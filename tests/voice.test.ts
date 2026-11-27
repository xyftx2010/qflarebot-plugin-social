import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockContext, createMockSession } from '@qqbot/sdk/testing'
import plugin from '../src/index.js'
import { defaultConfig } from '../src/config.js'
import { ensureSchema, resetSchemaReadyForTest } from '../src/store/schema.js'
import { listRecentVoiceLogs, summarizeVoiceUsage } from '../src/store/voice-db.js'
import { synthesizeSpeech } from '../src/voice/providers.js'
import {
  decideVoiceReply,
  parseVoiceDirective,
  resolveEffectiveVoiceConfig,
} from '../src/voice/decision.js'
import { generateTestToneWav } from '../src/voice/probe.js'
import { handleGroupChatEvent } from '../src/chat/pipeline.js'
import type { LLMService } from '../src/types.js'
import { createSqliteTestDB } from './helpers/sqlite-db.js'
import { createMockR2 } from './helpers/mock-r2.js'

function bytesToHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

describe('voice: TTS providers, smart decision, cache, fallback & admin overview', () => {
  beforeEach(() => {
    resetSchemaReadyForTest()
  })

  it('adapts MiniMax, Qwen, and OpenAI Compatible TTS providers cleanly', async () => {
    const sampleWav = generateTestToneWav(200)
    const sampleHex = bytesToHex(sampleWav)

    // 1. MiniMax hex decode
    const fetchMiniMax = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      expect(body.model).toBe('speech-02-turbo')
      expect((body.voice_setting as Record<string, unknown>).emotion).toBe('happy')
      return Response.json({ base_resp: { status_code: 0 }, data: { audio: sampleHex } })
    }) as unknown as typeof fetch

    const mmRes = await synthesizeSpeech(
      {
        text: '测试语音',
        provider: 'minimax',
        apiBaseUrl: '',
        apiKey: 'sk-test',
        model: 'speech-02-turbo',
        voiceId: 'male-qn-qingse',
        speed: 1.1,
        pitch: 1,
        volume: 1,
        emotion: 'happy',
        format: 'wav',
        timeoutMs: 5000,
      },
      fetchMiniMax,
    )
    expect(mmRes.sizeBytes).toBe(sampleWav.byteLength)
    expect(mmRes.contentType).toBe('audio/wav')

    // 2. Qwen DashScope URL download
    const fetchQwen = vi.fn(async (url: string) => {
      if (url.includes('dashscope')) {
        return Response.json({ output: { audio: { url: 'https://cdn.example.com/qwen.wav' } } })
      }
      return new Response(sampleWav, { status: 200, headers: { 'content-type': 'audio/wav' } })
    }) as unknown as typeof fetch

    const qwenRes = await synthesizeSpeech(
      {
        text: '千问测试',
        provider: 'qwen',
        apiBaseUrl: '',
        apiKey: 'sk-qwen',
        model: 'qwen-tts',
        voiceId: 'Cherry',
        speed: 1,
        pitch: 0,
        volume: 1,
        emotion: '',
        format: 'wav',
        timeoutMs: 5000,
      },
      fetchQwen,
    )
    expect(qwenRes.sizeBytes).toBe(sampleWav.byteLength)

    // 3. OpenAI Compatible TTS (/v1 suffix auto-appends /audio/speech)
    const fetchOpenAI = vi.fn(async (url: string) => {
      expect(url).toBe('https://tts.example.com/v1/audio/speech')
      return new Response(sampleWav, { status: 200, headers: { 'content-type': 'audio/wav' } })
    }) as unknown as typeof fetch

    const oaiRes = await synthesizeSpeech(
      {
        text: 'openai test',
        provider: 'openai',
        apiBaseUrl: 'https://tts.example.com/v1',
        apiKey: 'sk-oai',
        model: 'tts-1',
        voiceId: 'alloy',
        speed: 1.0,
        pitch: 0,
        volume: 1,
        emotion: 'calm',
        format: 'wav',
        timeoutMs: 5000,
      },
      fetchOpenAI,
    )
    expect(oaiRes.sizeBytes).toBe(sampleWav.byteLength)
  })

  it('parses single-pass AI voice directive and enforces trigger modes, char limit & daily quota', () => {
    const parsed = parseVoiceDirective('[[voice:happy]] 哈哈太棒啦！')
    expect(parsed).toEqual({ aiRequestedVoice: true, emotion: 'happy', cleanText: '哈哈太棒啦！' })

    const plain = parseVoiceDirective('普通文字回复')
    expect(plain).toEqual({ aiRequestedVoice: false, emotion: '', cleanText: '普通文字回复' })

    const effective = resolveEffectiveVoiceConfig({
      ...defaultConfig,
      enable_voice: true,
      tts_api_key: 'sk-key',
      voice_trigger_mode: 'ai',
      voice_daily_limit_per_group: 5,
    })

    // 超过字符数限制 -> 降级文字
    const tooLong = decideVoiceReply({
      effective,
      maxChars: 10,
      sentToday: 0,
      userText: 'hi',
      replyText: '这是一段超过十个字的长回复文本',
      aiRequestedVoice: true,
      aiEmotion: 'happy',
    })
    expect(tooLong.useVoice).toBe(false)
    expect(tooLong.reason).toBe('exceeds-max-chars')

    // 达到每日上限 -> 降级文字
    const quotaHit = decideVoiceReply({
      effective,
      maxChars: 80,
      sentToday: 5,
      userText: 'hi',
      replyText: '好呀',
      aiRequestedVoice: true,
      aiEmotion: 'happy',
    })
    expect(quotaHit.useVoice).toBe(false)
    expect(quotaHit.reason).toBe('daily-limit-reached')
  })

  it('sends native voice without duplicate text, caches repeated TTS, and falls back to text on TTS error', async () => {
    const db = createSqliteTestDB()
    const r2 = createMockR2()
    const sampleWav = generateTestToneWav(200)
    const sampleHex = bytesToHex(sampleWav)

    const llm: LLMService = {
      contractVersion: 1,
      listModels: async () => [],
      resolve: async () => ({
        alias: 'chat',
        provider: 'mock',
        provider_name: 'Mock',
        model: 'mock-chat',
        capabilities: ['text'],
      }),
      chat: vi.fn(async () => ({
        text: '[[voice:happy]] 晚安早点睡呀！',
        alias: 'chat',
        provider: 'mock',
        model: 'mock-chat',
        latency_ms: 80,
      })),
    }

    const fetchTts = vi.fn(async () =>
      Response.json({ base_resp: { status_code: 0 }, data: { audio: sampleHex } }),
    ) as unknown as typeof fetch

    const ctx = createMockContext(plugin, {
      config: {
        ...defaultConfig,
        yield_at_to_agent: false,
        cooldown_seconds: 0,
        enable_meme_reply: false,
        enable_voice: true,
        tts_provider: 'minimax',
        tts_api_key: 'sk-secret-key-do-not-leak',
        voice_trigger_mode: 'ai',
        voice_fallback_to_text: true,
      },
      db,
      r2,
      services: { llm },
    })
    await ensureSchema(ctx.db)

    // 1. 首次 AI 决策发语音：只发 1 条原生语音，不重复发文字
    const s1 = createMockSession({
      scene: 'group',
      event: 'qq.group.at_message',
      targetId: 'grp-voice',
      content: '准备睡了',
      atMe: true,
    })
    const o1 = await handleGroupChatEvent(s1, ctx, {
      now: () => 1_000_000,
      fetchImpl: fetchTts,
      awaitBackground: true,
    })
    expect(o1.replied).toBe(true)
    expect(o1.replyStyle).toBe('voice')
    expect(o1.voiceUsed).toBe(true)
    expect(o1.voiceCached).toBe(false)
    expect(s1.replies).toHaveLength(1)
    expect(s1.replies[0]).toMatchObject({ media: { type: 'voice', filename: 'voice.wav' } })
    expect(fetchTts).toHaveBeenCalledTimes(1)

    // 2. 相同文本与参数二次触发：直接命中 R2 缓存，0 次额外 TTS 请求
    const s2 = createMockSession({
      scene: 'group',
      event: 'qq.group.at_message',
      targetId: 'grp-voice',
      content: '我也睡了',
      atMe: true,
    })
    const o2 = await handleGroupChatEvent(s2, ctx, {
      now: () => 1_005_000,
      fetchImpl: fetchTts,
      awaitBackground: true,
    })
    expect(o2.replied).toBe(true)
    expect(o2.voiceCached).toBe(true)
    expect(fetchTts).toHaveBeenCalledTimes(1)

    // 3. TTS 失败时自动降级为纯文本回复，且日志记为 fallback_text
    const failCtx = createMockContext(plugin, {
      config: {
        ...defaultConfig,
        yield_at_to_agent: false,
        cooldown_seconds: 0,
        enable_meme_reply: false,
        enable_voice: true,
        tts_provider: 'openai',
        tts_api_key: 'sk-fail',
        voice_trigger_mode: 'always',
        voice_fallback_to_text: true,
      },
      db,
      r2,
      services: { llm },
    })
    const s3 = createMockSession({
      scene: 'group',
      event: 'qq.group.at_message',
      targetId: 'grp-voice',
      content: '说句话',
      atMe: true,
    })
    const o3 = await handleGroupChatEvent(s3, failCtx, {
      now: () => 1_010_000,
      fetchImpl: vi.fn(async () => new Response('Bad Gateway', { status: 502 })) as unknown as typeof fetch,
      awaitBackground: true,
    })
    expect(o3.replied).toBe(true)
    expect(o3.replyStyle).toBe('text')
    expect(s3.replies).toEqual(['晚安早点睡呀！'])

    const logs = await listRecentVoiceLogs(ctx.db, 10)
    expect(logs).toHaveLength(3)
    const usage = await summarizeVoiceUsage(ctx.db, 0)
    expect(usage.totalSent).toBe(2)
    expect(usage.totalCached).toBe(1)
    expect(usage.totalFallback).toBe(1)

    // 4. 管理页语音概览接口绝不泄露 API Key 明文
    const voiceOverviewRoute = plugin.routes?.find((r) => r.method === 'GET' && r.path === '/api/voice/overview')
    expect(voiceOverviewRoute).toBeDefined()
    const res = await voiceOverviewRoute!.handler({
      ctx,
      request: new Request('https://bot.example.com/p/social/api/voice/overview'),
      params: {},
      authenticated: true,
    })
    const textBody = await res.text()
    expect(textBody).not.toContain('sk-secret-key-do-not-leak')
    expect(JSON.parse(textBody).config.hasApiKey).toBe(true)
  })
})
