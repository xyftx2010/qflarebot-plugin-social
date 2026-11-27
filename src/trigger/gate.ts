import type { Session } from '@qqbot/sdk'
import type { GroupSettings, GroupState, SocialConfig, SocialMode, TriggerDecision } from '../types.js'
import { extractReadableText } from '../memory/context.js'
import { containsBlockedKeyword } from '../memory/privacy.js'
import { scoreGroupMessage } from './scorer.js'

const RATE_WINDOW_MS = 60_000

export function resolveEffectiveMode(config: SocialConfig, settings?: GroupSettings | null): SocialMode {
  return settings?.mode ?? config.default_mode
}

export function resolveEffectiveCooldownSeconds(config: SocialConfig, settings?: GroupSettings | null): number {
  const val = settings?.cooldownSeconds ?? config.cooldown_seconds
  return Math.max(0, Math.floor(val))
}

export function resolveEffectiveProbability(config: SocialConfig, settings?: GroupSettings | null): number {
  const val = settings?.replyProbability ?? config.base_reply_probability
  return Math.min(1, Math.max(0, val))
}

export function isRateLimited(state: GroupState, maxPerMinute: number, now: number): boolean {
  if (maxPerMinute <= 0) return false
  if (now - state.windowStartAt >= RATE_WINDOW_MS) return false
  return state.windowReplyCount >= maxPerMinute
}

export function recordReplyRate(state: GroupState, now: number): void {
  if (now - state.windowStartAt >= RATE_WINDOW_MS) {
    state.windowStartAt = now
    state.windowReplyCount = 1
  } else {
    state.windowReplyCount += 1
  }
  state.lastReplyAt = now
}

export interface GateOptions {
  session: Session
  config: SocialConfig
  settings?: GroupSettings | null
  state: GroupState
  callNames: readonly string[]
  now?: number
  random?: () => number
}

/**
 * 第一层前置守卫 + 第二层启发式发言判断。
 *
 * 严格遵循 QFlareBot 官方收件人规则：
 * - 先拦截机器人自身消息与 `session.addressedToOthers`；
 * - 同群启用 Agent 且 `yield_at_to_agent: true` 时让渡 `@机器人` 消息，避免重复调用模型和重复回复。
 */
const CONTINUOUS_FOLLOWUP_WINDOW_MS = 90_000
const CONTINUOUS_FOLLOWUP_MIN_COOLDOWN_MS = 3_000
const CONTINUOUS_FOLLOWUP_RE =
  /^(?:那|还有|再|顺便|明天|后天|晚上|换成|换个|另外)|[?？]|(?:呢|吗|嘛|么|啥|多少|怎么|几点|周几)$/

function isContinuousFollowup(session: Session, state: GroupState, text: string, now: number): boolean {
  const recent = state.recentMessages
  if (recent.length < 2) return false
  const last = recent[recent.length - 1]
  if (!last || last.role !== 'assistant' || now - last.ts > CONTINUOUS_FOLLOWUP_WINDOW_MS) return false
  const prevUser = [...recent].slice(0, -1).reverse().find((m) => m.role === 'user')
  if (!prevUser || !session.userId || prevUser.speakerKey !== session.userId) return false
  return CONTINUOUS_FOLLOWUP_RE.test(text.trim())
}
function isOtherBotSender(session: Session): boolean {
  const raw = session.raw as { author?: { bot?: unknown } } | undefined
  return raw?.author?.bot === true
}

export function evaluateTrigger(opts: GateOptions): TriggerDecision {
  const { session, config, settings, state, callNames } = opts
  const now = opts.now ?? Date.now()

  if (session.userId === session.botId) {
    return { shouldReply: false, reason: 'bot-self', score: 0, recordContext: false }
  }
  if (isOtherBotSender(session)) {
    return { shouldReply: false, reason: 'bot-sender', score: 0, recordContext: false }
  }
  if (session.scene !== 'group') {
    return { shouldReply: false, reason: 'not-group', score: 0, recordContext: false }
  }
  if (session.addressedToOthers) {
    return { shouldReply: false, reason: 'addressed-to-others', score: 0, recordContext: false }
  }

  const text = extractReadableText(session)
  if (!text) {
    return { shouldReply: false, reason: 'empty', score: 0, recordContext: false }
  }

  const mode = resolveEffectiveMode(config, settings)
  if (mode === 'off') {
    return { shouldReply: false, reason: 'mode-off', score: 0, recordContext: false }
  }

  const combinedForSafety = [text, session.quote?.content].filter(Boolean).join('\n')
  if (containsBlockedKeyword(combinedForSafety, config.blocked_keywords)) {
    return { shouldReply: false, reason: 'blocked-keyword', score: 0, recordContext: false }
  }

  // 防重复回复核心规则：与 qflarebot-plugin-agent 同群共装时，@机器人 交给 Agent 统一处理
  if (session.atMe && config.yield_at_to_agent) {
    return { shouldReply: false, reason: 'yield-to-agent', score: 0, recordContext: true }
  }

  if (!session.atMe && mode === 'at') {
    return { shouldReply: false, reason: 'at-only-mode', score: 0, recordContext: true }
  }

  const continuousFollowup = !session.atMe && isContinuousFollowup(session, state, text, now)

  const rawCooldownMs = resolveEffectiveCooldownSeconds(config, settings) * 1000
  const cooldownMs = continuousFollowup
    ? Math.min(rawCooldownMs, CONTINUOUS_FOLLOWUP_MIN_COOLDOWN_MS)
    : rawCooldownMs
  if (cooldownMs > 0 && state.lastReplyAt > 0 && now - state.lastReplyAt < cooldownMs) {
    return { shouldReply: false, reason: 'cooldown', score: 0, recordContext: true }
  }

  if (isRateLimited(state, config.max_replies_per_minute, now)) {
    return { shouldReply: false, reason: 'rate-limited', score: 0, recordContext: true }
  }

  if (session.atMe) {
    return { shouldReply: true, reason: 'at-me', score: 100, recordContext: true }
  }

  const { score } = scoreGroupMessage({
    text,
    callNames,
    baseProbability: resolveEffectiveProbability(config, settings),
    msSinceLastReply: state.lastReplyAt > 0 ? now - state.lastReplyAt : Number.MAX_SAFE_INTEGER,
    isContinuousFollowup: continuousFollowup,
    random: opts.random,
  })

  if (score >= config.trigger_threshold) {
    return { shouldReply: true, reason: 'score-pass', score, recordContext: true }
  }

  return { shouldReply: false, reason: 'score-below-threshold', score, recordContext: true }
}
