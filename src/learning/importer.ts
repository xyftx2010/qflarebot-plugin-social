import type { PluginDB } from '@qqbot/sdk'
import type { CorpusRecord, LearningSourceType } from './types.js'
import { anonymizeSenderId, computeContentHash, evaluateAndCleanCorpus } from './cleaner.js'
import { hasCorpusContentHash, insertCorpusBatch, upsertLearningSource } from '../store/learning-db.js'

export interface RawImportRow {
  sender: string
  content: string
  timestamp: number
  messageId?: string
  replyTo?: string
  mentions?: string[]
  isBot?: boolean
}

export interface ImportFieldMapping {
  sender?: string
  content?: string
  timestamp?: string
  messageId?: string
  replyTo?: string
  isBot?: string
}

export interface ParseCorpusOptions {
  format: 'txt' | 'csv' | 'json' | 'jsonl'
  rawText: string
  mapping?: ImportFieldMapping
  timezoneOffsetMinutes?: number
  defaultNow?: number
}

function parseTimestamp(value: unknown, tzOffsetMin: number, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? Math.floor(value) : Math.floor(value * 1000)
  }
  const str = String(value ?? '').trim()
  if (!str) return fallback
  if (/^\d{10,13}$/.test(str)) {
    const n = Number(str)
    return n > 1e12 ? n : n * 1000
  }
  // 支持常见 YYYY-MM-DD HH:mm:ss 或 YYYY/MM/DD HH:mm:ss（按指定时区偏移转换）
  const m = str.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/)
  if (m) {
    const utcMs = Date.UTC(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4]),
      Number(m[5]),
      Number(m[6] ?? '0'),
    )
    return utcMs - tzOffsetMin * 60_000
  }
  const parsed = Date.parse(str)
  return Number.isFinite(parsed) ? parsed : fallback
}

function parseCsvLine(line: string): string[] {
  const cols: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"'
        i += 1
      } else {
        inQuotes = !inQuotes
      }
    } else if (ch === ',' && !inQuotes) {
      cols.push(cur.trim())
      cur = ''
    } else {
      cur += ch
    }
  }
  cols.push(cur.trim())
  return cols
}

function extractMentions(text: string): string[] {
  const matches = text.match(/@[\u4e00-\u9fa5a-zA-Z0-9_-]{1,24}/g) ?? []
  return [...new Set(matches)].slice(0, 8)
}

function mapObjectRow(
  obj: Record<string, unknown>,
  mapping: ImportFieldMapping | undefined,
  tzOffsetMin: number,
  fallbackTs: number,
): RawImportRow | null {
  const senderKey = mapping?.sender || 'sender'
  const contentKey = mapping?.content || 'content'
  const tsKey = mapping?.timestamp || 'timestamp'
  const idKey = mapping?.messageId || 'message_id'
  const replyKey = mapping?.replyTo || 'reply_to'
  const botKey = mapping?.isBot || 'is_bot'

  const sender = String(
    obj[senderKey] ?? obj.sender ?? obj.user ?? obj.author ?? obj.nickname ?? obj.user_id ?? obj.uid ?? 'anon',
  ).trim()
  const content = String(obj[contentKey] ?? obj.content ?? obj.text ?? obj.message ?? obj.msg ?? '').trim()
  if (!content) return null
  const tsRaw = obj[tsKey] ?? obj.timestamp ?? obj.time ?? obj.date ?? obj.created_at
  const timestamp = parseTimestamp(tsRaw, tzOffsetMin, fallbackTs)
  const messageId = String(obj[idKey] ?? obj.id ?? obj.msg_id ?? '').trim()
  const replyTo = String(obj[replyKey] ?? obj.replyTo ?? '').trim()
  const isBotRaw = obj[botKey] ?? obj.bot ?? obj.isBot
  const isBot = isBotRaw === true || isBotRaw === 'true' || isBotRaw === 1

  return {
    sender,
    content,
    timestamp,
    messageId: messageId || undefined,
    replyTo: replyTo || undefined,
    mentions: extractMentions(content),
    isBot,
  }
}

/**
 * 解析 TXT（含 QQ 标准导出格式）、CSV、JSON、JSONL 四种语料格式。
 */
