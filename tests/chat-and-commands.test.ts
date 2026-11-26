import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockContext, createMockSession, runCommand } from '@qqbot/sdk/testing'
import plugin from '../src/index.js'
import { defaultConfig } from '../src/config.js'
import { resetSchemaReadyForTest } from '../src/store/schema.js'
import { handleGroupChatEvent } from '../src/chat/pipeline.js'
import { createSocialService } from '../src/chat/tools.js'
import type { AgentPromptService, LLMService } from '../src/types.js'
import { createSqliteTestDB } from './helpers/sqlite-db.js'

function createMockLlm(replyText = '哈哈这波确实有意思！') {
  const chat = vi.fn(async () => ({
    text: replyText,
    alias: 'chat-fast',
    provider: 'mock',
    model: 'mock-model',
    latency_ms: 120,
  }))
  const llm: LLMService = {
    contractVersion: 1,
    listModels: async () => [],
    resolve: async () => ({
      alias: 'chat-fast',
      provider: 'mock',
      provider_name: 'Mock',
      model: 'mock-model',
      capabilities: ['text'],
    }),
    chat,
  }
  return { llm, chat }
}

describe('chat pipeline, commands, tools & admin routes', () => {
  beforeEach(() => {
    resetSchemaReadyForTest()
  })

  it('tracks non-@ group messages for permission diagnostics and calls LLM only when triggered', async () => {
    const db = createSqliteTestDB()
    const { llm, chat } = createMockLlm('火锅必须安排毛肚和鸭肠！')
    const ctxOpts = {
      config: { ...defaultConfig, cooldown_seconds: 30 },
      db,
      services: { llm },
    }
    const ctx = createMockContext(plugin, ctxOpts)

    // 1. 普通低分消息：记录上下文与非@权限时间，但不调 LLM
    const s1 = createMockSession({
      scene: 'group',
      event: 'qq.group.message',
      targetId: 'grp-100',
      userId: 'u-1',
      groupNickname: '阿强',
      content: '今天上班好累',
      atMe: false,
    })
    const o1 = await handleGroupChatEvent(s1, ctx, { now: () => 1_000_000, random: () => 0.95 })
    expect(o1.replied).toBe(false)
    expect(chat).toHaveBeenCalledTimes(0)
    expect(s1.replies).toHaveLength(0)

    // 2. 命中呼唤词的消息：触发 1 次 LLM 调用并被动回复
    const s2 = createMockSession({
      scene: 'group',
      event: 'qq.group.message',
      targetId: 'grp-100',
      userId: 'u-2',
      groupNickname: '小美',
      content: '小Q今晚吃火锅点啥菜好？',
      atMe: false,
    })
    const o2 = await handleGroupChatEvent(s2, ctx, { now: () => 1_005_000, random: () => 0.95 })
    expect(o2.replied).toBe(true)
    expect(chat).toHaveBeenCalledTimes(1)
    expect(s2.replies).toEqual(['火锅必须安排毛肚和鸭肠！'])

    // 3. /social status 能看到非@全量消息已收到
    const statusSession = await runCommand(plugin, 'social status', '', {
      session: { scene: 'group', targetId: 'grp-100' },
      ctx: ctxOpts,
    })
    expect(String(statusSession.replies[0])).toContain('非@全量消息权限：已收到')
    expect(String(statusSession.replies[0])).toContain('LLM 服务：正常（chat-fast）')
  })

  it('supports member self-service privacy commands, admin commands, and v5 group-isolated tools', async () => {
    const db = createSqliteTestDB()
    const { llm } = createMockLlm()
    const registerPrompt = vi.fn(async () => true)
    const agent: AgentPromptService = {
      registerPrompt,
      disablePrompt: async () => true,
      clearPrompt: async () => true,
      listPrompts: async () => [],
    }
    const ctxOpts = {
      config: defaultConfig,
      db,
      services: { llm, agent },
    }
    const ctx = createMockContext(plugin, ctxOpts)

    // 群管理员切换人格并同步到 Agent
    const personaSession = await runCommand(plugin, 'social persona', 'witty', {
      session: { scene: 'group', targetId: 'grp-200', memberRole: 'admin' },
      ctx: ctxOpts,
    })
    expect(String(personaSession.replies[0])).toContain('幽默吐槽役')

    const syncSession = await runCommand(plugin, 'social sync', '', {
      session: { scene: 'group', targetId: 'grp-200', memberRole: 'admin' },
      ctx: ctxOpts,
    })
    expect(registerPrompt).toHaveBeenCalledTimes(1)
    expect(String(syncSession.replies[0])).toContain('幽默吐槽役')

    // 群管理员添加记忆，然后用 v5 service 工具验证群级隔离查询
    const addMemSession = await runCommand(plugin, 'social memory', 'add 周五晚上八点一起打排位', {
      session: { scene: 'group', targetId: 'grp-200', memberRole: 'owner' },
      ctx: ctxOpts,
    })
    expect(String(addMemSession.replies[0])).toContain('已添加本群公共记忆')

    const svc = createSocialService(ctx)
    const found = await svc.searchMemory('grp-200', '排位', 5)
    expect(found.memories).toHaveLength(1)
    const otherGroup = await svc.searchMemory('grp-999', '排位', 5)
    expect(otherGroup.memories).toHaveLength(0)

    // 普通成员执行 /social privacy off
    const memberSession = await runCommand(plugin, 'social privacy', 'off', {
      session: { scene: 'group', targetId: 'grp-200', userId: 'u-normal', memberRole: 'member' },
      ctx: ctxOpts,
    })
    expect(String(memberSession.replies[0])).toContain('已为你关闭本群的个人记忆收集')
  })

  it('serves admin overview and memory APIs cleanly', async () => {
    const db = createSqliteTestDB()
    const { llm } = createMockLlm()
    const ctx = createMockContext(plugin, {
      config: defaultConfig,
      db,
      services: { llm },
    })

    const overviewRoute = plugin.routes?.find((r) => r.method === 'GET' && r.path === '/api/overview')
    expect(overviewRoute).toBeDefined()
    const res = await overviewRoute!.handler({
      ctx,
      request: new Request('https://bot.example.com/p/social/api/overview'),
      params: {},
      authenticated: true,
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { ok: boolean; personas: unknown[] }
    expect(json.ok).toBe(true)
    expect(json.personas.length).toBeGreaterThanOrEqual(3)
  })
})
