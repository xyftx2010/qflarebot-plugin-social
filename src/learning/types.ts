export type LearningSourceType = 'import_txt' | 'import_csv' | 'import_json' | 'import_jsonl' | 'online'
export type CorpusLearningStatus = 'pending' | 'processed' | 'excluded' | 'review'
export type StyleProfileStatus = 'candidate' | 'published' | 'frozen' | 'archived' | 'rejected' | 'invalidated'
export type GroupMemeStatus = 'candidate' | 'active' | 'inactive' | 'blocked' | 'archived'
export type GroupMemeCategory = 'public_meme' | 'group_exclusive' | 'history_derived' | 'temporary'
export type DialogueBehaviorType =
  | 'casual'
  | 'humor_banter'
  | 'sarcasm_roast'
  | 'comfort'
  | 'meme_chain'
  | 'normal_qa'
  | 'short_ack'
  | 'silence'
  | 'showoff_reply'
  | 'complaint_reply'

export interface LearningGroupSettings {
  groupId: string
  authorized: boolean
  freezeStable: boolean
  stableWeight?: number | null
  recentWeight?: number | null
  influenceStrength?: number | null
  retentionDays?: number | null
  autoPublish?: boolean | null
  updatedAt: number
}

export interface LearningSourceRecord {
  sourceId: string
  groupId: string
  sourceType: LearningSourceType
  label: string
  consentStatus: 'authorized' | 'revoked'
  totalRows: number
  acceptedRows: number
  skippedRows: number
  status: 'importing' | 'paused' | 'completed' | 'failed'
  errorSummary: string
  createdAt: number
  updatedAt: number
}

export interface CorpusRecord {
  corpusId: string
  groupId: string
  sourceId: string
  sourceType: LearningSourceType
  pseudonymousSenderId: string
  messageId: string
  timestamp: number
  messageType: 'text' | 'image_caption' | 'mixed'
  content: string
  replyTo: string
  mentions: string[]
  consentStatus: 'authorized' | 'opted_out'
  contentHash: string
  qualityScore: number
  learningStatus: CorpusLearningStatus
  createdAt: number
  expiresAt: number
}

export interface StyleLayerProfile {
  primaryLanguage: string
  colloquialLevel: 'low' | 'medium' | 'high'
  avgMessageLength: number
  lengthDistribution: { shortPct: number; mediumPct: number; longPct: number }
  vocabulary: string[]
  sentencePatterns: string[]
  modalParticles: string[]
  punctuationHabits: string[]
  humorPatterns: string[]
  ironyPatterns: string[]
  responseHabits: string[]
  avoidPatterns: string[]
  toneSummary: string
  voiceMoodHints: string[]
}

export interface DialogueBehaviorProfile {
  banterStrategy: string
  memeUsageRule: string
  roastAndIronyRule: string
  comfortStrategy: string
  showoffAndComplaintRule: string
  seriousTopicBoundary: string
  alreadyAnsweredRule: string
  conversationEndSignals: string[]
  interactionBoundaries: string[]
}

export interface StyleProfileRecord {
  profileId: string
  groupId: string
  version: number
  status: StyleProfileStatus
  stableStyle: StyleLayerProfile
  recentStyle: StyleLayerProfile
  behaviorProfile: DialogueBehaviorProfile
  evidenceCount: number
  distinctSenders: number
  confidence: number
  sourceWindowStart: number
  sourceWindowEnd: number
  sourceCorpusIds: string[]
  containsDeletedData: boolean
  notes: string
  createdAt: number
  publishedAt: number
}

export interface GroupMemeRecord {
  memeId: string
  groupId: string
  name: string
  category: GroupMemeCategory
  meaning: string
  aliases: string[]
  examplePatterns: string[]
  applicableContext: string
  inappropriateContext: string
  sourceCorpusIds: string[]
  firstSeenAt: number
  lastSeenAt: number
  occurrenceCount: number
  distinctSenderCount: number
  confidence: number
  popularityWeight: number
  decayWeight: number
  status: GroupMemeStatus
  updatedAt: number
}

