import type {
  ContextMessage,
  GroupMultimodalState,
  MemeRecord,
  MemeSelectionDecision,
  SocialConfig,
} from '../types.js'

const MIN_MATCH_SCORE = 20

const MOOD_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  搞笑: ['哈哈', '笑死', 'hhh', '离谱', '绷不住', '绝了', '草', '乐'],
  无语: ['无语', '服了', '离谱', '什么鬼', '沉默', '汗', '麻了'],
  震惊: ['震惊', '卧槽', '居然', '真的假的', '离大谱', '惊了'],
  委屈: ['委屈', '呜呜', '难过', '惨', '哭', '心碎', '破防'],
  摆烂: ['摆烂', '摸鱼', '不想干', '累', '躺平', '下班', '睡'],
  开心: ['好耶', '开心', '太棒', '芜湖', '冲鸭', '爽', '赞'],
  吐槽: ['吐槽', '离谱', '槽点', '这也行', '就这', '逆天'],
}

export function extractQueryKeywords(text: string): string[] {
  const clean = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ')
  const raw = clean
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2)
  return [...new Set(raw)].slice(0, 24)
}

export function scoreMemeCandidate(meme: MemeRecord, combinedText: string, tokens: readonly string[]): number {
  const lower = combinedText.toLowerCase()
  let score = 0

  // 1. 标签命中
  let tagScore = 0
  for (const tag of meme.tags) {
    const t = tag.toLowerCase().trim()
    if (t.length >= 1 && lower.includes(t)) {
      tagScore += 26
    }
  }
  score += Math.min(52, tagScore)

  // 2. 情绪关键词与同义词命中
  if (meme.mood) {
    const moodLower = meme.mood.toLowerCase()
    if (lower.includes(moodLower)) {
      score += 24
    } else {
      const syns = MOOD_SYNONYMS[meme.mood] ?? []
      if (syns.some((s) => lower.includes(s))) {
        score += 22
      }
    }
  }

  // 3. 含义与适用场景匹配
  const desc = `${meme.meaning} ${meme.sceneHints} ${meme.category}`.toLowerCase()
  let overlap = 0
  for (const tok of tokens) {
    if (desc.includes(tok)) overlap += 12
  }
  // 中文短语反向包含检查（如 meaning 中含 "摸鱼"，对话中也含 "摸鱼"）
  for (const chunk of desc.split(/[\s,，。；;、/]+/)) {
    if (chunk.length >= 2 && lower.includes(chunk)) {
      overlap += 16
    }
  }
  score += Math.min(36, overlap)

  // 4. 群独立素材库小幅加权
  if (meme.scope === 'group') {
    score += 4
  }

  return score
}

/** 检测近期是否出现连续纯图/表情互动，防止机器人之间或群友无限斗图循环 */
export function isImageSpamLoop(recentMessages: readonly ContextMessage[]): boolean {
  if (recentMessages.length < 3) return false
  const tail = recentMessages.slice(-3)
  const imageOnlyCount = tail.filter((m) => m.text === '[发送了图片]' || m.text === '[表情包]').length
  return imageOnlyCount >= 3
}

export interface SelectMemeOptions {
  config: SocialConfig
  mmState: GroupMultimodalState
  candidates: readonly MemeRecord[]
  recentMessages: readonly ContextMessage[]
  userText: string
  visionSummary: string
  replyText: string
  now?: number
  random?: () => number
}

/**
 * 规则优先的智能表情包决策器（零额外 LLM 调用）：
 * - 严格过滤重复冷却期内的表情包；
 * - 限制连续表情包次数并防范斗图循环；
 * - 支持纯文本、纯表情包、文本+表情包三种回复形式。
 */
export function selectMemeForReply(opts: SelectMemeOptions): MemeSelectionDecision {
  const { config, mmState, candidates, recentMessages, userText, visionSummary, replyText } = opts
  const now = opts.now ?? Date.now()
  const rng = opts.random ?? Math.random

  if (!config.enable_meme_reply) {
    return { style: 'text', score: 0, reason: 'meme-disabled' }
  }
  if (candidates.length === 0) {
    return { style: 'text', score: 0, reason: 'no-candidates' }
  }
  if (mmState.consecutiveMemeCount >= config.max_consecutive_memes) {
    return { style: 'text', score: 0, reason: 'max-consecutive-memes' }
  }
  if (isImageSpamLoop(recentMessages)) {
    return { style: 'text', score: 0, reason: 'anti-meme-loop' }
  }

  const repeatCooldownMs = Math.max(0, config.meme_repeat_cooldown_seconds) * 1000
  const cooledIds = new Set(
    mmState.recentMemes
      .filter((r) => repeatCooldownMs > 0 && now - r.usedAt < repeatCooldownMs)
      .map((r) => r.id),
  )

  const eligible = candidates.filter((m) => m.enabled && m.expiresAt > now && !cooledIds.has(m.id))
  if (eligible.length === 0) {
    return { style: 'text', score: 0, reason: 'all-in-repeat-cooldown' }
  }

  const combinedText = `${userText}\n${visionSummary}\n${replyText}`
  const tokens = extractQueryKeywords(combinedText)

  let best: MemeRecord | null = null
  let bestScore = 0
  for (const meme of eligible) {
    const s = scoreMemeCandidate(meme, combinedText, tokens)
    if (s > bestScore) {
      bestScore = s
      best = meme
    }
  }

  if (!best || bestScore < MIN_MATCH_SCORE) {
    return { style: 'text', score: bestScore, reason: 'low-semantic-match' }
  }

  const prob = Math.min(1, Math.max(0, config.meme_send_probability))
  if (prob <= 0 || rng() >= prob) {
    return { style: 'text', score: bestScore, reason: 'probability-skip' }
  }

  // 高匹配度且回复很短时，有一定概率直接发纯表情包，更像真人群友
  const pureMeme = bestScore >= 46 && replyText.trim().length <= 16 && rng() < 0.35
  return {
    style: pureMeme ? 'meme' : 'text_and_meme',
    meme: best,
    score: bestScore,
    reason: pureMeme ? 'pure-meme-match' : 'text-and-meme-match',
  }
}

export function recordMemeReplyOutcome(
  mmState: GroupMultimodalState,
  memeId: string | null,
  repeatCooldownSeconds: number,
  now = Date.now(),
): void {
  const cutoff = now - Math.max(60, repeatCooldownSeconds) * 1000
  mmState.recentMemes = mmState.recentMemes.filter((r) => r.usedAt >= cutoff)

  if (memeId) {
    mmState.lastMemeSentAt = now
    mmState.consecutiveMemeCount += 1
    mmState.recentMemes.push({ id: memeId, usedAt: now })
  } else {
    mmState.consecutiveMemeCount = 0
  }
  mmState.updatedAt = now
}
