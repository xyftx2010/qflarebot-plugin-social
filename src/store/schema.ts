import type { Logger, ScopedDB } from '@qqbot/sdk'

/**
 * 可追踪的 D1 数据库迁移机制（V0.5.0）。
 *
 * 严格遵循 QFlareBot SQL 规范：
 * - 所有表名、索引名使用 `{占位符}`；
 * - 非整数主键全部加 `WITHOUT ROWID`，减少隐藏索引写入行数；
 * - 禁用 PRAGMA / ATTACH / sqlite_master；
 * - 所有迁移语句幂等（IF NOT EXISTS），绝不破坏现有长期记忆数据。
 */
export interface SchemaMigration {
  version: number
  name: string
  statements: readonly string[]
}

const MIGRATION_TABLE_DDL = `CREATE TABLE IF NOT EXISTS {schema_migrations} (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);`

export const SCHEMA_MIGRATIONS: readonly SchemaMigration[] = [
  {
    version: 1,
    name: 'v0.1.0_base_social_memory',
    statements: [
      `CREATE TABLE IF NOT EXISTS {group_settings} (
        group_id TEXT PRIMARY KEY,
        mode TEXT,
        persona_id TEXT,
        cooldown_seconds INTEGER,
        reply_probability REAL,
        memory_ttl_days INTEGER,
        updated_at INTEGER NOT NULL
      ) WITHOUT ROWID;`,
      `CREATE TABLE IF NOT EXISTS {group_state} (
        group_id TEXT PRIMARY KEY,
        recent_messages_json TEXT NOT NULL,
        last_reply_at INTEGER NOT NULL DEFAULT 0,
        window_start_at INTEGER NOT NULL DEFAULT 0,
        window_reply_count INTEGER NOT NULL DEFAULT 0,
        last_non_at_seen_at INTEGER NOT NULL DEFAULT 0,
        last_prune_at INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      ) WITHOUT ROWID;`,
      `CREATE TABLE IF NOT EXISTS {group_memories} (
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        user_id TEXT,
        user_name TEXT,
        scope TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      ) WITHOUT ROWID;`,
      `CREATE INDEX IF NOT EXISTS {group_memories_grp} ON {group_memories}(group_id, expires_at);`,
      `CREATE TABLE IF NOT EXISTS {member_privacy} (
        group_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        opt_out INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (group_id, user_id)
      ) WITHOUT ROWID;`,
    ],
  },
  {
    version: 2,
    name: 'v0.5.0_multimodal_vision_and_memes',
    statements: [
      `CREATE TABLE IF NOT EXISTS {image_cache} (
        hash TEXT PRIMARY KEY,
        summary TEXT NOT NULL,
        ocr_text TEXT NOT NULL DEFAULT '',
        meme_meaning TEXT NOT NULL DEFAULT '',
        mood TEXT NOT NULL DEFAULT '',
        tags_json TEXT NOT NULL DEFAULT '[]',
        scene_hints TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      ) WITHOUT ROWID;`,
      `CREATE TABLE IF NOT EXISTS {memes} (
        id TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        scope TEXT NOT NULL,
        group_id TEXT,
        r2_key TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        meaning TEXT NOT NULL,
        mood TEXT NOT NULL DEFAULT '',
        tags_json TEXT NOT NULL DEFAULT '[]',
        scene_hints TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL DEFAULT 'general',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_by TEXT,
        use_count INTEGER NOT NULL DEFAULT 0,
        last_used_at INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      ) WITHOUT ROWID;`,
      `CREATE INDEX IF NOT EXISTS {memes_scope_grp} ON {memes}(scope, group_id, enabled, expires_at);`,
      `CREATE INDEX IF NOT EXISTS {memes_hash} ON {memes}(hash, scope, group_id);`,
      `CREATE TABLE IF NOT EXISTS {group_multimodal_state} (
        group_id TEXT PRIMARY KEY,
        vision_window_start INTEGER NOT NULL DEFAULT 0,
        vision_window_count INTEGER NOT NULL DEFAULT 0,
        last_meme_sent_at INTEGER NOT NULL DEFAULT 0,
        consecutive_meme_count INTEGER NOT NULL DEFAULT 0,
        recent_meme_ids_json TEXT NOT NULL DEFAULT '[]',
        updated_at INTEGER NOT NULL
      ) WITHOUT ROWID;`,
      `CREATE TABLE IF NOT EXISTS {multimodal_stats} (
        day TEXT PRIMARY KEY,
        vision_calls INTEGER NOT NULL DEFAULT 0,
        vision_cache_hits INTEGER NOT NULL DEFAULT 0,
        vision_errors INTEGER NOT NULL DEFAULT 0,
        meme_sent INTEGER NOT NULL DEFAULT 0,
        meme_collected INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      ) WITHOUT ROWID;`,
    ],
  },
  {
    version: 3,
    name: 'v0.10.0_ai_voice',
    statements: [
      `CREATE TABLE IF NOT EXISTS {group_voice_settings} (
        group_id TEXT PRIMARY KEY,
        enabled INTEGER,
        trigger_mode TEXT,
        probability REAL,
        voice_id TEXT,
        speed REAL,
        emotion TEXT,
        daily_limit INTEGER,
        updated_at INTEGER NOT NULL
      ) WITHOUT ROWID;`,
      `CREATE TABLE IF NOT EXISTS {voice_cache} (
        cache_key TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        format TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        r2_key TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      ) WITHOUT ROWID;`,
      `CREATE TABLE IF NOT EXISTS {voice_logs} (
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        voice_id TEXT NOT NULL,
        emotion TEXT NOT NULL DEFAULT '',
        char_count INTEGER NOT NULL,
        estimated_cost REAL NOT NULL DEFAULT 0,
        format TEXT NOT NULL,
        cached INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        error TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      ) WITHOUT ROWID;`,
      `CREATE INDEX IF NOT EXISTS {voice_logs_grp_ts} ON {voice_logs}(group_id, created_at);`,
    ],
  },
]

export const SCHEMA_STATEMENTS: readonly string[] = [
  MIGRATION_TABLE_DDL,
  ...SCHEMA_MIGRATIONS.flatMap((m) => m.statements),
]

let schemaReady = false

/** 单元测试重置隔离状态用 */
export function resetSchemaReadyForTest(): void {
  schemaReady = false
}

export async function ensureSchema(db: ScopedDB, logger?: Logger): Promise<void> {
  if (schemaReady) return
  await db.exec(MIGRATION_TABLE_DDL)

  const appliedRows = await db.all<{ version: number }>(
    'SELECT version FROM {schema_migrations} ORDER BY version ASC',
  )
  const applied = new Set(appliedRows.map((r) => r.version))

  for (const migration of SCHEMA_MIGRATIONS) {
    if (applied.has(migration.version)) continue
    await db.exec(migration.statements.join('\n'))
    await db.run(
      'INSERT OR IGNORE INTO {schema_migrations} (version, name, applied_at) VALUES (?, ?, ?)',
      migration.version,
      migration.name,
      Date.now(),
    )
    logger?.info('已应用 D1 数据库迁移', { version: migration.version, name: migration.name })
  }

  schemaReady = true
}

export async function listAppliedMigrations(
  db: ScopedDB,
): Promise<Array<{ version: number; name: string; appliedAt: number }>> {
  const rows = await db.all<{ version: number; name: string; applied_at: number }>(
    'SELECT version, name, applied_at FROM {schema_migrations} ORDER BY version ASC',
  )
  return rows.map((r) => ({ version: r.version, name: r.name, appliedAt: r.applied_at }))
}
