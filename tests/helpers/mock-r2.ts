import type { ScopedR2, StoredObject } from '@qqbot/sdk'

interface Entry {
  bytes: Uint8Array
  contentType?: string
  metadata?: Record<string, string>
  uploadedAt: Date
}

/** 内存版 ScopedR2 测试替身，支持 put / get / getStream / delete / head / list */
export function createMockR2(): ScopedR2 & { readonly store: Map<string, Entry> } {
  const store = new Map<string, Entry>()

  return {
    store,
    async get(key: string) {
      const e = store.get(key)
      return e ? e.bytes.slice().buffer : null
    },
    async getText(key: string) {
      const e = store.get(key)
      return e ? new TextDecoder().decode(e.bytes) : null
    },
    async getJSON<T = unknown>(key: string) {
      const e = store.get(key)
      return e ? (JSON.parse(new TextDecoder().decode(e.bytes)) as T) : null
    },
    async getStream(key: string) {
      const e = store.get(key)
      if (!e) return null
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(e.bytes.slice())
          controller.close()
        },
      })
    },
    async put(key, value, options) {
      let bytes: Uint8Array
      if (typeof value === 'string') {
        bytes = new TextEncoder().encode(value)
      } else if (value instanceof ArrayBuffer) {
        bytes = new Uint8Array(value.slice(0))
      } else if (ArrayBuffer.isView(value)) {
        bytes = new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
      } else if (value instanceof Blob) {
        bytes = new Uint8Array(await value.arrayBuffer())
      } else {
        const reader = value.getReader()
        const chunks: Uint8Array[] = []
        let total = 0
        while (true) {
          const { done, value: chunk } = await reader.read()
          if (done) break
          chunks.push(chunk)
          total += chunk.byteLength
        }
        bytes = new Uint8Array(total)
        let off = 0
        for (const c of chunks) {
          bytes.set(c, off)
          off += c.byteLength
        }
      }
      store.set(key, {
        bytes,
        contentType: options?.contentType,
        metadata: options?.metadata,
        uploadedAt: new Date(),
      })
    },
    async delete(key) {
      const keys = Array.isArray(key) ? key : [key]
      for (const k of keys) store.delete(k)
    },
    async head(key) {
      const e = store.get(key)
      if (!e) return null
      return {
        key,
        size: e.bytes.byteLength,
        uploadedAt: e.uploadedAt,
        metadata: e.metadata,
      }
    },
    async list(prefix = '', options) {
      const out: StoredObject[] = []
      for (const [key, e] of store.entries()) {
        if (prefix && !key.startsWith(prefix)) continue
        out.push({
          key,
          size: e.bytes.byteLength,
          uploadedAt: e.uploadedAt,
          metadata: e.metadata,
        })
        if (options?.limit && out.length >= options.limit) break
      }
      return out
    },
  }
}
