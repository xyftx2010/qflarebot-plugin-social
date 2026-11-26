import type { PluginContext, Session } from '@qqbot/sdk'
import type { LLMChatMessage, LLMService, SocialConfig } from '../types.js'
import { ensureSchema } from '../store/schema.js'
import {
  createEmptyGroupState,
  getGroupSettings,
  getGroupState,
  saveGroupState,
} from '../store/db.js'
import {
  appendContextMessage,
  buildAssistantContextMessage,
  buildUserContextMessage,
  extractReadableText,
  formatContextTranscript,
  pruneContextWindow,
  resolveSpeakerName,
} from '../memory/context.js'
import {
  addGroupMemory,
  extractCandidateMemory,
  listActiveGroupMemories,
  maybePruneGroupMemories,
  resolveMemoryTtlDays,
} from '../memory/store.js'
import { containsBlockedKeyword } from '../memory/privacy.js'
import { buildSocialSystemPrompt, collectCallNames, resolvePersona } from '../persona/manager.js'
import { evaluateTrigger, recordReplyRate } from '../trigger/gate.js'

export interface PipelineOptions {
  now?: () => number
  random?: () => number
}

export interface PipelineOutcome {
  replied: boolean
  reason: string
  score: number
  replyText?: string
}

/**
 * 群聊主处理管线：
 * 读状态 -> 权限观测 -> 零成本触发判断 -> 上下文与轻量记忆维护 -> 按需调用 LLM -> 被动回复。
 */
export async function handleGroupChatEvent(
  session: Session,
  ctx: PluginContext<SocialConfig>,
  opts: PipelineOptions = {},
): Promise<PipelineOutcome> {
  if (session.scene !== 'group') {
    return { replied: false, reason: 'not-group', score: 0 }
  }

  const now = (opts.now ?? Date.now)()
  await ensureSchema(ctx.db, ctx.logger)

  const groupId = session.targetId
  const [settings, loadedState] = await Promise.all([
    getGroupSettings(ctx.db, groupId),
    getGroupState(ctx.db, groupId),
  ])

  const state = loadedState ?? createEmptyGroupState(groupId, now)
  let stateDirty = false

  // 记录非 @ 普通群消息到达时间，用于 /social status 验证「获取群内全部消息」权限是否生效
  if (session.event === 'qq.group.message' && !session.atMe && session.userId !== session.botId) {
    state.lastNonAtSeenAt = now
    stateDirty = true
  }

  const persona = resolvePersona(ctx.config, settings)
  const callNames = collectCallNames(ctx.config, persona, session.botName)

  const decision = evaluateTrigger({
    session,
    config: ctx.config,
    settings,
    state,
    callNames,
    now,
    random: opts.random,
  })

  // 记录滑窗上下文与零成本轻量记忆
  if (decision.recordContext) {
    const userMsg = buildUserContextMessage(session, now)
    if (userMsg) {
      state.recentMessages = appendContextMessage(state.recentMessages, userMsg, ctx.config, now)
      state.updatedAt = now
      stateDirty = true
    }

    if (ctx.config.enable_memory) {
      const candidate = extractCandidateMemory(extractReadableText(session))
      if (candidate) {
        await addGroupMemory(ctx.db, {
          groupId,
          userId: session.userId,
          userName: resolveSpeakerName(session),
          scope: candidate.scope,
          content: candidate.content,
          ttlDays: resolveMemoryTtlDays(ctx.config, settings),
          maxPerGroup: ctx.config.max_memories_per_group,
          now,
        })
      }
      const pruneRes = await maybePruneGroupMemories(ctx.db, state, now)
      if (pruneRes.touched) stateDirty = true
    }
  }

  if (!decision.shouldReply) {
    if (stateDirty) {
      state.updatedAt = now
      await saveGroupState(ctx.db, state)
    }
    return { replied: false, reason: decision.reason, score: decision.score }
  }

  // 解析 LLM 服务
  let llm: LLMService
  try {
    llm = ctx.service<LLMService>('llm')
  } catch {
    ctx.logger.warn('llm 服务不可用，跳过拟人回复', { groupId })
    if (stateDirty) {
      state.updatedAt = now
      await saveGroupState(ctx.db, state)
    }
    if (session.atMe) {
      await session.reply('「LLM 接口」插件未启用，暂时没法聊天哦。').catch(() => false)
    }
    return { replied: false, reason: 'llm-unavailable', score: decision.score }
  }

  const memories = ctx.config.enable_memory
    ? await listActiveGroupMemories(ctx.db, groupId, now, 12)
    : []

  const freshContext = pruneContextWindow(state.recentMessages, ctx.config, now)
  const systemPrompt = buildSocialSystemPrompt(persona, memories, session.botName)
  const transcript = formatContextTranscript(freshContext)
  const currentSpeaker = resolveSpeakerName(session)

  const messages: LLMChatMessage[] = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: [
        '以下是当前 QQ 群的近期聊天片段：',
        transcript,
        '',
        `请自然地回应最新一条来自「${currentSpeaker}」的消息，只输出你要发到群里的回复正文。`,
      ].join('\n'),
    },
  ]

  let replyText = ''
  try {
    const result = await llm.chat({
      model: ctx.config.model_alias.trim() || undefined,
      messages,
      temperature: ctx.config.temperature,
      max_tokens: ctx.config.max_output_tokens,
      timeout_ms: ctx.config.llm_timeout_ms,
    })
    replyText = (result.text ?? '').trim()
  } catch (err) {
    ctx.logger.warn('LLM 调用失败，已静默降级', {
      groupId,
      error: err instanceof Error ? err.message : String(err),
    })
    if (stateDirty) {
      state.updatedAt = now
      await saveGroupState(ctx.db, state)
    }
    return { replied: false, reason: 'llm-error', score: decision.score }
  }

  if (!replyText) {
    if (stateDirty) {
      state.updatedAt = now
      await saveGroupState(ctx.db, state)
    }
    return { replied: false, reason: 'empty-reply', score: decision.score }
  }

  // 出站安全关键词检查
  if (containsBlockedKeyword(replyText, ctx.config.blocked_keywords)) {
    ctx.logger.warn('出站回复命中过滤关键词，已拦截', { groupId })
    if (stateDirty) {
      state.updatedAt = now
      await saveGroupState(ctx.db, state)
    }
    return { replied: false, reason: 'blocked-output', score: decision.score }
  }

  const sendResult = await session.reply(replyText)
  if (!sendResult.ok) {
    ctx.logger.warn('群聊被动回复投递失败', {
      groupId,
      status: sendResult.status,
      code: sendResult.code,
      error: sendResult.error,
    })
    if (stateDirty) {
      state.updatedAt = now
      await saveGroupState(ctx.db, state)
    }
    return { replied: false, reason: 'send-failed', score: decision.score }
  }

  recordReplyRate(state, now)
  state.recentMessages = appendContextMessage(
    freshContext,
    buildAssistantContextMessage(session.botName, replyText, now),
    ctx.config,
    now,
  )
  state.updatedAt = now
  await saveGroupState(ctx.db, state)

  return {
    replied: true,
    reason: decision.reason,
    score: decision.score,
    replyText,
  }
}
