import type { AgentChannel, ContextMessage, SocialConfig } from '../types.js'
import type { BoundExternalTool } from './external-tools.js'

export interface IntentRule {
  intent: string
  toolId: string
  /** 仅匹配领域关键词；必须结合查询/动作意图或上下文追问才视为可行动意图 */
  domainRe: RegExp
  /** 明确动作表达：命中即自带查询/行动意图 */
  directActionRe?: RegExp
}

const INTENT_RULES: readonly IntentRule[] = [
  {
    intent: 'weather',
    toolId: 'social.weather',
    domainRe: /(?:天气|气温|温度|下雨|下雪|冷不冷|热不热|刮风|阴天|晴天|穿什么)/,
    directActionRe:
      /(?:查一下?|看看|帮我查|帮我看).{0,8}(?:天气|气温|下雨|冷不冷|热不热)|(?:今天|明天|现在).{0,8}(?:冷不冷|热不热|会下雨|下不下雨|多少度)/,
  },
  {
    intent: 'time',
    toolId: 'social.get_time',
    domainRe: /(?:几点|星期几|周几|几号|几月几|北京时间|现在时间)/,
    directActionRe: /(?:现在|目前|今天|明天).{0,4}(?:几点|星期几|周几|几号|几月)/,
  },
  {
    intent: 'web_fetch',
    toolId: 'social.web_fetch',
    domainRe: /https?:\/\/[^\s]+/i,
    directActionRe: /https?:\/\/[^\s]+/i,
  },
  {
    intent: 'web_search',
    toolId: 'social.web_search',
    domainRe: /(?:什么梗|什么意思|攻略|最新|新闻|百科|谁是|哪年|多少钱|发售|上线|比分|排名|热搜)/,
    directActionRe: /(?:查一下?|搜一下?|搜索|查查|帮我查|帮我搜|科普一下)/,
  },
  {
    intent: 'memory_search',
    toolId: 'social.search_memory',
    domainRe: /(?:记得|之前说过|上次|群梗|以前聊过|还记不记得)/,
    directActionRe: /(?:还记得|帮我回忆|之前说过什么|查查群梗)/,
  },
  {
    intent: 'memory_save',
    toolId: 'social.remember_fact',
    domainRe: /(?:记住|记一下|别忘了)/,
    directActionRe: /(?:记住一下?|帮我记住|记一下这)/,
  },
  {
    intent: 'roll',
    toolId: 'social.roll',
    domainRe: /(?:掷骰子|摇骰子|骰子|抽签|随机选|吃啥|吃什么|选一个|帮我选|\d+d\d+)/i,
    directActionRe: /(?:帮我选|随机抽|掷个?骰子|摇个?骰子|抽个?签|\d+d\d+)/i,
  },
  {
    intent: 'memes',
    toolId: 'social.search_memes',
    domainRe: /(?:表情包|斗图|来张图|发个表情)/,
  },
]

const QUERY_SIGNAL_RE =
  /[?？]|(?:吗|呢|嘛|么|啥|谁|哪|几|多少|怎么|为啥|为什么|查|搜|帮我|看看|问下|问一下|知道|推荐|有没有|能不能|可不可以|行不行)/
const FOLLOWUP_COREF_RE = /^(?:那|还有|再|顺便|明天|后天|晚上|换成|换个|它|这个|那个|这边|那边)/
const CASUAL_STATEMENT_RE = /^(?:哈哈|笑死|确实|太好了|真好|气死我了|烦死了|绝了|无语|真不错)/

export interface IntentAnalysis {
  channel: AgentChannel
  matchedIntents: string[]
  candidateToolIds: string[]
  isMultiTool: boolean
  isContinuousChat: boolean
  hasActionableQuery: boolean
  reason: string
}