export interface DialogueExampleRecord {
  exampleId: string
  groupId: string
  contextMessages: Array<{ speaker: string; text: string }>
  targetResponse: string
  topicTags: string[]
  intentTags: string[]
  emotion: string
  dialogueBehavior: DialogueBehaviorType
  humorType: string
  styleFeatures: string[]
  searchTokens: string
  qualityScore: number
  confidence: number
  sourceCorpusIds: string[]
  status: 'active' | 'excluded'
  createdAt: number
  expiresAt: number
}

export interface LearningJobRecord {
  jobId: string
  groupId: string
  triggerType: 'cron' | 'manual' | 'import'
  status: 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'
  checkpointCursor: number
  processedCount: number
  retryCount: number
  leaseUntil: number
  candidateProfileId: string
  error: string
  createdAt: number
  updatedAt: number
}

export interface LearningFeedbackRecord {
  feedbackId: string
  groupId: string
  profileId: string
  mode: string
  contextExcerpt: string
  botReply: string
  rating: 'good' | 'unnatural' | 'bad' | 'meme_fail' | 'repetitive' | 'implicit_follow'
  note: string
  source: 'admin' | 'member' | 'implicit' | 'lab'
  createdAt: number
}

export interface LearningUsageDay {
  day: string
  runs: number
  inputTokens: number
  outputTokens: number
  jobsCompleted: number
  jobsFailed: number
}

export interface LearningAuditLog {
  id: string
  groupId: string
  action: string
  actor: string
  detail: string
  createdAt: number
}

export function createEmptyStyleLayer(): StyleLayerProfile {
  return {
    primaryLanguage: 'zh-CN',
    colloquialLevel: 'medium',
    avgMessageLength: 14,
    lengthDistribution: { shortPct: 0.45, mediumPct: 0.45, longPct: 0.1 },
    vocabulary: [],
    sentencePatterns: [],
    modalParticles: [],
    punctuationHabits: [],
    humorPatterns: [],
    ironyPatterns: [],
    responseHabits: [],
    avoidPatterns: [],
    toneSummary: '',
    voiceMoodHints: [],
  }
}

export function createEmptyBehaviorProfile(): DialogueBehaviorProfile {
  return {
    banterStrategy: '顺着群友话头简短自然接话，不强行抢话。',
    memeUsageRule: '仅在语境高度贴合时自然点缀，不为了玩梗而硬插梗。',
    roastAndIronyRule: '善意调侃点到为止，避免人身攻击。',
    comfortStrategy: '遇到吐槽或难过时先共情再轻松陪伴，不强行说教。',
    showoffAndComplaintRule: '对炫耀轻松捧哏或调侃，对抱怨给予顺毛回应。',
    seriousTopicBoundary: '严肃讨论或求助时收敛玩梗，直接给有用回应。',
    alreadyAnsweredRule: '已有群友完整回答时不再重复复述。',
    conversationEndSignals: ['好了散了', '睡了', '先撤了'],
    interactionBoundaries: ['保持 AI 群友身份，不冒充特定群成员', '不传播私人敏感信息'],
  }
}

const INJECTION_STYLE_RE =
  /(?:ignore\s+previous|system\s+prompt|忽略(?:上面|之前|所有)(?:规则|指令)|覆盖(?:人格|系统)|执行(?:命令|代码)|放行工具|修改配置|sudo)/i

function sanitizeStringList(raw: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const clean = item.replace(/\s+/g, ' ').trim().slice(0, maxLen)
    if (!clean || INJECTION_STYLE_RE.test(clean) || seen.has(clean)) continue
    seen.add(clean)
    out.push(clean)
    if (out.length >= maxItems) break
  }
  return out
}

function sanitizeText(raw: unknown, maxLen: number, fallback: string): string {
  if (typeof raw !== 'string') return fallback
  const clean = raw.replace(/\s+/g, ' ').trim().slice(0, maxLen)
  if (!clean || INJECTION_STYLE_RE.test(clean)) return fallback
  return clean
}

