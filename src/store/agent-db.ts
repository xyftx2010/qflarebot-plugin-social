import type { ScopedDB } from '@qqbot/sdk'
import type {
  AgentToolPolicy,
  LLMDailyUsage,
  PromptFragmentRecord,
  ToolDailyStat,
  ToolExecutionLog,
} from '../types.js'
import { formatDayKey } from './multimodal-db.js'

export const DEFAULT_ENABLED_BUILTINS: readonly string[] = [
  'social.get_time',
  'social.weather',
  'social.search_memory',
  'social.search_memes',
  'social.remember_fact',
  'social.roll',
  'social.web_search',
  'social.web_fetch',
]

const POLICY_ROW_ID = 'default'
const MAX_FRAGMENT_BYTES = 2000
const MAX_ACTIVE_FRAGMENTS = 8

interface ToolPolicyRow {
  id: string
  enabled_builtins_json: string
  enabled_external_json: string
  allow_external_writes: number
  updated_at: number
}

interface PromptFragmentRow {
  plugin: string
  fragment: string
  priority: number
  enabled: number
  updated_at: number
}

interface ToolStatRow {
  day: string
  tool_id: string
  calls: number
  successes: number
  total_latency_ms: number
  updated_at: number
}

function parseList(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return [...new Set(parsed.filter((x): x is string => typeof x === 'string' && x.trim().length > 0))]
  } catch {
    return []
  }
}

export async function getAgentToolPolicy(db: ScopedDB): Promise<AgentToolPolicy> {
  const row = await db.first<ToolPolicyRow>(
    'SELECT * FROM {tool_policy} WHERE id = ?',
    POLICY_ROW_ID,
  )
  if (!row) {
    return {
      enabledBuiltins: [...DEFAULT_ENABLED_BUILTINS],
      enabledExternalTools: [],
      allowExternalWrites: false,
      updatedAt: 0,
    }
  }
  return {
    enabledBuiltins: parseList(row.enabled_builtins_json),
    enabledExternalTools: parseList(row.enabled_external_json),
    allowExternalWrites: row.allow_external_writes === 1,
    updatedAt: row.updated_at,
  }
}

export async function saveAgentToolPolicy(
  db: ScopedDB,
  patch: Partial<Omit<AgentToolPolicy, 'updatedAt'>>,
  now = Date.now(),
): Promise<AgentToolPolicy> {
  const cur = await getAgentToolPolicy(db)
  const next: AgentToolPolicy = {
    enabledBuiltins: patch.enabledBuiltins ?? cur.enabledBuiltins,
    enabledExternalTools: patch.enabledExternalTools ?? cur.enabledExternalTools,
    allowExternalWrites: patch.allowExternalWrites ?? cur.allowExternalWrites,
    updatedAt: now,
  }
  await db.run(
    `INSERT INTO {tool_policy} (id, enabled_builtins_json, enabled_external_json, allow_external_writes, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       enabled_builtins_json = excluded.enabled_builtins_json,
       enabled_external_json = excluded.enabled_external_json,
       allow_external_writes = excluded.allow_external_writes,
       updated_at = excluded.updated_at`,
    POLICY_ROW_ID,
    JSON.stringify([...new Set(next.enabledBuiltins)]),
    JSON.stringify([...new Set(next.enabledExternalTools)]),
    next.allowExternalWrites ? 1 : 0,
    next.updatedAt,
  )
  return next
}

// ---------------------------------------------------------------------------
// 兼容 services.agent 的提示词片段存储（2000 字节上限 / 最多 8 条 / 稳定排序）
// ---------------------------------------------------------------------------

export async function upsertPromptFragment(
  db: ScopedDB,
  plugin: string,
  fragment: string,
  priority = 0,
  now = Date.now(),
): Promise<boolean> {
  const name = plugin.trim()
  const text = fragment.trim()
  if (!name || !text) return false
  const bytes = new TextEncoder().encode(text).length
  if (bytes > MAX_FRAGMENT_BYTES) {
    throw new Error(`提示词片段超过 ${MAX_FRAGMENT_BYTES} 字节上限（当前 ${bytes} 字节）`)
  }
  const existing = await db.first<PromptFragmentRow>(
    'SELECT * FROM {prompt_fragments} WHERE plugin = ?',
    name,
  )
  if (existing && existing.fragment === text && existing.priority === priority && existing.enabled === 1) {
    // 内容与优先级未变时不写库（遵循官方 AgentService 契约）
    return false
  }
  await db.run(
    `INSERT INTO {prompt_fragments} (plugin, fragment, priority, enabled, updated_at)
     VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(plugin) DO UPDATE SET
       fragment = excluded.fragment,
       priority = excluded.priority,
       enabled = 1,
       updated_at = excluded.updated_at`,
    name,
    text,
    Math.floor(priority),
    now,
  )
  return true
}

export async function setPromptFragmentEnabled(
  db: ScopedDB,
  plugin: string,
  enabled: boolean,
  now = Date.now(),
): Promise<boolean> {
  const res = await db.run(
    'UPDATE {prompt_fragments} SET enabled = ?, updated_at = ? WHERE plugin = ?',
    enabled ? 1 : 0,
    now,
    plugin.trim(),
  )
  return res.changes > 0
}

export async function deletePromptFragment(db: ScopedDB, plugin: string): Promise<boolean> {
  const res = await db.run('DELETE FROM {prompt_fragments} WHERE plugin = ?', plugin.trim())
  return res.changes > 0
}

