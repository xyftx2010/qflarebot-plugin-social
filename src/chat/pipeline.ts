import type { OutgoingMessage, PluginContext, PluginToolArtifact, Session } from '@qqbot/sdk'
import type {
  AgentChannel,
  GroupMemory,
  GroupMultimodalState,
  GroupSettings,
  GroupState,
  LLMChatMessage,
  LLMService,
  ReplyStyle,
  RoutingLogRecord,
  SocialConfig,
  ToolExecutionLog,
  VoiceLogRecord,
} from '../types.js'
import { ensureSchema } from '../store/schema.js'
import { createEmptyGroupState, loadGroupChatSnapshot, saveGroupState } from '../store/db.js'
import {
  createEmptyMultimodalState,
  getGroupMultimodalState,
  listAvailableMemesForGroup,
  markMemeUsed,
  pruneExpiredImageCache,
  recordMultimodalStats,
  saveGroupMultimodalState,
  type MultimodalStatsDelta,
} from '../store/multimodal-db.js'
import {
  countGroupVoiceSentToday,
  getGroupVoiceSettings,
  pruneExpiredVoiceCache,
  pruneOldVoiceLogs,
} from '../store/voice-db.js'
import {
  countGroupAutoAgentToday,
  getAgentToolPolicy,
  insertRoutingLog,
  insertToolExecutionLog,
  listPromptFragments,
  pruneOldRoutingLogs,
  pruneOldToolLogs,
  recordLLMUsage,
  recordToolStat,
} from '../store/agent-db.js'
import {
  appendContextMessage,
  buildAssistantContextMessage,
  buildUserContextMessage,
  extractReadableText,
  formatContextTranscript,
  pruneContextWindow,
  resolveSpeakerName,
  truncateText,
} from '../memory/context.js'
import {
  addGroupMemory,
  extractCandidateMemory,
  maybePruneGroupMemories,
  resolveMemoryTtlDays,
} from '../memory/store.js'
import { containsBlockedKeyword } from '../memory/privacy.js'
import { buildSocialSystemPrompt, collectCallNames, resolvePersona } from '../persona/manager.js'
import { evaluateTrigger, recordReplyRate } from '../trigger/gate.js'
import { extractSessionImages } from '../vision/media.js'
import { analyzeSessionImages } from '../vision/analyzer.js'
import { pruneExpiredMemes, resolveMemeOutgoingImage } from '../meme/store.js'
import { recordMemeReplyOutcome, selectMemeForReply } from '../meme/selector.js'
import {
  buildVoicePromptDirective,
  decideVoiceReply,
  parseVoiceDirective,
  resolveEffectiveVoiceConfig,
} from '../voice/decision.js'
import { recordVoiceSendLog, synthesizeAndPrepareVoice } from '../voice/service.js'
import { discoverExternalTools } from '../agent/external-tools.js'
import { analyzeMessageIntent } from '../agent/intent-router.js'
import { buildAvailableToolCatalog, selectDynamicTools } from '../agent/tool-selector.js'
import { buildEscalationPromptHint, parseEscalationDirective } from '../agent/escalation.js'
import { runSocialAgentLoop } from '../agent/loop.js'

/** 进程内轻量事件去重表，防止并发重试或重复投递导致重复回复 */
const recentHandledIds = new Set<string>()
const MAX_DEDUP_IDS = 200

export function resetDedupForTest(): void {
  recentHandledIds.clear()
}

function claimMessageDedup(session: Session): boolean {
  const key = session.messageId || session.id
  if (!key || key === 'mock-message-id' || key === 'mock-event-id') return true
  if (recentHandledIds.has(key)) return false
  recentHandledIds.add(key)
  if (recentHandledIds.size > MAX_DEDUP_IDS) {
    const first = recentHandledIds.values().next().value
    if (first) recentHandledIds.delete(first)
  }
  return true
}

export interface PipelineOptions {
  now?: () => number
  random?: () => number
  fetchImpl?: typeof fetch
  /** 显式命令（如 /ask）强制触发并进入 Full Agent */
  forceReply?: boolean
  /** 显式文本覆盖（例如 /ask 去掉命令前缀后的正文） */
  overrideText?: string
  /** 仅单元测试用：等待后台落库完成再返回，线上走 ctx.waitUntil 避免阻塞回复 */
  awaitBackground?: boolean
}

export interface PipelineOutcome {
  replied: boolean
  reason: string
  score: number
  replyText?: string
  replyStyle?: ReplyStyle
  memeId?: string
  visionUsed?: boolean
  voiceUsed?: boolean
  voiceCached?: boolean
  usedAgentLoop?: boolean
  toolCallsCount?: number
  channel?: AgentChannel
  escalated?: boolean
  candidateToolCount?: number
}

