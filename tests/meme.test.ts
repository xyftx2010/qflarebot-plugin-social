import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockContext, createMockSession } from '@qqbot/sdk/testing'
import plugin from '../src/index.js'
import { defaultConfig } from '../src/config.js'
import { ensureSchema, resetSchemaReadyForTest } from '../src/store/schema.js'
import { createEmptyMultimodalState, listAvailableMemesForGroup } from '../src/store/multimodal-db.js'
import { collectMemeFromSession, deleteMemeAsset } from '../src/meme/store.js'
import { recordMemeReplyOutcome, selectMemeForReply } from '../src/meme/selector.js'
import type { LLMService } from '../src/types.js'
import { createSqliteTestDB } from './helpers/sqlite-db.js'
import { createMockR2 } from './helpers/mock-r2.js'

const IMG_A = new Uint8Array([137, 80, 78, 71, 10, 20, 30, 40])
const IMG_B = new Uint8Array([137, 80, 78, 71, 99, 88, 77, 66])

function createVisionLlm(meaning: string, mood: string, tags: string[]): LLMService {
  return {
    contractVersion: 1,
    listModels: async () => [],
    resolve: async () => ({
      alias: 'vl',
      provider: 'mock',
      provider_name: 'Mock',
      model: 'mock-vl',
      capabilities: ['text', 'image'],
    }),
    chat: vi.fn(async () => ({
      text: JSON.stringify({
        summary: meaning,
        ocrText: '',
        memeMeaning: meaning,
        mood,
        tags,
        sceneHints: '群聊搞笑接梗',
      }),
      alias: 'vl',
      provider: 'mock',
      model: 'mock-vl',
      latency_ms: 80,
    })),
  }
}

