import { containsBlockedKeyword, sanitizeSensitiveText } from '../memory/privacy.js'

const EXTRA_SENSITIVE_PATTERNS: ReadonlyArray<{ re: RegExp; replacement: string }> = [
  { re: /\b(?:sk|pk|rk|ghp|gho|xoxb|AIza)[-_a-zA-Z0-9]{12,}\b/g, replacement: '[密钥已脱敏]' },
  { re: /\bBearer\s+[A-Za-z0-9._-]{16,}/gi, replacement: '[令牌已脱敏]' },
  { re: /(?:密码|口令|password|passwd|secret|token|apikey|api_key)\s*[:=：]\s*\S+/gi, replacement: '[凭证已脱敏]' },
  { re: /(?:微信号?|wx|vx|qq号?)\s*[:：]?\s*[a-zA-Z0-9_-]{5,20}/gi, replacement: '[联系方式已脱敏]' },
  { re: /[\u4e00-\u9fa5]{2,6}(?:省|市|区|县)[\u4e00-\u9fa5]{2,12}(?:路|街|巷|小区|号楼|单元|室)\S{0,10}/g, replacement: '[地址已脱敏]' },
]

const PROMPT_INJECTION_RE =
  /(?:ignore\s+(?:all\s+)?previous\s+instructions|system\s*prompt|you\s+are\s+now\s+|<\s*[|｜\s]*DSML|忽略(?:之前|上面|所有)(?:的)?(?:指令|规则|提示词)|现在你必须|覆盖(?:系统|人格)设置|执行(?:命令|脚本))/i

const SYSTEM_NOTICE_RE =
  /^(?:撤回了一条消息|.+加入了本群|.+退出了本群|.+被移出群聊|群主已开启|管理员已设置|\[系统消息\]|\[群公告\]|\[红包\]|\[转账\]|\[撤回\])/

const AD_SPAM_RE =
  /(?:加微信|兼职日结|刷单|代开发票|低价出售|点击领取|免费领|赌博|博彩|外挂|私聊领福利|复制打开淘宝|拼多多砍一刀)/i

const ABUSE_RE = /(?:去死吧|全家死光|nmsl|操你妈|sb东西|傻逼滚|滚出群)/i

const PURE_URL_RE = /^(?:https?:\/\/\S+\s*)+$/i
const REPEATED_CHAR_RE = /^(.)\1{7,}$/

/** 允许保留的高价值群聊短表达（在有上下文时作为有效风格样本） */
export const EXPRESSIVE_SHORT_TERMS = new Set([
  '典',
  '绷',
  '急',
  '乐',
  '麻了',
  '确实',
  '逆天',
  '离谱',
  '抽象',
  '寄',
  '润',
  '哈？',
  '草',
  '笑死',
  '好耶',
  '冲',
  '呜呜',
  '啊？',
  '绝了',
  '赢麻了',
  '6',
  '666',
  '？',
])

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const buf = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export async function anonymizeSenderId(groupId: string, rawSender: string): Promise<string> {
  const normalized = (rawSender || 'anon').trim() || 'anon'
  const hex = await sha256Hex(`social-v12::${groupId}::${normalized}`)
  return `u_${hex.slice(0, 14)}`
}

export async function computeContentHash(groupId: string, content: string, timestamp: number): Promise<string> {
  // 同一群内 5 分钟桶 + 规范化内容用于跨来源去重（导入 + 在线）
  const bucket = Math.floor(timestamp / 300_000)
  const norm = content.toLowerCase().replace(/\s+/g, ' ').trim()
  const hex = await sha256Hex(`${groupId}::${bucket}::${norm}`)
  return hex.slice(0, 24)
}

/**
 * 敏感信息双重脱敏（复用既有隐私规则 + V0.12.0 密钥/密码/联系方式/精确地址脱敏）。
 */
export function sanitizeCorpusText(raw: string): string {
  let text = raw.replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim()
  text = sanitizeSensitiveText(text).text
  for (const { re, replacement } of EXTRA_SENSITIVE_PATTERNS) {
    text = text.replace(re, replacement)
  }
  return text.replace(/\s+/g, ' ').trim()
}

export interface CleanEvaluationInput {
  rawContent: string
  senderIsBot?: boolean
  senderUncertainBot?: boolean
  blockedKeywords?: string
  hasContextNeighbor?: boolean
  timestamp: number
  now: number
}

export interface CleanEvaluationResult {
  accepted: boolean
  reason: string
  cleanedContent: string
  qualityScore: number
  learningStatus: 'pending' | 'review' | 'excluded'
}

/**
 * 语料清洗与客观质量评分（纯程序化，零 LLM 开销）。
 * - 严格排除机器人、系统通知、广告、注入、攻击性内容；
 * - 保留“典”“绷”“确实”等短表达（结合上下文作为有效风格样本）。
 */
