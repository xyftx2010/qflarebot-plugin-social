import type { Session } from '@qqbot/sdk'
import type { ContextMessage, SocialConfig } from '../types.js'
import { makeSpeakerKey, sanitizeSensitiveText } from './privacy.js'

const MAX_SINGLE_MSG_LEN = 220
const MAX_QUOTE_LEN = 80

export function truncateText(text: string, maxLen: number): string {
  const trimmed = text.replace(/\s+/g, ' ').trim()
  if (trimmed.length <= maxLen) return trimmed
  return `${trimmed.slice(0, maxLen - 1)}…`
}

/**
 * 读取适合交给 AI 与上下文滑窗的正文：
 * 优先 session.displayContent（保留其他人的 @群昵称 和 QQ 表情描述），回退 session.content。
 */
export function extractReadableText(session: Session): string {
  const raw = (session.displayContent ?? session.content ?? '').trim()
  if (raw) return raw
  if (session.attachments.length > 0) {
    const types = session.attachments.map((a) => (a.contentType?.startsWith('image/') ? '图片' : '附件'))
    return `[发送了${types.join('、')}]`
  }
  if (session.quote && session.quote.attachments.length > 0) {
    return '[引用了图片]'
  }
  return ''
}

export function resolveSpeakerName(session: Session): string {
  const name = (session.groupNickname ?? session.userName ?? '').trim()
  return name || '群友'
}

export function buildUserContextMessage(session: Session, now = Date.now()): ContextMessage | null {
  const rawText = extractReadableText(session)
  if (!rawText) return null
  const sanitized = sanitizeSensitiveText(rawText)
  const quoteRaw = session.quote?.content?.trim()
  const quoteSummary = quoteRaw ? truncateText(sanitizeSensitiveText(quoteRaw).text, MAX_QUOTE_LEN) : undefined
  return {
    role: 'user',
    speakerKey: makeSpeakerKey(session.userId),
    speakerName: resolveSpeakerName(session),
    text: truncateText(sanitized.text, MAX_SINGLE_MSG_LEN),
    atMe: session.atMe,
    ...(quoteSummary ? { quoteSummary } : {}),
    ts: now,
  }
}

export function buildAssistantContextMessage(botName: string, replyText: string, now = Date.now()): ContextMessage {
  return {
    role: 'assistant',
    speakerKey: 'bot',
    speakerName: botName.trim() || '我',
    text: truncateText(replyText, MAX_SINGLE_MSG_LEN),
    atMe: false,
    ts: now,
  }
}

export function pruneContextWindow(
  messages: readonly ContextMessage[],
  config: Pick<SocialConfig, 'max_context_messages' | 'context_ttl_minutes'> & { context_max_tokens?: number },
  now = Date.now(),
): ContextMessage[] {
  const cutoff = now - config.context_ttl_minutes * 60_000
  const fresh = messages.filter((m) => m.ts >= cutoff)
  const maxItems = Math.max(1, config.max_context_messages)
  const trimmed = fresh.length > maxItems ? fresh.slice(fresh.length - maxItems) : fresh
  const maxTokens = config.context_max_tokens ?? 3000
  return compressContextToTokenBudget(trimmed, maxTokens)
}

/** 轻量估算文本 Token 数（中文约 1.5 字/token，ASCII 约 4 字符/token） */
export function estimateTokens(text: string): number {
  let cjk = 0
  let ascii = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code >= 0x4e00 && code <= 0x9fff) cjk += 1
    else ascii += 1
  }
  return Math.ceil(cjk / 1.5 + ascii / 4)
}

/** 超出 Token 预算时从最早消息开始压缩裁剪，始终保留至少最新 2 条语境 */
export function compressContextToTokenBudget(
  messages: readonly ContextMessage[],
  maxTokens: number,
): ContextMessage[] {
  if (messages.length <= 2 || maxTokens <= 0) return [...messages]
  const kept: ContextMessage[] = []
  let tokens = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    const cost = estimateTokens(`${m.speakerName} ${m.text} ${m.quoteSummary ?? ''} ${m.imageSummary ?? ''}`) + 8
    if (kept.length >= 2 && tokens + cost > maxTokens) break
    kept.unshift(m)
    tokens += cost
  }
  return kept
}

export function appendContextMessage(
  messages: readonly ContextMessage[],
  next: ContextMessage,
  config: Pick<SocialConfig, 'max_context_messages' | 'context_ttl_minutes'>,
  now = Date.now(),
): ContextMessage[] {
  return pruneContextWindow([...messages, next], config, now)
}

/** 格式化为可读的群聊记录片段（供提示词与 v5 只读工具使用） */
export function formatContextTranscript(messages: readonly ContextMessage[]): string {
  if (messages.length === 0) return '（近期暂无群聊记录）'
  return messages
    .map((m) => {
      const prefix = m.role === 'assistant' ? `[我]` : `[${m.speakerName}(${m.speakerKey})]`
      const quote = m.quoteSummary ? `（引用：“${m.quoteSummary}”）` : ''
      const img = m.imageSummary ? ` [图意：${m.imageSummary}]` : ''
      return `${prefix}${quote}: ${m.text}${img}`
    })
    .join('\n')
}
