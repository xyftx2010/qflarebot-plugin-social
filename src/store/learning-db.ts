import type { PluginDB } from '@qqbot/sdk'
import type {
  CorpusRecord,
  DialogueExampleRecord,
  GroupMemeRecord,
  GroupMemeStatus,
  LearningAuditLog,
  LearningFeedbackRecord,
  LearningGroupSettings,
  LearningJobRecord,
  LearningSourceRecord,
  LearningUsageDay,
  StyleProfileRecord,
  StyleProfileStatus,
} from '../learning/types.js'
import { validateBehaviorProfile, validateStyleLayer } from '../learning/types.js'

function dayKey(ts: number): string {
  return new Date(ts + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

// ---- 群级学习配置 ----

export async function getLearningGroupSettings(
  db: PluginDB,
  groupId: string,
): Promise<LearningGroupSettings | null> {
  const row = await db.first<{
    group_id: string
    authorized: number
    freeze_stable: number
    stable_weight: number | null
    recent_weight: number | null
    influence_strength: number | null
    retention_days: number | null
    auto_publish: number | null
    updated_at: number
  }>('SELECT * FROM {learning_group_settings} WHERE group_id = ?', groupId)
  if (!row) return null
  return {
    groupId: row.group_id,
    authorized: row.authorized === 1,
    freezeStable: row.freeze_stable === 1,
    stableWeight: row.stable_weight,
    recentWeight: row.recent_weight,
    influenceStrength: row.influence_strength,
    retentionDays: row.retention_days,
    autoPublish: row.auto_publish === null ? null : row.auto_publish === 1,
    updatedAt: row.updated_at,
  }
}

export async function listAuthorizedLearningGroups(db: PluginDB): Promise<LearningGroupSettings[]> {
  const rows = await db.all<{
    group_id: string
    authorized: number
    freeze_stable: number
    stable_weight: number | null
    recent_weight: number | null
    influence_strength: number | null
    retention_days: number | null
    auto_publish: number | null
    updated_at: number
  }>('SELECT * FROM {learning_group_settings} WHERE authorized = 1 ORDER BY updated_at DESC')
  return rows.map((row) => ({
    groupId: row.group_id,
    authorized: true,
    freezeStable: row.freeze_stable === 1,
    stableWeight: row.stable_weight,
    recentWeight: row.recent_weight,
    influenceStrength: row.influence_strength,
    retentionDays: row.retention_days,
    autoPublish: row.auto_publish === null ? null : row.auto_publish === 1,
    updatedAt: row.updated_at,
  }))
}

export async function upsertLearningGroupSettings(
  db: PluginDB,
  groupId: string,
  patch: Partial<Omit<LearningGroupSettings, 'groupId' | 'updatedAt'>>,
  now = Date.now(),
): Promise<LearningGroupSettings> {
  const cur = await getLearningGroupSettings(db, groupId)
  const next: LearningGroupSettings = {
    groupId,
    authorized: patch.authorized ?? cur?.authorized ?? false,
    freezeStable: patch.freezeStable ?? cur?.freezeStable ?? false,
    stableWeight: patch.stableWeight !== undefined ? patch.stableWeight : (cur?.stableWeight ?? null),
    recentWeight: patch.recentWeight !== undefined ? patch.recentWeight : (cur?.recentWeight ?? null),
    influenceStrength: patch.influenceStrength !== undefined ? patch.influenceStrength : (cur?.influenceStrength ?? null),
    retentionDays: patch.retentionDays !== undefined ? patch.retentionDays : (cur?.retentionDays ?? null),
    autoPublish: patch.autoPublish !== undefined ? patch.autoPublish : (cur?.autoPublish ?? null),
    updatedAt: now,
  }
  await db.run(
    `INSERT INTO {learning_group_settings}
      (group_id, authorized, freeze_stable, stable_weight, recent_weight, influence_strength, retention_days, auto_publish, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(group_id) DO UPDATE SET
      authorized = excluded.authorized,
      freeze_stable = excluded.freeze_stable,
      stable_weight = excluded.stable_weight,
      recent_weight = excluded.recent_weight,
      influence_strength = excluded.influence_strength,
      retention_days = excluded.retention_days,
      auto_publish = excluded.auto_publish,
      updated_at = excluded.updated_at`,
    next.groupId,
    next.authorized ? 1 : 0,
    next.freezeStable ? 1 : 0,
    next.stableWeight ?? null,
    next.recentWeight ?? null,
    next.influenceStrength ?? null,
    next.retentionDays ?? null,
    next.autoPublish === null || next.autoPublish === undefined ? null : next.autoPublish ? 1 : 0,
    next.updatedAt,
  )
  return next
}

// ---- 语料来源与语料库 ----

export async function upsertLearningSource(db: PluginDB, rec: LearningSourceRecord): Promise<void> {
  await db.run(
    `INSERT INTO {learning_sources}
      (source_id, group_id, source_type, label, consent_status, total_rows, accepted_rows, skipped_rows, status, error_summary, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_id) DO UPDATE SET
      total_rows = total_rows + excluded.total_rows,
      accepted_rows = accepted_rows + excluded.accepted_rows,
      skipped_rows = skipped_rows + excluded.skipped_rows,
      status = excluded.status,
      error_summary = excluded.error_summary,
      updated_at = excluded.updated_at`,
    rec.sourceId,
    rec.groupId,
    rec.sourceType,
    rec.label,
    rec.consentStatus,
    rec.totalRows,
    rec.acceptedRows,
    rec.skippedRows,
    rec.status,
    rec.errorSummary,
    rec.createdAt,
    rec.updatedAt,
  )
}

export async function listLearningSources(db: PluginDB, groupId: string, limit = 30): Promise<LearningSourceRecord[]> {
  const rows = await db.all<{
    source_id: string
    group_id: string
    source_type: string
    label: string
    consent_status: string
    total_rows: number
    accepted_rows: number
    skipped_rows: number
    status: string
    error_summary: string
    created_at: number
    updated_at: number
  }>(
    'SELECT * FROM {learning_sources} WHERE group_id = ? ORDER BY created_at DESC LIMIT ?',
    groupId,
    Math.min(100, Math.max(1, limit)),
  )
  return rows.map((r) => ({
    sourceId: r.source_id,
    groupId: r.group_id,
    sourceType: r.source_type as LearningSourceRecord['sourceType'],
    label: r.label,
    consentStatus: r.consent_status as 'authorized' | 'revoked',
    totalRows: r.total_rows,
    acceptedRows: r.accepted_rows,
    skippedRows: r.skipped_rows,
    status: r.status as LearningSourceRecord['status'],
    errorSummary: r.error_summary,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }))
}

export async function hasCorpusContentHash(db: PluginDB, groupId: string, contentHash: string): Promise<boolean> {
  const row = await db.first<{ corpus_id: string }>(
    'SELECT corpus_id FROM {learning_corpus} WHERE group_id = ? AND content_hash = ? LIMIT 1',
    groupId,
    contentHash,
  )
  return Boolean(row)
}

/** 批量查询已存在的 content_hash，避免导入时逐条 SELECT 触发 Workers 子请求上限 */
export async function findExistingCorpusHashes(
  db: PluginDB,
  groupId: string,
  hashes: readonly string[],
): Promise<Set<string>> {
  const existing = new Set<string>()
  if (hashes.length === 0) return existing
  const unique = [...new Set(hashes)]
  for (let i = 0; i < unique.length; i += 50) {
    const slice = unique.slice(i, i + 50)
    const placeholders = slice.map(() => '?').join(', ')
    const rows = await db.all<{ content_hash: string }>(
      `SELECT content_hash FROM {learning_corpus} WHERE group_id = ? AND content_hash IN (${placeholders})`,
      groupId,
      ...slice,
    )
    for (const r of rows) existing.add(r.content_hash)
  }
  return existing
}

export async function insertCorpusBatch(db: PluginDB, records: readonly CorpusRecord[]): Promise<void> {
  if (records.length === 0) return
  // 分批使用 db.batch 避免单次语句过多
  for (let i = 0; i < records.length; i += 25) {
    const slice = records.slice(i, i + 25)
    await db.batch(
      slice.map((r) => ({
        sql: `INSERT OR IGNORE INTO {learning_corpus}
          (corpus_id, group_id, source_id, source_type, pseudonymous_sender_id, message_id, timestamp, message_type, content, reply_to, mentions_json, consent_status, content_hash, quality_score, learning_status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          r.corpusId,
          r.groupId,
          r.sourceId,
          r.sourceType,
          r.pseudonymousSenderId,
          r.messageId,
          r.timestamp,
          r.messageType,
          r.content,
          r.replyTo,
          JSON.stringify(r.mentions),
          r.consentStatus,
          r.contentHash,
          r.qualityScore,
          r.learningStatus,
          r.createdAt,
          r.expiresAt,
        ],
      })),
    )
  }
}

function mapCorpusRow(r: Record<string, unknown>): CorpusRecord {
  return {
    corpusId: String(r.corpus_id),
    groupId: String(r.group_id),
    sourceId: String(r.source_id),
    sourceType: String(r.source_type) as CorpusRecord['sourceType'],
    pseudonymousSenderId: String(r.pseudonymous_sender_id),
    messageId: String(r.message_id ?? ''),
    timestamp: Number(r.timestamp),
    messageType: (String(r.message_type || 'text') as CorpusRecord['messageType']),
    content: String(r.content),
    replyTo: String(r.reply_to ?? ''),
    mentions: safeJsonParse<string[]>(String(r.mentions_json ?? '[]'), []),
    consentStatus: String(r.consent_status) as 'authorized' | 'opted_out',
    contentHash: String(r.content_hash),
    qualityScore: Number(r.quality_score),
    learningStatus: String(r.learning_status) as CorpusRecord['learningStatus'],
    createdAt: Number(r.created_at),
    expiresAt: Number(r.expires_at),
  }
}

export async function listCorpusRecords(
  db: PluginDB,
  opts: {
    groupId: string
    status?: string
    senderId?: string
    minQuality?: number
    sinceTs?: number
    limit?: number
  },
): Promise<CorpusRecord[]> {
  const where: string[] = ['group_id = ?']
  const params: unknown[] = [opts.groupId]
  if (opts.status) {
    where.push('learning_status = ?')
    params.push(opts.status)
  }
  if (opts.senderId) {
    where.push('pseudonymous_sender_id = ?')
    params.push(opts.senderId)
  }
  if (typeof opts.minQuality === 'number') {
    where.push('quality_score >= ?')
    params.push(opts.minQuality)
  }
  if (typeof opts.sinceTs === 'number') {
    where.push('timestamp >= ?')
    params.push(opts.sinceTs)
  }
  params.push(Math.min(400, Math.max(1, opts.limit ?? 100)))
  const rows = await db.all<Record<string, unknown>>(
    `SELECT * FROM {learning_corpus} WHERE ${where.join(' AND ')} ORDER BY timestamp DESC LIMIT ?`,
    ...params,
  )
  return rows.map(mapCorpusRow)
}

export async function countCorpusSummary(
  db: PluginDB,
  groupId: string,
): Promise<{ total: number; pending: number; processed: number; onlineCount: number; importCount: number }> {
  const row = await db.first<{
    total: number
    pending: number
    processed: number
    online_cnt: number
    import_cnt: number
  }>(
    `SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN learning_status = 'pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN learning_status = 'processed' THEN 1 ELSE 0 END) AS processed,
      SUM(CASE WHEN source_type = 'online' THEN 1 ELSE 0 END) AS online_cnt,
      SUM(CASE WHEN source_type != 'online' THEN 1 ELSE 0 END) AS import_cnt
     FROM {learning_corpus} WHERE group_id = ? AND learning_status != 'excluded'`,
    groupId,
  )
  return {
    total: row?.total ?? 0,
    pending: row?.pending ?? 0,
    processed: row?.processed ?? 0,
    onlineCount: row?.online_cnt ?? 0,
    importCount: row?.import_cnt ?? 0,
  }
}

export async function markCorpusStatus(
  db: PluginDB,
  corpusIds: readonly string[],
  status: CorpusRecord['learningStatus'],
): Promise<void> {
  if (corpusIds.length === 0) return
  for (let i = 0; i < corpusIds.length; i += 25) {
    const slice = corpusIds.slice(i, i + 25)
    await db.batch(
      slice.map((id) => ({
        sql: 'UPDATE {learning_corpus} SET learning_status = ? WHERE corpus_id = ?',
        params: [status, id],
      })),
    )
  }
}

export async function deleteCorpusByIds(db: PluginDB, groupId: string, corpusIds: readonly string[]): Promise<number> {
  let deleted = 0
  for (const id of corpusIds) {
    const res = await db.run('DELETE FROM {learning_corpus} WHERE group_id = ? AND corpus_id = ?', groupId, id)
    deleted += res.changes
  }
  return deleted
}

export async function deleteCorpusBySender(
  db: PluginDB,
  groupId: string,
  pseudonymousSenderId: string,
): Promise<string[]> {
  const rows = await db.all<{ corpus_id: string }>(
    'SELECT corpus_id FROM {learning_corpus} WHERE group_id = ? AND pseudonymous_sender_id = ?',
    groupId,
    pseudonymousSenderId,
  )
  const ids = rows.map((r) => r.corpus_id)
  if (ids.length > 0) {
    await db.run(
      'DELETE FROM {learning_corpus} WHERE group_id = ? AND pseudonymous_sender_id = ?',
      groupId,
      pseudonymousSenderId,
    )
  }
  return ids
}

export async function pruneExpiredLearningData(db: PluginDB, now: number): Promise<{ corpus: number; examples: number }> {
  const c = await db.run('DELETE FROM {learning_corpus} WHERE expires_at > 0 AND expires_at < ?', now)
  const e = await db.run('DELETE FROM {dialogue_examples} WHERE expires_at > 0 AND expires_at < ?', now)
  return { corpus: c.changes, examples: e.changes }
}

// ---- 风格档案版本管理 ----

function mapProfileRow(r: Record<string, unknown>): StyleProfileRecord {
  return {
    profileId: String(r.profile_id),
    groupId: String(r.group_id),
    version: Number(r.version),
    status: String(r.status) as StyleProfileStatus,
    stableStyle: validateStyleLayer(safeJsonParse(String(r.stable_style_json), {})),
    recentStyle: validateStyleLayer(safeJsonParse(String(r.recent_style_json), {})),
    behaviorProfile: validateBehaviorProfile(safeJsonParse(String(r.behavior_profile_json), {})),
    evidenceCount: Number(r.evidence_count),
    distinctSenders: Number(r.distinct_senders),
    confidence: Number(r.confidence),
    sourceWindowStart: Number(r.source_window_start),
    sourceWindowEnd: Number(r.source_window_end),
    sourceCorpusIds: safeJsonParse<string[]>(String(r.source_corpus_ids_json ?? '[]'), []),
    containsDeletedData: Number(r.contains_deleted_data) === 1,
    notes: String(r.notes ?? ''),
    createdAt: Number(r.created_at),
    publishedAt: Number(r.published_at ?? 0),
  }
}

export async function getPublishedStyleProfile(db: PluginDB, groupId: string): Promise<StyleProfileRecord | null> {
  const row = await db.first<Record<string, unknown>>(
    `SELECT * FROM {style_profiles}
     WHERE group_id = ? AND status IN ('published', 'frozen') AND contains_deleted_data = 0
     ORDER BY version DESC LIMIT 1`,
    groupId,
  )
  return row ? mapProfileRow(row) : null
}

export async function getStyleProfileById(db: PluginDB, profileId: string): Promise<StyleProfileRecord | null> {
  const row = await db.first<Record<string, unknown>>(
    'SELECT * FROM {style_profiles} WHERE profile_id = ?',
    profileId,
  )
  return row ? mapProfileRow(row) : null
}

export async function listStyleProfiles(db: PluginDB, groupId: string, limit = 20): Promise<StyleProfileRecord[]> {
  const rows = await db.all<Record<string, unknown>>(
    'SELECT * FROM {style_profiles} WHERE group_id = ? ORDER BY version DESC LIMIT ?',
    groupId,
    Math.min(50, Math.max(1, limit)),
  )
  return rows.map(mapProfileRow)
}

export async function getNextProfileVersion(db: PluginDB, groupId: string): Promise<number> {
  const row = await db.first<{ max_v: number | null }>(
    'SELECT MAX(version) AS max_v FROM {style_profiles} WHERE group_id = ?',
    groupId,
  )
  return (row?.max_v ?? 0) + 1
}

export async function insertStyleProfile(db: PluginDB, profile: StyleProfileRecord): Promise<void> {
  await db.run(
    `INSERT INTO {style_profiles}
      (profile_id, group_id, version, status, stable_style_json, recent_style_json, behavior_profile_json,
       evidence_count, distinct_senders, confidence, source_window_start, source_window_end,
       source_corpus_ids_json, contains_deleted_data, notes, created_at, published_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    profile.profileId,
    profile.groupId,
    profile.version,
    profile.status,
    JSON.stringify(profile.stableStyle),
    JSON.stringify(profile.recentStyle),
    JSON.stringify(profile.behaviorProfile),
    profile.evidenceCount,
    profile.distinctSenders,
    profile.confidence,
    profile.sourceWindowStart,
    profile.sourceWindowEnd,
    JSON.stringify(profile.sourceCorpusIds.slice(0, 500)),
    profile.containsDeletedData ? 1 : 0,
    profile.notes,
    profile.createdAt,
    profile.publishedAt,
  )
}

export async function updateStyleProfileStatus(
  db: PluginDB,
  profileId: string,
  status: StyleProfileStatus,
  publishedAt?: number,
): Promise<void> {
  if (publishedAt !== undefined) {
    await db.run(
      'UPDATE {style_profiles} SET status = ?, published_at = ? WHERE profile_id = ?',
      status,
      publishedAt,
      profileId,
    )
  } else {
    await db.run('UPDATE {style_profiles} SET status = ? WHERE profile_id = ?', status, profileId)
  }
}

export async function updateStyleProfileContent(
  db: PluginDB,
  profileId: string,
  patch: {
    stableStyle?: StyleProfileRecord['stableStyle']
    recentStyle?: StyleProfileRecord['recentStyle']
    behaviorProfile?: StyleProfileRecord['behaviorProfile']
    notes?: string
  },
): Promise<boolean> {
  const cur = await getStyleProfileById(db, profileId)
  if (!cur) return false
  const stable = patch.stableStyle ? validateStyleLayer(patch.stableStyle, cur.stableStyle) : cur.stableStyle
  const recent = patch.recentStyle ? validateStyleLayer(patch.recentStyle, cur.recentStyle) : cur.recentStyle
  const behavior = patch.behaviorProfile ? validateBehaviorProfile(patch.behaviorProfile, cur.behaviorProfile) : cur.behaviorProfile
  await db.run(
    `UPDATE {style_profiles}
     SET stable_style_json = ?, recent_style_json = ?, behavior_profile_json = ?, notes = ?
     WHERE profile_id = ?`,
    JSON.stringify(stable),
    JSON.stringify(recent),
    JSON.stringify(behavior),
    patch.notes ?? cur.notes,
    profileId,
  )
  return true
}

// ---- 群内热梗知识库 ----

function mapMemeRow(r: Record<string, unknown>): GroupMemeRecord {
  return {
    memeId: String(r.meme_id),
    groupId: String(r.group_id),
    name: String(r.name),
    category: String(r.category) as GroupMemeRecord['category'],
    meaning: String(r.meaning),
    aliases: safeJsonParse<string[]>(String(r.aliases_json ?? '[]'), []),
    examplePatterns: safeJsonParse<string[]>(String(r.example_patterns_json ?? '[]'), []),
    applicableContext: String(r.applicable_context ?? ''),
    inappropriateContext: String(r.inappropriate_context ?? ''),
    sourceCorpusIds: safeJsonParse<string[]>(String(r.source_corpus_ids_json ?? '[]'), []),
    firstSeenAt: Number(r.first_seen_at),
    lastSeenAt: Number(r.last_seen_at),
    occurrenceCount: Number(r.occurrence_count),
    distinctSenderCount: Number(r.distinct_sender_count),
    confidence: Number(r.confidence),
    popularityWeight: Number(r.popularity_weight),
    decayWeight: Number(r.decay_weight),
    status: String(r.status) as GroupMemeStatus,
    updatedAt: Number(r.updated_at),
  }
}

export async function upsertGroupMeme(db: PluginDB, meme: GroupMemeRecord): Promise<void> {
  await db.run(
    `INSERT INTO {group_memes}
      (meme_id, group_id, name, category, meaning, aliases_json, example_patterns_json,
       applicable_context, inappropriate_context, source_corpus_ids_json,
       first_seen_at, last_seen_at, occurrence_count, distinct_sender_count,
       confidence, popularity_weight, decay_weight, status, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(meme_id) DO UPDATE SET
       meaning = excluded.meaning,
       aliases_json = excluded.aliases_json,
       example_patterns_json = excluded.example_patterns_json,
       applicable_context = excluded.applicable_context,
       inappropriate_context = excluded.inappropriate_context,
       source_corpus_ids_json = excluded.source_corpus_ids_json,
       last_seen_at = excluded.last_seen_at,
       occurrence_count = excluded.occurrence_count,
       distinct_sender_count = excluded.distinct_sender_count,
       confidence = excluded.confidence,
       popularity_weight = excluded.popularity_weight,
       decay_weight = excluded.decay_weight,
       status = excluded.status,
       updated_at = excluded.updated_at`,
    meme.memeId,
    meme.groupId,
    meme.name,
    meme.category,
    meme.meaning,
    JSON.stringify(meme.aliases),
    JSON.stringify(meme.examplePatterns),
    meme.applicableContext,
    meme.inappropriateContext,
    JSON.stringify(meme.sourceCorpusIds.slice(0, 100)),
    meme.firstSeenAt,
    meme.lastSeenAt,
    meme.occurrenceCount,
    meme.distinctSenderCount,
    meme.confidence,
    meme.popularityWeight,
    meme.decayWeight,
    meme.status,
    meme.updatedAt,
  )
}

export async function listGroupMemes(
  db: PluginDB,
  groupId: string,
  opts?: { status?: GroupMemeStatus | 'all'; limit?: number },
): Promise<GroupMemeRecord[]> {
  const limit = Math.min(100, Math.max(1, opts?.limit ?? 40))
  const rows =
    opts?.status && opts.status !== 'all'
      ? await db.all<Record<string, unknown>>(
          'SELECT * FROM {group_memes} WHERE group_id = ? AND status = ? ORDER BY popularity_weight DESC, last_seen_at DESC LIMIT ?',
          groupId,
          opts.status,
          limit,
        )
      : await db.all<Record<string, unknown>>(
          'SELECT * FROM {group_memes} WHERE group_id = ? ORDER BY popularity_weight DESC, last_seen_at DESC LIMIT ?',
          groupId,
          limit,
        )
  return rows.map(mapMemeRow)
}

export async function deleteGroupMeme(db: PluginDB, groupId: string, memeId: string): Promise<boolean> {
  const res = await db.run('DELETE FROM {group_memes} WHERE group_id = ? AND meme_id = ?', groupId, memeId)
  return res.changes > 0
}

// ---- 高质量对话样本库 ----

function mapExampleRow(r: Record<string, unknown>): DialogueExampleRecord {
  return {
    exampleId: String(r.example_id),
    groupId: String(r.group_id),
    contextMessages: safeJsonParse<Array<{ speaker: string; text: string }>>(String(r.context_json ?? '[]'), []),
    targetResponse: String(r.target_response),
    topicTags: safeJsonParse<string[]>(String(r.topic_tags_json ?? '[]'), []),
    intentTags: safeJsonParse<string[]>(String(r.intent_tags_json ?? '[]'), []),
    emotion: String(r.emotion ?? 'neutral'),
    dialogueBehavior: String(r.dialogue_behavior ?? 'casual') as DialogueExampleRecord['dialogueBehavior'],
    humorType: String(r.humor_type ?? 'none'),
    styleFeatures: safeJsonParse<string[]>(String(r.style_features_json ?? '[]'), []),
    searchTokens: String(r.search_tokens ?? ''),
    qualityScore: Number(r.quality_score),
    confidence: Number(r.confidence),
    sourceCorpusIds: safeJsonParse<string[]>(String(r.source_corpus_ids_json ?? '[]'), []),
    status: String(r.status ?? 'active') as 'active' | 'excluded',
    createdAt: Number(r.created_at),
    expiresAt: Number(r.expires_at),
  }
}

export async function insertDialogueExamples(db: PluginDB, examples: readonly DialogueExampleRecord[]): Promise<void> {
  if (examples.length === 0) return
  for (let i = 0; i < examples.length; i += 20) {
    const slice = examples.slice(i, i + 20)
    await db.batch(
      slice.map((e) => ({
        sql: `INSERT OR REPLACE INTO {dialogue_examples}
          (example_id, group_id, context_json, target_response, topic_tags_json, intent_tags_json,
           emotion, dialogue_behavior, humor_type, style_features_json, search_tokens,
           quality_score, confidence, source_corpus_ids_json, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          e.exampleId,
          e.groupId,
          JSON.stringify(e.contextMessages),
          e.targetResponse,
          JSON.stringify(e.topicTags),
          JSON.stringify(e.intentTags),
          e.emotion,
          e.dialogueBehavior,
          e.humorType,
          JSON.stringify(e.styleFeatures),
          e.searchTokens,
          e.qualityScore,
          e.confidence,
          JSON.stringify(e.sourceCorpusIds),
          e.status,
          e.createdAt,
          e.expiresAt,
        ],
      })),
    )
  }
}

export async function listDialogueExamples(
  db: PluginDB,
  groupId: string,
  opts?: { activeOnly?: boolean; limit?: number; now?: number },
): Promise<DialogueExampleRecord[]> {
  const limit = Math.min(120, Math.max(1, opts?.limit ?? 60))
  const now = opts?.now ?? Date.now()
  const rows = opts?.activeOnly
    ? await db.all<Record<string, unknown>>(
        `SELECT * FROM {dialogue_examples}
         WHERE group_id = ? AND status = 'active' AND (expires_at = 0 OR expires_at > ?)
         ORDER BY quality_score DESC, created_at DESC LIMIT ?`,
        groupId,
        now,
        limit,
      )
    : await db.all<Record<string, unknown>>(
        'SELECT * FROM {dialogue_examples} WHERE group_id = ? ORDER BY quality_score DESC, created_at DESC LIMIT ?',
        groupId,
        limit,
      )
  return rows.map(mapExampleRow)
}

export async function updateDialogueExampleStatus(
  db: PluginDB,
  groupId: string,
  exampleId: string,
  status: 'active' | 'excluded',
): Promise<boolean> {
  const res = await db.run(
    'UPDATE {dialogue_examples} SET status = ? WHERE group_id = ? AND example_id = ?',
    status,
    groupId,
    exampleId,
  )
  return res.changes > 0
}

export async function deleteDialogueExample(db: PluginDB, groupId: string, exampleId: string): Promise<boolean> {
  const res = await db.run('DELETE FROM {dialogue_examples} WHERE group_id = ? AND example_id = ?', groupId, exampleId)
  return res.changes > 0
}

// ---- 学习任务、反馈、用量与审计 ----

export async function upsertLearningJob(db: PluginDB, job: LearningJobRecord): Promise<void> {
  await db.run(
    `INSERT INTO {learning_jobs}
      (job_id, group_id, trigger_type, status, checkpoint_cursor, processed_count, retry_count, lease_until, candidate_profile_id, error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(job_id) DO UPDATE SET
      status = excluded.status,
      checkpoint_cursor = excluded.checkpoint_cursor,
      processed_count = excluded.processed_count,
      retry_count = excluded.retry_count,
      lease_until = excluded.lease_until,
      candidate_profile_id = excluded.candidate_profile_id,
      error = excluded.error,
      updated_at = excluded.updated_at`,
    job.jobId,
    job.groupId,
    job.triggerType,
    job.status,
    job.checkpointCursor,
    job.processedCount,
    job.retryCount,
    job.leaseUntil,
    job.candidateProfileId,
    job.error,
    job.createdAt,
    job.updatedAt,
  )
}

export async function getActiveRunningJob(db: PluginDB, groupId: string, now: number): Promise<LearningJobRecord | null> {
  const row = await db.first<Record<string, unknown>>(
    `SELECT * FROM {learning_jobs}
     WHERE group_id = ? AND status = 'running' AND lease_until > ?
     ORDER BY updated_at DESC LIMIT 1`,
    groupId,
    now,
  )
  if (!row) return null
  return {
    jobId: String(row.job_id),
    groupId: String(row.group_id),
    triggerType: String(row.trigger_type) as LearningJobRecord['triggerType'],
    status: String(row.status) as LearningJobRecord['status'],
    checkpointCursor: Number(row.checkpoint_cursor),
    processedCount: Number(row.processed_count),
    retryCount: Number(row.retry_count),
    leaseUntil: Number(row.lease_until),
    candidateProfileId: String(row.candidate_profile_id ?? ''),
    error: String(row.error ?? ''),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

export async function listRecentLearningJobs(db: PluginDB, groupId: string, limit = 15): Promise<LearningJobRecord[]> {
  const rows = await db.all<Record<string, unknown>>(
    'SELECT * FROM {learning_jobs} WHERE group_id = ? ORDER BY created_at DESC LIMIT ?',
    groupId,
    Math.min(50, Math.max(1, limit)),
  )
  return rows.map((row) => ({
    jobId: String(row.job_id),
    groupId: String(row.group_id),
    triggerType: String(row.trigger_type) as LearningJobRecord['triggerType'],
    status: String(row.status) as LearningJobRecord['status'],
    checkpointCursor: Number(row.checkpoint_cursor),
    processedCount: Number(row.processed_count),
    retryCount: Number(row.retry_count),
    leaseUntil: Number(row.lease_until),
    candidateProfileId: String(row.candidate_profile_id ?? ''),
    error: String(row.error ?? ''),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }))
}

export async function insertLearningFeedback(db: PluginDB, rec: LearningFeedbackRecord): Promise<void> {
  await db.run(
    `INSERT INTO {learning_feedback}
      (feedback_id, group_id, profile_id, mode, context_excerpt, bot_reply, rating, note, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    rec.feedbackId,
    rec.groupId,
    rec.profileId,
    rec.mode,
    rec.contextExcerpt.slice(0, 400),
    rec.botReply.slice(0, 400),
    rec.rating,
    rec.note.slice(0, 200),
    rec.source,
    rec.createdAt,
  )
}

export async function listLearningFeedback(
  db: PluginDB,
  groupId: string,
  limit = 30,
): Promise<LearningFeedbackRecord[]> {
  const rows = await db.all<Record<string, unknown>>(
    'SELECT * FROM {learning_feedback} WHERE group_id = ? ORDER BY created_at DESC LIMIT ?',
    groupId,
    Math.min(100, Math.max(1, limit)),
  )
  return rows.map((r) => ({
    feedbackId: String(r.feedback_id),
    groupId: String(r.group_id),
    profileId: String(r.profile_id ?? ''),
    mode: String(r.mode ?? 'live'),
    contextExcerpt: String(r.context_excerpt ?? ''),
    botReply: String(r.bot_reply ?? ''),
    rating: String(r.rating) as LearningFeedbackRecord['rating'],
    note: String(r.note ?? ''),
    source: String(r.source ?? 'admin') as LearningFeedbackRecord['source'],
    createdAt: Number(r.created_at),
  }))
}

export async function recordLearningUsage(
  db: PluginDB,
  delta: { runs?: number; inputTokens?: number; outputTokens?: number; completed?: number; failed?: number },
  now = Date.now(),
): Promise<void> {
  const day = dayKey(now)
  await db.run(
    `INSERT INTO {learning_usage_stats} (day, runs, input_tokens, output_tokens, jobs_completed, jobs_failed, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(day) DO UPDATE SET
      runs = runs + excluded.runs,
      input_tokens = input_tokens + excluded.input_tokens,
      output_tokens = output_tokens + excluded.output_tokens,
      jobs_completed = jobs_completed + excluded.jobs_completed,
      jobs_failed = jobs_failed + excluded.jobs_failed,
      updated_at = excluded.updated_at`,
    day,
    delta.runs ?? 0,
    delta.inputTokens ?? 0,
    delta.outputTokens ?? 0,
    delta.completed ?? 0,
    delta.failed ?? 0,
    now,
  )
}

export async function getTodayLearningRuns(db: PluginDB, now = Date.now()): Promise<number> {
  const row = await db.first<{ runs: number }>('SELECT runs FROM {learning_usage_stats} WHERE day = ?', dayKey(now))
  return row?.runs ?? 0
}

export async function listLearningUsage(db: PluginDB, days = 7): Promise<LearningUsageDay[]> {
  const rows = await db.all<{
    day: string
    runs: number
    input_tokens: number
    output_tokens: number
    jobs_completed: number
    jobs_failed: number
  }>('SELECT * FROM {learning_usage_stats} ORDER BY day DESC LIMIT ?', Math.min(30, Math.max(1, days)))
  return rows.map((r) => ({
    day: r.day,
    runs: r.runs,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    jobsCompleted: r.jobs_completed,
    jobsFailed: r.jobs_failed,
  }))
}

export async function insertLearningAudit(
  db: PluginDB,
  groupId: string,
  action: string,
  actor: string,
  detail: string,
  now = Date.now(),
): Promise<void> {
  await db.run(
    'INSERT INTO {learning_audit_logs} (id, group_id, action, actor, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    `aud_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
    groupId,
    action,
    actor,
    detail.slice(0, 300),
    now,
  )
}

export async function listLearningAudits(db: PluginDB, groupId: string, limit = 20): Promise<LearningAuditLog[]> {
  const rows = await db.all<{
    id: string
    group_id: string
    action: string
    actor: string
    detail: string
    created_at: number
  }>('SELECT * FROM {learning_audit_logs} WHERE group_id = ? ORDER BY created_at DESC LIMIT ?', groupId, limit)
  return rows.map((r) => ({
    id: r.id,
    groupId: r.group_id,
    action: r.action,
    actor: r.actor,
    detail: r.detail,
    createdAt: r.created_at,
  }))
}

export async function purgeGroupLearningData(db: PluginDB, groupId: string): Promise<void> {
  await db.batch([
    { sql: 'DELETE FROM {learning_corpus} WHERE group_id = ?', params: [groupId] },
    { sql: 'DELETE FROM {learning_sources} WHERE group_id = ?', params: [groupId] },
    { sql: 'DELETE FROM {learning_jobs} WHERE group_id = ?', params: [groupId] },
    { sql: 'DELETE FROM {style_profiles} WHERE group_id = ?', params: [groupId] },
    { sql: 'DELETE FROM {group_memes} WHERE group_id = ?', params: [groupId] },
    { sql: 'DELETE FROM {dialogue_examples} WHERE group_id = ?', params: [groupId] },
    { sql: 'DELETE FROM {learning_feedback} WHERE group_id = ?', params: [groupId] },
  ])
}
