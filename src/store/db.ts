import type { ScopedDB } from '@qqbot/sdk'
import type {
  ContextMessage,
  GroupMemory,
  GroupSettings,
  GroupState,
  MemberPrivacy,
  MemoryScope,
  SocialMode,
} from '../types.js'

interface GroupSettingsRow {
  group_id: string
  mode: string | null
  persona_id: string | null
  cooldown_seconds: number | null
  reply_probability: number | null
  memory_ttl_days: number | null
  updated_at: number
}

interface GroupStateRow {
  group_id: string
  recent_messages_json: string
  last_reply_at: number
  window_start_at: number
  window_reply_count: number
  last_non_at_seen_at: number
  last_prune_at: number
  updated_at: number
}

interface GroupMemoryRow {
  id: string
  group_id: string
  user_id: string | null
  user_name: string | null
  scope: string
  content: string
  created_at: number
  expires_at: number
}

interface MemberPrivacyRow {
  group_id: string
  user_id: string
  opt_out: number
  updated_at: number
}

function parseMode(val: string | null): SocialMode | null {
  if (val === 'auto' || val === 'at' || val === 'off') return val
  return null
}

function parseContextJson(raw: string): ContextMessage[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (item): item is ContextMessage =>
        typeof item === 'object' &&
        item !== null &&
        (item.role === 'user' || item.role === 'assistant') &&
        typeof item.text === 'string' &&
        typeof item.ts === 'number',
    )
  } catch {
    return []
  }
}

export function createEmptyGroupState(groupId: string, now = Date.now()): GroupState {
  return {
    groupId,
    recentMessages: [],
    lastReplyAt: 0,
    windowStartAt: 0,
    windowReplyCount: 0,
    lastNonAtSeenAt: 0,
    lastPruneAt: 0,
    updatedAt: now,
  }
}

export async function getGroupSettings(db: ScopedDB, groupId: string): Promise<GroupSettings | null> {
  const row = await db.first<GroupSettingsRow>(
    'SELECT group_id, mode, persona_id, cooldown_seconds, reply_probability, memory_ttl_days, updated_at FROM {group_settings} WHERE group_id = ?',
    groupId,
  )
  if (!row) return null
  return {
    groupId: row.group_id,
    mode: parseMode(row.mode),
    personaId: row.persona_id,
    cooldownSeconds: row.cooldown_seconds,
    replyProbability: row.reply_probability,
    memoryTtlDays: row.memory_ttl_days,
    updatedAt: row.updated_at,
  }
}

export async function listGroupSettings(db: ScopedDB, limit = 100): Promise<GroupSettings[]> {
  const rows = await db.all<GroupSettingsRow>(
    'SELECT group_id, mode, persona_id, cooldown_seconds, reply_probability, memory_ttl_days, updated_at FROM {group_settings} ORDER BY updated_at DESC LIMIT ?',
    limit,
  )
  return rows.map((row) => ({
    groupId: row.group_id,
    mode: parseMode(row.mode),
    personaId: row.persona_id,
    cooldownSeconds: row.cooldown_seconds,
    replyProbability: row.reply_probability,
    memoryTtlDays: row.memory_ttl_days,
    updatedAt: row.updated_at,
  }))
}

export async function upsertGroupSettings(
  db: ScopedDB,
  groupId: string,
  patch: Partial<Omit<GroupSettings, 'groupId' | 'updatedAt'>>,
  now = Date.now(),
): Promise<GroupSettings> {
  const existing = await getGroupSettings(db, groupId)
  const next: GroupSettings = {
    groupId,
    mode: patch.mode !== undefined ? patch.mode : (existing?.mode ?? null),
    personaId: patch.personaId !== undefined ? patch.personaId : (existing?.personaId ?? null),
    cooldownSeconds: patch.cooldownSeconds !== undefined ? patch.cooldownSeconds : (existing?.cooldownSeconds ?? null),
    replyProbability:
      patch.replyProbability !== undefined ? patch.replyProbability : (existing?.replyProbability ?? null),
    memoryTtlDays: patch.memoryTtlDays !== undefined ? patch.memoryTtlDays : (existing?.memoryTtlDays ?? null),
    updatedAt: now,
  }
  await db.run(
    `INSERT INTO {group_settings} (group_id, mode, persona_id, cooldown_seconds, reply_probability, memory_ttl_days, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(group_id) DO UPDATE SET
       mode = excluded.mode,
       persona_id = excluded.persona_id,
       cooldown_seconds = excluded.cooldown_seconds,
       reply_probability = excluded.reply_probability,
       memory_ttl_days = excluded.memory_ttl_days,
       updated_at = excluded.updated_at`,
    next.groupId,
    next.mode,
    next.personaId,
    next.cooldownSeconds,
    next.replyProbability,
    next.memoryTtlDays,
    next.updatedAt,
  )
  return next
}

