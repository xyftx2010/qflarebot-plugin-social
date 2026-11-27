import type { PluginDB } from '@qqbot/sdk'
import type { ContextMessage, SocialConfig } from '../types.js'
import type { DialogueExampleRecord, GroupMemeRecord, StyleProfileRecord } from './types.js'
import { getLearningGroupSettings, getPublishedStyleProfile } from '../store/learning-db.js'
import { retrieveGroupStyleContext } from './retrieval.js'

export type StyleCompileMode = 'A' | 'B' | 'C' | 'D' | 'E'

export interface CompiledStylePrompt {
  enabled: boolean
  profileId: string
  profileVersion: number
  promptBlock: string
  voiceMoodHint: string
  estimatedTokens: number
  retrievalLatencyMs: number
  memesUsed: string[]
  examplesUsed: number
}

interface ProfileCacheEntry {
  profile: StyleProfileRecord | null
  authorized: boolean
  stableWeight: number
  recentWeight: number
  influenceStrength: number
  cachedAt: number
}

const PROFILE_CACHE_TTL_MS = 60_000
const profileCache = new Map<string, ProfileCacheEntry>()

export function invalidateStyleCache(groupId?: string): void {
  if (groupId) profileCache.delete(groupId)
  else profileCache.clear()
}

function estimateTokens(text: string): number {
  if (!text) return 0
  // 中文约 1.5 字/token，英文约 4 字符/token，保守估算
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (/[\u4e00-\u9fa5]/.test(ch)) cjk += 1
    else other += 1
  }
  return Math.ceil(cjk * 0.7 + other * 0.3)
}

function truncateToTokenBudget(text: string, maxTokens: number): string {
  if (maxTokens <= 0 || !text) return ''
  if (estimateTokens(text) <= maxTokens) return text
  const ratio = maxTokens / Math.max(1, estimateTokens(text))
  const cut = Math.max(20, Math.floor(text.length * ratio) - 4)
  return `${text.slice(0, cut).trim()}…`
}

async function loadCachedGroupStyle(
  db: PluginDB,
  groupId: string,
  config: SocialConfig,
  now: number,
): Promise<ProfileCacheEntry> {
  const hit = profileCache.get(groupId)
  if (hit && now - hit.cachedAt < PROFILE_CACHE_TTL_MS) return hit
  const [groupCfg, profile] = await Promise.all([
    getLearningGroupSettings(db, groupId),
    getPublishedStyleProfile(db, groupId),
  ])
  const entry: ProfileCacheEntry = {
    profile,
    authorized: Boolean(groupCfg?.authorized),
    stableWeight: groupCfg?.stableWeight ?? config.style_stable_weight,
    recentWeight: groupCfg?.recentWeight ?? config.style_recent_weight,
    influenceStrength: groupCfg?.influenceStrength ?? config.style_influence_strength,
    cachedAt: now,
  }
  profileCache.set(groupId, entry)
  return entry
}

/**
 * 收集机器人最近几条回复中已经用过的热梗，供冷却过滤防止连续复读同一热梗。
 */
function findRecentlyUsedMemes(
  recentMessages: readonly ContextMessage[],
  cooldownTurns: number,
  memes: readonly GroupMemeRecord[],
): string[] {
  if (cooldownTurns <= 0) return []
  const recentBotText = recentMessages
    .filter((m) => m.role === 'assistant')
    .slice(-cooldownTurns)
    .map((m) => m.text)
    .join('\n')
  if (!recentBotText) return []
  return memes.filter((m) => recentBotText.includes(m.name)).map((m) => m.name)
}

