import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CORE_TOOLS_SERVICE, type PluginToolDescriptor, type PluginToolRegistry } from '@qqbot/sdk'
import { createMockContext, createMockSession } from '@qqbot/sdk/testing'
import plugin from '../src/index.js'
import { defaultConfig } from '../src/config.js'
import { ensureSchema, resetSchemaReadyForTest } from '../src/store/schema.js'
import { listLLMUsageStats, listRecentToolLogs, saveAgentToolPolicy } from '../src/store/agent-db.js'
import { handleGroupChatEvent, resetDedupForTest } from '../src/chat/pipeline.js'
import type { AgentPromptService, LLMChatRequest, LLMService } from '../src/types.js'
import { createSqliteTestDB } from './helpers/sqlite-db.js'

describe('V0.11.0 Social Agent Engine: fast chat, ReAct loop, core.tools, dedup & AgentService', () => {
  beforeEach(() => {
    resetSchemaReadyForTest()
    resetDedupForTest()
  })

  it('uses fast chat without tools for non-@ banter, and ReAct tool loop for @me with builtin + external core.tools', async () => {
    const db = createSqliteTestDB()
    const seenRequests: LLMChatRequest[] = []
    let step = 0

    const llm: LLMService = {
      contractVersion: 1,
      listModels: async () => [],
      resolve: async () => ({
        alias: 'chat',
        provider: 'mock',
        provider_name: 'Mock',
        model: 'mock-model',
        capabilities: ['text', 'tools'],
      }),
      chat: vi.fn(async (req: LLMChatRequest) => {
        seenRequests.push(req)
        if (!req.tools?.length) {
          return {
            text: '快通道秒回！',
            alias: 'chat',
            provider: 'mock',
            model: 'mock-model',
            usage: { input_tokens: 50, output_tokens: 10 },
            latency_ms: 40,
          }
        }
        step += 1
        if (step === 1) {
          return {
            text: '',
            tool_calls: [
              { id: 'c1', name: 'social_roll', arguments: JSON.stringify({ options: ['火锅', '烧烤'] }) },
              { id: 'c2', name: 'plugin_t2i_render', arguments: JSON.stringify({ html: '<h1>今晚吃火锅</h1>' }) },
            ],
            alias: 'chat',
            provider: 'mock',
            model: 'mock-model',
            usage: { input_tokens: 120, output_tokens: 30 },
            latency_ms: 60,
          }
        }
        return {
          text: '帮你抽好了，今晚就吃火锅！',
          alias: 'chat',
          provider: 'mock',
          model: 'mock-model',
          usage: { input_tokens: 200, output_tokens: 20 },
          latency_ms: 50,
        }
      }),
    }

    const t2iDesc: PluginToolDescriptor = {
      id: 't2i.render',
      owner: 't2i',
      name: 'render',
      description: '将 HTML 渲染为图片卡片',
      inputSchema: { type: 'object', properties: { html: { type: 'string' } } },
      permission: 'member',
      sideEffect: 'none',
      revision: 'rev-1',
      timeoutMs: 8000,
    }

    const invokeSpy = vi.fn(async () => ({
      status: 'success' as const,
      output: { rendered: true },
      artifacts: [{ type: 'image' as const, url: 'https://bot.example.com/p/t2i/card.png' }],
    }))

    const coreTools: PluginToolRegistry = {
      contractVersion: 1,
      capture: async () => ({ token: 'signed-inv-token' }),
      list: async () => [t2iDesc],
      describe: async (id) => (id === 't2i.render' ? t2iDesc : null),
      invoke: invokeSpy,
    }

    const ctx = createMockContext(plugin, {
      config: { ...defaultConfig, cooldown_seconds: 0, enable_meme_reply: false, enable_agent_tools: true },
      db,
      services: { llm, [CORE_TOOLS_SERVICE]: coreTools },
    })
    await ensureSchema(ctx.db)
    await saveAgentToolPolicy(ctx.db, { enabledExternalTools: ['t2i.render'] })

    // 1. 非 @ 普通闲聊插话 -> 快通道（不传 tools）
    const nonAt = createMockSession({
      scene: 'group',
      event: 'qq.group.message',
      targetId: 'grp-agent',
      messageId: 'msg-non-at-1',
      content: '小Q今天心情真不错呀',
      atMe: false,
    })
    const oFast = await handleGroupChatEvent(nonAt, ctx, { now: () => 1_000_000, random: () => 0.1, awaitBackground: true })
    expect(oFast.replied).toBe(true)
    expect(oFast.usedAgentLoop).toBe(false)
    expect(seenRequests[0]?.tools).toBeUndefined()

    // 2. @机器人 -> Agent Loop 调用内置 social.roll + 外部 core.tools t2i.render 并交付图片附件
    const atSession = createMockSession({
      scene: 'group',
      event: 'qq.group.at_message',
      targetId: 'grp-agent',
      messageId: 'msg-at-1',
      content: '帮我抽一下今晚吃啥并画张图',
      atMe: true,
    })
    const oAgent = await handleGroupChatEvent(atSession, ctx, {
      now: () => 1_005_000,
      random: () => 0.1,
      awaitBackground: true,
    })
    expect(oAgent.replied).toBe(true)
    expect(oAgent.usedAgentLoop).toBe(true)
    expect(oAgent.toolCallsCount).toBe(2)
    expect(invokeSpy).toHaveBeenCalledTimes(1)
    expect(atSession.replies[0]).toMatchObject({
      text: '帮你抽好了，今晚就吃火锅！',
      image: { url: 'https://bot.example.com/p/t2i/card.png' },
    })

    // 3. 相同 messageId 重试投递 -> 去重拦截不重复回复
    const dupSession = createMockSession({
      scene: 'group',
      event: 'qq.group.at_message',
      targetId: 'grp-agent',
      messageId: 'msg-at-1',
      content: '帮我抽一下今晚吃啥并画张图',
      atMe: true,
    })
    const oDup = await handleGroupChatEvent(dupSession, ctx, { now: () => 1_006_000, awaitBackground: true })
    expect(oDup.replied).toBe(false)
    expect(oDup.reason).toBe('duplicate-event')

    // 4. 验证 D1 模型用量与工具执行日志已落库
    const usage = await listLLMUsageStats(ctx.db, 1)
    expect(usage[0]?.runs).toBe(3)
    expect(usage[0]?.toolCalls).toBe(2)
    const logs = await listRecentToolLogs(ctx.db, 10)
    expect(logs.map((l) => l.toolId)).toContain('social.roll')
    expect(logs.map((l) => l.toolId)).toContain('t2i.render')
  })

  it('prevents infinite repeated tool call loops and supports compatible services.agent prompt fragments', async () => {
    const db = createSqliteTestDB()
    let callCount = 0
    const llm: LLMService = {
      contractVersion: 1,
      listModels: async () => [],
      resolve: async () => ({
        alias: 'chat',
        provider: 'mock',
        provider_name: 'Mock',
        model: 'mock',
        capabilities: ['text', 'tools'],
      }),
      chat: vi.fn(async (req: LLMChatRequest) => {
        callCount += 1
        // 确认注册的提示词片段已拼进 system prompt
        expect(String(req.messages[0]?.content)).toContain('回答天气时先用工具查')
        if (req.tools?.length && callCount <= 2) {
          return {
            text: '',
            tool_calls: [{ id: `dup_${callCount}`, name: 'social_get_time', arguments: '{}' }],
            alias: 'chat',
            provider: 'mock',
            model: 'mock',
            latency_ms: 20,
          }
        }
        return {
          text: '现在是北京时间下午，已停止重复查时间！',
          alias: 'chat',
          provider: 'mock',
          model: 'mock',
          latency_ms: 20,
        }
      }),
    }

    const ctx = createMockContext(plugin, {
      config: { ...defaultConfig, cooldown_seconds: 0, enable_meme_reply: false },
      db,
      services: { llm },
    })
    await ensureSchema(ctx.db)

    // 通过兼容的 services.agent 注册提示词片段
    const agentSvc = plugin.services?.agent?.(ctx) as AgentPromptService
    expect(await agentSvc.registerPrompt('weather', '回答天气时先用工具查', 5)).toBe(true)
    expect(await agentSvc.registerPrompt('weather', '回答天气时先用工具查', 5)).toBe(false)
    expect(await agentSvc.listPrompts()).toHaveLength(1)

    const session = createMockSession({
      scene: 'group',
      event: 'qq.group.at_message',
      targetId: 'grp-loop',
      messageId: 'msg-loop-1',
      content: '现在几点了',
      atMe: true,
    })
    const out = await handleGroupChatEvent(session, ctx, { now: () => 2_000_000, awaitBackground: true })
    expect(out.replied).toBe(true)
    expect(out.toolCallsCount).toBe(1) // 第二次重复调用被死循环守卫拦截
    expect(session.replies[0]).toBe('现在是北京时间下午，已停止重复查时间！')
  })
})