export function parseCorpusText(opts: ParseCorpusOptions): RawImportRow[] {
  const tzOffsetMin = opts.timezoneOffsetMinutes ?? 480 // 默认东八区 UTC+8
  const baseTs = opts.defaultNow ?? Date.now()
  const cleanText = opts.rawText.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  const rows: RawImportRow[] = []

  if (opts.format === 'json') {
    const parsed: unknown = JSON.parse(cleanText)
    const arr = Array.isArray(parsed)
      ? parsed
      : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { messages?: unknown }).messages)
        ? (parsed as { messages: unknown[] }).messages
        : []
    for (let i = 0; i < arr.length; i += 1) {
      const item = arr[i]
      if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
        const mapped = mapObjectRow(item as Record<string, unknown>, opts.mapping, tzOffsetMin, baseTs - (arr.length - i) * 1000)
        if (mapped) rows.push(mapped)
      }
    }
    return rows
  }

  if (opts.format === 'jsonl') {
    const lines = cleanText.split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]?.trim()
      if (!line) continue
      try {
        const item: unknown = JSON.parse(line)
        if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
          const mapped = mapObjectRow(item as Record<string, unknown>, opts.mapping, tzOffsetMin, baseTs - (lines.length - i) * 1000)
          if (mapped) rows.push(mapped)
        }
      } catch {
        // 跳过坏行
      }
    }
    return rows
  }

  if (opts.format === 'csv') {
    const lines = cleanText.split('\n').filter((l) => l.trim().length > 0)
    if (lines.length < 2) return []
    const headers = parseCsvLine(lines[0] ?? '')
    for (let i = 1; i < lines.length; i += 1) {
      const cols = parseCsvLine(lines[i] ?? '')
      const obj: Record<string, string> = {}
      headers.forEach((h, idx) => {
        obj[h] = cols[idx] ?? ''
      })
      const mapped = mapObjectRow(obj, opts.mapping, tzOffsetMin, baseTs - (lines.length - i) * 1000)
      if (mapped) rows.push(mapped)
    }
    return rows
  }

  // TXT：支持 QQ 导出格式 `2026-10-01 12:34:56 昵称(123456)\n内容` 以及单行 `[2026-10-01 12:34:56] 昵称: 内容`
  const lines = cleanText.split('\n')
  const qqHeaderRe = /^(\d{4}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?)\s+(.+?)(?:\((\d+|[^)]+)\))?$/
  const inlineRe = /^\[?(\d{4}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?)\]?\s+([^:：]{1,32})[:：]\s*(.+)$/

  let pendingHeader: { sender: string; timestamp: number } | null = null
  let pendingLines: string[] = []

  const flushPending = () => {
    if (!pendingHeader) return
    const content = pendingLines.join(' ').trim()
    if (content) {
      rows.push({
        sender: pendingHeader.sender,
        content,
        timestamp: pendingHeader.timestamp,
        mentions: extractMentions(content),
      })
    }
    pendingHeader = null
    pendingLines = []
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) {
      flushPending()
      continue
    }
    const inlineMatch = line.match(inlineRe)
    if (inlineMatch) {
      flushPending()
      const ts = parseTimestamp(inlineMatch[1], tzOffsetMin, baseTs)
      const sender = (inlineMatch[2] ?? 'anon').trim()
      const content = (inlineMatch[3] ?? '').trim()
      if (content) {
        rows.push({ sender, content, timestamp: ts, mentions: extractMentions(content) })
      }
      continue
    }
    const headerMatch = line.match(qqHeaderRe)
    if (headerMatch) {
      flushPending()
      const ts = parseTimestamp(headerMatch[1], tzOffsetMin, baseTs)
      const sender = (headerMatch[3] || headerMatch[2] || 'anon').trim()
      pendingHeader = { sender, timestamp: ts }
      continue
    }
    if (pendingHeader) {
      pendingLines.push(line)
    }
  }
  flushPending()
  return rows
}

export interface ImportChunkInput {
  db: PluginDB
  groupId: string
  sourceId?: string
  format: 'txt' | 'csv' | 'json' | 'jsonl'
  label?: string
  rawText?: string
  rows?: RawImportRow[]
  mapping?: ImportFieldMapping
  timezoneOffsetMinutes?: number
  blockedKeywords?: string
  retentionDays: number
  excludeBotMessages: boolean
  now?: number
}

