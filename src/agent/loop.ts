import type { PluginContext, PluginToolArtifact } from '@qqbot/sdk'
import type {
  AgentToolPolicy,
  LLMChatMessage,
  LLMService,
  LLMToolDefinition,
  SocialConfig,
  ToolExecutionLog,
} from '../types.js'
import {
  executeBuiltinTool,
  findBuiltinByWireName,
  listEnabledBuiltinToolDefs,
} from './builtin-tools.js'
import {
  discoverExternalTools,
  invokeExternalTool,
  type DiscoveredExternalTools,
} from './external-tools.js'

export interface AgentLoopInput {
  ctx: PluginContext<SocialConfig>
  llm: LLMService
  conversationId: string
  messages: LLMChatMessage[]
  allowTools: boolean
  policy: AgentToolPolicy
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

/**
 * 统一 Social Agent 执行引擎：
 * - 快通道（allowTools=false 或无可用工具）：1 次 llm.chat() 直接返回；
 * - Agent Loop（allowTools=true 且有可用工具）：支持多步 Function Calling、
 *   思考签名透传、重复调用死循环保护、步数/次数/软超时预算控制与工具附件收集。
 */
export async function runSocialAgentLoop(input: AgentLoopInput): Promise<AgentLoopOutput> {
  const { ctx, llm, conversationId, allowTools, policy, now } = input
  const fetchImpl = input.fetchImpl ?? globalThis.fetch
  const model = ctx.config.model_alias.trim() || undefined

  const usage = { runs: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0 }
  const toolLogs: Array<Omit<ToolExecutionLog, 'id'>> = []
  const artifacts: PluginToolArtifact[] = []

  let externalDiscovered: DiscoveredExternalTools | null = null
  let toolDefs: LLMToolDefinition[] = []

  if (allowTools && ctx.config.enable_agent_tools) {
    const builtinDefs = listEnabledBuiltinToolDefs(ctx.config, policy.enabledBuiltins)
    externalDiscovered = await discoverExternalTools(ctx, policy)
    toolDefs = [...builtinDefs, ...(externalDiscovered?.definitions ?? [])]
  }

  // 快通道：零工具开销，单次调用
  if (toolDefs.length === 0) {
    const res = await llm.chat({
      model,
      messages: input.messages,
      temperature: ctx.config.temperature,
      max_tokens: ctx.config.max_output_tokens,
      timeout_ms: ctx.config.llm_timeout_ms,
    })
    usage.runs += 1
    usage.inputTokens += res.usage?.input_tokens ?? 0
    usage.outputTokens += res.usage?.output_tokens ?? 0
    return {
      text: (res.text ?? '').trim(),
      artifacts,
      toolLogs,
      usage,
      usedAgentLoop: false,
    }
  }

  // Agent Loop：带工具调用的多轮推理
  const history: LLMChatMessage[] = [...input.messages]
  const maxSteps = Math.min(6, Math.max(1, Math.floor(ctx.config.agent_max_tool_steps || 4)))
  const maxCalls = Math.min(12, Math.max(1, Math.floor(ctx.config.agent_max_tool_calls || 6)))
  const deadline = Date.now() + Math.max(6_000, ctx.config.agent_budget_ms || 18_000)
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

    const calls = res.tool_calls ?? []
    if (calls.length === 0) {
      return {
        text: (res.text ?? '').trim(),
        artifacts,
        toolLogs,
        usage,
        usedAgentLoop: true,
      }
    }

    // 保留思考签名（Gemini thought_signatures / Anthropic reasoning_signatures / DeepSeek reasoning）
    history.push({
      role: 'assistant',
      content: res.text || undefined,
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
          content: JSON.stringify({ error: '工具调用已达本轮次数或时间预算上限，请直接根据已有信息回复。' }),
        })
        loopBroken = true
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

  // 步数/时间预算耗尽后做一次不带 tools 的收尾总结，确保给用户自然答复
  const finalTimeout = Math.max(4_000, Math.min(ctx.config.llm_timeout_ms, deadline - Date.now() + 4_000))
  const finalRes = await llm.chat({
    model,
    messages: history,
    temperature: ctx.config.temperature,
    max_tokens: ctx.config.max_output_tokens,
    timeout_ms: finalTimeout,
  })
  usage.runs += 1
  usage.inputTokens += finalRes.usage?.input_tokens ?? 0
  usage.outputTokens += finalRes.usage?.output_tokens ?? 0

  return {
    text: (finalRes.text ?? '').trim(),
    artifacts,
    toolLogs,
    usage,
    usedAgentLoop: true,
  }
}