export function evaluateAndCleanCorpus(input: CleanEvaluationInput): CleanEvaluationResult {
  if (input.senderIsBot) {
    return { accepted: false, reason: 'bot-message', cleanedContent: '', qualityScore: 0, learningStatus: 'excluded' }
  }

  const raw = (input.rawContent ?? '').trim()
  if (!raw) {
    return { accepted: false, reason: 'empty', cleanedContent: '', qualityScore: 0, learningStatus: 'excluded' }
  }
  if (SYSTEM_NOTICE_RE.test(raw)) {
    return { accepted: false, reason: 'system-notice', cleanedContent: '', qualityScore: 0, learningStatus: 'excluded' }
  }
  if (PROMPT_INJECTION_RE.test(raw)) {
    return { accepted: false, reason: 'prompt-injection', cleanedContent: '', qualityScore: 0, learningStatus: 'excluded' }
  }
  if (AD_SPAM_RE.test(raw)) {
    return { accepted: false, reason: 'ad-spam', cleanedContent: '', qualityScore: 0, learningStatus: 'excluded' }
  }
  if (ABUSE_RE.test(raw)) {
    return { accepted: false, reason: 'abusive', cleanedContent: '', qualityScore: 0, learningStatus: 'excluded' }
  }
  if (PURE_URL_RE.test(raw)) {
    return { accepted: false, reason: 'pure-url', cleanedContent: '', qualityScore: 0, learningStatus: 'excluded' }
  }
  if (REPEATED_CHAR_RE.test(raw)) {
    return { accepted: false, reason: 'char-flood', cleanedContent: '', qualityScore: 0, learningStatus: 'excluded' }
  }
  if (input.blockedKeywords && containsBlockedKeyword(raw, input.blockedKeywords)) {
    return { accepted: false, reason: 'blocked-keyword', cleanedContent: '', qualityScore: 0, learningStatus: 'excluded' }
  }

  // 忽略机器人命令（/ask、/social 等）
  if (/^\/[a-zA-Z\u4e00-\u9fa5]/.test(raw)) {
    return { accepted: false, reason: 'bot-command', cleanedContent: '', qualityScore: 0, learningStatus: 'excluded' }
  }

  const cleaned = sanitizeCorpusText(raw).slice(0, 400)
  if (!cleaned || cleaned === '[已脱敏]' || cleaned === '[密钥已脱敏]') {
    return { accepted: false, reason: 'only-sensitive', cleanedContent: '', qualityScore: 0, learningStatus: 'excluded' }
  }

  // 客观质量评分（0 ~ 1）
  let score = 0.45
  const len = cleaned.length
  const isExpressiveShort = EXPRESSIVE_SHORT_TERMS.has(cleaned)
  if (len >= 6 && len <= 80) {
    score += 0.2
  } else if (len < 6) {
    if (isExpressiveShort || input.hasContextNeighbor) {
      score += 0.1
    } else {
      score -= 0.15
    }
  } else if (len > 200) {
    score -= 0.1
  }

  // 中文口语/对话特征加分
  if (/[\u4e00-\u9fa5]/.test(cleaned)) score += 0.1
  if (/[？?！!~～…]|(?:哈哈|笑死|确实|离谱|绷|典|吧|呢|啊|呀|嘛|哦)/.test(cleaned)) score += 0.1
  // 包含脱敏占位符略降权
  if (cleaned.includes('已脱敏]')) score -= 0.12

  // 时间新鲜度（30 天内满权，超出温和衰减）
  const ageDays = Math.max(0, (input.now - input.timestamp) / 86_400_000)
  if (ageDays <= 30) score += 0.08
  else if (ageDays > 90) score -= 0.08

  // 疑似未确认机器人降权并进入 review 队列
  if (input.senderUncertainBot) {
    score = Math.max(0.1, score - 0.3)
    return {
      accepted: true,
      reason: 'uncertain-bot-review',
      cleanedContent: cleaned,
      qualityScore: Number(Math.min(1, Math.max(0.05, score)).toFixed(3)),
      learningStatus: 'review',
    }
  }

  const finalScore = Number(Math.min(1, Math.max(0.05, score)).toFixed(3))
  return {
    accepted: true,
    reason: 'ok',
    cleanedContent: cleaned,
    qualityScore: finalScore,
    learningStatus: 'pending',
  }
}

/**
 * 提取 CJK 二元组与英文词元，供 D1 轻量检索替代无中文分词能力的 FTS5。
 */
export function extractSearchTokens(text: string, maxTokens = 40): string[] {
  const lower = text.toLowerCase()
  const tokens = new Set<string>()
  for (const word of lower.match(/[a-z0-9]{2,16}/g) ?? []) {
    tokens.add(word)
  }
  for (const seg of lower.match(/[\u4e00-\u9fa5]{2,}/g) ?? []) {
    if (seg.length <= 4) tokens.add(seg)
    for (let i = 0; i <= seg.length - 2; i += 1) {
      tokens.add(seg.slice(i, i + 2))
    }
  }
  return [...tokens].slice(0, maxTokens)
}
