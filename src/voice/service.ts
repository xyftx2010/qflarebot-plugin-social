import type { MediaSource, PluginContext } from '@qqbot/sdk'
import type {
  SocialConfig,
  TTSProviderType,
  VoiceAudioFormat,
  VoiceLogRecord,
} from '../types.js'
import { ensureSchema } from '../store/schema.js'
import {
  getVoiceCacheEntry,
  insertVoiceLog,
  saveVoiceCacheEntry,
} from '../store/voice-db.js'
import { arrayBufferToBase64, sha256Hex } from '../vision/media.js'
import { synthesizeSpeech } from './providers.js'

/** 低于该体积优先直接 Base64 (file_data) 上传 QQ，免去 URL 回源延迟 */
const DIRECT_BASE64_LIMIT_BYTES = 350_000

export interface PrepareVoiceInput {
  groupId: string
  text: string
  voiceId: string
  speed: number
  emotion: string
  now?: number
  fetchImpl?: typeof fetch
}

export type PrepareVoiceResult =
  | {
      ok: true
      media: MediaSource
      bytes: ArrayBuffer
      format: VoiceAudioFormat
      contentType: string
      cached: boolean
      estimatedCost: number
      cacheKey: string
    }
  | {
      ok: false
      error: string
      estimatedCost: number
    }

export async function buildVoiceCacheKey(params: {
  provider: TTSProviderType
  model: string
  voiceId: string
  speed: number
  pitch: number
  volume: number
  emotion: string
  format: VoiceAudioFormat
  text: string
}): Promise<string> {
  const payload = JSON.stringify(params)
  const encoded = new TextEncoder().encode(payload)
  const buf = encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer
  const hex = await sha256Hex(buf)
  return `vc_${hex.slice(0, 24)}`
}

export function estimateVoiceCost(charCount: number, costPer1kChars: number): number {
  if (charCount <= 0 || costPer1kChars <= 0) return 0
  return Number(((charCount / 1000) * costPer1kChars).toFixed(4))
}

/**
 * 合成或复用缓存音频，并选择最优 QQ 上传形态：
 * - 命中 R2 短期缓存：0 次 TTS 调用、0 费用；
 * - 短音频（≤ 350KB）：优先 base64 直传 QQ；
 * - 较长音频且有 ctx.publicUrl：走临时 R2 对象 + 公开短期流式路由，避免大 base64 占用 CPU。
 */
export async function synthesizeAndPrepareVoice(
  ctx: PluginContext<SocialConfig>,
  input: PrepareVoiceInput,
): Promise<PrepareVoiceResult> {
  const now = input.now ?? Date.now()
  await ensureSchema(ctx.db, ctx.logger)

  const format = ctx.config.tts_audio_format
  const cacheKey = await buildVoiceCacheKey({
    provider: ctx.config.tts_provider,
    model: ctx.config.tts_model,
    voiceId: input.voiceId,
    speed: input.speed,
    pitch: ctx.config.tts_pitch,
    volume: ctx.config.tts_volume,
    emotion: input.emotion,
    format,
    text: input.text.trim(),
  })

  // 1. 先查短期缓存
  const cachedEntry = await getVoiceCacheEntry(ctx.db, cacheKey, now)
  if (cachedEntry) {
    try {
      const cachedBytes = await ctx.r2.get(cachedEntry.r2Key)
      if (cachedBytes && cachedBytes.byteLength > 0) {
        const useUrl = cachedBytes.byteLength > DIRECT_BASE64_LIMIT_BYTES && Boolean(ctx.publicUrl)
        const media: MediaSource = useUrl
          ? {
              type: 'voice',
              url: `${ctx.publicUrl}/p/${ctx.plugin.name}/voice/${encodeURIComponent(cacheKey)}`,
              filename: `voice.${cachedEntry.format}`,
            }
          : {
              type: 'voice',
              base64: arrayBufferToBase64(cachedBytes),
              filename: `voice.${cachedEntry.format}`,
            }
        return {
          ok: true,
          media,
          bytes: cachedBytes,
          format: cachedEntry.format,
          contentType: cachedEntry.contentType,
          cached: true,
          estimatedCost: 0,
          cacheKey,
        }
      }
    } catch {
      // R2 读缓存失败则回退到重新合成
    }
  }

  // 2. 调用 TTS 供应商合成
  let synth
  try {
    synth = await synthesizeSpeech(
      {
        text: input.text.trim(),
        provider: ctx.config.tts_provider,
        apiBaseUrl: ctx.config.tts_api_base_url,
        apiKey: ctx.config.tts_api_key,
        model: ctx.config.tts_model,
        voiceId: input.voiceId,
        speed: input.speed,
        pitch: ctx.config.tts_pitch,
        volume: ctx.config.tts_volume,
        emotion: input.emotion,
        format,
        timeoutMs: ctx.config.tts_timeout_ms,
      },
      input.fetchImpl,
    )
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      estimatedCost: 0,
    }
  }

  const estimatedCost = estimateVoiceCost(input.text.trim().length, ctx.config.voice_cost_per_1k_chars)
  const r2Key = `voice_tmp/${cacheKey}.${synth.format}`
  const ttlMs = Math.max(1, ctx.config.voice_cache_ttl_hours) * 3600 * 1000
  let savedToR2 = false

  // 尽力写入短期 R2 缓存（用于复用或大音频 URL 交付），失败不影响直接 base64 发送
  try {
    await ctx.r2.put(r2Key, synth.bytes, {
      contentType: synth.contentType,
      metadata: { cacheKey, provider: ctx.config.tts_provider },
    })
    await saveVoiceCacheEntry(ctx.db, {
      cacheKey,
      provider: ctx.config.tts_provider,
      format: synth.format,
      contentType: synth.contentType,
      sizeBytes: synth.sizeBytes,
      r2Key,
      createdAt: now,
      expiresAt: now + ttlMs,
    })
    savedToR2 = true
  } catch {
    savedToR2 = false
  }

  const useUrl = savedToR2 && synth.sizeBytes > DIRECT_BASE64_LIMIT_BYTES && Boolean(ctx.publicUrl)
  const media: MediaSource = useUrl
    ? {
        type: 'voice',
        url: `${ctx.publicUrl}/p/${ctx.plugin.name}/voice/${encodeURIComponent(cacheKey)}`,
        filename: `voice.${synth.format}`,
      }
    : {
        type: 'voice',
        base64: arrayBufferToBase64(synth.bytes),
        filename: `voice.${synth.format}`,
      }

  return {
    ok: true,
    media,
    bytes: synth.bytes,
    format: synth.format,
    contentType: synth.contentType,
    cached: false,
    estimatedCost,
    cacheKey,
  }
}

export async function recordVoiceSendLog(
  ctx: PluginContext<SocialConfig>,
  entry: Omit<VoiceLogRecord, 'id'>,
): Promise<void> {
  await insertVoiceLog(ctx.db, {
    id: `vlog_${entry.createdAt.toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    ...entry,
  })
}