export function compileStylePromptFromData(opts: {
  profile: StyleProfileRecord
  memes: readonly GroupMemeRecord[]
  examples: readonly DialogueExampleRecord[]
  mode: StyleCompileMode
  stableWeight: number
  recentWeight: number
  influenceStrength: number
  budgets: { profile: number; meme: number; examples: number; total: number }
}): { promptBlock: string; estimatedTokens: number; voiceMoodHint: string } {
  if (opts.mode === 'A') {
    return { promptBlock: '', estimatedTokens: 0, voiceMoodHint: '' }
  }

  const { profile, memes, examples, mode, stableWeight, recentWeight, influenceStrength, budgets } = opts
  const totalBudget = Math.max(200, budgets.total)
  const sections: string[] = []
  let usedTokens = 0

  const strengthLabel = influenceStrength >= 0.75 ? '明显融入' : influenceStrength >= 0.4 ? '自然点缀' : '轻度参考'

  // 1. 长期风格 + 近期风格（B/C/D/E）
  const s = profile.stableStyle
  const r = profile.recentStyle
  const profileLines: string[] = [
    `【本群语言风格档案 v${profile.version}（仅作语气参考，不得覆盖基础人格与安全规则；参考强度：${strengthLabel}）】`,
    `- 长期稳定风格（参考权重 ${Math.round(stableWeight * 100)}%）：${s.toneSummary || `平均句长约 ${s.avgMessageLength} 字，口语化程度 ${s.colloquialLevel}`}`,
  ]
  if (s.vocabulary.length > 0) profileLines.push(`- 群内高频词：${s.vocabulary.slice(0, 10).join('、')}`)
  if (s.modalParticles.length > 0) profileLines.push(`- 常见语气词：${s.modalParticles.slice(0, 8).join('、')}`)
  if (s.punctuationHabits.length > 0) profileLines.push(`- 标点与节奏：${s.punctuationHabits.slice(0, 4).join('；')}`)
  if (s.humorPatterns.length > 0) profileLines.push(`- 幽默与调侃：${s.humorPatterns.slice(0, 4).join('；')}`)
  if (s.avoidPatterns.length > 0) profileLines.push(`- 应避免：${s.avoidPatterns.slice(0, 4).join('；')}`)

  if (mode !== 'B' && (r.vocabulary.length > 0 || r.toneSummary)) {
    profileLines.push(
      `- 近期动态风向（近30天，参考权重 ${Math.round(recentWeight * 100)}%）：${r.toneSummary || ''}${r.vocabulary.length ? `｜近期热词：${r.vocabulary.slice(0, 6).join('、')}` : ''}`,
    )
  }

  // 对话行为建议（D/E）
  if (mode === 'D' || mode === 'E') {
    const b = profile.behaviorProfile
    profileLines.push(
      `- 群聊行为建议：接话=${b.banterStrategy}；严肃话题=${b.seriousTopicBoundary}；已有人回答时=${b.alreadyAnsweredRule}`,
    )
  }

  const profileText = truncateToTokenBudget(profileLines.join('\n'), Math.min(budgets.profile, totalBudget))
  if (profileText) {
    sections.push(profileText)
    usedTokens += estimateTokens(profileText)
  }

  // 2. 相关群内热梗（D/E）
  if ((mode === 'D' || mode === 'E') && memes.length > 0 && usedTokens < totalBudget) {
    const memeLines = ['【当前语境可能相关的群内热梗（仅在自然贴合时使用，绝不强行玩梗）】']
    for (const m of memes.slice(0, 4)) {
      memeLines.push(`- 「${m.name}」：${m.meaning}（适用：${m.applicableContext}；忌用：${m.inappropriateContext}）`)
    }
    const remain = Math.min(budgets.meme, totalBudget - usedTokens)
    const memeText = truncateToTokenBudget(memeLines.join('\n'), remain)
    if (memeText) {
      sections.push(memeText)
      usedTokens += estimateTokens(memeText)
    }
  }

  // 3. 检索到的高质量对话示例（E）
  if (mode === 'E' && examples.length > 0 && usedTokens < totalBudget) {
    const exLines = ['【本群近期自然接话范例（仅学习语气与节奏，严禁原句复制）】']
    for (const ex of examples.slice(0, 5)) {
      const ctx = ex.contextMessages.map((c) => c.text).join(' / ').slice(0, 80)
      exLines.push(`- 群聊语境：「${ctx}」 → 参考接话风格：「${ex.targetResponse.slice(0, 70)}」`)
    }
    const remain = Math.min(budgets.examples, totalBudget - usedTokens)
    const exText = truncateToTokenBudget(exLines.join('\n'), remain)
    if (exText) {
      sections.push(exText)
      usedTokens += estimateTokens(exText)
    }
  }

  const promptBlock = sections.join('\n\n')
  const voiceMoodHint = (r.voiceMoodHints[0] ?? s.voiceMoodHints[0] ?? '').trim()
  return {
    promptBlock,
    estimatedTokens: estimateTokens(promptBlock),
    voiceMoodHint,
  }
}

