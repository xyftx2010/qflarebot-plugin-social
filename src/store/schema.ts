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
  {
    version: 4,
    name: 'v0.11.0_social_agent',
    statements: [
      `CREATE TABLE IF NOT EXISTS {tool_policy} (
        id TEXT PRIMARY KEY,
        enabled_builtins_json TEXT NOT NULL,
        enabled_external_json TEXT NOT NULL,
        allow_external_writes INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      ) WITHOUT ROWID;`,
      `CREATE TABLE IF NOT EXISTS {prompt_fragments} (
        plugin TEXT PRIMARY KEY,
        fragment TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL
      ) WITHOUT ROWID;`,
      `CREATE TABLE IF NOT EXISTS {tool_stats} (
        day TEXT NOT NULL,
        tool_id TEXT NOT NULL,
        calls INTEGER NOT NULL DEFAULT 0,
        successes INTEGER NOT NULL DEFAULT 0,
        total_latency_ms INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (day, tool_id)
      ) WITHOUT ROWID;`,
      `CREATE TABLE IF NOT EXISTS {tool_logs} (
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        tool_id TEXT NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        latency_ms INTEGER NOT NULL DEFAULT 0,
        error TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      ) WITHOUT ROWID;`,
      `CREATE INDEX IF NOT EXISTS {tool_logs_ts} ON {tool_logs}(created_at);`,
      `CREATE TABLE IF NOT EXISTS {llm_usage_stats} (
        day TEXT PRIMARY KEY,
        runs INTEGER NOT NULL DEFAULT 0,
        tool_calls INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      ) WITHOUT ROWID;`,
    ],
  },
  {
    version: 5,
    name: 'v0.11.1_adaptive_routing',
    statements: [
      `CREATE TABLE IF NOT EXISTS {routing_logs} (
        id TEXT PRIMARY KEY,
        day TEXT NOT NULL,
        group_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        escalated INTEGER NOT NULL DEFAULT 0,
        matched_intents TEXT NOT NULL DEFAULT '',
        candidate_count INTEGER NOT NULL DEFAULT 0,
        tool_calls INTEGER NOT NULL DEFAULT 0,
        tool_failures INTEGER NOT NULL DEFAULT 0,
        false_trigger INTEGER NOT NULL DEFAULT 0,
        latency_ms INTEGER NOT NULL DEFAULT 0,
        tokens INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      ) WITHOUT ROWID;`,
      `CREATE INDEX IF NOT EXISTS {routing_logs_day} ON {routing_logs}(day, group_id);`,
    ],
  },
  {
    version: 6,
    name: 'v0.12.0_style_learning_system',
    statements: [
      `CREATE TABLE IF NOT EXISTS {learning_group_settings} (
        group_id TEXT PRIMARY KEY,
        authorized INTEGER NOT NULL DEFAULT 0,
        freeze_stable INTEGER NOT NULL DEFAULT 0,
        stable_weight REAL,
        recent_weight REAL,
        influence_strength REAL,
        retention_days INTEGER,
        auto_publish INTEGER,
        updated_at INTEGER NOT NULL
      ) WITHOUT ROWID;`,
      `CREATE TABLE IF NOT EXISTS {learning_sources} (
        source_id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        source_type TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        consent_status TEXT NOT NULL DEFAULT 'authorized',
        total_rows INTEGER NOT NULL DEFAULT 0,
        accepted_rows INTEGER NOT NULL DEFAULT 0,
        skipped_rows INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'completed',
        error_summary TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) WITHOUT ROWID;`,
      `CREATE INDEX IF NOT EXISTS {learning_sources_grp} ON {learning_sources}(group_id, created_at);`,
      `CREATE TABLE IF NOT EXISTS {learning_corpus} (
        corpus_id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        source_type TEXT NOT NULL,
        pseudonymous_sender_id TEXT NOT NULL,
        message_id TEXT NOT NULL DEFAULT '',
        timestamp INTEGER NOT NULL,
        message_type TEXT NOT NULL DEFAULT 'text',
        content TEXT NOT NULL,
        reply_to TEXT NOT NULL DEFAULT '',
        mentions_json TEXT NOT NULL DEFAULT '[]',
        consent_status TEXT NOT NULL DEFAULT 'authorized',
        content_hash TEXT NOT NULL,
        quality_score REAL NOT NULL DEFAULT 0,
        learning_status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      ) WITHOUT ROWID;`,
      `CREATE INDEX IF NOT EXISTS {learning_corpus_grp_status} ON {learning_corpus}(group_id, learning_status, timestamp);`,
      `CREATE INDEX IF NOT EXISTS {learning_corpus_hash} ON {learning_corpus}(group_id, content_hash);`,
      `CREATE INDEX IF NOT EXISTS {learning_corpus_sender} ON {learning_corpus}(group_id, pseudonymous_sender_id);`,
      `CREATE TABLE IF NOT EXISTS {learning_jobs} (
        job_id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        trigger_type TEXT NOT NULL,
        status TEXT NOT NULL,
        checkpoint_cursor INTEGER NOT NULL DEFAULT 0,
        processed_count INTEGER NOT NULL DEFAULT 0,
        retry_count INTEGER NOT NULL DEFAULT 0,
        lease_until INTEGER NOT NULL DEFAULT 0,
        candidate_profile_id TEXT NOT NULL DEFAULT '',
        error TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) WITHOUT ROWID;`,
      `CREATE INDEX IF NOT EXISTS {learning_jobs_grp} ON {learning_jobs}(group_id, status, updated_at);`,
      `CREATE TABLE IF NOT EXISTS {style_profiles} (
        profile_id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        status TEXT NOT NULL,
        stable_style_json TEXT NOT NULL,
        recent_style_json TEXT NOT NULL,
        behavior_profile_json TEXT NOT NULL,
        evidence_count INTEGER NOT NULL DEFAULT 0,
        distinct_senders INTEGER NOT NULL DEFAULT 0,
        confidence REAL NOT NULL DEFAULT 0,
        source_window_start INTEGER NOT NULL DEFAULT 0,
        source_window_end INTEGER NOT NULL DEFAULT 0,
        source_corpus_ids_json TEXT NOT NULL DEFAULT '[]',
        contains_deleted_data INTEGER NOT NULL DEFAULT 0,
        notes TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        published_at INTEGER NOT NULL DEFAULT 0
      ) WITHOUT ROWID;`,
      `CREATE INDEX IF NOT EXISTS {style_profiles_grp} ON {style_profiles}(group_id, status, version);`,
      `CREATE TABLE IF NOT EXISTS {group_memes} (
        meme_id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        name TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'group_exclusive',
        meaning TEXT NOT NULL,
        aliases_json TEXT NOT NULL DEFAULT '[]',
        example_patterns_json TEXT NOT NULL DEFAULT '[]',
        applicable_context TEXT NOT NULL DEFAULT '',
        inappropriate_context TEXT NOT NULL DEFAULT '',
        source_corpus_ids_json TEXT NOT NULL DEFAULT '[]',
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        occurrence_count INTEGER NOT NULL DEFAULT 1,
        distinct_sender_count INTEGER NOT NULL DEFAULT 1,
        confidence REAL NOT NULL DEFAULT 0.5,
        popularity_weight REAL NOT NULL DEFAULT 0.5,
        decay_weight REAL NOT NULL DEFAULT 1.0,
        status TEXT NOT NULL DEFAULT 'candidate',
        updated_at INTEGER NOT NULL
      ) WITHOUT ROWID;`,
      `CREATE INDEX IF NOT EXISTS {group_memes_grp} ON {group_memes}(group_id, status, popularity_weight);`,
      `CREATE TABLE IF NOT EXISTS {dialogue_examples} (
        example_id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        context_json TEXT NOT NULL,
        target_response TEXT NOT NULL,
        topic_tags_json TEXT NOT NULL DEFAULT '[]',
        intent_tags_json TEXT NOT NULL DEFAULT '[]',
        emotion TEXT NOT NULL DEFAULT 'neutral',
        dialogue_behavior TEXT NOT NULL DEFAULT 'casual',
        humor_type TEXT NOT NULL DEFAULT 'none',
        style_features_json TEXT NOT NULL DEFAULT '[]',
        search_tokens TEXT NOT NULL DEFAULT '',
        quality_score REAL NOT NULL DEFAULT 0.5,
        confidence REAL NOT NULL DEFAULT 0.5,
        source_corpus_ids_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      ) WITHOUT ROWID;`,
      `CREATE INDEX IF NOT EXISTS {dialogue_examples_grp} ON {dialogue_examples}(group_id, status, quality_score);`,
      `CREATE TABLE IF NOT EXISTS {learning_feedback} (
        feedback_id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        profile_id TEXT NOT NULL DEFAULT '',
        mode TEXT NOT NULL DEFAULT 'live',
        context_excerpt TEXT NOT NULL DEFAULT '',
        bot_reply TEXT NOT NULL,
        rating TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'admin',
        created_at INTEGER NOT NULL
      ) WITHOUT ROWID;`,
      `CREATE INDEX IF NOT EXISTS {learning_feedback_grp} ON {learning_feedback}(group_id, created_at);`,
      `CREATE TABLE IF NOT EXISTS {learning_usage_stats} (
        day TEXT PRIMARY KEY,
        runs INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        jobs_completed INTEGER NOT NULL DEFAULT 0,
        jobs_failed INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      ) WITHOUT ROWID;`,
      `CREATE TABLE IF NOT EXISTS {learning_audit_logs} (
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        action TEXT NOT NULL,
        actor TEXT NOT NULL DEFAULT 'system',
        detail TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      ) WITHOUT ROWID;`,
      `CREATE INDEX IF NOT EXISTS {learning_audit_grp} ON {learning_audit_logs}(group_id, created_at);`,
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