export async function getGroupState(db: ScopedDB, groupId: string): Promise<GroupState | null> {
  const row = await db.first<GroupStateRow>(
    `SELECT group_id, recent_messages_json, last_reply_at, window_start_at, window_reply_count,
            last_non_at_seen_at, last_prune_at, updated_at
     FROM {group_state} WHERE group_id = ?`,
    groupId,
  )
  if (!row) return null
  return {
    groupId: row.group_id,
    recentMessages: parseContextJson(row.recent_messages_json),
    lastReplyAt: row.last_reply_at,
    windowStartAt: row.window_start_at,
    windowReplyCount: row.window_reply_count,
    lastNonAtSeenAt: row.last_non_at_seen_at,
    lastPruneAt: row.last_prune_at,
    updatedAt: row.updated_at,
  }
}

export async function listTrackedGroups(db: ScopedDB, limit = 100): Promise<GroupState[]> {
  const rows = await db.all<GroupStateRow>(
    `SELECT group_id, recent_messages_json, last_reply_at, window_start_at, window_reply_count,
            last_non_at_seen_at, last_prune_at, updated_at
     FROM {group_state} ORDER BY updated_at DESC LIMIT ?`,
    limit,
  )
  return rows.map((row) => ({
    groupId: row.group_id,
    recentMessages: parseContextJson(row.recent_messages_json),
    lastReplyAt: row.last_reply_at,
    windowStartAt: row.window_start_at,
    windowReplyCount: row.window_reply_count,
    lastNonAtSeenAt: row.last_non_at_seen_at,
    lastPruneAt: row.last_prune_at,
    updatedAt: row.updated_at,
  }))
}

export async function saveGroupState(db: ScopedDB, state: GroupState): Promise<void> {
  await db.run(
    `INSERT INTO {group_state} (
       group_id, recent_messages_json, last_reply_at, window_start_at, window_reply_count,
       last_non_at_seen_at, last_prune_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(group_id) DO UPDATE SET
       recent_messages_json = excluded.recent_messages_json,
       last_reply_at = excluded.last_reply_at,
       window_start_at = excluded.window_start_at,
       window_reply_count = excluded.window_reply_count,
       last_non_at_seen_at = excluded.last_non_at_seen_at,
       last_prune_at = excluded.last_prune_at,
       updated_at = excluded.updated_at`,
    state.groupId,
    JSON.stringify(state.recentMessages),
    state.lastReplyAt,
    state.windowStartAt,
    state.windowReplyCount,
    state.lastNonAtSeenAt,
    state.lastPruneAt,
    state.updatedAt,
  )
}

export async function getMemberPrivacy(db: ScopedDB, groupId: string, userId: string): Promise<MemberPrivacy | null> {
  const row = await db.first<MemberPrivacyRow>(
    'SELECT group_id, user_id, opt_out, updated_at FROM {member_privacy} WHERE group_id = ? AND user_id = ?',
    groupId,
    userId,
  )
  if (!row) return null
  return {
    groupId: row.group_id,
    userId: row.user_id,
    optOut: row.opt_out === 1,
    updatedAt: row.updated_at,
  }
}

export async function setMemberOptOut(
  db: ScopedDB,
  groupId: string,
  userId: string,
  optOut: boolean,
  now = Date.now(),
): Promise<MemberPrivacy> {
  await db.run(
    `INSERT INTO {member_privacy} (group_id, user_id, opt_out, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(group_id, user_id) DO UPDATE SET
       opt_out = excluded.opt_out,
       updated_at = excluded.updated_at`,
    groupId,
    userId,
    optOut ? 1 : 0,
    now,
  )
  return { groupId, userId, optOut, updatedAt: now }
}

function mapMemoryRow(row: GroupMemoryRow): GroupMemory {
  return {
    id: row.id,
    groupId: row.group_id,
    userId: row.user_id,
    userName: row.user_name,
    scope: row.scope === 'member' ? 'member' : 'group',
    content: row.content,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  }
}

