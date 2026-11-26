import type { PluginContext, Session } from '@qqbot/sdk'
import type {
  GroupMultimodalState,
  ImageAnalysisResult,
  LLMChatMessage,
  LLMService,
  SocialConfig,
} from '../types.js'
import {
  getCachedImageAnalysis,
  saveCachedImageAnalysis,
  type MultimodalStatsDelta,
} from '../store/multimodal-db.js'
import { sanitizeSensitiveText } from '../memory/privacy.js'
import {
  downloadImageSafe,
  extractSessionImages,
  MAX_TOTAL_IMAGE_BYTES,
  type DownloadedImage,
} from './media.js'

const VISION_WINDOW_MS = 60_000

const VISION_SYSTEM_PROMPT = [
  '你是一个 QQ 群聊图片理解助手，负责客观、简明地分析群友发的图片、截图或表情包。',
  '请输出一个纯 JSON 对象（不要额外解释），包含以下字段：',
  '- summary: 用 1~2 句中文概括图片画面内容（不超过 80 字）',
  '- ocrText: 图片或截图中清晰可见的关键文字（没有就填空字符串，不超过 120 字）',
  '- memeMeaning: 如果是表情包，说明它表达的梗或情绪（不是表情包填空字符串）',
  '- mood: 情绪关键词（如 开心/无语/震惊/搞笑/摆烂/委屈/吐槽/日常）',
  '- tags: 3~6 个简短中文标签数组（用于后续搜索和匹配）',
  '- sceneHints: 适合在什么聊天场景使用（不超过 40 字）',
  '隐私规则：不要猜测或推断人物的真实姓名、年龄、住址、手机号等敏感个人属性。',
].join('\n')

export function isVisionRateLimited(
  state: GroupMultimodalState,
  limitPerMinute: number,
  now: number,
): boolean {
  if (limitPerMinute <= 0) return false
  if (now - state.visionWindowStart >= VISION_WINDOW_MS) return false
  return state.visionWindowCount >= limitPerMinute
}

export function recordVisionRate(state: GroupMultimodalState, now: number): void {
  if (now - state.visionWindowStart >= VISION_WINDOW_MS) {
    state.visionWindowStart = now
    state.visionWindowCount = 1
  } else {
    state.visionWindowCount += 1
  }
  state.updatedAt = now
}

export function resolveVisionModelAlias(config: SocialConfig): string | undefined {
  return config.vision_model_alias.trim() || config.model_alias.trim() || undefined
}

/** 兼容 JSON 对象、Markdown 代码块包裹 JSON 以及纯文本降级解析 */
export function parseVisionResponse(raw: string, hash: string): Omit<ImageAnalysisResult, 'fromCache'> {
  const trimmed = raw.trim()
  const unwrapped = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()

  const jsonMatch = unwrapped.match(/\{[\s\S]*\}/)
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]) as Record<string, unknown>
      const str = (key: string, maxLen: number) => {
        const val = typeof obj[key] === 'string' ? obj[key].trim() : ''
        return sanitizeSensitiveText(val).text.slice(0, maxLen)
      }
      const rawTags = Array.isArray(obj.tags)
        ? obj.tags
            .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
            .map((t) => sanitizeSensitiveText(t.trim()).text.slice(0, 16))
            .slice(0, 8)
        : []
      const summary = str('summary', 120) || str('memeMeaning', 120) || '一张群聊图片'
      return {
        hash,
        summary,
        ocrText: str('ocrText', 160),
        memeMeaning: str('memeMeaning', 100),
        mood: str('mood', 24) || '日常',
        tags: rawTags,
        sceneHints: str('sceneHints', 80),
      }
    } catch {
      // 回落纯文本解析
    }
  }

  const clean = sanitizeSensitiveText(trimmed).text.slice(0, 120)
  return {
    hash,
    summary: clean || '一张群聊图片',
    ocrText: '',
    memeMeaning: '',
    mood: '日常',
    tags: [],
    sceneHints: '',
  }
}

export interface AnalyzeImageOptions {
  now?: number
  mmState?: GroupMultimodalState
  purpose?: 'chat' | 'collect'
}

export type SingleVisionOutcome =
  | { ok: true; analysis: ImageAnalysisResult; statsDelta: MultimodalStatsDelta }
  | { ok: false; reason: string; statsDelta: MultimodalStatsDelta }

/**
 * 分析单张已下载图片：优先按 SHA-256 命中 D1 缓存，未命中时检查模型 image 能力与频控后调视觉模型。
 */