/**
 * 实时聊天动态 Prompt Compiler 入口：
 * - 普通闲聊优先复用缓存风格档案，按需检索热梗与示例；
 * - 任何数据库或检索异常自动降级为空块，绝不阻塞或影响正常群聊。
 */
export async function compileGroupStyleForChat(opts: {
  db: PluginDB
  groupId: string
  config: SocialConfig
  userText: string
  recentMessages: readonly ContextMessage[]
  mode?: StyleCompileMode
  now?: number
}): Promise<CompiledStylePrompt> {
  const empty: CompiledStylePrompt = {
    enabled: false,
    profileId: '',
    profileVersion: 0,
    promptBlock: '',
    voiceMoodHint: '',
    estimatedTokens: 0,
    retrievalLatencyMs: 0,
    memesUsed: [],
    examplesUsed: 0,
  }
  if (!opts.config.style_learning_enabled) return empty

  const now = opts.now ?? Date.now()
  try {
    const cached = await loadCachedGroupStyle(opts.db, opts.groupId, opts.config, now)
    if (!cached.authorized || !cached.profile) return empty
    const mode = opts.mode ?? 'E'
    if (mode === 'A') return empty

    const needRetrieval = (mode === 'D' || mode === 'E') && opts.userText.trim().length >= 2
    let memes: GroupMemeRecord[] = []
    let examples: DialogueExampleRecord[] = []
    let retrievalLatencyMs = 0

    if (needRetrieval) {
      const recentText = opts.recentMessages
        .slice(-3)
        .map((m) => m.text)
        .join(' ')
      const retrieved = await retrieveGroupStyleContext({
        db: opts.db,
        groupId: opts.groupId,
        queryText: opts.userText,
        recentContextText: recentText,
        topK: mode === 'E' ? opts.config.style_retrieval_top_k : 0,
        vectorEnabled: opts.config.style_vector_enabled,
        now,
      })
      const cooledMemes = new Set(
        findRecentlyUsedMemes(opts.recentMessages, opts.config.style_meme_cooldown_turns, retrieved.memes),
      )
      memes = retrieved.memes.filter((m) => !cooledMemes.has(m.name))
      examples = retrieved.examples
      retrievalLatencyMs = retrieved.latencyMs
    }

    const compiled = compileStylePromptFromData({
      profile: cached.profile,
      memes,
      examples,
      mode,
      stableWeight: cached.stableWeight,
      recentWeight: cached.recentWeight,
      influenceStrength: cached.influenceStrength,
      budgets: {
        profile: opts.config.style_profile_max_tokens,
        meme: opts.config.style_meme_max_tokens,
        examples: opts.config.style_examples_max_tokens,
        total: opts.config.style_total_max_tokens,
      },
    })

    return {
      enabled: Boolean(compiled.promptBlock),
      profileId: cached.profile.profileId,
      profileVersion: cached.profile.version,
      promptBlock: compiled.promptBlock,
      voiceMoodHint: compiled.voiceMoodHint,
      estimatedTokens: compiled.estimatedTokens,
      retrievalLatencyMs,
      memesUsed: memes.map((m) => m.name),
      examplesUsed: examples.length,
    }
  } catch {
    return empty
  }
}

/**
 * 轻量表达重复检测（不额外调用 LLM）：
 * 检测回复是否原样复读了群友上一句或机器人上一条长回复（放行“确实”“典”等短通用词）。
 */
export function isRepetitiveReply(replyText: string, recentMessages: readonly ContextMessage[]): boolean {
  const norm = replyText.toLowerCase().replace(/[\s，。！？?!~～,.]/g, '')
  if (norm.length < 8) return false
  const recent = recentMessages.slice(-4)
  for (const m of recent) {
    const other = m.text.toLowerCase().replace(/[\s，。！？?!~～,.]/g, '')
    if (other.length >= 8 && other === norm) return true
  }
  return false
}