export interface AnalyzeIntentInput {
  text: string
  quoteText?: string
  recentMessages: readonly ContextMessage[]
  config: SocialConfig
  isExplicit: boolean
  isAtMe: boolean
  autoAgentCountToday: number
  externalTools: readonly BoundExternalTool[]
  now: number
}

function matchExternalToolIds(text: string, externalTools: readonly BoundExternalTool[]): string[] {
  if (externalTools.length === 0) return []
  const lower = text.toLowerCase()
  const hits: string[] = []
  for (const ext of externalTools) {
    const raw = `${ext.descriptor.id} ${ext.descriptor.name} ${ext.descriptor.description}`.toLowerCase()
    const asciiTokens = raw.match(/[a-z0-9]{2,}/g) ?? []
    const cjkSegments = raw.match(/[\u4e00-\u9fa5]{2,}/g) ?? []
    const cjkBigrams: string[] = []
    for (const seg of cjkSegments) {
      for (let i = 0; i <= seg.length - 2; i += 1) {
        cjkBigrams.push(seg.slice(i, i + 2))
      }
    }
    const visualHit =
      /(?:图片|画图|渲染|海报|卡片)/.test(raw) && /(?:画张图|画个图|出张图|做张图|渲染|生成图|画一?张)/.test(lower)
    if (visualHit || asciiTokens.some((tok) => lower.includes(tok)) || cjkBigrams.some((tok) => lower.includes(tok))) {
      hits.push(ext.descriptor.id)
    }
  }
  return hits
}

function detectContextIntents(recentMessages: readonly ContextMessage[]): Array<{ intent: string; toolId: string }> {
  const recentText = recentMessages
    .slice(-3)
    .map((m) => m.text)
    .join('\n')
  const found: Array<{ intent: string; toolId: string }> = []
  for (const rule of INTENT_RULES) {
    if (rule.domainRe.test(recentText)) {
      found.push({ intent: rule.intent, toolId: rule.toolId })
    }
  }
  return found
}

/**
 * 零 LLM 成本自适应三通道意图路由器（Fast Chat / Smart Tool Chat / Full Agent）。
 *
 * 原则：
 * - 关键词仅用于筛选候选工具，绝不直接执行工具；
 * - 无查询/行动意图的纯感叹/闲聊（如“今天天气真好哈哈”）走 Fast Chat，不加载工具 Schema。
 */