function resolveConversationId(session: Session): string {
  return session.scene === 'group' ? session.targetId : `c2c:${session.userId}`
}

function selectRelevantMemories(
  memories: readonly GroupMemory[],
  queryText: string,
  limit = 10,
): GroupMemory[] {
  if (memories.length <= limit) return [...memories]
  const tokens = queryText
    .toLowerCase()
    .split(/[\s,，。？！?!]+/)
    .filter((t) => t.length >= 2)
  if (tokens.length === 0) return memories.slice(0, limit)
  const scored = memories.map((m) => {
    const hay = `${m.userName ?? ''} ${m.content}`.toLowerCase()
    let hits = 0
    for (const tok of tokens) {
      if (hay.includes(tok)) hits += 1
    }
    return { m, hits }
  })
  scored.sort((a, b) => b.hits - a.hits || b.m.createdAt - a.m.createdAt)
  return scored.slice(0, limit).map((x) => x.m)
}

function firstImageArtifact(artifacts: readonly PluginToolArtifact[]): { url?: string; base64?: string } | null {
  for (const a of artifacts) {
    if (a.type === 'image' && (a.url || a.base64)) {
      return a.url ? { url: a.url } : { base64: a.base64 }
    }
  }
  return null
}

async function runPostPersist(
  ctx: PluginContext<SocialConfig>,
  session: Session,
  state: GroupState,
  mmState: GroupMultimodalState | null,
  settings: GroupSettings | null,
  opts: {
    now: number
    stateDirty: boolean
    mmDirty: boolean
    shouldExtractMemory: boolean
    statsDelta: MultimodalStatsDelta
    usedMemeId?: string
    voiceLog?: Omit<VoiceLogRecord, 'id'>
    llmUsage?: { runs: number; toolCalls: number; inputTokens: number; outputTokens: number }
    toolLogs?: Array<Omit<ToolExecutionLog, 'id'>>
    routingLog?: Omit<RoutingLogRecord, 'id' | 'day'>
  },
): Promise<void> {
  const { now, shouldExtractMemory, statsDelta, usedMemeId, voiceLog, llmUsage, toolLogs, routingLog } = opts
  let dirty = opts.stateDirty

  try {
    if (shouldExtractMemory && ctx.config.enable_memory) {
      const plainText = (session.displayContent ?? session.content ?? '').trim()
      const candidate = extractCandidateMemory(plainText)
      if (candidate) {
        await addGroupMemory(ctx.db, {
          groupId: state.groupId,
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
      if (pruneRes.touched) {
        dirty = true
        await pruneExpiredImageCache(ctx.db, now).catch(() => 0)
        await pruneExpiredMemes(ctx, now).catch(() => 0)
        await pruneExpiredVoiceCache(ctx.db, ctx.r2, now).catch(() => 0)
        await pruneOldVoiceLogs(ctx.db, 14, now).catch(() => 0)
        await pruneOldToolLogs(ctx.db, 7, now).catch(() => 0)
        await pruneOldRoutingLogs(ctx.db, 7, now).catch(() => 0)
      }
    }

    if (dirty) {
      state.updatedAt = now
      await saveGroupState(ctx.db, state)
    }

    if (mmState && opts.mmDirty) {
      mmState.updatedAt = now
      await saveGroupMultimodalState(ctx.db, mmState)
    }

    if (usedMemeId) {
      await markMemeUsed(ctx.db, usedMemeId, now).catch(() => undefined)
    }

    if (voiceLog) {
      await recordVoiceSendLog(ctx, voiceLog).catch(() => undefined)
    }

    if (llmUsage && (llmUsage.runs > 0 || llmUsage.toolCalls > 0)) {
      await recordLLMUsage(ctx.db, llmUsage, now).catch(() => undefined)
    }

    if (toolLogs && toolLogs.length > 0) {
      for (const log of toolLogs) {
        await recordToolStat(ctx.db, log.toolId, log.status === 'success', log.latencyMs, now).catch(() => undefined)
        await insertToolExecutionLog(ctx.db, log).catch(() => undefined)
      }
    }

    if (routingLog) {
      await insertRoutingLog(ctx.db, routingLog).catch(() => undefined)
    }

    await recordMultimodalStats(ctx.db, statsDelta, now)
  } catch (err) {
    ctx.logger.warn('后台保存群聊状态或记忆失败', {
      groupId: state.groupId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

function scheduleBackground(
  ctx: PluginContext<SocialConfig>,
  task: Promise<void>,
  awaitBackground?: boolean,
): Promise<void> | void {
  if (awaitBackground) return task
  ctx.waitUntil(task)
}

/**
 * 统一 Social Agent 执行引擎（V0.11.1 自适应三通道路由版）：
 * 去重 -> 发言权限/冷却/概率守卫 -> 意图路由（Fast / Smart Tool / Full Agent）
 * -> 动态工具筛选 + 单跳模型自主升级 -> 文字/表情包/图片/语音互斥回复 -> 可观测性落库。
 */
export async function handleGroupChatEvent(
  session: Session,
  ctx: PluginContext<SocialConfig>,
  opts: PipelineOptions = {},
): Promise<PipelineOutcome> {
  const isGroup = session.scene === 'group'
  const isAllowedC2c = session.scene === 'c2c' && (ctx.config.enable_c2c_chat || opts.forceReply)
  if (!isGroup && !isAllowedC2c) {
    return { replied: false, reason: 'not-group', score: 0 }
  }

  if (!opts.forceReply && !claimMessageDedup(session)) {
    return { replied: false, reason: 'duplicate-event', score: 0, replyStyle: 'none' }
  }

  const startedAt = Date.now()
  const now = (opts.now ?? Date.now)()
  const sharedDeadline = startedAt + Math.max(6_000, ctx.config.agent_budget_ms || 18_000)
  await ensureSchema(ctx.db, ctx.logger)

  const conversationId = resolveConversationId(session)
  const snapshot = await loadGroupChatSnapshot(ctx.db, conversationId, now, ctx.config.enable_memory, 24)
  const settings = snapshot.settings
  const state = snapshot.state ?? createEmptyGroupState(conversationId, now)
  let stateDirty = false
  let mmState: GroupMultimodalState | null = null
  let mmDirty = false
  const statsDelta: MultimodalStatsDelta = {
    visionCalls: 0,
    visionCacheHits: 0,
    visionErrors: 0,
    memeSent: 0,
  }

  if (isGroup && session.event === 'qq.group.message' && !session.atMe && session.userId !== session.botId) {
    state.lastNonAtSeenAt = now
    stateDirty = true
  }

  const persona = resolvePersona(ctx.config, settings)
  const callNames = collectCallNames(ctx.config, persona, session.botName)

  // 严格先过原有发言权限、群配置、冷却、频控与启发式发言判断，再做工具路由
  const decision =
    opts.forceReply || isAllowedC2c
      ? { shouldReply: true, reason: 'at-me' as const, score: 100, recordContext: true }
      : evaluateTrigger({
          session,
          config: ctx.config,
          settings,
          state,
          callNames,
          now,
          random: opts.random,
        })

  const userMsg = decision.recordContext ? buildUserContextMessage(session, now) : null
  if (userMsg) {
    if (opts.overrideText) userMsg.text = truncateText(opts.overrideText, 220)
    state.recentMessages = appendContextMessage(state.recentMessages, userMsg, ctx.config, now)
    state.updatedAt = now
    stateDirty = true
  }

  if (!decision.shouldReply) {
    const bg = runPostPersist(ctx, session, state, null, settings, {
      now,
      stateDirty,
      mmDirty: false,
      shouldExtractMemory: decision.recordContext,
      statsDelta,
    })
    await scheduleBackground(ctx, bg, opts.awaitBackground)
    return { replied: false, reason: decision.reason, score: decision.score, replyStyle: 'none' }
  }

  let llm: LLMService
  try {
    llm = ctx.service<LLMService>('llm')
  } catch {
    ctx.logger.warn('llm 服务不可用，跳过拟人回复', { conversationId })
    if (session.atMe || opts.forceReply || isAllowedC2c) {
      await session.reply('「LLM 接口」插件未启用，暂时没法聊天哦。').catch(() => false)
    }
    const bg = runPostPersist(ctx, session, state, null, settings, {
      now,
      stateDirty,
      mmDirty: false,
      shouldExtractMemory: decision.recordContext,
      statsDelta,
    })
    await scheduleBackground(ctx, bg, opts.awaitBackground)
    return { replied: false, reason: 'llm-unavailable', score: decision.score, replyStyle: 'none' }
  }

  const hasImages = extractSessionImages(session, ctx.config.max_vision_images).length > 0
  const needAutoQuota =
    ctx.config.enable_agent_tools &&
    !opts.forceReply &&
    !session.atMe &&
    ctx.config.agent_auto_daily_limit > 0

  const [loadedMmState, groupVoiceSettings, toolPolicy, promptFragments, autoAgentToday] = await Promise.all([
    hasImages || ctx.config.enable_meme_reply ? getGroupMultimodalState(ctx.db, conversationId) : Promise.resolve(null),
    ctx.config.tts_api_key.trim() ? getGroupVoiceSettings(ctx.db, conversationId) : Promise.resolve(null),
    ctx.config.enable_agent_tools
      ? getAgentToolPolicy(ctx.db)
      : Promise.resolve({ enabledBuiltins: [], enabledExternalTools: [], allowExternalWrites: false, updatedAt: 0 }),
    listPromptFragments(ctx.db, true),
    needAutoQuota ? countGroupAutoAgentToday(ctx.db, conversationId, now) : Promise.resolve(0),
  ])

  if (hasImages || ctx.config.enable_meme_reply) {
    mmState = loadedMmState ?? createEmptyMultimodalState(conversationId, now)
  }
  const effectiveVoice = resolveEffectiveVoiceConfig(ctx.config, groupVoiceSettings)

  // 发现已授权的外部 core.tools 工具（仅当启用工具且有白名单）
  const externalDiscovered = ctx.config.enable_agent_tools
    ? await discoverExternalTools(ctx, toolPolicy)
    : null
  const availableCatalog = ctx.config.enable_agent_tools
    ? buildAvailableToolCatalog(ctx.config, toolPolicy.enabledBuiltins, externalDiscovered?.tools ?? [])
    : []

  // 按需图片理解
  let visionSummary = ''
  let visionNotes: string[] = []
  let visionTagsText = ''
  let visionUsed = false
  if (hasImages && mmState) {
    const vision = await analyzeSessionImages(session, ctx, mmState, {
      now,
      fetchImpl: opts.fetchImpl,
    })
    statsDelta.visionCalls = (statsDelta.visionCalls ?? 0) + (vision.statsDelta.visionCalls ?? 0)
    statsDelta.visionCacheHits = (statsDelta.visionCacheHits ?? 0) + (vision.statsDelta.visionCacheHits ?? 0)
    statsDelta.visionErrors = (statsDelta.visionErrors ?? 0) + (vision.statsDelta.visionErrors ?? 0)
    if ((vision.statsDelta.visionCalls ?? 0) > 0) mmDirty = true

    visionSummary = vision.combinedSummary
    visionNotes = vision.notes
    visionUsed = vision.analyses.length > 0
    visionTagsText = vision.analyses.flatMap((a) => [a.analysis.mood, ...a.analysis.tags]).join(' ')

    if (visionSummary && userMsg) {
      userMsg.imageSummary = truncateText(visionSummary, 140)
      stateDirty = true
    }
  }

  const freshContext = pruneContextWindow(state.recentMessages, ctx.config, now)
  const priorContext = userMsg ? freshContext.slice(0, -1) : freshContext
  const userText = (opts.overrideText ?? extractReadableText(session)).trim()
  const relevantMemories = selectRelevantMemories(snapshot.memories, `${userText} ${visionTagsText}`, 10)
  const voicePromptHint = buildVoicePromptDirective(effectiveVoice)

  // 自适应三通道意图路由（零额外 LLM 请求）
  const intent = analyzeMessageIntent({
    text: userText,
    quoteText: session.quote?.content,
    recentMessages: priorContext,
    config: ctx.config,
    isExplicit: Boolean(opts.forceReply || isAllowedC2c),
    isAtMe: session.atMe,
    autoAgentCountToday: autoAgentToday,
    externalTools: externalDiscovered?.tools ?? [],
    now,
  })

  let activeChannel: AgentChannel = intent.channel
  const dynamicSelection = selectDynamicTools({
    channel: activeChannel,
    catalog: availableCatalog,
    intent,
    text: userText,
    topK: ctx.config.agent_candidate_top_k,
  })

  const canEscalate =
    activeChannel === 'fast' &&
    ctx.config.enable_agent_tools &&
    ctx.config.adaptive_agent_enabled &&
    ctx.config.agent_auto_escalate &&
    availableCatalog.length > 0 &&
    (session.atMe || (ctx.config.agent_allow_non_mention && (ctx.config.agent_auto_daily_limit === 0 || autoAgentToday < ctx.config.agent_auto_daily_limit)))

  const baseSystemParts = [
    buildSocialSystemPrompt(persona, relevantMemories, session.botName),
    voicePromptHint,
    ...promptFragments.map((f) => f.fragment),
  ].filter(Boolean)

  const transcript = formatContextTranscript(freshContext)
  const currentSpeaker = resolveSpeakerName(session)

  const promptSections: string[] = [
    isGroup ? '以下是当前 QQ 群的近期聊天片段：' : '以下是最近的私聊对话片段：',
    transcript,
  ]
  if (visionSummary) {
    promptSections.push('', '本条消息涉及的图片内容解析：', visionSummary)
  }
  if (visionNotes.length > 0 && !visionSummary) {
    promptSections.push('', `图片读取备注：${visionNotes.join('；')}（如果看不到图就自然接文字话题，不要硬编图片内容）`)
  }
  promptSections.push('', `请结合语境自然回应最新一条来自「${currentSpeaker}」的消息，只输出回复正文。`)
  const userPromptContent = promptSections.join('\n')

  const buildMessages = (withEscalationHint: boolean): LLMChatMessage[] => {
    const sys = withEscalationHint
      ? [...baseSystemParts, buildEscalationPromptHint(true, availableCatalog.map((c) => c.id))]
      : baseSystemParts
    return [
      { role: 'system', content: sys.join('\n\n') },
      { role: 'user', content: userPromptContent },
    ]
  }

  let escalated = false
  let candidateToolCount = dynamicSelection.definitions.length
  let agentResult

  const maxStepsForChannel =
    !opts.forceReply && !session.atMe
      ? Math.min(ctx.config.agent_auto_max_steps, ctx.config.agent_max_tool_steps)
      : ctx.config.agent_max_tool_steps

  try {
    agentResult = await runSocialAgentLoop({
      ctx,
      llm,
      conversationId,
      messages: buildMessages(canEscalate),
      channel: activeChannel,
      toolDefs: dynamicSelection.definitions,
      externalDiscovered,
      maxSteps: maxStepsForChannel,
      deadlineMs: sharedDeadline,
      now,
      fetchImpl: opts.fetchImpl,
      random: opts.random,
    })

    // 处理 Fast Chat 模型自主升级协议（单跳升级，共享同一预算与权限白名单）
    if (canEscalate && activeChannel === 'fast') {
      const directive = parseEscalationDirective(agentResult.text)
      if (directive.action === 'silence') {
        const routingLog: Omit<RoutingLogRecord, 'id' | 'day'> = {
          groupId: conversationId,
          channel: 'fast',
          escalated: false,
          matchedIntents: intent.matchedIntents,
          candidateCount: 0,
          toolCalls: 0,
          toolFailures: 0,
          falseTrigger: false,
          latencyMs: Date.now() - startedAt,
          tokens: agentResult.usage.inputTokens + agentResult.usage.outputTokens,
          createdAt: now,
        }
        const bg = runPostPersist(ctx, session, state, mmState, settings, {
          now,
          stateDirty,
          mmDirty,
          shouldExtractMemory: decision.recordContext,
          statsDelta,
          llmUsage: agentResult.usage,
          routingLog,
        })
        await scheduleBackground(ctx, bg, opts.awaitBackground)
        return {
          replied: false,
          reason: 'model-chose-silence',
          score: decision.score,
          replyStyle: 'none',
          channel: 'fast',
          escalated: false,
          candidateToolCount: 0,
        }
      }

      if (directive.action === 'escalate' && sharedDeadline - Date.now() >= 3_000) {
        escalated = true
        const targetChannel: AgentChannel = directive.requestedTools.length >= 2 ? 'full' : 'smart'
        const escSelection = selectDynamicTools({
          channel: targetChannel,
          catalog: availableCatalog,
          intent,
          text: `${userText} ${directive.reason}`,
          topK: ctx.config.agent_candidate_top_k,
          requestedToolIds: directive.requestedTools,
        })
        if (escSelection.definitions.length > 0) {
          activeChannel = targetChannel
          candidateToolCount = escSelection.definitions.length
          const prevUsage = agentResult.usage
          const escalatedRun = await runSocialAgentLoop({
            ctx,
            llm,
            conversationId,
            messages: buildMessages(false),
            channel: activeChannel,
            toolDefs: escSelection.definitions,
            externalDiscovered,
            maxSteps: maxStepsForChannel,
            deadlineMs: sharedDeadline,
            now,
            fetchImpl: opts.fetchImpl,
            random: opts.random,
          })
          agentResult = {
            ...escalatedRun,
            usage: {
              runs: prevUsage.runs + escalatedRun.usage.runs,
              toolCalls: prevUsage.toolCalls + escalatedRun.usage.toolCalls,
              toolFailures: prevUsage.toolFailures + escalatedRun.usage.toolFailures,
              inputTokens: prevUsage.inputTokens + escalatedRun.usage.inputTokens,
              outputTokens: prevUsage.outputTokens + escalatedRun.usage.outputTokens,
            },
          }
        }
      } else if (directive.action === 'reply') {
        agentResult.text = directive.text
      }
    }
  } catch (err) {
    ctx.logger.warn('Social Agent LLM 执行失败，已静默降级', {
      conversationId,
      channel: activeChannel,
      error: err instanceof Error ? err.message : String(err),
    })
    const bg = runPostPersist(ctx, session, state, mmState, settings, {
      now,
      stateDirty,
      mmDirty,
      shouldExtractMemory: decision.recordContext,
      statsDelta,
    })
    await scheduleBackground(ctx, bg, opts.awaitBackground)
    return {
      replied: false,
      reason: 'llm-error',
      score: decision.score,
      replyStyle: 'none',
      visionUsed,
      channel: activeChannel,
      escalated,
      candidateToolCount,
    }
  }

  const parsedVoice = parseVoiceDirective(agentResult.text)
  let replyText = parsedVoice.cleanText

  if (ctx.config.agent_show_tool_progress && agentResult.toolLogs.length > 0 && replyText) {
    const names = [...new Set(agentResult.toolLogs.map((l) => l.toolId))].join('、')
    replyText = `${replyText}\n（已参考：${names}）`
  }

  const routingLog: Omit<RoutingLogRecord, 'id' | 'day'> = {
    groupId: conversationId,
    channel: activeChannel,
    escalated,
    matchedIntents: intent.matchedIntents,
    candidateCount: candidateToolCount,
    toolCalls: agentResult.usage.toolCalls,
    toolFailures: agentResult.usage.toolFailures,
    falseTrigger: activeChannel !== 'fast' && !opts.forceReply && agentResult.usage.toolCalls === 0,
    latencyMs: Date.now() - startedAt,
    tokens: agentResult.usage.inputTokens + agentResult.usage.outputTokens,
    createdAt: now,
  }

  if (!replyText && agentResult.artifacts.length === 0) {
    const bg = runPostPersist(ctx, session, state, mmState, settings, {
      now,
      stateDirty,
      mmDirty,
      shouldExtractMemory: decision.recordContext,
      statsDelta,
      llmUsage: agentResult.usage,
      toolLogs: agentResult.toolLogs,
      routingLog,
    })
    await scheduleBackground(ctx, bg, opts.awaitBackground)
    return {
      replied: false,
      reason: 'empty-reply',
      score: decision.score,
      replyStyle: 'none',
      visionUsed,
      channel: activeChannel,
      escalated,
      candidateToolCount,
    }
  }

  if (replyText && containsBlockedKeyword(replyText, ctx.config.blocked_keywords)) {
    ctx.logger.warn('出站回复命中过滤关键词，已拦截', { conversationId })
    const bg = runPostPersist(ctx, session, state, mmState, settings, {
      now,
      stateDirty,
      mmDirty,
      shouldExtractMemory: decision.recordContext,
      statsDelta,
      llmUsage: agentResult.usage,
      toolLogs: agentResult.toolLogs,
      routingLog,
    })
    await scheduleBackground(ctx, bg, opts.awaitBackground)
    return {
      replied: false,
      reason: 'blocked-output',
      score: decision.score,
      replyStyle: 'none',
      visionUsed,
      channel: activeChannel,
      escalated,
      candidateToolCount,
    }
  }

  // 0. 外部工具图片附件交付
  const toolImage = firstImageArtifact(agentResult.artifacts)
  if (toolImage) {
    let sendRes = await session.reply(replyText ? { text: replyText, image: toolImage } : { image: toolImage })
    if (!sendRes.ok && replyText) {
      sendRes = await session.reply(replyText)
    }
    if (sendRes.ok) {
      recordReplyRate(state, now)
      state.recentMessages = appendContextMessage(
        freshContext,
        buildAssistantContextMessage(session.botName, replyText || '[图片]', now),
        ctx.config,
        now,
      )
      stateDirty = true
    }
    const bg = runPostPersist(ctx, session, state, mmState, settings, {
      now,
      stateDirty,
      mmDirty,
      shouldExtractMemory: decision.recordContext,
      statsDelta,
      llmUsage: agentResult.usage,
      toolLogs: agentResult.toolLogs,
      routingLog,
    })
    await scheduleBackground(ctx, bg, opts.awaitBackground)
    return {
      replied: sendRes.ok,
      reason: sendRes.ok ? 'tool-artifact' : 'send-failed',
      score: decision.score,
      replyText: replyText || '[图片]',
      replyStyle: 'text_and_meme',
      visionUsed,
      usedAgentLoop: agentResult.usedAgentLoop,
      toolCallsCount: agentResult.usage.toolCalls,
      channel: activeChannel,
      escalated,
      candidateToolCount,
    }
  }

  // 1. 原生语音回复路径（与文字/表情包互斥，不重复发送）
  let voiceLog: Omit<VoiceLogRecord, 'id'> | undefined
  if (effectiveVoice.enabled && replyText) {
    const sentToday =
      effectiveVoice.dailyLimit > 0 ? await countGroupVoiceSentToday(ctx.db, conversationId, now) : 0
    const voiceDecision = decideVoiceReply({
      effective: effectiveVoice,
      maxChars: ctx.config.voice_max_chars,
      sentToday,
      userText,
      replyText,
      aiRequestedVoice: parsedVoice.aiRequestedVoice,
      aiEmotion: parsedVoice.emotion,
      random: opts.random,
    })

    if (voiceDecision.useVoice) {
      const prepared = await synthesizeAndPrepareVoice(ctx, {
        groupId: conversationId,
        text: replyText,
        voiceId: effectiveVoice.voiceId,
        speed: effectiveVoice.speed,
        emotion: voiceDecision.emotion,
        now,
        fetchImpl: opts.fetchImpl,
      })

      if (prepared.ok) {
        const voiceSend = await session.reply({ media: prepared.media })
        if (voiceSend.ok) {
          recordReplyRate(state, now)
          state.recentMessages = appendContextMessage(
            freshContext,
            buildAssistantContextMessage(session.botName, `[语音] ${replyText}`, now),
            ctx.config,
            now,
          )
          stateDirty = true
          if (mmState) {
            recordMemeReplyOutcome(mmState, null, ctx.config.meme_repeat_cooldown_seconds, now)
            mmDirty = true
          }
          voiceLog = {
            groupId: conversationId,
            provider: ctx.config.tts_provider,
            model: ctx.config.tts_model,
            voiceId: effectiveVoice.voiceId,
            emotion: voiceDecision.emotion,
            charCount: replyText.length,
            estimatedCost: prepared.estimatedCost,
            format: prepared.format,
            cached: prepared.cached,
            status: 'sent',
            error: '',
            createdAt: now,
          }
          const bg = runPostPersist(ctx, session, state, mmState, settings, {
            now,
            stateDirty,
            mmDirty,
            shouldExtractMemory: decision.recordContext,
            statsDelta,
            voiceLog,
            llmUsage: agentResult.usage,
            toolLogs: agentResult.toolLogs,
            routingLog,
          })
          await scheduleBackground(ctx, bg, opts.awaitBackground)
          return {
            replied: true,
            reason: voiceDecision.reason,
            score: decision.score,
            replyText,
            replyStyle: 'voice',
            visionUsed,
            voiceUsed: true,
            voiceCached: prepared.cached,
            usedAgentLoop: agentResult.usedAgentLoop,
            toolCallsCount: agentResult.usage.toolCalls,
            channel: activeChannel,
            escalated,
            candidateToolCount,
          }
        }

        const errMsg = `QQ 语音发送失败 (HTTP ${voiceSend.status}): ${voiceSend.error ?? ''}`
        voiceLog = {
          groupId: conversationId,
          provider: ctx.config.tts_provider,
          model: ctx.config.tts_model,
          voiceId: effectiveVoice.voiceId,
          emotion: voiceDecision.emotion,
          charCount: replyText.length,
          estimatedCost: prepared.estimatedCost,
          format: prepared.format,
          cached: prepared.cached,
          status: ctx.config.voice_fallback_to_text ? 'fallback_text' : 'failed',
          error: errMsg,
          createdAt: now,
        }
        if (!ctx.config.voice_fallback_to_text) {
          const bg = runPostPersist(ctx, session, state, mmState, settings, {
            now,
            stateDirty,
            mmDirty,
            shouldExtractMemory: decision.recordContext,
            statsDelta,
            voiceLog,
            llmUsage: agentResult.usage,
            toolLogs: agentResult.toolLogs,
            routingLog,
          })
          await scheduleBackground(ctx, bg, opts.awaitBackground)
          return {
            replied: false,
            reason: 'voice-send-failed',
            score: decision.score,
            replyStyle: 'none',
            visionUsed,
            channel: activeChannel,
            escalated,
            candidateToolCount,
          }
        }
      } else {
        voiceLog = {
          groupId: conversationId,
          provider: ctx.config.tts_provider,
          model: ctx.config.tts_model,
          voiceId: effectiveVoice.voiceId,
          emotion: voiceDecision.emotion,
          charCount: replyText.length,
          estimatedCost: 0,
          format: ctx.config.tts_audio_format,
          cached: false,
          status: ctx.config.voice_fallback_to_text ? 'fallback_text' : 'failed',
          error: prepared.error,
          createdAt: now,
        }
        if (!ctx.config.voice_fallback_to_text) {
          const bg = runPostPersist(ctx, session, state, mmState, settings, {
            now,
            stateDirty,
            mmDirty,
            shouldExtractMemory: decision.recordContext,
            statsDelta,
            voiceLog,
            llmUsage: agentResult.usage,
            toolLogs: agentResult.toolLogs,
            routingLog,
          })
          await scheduleBackground(ctx, bg, opts.awaitBackground)
          return {
            replied: false,
            reason: 'tts-failed',
            score: decision.score,
            replyStyle: 'none',
            visionUsed,
            channel: activeChannel,
            escalated,
            candidateToolCount,
          }
        }
      }
    }
  }

  // 2. 文字 / 表情包回复路径
  let replyStyle: ReplyStyle = 'text'
  let chosenMemeId: string | undefined
  let outgoing: OutgoingMessage = replyText

  if (!voiceLog && ctx.config.enable_meme_reply && mmState) {
    const candidates = await listAvailableMemesForGroup(
      ctx.db,
      conversationId,
      ctx.config.use_global_meme_library,
      now,
      60,
      ctx.config.share_memes_across_groups,
    )
    const memeDecision = selectMemeForReply({
      config: ctx.config,
      mmState,
      candidates,
      recentMessages: freshContext,
      userText,
      visionSummary,
      replyText,
      now,
      random: opts.random,
    })

    if ((memeDecision.style === 'meme' || memeDecision.style === 'text_and_meme') && memeDecision.meme) {
      const imgPayload = await resolveMemeOutgoingImage(ctx, memeDecision.meme)
      if (imgPayload) {
        replyStyle = memeDecision.style
        chosenMemeId = memeDecision.meme.id
        outgoing =
          memeDecision.style === 'meme'
            ? { image: imgPayload }
            : { text: replyText, image: imgPayload }
      }
    }
  }

  let sendResult = await session.reply(outgoing)
  if (!sendResult.ok && typeof outgoing !== 'string') {
    ctx.logger.warn('表情包发送失败，降级为纯文本回复', {
      conversationId,
      memeId: chosenMemeId,
      status: sendResult.status,
      error: sendResult.error,
    })
    chosenMemeId = undefined
    replyStyle = 'text'
    sendResult = await session.reply(replyText)
  }

  if (!sendResult.ok) {
    ctx.logger.warn('被动回复投递失败', {
      conversationId,
      status: sendResult.status,
      code: sendResult.code,
      error: sendResult.error,
    })
    const bg = runPostPersist(ctx, session, state, mmState, settings, {
      now,
      stateDirty,
      mmDirty,
      shouldExtractMemory: decision.recordContext,
      statsDelta,
      voiceLog,
      llmUsage: agentResult.usage,
      toolLogs: agentResult.toolLogs,
      routingLog,
    })
    await scheduleBackground(ctx, bg, opts.awaitBackground)
    return {
      replied: false,
      reason: 'send-failed',
      score: decision.score,
      replyStyle: 'none',
      visionUsed,
      channel: activeChannel,
      escalated,
      candidateToolCount,
    }
  }

  recordReplyRate(state, now)
  const recordedText = replyStyle === 'meme' ? '[表情包]' : replyText
  state.recentMessages = appendContextMessage(
    freshContext,
    buildAssistantContextMessage(session.botName, recordedText, now),
    ctx.config,
    now,
  )
  stateDirty = true

  if (mmState) {
    recordMemeReplyOutcome(mmState, chosenMemeId ?? null, ctx.config.meme_repeat_cooldown_seconds, now)
    mmDirty = true
    if (chosenMemeId) {
      statsDelta.memeSent = (statsDelta.memeSent ?? 0) + 1
    }
  }

  const bg = runPostPersist(ctx, session, state, mmState, settings, {
    now,
    stateDirty,
    mmDirty,
    shouldExtractMemory: decision.recordContext,
    statsDelta,
    usedMemeId: chosenMemeId,
    voiceLog,
    llmUsage: agentResult.usage,
    toolLogs: agentResult.toolLogs,
    routingLog,
  })
  await scheduleBackground(ctx, bg, opts.awaitBackground)

  return {
    replied: true,
    reason: voiceLog ? 'voice-fallback-text' : decision.reason,
    score: decision.score,
    replyText: recordedText,
    replyStyle,
    memeId: chosenMemeId,
    visionUsed,
    voiceUsed: false,
    usedAgentLoop: agentResult.usedAgentLoop,
    toolCallsCount: agentResult.usage.toolCalls,
    channel: activeChannel,
    escalated,
    candidateToolCount,
  }
}