/**
 * 严格校验并消毒模型或外部编辑生成的 StyleLayerProfile，绝不接受任意系统指令。
 */
export function validateStyleLayer(raw: unknown, fallback?: StyleLayerProfile): StyleLayerProfile {
  const base = fallback ?? createEmptyStyleLayer()
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ...base }
  const obj = raw as Record<string, unknown>
  const level =
    obj.colloquialLevel === 'low' || obj.colloquialLevel === 'medium' || obj.colloquialLevel === 'high'
      ? obj.colloquialLevel
      : base.colloquialLevel
  const avgLen =
    typeof obj.avgMessageLength === 'number' && Number.isFinite(obj.avgMessageLength)
      ? Math.max(1, Math.min(200, Math.round(obj.avgMessageLength)))
      : base.avgMessageLength
  const distRaw =
    typeof obj.lengthDistribution === 'object' && obj.lengthDistribution !== null
      ? (obj.lengthDistribution as Record<string, unknown>)
      : {}
  const shortPct = typeof distRaw.shortPct === 'number' ? Math.min(1, Math.max(0, distRaw.shortPct)) : base.lengthDistribution.shortPct
  const mediumPct = typeof distRaw.mediumPct === 'number' ? Math.min(1, Math.max(0, distRaw.mediumPct)) : base.lengthDistribution.mediumPct
  const longPct = typeof distRaw.longPct === 'number' ? Math.min(1, Math.max(0, distRaw.longPct)) : base.lengthDistribution.longPct

  return {
    primaryLanguage: sanitizeText(obj.primaryLanguage, 24, base.primaryLanguage),
    colloquialLevel: level,
    avgMessageLength: avgLen,
    lengthDistribution: { shortPct, mediumPct, longPct },
    vocabulary: sanitizeStringList(obj.vocabulary, 24, 24),
    sentencePatterns: sanitizeStringList(obj.sentencePatterns, 14, 48),
    modalParticles: sanitizeStringList(obj.modalParticles, 14, 12),
    punctuationHabits: sanitizeStringList(obj.punctuationHabits, 10, 32),
    humorPatterns: sanitizeStringList(obj.humorPatterns, 10, 48),
    ironyPatterns: sanitizeStringList(obj.ironyPatterns, 10, 48),
    responseHabits: sanitizeStringList(obj.responseHabits, 12, 56),
    avoidPatterns: sanitizeStringList(obj.avoidPatterns, 12, 56),
    toneSummary: sanitizeText(obj.toneSummary, 160, base.toneSummary),
    voiceMoodHints: sanitizeStringList(obj.voiceMoodHints, 6, 20),
  }
}

export function validateBehaviorProfile(raw: unknown, fallback?: DialogueBehaviorProfile): DialogueBehaviorProfile {
  const base = fallback ?? createEmptyBehaviorProfile()
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ...base }
  const obj = raw as Record<string, unknown>
  return {
    banterStrategy: sanitizeText(obj.banterStrategy, 120, base.banterStrategy),
    memeUsageRule: sanitizeText(obj.memeUsageRule, 120, base.memeUsageRule),
    roastAndIronyRule: sanitizeText(obj.roastAndIronyRule, 120, base.roastAndIronyRule),
    comfortStrategy: sanitizeText(obj.comfortStrategy, 120, base.comfortStrategy),
    showoffAndComplaintRule: sanitizeText(obj.showoffAndComplaintRule, 120, base.showoffAndComplaintRule),
    seriousTopicBoundary: sanitizeText(obj.seriousTopicBoundary, 120, base.seriousTopicBoundary),
    alreadyAnsweredRule: sanitizeText(obj.alreadyAnsweredRule, 120, base.alreadyAnsweredRule),
    conversationEndSignals: sanitizeStringList(obj.conversationEndSignals, 10, 24),
    interactionBoundaries: sanitizeStringList(obj.interactionBoundaries, 10, 64),
  }
}
