import type { AgentChannel, LLMToolDefinition, SocialConfig } from '../types.js'
import { BUILTIN_TOOLS, type BuiltinToolMeta } from './builtin-tools.js'
import type { BoundExternalTool } from './external-tools.js'
import type { IntentAnalysis } from './intent-router.js'

export interface CandidateToolCatalogEntry {
  id: string
  wireName: string
  source: 'builtin' | 'external'
  description: string
  intentTags: string[]
  keywords: string[]
  parameters: Record<string, unknown>
  permission: string
  cost: 'low' | 'medium'
  available: boolean
}

const BUILTIN_TAGS: Readonly<Record<string, { intentTags: string[]; keywords: string[]; cost: 'low' | 'medium' }>> = {
  'social.get_time': { intentTags: ['time'], keywords: ['时间', '几点', '星期', '周几', '日期'], cost: 'low' },
  'social.weather': { intentTags: ['weather'], keywords: ['天气', '气温', '下雨', '温度', '冷', '热'], cost: 'low' },
  'social.search_memory': { intentTags: ['memory_search'], keywords: ['记得', '记忆', '群梗', '之前', '上次'], cost: 'low' },
  'social.search_memes': { intentTags: ['memes'], keywords: ['表情包', '斗图', '表情'], cost: 'low' },
  'social.remember_fact': { intentTags: ['memory_save'], keywords: ['记住', '记一下', '约定'], cost: 'low' },
  'social.roll': { intentTags: ['roll'], keywords: ['骰子', '抽签', '随机', '吃啥', '选一个'], cost: 'low' },
  'social.web_search': { intentTags: ['web_search'], keywords: ['搜索', '查', '新闻', '攻略', '百科', '梗'], cost: 'medium' },
  'social.web_fetch': { intentTags: ['web_fetch'], keywords: ['网页', '链接', 'http', 'https'], cost: 'medium' },
}

export function buildAvailableToolCatalog(
  config: SocialConfig,
  enabledBuiltins: readonly string[],
  externalTools: readonly BoundExternalTool[],
): CandidateToolCatalogEntry[] {
  const allowedBuiltins = new Set(enabledBuiltins)
  const entries: CandidateToolCatalogEntry[] = []

  for (const t of BUILTIN_TOOLS) {
    if (!allowedBuiltins.has(t.id)) continue
    const available = !t.requiresApiKey || Boolean(config.web_search_api_key.trim())
    if (!available) continue
    const meta = BUILTIN_TAGS[t.id] ?? { intentTags: [], keywords: [], cost: 'low' as const }
    entries.push({
      id: t.id,
      wireName: t.wireName,
      source: 'builtin',
      description: t.description,
      intentTags: meta.intentTags,
      keywords: meta.keywords,
      parameters: t.parameters,
      permission: 'member',
      cost: meta.cost,
      available: true,
    })
  }

  for (const ext of externalTools) {
    const rawDesc = `${ext.descriptor.id} ${ext.descriptor.name} ${ext.descriptor.description}`.toLowerCase()
    const ascii = rawDesc.match(/[a-z0-9]{2,}/g) ?? []
    const cjkSegs = rawDesc.match(/[\u4e00-\u9fa5]{2,}/g) ?? []
    const bigrams: string[] = []
    for (const seg of cjkSegs) {
      for (let i = 0; i <= seg.length - 2; i += 1) {
        bigrams.push(seg.slice(i, i + 2))
      }
    }
    entries.push({
      id: ext.descriptor.id,
      wireName: ext.wireName,
      source: 'external',
      description: ext.descriptor.description,
      intentTags: [`ext:${ext.descriptor.id}`],
      keywords: [...new Set([...ascii, ...bigrams])].slice(0, 24),
      parameters: ext.descriptor.inputSchema,
      permission: ext.descriptor.permission,
      cost: 'medium',
      available: true,
    })
  }

  return entries
}

/**
 * 动态工具筛选器：
 * - Fast Chat：返回空数组（零工具 Schema）；
 * - Smart Tool Chat：按意图与文本相关性精选 Top-K（默认 ≤ 3）；
 * - Full Agent：返回当前会话全部已授权可用工具。
 */
export function selectDynamicTools(opts: {
  channel: AgentChannel
  catalog: readonly CandidateToolCatalogEntry[]
  intent: IntentAnalysis
  text: string
  topK: number
  requestedToolIds?: readonly string[]
}): {
  selected: CandidateToolCatalogEntry[]
  definitions: LLMToolDefinition[]
} {
  const { channel, catalog, intent, text, requestedToolIds } = opts
  if (channel === 'fast' || catalog.length === 0) {
    return { selected: [], definitions: [] }
  }

  if (channel === 'full') {
    const all = [...catalog]
    return {
      selected: all,
      definitions: all.map((c) => ({
        name: c.wireName,
        description: c.description,
        parameters: c.parameters,
      })),
    }
  }

  const limit = Math.min(5, Math.max(1, Math.floor(opts.topK || 3)))
  const lower = text.toLowerCase()
  const intentSet = new Set(intent.candidateToolIds)
  const requestedSet = new Set((requestedToolIds ?? []).map((x) => x.toLowerCase()))

  const scored = catalog.map((item) => {
    let score = 0
    if (requestedSet.has(item.id.toLowerCase()) || requestedSet.has(item.wireName.toLowerCase())) {
      score += 100
    }
    if (intentSet.has(item.id)) {
      score += 60
    }
    for (const kw of item.keywords) {
      if (lower.includes(kw)) score += 15
    }
    if (item.cost === 'low') score += 2
    return { item, score }
  })

  scored.sort((a, b) => b.score - a.score)
  const positive = scored.filter((x) => x.score > 2)
  const picked = (positive.length > 0 ? positive : scored).slice(0, limit).map((x) => x.item)

  return {
    selected: picked,
    definitions: picked.map((c) => ({
      name: c.wireName,
      description: c.description,
      parameters: c.parameters,
    })),
  }
}

export type { BuiltinToolMeta }
