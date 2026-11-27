import type { PluginDB } from '@qqbot/sdk'
import type { DialogueExampleRecord, GroupMemeRecord } from './types.js'
import { extractSearchTokens } from './cleaner.js'
import { listDialogueExamples, listGroupMemes } from '../store/learning-db.js'

/**
 * 可选向量检索接口（Phase 6 预留）：
 * 当前 QFlareBot SDK v5 未提供 Vectorize 绑定，默认使用 D1 轻量混合检索；
 * 不可用时自动降级，绝不跨群检索。
 */
export interface VectorRetriever {
  searchExamples(groupId: string, queryText: string, topK: number): Promise<string[]>
}

export interface RetrievalResult {
  memes: GroupMemeRecord[]
  examples: DialogueExampleRecord[]
  engine: 'd1' | 'vector_hybrid'
  latencyMs: number
}

function overlapRatio(queryTokens: readonly string[], targetText: string): number {
  if (queryTokens.length === 0 || !targetText) return 0
  const lower = targetText.toLowerCase()
  let hits = 0
  for (const tok of queryTokens) {
    if (lower.includes(tok)) hits += 1
  }
  return hits / queryTokens.length
}

/**
 * 按需轻量检索（D1 优先）：
 * - 严格按 `group_id` 隔离，二次校验 `groupId` 与活跃状态；
 * - 结合 CJK 2-gram 词元、对话行为、情绪、时间衰减与质量分排序；
 * - 相关性不足时不强行返回示例，默认返回 0 ~ topK 条，避免塞入无关噪音。
 */
export async function retrieveGroupStyleContext(opts: {
  db: PluginDB
  groupId: string
  queryText: string
  recentContextText?: string
  topK: number
  excludeMemeNames?: readonly string[]
  vectorRetriever?: VectorRetriever | null
  vectorEnabled?: boolean
  now?: number
}): Promise<RetrievalResult> {
  const started = Date.now()
  const now = opts.now ?? Date.now()
  const combinedQuery = `${opts.queryText} ${opts.recentContextText ?? ''}`.trim()
  const queryTokens = extractSearchTokens(combinedQuery, 24)
  const excludeSet = new Set((opts.excludeMemeNames ?? []).map((x) => x.toLowerCase()))

  const [activeMemes, activeExamples] = await Promise.all([
    listGroupMemes(opts.db, opts.groupId, { status: 'active', limit: 30 }),
    opts.topK > 0
      ? listDialogueExamples(opts.db, opts.groupId, { activeOnly: true, limit: 60, now })
      : Promise.resolve([]),
  ])

  // 二次校验群隔离，过滤冷却中的热梗
  const scoredMemes = activeMemes
    .filter((m) => m.groupId === opts.groupId && m.status === 'active' && !excludeSet.has(m.name.toLowerCase()))
    .map((m) => {
      const hay = `${m.name} ${m.aliases.join(' ')} ${m.meaning} ${m.applicableContext}`
      const rel = overlapRatio(queryTokens, hay)
      const directHit = combinedQuery.includes(m.name) ? 0.5 : 0
      const ageDays = Math.max(0, (now - m.lastSeenAt) / 86_400_000)
      const timeDecay = Math.exp(-ageDays / 45)
      const score = directHit + rel * 0.45 + m.popularityWeight * 0.2 * timeDecay
      return { meme: m, score }
    })
    .filter((x) => x.score >= 0.18)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map((x) => x.meme)

  // 可选 Phase 6 向量检索（失败自动降级 D1）
  let vectorBoostIds = new Set<string>()
  let engine: 'd1' | 'vector_hybrid' = 'd1'
  if (opts.vectorEnabled && opts.vectorRetriever && opts.topK > 0) {
    try {
      const ids = await opts.vectorRetriever.searchExamples(opts.groupId, combinedQuery, opts.topK * 2)
      vectorBoostIds = new Set(ids)
      engine = 'vector_hybrid'
    } catch {
      engine = 'd1'
    }
  }

  // 对话示例排序 + 多样性控制（同一种 behavior 最多取 2 条，避免重复模式）
  const scoredExamples = activeExamples
    .filter((e) => e.groupId === opts.groupId && e.status === 'active')
    .map((e) => {
      const hay = `${e.searchTokens} ${e.topicTags.join(' ')} ${e.targetResponse}`
      const rel = overlapRatio(queryTokens, hay)
      const ageDays = Math.max(0, (now - e.createdAt) / 86_400_000)
      const timeDecay = Math.exp(-ageDays / 35)
      const vecBoost = vectorBoostIds.has(e.exampleId) ? 0.35 : 0
      const score = rel * 0.55 + e.qualityScore * 0.25 + e.confidence * 0.15 * timeDecay + vecBoost
      return { example: e, score }
    })
    .filter((x) => x.score >= 0.28)
    .sort((a, b) => b.score - a.score)

  const pickedExamples: DialogueExampleRecord[] = []
  const behaviorCount = new Map<string, number>()
  const seenReply = new Set<string>()
  const maxExamples = Math.min(5, Math.max(0, opts.topK))

  for (const item of scoredExamples) {
    if (pickedExamples.length >= maxExamples) break
    const bCnt = behaviorCount.get(item.example.dialogueBehavior) ?? 0
    if (bCnt >= 2) continue
    const norm = item.example.targetResponse.toLowerCase().replace(/\s+/g, '')
    if (seenReply.has(norm)) continue
    seenReply.add(norm)
    behaviorCount.set(item.example.dialogueBehavior, bCnt + 1)
    pickedExamples.push(item.example)
  }

  return {
    memes: scoredMemes,
    examples: pickedExamples,
    engine,
    latencyMs: Date.now() - started,
  }
}
