import type { ScopedDB, ScopedR2 } from '@qqbot/sdk'
import type {
  GroupVoiceSettings,
  TTSProviderType,
  VoiceAudioFormat,
  VoiceCacheEntry,
  VoiceLogRecord,
  VoiceTriggerMode,
} from '../types.js'

interface GroupVoiceSettingsRow {
  group_id: string
  enabled: number | null
  trigger_mode: string | null
  probability: number | null
  voice_id: string | null
  speed: number | null
  emotion: string | null
  daily_limit: number | null
  updated_at: number
}

interface VoiceCacheRow {
  cache_key: string
  provider: string
  format: string
  content_type: string
  size_bytes: number
  r2_key: string
  created_at: number
  expires_at: number
}

interface VoiceLogRow {
  id: string
  group_id: string
  provider: string
  model: string
  voice_id: string
  emotion: string
  char_count: number
  estimated_cost: number
  format: string
  cached: number
  status: string
  error: string
  created_at: number
}

function parseTriggerMode(val: string | null): VoiceTriggerMode | null {
  if (val === 'manual' || val === 'probability' || val === 'ai' || val === 'always') return val
  return null
}

function parseProvider(val: string): TTSProviderType {
  if (val === 'qwen' || val === 'openai') return val
  return 'minimax'
}

function parseFormat(val: string): VoiceAudioFormat {
  return val === 'mp3' ? 'mp3' : 'wav'
}

function mapGroupVoiceRow(row: GroupVoiceSettingsRow): GroupVoiceSettings {
  return {
    groupId: row.group_id,
    enabled: row.enabled === null ? null : row.enabled === 1,
    triggerMode: parseTriggerMode(row.trigger_mode),
    probability: row.probability,
    voiceId: row.voice_id,
    speed: row.speed,
    emotion: row.emotion,
    dailyLimit: row.daily_limit,
    updatedAt: row.updated_at,
  }
}

export async function getGroupVoiceSettings(db: ScopedDB, groupId: string): Promise<GroupVoiceSettings | null> {
  const row = await db.first<GroupVoiceSettingsRow>(
    'SELECT * FROM {group_voice_settings} WHERE group_id = ?',
    groupId,
  )
  return row ? mapGroupVoiceRow(row) : null
}

export async function listGroupVoiceSettings(db: ScopedDB, limit = 100): Promise<GroupVoiceSettings[]> {
  const rows = await db.all<GroupVoiceSettingsRow>(
    'SELECT * FROM {group_voice_settings} ORDER BY updated_at DESC LIMIT ?',
    limit,
  )
  return rows.map(mapGroupVoiceRow)
}

export async function upsertGroupVoiceSettings(
  db: ScopedDB,
  groupId: string,
  patch: Partial<Omit<GroupVoiceSettings, 'groupId' | 'updatedAt'>>,
  now = Date.now(),
): Promise<GroupVoiceSettings> {
  const existing = await getGroupVoiceSettings(db, groupId)
  const next: GroupVoiceSettings = {
    groupId,
    enabled: patch.enabled !== undefined ? patch.enabled : (existing?.enabled ?? null),
    triggerMode: patch.triggerMode !== undefined ? patch.triggerMode : (existing?.triggerMode ?? null),
    probability: patch.probability !== undefined ? patch.probability : (existing?.probability ?? null),
    voiceId: patch.voiceId !== undefined ? patch.voiceId : (existing?.voiceId ?? null),
    speed: patch.speed !== undefined ? patch.speed : (existing?.speed ?? null),
    emotion: patch.emotion !== undefined ? patch.emotion : (existing?.emotion ?? null),
    dailyLimit: patch.dailyLimit !== undefined ? patch.dailyLimit : (existing?.dailyLimit ?? null),
    updatedAt: now,
  }
  await db.run(
    `INSERT INTO {group_voice_settings} (
       group_id, enabled, trigger_mode, probability, voice_id, speed, emotion, daily_limit, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(group_id) DO UPDATE SET
       enabled = excluded.enabled,
       trigger_mode = excluded.trigger_mode,
       probability = excluded.probability,
       voice_id = excluded.voice_id,
       speed = excluded.speed,
       emotion = excluded.emotion,
       daily_limit = excluded.daily_limit,
       updated_at = excluded.updated_at`,
    next.groupId,
    next.enabled === null ? null : next.enabled ? 1 : 0,
    next.triggerMode,
    next.probability,
    next.voiceId,
    next.speed,
    next.emotion,
    next.dailyLimit,
    next.updatedAt,
  )
  return next
}

// ---------------------------------------------------------------------------
// 临时语音与去重缓存（短期有效 + 自动清理）
// ---------------------------------------------------------------------------

export async function getVoiceCacheEntry(
  db: ScopedDB,
  cacheKey: string,
  now = Date.now(),
): Promise<VoiceCacheEntry | null> {
  const row = await db.first<VoiceCacheRow>(
    'SELECT * FROM {voice_cache} WHERE cache_key = ? AND expires_at > ?',
    cacheKey,
    now,
  )
  if (!row) return null
  return {
    cacheKey: row.cache_key,
    provider: parseProvider(row.provider),
    format: parseFormat(row.format),
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    r2Key: row.r2_key,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  }
}

