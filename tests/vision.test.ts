import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockContext, createMockSession } from '@qqbot/sdk/testing'
import plugin from '../src/index.js'
import { defaultConfig } from '../src/config.js'
import { ensureSchema, resetSchemaReadyForTest } from '../src/store/schema.js'
import { createEmptyMultimodalState } from '../src/store/multimodal-db.js'
import { downloadImageSafe, extractSessionImages, validateImageUrl } from '../src/vision/media.js'
import { analyzeSessionImages } from '../src/vision/analyzer.js'
import type { LLMService } from '../src/types.js'
import { createSqliteTestDB } from './helpers/sqlite-db.js'

const SAMPLE_PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4])

function mockFetchOk(bytes = SAMPLE_PNG_BYTES, contentType = 'image/png'): typeof fetch {
  return vi.fn(async () => new Response(bytes, { status: 200, headers: { 'content-type': contentType } })) as unknown as typeof fetch
}

describe('vision: image extraction, SSRF/expiry guards, vision call & hash cache', () => {
  beforeEach(() => {
    resetSchemaReadyForTest()
  })

  it('extracts images from both message attachments and quoted message attachments', () => {
    const session = createMockSession({
      scene: 'group',
      attachments: [{ url: 'https://cdn.example.com/a.png', contentType: 'image/png' }],
      quote: {
        content: '看这张图',
        attachments: [{ url: 'https://cdn.example.com/b.jpg', contentType: 'image/jpeg' }],
      },
    })
    const refs = extractSessionImages(session, 2)
    expect(refs).toHaveLength(2)
    expect(refs[0]).toMatchObject({ url: 'https://cdn.example.com/a.png', source: 'message' })
    expect(refs[1]).toMatchObject({ url: 'https://cdn.example.com/b.jpg', source: 'quote' })
  })

  it('blocks private/SSRF URLs and classifies expired 403/404 image URLs', async () => {
    expect(validateImageUrl('http://127.0.0.1/secret.png')).not.toBeNull()
    expect(validateImageUrl('http://169.254.169.254/latest/meta-data')).not.toBeNull()
    expect(validateImageUrl('https://multimedia.nt.qq.com.cn/a.jpg')).toBeNull()

    const fetchExpired = vi.fn(async () => new Response('Forbidden', { status: 403 })) as unknown as typeof fetch
    const expired = await downloadImageSafe('https://cdn.example.com/old.jpg', { fetchImpl: fetchExpired })
    expect(expired.ok).toBe(false)
    if (!expired.ok) expect(expired.code).toBe('expired')

    const tooLarge = await downloadImageSafe('https://cdn.example.com/big.png', {
      maxBytes: 4,
      fetchImpl: mockFetchOk(SAMPLE_PNG_BYTES),
    })
    expect(tooLarge.ok).toBe(false)
    if (!tooLarge.ok) expect(tooLarge.code).toBe('too-large')
  })

  it('calls vision model once and reuses SHA-256 hash cache on repeated identical images', async () => {
    const db = createSqliteTestDB()
    const chat = vi.fn(async () => ({
      text: JSON.stringify({
        summary: '一只戴墨镜的柴犬表情包',
        ocrText: '问题不大',
        memeMeaning: '淡定应对一切突发状况',
        mood: '搞笑',
        tags: ['柴犬', '淡定', '问题不大'],
        sceneHints: '出状况时装淡定',
      }),
      alias: 'vision-fast',
      provider: 'mock',
      model: 'mock-vl',
      latency_ms: 90,
    }))
    const llm: LLMService = {
      contractVersion: 1,
      listModels: async () => [],
      resolve: async (alias) => ({
        alias: alias ?? 'vision-fast',
        provider: 'mock',
        provider_name: 'Mock',
        model: 'mock-vl',
        capabilities: ['text', 'image'],
      }),
      chat,
    }

    const ctx = createMockContext(plugin, {
      config: { ...defaultConfig, vision_model_alias: 'vision-fast', enable_vision: true },
      db,
      services: { llm },
    })
    await ensureSchema(ctx.db)

    const mmState = createEmptyMultimodalState('g-vis')
    const session = createMockSession({
      scene: 'group',
      targetId: 'g-vis',
      attachments: [{ url: 'https://cdn.example.com/doge.png', contentType: 'image/png' }],
    })

    const first = await analyzeSessionImages(session, ctx, mmState, {
      now: 1_000_000,
      fetchImpl: mockFetchOk(),
    })
    expect(first.analyses).toHaveLength(1)
    expect(first.analyses[0]!.analysis.fromCache).toBe(false)
    expect(first.analyses[0]!.analysis.ocrText).toBe('问题不大')
    expect(first.statsDelta.visionCalls).toBe(1)
    expect(chat).toHaveBeenCalledTimes(1)

    // 换一个 URL 但内容完全相同，应直接命中 SHA-256 缓存，0 次额外视觉调用
    const session2 = createMockSession({
      scene: 'group',
      targetId: 'g-vis',
      quote: {
        content: '上次那个图',
        attachments: [{ url: 'https://cdn.example.com/doge-reupload.png', contentType: 'image/png' }],
      },
    })
    const second = await analyzeSessionImages(session2, ctx, mmState, {
      now: 1_005_000,
      fetchImpl: mockFetchOk(),
    })
    expect(second.analyses).toHaveLength(1)
    expect(second.analyses[0]!.analysis.fromCache).toBe(true)
    expect(second.statsDelta.visionCacheHits).toBe(1)
    expect(chat).toHaveBeenCalledTimes(1)
  })

  it('degrades gracefully when configured vision model lacks image capability', async () => {
    const db = createSqliteTestDB()
    const chat = vi.fn()
    const llm: LLMService = {
      contractVersion: 1,
      listModels: async () => [],
      resolve: async () => ({
        alias: 'text-only',
        provider: 'mock',
        provider_name: 'Mock',
        model: 'mock-text',
        capabilities: ['text'],
      }),
      chat,
    }
    const ctx = createMockContext(plugin, {
      config: { ...defaultConfig, vision_model_alias: 'text-only', enable_vision: true },
      db,
      services: { llm },
    })
    await ensureSchema(ctx.db)

    const session = createMockSession({
      scene: 'group',
      attachments: [{ url: 'https://cdn.example.com/pic.png', contentType: 'image/png' }],
    })
    const out = await analyzeSessionImages(session, ctx, createEmptyMultimodalState('g-no-vl'), {
      fetchImpl: mockFetchOk(),
    })
    expect(out.analyses).toHaveLength(0)
    expect(out.notes[0]).toContain('未开启 image 视觉能力')
    expect(chat).toHaveBeenCalledTimes(0)
  })
})
