import type { PluginContext, PluginToolArtifact } from '@qqbot/sdk'
import type {
  AgentChannel,
  LLMChatMessage,
  LLMService,
  LLMToolCall,
  LLMToolDefinition,
  SocialConfig,
  ToolExecutionLog,
} from '../types.js'
import { executeBuiltinTool, findBuiltinByWireName } from './builtin-tools.js'
import { invokeExternalTool, type DiscoveredExternalTools } from './external-tools.js'

export interface AgentLoopInput {
  ctx: PluginContext<SocialConfig>
  llm: LLMService
  conversationId: string
  messages: LLMChatMessage[]
  channel: AgentChannel
  toolDefs: LLMToolDefinition[]
  externalDiscovered: DiscoveredExternalTools | null
  maxSteps?: number
  deadlineMs?: number
  now: number
  fetchImpl?: typeof fetch
  random?: () => number
}

export interface AgentLoopOutput {
  text: string
  artifacts: PluginToolArtifact[]
  toolLogs: Array<Omit<ToolExecutionLog, 'id'>>
  usage: {
    runs: number
    toolCalls: number
    toolFailures: number
    inputTokens: number
    outputTokens: number
  }
  usedAgentLoop: boolean
}

function safeParseToolArgs(raw: string): Record<string, unknown> {
  if (!raw || !raw.trim()) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return {}
  } catch {
    return {}
  }
}

function serializeToolResult(payload: unknown): string {
  const raw = typeof payload === 'string' ? payload : JSON.stringify(payload)
  return raw.length > 4000 ? `${raw.slice(0, 3990)}…(已截断)` : raw
}

const DSML_BLOCK_RE =
  /<\s*[|｜\s]*DSML[|｜\s]*(?:function_)?calls[^>]*>[\s\S]*?<\/\s*[|｜\s]*DSML[|｜\s]*(?:function_)?calls\s*>/gi
const DSML_INVOKE_RE =
  /<\s*[|｜\s]*DSML[|｜\s]*invoke\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/\s*[|｜\s]*DSML[|｜\s]*invoke\s*>/gi
const DSML_PARAM_RE =
  /<\s*[|｜\s]*DSML[|｜\s]*parameter\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/\s*[|｜\s]*DSML[|｜\s]*parameter\s*>/gi
const XML_TOOL_CALL_RE = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/gi
const ANY_LEAKED_MARKUP_RE =
  /<\s*\/?\s*[|｜\s]*DSML[|｜\s]*[^>]*>|<tool_call>[\s\S]*?<\/tool_call>|<function_calls>[\s\S]*?<\/function_calls>/gi

/**
 * 清理模型在纯文本中意外泄漏的 DeepSeek DSML / XML 工具调用标记，防止原样发到 QQ 群。
 */
