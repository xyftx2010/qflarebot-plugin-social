import type { PluginContext } from '@qqbot/sdk'
import type { LLMService, SocialConfig } from '../types.js'
import type { LearningJobRecord, StyleProfileRecord } from './types.js'
import {
  countCorpusSummary,
  deleteCorpusByIds,
  deleteCorpusBySender,
  getActiveRunningJob,
  getLearningGroupSettings,
  getNextProfileVersion,
  getPublishedStyleProfile,
  getStyleProfileById,
  getTodayLearningRuns,
  insertDialogueExamples,
  insertLearningAudit,
  insertStyleProfile,
  listAuthorizedLearningGroups,
  listCorpusRecords,
  listDialogueExamples,
  listGroupMemes,
  listStyleProfiles,
  markCorpusStatus,
  pruneExpiredLearningData,
  recordLearningUsage,
  updateStyleProfileStatus,
  upsertGroupMeme,
  upsertLearningJob,
} from '../store/learning-db.js'
import { anonymizeSenderId, computeContentHash, evaluateAndCleanCorpus } from './cleaner.js'
import { distillGroupStyleBatch } from './distiller.js'
import { invalidateStyleCache } from './prompt-compiler.js'
import { hasCorpusContentHash, insertCorpusBatch } from '../store/learning-db.js'

const JOB_LEASE_MS = 5 * 60_000

/**
 * 在线增量语料采集器（在 ctx.waitUntil() 中异步执行，绝不阻塞实时群聊）：
 * - 仅在总开关开启 + 群已授权 + 成员未 opt-out + 非机器人消息时采集；
 * - 共享与离线导入完全一致的清洗、脱敏、评分与跨来源去重流程。
 */
export async function collectOnlineCorpusMessage(opts: {
  ctx: PluginContext<SocialConfig>
  groupId: string
  userId: string
  messageId: string
  content: string
  replyTo?: string
  mentions?: string[]
  isBot?: boolean
  optedOut?: boolean
  now?: number
}): Promise<{ collected: boolean; reason: string }> {
  const { ctx, groupId, userId, messageId, content } = opts
  const now = opts.now ?? Date.now()
  if (!ctx.config.style_learning_enabled) return { collected: false, reason: 'disabled' }
  if (opts.optedOut) return { collected: false, reason: 'member-opt-out' }
  if (ctx.config.style_exclude_bot_messages && (opts.isBot || userId === ctx.botId)) {
    return { collected: false, reason: 'bot-excluded' }
  }

  const groupCfg = await getLearningGroupSettings(ctx.db, groupId)
  if (!groupCfg?.authorized) return { collected: false, reason: 'group-not-authorized' }

  const evalRes = evaluateAndCleanCorpus({
    rawContent: content,
    senderIsBot: Boolean(opts.isBot),
    blockedKeywords: ctx.config.blocked_keywords,
    hasContextNeighbor: true,
    timestamp: now,
    now,
  })
  if (!evalRes.accepted) return { collected: false, reason: evalRes.reason }

  const contentHash = await computeContentHash(groupId, evalRes.cleanedContent, now)
  if (await hasCorpusContentHash(ctx.db, groupId, contentHash)) {
    return { collected: false, reason: 'duplicate' }
  }

  const pseudoSender = await anonymizeSenderId(groupId, userId)
  const retentionDays = groupCfg.retentionDays ?? ctx.config.style_corpus_retention_days
  await insertCorpusBatch(ctx.db, [
    {
      corpusId: `cor_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`,
      groupId,
      sourceId: 'online_stream',
      sourceType: 'online',
      pseudonymousSenderId: pseudoSender,
      messageId,
      timestamp: now,
      messageType: 'text',
      content: evalRes.cleanedContent,
      replyTo: opts.replyTo ?? '',
      mentions: opts.mentions ?? [],
      consentStatus: 'authorized',
      contentHash,
      qualityScore: evalRes.qualityScore,
      learningStatus: evalRes.learningStatus,
      createdAt: now,
      expiresAt: now + Math.max(1, retentionDays) * 86_400_000,
    },
  ])
  return { collected: true, reason: 'ok' }
}