export async function insertGroupMemory(
  db: ScopedDB,
  memory: GroupMemory,
): Promise<void> {
  await db.run(
    `INSERT INTO {group_memories} (id, group_id, user_id, user_name, scope, content, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    memory.id,
    memory.groupId,
    memory.userId,
    memory.userName,
    memory.scope,
    memory.content,
    memory.createdAt,
    memory.expiresAt,
  )
}

export async function listActiveGroupMemories(
  db: ScopedDB,
  groupId: string,
  now = Date.now(),
  limit = 30,
): Promise<GroupMemory[]> {
  const rows = await db.all<GroupMemoryRow>(
    `SELECT id, group_id, user_id, user_name, scope, content, created_at, expires_at
     FROM {group_memories}
     WHERE group_id = ? AND expires_at > ?
     ORDER BY created_at DESC
     LIMIT ?`,
    groupId,
    now,
    limit,
  )
  return rows.map(mapMemoryRow)
}

export async function deleteGroupMemoryById(db: ScopedDB, groupId: string, id: string): Promise<number> {
  const res = await db.run('DELETE FROM {group_memories} WHERE group_id = ? AND id = ?', groupId, id)
  return res.changes
}

export async function deleteMemberMemories(db: ScopedDB, groupId: string, userId: string): Promise<number> {
  const res = await db.run('DELETE FROM {group_memories} WHERE group_id = ? AND user_id = ?', groupId, userId)
  return res.changes
}

export async function clearGroupMemories(db: ScopedDB, groupId: string): Promise<number> {
  const res = await db.run('DELETE FROM {group_memories} WHERE group_id = ?', groupId)
  return res.changes
}

export async function pruneExpiredGroupMemories(db: ScopedDB, groupId: string, now = Date.now()): Promise<number> {
  const res = await db.run(
    'DELETE FROM {group_memories} WHERE group_id = ? AND expires_at <= ?',
    groupId,
    now,
  )
  return res.changes
}

export async function trimExcessGroupMemories(
  db: ScopedDB,
  groupId: string,
  maxKeep: number,
  now = Date.now(),
): Promise<number> {
  const active = await listActiveGroupMemories(db, groupId, now, maxKeep + 50)
  if (active.length <= maxKeep) return 0
  const toDrop = active.slice(maxKeep)
  let deleted = 0
  for (const item of toDrop) {
    deleted += await deleteGroupMemoryById(db, groupId, item.id)
  }
  return deleted
}

export interface GroupChatSnapshot {
  settings: GroupSettings | null
  state: GroupState | null
  memories: GroupMemory[]
}

/**
 * 一次 D1 网络往返合批读取群设置、群状态滑窗与活跃记忆，显著降低回复前延迟。
 */
export async function loadGroupChatSnapshot(
  db: ScopedDB,
  groupId: string,
  now = Date.now(),
  includeMemories = true,
  memoryLimit = 12,
): Promise<GroupChatSnapshot> {
  if (typeof db.batch === 'function') {
    const statements = [
      {
        sql: 'SELECT group_id, mode, persona_id, cooldown_seconds, reply_probability, memory_ttl_days, updated_at FROM {group_settings} WHERE group_id = ?',
        params: [groupId],
      },
      {
        sql: `SELECT group_id, recent_messages_json, last_reply_at, window_start_at, window_reply_count,
                     last_non_at_seen_at, last_prune_at, updated_at
              FROM {group_state} WHERE group_id = ?`,
        params: [groupId],
      },
      ...(includeMemories
        ? [
            {
              sql: `SELECT id, group_id, user_id, user_name, scope, content, created_at, expires_at
                    FROM {group_memories}
                    WHERE group_id = ? AND expires_at > ?
                    ORDER BY created_at DESC
                    LIMIT ?`,
              params: [groupId, now, memoryLimit],
            },
          ]
        : []),
    ]

    const results = await db.batch(statements)
    const settingsRow = results[0]?.results[0] as unknown as GroupSettingsRow | undefined
    const stateRow = results[1]?.results[0] as unknown as GroupStateRow | undefined
    const memoryRows = includeMemories
      ? ((results[2]?.results ?? []) as unknown as GroupMemoryRow[])
      : []

    return {
      settings: settingsRow
        ? {
            groupId: settingsRow.group_id,
            mode: parseMode(settingsRow.mode),
            personaId: settingsRow.persona_id,
            cooldownSeconds: settingsRow.cooldown_seconds,
            replyProbability: settingsRow.reply_probability,
            memoryTtlDays: settingsRow.memory_ttl_days,
            updatedAt: settingsRow.updated_at,
          }
        : null,
      state: stateRow
        ? {
            groupId: stateRow.group_id,
            recentMessages: parseContextJson(stateRow.recent_messages_json),
            lastReplyAt: stateRow.last_reply_at,
            windowStartAt: stateRow.window_start_at,
            windowReplyCount: stateRow.window_reply_count,
            lastNonAtSeenAt: stateRow.last_non_at_seen_at,
            lastPruneAt: stateRow.last_prune_at,
            updatedAt: stateRow.updated_at,
          }
        : null,
      memories: memoryRows.map(mapMemoryRow),
    }
  }

  const [settings, state, memories] = await Promise.all([
    getGroupSettings(db, groupId),
    getGroupState(db, groupId),
    includeMemories ? listActiveGroupMemories(db, groupId, now, memoryLimit) : Promise.resolve([]),
  ])
  return { settings, state, memories }
}

export type { MemoryScope }