export function sanitizeLeakedToolMarkup(raw: string): string {
  if (!raw) return ''
  return raw
    .replace(DSML_BLOCK_RE, '')
    .replace(DSML_INVOKE_RE, '')
    .replace(XML_TOOL_CALL_RE, '')
    .replace(ANY_LEAKED_MARKUP_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 兜底解析部分模型（如 DeepSeek V3.2 / R1 或第三方兼容中转）在 content 中泄漏的 DSML / <tool_call> 调用。
 */
export function parseLeakedToolCalls(raw: string, stepIndex = 0): { calls: LLMToolCall[]; cleanedText: string } {
  if (!raw || (!/DSML/i.test(raw) && !raw.includes('<tool_call>'))) {
    return { calls: [], cleanedText: raw.trim() }
  }

  const calls: LLMToolCall[] = []
  let idx = 0

  DSML_INVOKE_RE.lastIndex = 0
  let invokeMatch: RegExpExecArray | null
  while ((invokeMatch = DSML_INVOKE_RE.exec(raw)) !== null) {
    const name = (invokeMatch[1] ?? '').trim()
    const body = invokeMatch[2] ?? ''
    if (!name) continue
    const args: Record<string, unknown> = {}
    DSML_PARAM_RE.lastIndex = 0
    let paramMatch: RegExpExecArray | null
    while ((paramMatch = DSML_PARAM_RE.exec(body)) !== null) {
      const pName = (paramMatch[1] ?? '').trim()
      const pVal = (paramMatch[2] ?? '').trim()
      if (!pName) continue
      if (pVal === 'true') args[pName] = true
      else if (pVal === 'false') args[pName] = false
      else if (/^-?\d+(?:\.\d+)?$/.test(pVal)) args[pName] = Number(pVal)
      else args[pName] = pVal
    }
    idx += 1
    calls.push({
      id: `dsml_${stepIndex}_${idx}`,
      name,
      arguments: JSON.stringify(args),
    })
  }

  if (calls.length === 0) {
    XML_TOOL_CALL_RE.lastIndex = 0
    let xmlMatch: RegExpExecArray | null
    while ((xmlMatch = XML_TOOL_CALL_RE.exec(raw)) !== null) {
      try {
        const parsed = JSON.parse(xmlMatch[1] ?? '{}') as { name?: string; arguments?: unknown }
        if (typeof parsed.name === 'string' && parsed.name.trim()) {
          idx += 1
          calls.push({
            id: `xml_${stepIndex}_${idx}`,
            name: parsed.name.trim(),
            arguments: typeof parsed.arguments === 'string' ? parsed.arguments : JSON.stringify(parsed.arguments ?? {}),
          })
        }
      } catch {
        // 忽略无法解析的残缺 JSON
      }
    }
  }

  return {
    calls,
    cleanedText: sanitizeLeakedToolMarkup(raw),
  }
}

/**
 * 统一 Social Agent 执行引擎（V0.11.1 三通道复用版）：
 * - Fast Chat（toolDefs 为空）：1 次 llm.chat()，零工具 Schema 开销；
 * - Smart Tool Chat / Full Agent：按注入的精选或全量工具集执行多步 ReAct 循环，
 *   共享同一条消息的预算 deadline、思考签名透传与死循环拦截。
 */
export async function runSocialAgentLoop(input: AgentLoopInput): Promise<AgentLoopOutput> {
  const { ctx, llm, conversationId, channel, toolDefs, externalDiscovered, now } = input
  const fetchImpl = input.fetchImpl ?? globalThis.fetch
  const model = ctx.config.model_alias.trim() || undefined

  const usage = { runs: 0, toolCalls: 0, toolFailures: 0, inputTokens: 0, outputTokens: 0 }
  const toolLogs: Array<Omit<ToolExecutionLog, 'id'>> = []
  const artifacts: PluginToolArtifact[] = []
  const deadline = input.deadlineMs ?? Date.now() + Math.max(6_000, ctx.config.agent_budget_ms || 18_000)

  // Fast Chat 快通道：零工具 Schema，单次调用
  if (channel === 'fast' || toolDefs.length === 0) {
    const timeoutMs = Math.max(3_000, Math.min(ctx.config.llm_timeout_ms, deadline - Date.now()))
    const res = await llm.chat({
      model,
      messages: input.messages,
      temperature: ctx.config.temperature,
      max_tokens: ctx.config.max_output_tokens,
      timeout_ms: timeoutMs,
    })
    usage.runs += 1
    usage.inputTokens += res.usage?.input_tokens ?? 0
    usage.outputTokens += res.usage?.output_tokens ?? 0
    return {
      text: sanitizeLeakedToolMarkup(res.text ?? ''),
      artifacts,
      toolLogs,
      usage,
      usedAgentLoop: false,
    }
  }

  // Smart Tool Chat / Full Agent：受限多步 Function Calling 循环
  const history: LLMChatMessage[] = [...input.messages]
  const allowedWireNames = new Set(toolDefs.map((t) => t.name))
  const maxSteps = Math.min(
    6,
    Math.max(1, Math.floor(input.maxSteps ?? ctx.config.agent_max_tool_steps ?? 4)),
  )
  const maxCalls = Math.min(12, Math.max(1, Math.floor(ctx.config.agent_max_tool_calls || 6)))
  const seenCallFingerprints = new Set<string>()
  let totalCalls = 0

  for (let step = 0; step < maxSteps; step++) {
    const remainingMs = deadline - Date.now()
    if (remainingMs < 2_500) break

    const res = await llm.chat({
      model,
      messages: history,
      tools: toolDefs,
      tool_choice: 'auto',
      temperature: ctx.config.temperature,
      max_tokens: Math.max(ctx.config.max_output_tokens, 260),
      timeout_ms: Math.min(ctx.config.llm_timeout_ms, remainingMs),
    })
    usage.runs += 1
    usage.inputTokens += res.usage?.input_tokens ?? 0
    usage.outputTokens += res.usage?.output_tokens ?? 0

    let calls = res.tool_calls ?? []
    let assistantText = (res.text ?? '').trim()
    if (calls.length === 0 && assistantText) {
      const recovered = parseLeakedToolCalls(assistantText, step)
      if (recovered.calls.length > 0) {
        calls = recovered.calls
        assistantText = recovered.cleanedText
      }
    }

    if (calls.length === 0) {
      return {
        text: sanitizeLeakedToolMarkup(assistantText),
        artifacts,
        toolLogs,
        usage,
        usedAgentLoop: true,
      }
    }

    history.push({
      role: 'assistant',
      content: assistantText || undefined,
      tool_calls: calls,
      ...(res.reasoning ? { reasoning: res.reasoning } : {}),
      ...(res.thought_signatures ? { thought_signatures: res.thought_signatures } : {}),
      ...(res.reasoning_signatures ? { reasoning_signatures: res.reasoning_signatures } : {}),
    })

    let loopBroken = false
    for (const call of calls) {
      if (totalCalls >= maxCalls || Date.now() >= deadline - 1_500) {
        history.push({
          role: 'tool',
          tool_call_id: call.id,
          is_error: true,
          content: JSON.stringify({ error: '工具调用已达本轮次数或时间预算上限，请直接根据已有信息自然回复。' }),
        })
        loopBroken = true
        continue
      }

      if (!allowedWireNames.has(call.name)) {
        usage.toolFailures += 1
        toolLogs.push({
          groupId: conversationId,
          toolId: call.name,
          source: 'external',
          status: 'denied',
          latencyMs: 0,
          error: '工具未在当前会话授权列表中',
          createdAt: now,
        })
        history.push({
          role: 'tool',
          tool_call_id: call.id,
          is_error: true,
          content: JSON.stringify({ error: `工具 ${call.name} 未授权，请勿调用。` }),
        })
        continue
      }

      const fingerprint = `${call.name}::${call.arguments}`
      if (seenCallFingerprints.has(fingerprint)) {
        history.push({
          role: 'tool',
          tool_call_id: call.id,
          is_error: true,
          content: JSON.stringify({ error: '检测到重复的相同工具调用，已阻止死循环，请直接总结回复。' }),
        })
        loopBroken = true
        continue
      }
      seenCallFingerprints.add(fingerprint)
      totalCalls += 1
      usage.toolCalls += 1

      const started = Date.now()
      const parsedArgs = safeParseToolArgs(call.arguments)
      const builtin = findBuiltinByWireName(call.name)

      if (builtin) {
        const result = await executeBuiltinTool(builtin, parsedArgs, {
          ctx,
          conversationId,
          now,
          timeoutMs: Math.min(ctx.config.tool_timeout_ms, Math.max(1500, deadline - Date.now())),
          fetchImpl,
          random: input.random,
        })
        if (!result.ok) usage.toolFailures += 1
        toolLogs.push({
          groupId: conversationId,
          toolId: builtin.id,
          source: 'builtin',
          status: result.ok ? 'success' : 'failed',
          latencyMs: Date.now() - started,
          error: result.error ?? '',
          createdAt: now,
        })
        history.push({
          role: 'tool',
          tool_call_id: call.id,
          is_error: !result.ok,
          content: serializeToolResult(result.ok ? result.output : { error: result.error }),
        })
        continue
      }

      const extBound = externalDiscovered?.tools.find((t) => t.wireName === call.name)
      if (externalDiscovered && extBound) {
        const result = await invokeExternalTool(externalDiscovered, extBound, parsedArgs, {
          timeoutMs: ctx.config.tool_timeout_ms,
          deadline,
        })
        if (!result.ok) usage.toolFailures += 1
        toolLogs.push({
          groupId: conversationId,
          toolId: extBound.descriptor.id,
          source: 'external',
          status: result.status,
          latencyMs: Date.now() - started,
          error: result.error ?? '',
          createdAt: now,
        })
        if (result.artifacts.length > 0) {
          artifacts.push(...result.artifacts)
        }
        history.push({
          role: 'tool',
          tool_call_id: call.id,
          is_error: !result.ok,
          content: serializeToolResult(result.ok ? result.output : { error: result.error }),
        })
        continue
      }

      usage.toolFailures += 1
      toolLogs.push({
        groupId: conversationId,
        toolId: call.name,
        source: 'builtin',
        status: 'denied',
        latencyMs: Date.now() - started,
        error: '工具未启用或不存在',
        createdAt: now,
      })
      history.push({
        role: 'tool',
        tool_call_id: call.id,
        is_error: true,
        content: JSON.stringify({ error: `工具 ${call.name} 不存在或未启用` }),
      })
    }

    if (loopBroken) break
  }

  // 步数/时间预算耗尽后做一次不带 tools 的收尾总结，明确禁止再输出工具/DSML 标签
  const finalMessages: LLMChatMessage[] = [
    ...history,
    {
      role: 'user',
      content:
        '[系统提示] 工具查询阶段已结束，请不要再调用任何工具，也不要输出任何 DSML、XML、JSON 或工具调用标记；请直接根据已有信息用自然口语回复群友。',
    },
  ]
  const finalTimeout = Math.max(4_000, Math.min(ctx.config.llm_timeout_ms, deadline - Date.now() + 4_000))
  const finalRes = await llm.chat({
    model,
    messages: finalMessages,
    temperature: ctx.config.temperature,
    max_tokens: ctx.config.max_output_tokens,
    timeout_ms: finalTimeout,
  })
  usage.runs += 1
  usage.inputTokens += finalRes.usage?.input_tokens ?? 0
  usage.outputTokens += finalRes.usage?.output_tokens ?? 0

  const sanitizedFinal = sanitizeLeakedToolMarkup(finalRes.text ?? '')
  return {
    text: sanitizedFinal || (usage.toolFailures > 0 ? '刚刚查了一圈没查到准确结果，换个大一点的城市名再问我试试？' : ''),
    artifacts,
    toolLogs,
    usage,
    usedAgentLoop: true,
  }
}
