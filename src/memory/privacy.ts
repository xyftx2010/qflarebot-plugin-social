/**
 * 群聊记忆隐私保护与敏感信息脱敏。
 *
 * 原则：
 * 1. 仅记录娱乐向公开梗与无害偏好，不落库手机号、身份证号、邮箱、凭据与私密链接；
 * 2. 成员可随时通过 /social forgetme 删除本人在本群的全部记忆；
 * 3. 成员可通过 /social privacy off 退出记忆收集（Opt-out）。
 */

const SENSITIVE_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: 'phone', pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/g },
  { label: 'id_card', pattern: /(?<!\d)\d{17}[\dXx](?!\d)/g },
  { label: 'email', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { label: 'secret', pattern: /\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/g },
  { label: 'auth_query', pattern: /https?:\/\/[^\s]*[?&](?:token|key|secret|password|auth)=[^\s&]+/gi },
]

export interface SanitizeResult {
  text: string
  hadSensitive: boolean
  matchedLabels: string[]
}

/** 对拟写入记忆或上下文的文本做敏感信息脱敏 */
export function sanitizeSensitiveText(input: string): SanitizeResult {
  let text = input
  const matchedLabels: string[] = []
  for (const { label, pattern } of SENSITIVE_PATTERNS) {
    pattern.lastIndex = 0
    if (pattern.test(text)) {
      matchedLabels.push(label)
      pattern.lastIndex = 0
      text = text.replace(pattern, '[已脱敏]')
    }
  }
  return {
    text,
    hadSensitive: matchedLabels.length > 0,
    matchedLabels,
  }
}

/** 不可逆短标识：用于区分同群同名成员，避免在提示词中暴露原始 openid */
export function makeSpeakerKey(userId: string): string {
  let hash = 2166136261
  for (let i = 0; i < userId.length; i++) {
    hash ^= userId.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return `u_${(hash >>> 0).toString(36).slice(0, 6)}`
}

export function parseKeywords(raw: string): string[] {
  return raw
    .split(/[,，\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

export function containsBlockedKeyword(text: string, blockedRaw: string): string | null {
  const keywords = parseKeywords(blockedRaw)
  if (keywords.length === 0) return null
  const lower = text.toLowerCase()
  for (const kw of keywords) {
    if (lower.includes(kw.toLowerCase())) return kw
  }
  return null
}
