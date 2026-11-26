import type { ScopedDB } from '@qqbot/sdk'
import type {
  GroupMultimodalState,
  ImageAnalysisResult,
  MemeRecord,
  MemeScope,
  MultimodalDailyStats,
  RecentMemeUse,
} from '../types.js'

interface ImageCacheRow {
  hash: string
  summary: string
  ocr_text: string
  meme_meaning: string
  mood: string
  tags_json: string
  scene_hints: string
  created_at: number
  expires_at: number
}

interface MemeRow {
  id: string
  hash: string
  scope: string
  group_id: string | null
  r2_key: string
  content_type: string
  size_bytes: number
  meaning: string
  mood: string
  tags_json: string
  scene_hints: string
  category: string
  enabled: number
  created_by: string | null
  use_count: number
  last_used_at: number
  created_at: number
  expires_at: number
}

interface GroupMultimodalStateRow {
  group_id: string
  vision_window_start: number
  vision_window_count: number
  last_meme_sent_at: number
  consecutive_meme_count: number
  recent_meme_ids_json: string
  updated_at: number
}

interface MultimodalStatsRow {
  day: string
  vision_calls: number
  vision_cache_hits: number
  vision_errors: number
  meme_sent: number
  meme_collected: number
  updated_at: number
}

function parseStringArray(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
  } catch {
    return []
  }
}

function parseRecentMemes(raw: string): RecentMemeUse[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (item): item is RecentMemeUse =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as RecentMemeUse).id === 'string' &&
        typeof (item as RecentMemeUse).usedAt === 'number',
    )
  } catch {
    return []
  }
}

function mapMemeRow(row: MemeRow): MemeRecord {
  return {
    id: row.id,
    hash: row.hash,
    scope: row.scope === 'global' ? 'global' : 'group',
    groupId: row.group_id,
    r2Key: row.r2_key,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    meaning: row.meaning,
    mood: row.mood,
    tags: parseStringArray(row.tags_json),
    sceneHints: row.scene_hints,
    category: row.category,
    enabled: row.enabled === 1,
    createdBy: row.created_by,
    useCount: row.use_count,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  }
}

export function createEmptyMultimodalState(groupId: string, now = Date.now()): GroupMultimodalState {
  return {
    groupId,
    visionWindowStart: 0,
    visionWindowCount: 0,
    lastMemeSentAt: 0,
    consecutiveMemeCount: 0,
    recentMemes: [],
    updatedAt: now,
  }
}