export async function saveVoiceCacheEntry(db: ScopedDB, entry: VoiceCacheEntry): Promise<void> {
  await db.run(
    `INSERT INTO {voice_cache} (
       cache_key, provider, format, content_type, size_bytes, r2_key, created_at, expires_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET
       provider = excluded.provider,
       format = excluded.format,
       content_type = excluded.content_type,
       size_bytes = excluded.size_bytes,
       r2_key = excluded.r2_key,
       created_at = excluded.created_at,
       expires_at = excluded.expires_at`,
    entry.cacheKey,
    entry.provider,
    entry.format,
    entry.contentType,
    entry.sizeBytes,
    entry.r2Key,
    entry.createdAt,
    entry.expiresAt,
  )
}

export async function pruneExpiredVoiceCache(
  db: ScopedDB,
  r2: ScopedR2 | undefined,
  now = Date.now(),
  limit = 40,
): Promise<number> {
  const expired = await db.all<VoiceCacheRow>(
    'SELECT * FROM {voice_cache} WHERE expires_at <= ? LIMIT ?',
    now,
    limit,
  )
  let removed = 0
  for (const row of expired) {
    const res = await db.run('DELETE FROM {voice_cache} WHERE cache_key = ?', row.cache_key)
    if (res.changes > 0) {
      removed += 1
      if (r2) {
        await r2.delete(row.r2_key).catch(() => undefined)
      }
    }
  }
  return removed
}

// ---------------------------------------------------------------------------
// 语音发送日志、每日配额统计与费用汇总
// ---------------------------------------------------------------------------

export async function insertVoiceLog(db: ScopedDB, log: VoiceLogRecord): Promise<void> {
  await db.run(
    `INSERT INTO {voice_logs} (
       id, group_id, provider, model, voice_id, emotion, char_count,
       estimated_cost, format, cached, status, error, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    log.id,
    log.groupId,
    log.provider,
    log.model,
    log.voiceId,
    log.emotion,
    log.charCount,
    log.estimatedCost,
    log.format,
    log.cached ? 1 : 0,
    log.status,
    log.error,
    log.createdAt,
  )
}

export async function countGroupVoiceSentToday(db: ScopedDB, groupId: string, now = Date.now()): Promise<number> {
  const startOfDay = new Date(now)
  startOfDay.setUTCHours(0, 0, 0, 0)
  const row = await db.first<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt FROM {voice_logs}
     WHERE group_id = ? AND status = 'sent' AND created_at >= ?`,
    groupId,
    startOfDay.getTime(),
  )
  return Number(row?.cnt ?? 0)
}

export async function listRecentVoiceLogs(db: ScopedDB, limit = 50): Promise<VoiceLogRecord[]> {
  const rows = await db.all<VoiceLogRow>(
    'SELECT * FROM {voice_logs} ORDER BY created_at DESC LIMIT ?',
    Math.min(100, Math.max(1, limit)),
  )
  return rows.map((r) => ({
    id: r.id,
    groupId: r.group_id,
    provider: parseProvider(r.provider),
    model: r.model,
    voiceId: r.voice_id,
    emotion: r.emotion,
    charCount: r.char_count,
    estimatedCost: r.estimated_cost,
    format: parseFormat(r.format),
    cached: r.cached === 1,
    status: r.status === 'sent' ? 'sent' : r.status === 'fallback_text' ? 'fallback_text' : 'failed',
    error: r.error,
    createdAt: r.created_at,
  }))
}

export async function summarizeVoiceUsage(
  db: ScopedDB,
  sinceMs: number,
): Promise<{
  totalSent: number
  totalFallback: number
  totalFailed: number
  totalCached: number
  totalChars: number
  totalEstimatedCost: number
}> {
  const rows = await db.all<{
    status: string
    cached: number
    char_count: number
    estimated_cost: number
  }>('SELECT status, cached, char_count, estimated_cost FROM {voice_logs} WHERE created_at >= ?', sinceMs)

  let totalSent = 0
  let totalFallback = 0
  let totalFailed = 0
  let totalCached = 0
  let totalChars = 0
  let totalEstimatedCost = 0

  for (const r of rows) {
    if (r.status === 'sent') totalSent += 1
    else if (r.status === 'fallback_text') totalFallback += 1
    else totalFailed += 1
    if (r.cached === 1) totalCached += 1
    totalChars += Number(r.char_count ?? 0)
    totalEstimatedCost += Number(r.estimated_cost ?? 0)
  }

  return {
    totalSent,
    totalFallback,
    totalFailed,
    totalCached,
    totalChars,
    totalEstimatedCost: Number(totalEstimatedCost.toFixed(4)),
  }
}

export async function pruneOldVoiceLogs(db: ScopedDB, retentionDays = 14, now = Date.now()): Promise<number> {
  const cutoff = now - Math.max(1, retentionDays) * 24 * 3600 * 1000
  const res = await db.run('DELETE FROM {voice_logs} WHERE created_at < ?', cutoff)
  return res.changes
}
