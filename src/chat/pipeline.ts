import type { OutgoingMessage, PluginContext, Session } from '@qqbot/sdk'
import type {
  GroupMemory,
  GroupMultimodalState,
  GroupSettings,
  GroupState,
  LLMChatMessage,
  LLMService,
  ReplyStyle,
  SocialConfig,
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

export interface PipelineOptions {
  now?: () => number
  random?: () => number
  fetchImpl?: typeof fetch
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
  },
): Promise<void> {
  const { now, shouldExtractMemory, statsDelta, usedMemeId, voiceLog } = opts
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
 * 群聊主处理管线（V0.10.0 多模态 + AI 语音版）：
 * 1 次合批 D1 读取 -> 零成本触发判断 -> 按需图片理解 -> 单次 LLM 同时生成回复与语音情绪决策
 * -> 文字 / 表情包 / 原生语音互斥发送（失败降级文字） -> 异步后台落库与清理。
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
  const snapshot = await loadGroupChatSnapshot(ctx.db, groupId, now, ctx.config.enable_memory, 24)
  const settings = snapshot.settings
  const state = snapshot.state ?? createEmptyGroupState(groupId, now)
  let stateDirty = false
  let mmState: GroupMultimodalState | null = null
  let mmDirty = false
  const statsDelta: MultimodalStatsDelta = {
    visionCalls: 0,
    visionCacheHits: 0,
    visionErrors: 0,
    memeSent: 0,
  }

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

  const userMsg = decision.recordContext ? buildUserContextMessage(session, now) : null
  if (userMsg) {
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
    ctx.logger.warn('llm 服务不可用，跳过拟人回复', { groupId })
    if (session.atMe) {
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
  const [loadedMmState, groupVoiceSettings] = await Promise.all([
    hasImages || ctx.config.enable_meme_reply ? getGroupMultimodalState(ctx.db, groupId) : Promise.resolve(null),
    ctx.config.tts_api_key.trim() ? getGroupVoiceSettings(ctx.db, groupId) : Promise.resolve(null),
  ])
  if (hasImages || ctx.config.enable_meme_reply) {
    mmState = loadedMmState ?? createEmptyMultimodalState(groupId, now)
  }
  const effectiveVoice = resolveEffectiveVoiceConfig(ctx.config, groupVoiceSettings)

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
  const userText = extractReadableText(session)
  const relevantMemories = selectRelevantMemories(snapshot.memories, `${userText} ${visionTagsText}`, 10)
  const voicePromptHint = buildVoicePromptDirective(effectiveVoice)
  const systemPrompt = [
    buildSocialSystemPrompt(persona, relevantMemories, session.botName),
    voicePromptHint,
  ]
    .filter(Boolean)
    .join('\n\n')
  const transcript = formatContextTranscript(freshContext)
  const currentSpeaker = resolveSpeakerName(session)

  const promptSections: string[] = ['以下是当前 QQ 群的近期聊天片段：', transcript]
  if (visionSummary) {
    promptSections.push('', '本条消息涉及的图片内容解析：', visionSummary)
  }
  if (visionNotes.length > 0 && !visionSummary) {
    promptSections.push('', `图片读取备注：${visionNotes.join('；')}（如果看不到图就自然接文字话题，不要硬编图片内容）`)
  }
  promptSections.push(
    '',
    `请结合语境自然回应最新一条来自「${currentSpeaker}」的消息，可以轻松吐槽或接梗，只输出你要发到群里的回复正文。`,
  )

  const messages: LLMChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: promptSections.join('\n') },
  ]

  let rawReply = ''
  try {
    const result = await llm.chat({
      model: ctx.config.model_alias.trim() || undefined,
      messages,
      temperature: ctx.config.temperature,
      max_tokens: ctx.config.max_output_tokens,
      timeout_ms: ctx.config.llm_timeout_ms,
    })
    rawReply = (result.text ?? '').trim()
  } catch (err) {
    ctx.logger.warn('LLM 调用失败，已静默降级', {
      groupId,
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
    return { replied: false, reason: 'llm-error', score: decision.score, replyStyle: 'none', visionUsed }
  }

  const parsedVoice = parseVoiceDirective(rawReply)
  const replyText = parsedVoice.cleanText

  if (!replyText) {
    const bg = runPostPersist(ctx, session, state, mmState, settings, {
      now,
      stateDirty,
      mmDirty,
      shouldExtractMemory: decision.recordContext,
      statsDelta,
    })
    await scheduleBackground(ctx, bg, opts.awaitBackground)
    return { replied: false, reason: 'empty-reply', score: decision.score, replyStyle: 'none', visionUsed }
  }

  if (containsBlockedKeyword(replyText, ctx.config.blocked_keywords)) {
    ctx.logger.warn('出站回复命中过滤关键词，已拦截', { groupId })
    const bg = runPostPersist(ctx, session, state, mmState, settings, {
      now,
      stateDirty,
      mmDirty,
      shouldExtractMemory: decision.recordContext,
      statsDelta,
    })
    await scheduleBackground(ctx, bg, opts.awaitBackground)
    return { replied: false, reason: 'blocked-output', score: decision.score, replyStyle: 'none', visionUsed }
  }

  // 1. 判断是否走原生语音回复（语音与文字/表情包互斥，绝不同时重复发送）
  let voiceLog: Omit<VoiceLogRecord, 'id'> | undefined
  if (effectiveVoice.enabled) {
    const sentToday =
      effectiveVoice.dailyLimit > 0 ? await countGroupVoiceSentToday(ctx.db, groupId, now) : 0
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
        groupId,
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
            groupId,
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
          }
        }

        // QQ 语音投递失败：记录日志并按配置降级为文字
        const errMsg = `QQ 语音发送失败 (HTTP ${voiceSend.status}): ${voiceSend.error ?? ''}`
        voiceLog = {
          groupId,
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
          })
          await scheduleBackground(ctx, bg, opts.awaitBackground)
          return { replied: false, reason: 'voice-send-failed', score: decision.score, replyStyle: 'none', visionUsed }
        }
      } else {
        // TTS 合成失败：记录日志并按配置降级为文字
        voiceLog = {
          groupId,
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
          })
          await scheduleBackground(ctx, bg, opts.awaitBackground)
          return { replied: false, reason: 'tts-failed', score: decision.score, replyStyle: 'none', visionUsed }
        }
      }
    }
  }

  // 2. 文字 / 表情包回复路径（含语音失败降级）
  let replyStyle: ReplyStyle = 'text'
  let chosenMemeId: string | undefined
  let outgoing: OutgoingMessage = replyText

  if (!voiceLog && ctx.config.enable_meme_reply && mmState) {
    const candidates = await listAvailableMemesForGroup(
      ctx.db,
      groupId,
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
      groupId,
      memeId: chosenMemeId,
      status: sendResult.status,
      error: sendResult.error,
    })
    chosenMemeId = undefined
    replyStyle = 'text'
    sendResult = await session.reply(replyText)
  }

  if (!sendResult.ok) {
    ctx.logger.warn('群聊被动回复投递失败', {
      groupId,
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
    })
    await scheduleBackground(ctx, bg, opts.awaitBackground)
    return { replied: false, reason: 'send-failed', score: decision.score, replyStyle: 'none', visionUsed }
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
  }
}