describe('meme library: hash dedup, R2+D1 CRUD, group isolation, semantic matching & repeat cooldown', () => {
  beforeEach(() => {
    resetSchemaReadyForTest()
  })

  it('collects meme to R2+D1, deduplicates by SHA-256 hash, isolates groups, and deletes cleanly', async () => {
    const db = createSqliteTestDB()
    const r2 = createMockR2()
    const llm = createVisionLlm('熊猫头摸鱼摆烂', '摆烂', ['摸鱼', '下班', '摆烂'])
    const ctx = createMockContext(plugin, {
      config: defaultConfig,
      db,
      r2,
      services: { llm },
    })
    await ensureSchema(ctx.db)

    const fetchImgA = vi.fn(
      async () => new Response(IMG_A, { status: 200, headers: { 'content-type': 'image/png' } }),
    ) as unknown as typeof fetch

    const sGroupA = createMockSession({
      scene: 'group',
      targetId: 'group-A',
      userId: 'u1',
      attachments: [{ url: 'https://cdn.example.com/moyu.png', contentType: 'image/png' }],
    })

    const first = await collectMemeFromSession(sGroupA, ctx, {
      scope: 'group',
      category: '日常',
      extraTags: ['打工人'],
      now: 1_000_000,
      fetchImpl: fetchImgA,
    })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.visionUsed).toBe(true)
    expect(first.meme.tags).toContain('摸鱼')
    expect(first.meme.tags).toContain('打工人')
    expect(r2.store.size).toBe(1)

    // 同群重复收藏相同图片 -> SHA-256 去重拦截
    const dup = await collectMemeFromSession(sGroupA, ctx, {
      scope: 'group',
      now: 1_001_000,
      fetchImpl: fetchImgA,
    })
    expect(dup.ok).toBe(false)
    if (!dup.ok) expect(dup.duplicate).toBe(true)

    // 默认跨群共享模式：group-B 也能直接使用 group-A 收藏的表情包
    const sharedB = await listAvailableMemesForGroup(ctx.db, 'group-B', true, 1_002_000, 80, true)
    expect(sharedB).toHaveLength(1)

    // 关闭跨群共享时，仍支持按群严格隔离
    const isolatedA = await listAvailableMemesForGroup(ctx.db, 'group-A', true, 1_002_000, 80, false)
    const isolatedB = await listAvailableMemesForGroup(ctx.db, 'group-B', true, 1_002_000, 80, false)
    expect(isolatedA).toHaveLength(1)
    expect(isolatedB).toHaveLength(0)

    // 删除表情包应同步删除 D1 记录和 R2 对象
    const del = await deleteMemeAsset(ctx, first.meme.id, 'group-A')
    expect(del.deleted).toBe(true)
    expect(r2.store.size).toBe(0)
    expect(await listAvailableMemesForGroup(ctx.db, 'group-A', true, 1_003_000)).toHaveLength(0)
  })

  it('matches memes semantically, enforces repeat cooldown, and blocks consecutive meme spam loops', async () => {
    const db = createSqliteTestDB()
    const r2 = createMockR2()
    const llm = createVisionLlm('猫猫震撼无语', '无语', ['无语', '离谱', '猫猫'])
    const ctx = createMockContext(plugin, {
      config: { ...defaultConfig, meme_send_probability: 1, meme_repeat_cooldown_seconds: 180, max_consecutive_memes: 2 },
      db,
      r2,
      services: { llm },
    })
    await ensureSchema(ctx.db)

    const fetchImgB = vi.fn(
      async () => new Response(IMG_B, { status: 200, headers: { 'content-type': 'image/png' } }),
    ) as unknown as typeof fetch

    const s = createMockSession({
      scene: 'group',
      targetId: 'group-M',
      attachments: [{ url: 'https://cdn.example.com/cat.png', contentType: 'image/png' }],
    })
    const collected = await collectMemeFromSession(s, ctx, { scope: 'group', now: 10_000, fetchImpl: fetchImgB })
    expect(collected.ok).toBe(true)
    if (!collected.ok) return

    const candidates = await listAvailableMemesForGroup(ctx.db, 'group-M', true, 11_000)
    const mmState = createEmptyMultimodalState('group-M', 11_000)

    // 1. 语境匹配 -> 选中表情包
    const hit = selectMemeForReply({
      config: { ...defaultConfig, meme_send_probability: 1, meme_repeat_cooldown_seconds: 180 },
      mmState,
      candidates,
      recentMessages: [],
      userText: '这也太离谱了吧我直接无语',
      visionSummary: '',
      replyText: '确实离谱哈哈',
      now: 12_000,
      random: () => 0.5,
    })
    expect(hit.style).toBe('text_and_meme')
    expect(hit.meme?.id).toBe(collected.meme.id)

    // 2. 记录已发送后，在重复冷却期内不再发同一张
    recordMemeReplyOutcome(mmState, collected.meme.id, 180, 12_000)
    const cooled = selectMemeForReply({
      config: { ...defaultConfig, meme_send_probability: 1, meme_repeat_cooldown_seconds: 180 },
      mmState,
      candidates,
      recentMessages: [],
      userText: '又来一个离谱无语的事',
      visionSummary: '',
      replyText: '真的无语',
      now: 20_000,
      random: () => 0.1,
    })
    expect(cooled.style).toBe('text')
    expect(cooled.reason).toBe('all-in-repeat-cooldown')

    // 3. 超过连续表情包次数上限 -> 拦截防斗图死循环
    mmState.consecutiveMemeCount = 2
    mmState.recentMemes = []
    const antiLoop = selectMemeForReply({
      config: { ...defaultConfig, meme_send_probability: 1, max_consecutive_memes: 2 },
      mmState,
      candidates,
      recentMessages: [],
      userText: '无语猫猫',
      visionSummary: '',
      replyText: '笑死',
      now: 300_000,
      random: () => 0.1,
    })
    expect(antiLoop.style).toBe('text')
    expect(antiLoop.reason).toBe('max-consecutive-memes')
  })
})
