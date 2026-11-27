import {
  CORE_TOOLS_SERVICE,
  type PluginContext,
  type PluginToolArtifact,
  type PluginToolDescriptor,
  type PluginToolRegistry,
  type ToolInvocation,
} from '@qqbot/sdk'
import type { AgentToolPolicy, LLMToolDefinition, SocialConfig } from '../types.js'

export interface BoundExternalTool {
  wireName: string
  descriptor: PluginToolDescriptor
}

export interface DiscoveredExternalTools {
  registry: PluginToolRegistry
  invocation: ToolInvocation
  tools: BoundExternalTool[]
  definitions: LLMToolDefinition[]
}

export function tryGetCoreTools(ctx: PluginContext<SocialConfig>): PluginToolRegistry | null {
  try {
    return ctx.service<PluginToolRegistry>(CORE_TOOLS_SERVICE)
  } catch {
    return null
  }
}

function toSafeWireName(toolId: string, used: Set<string>): string {
  const sanitized = `plugin_${toolId.replace(/[^a-zA-Z0-9_-]/g, '_')}`
  let candidate = sanitized.length <= 64 ? sanitized : sanitized.slice(0, 56)
  if (!used.has(candidate)) {
    used.add(candidate)
    return candidate
  }
  let idx = 2
  while (used.has(`${candidate.slice(0, 60)}_${idx}`)) idx += 1
  const unique = `${candidate.slice(0, 60)}_${idx}`
  used.add(unique)
  return unique
}

/**
 * 通过框架 SDK v5 `core.tools` 发现外部插件工具：
 * - 使用 `capture()` 签发原始发起人凭据，不伪造身份；
 * - 严格按管理员显式白名单 `policy.enabledExternalTools` 过滤；
 * - 默认拦截 `external_write` / `dangerous` 副作用工具。
 */
export async function discoverExternalTools(
  ctx: PluginContext<SocialConfig>,
  policy: AgentToolPolicy,
): Promise<DiscoveredExternalTools | null> {
  if (policy.enabledExternalTools.length === 0) return null
  const registry = tryGetCoreTools(ctx)
  if (!registry) return null

  let invocation: ToolInvocation
  try {
    invocation = await registry.capture()
  } catch {
    return null
  }

  let descriptors: PluginToolDescriptor[]
  try {
    descriptors = await registry.list(invocation)
  } catch {
    return null
  }

  const allowedSet = new Set(policy.enabledExternalTools)
  const usedNames = new Set<string>()
  const bound: BoundExternalTool[] = []

  for (const desc of descriptors) {
    // 禁止递归调用自身公开的工具
    if (desc.owner === ctx.plugin.name) continue
    if (!allowedSet.has(desc.id)) continue
    if (!policy.allowExternalWrites && (desc.sideEffect === 'external_write' || desc.sideEffect === 'dangerous')) {
      continue
    }
    const wireName = toSafeWireName(desc.id, usedNames)
    bound.push({ wireName, descriptor: desc })
  }

  if (bound.length === 0) return null

  return {
    registry,
    invocation,
    tools: bound,
    definitions: bound.map(({ wireName, descriptor }) => ({
      name: wireName,
      description: descriptor.description,
      parameters: descriptor.inputSchema,
    })),
  }
}

export async function invokeExternalTool(
  discovered: DiscoveredExternalTools,
  bound: BoundExternalTool,
  input: unknown,
  opts: { timeoutMs: number; deadline: number },
): Promise<{
  ok: boolean
  status: 'success' | 'failed' | 'timeout' | 'denied'
  output: unknown
  artifacts: PluginToolArtifact[]
  error?: string
}> {
  const { registry, invocation } = discovered
  const { descriptor } = bound

  // 调用前按官方契约通过 describe() 复核可见性与 revision
  const verified = await registry.describe(descriptor.id, invocation).catch(() => null)
  if (!verified) {
    return {
      ok: false,
      status: 'denied',
      output: null,
      artifacts: [],
      error: `工具 ${descriptor.id} 当前不可用或无权调用`,
    }
  }

  const remainingMs = Math.max(1000, Math.min(opts.timeoutMs, opts.deadline - Date.now()))
  const result = await registry.invoke(verified.id, input, {
    invocation,
    callId: crypto.randomUUID(),
    expectedRevision: verified.revision,
    signal: AbortSignal.timeout(remainingMs),
    deadline: Math.min(opts.deadline, Date.now() + remainingMs),
  })

  if (result.status === 'success') {
    return {
      ok: true,
      status: 'success',
      output: result.output ?? { ok: true },
      artifacts: result.artifacts ?? [],
    }
  }

  const mappedStatus =
    result.status === 'timeout'
      ? 'timeout'
      : result.status === 'permission_denied'
        ? 'denied'
        : 'failed'
  return {
    ok: false,
    status: mappedStatus,
    output: result.output ?? null,
    artifacts: result.artifacts ?? [],
    error: result.error?.message ?? `外部工具调用失败（${result.status}）`,
  }
}