export async function analyzeDownloadedImage(
  ctx: PluginContext<SocialConfig>,
  image: DownloadedImage,
  opts: AnalyzeImageOptions = {},
): Promise<SingleVisionOutcome> {
  const now = opts.now ?? Date.now()
  const cached = await getCachedImageAnalysis(ctx.db, image.hash, now)
  if (cached) {
    return {
      ok: true,
      analysis: cached,
      statsDelta: { visionCacheHits: 1 },
    }
  }

  if (opts.mmState && isVisionRateLimited(opts.mmState, ctx.config.vision_rate_limit_per_minute, now)) {
    return {
      ok: false,
      reason: 'vision-rate-limited',
      statsDelta: {},
    }
  }

  let llm: LLMService
  try {
    llm = ctx.service<LLMService>('llm')
  } catch {
    return { ok: false, reason: 'llm-unavailable', statsDelta: {} }
  }

  const alias = resolveVisionModelAlias(ctx.config)
  try {
    const resolved = await llm.resolve(alias)
    if (!resolved.capabilities.includes('image')) {
      return {
        ok: false,
        reason: `模型「${resolved.alias}」未开启 image 视觉能力`,
        statsDelta: {},
      }
    }
  } catch (err) {
    return {
      ok: false,
      reason: `视觉模型解析失败：${err instanceof Error ? err.message : String(err)}`,
      statsDelta: { visionErrors: 1 },
    }
  }

  const promptHint =
    opts.purpose === 'collect'
      ? '群友正在收藏这张表情包，请重点提炼它的 memeMeaning、mood、tags 和 sceneHints。'
      : '请分析这张 QQ 群聊图片，重点识别画面内容、截图关键文字和表情包梗。'

  const messages: LLMChatMessage[] = [
    { role: 'system', content: VISION_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        { type: 'text', text: promptHint },
        {
          type: 'image',
          data: image.base64,
          media_type: image.contentType,
          detail: 'low',
        },
      ],
    },
  ]

  try {
    const res = await llm.chat({
      model: alias,
      messages,
      temperature: 0.2,
      max_tokens: 260,
      timeout_ms: ctx.config.vision_timeout_ms,
    })
    if (opts.mmState) recordVisionRate(opts.mmState, now)
    const parsed = parseVisionResponse(res.text ?? '', image.hash)
    await saveCachedImageAnalysis(ctx.db, parsed, ctx.config.image_cache_ttl_hours, now)
    return {
      ok: true,
      analysis: { ...parsed, fromCache: false },
      statsDelta: { visionCalls: 1 },
    }
  } catch (err) {
    ctx.logger.warn('视觉模型调用失败，已降级', {
      alias: alias ?? '(default)',
      error: err instanceof Error ? err.message : String(err),
    })
    return {
      ok: false,
      reason: `视觉模型调用失败：${err instanceof Error ? err.message : String(err)}`,
      statsDelta: { visionErrors: 1 },
    }
  }
}

export interface SessionVisionSummary {
  analyses: Array<{ source: 'message' | 'quote'; analysis: ImageAnalysisResult }>
  notes: string[]
  statsDelta: MultimodalStatsDelta
  /** 合并后的简短图片摘要，供短期上下文与主对话提示词使用 */
  combinedSummary: string
}

export async function analyzeSessionImages(
  session: Session,
  ctx: PluginContext<SocialConfig>,
  mmState: GroupMultimodalState,
  opts: { now?: number; fetchImpl?: typeof fetch } = {},
): Promise<SessionVisionSummary> {
  const now = opts.now ?? Date.now()
  const statsDelta: MultimodalStatsDelta = { visionCalls: 0, visionCacheHits: 0, visionErrors: 0 }
  const refs = extractSessionImages(session, ctx.config.max_vision_images)
  if (refs.length === 0) {
    return { analyses: [], notes: [], statsDelta, combinedSummary: '' }
  }

  if (!ctx.config.enable_vision) {
    return {
      analyses: [],
      notes: ['（当前未开启图片理解功能，仅根据文字互动）'],
      statsDelta,
      combinedSummary: '',
    }
  }

  const analyses: Array<{ source: 'message' | 'quote'; analysis: ImageAnalysisResult }> = []
  const notes: string[] = []
  let totalBytes = 0

  for (const ref of refs) {
    const dl = await downloadImageSafe(ref.url, {
      maxBytes: ctx.config.max_image_bytes,
      declaredContentType: ref.contentType,
      fetchImpl: opts.fetchImpl,
    })

    if (!dl.ok) {
      notes.push(ref.source === 'quote' ? `引用图片无法读取（${dl.message}）` : `图片无法读取（${dl.message}）`)
      continue
    }

    if (totalBytes + dl.image.sizeBytes > MAX_TOTAL_IMAGE_BYTES) {
      notes.push('本次图片总大小超过限制，跳过多余图片')
      break
    }
    totalBytes += dl.image.sizeBytes

    const res = await analyzeDownloadedImage(ctx, dl.image, {
      now,
      mmState,
      purpose: 'chat',
    })
    statsDelta.visionCalls = (statsDelta.visionCalls ?? 0) + (res.statsDelta.visionCalls ?? 0)
    statsDelta.visionCacheHits = (statsDelta.visionCacheHits ?? 0) + (res.statsDelta.visionCacheHits ?? 0)
    statsDelta.visionErrors = (statsDelta.visionErrors ?? 0) + (res.statsDelta.visionErrors ?? 0)

    if (res.ok) {
      analyses.push({ source: ref.source, analysis: res.analysis })
    } else if (res.reason === 'vision-rate-limited') {
      notes.push('图片理解触发每分钟频控，已降级为文字回复')
      break
    } else {
      notes.push(res.reason)
    }
  }

  const summaryParts = analyses.map(({ source, analysis }) => {
    const prefix = source === 'quote' ? '引用图片' : '消息图片'
    const extras: string[] = [analysis.summary]
    if (analysis.ocrText) extras.push(`图上文字：“${analysis.ocrText}”`)
    if (analysis.memeMeaning) extras.push(`表情含义：${analysis.memeMeaning}`)
    if (analysis.mood) extras.push(`情绪：${analysis.mood}`)
    return `[${prefix}] ${extras.join('；')}`
  })

  return {
    analyses,
    notes,
    statsDelta,
    combinedSummary: summaryParts.join('\n'),
  }
}
