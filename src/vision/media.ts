import type { Attachment, Session } from '@qqbot/sdk'

const MAX_REDIRECTS = 3
const DEFAULT_TIMEOUT_MS = 8_000
const DEFAULT_MAX_BYTES = 3_000_000
export const MAX_TOTAL_IMAGE_BYTES = 4_500_000

const IMAGE_EXT_RE = /\.(?:png|jpe?g|webp|gif|bmp)(?:[?#]|$)/i

export interface ExtractedImageRef {
  url: string
  contentType?: string
  filename?: string
  source: 'message' | 'quote'
}

export interface DownloadedImage {
  bytes: ArrayBuffer
  contentType: string
  sizeBytes: number
  hash: string
  base64: string
}

export type ImageDownloadErrorCode = 'invalid-url' | 'expired' | 'http-error' | 'too-large' | 'timeout' | 'network'

export type ImageDownloadResult =
  | { ok: true; image: DownloadedImage }
  | { ok: false; code: ImageDownloadErrorCode; status?: number; message: string }

export function isImageAttachment(att: Attachment): boolean {
  if (!att.url) return false
  if (att.contentType?.toLowerCase().startsWith('image/')) return true
  if (att.filename && IMAGE_EXT_RE.test(att.filename)) return true
  if (IMAGE_EXT_RE.test(att.url)) return true
  return false
}

/**
 * 提取当前消息及引用消息中的图片附件（优先当前消息，再补充引用图片）。
 */
export function extractSessionImages(session: Session, maxImages = 2): ExtractedImageRef[] {
  const limit = Math.max(1, Math.min(4, Math.floor(maxImages)))
  const out: ExtractedImageRef[] = []
  const seenUrls = new Set<string>()

  const pushList = (list: readonly Attachment[] | undefined, source: 'message' | 'quote') => {
    if (!list) return
    for (const att of list) {
      if (out.length >= limit) break
      if (!isImageAttachment(att) || seenUrls.has(att.url)) continue
      seenUrls.add(att.url)
      out.push({
        url: att.url,
        contentType: att.contentType,
        filename: att.filename,
        source,
      })
    }
  }

  pushList(session.attachments, 'message')
  pushList(session.quote?.attachments, 'quote')
  return out
}

/**
 * SSRF 防护校验：拒绝回环、内网 IP、云元数据地址和非 http/https 协议。
 */
export function validateImageUrl(rawUrl: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return '无效的图片 URL'
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return `不支持的协议：${parsed.protocol}`
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!host) return '缺少主机名'
  if (
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === 'metadata.google.internal'
  ) {
    return '拒绝访问本地或内网地址'
  }
  // IPv4 私有/保留网段
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (ipv4) {
    const a = Number(ipv4[1])
    const b = Number(ipv4[2])
    if (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    ) {
      return '拒绝访问私有网段地址'
    }
  }
  // IPv6 链路本地 / 唯一本地
  if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')) {
    return '拒绝访问内网 IPv6 地址'
  }
  return null
}

/** 分块转 base64，避免大 Uint8Array 展开爆栈 */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const CHUNK = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

/** Web Crypto 原生 SHA-256 哈希（16 进制），用于图片去重与视觉分析缓存 */
export async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  const arr = new Uint8Array(digest)
  let hex = ''
  for (let i = 0; i < arr.length; i++) {
    hex += arr[i]!.toString(16).padStart(2, '0')
  }
  return hex
}

export function inferImageExtension(contentType: string): string {
  const ct = contentType.toLowerCase().split(';')[0]?.trim() ?? ''
  if (ct === 'image/png') return 'png'
  if (ct === 'image/gif') return 'gif'
  if (ct === 'image/webp') return 'webp'
  return 'jpg'
}

export function normalizeImageContentType(headerType?: string | null, declaredType?: string): string {
  const pick = (v?: string | null) => {
    const clean = v?.toLowerCase().split(';')[0]?.trim()
    return clean && clean.startsWith('image/') ? clean : null
  }
  return pick(headerType) ?? pick(declaredType) ?? 'image/jpeg'
}

async function readStreamWithLimit(response: Response, maxBytes: number): Promise<ArrayBuffer> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel()
    throw new ImageTooLargeError(declared)
  }
  if (!response.body) {
    const buf = await response.arrayBuffer()
    if (buf.byteLength > maxBytes) throw new ImageTooLargeError(buf.byteLength)
    return buf
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel()
        throw new ImageTooLargeError(size)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const merged = new Uint8Array(size)
  let offset = 0
  for (const c of chunks) {
    merged.set(c, offset)
    offset += c.byteLength
  }
  return merged.buffer
}

class ImageTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super(`图片体积超过上限（${Math.round(bytes / 1024)} KB）`)
    this.name = 'ImageTooLargeError'
  }
}

export interface DownloadImageOptions {
  maxBytes?: number
  timeoutMs?: number
  declaredContentType?: string
  fetchImpl?: typeof fetch
}

/**
 * 安全下载 QQ 图片：逐跳 SSRF 校验 + 边读边限量 + 过期链接识别（403/404/410）+ SHA-256。
 */
export async function downloadImageSafe(
  url: string,
  opts: DownloadImageOptions = {},
): Promise<ImageDownloadResult> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch

  let current = url
  const signal = AbortSignal.timeout(timeoutMs)

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const invalid = validateImageUrl(current)
      if (invalid) {
        return { ok: false, code: 'invalid-url', message: invalid }
      }

      const response = await fetchImpl(current, {
        redirect: 'manual',
        signal,
      })

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        await response.body?.cancel()
        if (!location) {
          return { ok: false, code: 'http-error', status: response.status, message: '重定向缺少 Location' }
        }
        current = new URL(location, current).toString()
        continue
      }

      if (response.status === 403 || response.status === 404 || response.status === 410) {
        await response.body?.cancel()
        return {
          ok: false,
          code: 'expired',
          status: response.status,
          message: `图片链接已失效或无访问权限（HTTP ${response.status}）`,
        }
      }

      if (!response.ok) {
        await response.body?.cancel()
        return {
          ok: false,
          code: 'http-error',
          status: response.status,
          message: `图片下载失败（HTTP ${response.status}）`,
        }
      }

      const bytes = await readStreamWithLimit(response, maxBytes)
      if (bytes.byteLength === 0) {
        return { ok: false, code: 'http-error', message: '图片内容为空' }
      }

      const contentType = normalizeImageContentType(response.headers.get('content-type'), opts.declaredContentType)
      const hash = await sha256Hex(bytes)
      const base64 = arrayBufferToBase64(bytes)

      return {
        ok: true,
        image: {
          bytes,
          contentType,
          sizeBytes: bytes.byteLength,
          hash,
          base64,
        },
      }
    }

    return { ok: false, code: 'http-error', message: `图片重定向超过 ${MAX_REDIRECTS} 次` }
  } catch (err) {
    if (err instanceof ImageTooLargeError) {
      return { ok: false, code: 'too-large', message: err.message }
    }
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      return { ok: false, code: 'timeout', message: '图片下载超时' }
    }
    return {
      ok: false,
      code: 'network',
      message: `图片下载异常：${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
