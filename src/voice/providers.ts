import type {
  TTSProviderType,
  VoiceAudioFormat,
  VoiceSynthesisRequest,
  VoiceSynthesisResult,
} from '../types.js'
import { validateImageUrl } from '../vision/media.js'

const MAX_AUDIO_BYTES = 2_000_000

const DEFAULT_URLS: Readonly<Record<TTSProviderType, string>> = {
  minimax: 'https://api.minimaxi.com/v1/t2a_v2',
  qwen: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
  openai: 'https://api.openai.com/v1/audio/speech',
}

const MINIMAX_EMOTIONS = new Set(['happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'calm'])

export function contentTypeForAudio(format: VoiceAudioFormat): string {
  return format === 'mp3' ? 'audio/mpeg' : 'audio/wav'
}

export function resolveProviderEndpoint(provider: TTSProviderType, customBaseUrl: string): string {
  const trimmed = customBaseUrl.trim()
  if (!trimmed) return DEFAULT_URLS[provider]
  if (provider === 'openai' && /\/v1\/?$/i.test(trimmed)) {
    return `${trimmed.replace(/\/+$/, '')}/audio/speech`
  }
  return trimmed
}

function hexToArrayBuffer(hex: string): ArrayBuffer {
  const clean = hex.trim().replace(/^0x/i, '')
  const len = Math.floor(clean.length / 2)
  const out = new Uint8Array(len)
  for (let i = 0; i < len; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  return out.buffer
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const clean = b64.includes(',') ? b64.slice(b64.indexOf(',') + 1) : b64
  const binary = atob(clean.trim())
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes.buffer
}

async function fetchAudioFromUrl(
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<ArrayBuffer> {
  const invalid = validateImageUrl(url)
  if (invalid) throw new Error(`TTS 音频下载地址被拒绝：${invalid}`)
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`下载 TTS 音频失败（HTTP ${res.status}）`)
  const buf = await res.arrayBuffer()
  if (buf.byteLength === 0) throw new Error('下载的 TTS 音频为空')
  if (buf.byteLength > MAX_AUDIO_BYTES) throw new Error('TTS 音频超过 2MB 上限')
  return buf
}

async function synthesizeMiniMax(
  req: VoiceSynthesisRequest,
  endpoint: string,
  fetchImpl: typeof fetch,
): Promise<VoiceSynthesisResult> {
  const emotion = req.emotion.trim().toLowerCase()
  const voiceSetting: Record<string, unknown> = {
    voice_id: req.voiceId || 'male-qn-qingse',
    speed: Math.min(2, Math.max(0.5, req.speed || 1)),
    vol: Math.min(10, Math.max(0.1, req.volume || 1)),
    pitch: Math.min(12, Math.max(-12, Math.round(req.pitch || 0))),
  }
  if (emotion && MINIMAX_EMOTIONS.has(emotion)) {
    voiceSetting.emotion = emotion
  }

  const body = {
    model: req.model || 'speech-02-turbo',
    text: req.text,
    stream: false,
    voice_setting: voiceSetting,
    audio_setting: {
      sample_rate: 24000,
      bitrate: 128000,
      format: req.format,
      channel: 1,
    },
    output_format: 'hex',
  }

  const res = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${req.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(req.timeoutMs),
  })

  if (!res.ok) {
    const errText = (await res.text().catch(() => '')).slice(0, 200)
    throw new Error(`MiniMax TTS 失败（HTTP ${res.status}）：${errText}`)
  }

  const ct = res.headers.get('content-type') ?? ''
  if (ct.startsWith('audio/')) {
    const bytes = await res.arrayBuffer()
    if (bytes.byteLength === 0) throw new Error('MiniMax 返回空音频')
    return { bytes, format: req.format, contentType: contentTypeForAudio(req.format), sizeBytes: bytes.byteLength }
  }

  const json = (await res.json()) as {
    base_resp?: { status_code?: number; status_msg?: string }
    data?: { audio?: string }
  }
  if (json.base_resp?.status_code && json.base_resp.status_code !== 0) {
    throw new Error(`MiniMax TTS 业务错误（${json.base_resp.status_code}）：${json.base_resp.status_msg ?? ''}`)
  }
  const audioField = json.data?.audio?.trim()
  if (!audioField) throw new Error('MiniMax TTS 响应缺少 data.audio')

  const bytes = /^https?:\/\//i.test(audioField)
    ? await fetchAudioFromUrl(audioField, req.timeoutMs, fetchImpl)
    : hexToArrayBuffer(audioField)

  if (bytes.byteLength === 0) throw new Error('MiniMax 解码后音频为空')
  if (bytes.byteLength > MAX_AUDIO_BYTES) throw new Error('MiniMax 音频超过 2MB 上限')

  return {
    bytes,
    format: req.format,
    contentType: contentTypeForAudio(req.format),
    sizeBytes: bytes.byteLength,
  }
}

async function synthesizeQwen(
  req: VoiceSynthesisRequest,
  endpoint: string,
  fetchImpl: typeof fetch,
): Promise<VoiceSynthesisResult> {
  const body = {
    model: req.model || 'qwen-tts',
    input: {
      text: req.text,
      voice: req.voiceId || 'Cherry',
    },
    parameters: {
      format: req.format,
    },
  }

  const res = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${req.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(req.timeoutMs),
  })

  if (!res.ok) {
    const errText = (await res.text().catch(() => '')).slice(0, 200)
    throw new Error(`千问 TTS 失败（HTTP ${res.status}）：${errText}`)
  }

  const ct = res.headers.get('content-type') ?? ''
  if (ct.startsWith('audio/')) {
    const bytes = await res.arrayBuffer()
    if (bytes.byteLength === 0) throw new Error('千问 TTS 返回空音频')
    return { bytes, format: req.format, contentType: contentTypeForAudio(req.format), sizeBytes: bytes.byteLength }
  }

  const json = (await res.json()) as {
    code?: string
    message?: string
    output?: { audio?: { url?: string; data?: string } }
  }
  if (json.code) {
    throw new Error(`千问 TTS 业务错误（${json.code}）：${json.message ?? ''}`)
  }
  const audio = json.output?.audio
  let bytes: ArrayBuffer
  if (audio?.data) {
    bytes = base64ToArrayBuffer(audio.data)
  } else if (audio?.url) {
    bytes = await fetchAudioFromUrl(audio.url, req.timeoutMs, fetchImpl)
  } else {
    throw new Error('千问 TTS 响应缺少 output.audio.url 或 data')
  }

  if (bytes.byteLength === 0) throw new Error('千问 TTS 音频为空')
  if (bytes.byteLength > MAX_AUDIO_BYTES) throw new Error('千问 TTS 音频超过 2MB 上限')

  return {
    bytes,
    format: req.format,
    contentType: contentTypeForAudio(req.format),
    sizeBytes: bytes.byteLength,
  }
}

async function synthesizeOpenAI(
  req: VoiceSynthesisRequest,
  endpoint: string,
  fetchImpl: typeof fetch,
): Promise<VoiceSynthesisResult> {
  const body: Record<string, unknown> = {
    model: req.model || 'tts-1',
    input: req.text,
    voice: req.voiceId || 'alloy',
    response_format: req.format,
    speed: Math.min(4, Math.max(0.25, req.speed || 1)),
  }
  if (req.emotion.trim()) {
    body.instructions = `Speak naturally in a ${req.emotion.trim()} tone.`
  }

  const res = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${req.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(req.timeoutMs),
  })

  if (!res.ok) {
    const errText = (await res.text().catch(() => '')).slice(0, 200)
    throw new Error(`OpenAI Compatible TTS 失败（HTTP ${res.status}）：${errText}`)
  }

  const bytes = await res.arrayBuffer()
  if (bytes.byteLength === 0) throw new Error('OpenAI Compatible TTS 返回空音频')
  if (bytes.byteLength > MAX_AUDIO_BYTES) throw new Error('OpenAI Compatible TTS 音频超过 2MB 上限')

  return {
    bytes,
    format: req.format,
    contentType: contentTypeForAudio(req.format),
    sizeBytes: bytes.byteLength,
  }
}

/** 统一 TTS 合成入口（按供应商实际支持的参数分别适配） */
export async function synthesizeSpeech(
  req: VoiceSynthesisRequest,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<VoiceSynthesisResult> {
  if (!req.apiKey.trim()) {
    throw new Error('未配置 TTS API Key')
  }
  if (!req.text.trim()) {
    throw new Error('TTS 合成文本不能为空')
  }
  const endpoint = resolveProviderEndpoint(req.provider, req.apiBaseUrl)
  const invalid = validateImageUrl(endpoint)
  if (invalid) {
    throw new Error(`TTS 接口地址无效：${invalid}`)
  }

  switch (req.provider) {
    case 'minimax':
      return synthesizeMiniMax(req, endpoint, fetchImpl)
    case 'qwen':
      return synthesizeQwen(req, endpoint, fetchImpl)
    case 'openai':
      return synthesizeOpenAI(req, endpoint, fetchImpl)
  }
}
