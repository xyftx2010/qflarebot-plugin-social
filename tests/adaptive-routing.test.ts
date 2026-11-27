import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockContext, createMockSession } from '@qqbot/sdk/testing'
import plugin from '../src/index.js'
import { defaultConfig } from '../src/config.js'
import { ensureSchema, resetSchemaReadyForTest } from '../src/store/schema.js'
import { summarizeRoutingObservability } from '../src/store/agent-db.js'
import { analyzeMessageIntent } from '../src/agent/intent-router.js'
import { parseEscalationDirective } from '../src/agent/escalation.js'
import { handleGroupChatEvent, resetDedupForTest } from '../src/chat/pipeline.js'
import type { ContextMessage, LLMChatRequest, LLMService } from '../src/types.js'
import { createSqliteTestDB } from './helpers/sqlite-db.js'

describe('V0.11.1 adaptive 3-channel routing, context coreference, escalation & observability', () => {
  beforeEach(() => {
    resetSchemaReadyForTest()
    resetDedupForTest()
  })

  it('routes casual statements with keywords to Fast Chat, but queries & follow-ups to Smart/Full', () => {
    // 1. 关键词命中但无查询意图 -> Fast Chat
    const casual = analyzeMessageIntent({
      text: '哈哈今天天气真好啊',
      recentMessages: [],
      config: defaultConfig,
      isExplicit: false,
      isAtMe: false,
      autoAgentCountToday: 0,
      externalTools: [],
      now: 1_000_000,
    })
    expect(casual.channel).toBe('fast')

    // 2. 自然语言问天气 -> Smart Tool Chat
    const wx = analyzeMessageIntent({
      text: '北京今天天气怎么样？会下雨吗',
      recentMessages: [],
      config: defaultConfig,
      isExplicit: false,
      isAtMe: false,
      autoAgentCountToday: 0,
      externalTools: [],
      now: 1_000_000,
    })
    expect(wx.channel).toBe('smart')
    expect(wx.candidateToolIds).toContain('social.weather')

    // 3. 上下文指代追问（前一句问北京天气，这句问“那上海呢？”） -> Smart Tool Chat
    const prior: ContextMessage[] = [
      { role: 'user', speakerKey: 'u1', speakerName: '小明', text: '北京今天天气怎么样？', atMe: false, ts: 990_000 },
      { role: 'assistant', speakerKey: 'bot', speakerName: '我', text: '北京今天晴天 22 度挺舒服的', atMe: false, ts: 995_000 },
    ]
    const followup = analyzeMessageIntent({
      text: '那上海呢？',
      recentMessages: prior,
      config: defaultConfig,
      isExplicit: false,
      isAtMe: false,
      autoAgentCountToday: 0,
      externalTools: [],
      now: 1_000_000,
    })
    expect(followup.channel).toBe('smart')
    expect(followup.candidateToolIds).toContain('social.weather')

    // 4. 多工具复杂意图（时间 + 天气）-> Full Agent
    const multi = analyzeMessageIntent({
      text: '现在几点了？顺便帮我查下上海天气怎么样',
      recentMessages: [],
      config: defaultConfig,
      isExplicit: false,
      isAtMe: false,
      autoAgentCountToday: 0,
      externalTools: [],
      now: 1_000_000,
    })
    expect(multi.channel).toBe('full')
    expect(multi.isMultiTool).toBe(true)
  })

  it('triggers weather tool naturally on non-@ group message with <= 3 candidate tools', async () => {
    const db = createSqliteTestDB()
    const seenReqs: LLMChatRequest[] = []
    let callIdx = 0

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
        seenReqs.push(req)
        callIdx += 1
        if (callIdx === 1) {
          return {
            text: '',
            tool_calls: [{ id: 'w1', name: 'social_weather', arguments: JSON.stringify({ city: '上海' }) }],
            alias: 'chat',
            provider: 'mock',
            model: 'mock',
            usage: { input_tokens: 90, output_tokens: 20 },
            latency_ms: 40,
          }
        }
        return {
          text: '上海现在 21 度多云，出门带件薄外套刚刚好！',
          alias: 'chat',
          provider: 'mock',
          model: 'mock',
          usage: { input_tokens: 130, output_tokens: 25 },
          latency_ms: 35,
        }
      }),
    }

    const mockFetch = vi.fn(async (url: string) => {
      if (url.includes('geocoding-api.open-meteo.com')) {
        return Response.json({ results: [{ name: '上海', country: '中国', latitude: 31.23, longitude: 121.47 }] })
      }
      return Response.json({
        current: { temperature_2m: 21, apparent_temperature: 20, relative_humidity_2m: 60, weather_code: 2, wind_speed_10m: 8 },
      })
    }) as unknown as typeof fetch

    const ctx = createMockContext(plugin, {
      config: {
        ...defaultConfig,
        cooldown_seconds: 0,
        enable_meme_reply: false,
        trigger_threshold: 20,
        base_reply_probability: 1,
      },
      db,
      services: { llm },
    })
    await ensureSchema(ctx.db)

    // 普通非 @ 消息自然问天气（不带 /ask，不 @ 机器人）
    const session = createMockSession({
      scene: 'group',
      event: 'qq.group.message',
      targetId: 'grp-smart',
      messageId: 'msg-smart-wx-1',
      content: '上海现在天气冷不冷呀？',
      atMe: false,
    })

    const out = await handleGroupChatEvent(session, ctx, {
      now: () => 1_000_000,
      random: () => 0.1,
      fetchImpl: mockFetch,
      awaitBackground: true,
    })

    expect(out.replied).toBe(true)
    expect(out.channel).toBe('smart')
    expect(out.candidateToolCount).toBeLessThanOrEqual(3)
    expect(out.toolCallsCount).toBe(1)
    expect(seenReqs[0]?.tools?.length).toBeLessThanOrEqual(3)
    expect(session.replies).toEqual(['上海现在 21 度多云，出门带件薄外套刚刚好！'])

    const obs = await summarizeRoutingObservability(ctx.db, 7, 1_000_000)
    const smartSummary = obs.channels.find((c) => c.channel === 'smart')
    expect(smartSummary?.count).toBe(1)
    expect(smartSummary?.totalToolCalls).toBe(1)
    expect(smartSummary?.falseTriggers).toBe(0)
  })

  it('supports Fast Chat model self-escalation (escalate & silence) without duplicate replies', async () => {
    expect(parseEscalationDirective('[[silence]]')).toEqual({ action: 'silence' })
    expect(parseEscalationDirective('[[escalate:social.web_search|需要查最新消息]]')).toEqual({
      action: 'escalate',
      requestedTools: ['social.web_search'],
      reason: '需要查最新消息',
    })

    const db = createSqliteTestDB()
    let step = 0
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
        step += 1
        // 第 1 次：Fast Chat（无 tools）自主申请升级查时间
        if (step === 1) {
          expect(req.tools).toBeUndefined()
          return {
            text: '[[escalate:social.get_time|需要确认当前时间]]',
            alias: 'chat',
            provider: 'mock',
            model: 'mock',
            usage: { input_tokens: 60, output_tokens: 15 },
            latency_ms: 25,
          }
        }
        // 第 2 次：升级到 Smart Tool Chat 后发起工具调用
        if (step === 2) {
          expect(req.tools?.some((t) => t.name === 'social_get_time')).toBe(true)
          return {
            text: '',
            tool_calls: [{ id: 't1', name: 'social_get_time', arguments: '{}' }],
            alias: 'chat',
            provider: 'mock',
            model: 'mock',
            usage: { input_tokens: 100, output_tokens: 15 },
            latency_ms: 30,
          }
        }
        // 第 3 次：基于工具结果自然回复
        return {
          text: '刚看了一眼表，已经不早啦，快摸鱼准备下班吧！',
          alias: 'chat',
          provider: 'mock',
          model: 'mock',
          usage: { input_tokens: 120, output_tokens: 20 },
          latency_ms: 25,
        }
      }),
    }

    const ctx = createMockContext(plugin, {
      config: {
        ...defaultConfig,
        cooldown_seconds: 0,
        enable_meme_reply: false,
        trigger_threshold: 20,
        base_reply_probability: 1,
      },
      db,
      services: { llm },
    })
    await ensureSchema(ctx.db)

    // 没有明显时间关键词的模糊说法 -> 先走 Fast Chat -> 模型自主升级 -> 只发 1 条回复
    const session = createMockSession({
      scene: 'group',
      event: 'qq.group.message',
      targetId: 'grp-esc',
      messageId: 'msg-esc-1',
      content: '小Q快下班了吧',
      atMe: false,
    })
    const out = await handleGroupChatEvent(session, ctx, {
      now: () => 2_000_000,
      random: () => 0.1,
      awaitBackground: true,
    })
    expect(out.replied).toBe(true)
    expect(out.escalated).toBe(true)
    expect(out.channel).toBe('smart')
    expect(out.toolCallsCount).toBe(1)
    expect(session.replies).toHaveLength(1)

    const obs = await summarizeRoutingObservability(ctx.db, 7, 2_000_000)
    expect(obs.totalEscalations).toBe(1)
  })

  it('enforces daily auto-agent budget and blocks unauthorized external tools during escalation', async () => {
    // 1. 超过单群每日自动工具次数限额 -> 非 @ 降级回 Fast Chat
    const limited = analyzeMessageIntent({
      text: '北京今天天气怎么样？',
      recentMessages: [],
      config: { ...defaultConfig, agent_auto_daily_limit: 5 },
      isExplicit: false,
      isAtMe: false,
      autoAgentCountToday: 5,
      externalTools: [],
      now: 1_000_000,
    })
    expect(limited.channel).toBe('fast')
    expect(limited.reason).toBe('auto-daily-limit-reached')

    // 2. 自主升级请求未授权工具 -> 绝不暴露给 LLM，仅提供已授权工具并安全完成回复
    const db = createSqliteTestDB()
    const seenToolNames: string[][] = []
    let step = 0
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
        step += 1
        seenToolNames.push((req.tools ?? []).map((t) => t.name))
        if (step === 1) {
          return {
            text: '[[escalate:danger.exec_shell|尝试越权]]',
            alias: 'chat',
            provider: 'mock',
            model: 'mock',
            latency_ms: 20,
          }
        }
        return {
          text: '这个我可帮不了，咱们聊点别的吧~',
          alias: 'chat',
          provider: 'mock',
          model: 'mock',
          latency_ms: 20,
        }
      }),
    }

    const ctx = createMockContext(plugin, {
      config: {
        ...defaultConfig,
        cooldown_seconds: 0,
        enable_meme_reply: false,
        trigger_threshold: 20,
        base_reply_probability: 1,
      },
      db,
      services: { llm },
    })
    await ensureSchema(ctx.db)

    const session = createMockSession({
      scene: 'group',
      event: 'qq.group.message',
      targetId: 'grp-sec',
      messageId: 'msg-sec-1',
      content: '小Q聊聊近况',
      atMe: false,
    })
    const out = await handleGroupChatEvent(session, ctx, {
      now: () => 3_000_000,
      random: () => 0.1,
      awaitBackground: true,
    })
    expect(out.replied).toBe(true)
    expect(seenToolNames[0]).toEqual([])
    expect(seenToolNames[1]?.some((n) => n.includes('exec_shell') || n.includes('danger'))).toBe(false)
    expect(session.replies).toEqual(['这个我可帮不了，咱们聊点别的吧~'])
  })
})