export function formatDayKey(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// 图片理解缓存（按 SHA-256 复用）
// ---------------------------------------------------------------------------

export async function getCachedImageAnalysis(
  db: ScopedDB,
  hash: string,
  now = Date.now(),
): Promise<ImageAnalysisResult | null> {
  const row = await db.first<ImageCacheRow>(
    `SELECT hash, summary, ocr_text, meme_meaning, mood, tags_json, scene_hints, created_at, expires_at
     FROM {image_cache} WHERE hash = ? AND expires_at > ?`,
    hash,
    now,
  )
  if (!row) return null
  return {
    hash: row.hash,
    summary: row.summary,
    ocrText: row.ocr_text,
    memeMeaning: row.meme_meaning,
    mood: row.mood,
    tags: parseStringArray(row.tags_json),
    sceneHints: row.scene_hints,
    fromCache: true,
  }
}

export async function saveCachedImageAnalysis(
  db: ScopedDB,
  analysis: Omit<ImageAnalysisResult, 'fromCache'>,
  ttlHours: number,
  now = Date.now(),
): Promise<void> {
  const expiresAt = now + Math.max(1, ttlHours) * 3600 * 1000
  await db.run(
    `INSERT INTO {image_cache} (hash, summary, ocr_text, meme_meaning, mood, tags_json, scene_hints, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(hash) DO UPDATE SET
       summary = excluded.summary,
       ocr_text = excluded.ocr_text,
       meme_meaning = excluded.meme_meaning,
       mood = excluded.mood,
       tags_json = excluded.tags_json,
       scene_hints = excluded.scene_hints,
       created_at = excluded.created_at,
       expires_at = excluded.expires_at`,
    analysis.hash,
    analysis.summary,
    analysis.ocrText,
    analysis.memeMeaning,
    analysis.mood,
    JSON.stringify(analysis.tags),
    analysis.sceneHints,
    now,
    expiresAt,
  )
}

export async function pruneExpiredImageCache(db: ScopedDB, now = Date.now()): Promise<number> {
  const res = await db.run('DELETE FROM {image_cache} WHERE expires_at <= ?', now)
  return res.changes
}

// ---------------------------------------------------------------------------
// 表情包元数据 CRUD（群级隔离 + 全局素材库）
// ---------------------------------------------------------------------------

export async function findMemeByHash(
  db: ScopedDB,
  hash: string,
  scope: MemeScope,
  groupId: string | null,
): Promise<MemeRecord | null> {
  const row =
    scope === 'global'
      ? await db.first<MemeRow>(
          `SELECT * FROM {memes} WHERE hash = ? AND scope = 'global' LIMIT 1`,
          hash,
        )
      : await db.first<MemeRow>(
          `SELECT * FROM {memes} WHERE hash = ? AND scope = 'group' AND group_id = ? LIMIT 1`,
          hash,
          groupId,
        )
  return row ? mapMemeRow(row) : null
}

export async function getMemeById(db: ScopedDB, id: string): Promise<MemeRecord | null> {
  const row = await db.first<MemeRow>('SELECT * FROM {memes} WHERE id = ?', id)
  return row ? mapMemeRow(row) : null
}

export async function insertMemeRecord(db: ScopedDB, meme: MemeRecord): Promise<void> {
  await db.run(
    `INSERT INTO {memes} (
       id, hash, scope, group_id, r2_key, content_type, size_bytes,
       meaning, mood, tags_json, scene_hints, category, enabled,
       created_by, use_count, last_used_at, created_at, expires_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    meme.id,
    meme.hash,
    meme.scope,
    meme.groupId,
    meme.r2Key,
    meme.contentType,
    meme.sizeBytes,
    meme.meaning,
    meme.mood,
    JSON.stringify(meme.tags),
    meme.sceneHints,
    meme.category,
    meme.enabled ? 1 : 0,
    meme.createdBy,
    meme.useCount,
    meme.lastUsedAt,
    meme.createdAt,
    meme.expiresAt,
  )
}

/** 查询当前群可用于回复的活跃表情包（严格群级隔离：只返回本群 + 可选全局） */
export async function listAvailableMemesForGroup(
  db: ScopedDB,
  groupId: string,
  includeGlobal: boolean,
  now = Date.now(),
  limit = 80,
): Promise<MemeRecord[]> {
  const rows = includeGlobal
    ? await db.all<MemeRow>(
        `SELECT * FROM {memes}
         WHERE enabled = 1 AND expires_at > ?
           AND ((scope = 'group' AND group_id = ?) OR scope = 'global')
         ORDER BY use_count DESC, created_at DESC
         LIMIT ?`,
        now,
        groupId,
        limit,
      )
    : await db.all<MemeRow>(
        `SELECT * FROM {memes}
         WHERE enabled = 1 AND expires_at > ?
           AND scope = 'group' AND group_id = ?
         ORDER BY use_count DESC, created_at DESC
         LIMIT ?`,
        now,
        groupId,
        limit,
      )
  return rows.map(mapMemeRow)
}

/** 管理页与命令查询表情包列表（支持按范围、群、禁用状态筛选） */
export async function listMemesAdmin(
  db: ScopedDB,
  filter: { scope?: 'all' | 'global' | 'group'; groupId?: string; includeDisabled?: boolean; limit?: number } = {},
  now = Date.now(),
): Promise<MemeRecord[]> {
  const limit = Math.min(200, Math.max(1, filter.limit ?? 100))
  const clauses: string[] = ['expires_at > ?']
  const params: unknown[] = [now]

  if (!filter.includeDisabled) {
    clauses.push('enabled = 1')
  }
  if (filter.scope === 'global') {
    clauses.push("scope = 'global'")
  } else if (filter.scope === 'group') {
    clauses.push("scope = 'group'")
    if (filter.groupId) {
      clauses.push('group_id = ?')
      params.push(filter.groupId)
    }
  } else if (filter.groupId) {
    clauses.push("((scope = 'group' AND group_id = ?) OR scope = 'global')")
    params.push(filter.groupId)
  }

  params.push(limit)
  const rows = await db.all<MemeRow>(
    `SELECT * FROM {memes} WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT ?`,
    ...params,
  )
  return rows.map(mapMemeRow)
}

export async function updateMemeRecord(
  db: ScopedDB,
  id: string,
  patch: { enabled?: boolean; category?: string; meaning?: string; mood?: string; tags?: string[]; sceneHints?: string },
): Promise<boolean> {
  const existing = await getMemeById(db, id)
  if (!existing) return false
  await db.run(
    `UPDATE {memes}
     SET enabled = ?, category = ?, meaning = ?, mood = ?, tags_json = ?, scene_hints = ?
     WHERE id = ?`,
    patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : (existing.enabled ? 1 : 0),
    patch.category ?? existing.category,
    patch.meaning ?? existing.meaning,
    patch.mood ?? existing.mood,
    JSON.stringify(patch.tags ?? existing.tags),
    patch.sceneHints ?? existing.sceneHints,
    id,
  )
  return true
}

export async function markMemeUsed(db: ScopedDB, id: string, now = Date.now()): Promise<void> {
  await db.run(
    'UPDATE {memes} SET use_count = use_count + 1, last_used_at = ? WHERE id = ?',
    now,
    id,
  )
}

export async function deleteMemeRow(db: ScopedDB, id: string): Promise<number> {
  const res = await db.run('DELETE FROM {memes} WHERE id = ?', id)
  return res.changes
}

export async function countR2KeyReferences(db: ScopedDB, r2Key: string): Promise<number> {
  const row = await db.first<{ cnt: number }>(
    'SELECT COUNT(*) AS cnt FROM {memes} WHERE r2_key = ?',
    r2Key,
  )
  return Number(row?.cnt ?? 0)
}

export async function listExpiredMemes(db: ScopedDB, now = Date.now(), limit = 50): Promise<MemeRecord[]> {
  const rows = await db.all<MemeRow>(
    'SELECT * FROM {memes} WHERE expires_at <= ? LIMIT ?',
    now,
    limit,
  )
  return rows.map(mapMemeRow)
}

// ---------------------------------------------------------------------------
// 群级多模态状态（Vision 频控 + 表情包防重复/防斗图循环）
// ---------------------------------------------------------------------------

export async function getGroupMultimodalState(
  db: ScopedDB,
  groupId: string,
): Promise<GroupMultimodalState | null> {
  const row = await db.first<GroupMultimodalStateRow>(
    'SELECT * FROM {group_multimodal_state} WHERE group_id = ?',
    groupId,
  )
  if (!row) return null
  return {
    groupId: row.group_id,
    visionWindowStart: row.vision_window_start,
    visionWindowCount: row.vision_window_count,
    lastMemeSentAt: row.last_meme_sent_at,
    consecutiveMemeCount: row.consecutive_meme_count,
    recentMemes: parseRecentMemes(row.recent_meme_ids_json),
    updatedAt: row.updated_at,
  }
}

export async function saveGroupMultimodalState(db: ScopedDB, state: GroupMultimodalState): Promise<void> {
  await db.run(
    `INSERT INTO {group_multimodal_state} (
       group_id, vision_window_start, vision_window_count, last_meme_sent_at,
       consecutive_meme_count, recent_meme_ids_json, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(group_id) DO UPDATE SET
       vision_window_start = excluded.vision_window_start,
       vision_window_count = excluded.vision_window_count,
       last_meme_sent_at = excluded.last_meme_sent_at,
       consecutive_meme_count = excluded.consecutive_meme_count,
       recent_meme_ids_json = excluded.recent_meme_ids_json,
       updated_at = excluded.updated_at`,
    state.groupId,
    state.visionWindowStart,
    state.visionWindowCount,
    state.lastMemeSentAt,
    state.consecutiveMemeCount,
    JSON.stringify(state.recentMemes.slice(-20)),
    state.updatedAt,
  )
}

// ---------------------------------------------------------------------------
// 多模态调用统计（按天 1 行）
// ---------------------------------------------------------------------------

export interface MultimodalStatsDelta {
  visionCalls?: number
  visionCacheHits?: number
  visionErrors?: number
  memeSent?: number
  memeCollected?: number
}

export async function recordMultimodalStats(
  db: ScopedDB,
  delta: MultimodalStatsDelta,
  now = Date.now(),
): Promise<void> {
  const vc = delta.visionCalls ?? 0
  const vh = delta.visionCacheHits ?? 0
  const ve = delta.visionErrors ?? 0
  const ms = delta.memeSent ?? 0
  const mc = delta.memeCollected ?? 0
  if (vc === 0 && vh === 0 && ve === 0 && ms === 0 && mc === 0) return

  const day = formatDayKey(now)
  await db.run(
    `INSERT INTO {multimodal_stats} (
       day, vision_calls, vision_cache_hits, vision_errors, meme_sent, meme_collected, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(day) DO UPDATE SET
       vision_calls = vision_calls + excluded.vision_calls,
       vision_cache_hits = vision_cache_hits + excluded.vision_cache_hits,
       vision_errors = vision_errors + excluded.vision_errors,
       meme_sent = meme_sent + excluded.meme_sent,
       meme_collected = meme_collected + excluded.meme_collected,
       updated_at = excluded.updated_at`,
    day,
    vc,
    vh,
    ve,
    ms,
    mc,
    now,
  )
}

export async function listMultimodalStats(db: ScopedDB, days = 7): Promise<MultimodalDailyStats[]> {
  const rows = await db.all<MultimodalStatsRow>(
    'SELECT * FROM {multimodal_stats} ORDER BY day DESC LIMIT ?',
    Math.min(30, Math.max(1, days)),
  )
  return rows.map((r) => ({
    day: r.day,
    visionCalls: r.vision_calls,
    visionCacheHits: r.vision_cache_hits,
    visionErrors: r.vision_errors,
    memeSent: r.meme_sent,
    memeCollected: r.meme_collected,
    updatedAt: r.updated_at,
  }))
}
