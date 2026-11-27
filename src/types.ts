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

export interface LLMToolDefinition {
  name: string
  description?: string
  parameters: Record<string, unknown>
}

export interface LLMToolCall {
  id: string
  name: string
  arguments: string
}

export interface LLMThoughtSignature {
  part_index: number
  part_kind: 'text' | 'function_call'
  signature: string
  tool_call_index?: number
  tool_call_id?: string
  tool_name?: string
}

export interface LLMReasoningSignature {
  part_index: number
  block_type: 'thinking' | 'redacted_thinking'
  thinking?: string
  signature?: string
  data?: string
}

export interface LLMChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: LLMMessageContent
  tool_calls?: LLMToolCall[]
  tool_call_id?: string
  is_error?: boolean
  reasoning?: string
  thought_signatures?: LLMThoughtSignature[]
  reasoning_signatures?: LLMReasoningSignature[]
}

export type LLMToolChoice = 'auto' | 'none' | 'required' | { name: string }

export interface LLMChatRequest {
  model?: string
  messages: LLMChatMessage[]
  tools?: LLMToolDefinition[]
  tool_choice?: LLMToolChoice
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
  tool_calls?: LLMToolCall[]
  thought_signatures?: LLMThoughtSignature[]
  reasoning_signatures?: LLMReasoningSignature[]
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

  // ---- V0.10.0 AI 语音互动 ----
  /** 语音回复总开关 */
  enable_voice: boolean
  /** TTS 供应商：minimax / qwen / openai */
  tts_provider: TTSProviderType
  /** TTS API 地址（留空使用对应供应商默认地址） */
  tts_api_base_url: string
  /** TTS API Key（面板 writeOnly 脱敏存储） */
  tts_api_key: string
  /** TTS 模型名 */
  tts_model: string
  /** 默认音色 ID */
  tts_voice_id: string
  /** 语速（0.5 ~ 2.0） */
  tts_speed: number
  /** 音调（-12 ~ 12，仅支持该参数的供应商生效） */
  tts_pitch: number
  /** 音量（0.1 ~ 10，仅支持该参数的供应商生效） */
  tts_volume: number
  /** 默认情绪（如 happy / calm / sad，留空为中性） */
  tts_emotion: string
  /** 音频格式（推荐 wav，已实测 QQ 原生可播） */
  tts_audio_format: VoiceAudioFormat
  /** TTS 请求超时（毫秒） */
  tts_timeout_ms: number
  /** 语音触发模式：manual / probability / ai / always */
  voice_trigger_mode: VoiceTriggerMode
  /** 概率触发模式下的语音发送概率（0 ~ 1） */
  voice_probability: number
  /** 每群每日最大语音条数（0 = 不限） */
  voice_daily_limit_per_group: number
  /** 单次语音最大字符数（超出自动降级文字，控制成本与体积） */
  voice_max_chars: number
  /** 语音发送失败时是否自动降级为文字回复 */
  voice_fallback_to_text: boolean
  /** 临时语音与去重缓存保存时长（小时，到期自动清理） */
  voice_cache_ttl_hours: number
  /** 估算费率（元 / 千字，仅用于后台费用统计参考） */
  voice_cost_per_1k_chars: number

  // ---- V0.11.0 全托管 Social-Agent 能力 ----
  /** 是否开启 Agent 工具调用能力（仅在 @机器人 / /ask 时按需启用，非@插话保持快通道） */
  enable_agent_tools: boolean
  /** 单次 Agent 对话最大工具循环步数（1 ~ 6） */
  agent_max_tool_steps: number
  /** 单次 Agent 对话最大工具调用总次数（1 ~ 12） */
  agent_max_tool_calls: number
  /** 单次工具调用超时（毫秒） */
  tool_timeout_ms: number
  /** Agent 软执行预算（毫秒，给 QQ 30s 硬限留出余量） */
  agent_budget_ms: number
  /** 短期上下文估算 Token 上限（超出自动压缩裁剪） */
  context_max_tokens: number
  /** 是否允许单聊（私聊）对话（与群聊记忆严格隔离） */
  enable_c2c_chat: boolean
  /** 可选联网搜索供应商（tavily / bocha） */
  web_search_provider: 'tavily' | 'bocha'
  /** 可选联网搜索 API Key（留空则不启用联网搜索工具） */
  web_search_api_key: string