export interface ImportChunkResult {
  sourceId: string
  totalRows: number
  acceptedRows: number
  skippedRows: number
  duplicateRows: number
  skipReasons: Record<string, number>
  preview: Array<{ sender: string; content: string; qualityScore: number; status: string }>
}

/**
 * 分块导入语料：执行脱敏、过滤、评分、匿名化与跨来源去重后落库。
 * 历史导入记录仅写入 `{learning_corpus}`，绝不触发实时 QQ 群回复。
 */
export async function importCorpusChunk(input: ImportChunkInput): Promise<ImportChunkResult> {
  const now = input.now ?? Date.now()
  const sourceId = input.sourceId || `src_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
  const sourceType = `import_${input.format}` as LearningSourceType
  const parsedRows =
    input.rows ??
    parseCorpusText({
      format: input.format,
      rawText: input.rawText ?? '',
      mapping: input.mapping,
      timezoneOffsetMinutes: input.timezoneOffsetMinutes,
      defaultNow: now,
    })

  // 单次分块上限 500 条，避免 Worker 内存或 D1 子请求超限
  const boundedRows = parsedRows.slice(0, 500)
  const retentionMs = Math.max(1, Math.min(180, input.retentionDays || 30)) * 86_400_000
  const expiresAt = now + retentionMs

  const records: CorpusRecord[] = []
  const localHashes = new Set<string>()
  const skipReasons: Record<string, number> = {}
  let duplicateRows = 0
  const preview: Array<{ sender: string; content: string; qualityScore: number; status: string }> = []

  for (let i = 0; i < boundedRows.length; i += 1) {
    const row = boundedRows[i]!
    const hasNeighbor =
      (i > 0 && Math.abs(row.timestamp - (boundedRows[i - 1]?.timestamp ?? 0)) <= 120_000) ||
      (i + 1 < boundedRows.length && Math.abs((boundedRows[i + 1]?.timestamp ?? 0) - row.timestamp) <= 120_000)

    const evalRes = evaluateAndCleanCorpus({
      rawContent: row.content,
      senderIsBot: input.excludeBotMessages && Boolean(row.isBot),
      blockedKeywords: input.blockedKeywords,
      hasContextNeighbor: hasNeighbor,
      timestamp: row.timestamp,
      now,
    })

    if (!evalRes.accepted) {
      skipReasons[evalRes.reason] = (skipReasons[evalRes.reason] ?? 0) + 1
      continue
    }

    const contentHash = await computeContentHash(input.groupId, evalRes.cleanedContent, row.timestamp)
    if (localHashes.has(contentHash) || (await hasCorpusContentHash(input.db, input.groupId, contentHash))) {
      duplicateRows += 1
      skipReasons.duplicate = (skipReasons.duplicate ?? 0) + 1
      continue
    }
    localHashes.add(contentHash)

    const pseudoSender = await anonymizeSenderId(input.groupId, row.sender)
    const rec: CorpusRecord = {
      corpusId: `cor_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`,
      groupId: input.groupId,
      sourceId,
      sourceType,
      pseudonymousSenderId: pseudoSender,
      messageId: row.messageId ?? '',
      timestamp: row.timestamp,
      messageType: 'text',
      content: evalRes.cleanedContent,
      replyTo: row.replyTo ?? '',
      mentions: row.mentions ?? [],
      consentStatus: 'authorized',
      contentHash,
      qualityScore: evalRes.qualityScore,
      learningStatus: evalRes.learningStatus,
      createdAt: now,
      expiresAt,
    }
    records.push(rec)
    if (preview.length < 10) {
      preview.push({
        sender: pseudoSender,
        content: rec.content,
        qualityScore: rec.qualityScore,
        status: rec.learningStatus,
      })
    }
  }

  if (records.length > 0) {
    await insertCorpusBatch(input.db, records)
  }

  const skippedRows = boundedRows.length - records.length
  await upsertLearningSource(input.db, {
    sourceId,
    groupId: input.groupId,
    sourceType,
    label: input.label || `${input.format.toUpperCase()} 导入`,
    consentStatus: 'authorized',
    totalRows: boundedRows.length,
    acceptedRows: records.length,
    skippedRows,
    status: 'completed',
    errorSummary: '',
    createdAt: now,
    updatedAt: now,
  })

  return {
    sourceId,
    totalRows: boundedRows.length,
    acceptedRows: records.length,
    skippedRows,
    duplicateRows,
    skipReasons,
    preview,
  }
}
