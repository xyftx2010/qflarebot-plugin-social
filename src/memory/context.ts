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
  config: Pick<SocialConfig, 'max_context_messages' | 'context_ttl_minutes'>,
  now = Date.now(),
): ContextMessage[] {
  const cutoff = now - config.context_ttl_minutes * 60_000
  const fresh = messages.filter((m) => m.ts >= cutoff)
  const maxItems = Math.max(1, config.max_context_messages)
  return fresh.length > maxItems ? fresh.slice(fresh.length - maxItems) : fresh
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
      return `${prefix}${quote}: ${m.text}`
    })
    .join('\n')
}