  // ---- V0.11.1 自适应三通道路由与无感工具调用 ----
  /** 是否开启自适应三通道路由（Fast / Smart Tool / Full Agent） */
  adaptive_agent_enabled: boolean
  /** 路由模式：adaptive 自适应 / explicit_only 仅显式 @或/ask / always_smart 始终智能筛选 */
  agent_routing_mode: AgentRoutingMode
  /** 是否允许普通非 @ 群消息自然触发工具调用 */
  agent_allow_non_mention: boolean
  /** 是否结合近期群聊上下文做指代消解与话题意图识别 */
  agent_context_intent: boolean
  /** 是否允许 Fast Chat 模型自主申请升级到 Agent 工具通道 */
  agent_auto_escalate: boolean
  /** Smart Tool Chat 最多加载的候选工具数量（1 ~ 5，默认 3） */
  agent_candidate_top_k: number
  /** 普通非 @ 自动工具调用的最大步数（1 ~ 4，默认 2） */
  agent_auto_max_steps: number
  /** 是否在调试时显示工具调用提示（默认关闭，保持拟人隐身） */
  agent_show_tool_progress: boolean
  /** 每群每日非 @ 自动工具路由次数上限（0 = 不限） */
  agent_auto_daily_limit: number

  // ---- V0.12.0 群聊风格蒸馏、文化学习与自进化系统 ----
  /** 是否开启群聊风格学习系统（需群级授权后生效，默认关闭） */
  style_learning_enabled: boolean
  /** 是否开启定时增量学习（复用 SDK v5 cron） */
  style_auto_learn: boolean
  /** 是否允许通过门禁的候选风格自动发布（默认关闭，推荐人工审核） */
  style_auto_publish: boolean
  /** 学习蒸馏专用模型别名（留空复用对话模型别名） */
  style_learning_model_alias: string
  /** 单批学习最大有效消息条数（20 ~ 400，默认 200） */
  style_learning_batch_size: number
  /** 触发自动学习的最低新增有效语料条数（20 ~ 300，默认 100） */
  style_learning_min_messages: number
  /** 定时增量学习扫描周期（小时，默认 6） */
  style_learning_interval_hours: number
  /** 近期风格观察窗口（天，默认 30） */
  style_recent_window_days: number
  /** 原始学习语料保存期限（天，默认 30，到期自动清理） */
  style_corpus_retention_days: number
  /** 长期稳定风格参考权重（0 ~ 1，默认 0.7） */
  style_stable_weight: number
  /** 近期动态风格参考权重（0 ~ 1，默认 0.3） */
  style_recent_weight: number
  /** 单成员语料采样权重上限（0.05 ~ 0.5，默认 0.2，小群自动适配） */
  style_member_max_weight: number
  /** 风格表达影响强度（0 ~ 1，默认 0.7） */
  style_influence_strength: number
  /** 对话示例检索条数上限（0 ~ 5，默认 5） */
  style_retrieval_top_k: number
  /** 同一热梗重复使用冷却轮数（默认 4） */
  style_meme_cooldown_turns: number
  /** 风格档案 Prompt Token 预算上限（默认 800） */
  style_profile_max_tokens: number
  /** 热梗文化 Prompt Token 预算上限（默认 400） */
  style_meme_max_tokens: number
  /** 对话示例 Prompt Token 预算上限（默认 800） */
  style_examples_max_tokens: number
  /** 风格系统总新增 Prompt Token 预算上限（默认 2000） */
  style_total_max_tokens: number
  /** 每日学习 LLM 调用次数预算上限（默认 20） */
  style_daily_budget_runs: number
  /** 可选向量检索开关（Phase 6，当前默认关闭，不可用时自动降级 D1） */
  style_vector_enabled: boolean
  /** 是否开启显式/隐式反馈评估记录 */
  style_feedback_enabled: boolean
  /** 强制排除机器人自身及其他机器人消息 */
  style_exclude_bot_messages: boolean
  /** 严格按群隔离风格、热梗与样本 */
  style_group_isolation: boolean
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

export type ReplyStyle = 'none' | 'text' | 'meme' | 'text_and_meme' | 'voice'

export interface MemeSelectionDecision {
  style: ReplyStyle
  meme?: MemeRecord
  score: number
  reason: string
}

// ---------------------------------------------------------------------------
// V0.10.0 AI 语音互动领域模型
// ---------------------------------------------------------------------------

export type TTSProviderType = 'minimax' | 'qwen' | 'openai'
export type VoiceTriggerMode = 'manual' | 'probability' | 'ai' | 'always'
export type VoiceAudioFormat = 'wav' | 'mp3'

export interface GroupVoiceSettings {
  groupId: string
  enabled: boolean | null
  triggerMode: VoiceTriggerMode | null
  probability: number | null
  voiceId: string | null
  speed: number | null
  emotion: string | null
  dailyLimit: number | null
  updatedAt: number
}

export interface VoiceCacheEntry {
  cacheKey: string
  provider: TTSProviderType
  format: VoiceAudioFormat
  contentType: string
  sizeBytes: number
  r2Key: string
  createdAt: number
  expiresAt: number
}

export interface VoiceLogRecord {
  id: string
  groupId: string
  provider: TTSProviderType
  model: string
  voiceId: string
  emotion: string
  charCount: number
  estimatedCost: number
  format: VoiceAudioFormat
  cached: boolean
  status: 'sent' | 'fallback_text' | 'failed'
  error: string
  createdAt: number
}

export interface VoiceSynthesisRequest {
  text: string
  provider: TTSProviderType
  apiBaseUrl: string
  apiKey: string
  model: string
  voiceId: string
  speed: number
  pitch: number
  volume: number
  emotion: string
  format: VoiceAudioFormat
  timeoutMs: number
}

export interface VoiceSynthesisResult {
  bytes: ArrayBuffer
  format: VoiceAudioFormat
  contentType: string
  sizeBytes: number
}

// ---------------------------------------------------------------------------
// V1.0.0 Social-Agent 工具与提示词扩展模型
// ---------------------------------------------------------------------------

export interface AgentToolPolicy {
  enabledBuiltins: string[]
  enabledExternalTools: string[]
  allowExternalWrites: boolean
  updatedAt: number
}

export interface PromptFragmentRecord {
  plugin: string
  fragment: string
  priority: number
  enabled: boolean
  updatedAt: number
}

export interface ToolDailyStat {
  day: string
  toolId: string
  calls: number
  successes: number
  totalLatencyMs: number
  updatedAt: number
}

export interface ToolExecutionLog {
  id: string
  groupId: string
  toolId: string
  source: 'builtin' | 'external'
  status: 'success' | 'failed' | 'timeout' | 'denied'
  latencyMs: number
  error: string
  createdAt: number
}

export type AgentRoutingMode = 'adaptive' | 'explicit_only' | 'always_smart'
export type AgentChannel = 'fast' | 'smart' | 'full'

export interface LLMDailyUsage {
  day: string
  runs: number
  toolCalls: number
  inputTokens: number
  outputTokens: number
  updatedAt: number
}

export interface RoutingLogRecord {
  id: string
  day: string
  groupId: string
  channel: AgentChannel
  escalated: boolean
  matchedIntents: string[]
  candidateCount: number
  toolCalls: number
  toolFailures: number
  falseTrigger: boolean
  latencyMs: number
  tokens: number
  createdAt: number
}

export interface ChannelObservabilitySummary {
  channel: AgentChannel
  count: number
  avgLatencyMs: number
  p95LatencyMs: number
  totalTokens: number
  totalToolCalls: number
  totalToolFailures: number
  falseTriggers: number
}
