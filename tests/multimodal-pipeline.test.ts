import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockContext, createMockSession } from '@qqbot/sdk/testing'
import plugin from '../src/index.js'
import { defaultConfig } from '../src/config.js'
import { ensureSchema, resetSchemaReadyForTest } from '../src/store/schema.js'
import { listActiveGroupMemories } from '../src/store/db.js'
import { listMultimodalStats } from '../src/store/multimodal-db.js'
import { handleGroupChatEvent } from '../src/chat/pipeline.js'
import { collectMemeFromSession } from '../src/meme/store.js'
import { extractCandidateMemory } from '../src/memory/store.js'
import type { LLMChatRequest, LLMService } from '../src/types.js'
import { createSqliteTestDB } from './helpers/sqlite-db.js'
import { createMockR2 } from './helpers/mock-r2.js'

const SAMPLE_IMG = new Uint8Array([137, 80, 78, 71, 1, 3, 5, 7, 9])

describe('multimodal pipeline: vision + memory linkage + meme reply + timeout/rate-limit/send-fail', () => {
  beforeEach(() => {
    resetSchemaReadyForTest()
  })

  it('does not save jokes/sarcasm or vision-inferred attributes into long-term memory', () => {
    expect(extractCandidateMemory('哈哈开玩笑的我是亿万富翁')).toBeNull()
    expect(extractCandidateMemory('我喜欢大概可能反讽吧')).toBeNull()
    expect(extractCandidateMemory('[发送了图片]')).toBeNull()
    expect(extractCandidateMemory('我超喜欢玩怪物猎人')?.content).toBe('我超喜欢玩怪物猎人')
  })

  it('runs end-to-end vision -> reply + meme -> stats and degrades to text when image reply fails', async () => {
    const db = createSqliteTestDB()
    const r2 = createMockR2()
    const seenRequests: LLMChatRequest[] = []

    const llm: LLMService = {
      contractVersion: 1,
      listModels: async () => [],
      resolve: async (alias) => ({
        alias: alias ?? 'vl-chat',
        provider: 'mock',
        provider_name: 'Mock',
        model: 'mock-vl',
        capabilities: ['text', 'image'],
      }),
      chat: vi.fn(async (req: LLMChatRequest) => {
        seenRequests.push(req)
        const isVision = Array.isArray(req.messages[1]?.content)
        return {
          text: isVision
            ? JSON.stringify({
                summary: '群友晒了一碗加满辣椒油的麻辣烫',
                ocrText: '',
                memeMeaning: '深夜放毒搞笑',
                mood: '搞笑',
                tags: ['深夜放毒', '麻辣烫', '搞笑'],
                sceneHints: '有人晒美食时',
              })
            : '大晚上的放毒太离谱了哈哈！',
          alias: 'vl-chat',
          provider: 'mock',
          model: 'mock-vl',
          latency_ms: 100,
        }
      }),
    }

    const ctx = createMockContext(plugin, {
      config: {
        ...defaultConfig,
        yield_at_to_agent: false,
        enable_vision: true,
        enable_meme_reply: true,
        meme_send_probability: 1,
        cooldown_seconds: 0,
      },
      db,
      r2,
      publicUrl: 'https://bot.example.com',
      services: { llm },
    })
    await ensureSchema(ctx.db)

    const fetchImg = vi.fn(
      async () => new Response(SAMPLE_IMG, { status: 200, headers: { 'content-type': 'image/png' } }),
    ) as unknown as typeof fetch

    // 1. 先收藏一张“搞笑/深夜放毒”表情包到本群
    const collectSession = createMockSession({
      scene: 'group',
      targetId: 'grp-mm',
      attachments: [{ url: 'https://cdn.example.com/meme1.png', contentType: 'image/png' }],
    })
    const collected = await collectMemeFromSession(collectSession, ctx, {
      scope: 'group',
      extraTags: ['深夜放毒'],
      now: 1_000_000,
      fetchImpl: fetchImg,
    })
    expect(collected.ok).toBe(true)

    // 2. 群友发图 @机器人：应触发图片理解（命中缓存）+ 文本+表情包回复，且不写长期记忆
    const chatSession = createMockSession({
      scene: 'group',
      event: 'qq.group.at_message',
      targetId: 'grp-mm',
      userId: 'u-foodie',
      groupNickname: '吃货',
      content: '看看我夜宵',
      atMe: true,
      attachments: [{ url: 'https://cdn.example.com/night-food.png', contentType: 'image/png' }],
    })
    const outcome = await handleGroupChatEvent(chatSession, ctx, {
      now: () => 1_005_000,
      random: () => 0.4,
      fetchImpl: fetchImg,
      awaitBackground: true,
    })

    expect(outcome.replied).toBe(true)
    expect(outcome.visionUsed).toBe(true)
    expect(outcome.replyStyle).toBe('text_and_meme')
    expect(chatSession.replies).toHaveLength(1)
    expect(chatSession.replies[0]).toMatchObject({
      text: '大晚上的放毒太离谱了哈哈！',
      image: { url: expect.stringContaining('/p/social/meme/') },
    })
    // 长期记忆不应写入视觉推断内容
    expect(await listActiveGroupMemories(ctx.db, 'grp-mm', 1_006_000)).toHaveLength(0)

    const stats = await listMultimodalStats(ctx.db, 1)
    expect(stats[0]?.memeCollected).toBe(1)
    expect(stats[0]?.memeSent).toBe(1)

    // 3. 测试带图发送失败时自动降级为纯文本回复
    const failImgSession = createMockSession({
      scene: 'group',
      event: 'qq.group.at_message',
      targetId: 'grp-mm',
      userId: 'u-foodie',
      content: '再来一次深夜放毒',
      atMe: true,
    })
    let replyAttempts = 0
    const origReply = failImgSession.reply.bind(failImgSession)
    failImgSession.reply = async (msg) => {
      replyAttempts += 1
      if (typeof msg !== 'string') {
        return { ok: false, status: 500, error: '媒体上传失败', raw: null }
      }
      return origReply(msg)
    }

    const fallbackOutcome = await handleGroupChatEvent(failImgSession, ctx, {
      now: () => 1_500_000,
      random: () => 0.4,
      awaitBackground: true,
    })
    expect(fallbackOutcome.replied).toBe(true)
    expect(fallbackOutcome.replyStyle).toBe('text')
    expect(replyAttempts).toBe(2)
    expect(failImgSession.replies).toEqual(['大晚上的放毒太离谱了哈哈！'])
  })

  it('handles vision timeout and vision rate limit cleanly without breaking chat', async () => {
    const db = createSqliteTestDB()
    const llm: LLMService = {
      contractVersion: 1,
      listModels: async () => [],
      resolve: async () => ({
        alias: 'vl',
        provider: 'mock',
        provider_name: 'Mock',
        model: 'mock-vl',
        capabilities: ['text', 'image'],
      }),
      chat: vi.fn(async (req: LLMChatRequest) => {
        if (Array.isArray(req.messages[1]?.content)) {
          throw new Error('upstream timeout')
        }
        return {
          text: '图没加载出来不过听着挺有意思！',
          alias: 'vl',
          provider: 'mock',
          model: 'mock-vl',
          latency_ms: 50,
        }
      }),
    }

    const ctx = createMockContext(plugin, {
      config: { ...defaultConfig, yield_at_to_agent: false, enable_vision: true, enable_meme_reply: false },
      db,
      services: { llm },
    })
    await ensureSchema(ctx.db)

    const session = createMockSession({
      scene: 'group',
      event: 'qq.group.at_message',
      targetId: 'grp-timeout',
      content: '快看这图',
      atMe: true,
      attachments: [{ url: 'https://cdn.example.com/slow.png', contentType: 'image/png' }],
    })
    const outcome = await handleGroupChatEvent(session, ctx, {
      now: () => 2_000_000,
      fetchImpl: vi.fn(
        async () => new Response(SAMPLE_IMG, { status: 200, headers: { 'content-type': 'image/png' } }),
      ) as unknown as typeof fetch,
      awaitBackground: true,
    })

    expect(outcome.replied).toBe(true)
    expect(outcome.visionUsed).toBe(false)
    expect(session.replies).toEqual(['图没加载出来不过听着挺有意思！'])
    const stats = await listMultimodalStats(ctx.db, 1)
    expect(stats[0]?.visionErrors).toBe(1)
  })
})