export interface RunLearningJobResult {
  ok: boolean
  reason: string
  jobId?: string
  candidateProfileId?: string
  published?: boolean
  processedCount?: number
}

/**
 * 执行单群增量学习任务（支持租约锁防并发、检查点幂等、每日预算控制与候选版本审核门禁）。
 */
export async function runGroupLearningJob(opts: {
  ctx: PluginContext<SocialConfig>
  groupId: string
  triggerType: 'cron' | 'manual' | 'import'
  force?: boolean
  actor?: string
  now?: number
}): Promise<RunLearningJobResult> {
  const { ctx, groupId, triggerType } = opts
  const now = opts.now ?? Date.now()

  if (!ctx.config.style_learning_enabled && !opts.force) {
    return { ok: false, reason: 'style-learning-disabled' }
  }

  const groupCfg = await getLearningGroupSettings(ctx.db, groupId)
  if (!groupCfg?.authorized && !opts.force) {
    return { ok: false, reason: 'group-not-authorized' }
  }

  // 并发租约锁检查
  const activeJob = await getActiveRunningJob(ctx.db, groupId, now)
  if (activeJob) {
    return { ok: false, reason: 'job-already-running', jobId: activeJob.jobId }
  }

  // 每日学习调用预算检查
  const todayRuns = await getTodayLearningRuns(ctx.db, now)
  if (todayRuns >= ctx.config.style_daily_budget_runs) {
    return { ok: false, reason: 'daily-learning-budget-reached' }
  }

  // 读取待学习语料（或近期观察窗口内的有效语料）
  const sinceTs = now - Math.max(7, ctx.config.style_recent_window_days) * 86_400_000
  const pending = await listCorpusRecords(ctx.db, {
    groupId,
    status: 'pending',
    sinceTs,
    limit: ctx.config.style_learning_batch_size,
  })
  const minRequired = opts.force ? 2 : ctx.config.style_learning_min_messages
  if (pending.length < minRequired) {
    return { ok: false, reason: `pending-below-min:${pending.length}/${minRequired}` }
  }

  const jobId = `job_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
  const job: LearningJobRecord = {
    jobId,
    groupId,
    triggerType,
    status: 'running',
    checkpointCursor: 0,
    processedCount: 0,
    retryCount: 0,
    leaseUntil: now + JOB_LEASE_MS,
    candidateProfileId: '',
    error: '',
    createdAt: now,
    updatedAt: now,
  }
  await upsertLearningJob(ctx.db, job)

  try {
    let llm: LLMService | null = null
    try {
      llm = ctx.service<LLMService>('llm')
    } catch {
      llm = null
    }

    const existing = await getPublishedStyleProfile(ctx.db, groupId)
    const distilled = await distillGroupStyleBatch({
      groupId,
      records: pending,
      existingProfile: existing,
      freezeStable: Boolean(groupCfg?.freezeStable),
      config: ctx.config,
      llm,
      now,
    })

    const version = await getNextProfileVersion(ctx.db, groupId)
    const profileId = `prof_${groupId.slice(-6)}_v${version}_${crypto.randomUUID().slice(0, 6)}`
    const allowAutoPublish =
      (groupCfg?.autoPublish ?? ctx.config.style_auto_publish) &&
      distilled.candidateProfile.confidence >= 0.5 &&
      distilled.candidateProfile.distinctSenders >= 2

    const profile: StyleProfileRecord = {
      ...distilled.candidateProfile,
      profileId,
      version,
      status: allowAutoPublish ? 'published' : 'candidate',
      publishedAt: allowAutoPublish ? now : 0,
    }

    if (allowAutoPublish && existing && existing.status === 'published') {
      await updateStyleProfileStatus(ctx.db, existing.profileId, 'archived')
    }

    await insertStyleProfile(ctx.db, profile)
    for (const meme of distilled.extractedMemes) {
      await upsertGroupMeme(ctx.db, meme)
    }
    await insertDialogueExamples(ctx.db, distilled.extractedExamples)
    await markCorpusStatus(ctx.db, distilled.usedCorpusIds, 'processed')

    await recordLearningUsage(
      ctx.db,
      {
        runs: distilled.llmRuns,
        inputTokens: distilled.inputTokens,
        outputTokens: distilled.outputTokens,
        completed: 1,
      },
      now,
    )

    job.status = 'completed'
    job.checkpointCursor = distilled.usedCorpusIds.length
    job.processedCount = distilled.usedCorpusIds.length
    job.candidateProfileId = profileId
    job.leaseUntil = 0
    job.updatedAt = Date.now()
    await upsertLearningJob(ctx.db, job)

    await insertLearningAudit(
      ctx.db,
      groupId,
      allowAutoPublish ? 'profile_auto_published' : 'profile_candidate_created',
      opts.actor ?? triggerType,
      `生成风格档案 v${version}（样本 ${distilled.usedCorpusIds.length} 条，热梗 ${distilled.extractedMemes.length} 个，示例 ${distilled.extractedExamples.length} 条）`,
      now,
    )

    if (allowAutoPublish) invalidateStyleCache(groupId)

    return {
      ok: true,
      reason: allowAutoPublish ? 'auto-published' : 'candidate-created',
      jobId,
      candidateProfileId: profileId,
      published: allowAutoPublish,
      processedCount: distilled.usedCorpusIds.length,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    job.status = 'failed'
    job.error = msg.slice(0, 240)
    job.leaseUntil = 0
    job.updatedAt = Date.now()
    await upsertLearningJob(ctx.db, job)
    await recordLearningUsage(ctx.db, { failed: 1 }, now)
    return { ok: false, reason: msg, jobId }
  }
}

/**
 * 定时增量学习入口（挂载在 SDK v5 `cron`）：
 * 清理过期语料并扫描所有已授权群，满足新增最低语料阈值时自动启动学习。
 */
export async function runScheduledStyleLearning(ctx: PluginContext<SocialConfig>, now = Date.now()): Promise<void> {
  if (!ctx.config.style_learning_enabled) return
  await pruneExpiredLearningData(ctx.db, now).catch(() => {})
  if (!ctx.config.style_auto_learn) return

  const groups = await listAuthorizedLearningGroups(ctx.db)
  for (const g of groups.slice(0, 5)) {
    const summary = await countCorpusSummary(ctx.db, g.groupId)
    if (summary.pending >= ctx.config.style_learning_min_messages) {
      await runGroupLearningJob({
        ctx,
        groupId: g.groupId,
        triggerType: 'cron',
        now,
      }).catch((err) => {
        ctx.logger.warn('定时风格学习任务失败（不影响聊天）', {
          groupId: g.groupId,
          error: err instanceof Error ? err.message : String(err),
        })
      })
    }
  }
}

// ---- 版本发布 / 回滚 / 隐私级联失效 ----

export async function publishStyleProfileVersion(
  ctx: PluginContext<SocialConfig>,
  groupId: string,
  profileId: string,
  actor = 'admin',
  now = Date.now(),
): Promise<{ ok: boolean; error?: string }> {
  const target = await getStyleProfileById(ctx.db, profileId)
  if (!target || target.groupId !== groupId) return { ok: false, error: '未找到该风格版本' }
  if (target.status === 'invalidated' || target.containsDeletedData) {
    return { ok: false, error: '该版本包含已被删除或退出学习的语料，禁止发布或回滚，请基于合规语料重新学习。' }
  }

  const all = await listStyleProfiles(ctx.db, groupId, 30)
  for (const p of all) {
    if ((p.status === 'published' || p.status === 'frozen') && p.profileId !== profileId) {
      await updateStyleProfileStatus(ctx.db, p.profileId, 'archived')
    }
  }
  await updateStyleProfileStatus(ctx.db, profileId, 'published', now)
  invalidateStyleCache(groupId)
  await insertLearningAudit(ctx.db, groupId, 'profile_published', actor, `发布/切换风格版本 v${target.version} (${profileId})`, now)
  return { ok: true }
}

/**
 * 隐私级联清理：删除原始语料后，同步删除引用它的对话样本、重新评估热梗证据、
 * 将受影响的旧风格版本标记为 `invalidated`（防止通过回滚复活已删数据），并失效缓存。
 */
export async function cascadeDeleteCorpusAndInvalidate(
  ctx: PluginContext<SocialConfig>,
  groupId: string,
  opts: { corpusIds?: readonly string[]; rawUserId?: string; pseudonymousSenderId?: string; actor?: string },
  now = Date.now(),
): Promise<{ deletedCorpus: number; deletedExamples: number; invalidatedProfiles: number }> {
  const removedIds = new Set<string>(opts.corpusIds ?? [])
  if (opts.rawUserId) {
    const pseudo = await anonymizeSenderId(groupId, opts.rawUserId)
    const ids = await deleteCorpusBySender(ctx.db, groupId, pseudo)
    ids.forEach((id) => removedIds.add(id))
  }
  if (opts.pseudonymousSenderId) {
    const ids = await deleteCorpusBySender(ctx.db, groupId, opts.pseudonymousSenderId)
    ids.forEach((id) => removedIds.add(id))
  }
  if (opts.corpusIds && opts.corpusIds.length > 0) {
    await deleteCorpusByIds(ctx.db, groupId, opts.corpusIds)
  }

  if (removedIds.size === 0) {
    return { deletedCorpus: 0, deletedExamples: 0, invalidatedProfiles: 0 }
  }

  // 1. 删除引用了已删语料的对话样本
  const examples = await listDialogueExamples(ctx.db, groupId, { activeOnly: false, limit: 120, now })
  let deletedExamples = 0
  for (const ex of examples) {
    if (ex.sourceCorpusIds.some((id) => removedIds.has(id))) {
      await ctx.db.run('DELETE FROM {dialogue_examples} WHERE group_id = ? AND example_id = ?', groupId, ex.exampleId)
      deletedExamples += 1
    }
  }

  // 2. 重新评估受影响热梗（移除已删证据，证据不足降级为 inactive）
  const memes = await listGroupMemes(ctx.db, groupId, { status: 'all', limit: 100 })
  for (const m of memes) {
    const remaining = m.sourceCorpusIds.filter((id) => !removedIds.has(id))
    if (remaining.length !== m.sourceCorpusIds.length) {
      await upsertGroupMeme(ctx.db, {
        ...m,
        sourceCorpusIds: remaining,
        occurrenceCount: Math.max(0, remaining.length),
        status: remaining.length < 2 ? 'inactive' : m.status,
        updatedAt: now,
      })
    }
  }

  // 3. 将引用已删语料的所有历史/候选/已发布风格版本标记为 invalidated（防回滚复活）
  const profiles = await listStyleProfiles(ctx.db, groupId, 50)
  let invalidatedProfiles = 0
  for (const p of profiles) {
    if (p.sourceCorpusIds.some((id) => removedIds.has(id))) {
      await ctx.db.run(
        `UPDATE {style_profiles} SET status = 'invalidated', contains_deleted_data = 1 WHERE profile_id = ?`,
        p.profileId,
      )
      invalidatedProfiles += 1
    }
  }

  invalidateStyleCache(groupId)
  await insertLearningAudit(
    ctx.db,
    groupId,
    'privacy_cascade_delete',
    opts.actor ?? 'privacy',
    `级联删除语料 ${removedIds.size} 条、派生样本 ${deletedExamples} 条、失效受影响版本 ${invalidatedProfiles} 个`,
    now,
  )

  return {
    deletedCorpus: removedIds.size,
    deletedExamples,
    invalidatedProfiles,
  }
}