export function analyzeMessageIntent(input: AnalyzeIntentInput): IntentAnalysis {
  const { text, quoteText, recentMessages, config, isExplicit, isAtMe, autoAgentCountToday, externalTools, now } = input
  const combined = `${text} ${quoteText ?? ''}`.trim()

  const lastBotMsg = [...recentMessages].reverse().find((m) => m.role === 'assistant')
  const isContinuousChat = Boolean(lastBotMsg && now - lastBotMsg.ts <= 2 * 60_000)

  if (!config.enable_agent_tools) {
    return {
      channel: 'fast',
      matchedIntents: [],
      candidateToolIds: [],
      isMultiTool: false,
      isContinuousChat,
      hasActionableQuery: false,
      reason: 'agent-tools-disabled',
    }
  }

  // 1. 显式 /ask 命令始终进入 Full Agent
  if (isExplicit) {
    return {
      channel: 'full',
      matchedIntents: ['explicit'],
      candidateToolIds: [],
      isMultiTool: true,
      isContinuousChat,
      hasActionableQuery: true,
      reason: 'explicit-ask',
    }
  }

  // 2. 非自适应或仅显式模式
  if (!config.adaptive_agent_enabled || config.agent_routing_mode === 'explicit_only') {
    return {
      channel: isAtMe ? 'full' : 'fast',
      matchedIntents: isAtMe ? ['at-me'] : [],
      candidateToolIds: [],
      isMultiTool: false,
      isContinuousChat,
      hasActionableQuery: isAtMe,
      reason: isAtMe ? 'explicit-only-at' : 'explicit-only-fast',
    }
  }

  // 3. 识别查询/动作意图与上下文追问
  const hasQuerySignal = QUERY_SIGNAL_RE.test(text)
  const isFollowup = FOLLOWUP_COREF_RE.test(text.trim())
  const isCasualOnly = CASUAL_STATEMENT_RE.test(text.trim()) && !hasQuerySignal

  const matchedIntents: string[] = []
  const candidateToolIds: string[] = []
  let hasDirectAction = false

  for (const rule of INTENT_RULES) {
    const direct = Boolean(rule.directActionRe?.test(combined)) && !isCasualOnly
    const domain = rule.domainRe.test(combined)
    if (direct || (domain && hasQuerySignal && !isCasualOnly)) {
      matchedIntents.push(rule.intent)
      candidateToolIds.push(rule.toolId)
      if (direct) hasDirectAction = true
    }
  }

  // 外部白名单工具描述匹配
  if (hasQuerySignal || isAtMe) {
    for (const extId of matchExternalToolIds(combined, externalTools)) {
      if (!candidateToolIds.includes(extId)) {
        matchedIntents.push(`ext:${extId}`)
        candidateToolIds.push(extId)
      }
    }
  }

  // 上下文指代消解（如上一句问北京天气，这句问“那上海呢？”）
  if (
    config.agent_context_intent &&
    candidateToolIds.length === 0 &&
    (isFollowup || (hasQuerySignal && text.trim().length <= 16))
  ) {
    const ctxIntents = detectContextIntents(recentMessages)
    for (const item of ctxIntents.slice(0, 2)) {
      matchedIntents.push(`ctx:${item.intent}`)
      candidateToolIds.push(item.toolId)
    }
  }

  const hasActionableQuery = hasDirectAction || (candidateToolIds.length > 0 && (hasQuerySignal || isFollowup || isAtMe))
  const isMultiTool = candidateToolIds.length >= 2

  // 4. 非 @ 消息检查开关与每日自动工具限额
  if (!isAtMe) {
    if (!config.agent_allow_non_mention) {
      return {
        channel: 'fast',
        matchedIntents,
        candidateToolIds: [],
        isMultiTool: false,
        isContinuousChat,
        hasActionableQuery,
        reason: 'non-mention-disabled',
      }
    }
    if (config.agent_auto_daily_limit > 0 && autoAgentCountToday >= config.agent_auto_daily_limit) {
      return {
        channel: 'fast',
        matchedIntents,
        candidateToolIds: [],
        isMultiTool: false,
        isContinuousChat,
        hasActionableQuery,
        reason: 'auto-daily-limit-reached',
      }
    }
  }

  // 5. 通道决策
  if (config.agent_routing_mode === 'always_smart') {
    return {
      channel: isMultiTool ? 'full' : 'smart',
      matchedIntents,
      candidateToolIds,
      isMultiTool,
      isContinuousChat,
      hasActionableQuery: true,
      reason: 'always-smart-mode',
    }
  }

  if (isMultiTool && hasActionableQuery) {
    return {
      channel: 'full',
      matchedIntents,
      candidateToolIds,
      isMultiTool: true,
      isContinuousChat,
      hasActionableQuery: true,
      reason: 'multi-tool-intent',
    }
  }

  if (candidateToolIds.length > 0 && hasActionableQuery) {
    return {
      channel: 'smart',
      matchedIntents,
      candidateToolIds,
      isMultiTool: false,
      isContinuousChat,
      hasActionableQuery: true,
      reason: 'smart-intent-match',
    }
  }

  // 纯闲聊或仅提及关键词但无查询意图 -> Fast Chat（保留自主升级能力）
  return {
    channel: 'fast',
    matchedIntents,
    candidateToolIds: [],
    isMultiTool: false,
    isContinuousChat,
    hasActionableQuery: false,
    reason: isCasualOnly ? 'casual-statement-fast' : 'no-tool-intent-fast',
  }
}
