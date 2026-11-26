/**
 * 内部领域类型与跨插件服务内联契约（V0.5.0 多模态社交版）。
 *
 * 严格遵循 QFlareBot 官方规范：不 import 其他插件源码，通过内联形状对齐服务契约。
 */

// ---------------------------------------------------------------------------
// 内联契约：qflarebot-plugin-llm (contractVersion: 1)
// ---------------------------------------------------------------------------

export type LLMCapability = 'text' | 'image' | 'audio' | 'tools' | 'json' | 'reasoning'

export type LLMContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; url?: string; data?: string; media_type?: string; detail?: 'auto' | 'low' | 'high' }

export type LLMMessageContent = string | LLMContentPart[]

export interface LLMChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: LLMMessageContent
}

export interface LLMChatRequest {
  model?: string
  messages: LLMChatMessage[]
  temperature?: number
  max_tokens?: number
  top_p?: number
  stop?: string | string[]
  timeout_ms?: number
  signal?: AbortSignal
}

export interface LLMUsage {
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
}

export interface LLMChatResult {
  text: string
  reasoning?: string
  finish_reason?: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'other'
  alias: string
  provider: string
  model: string
  usage?: LLMUsage
  latency_ms: number
}

export interface LLMModelInfo {
  alias: string
  provider: string
  model: string
  capabilities: LLMCapability[]
  context_window?: number
  max_output_tokens?: number
}

export interface LLMService {
  readonly contractVersion: 1
  listModels(): Promise<LLMModelInfo[]>
  resolve(alias?: string): Promise<LLMModelInfo & { provider_name: string }>
  chat(req: LLMChatRequest): Promise<LLMChatResult>
}

// ---------------------------------------------------------------------------
// 内联契约：qflarebot-plugin-agent (docs/plugin-api.md)
// ---------------------------------------------------------------------------

export interface AgentPromptService {
  registerPrompt(plugin: string, fragment: string, priority?: number): Promise<boolean>
  disablePrompt(plugin: string): Promise<boolean>
  clearPrompt(plugin: string): Promise<boolean>
  listPrompts(): Promise<Array<{ plugin: string; fragment: string; priority: number; enabled: boolean }>>
}

// ---------------------------------------------------------------------------
// 插件配置与领域模型
// ---------------------------------------------------------------------------

export type SocialMode = 'auto' | 'at' | 'off'

export interface CustomPersonaItem {
  id: string
  name: string
  description?: string
  systemPrompt: string
  callNames?: string
}

export interface SocialConfig {
  /** 对话模型别名；留空使用 LLM 插件的默认模型 */
  model_alias: string
  /** 独立视觉模型别名；留空时回退到 model_alias / LLM 默认模型 */
  vision_model_alias: string
  /** 默认群发言模式：auto 智能插话 / at 仅@回复 / off 关闭 */
  default_mode: SocialMode
  /** 默认绑定人格 ID */
  default_persona: string
  /**
   * 同群共装 qflarebot-plugin-agent 时，是否将 @机器人 消息让渡给 Agent 处理，
   * 避免与 Agent 重复调用模型和重复回复。
   */
  yield_at_to_agent: boolean
  /** 机器人自定义呼唤词（逗号分隔，如 "小Q,团子"） */
  call_names: string
  /** 非 @ 普通群聊基础插话概率（0 ~ 1） */
  base_reply_probability: number
  /** 智能触发最低分数阈值（0 ~ 100） */
  trigger_threshold: number
  /** 群级最小回复冷却（秒） */
  cooldown_seconds: number
  /** 每群每分钟最大回复条数 */
  max_replies_per_minute: number
  /** 短期上下文滑窗最大保留条数 */
  max_context_messages: number
  /** 短期上下文有效时间（分钟） */
  context_ttl_minutes: number
  /** 是否开启群聊长期记忆 */
  enable_memory: boolean
  /** 长期记忆默认保存天数（1 ~ 90） */
  memory_ttl_days: number
  /** 单群最多保留的长期记忆条数 */
  max_memories_per_group: number
  /** 单次 LLM 调用超时时间（毫秒，建议 <= 15000） */
  llm_timeout_ms: number
  /** 单次回复最大 token 数 */
  max_output_tokens: number
  /** 生成温度 */
  temperature: number
  /** 入站/出站简单内容过滤词（逗号分隔） */
  blocked_keywords: string
  /** 自定义人格列表 */
  custom_personas: CustomPersonaItem[]

  // ---- V0.5.0 多模态：图片理解 ----
  /** 是否启用图片理解（需视觉模型支持 image 能力） */
  enable_vision: boolean
  /** 每群每分钟最多调用视觉模型次数（0 = 不限） */
  vision_rate_limit_per_minute: number
  /** 单条消息最多解析的图片张数（1 ~ 3） */
  max_vision_images: number
  /** 单张图片下载体积上限（字节，默认 800KB） */
  max_image_bytes: number
  /** 视觉分析结果缓存时长（小时，按图片 SHA-256 复用） */
  image_cache_ttl_hours: number
  /** 视觉模型调用超时（毫秒） */
  vision_timeout_ms: number

