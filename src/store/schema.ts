import type { Logger, ScopedDB } from '@qqbot/sdk'

/**
 * D1 表结构定义。
 *
 * 严格遵循 QFlareBot SQL 规范：
 * - 所有表名、索引名使用 `{占位符}`；
 * - 非整数主键全部加 `WITHOUT ROWID`，减少隐藏索引写入行数；
 * - 禁用 PRAGMA / ATTACH / sqlite_master。
 */
export const SCHEMA_STATEMENTS: readonly string[] = [
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
]

/** 供未来升级补列使用：按列探测，禁止使用 PRAGMA table_info */
const COLUMN_MIGRATIONS: ReadonlyArray<{ table: string; column: string; ddl: string }> = []

let schemaReady = false

/** 单元测试重置隔离状态用 */
export function resetSchemaReadyForTest(): void {
  schemaReady = false
}

export async function ensureSchema(db: ScopedDB, logger?: Logger): Promise<void> {
  if (schemaReady) return
  for (const sql of SCHEMA_STATEMENTS) {
    await db.exec(sql)
  }
  for (const m of COLUMN_MIGRATIONS) {
    try {
      await db.all(`SELECT ${m.column} FROM {${m.table}} LIMIT 0`)
    } catch {
      logger?.info('执行 D1 惰性补列迁移', { table: m.table, column: m.column })
      await db.exec(m.ddl)
    }
  }
  schemaReady = true
}