export async function listPromptFragments(db: ScopedDB, activeOnly = false): Promise<PromptFragmentRecord[]> {
  const sql = activeOnly
    ? 'SELECT * FROM {prompt_fragments} WHERE enabled = 1 ORDER BY priority DESC, plugin ASC LIMIT ?'
    : 'SELECT * FROM {prompt_fragments} ORDER BY priority DESC, plugin ASC LIMIT ?'
  const rows = await db.all<PromptFragmentRow>(sql, activeOnly ? MAX_ACTIVE_FRAGMENTS : 50)
  return rows.map((r) => ({
    plugin: r.plugin,
    fragment: r.fragment,
    priority: r.priority,
    enabled: r.enabled === 1,
    updatedAt: r.updated_at,
  }))
}

// ---------------------------------------------------------------------------
// 工具调用每日统计
// ---------------------------------------------------------------------------

export async function recordToolStat(
  db: ScopedDB,
  toolId: string,
  success: boolean,
  latencyMs: number,
  now = Date.now(),
): Promise<void> {
  const day = formatDayKey(now)
  await db.run(
    `INSERT INTO {tool_stats} (day, tool_id, calls, successes, total_latency_ms, updated_at)
     VALUES (?, ?, 1, ?, ?, ?)
     ON CONFLICT(day, tool_id) DO UPDATE SET
       calls = calls + 1,
       successes = successes + excluded.successes,
       total_latency_ms = total_latency_ms + excluded.total_latency_ms,
       updated_at = excluded.updated_at`,
    day,
    toolId,
    success ? 1 : 0,
    Math.max(0, Math.round(latencyMs)),
    now,
  )
}

export async function listToolStats(db: ScopedDB, days = 7): Promise<ToolDailyStat[]> {
  const since = formatDayKey(Date.now() - Math.max(1, days - 1) * 24 * 3600 * 1000)
  const rows = await db.all<ToolStatRow>(
    'SELECT * FROM {tool_stats} WHERE day >= ? ORDER BY day DESC, calls DESC LIMIT 100',
    since,
  )
  return rows.map((r) => ({
    day: r.day,
    toolId: r.tool_id,
    calls: r.calls,
    successes: r.successes,
    totalLatencyMs: r.total_latency_ms,
    updatedAt: r.updated_at,
  }))
}

export async function insertToolExecutionLog(
  db: ScopedDB,
  entry: Omit<ToolExecutionLog, 'id'>,
): Promise<void> {
  const id = `tlog_${entry.createdAt.toString(36)}_${Math.random().toString(36).slice(2, 7)}`
  await db.run(
    `INSERT INTO {tool_logs} (id, group_id, tool_id, source, status, latency_ms, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    entry.groupId,
    entry.toolId,
    entry.source,
    entry.status,
    Math.max(0, Math.round(entry.latencyMs)),
    entry.error.slice(0, 200),
    entry.createdAt,
  )
}

export async function listRecentToolLogs(db: ScopedDB, limit = 40): Promise<ToolExecutionLog[]> {
  const rows = await db.all<{
    id: string
    group_id: string
    tool_id: string
    source: string
    status: string
    latency_ms: number
    error: string
    created_at: number
  }>('SELECT * FROM {tool_logs} ORDER BY created_at DESC LIMIT ?', Math.min(100, Math.max(1, limit)))
  return rows.map((r) => ({
    id: r.id,
    groupId: r.group_id,
    toolId: r.tool_id,
    source: r.source === 'external' ? 'external' : 'builtin',
    status:
      r.status === 'success'
        ? 'success'
        : r.status === 'timeout'
          ? 'timeout'
          : r.status === 'denied'
            ? 'denied'
            : 'failed',
    latencyMs: r.latency_ms,
    error: r.error,
    createdAt: r.created_at,
  }))
}

export async function pruneOldToolLogs(db: ScopedDB, retentionDays = 7, now = Date.now()): Promise<number> {
  const cutoff = now - Math.max(1, retentionDays) * 24 * 3600 * 1000
  const res = await db.run('DELETE FROM {tool_logs} WHERE created_at < ?', cutoff)
  return res.changes
}

export async function recordLLMUsage(
  db: ScopedDB,
  delta: { runs?: number; toolCalls?: number; inputTokens?: number; outputTokens?: number },
  now = Date.now(),
): Promise<void> {
  const runs = delta.runs ?? 0
  const tc = delta.toolCalls ?? 0
  const inp = delta.inputTokens ?? 0
  const out = delta.outputTokens ?? 0
  if (runs === 0 && tc === 0 && inp === 0 && out === 0) return
  const day = formatDayKey(now)
  await db.run(
    `INSERT INTO {llm_usage_stats} (day, runs, tool_calls, input_tokens, output_tokens, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(day) DO UPDATE SET
       runs = runs + excluded.runs,
       tool_calls = tool_calls + excluded.tool_calls,
       input_tokens = input_tokens + excluded.input_tokens,
       output_tokens = output_tokens + excluded.output_tokens,
       updated_at = excluded.updated_at`,
    day,
    runs,
    tc,
    inp,
    out,
    now,
  )
}

export async function listLLMUsageStats(db: ScopedDB, days = 7): Promise<LLMDailyUsage[]> {
  const rows = await db.all<{
    day: string
    runs: number
    tool_calls: number
    input_tokens: number
    output_tokens: number
    updated_at: number
  }>('SELECT * FROM {llm_usage_stats} ORDER BY day DESC LIMIT ?', Math.min(30, Math.max(1, days)))
  return rows.map((r) => ({
    day: r.day,
    runs: r.runs,
    toolCalls: r.tool_calls,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    updatedAt: r.updated_at,
  }))
}