  // ---- V0.5.0 多模态：表情包素材库与智能回复 ----
  /** 是否启用智能表情包回复 */
  enable_meme_reply: boolean
  /** 启用表情包回复时的触发概率（0 ~ 1） */
  meme_send_probability: number
  /** 同一张表情包在同群内的重复冷却秒数 */
  meme_repeat_cooldown_seconds: number
  /** 允许连续发送含表情包回复的最大次数（防止刷屏和斗图死循环） */
  max_consecutive_memes: number
  /** 收藏的表情包资源保存天数（1 ~ 365） */
  meme_ttl_days: number
  /** 是否跨群共享全部表情包素材库（默认开启：所有群共用同一套表情包库） */
  share_memes_across_groups: boolean
  /** 兼容项：是否允许群聊回复使用全局素材库 */
  use_global_meme_library: boolean
}

export interface PersonaDefinition {
  id: string
  name: string
  description: string
  systemPrompt: string
  callNames: string[]
  builtin: boolean
}

export interface GroupSettings {
  groupId: string
  mode: SocialMode | null
  personaId: string | null
  cooldownSeconds: number | null
  replyProbability: number | null
  memoryTtlDays: number | null
  updatedAt: number
}

export interface ContextMessage {
  role: 'user' | 'assistant'
  /** 发送者唯一标识（脱敏短码或 openid 哈希，用于区分同名群友） */
  speakerKey: string
  /** 展示名（优先群昵称） */
  speakerName: string
  /** 文本内容（已截断，禁止超长文本） */
  text: string
  /** 是否 @ 了机器人 */
  atMe: boolean
  /** 引用摘要（如有） */
  quoteSummary?: string
  /** 图片语义摘要（仅用于短期上下文，不自动入长期记忆） */
  imageSummary?: string
  /** 时间戳（毫秒） */
  ts: number
}

export interface GroupState {
  groupId: string
  recentMessages: ContextMessage[]
  lastReplyAt: number
  windowStartAt: number
  windowReplyCount: number
  /** 最近一次收到非 @ 群消息的时间戳，用于诊断「获取群内全部消息」权限 */
  lastNonAtSeenAt: number
  /** 最近一次清理过期记忆的时间戳（节流用） */
  lastPruneAt: number
  updatedAt: number
}

export type MemoryScope = 'group' | 'member'

export interface GroupMemory {
  id: string
  groupId: string
  userId: string | null
  userName: string | null
  scope: MemoryScope
  content: string
  createdAt: number
  expiresAt: number
}

export interface MemberPrivacy {
  groupId: string
  userId: string
  optOut: boolean
  updatedAt: number
}

export interface TriggerDecision {
  shouldReply: boolean
  reason:
    | 'bot-self'
    | 'bot-sender'
    | 'not-group'
    | 'addressed-to-others'
    | 'empty'
    | 'mode-off'
    | 'yield-to-agent'
    | 'at-only-mode'
    | 'cooldown'
    | 'rate-limited'
    | 'blocked-keyword'
    | 'at-me'
    | 'score-pass'
    | 'score-below-threshold'
  score: number
  /** 是否允许将该条消息写入短期上下文 */
  recordContext: boolean
}

// ---------------------------------------------------------------------------
// V0.5.0 多模态领域模型
// ---------------------------------------------------------------------------

export interface ImageAnalysisResult {
  hash: string
  summary: string
  ocrText: string
  memeMeaning: string
  mood: string
  tags: string[]
  sceneHints: string
  fromCache: boolean
}

export type MemeScope = 'global' | 'group'

export interface MemeRecord {
  id: string
  hash: string
  scope: MemeScope
  groupId: string | null
  r2Key: string
  contentType: string
  sizeBytes: number
  meaning: string
  mood: string
  tags: string[]
  sceneHints: string
  category: string
  enabled: boolean
  createdBy: string | null
  useCount: number
  lastUsedAt: number
  createdAt: number
  expiresAt: number
}

export interface RecentMemeUse {
  id: string
  usedAt: number
}

export interface GroupMultimodalState {
  groupId: string
  visionWindowStart: number
  visionWindowCount: number
  lastMemeSentAt: number
  consecutiveMemeCount: number
  recentMemes: RecentMemeUse[]
  updatedAt: number
}

export interface MultimodalDailyStats {
  day: string
  visionCalls: number
  visionCacheHits: number
  visionErrors: number
  memeSent: number
  memeCollected: number
  updatedAt: number
}

export type ReplyStyle = 'none' | 'text' | 'meme' | 'text_and_meme'

export interface MemeSelectionDecision {
  style: ReplyStyle
  meme?: MemeRecord
  score: number
  reason: string
}
