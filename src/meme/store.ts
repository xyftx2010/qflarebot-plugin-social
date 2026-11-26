import type { PluginContext, Session } from '@qqbot/sdk'
import type { MemeRecord, MemeScope, SocialConfig } from '../types.js'
import {
  countR2KeyReferences,
  deleteMemeRow,
  findMemeByHash,
  getMemeById,
  insertMemeRecord,
  listExpiredMemes,
  listMemesAdmin,
  recordMultimodalStats,
  updateMemeRecord,
} from '../store/multimodal-db.js'
import { ensureSchema } from '../store/schema.js'
import { sanitizeSensitiveText } from '../memory/privacy.js'
import {
  arrayBufferToBase64,
  downloadImageSafe,
  extractSessionImages,
  inferImageExtension,
} from '../vision/media.js'
import { analyzeDownloadedImage } from '../vision/analyzer.js'

const DAY_MS = 24 * 3600 * 1000

export interface CollectMemeOptions {
  scope: MemeScope
  category?: string
  extraTags?: string[]
  note?: string
  now?: number
  fetchImpl?: typeof fetch
}

export type CollectMemeResult =
  | { ok: true; meme: MemeRecord; visionUsed: boolean }
  | { ok: false; duplicate?: boolean; existing?: MemeRecord; reason: string }

function parseExtraTokens(raw: string): { category: string; tags: string[]; note: string } {
  const tokens = raw
    .trim()
    .split(/[\s,，]+/)
    .map((t) => t.trim())
    .filter(Boolean)

  let category = 'general'
  const tags: string[] = []
  for (const t of tokens) {
    if (t.startsWith('cat:') || t.startsWith('分类:')) {
      const c = t.replace(/^(?:cat:|分类:)/, '').trim()
      if (c) category = c.slice(0, 24)
    } else if (t !== 'global' && t !== '全局') {
      tags.push(t.slice(0, 16))
    }
  }
  return {
    category,
    tags: [...new Set(tags)].slice(0, 8),
    note: tags.join(' '),
  }
}

export function parseCollectCommandArgs(argText: string): {
  scope: MemeScope
  category: string
  extraTags: string[]
  note: string
} {
  const trimmed = argText.trim()
  const isGlobal = /(?:^|\s)(?:global|全局)(?=\s|$)/i.test(trimmed)
  const parsed = parseExtraTokens(trimmed)
  return {
    scope: isGlobal ? 'global' : 'group',
    category: parsed.category,
    extraTags: parsed.tags,
    note: parsed.note,
  }
}

/**
 * 群友显式授权收藏表情包：
 * - 仅响应主动收藏指令，绝不自动永久保存群友发送的私人照片；
 * - 按 SHA-256 去重，R2 保存二进制原图，D1 保存元数据与保存期限；
 * - 若启用视觉模型则自动提取含义/情绪/标签/适用场景（复用图片缓存）。
 */
export async function collectMemeFromSession(
  session: Session,
  ctx: PluginContext<SocialConfig>,
  opts: CollectMemeOptions,
): Promise<CollectMemeResult> {
  const now = opts.now ?? Date.now()
  await ensureSchema(ctx.db, ctx.logger)

  const refs = extractSessionImages(session, 1)
  if (refs.length === 0) {
    return { ok: false, reason: '请附带一张图片，或引用包含图片的消息后再使用收藏命令。' }
  }

  const ref = refs[0]!
  const dl = await downloadImageSafe(ref.url, {
    maxBytes: ctx.config.max_image_bytes,
    declaredContentType: ref.contentType,
    fetchImpl: opts.fetchImpl,
  })
  if (!dl.ok) {
    return { ok: false, reason: `图片获取失败：${dl.message}` }
  }

  const groupId = opts.scope === 'group' ? session.targetId : null
  const existing = await findMemeByHash(ctx.db, dl.image.hash, opts.scope, groupId)
  if (existing) {
    return {
      ok: false,
      duplicate: true,
      existing,
      reason: `这张表情包已经在${opts.scope === 'global' ? '全局' : '本群'}素材库中了（ID: ${existing.id}）。`,
    }
  }

  const ext = inferImageExtension(dl.image.contentType)
  const r2Key = `memes/${opts.scope}/${groupId ?? 'global'}/${dl.image.hash}.${ext}`

  try {
    await ctx.r2.put(r2Key, dl.image.bytes, {
      contentType: dl.image.contentType,
      metadata: {
        scope: opts.scope,
        groupId: groupId ?? 'global',
        hash: dl.image.hash,
      },
    })
  } catch (err) {
    return {
      ok: false,
      reason: `R2 存储不可用，无法保存表情包图片（请检查 R2 绑定）：${err instanceof Error ? err.message : String(err)}`,
    }
  }

  let meaning = sanitizeSensitiveText(opts.note?.trim() || '群友收藏的表情包').text
  let mood = '搞笑'
  let tags = [...(opts.extraTags ?? [])]
  let sceneHints = '轻松群聊接梗'
  let visionUsed = false

  if (ctx.config.enable_vision) {
    const analyzed = await analyzeDownloadedImage(ctx, dl.image, { now, purpose: 'collect' })
    await recordMultimodalStats(ctx.db, analyzed.statsDelta, now)
    if (analyzed.ok) {
      visionUsed = true
      meaning = analyzed.analysis.memeMeaning || analyzed.analysis.summary || meaning
      mood = analyzed.analysis.mood || mood
      tags = [...new Set([...tags, ...analyzed.analysis.tags])].slice(0, 10)
      sceneHints = analyzed.analysis.sceneHints || sceneHints
    }
  }

  const ttlDays = Math.min(365, Math.max(1, Math.floor(ctx.config.meme_ttl_days || 90)))
  const meme: MemeRecord = {
    id: `meme_${now.toString(36)}_${dl.image.hash.slice(0, 6)}`,
    hash: dl.image.hash,
    scope: opts.scope,
    groupId,
    r2Key,
    contentType: dl.image.contentType,
    sizeBytes: dl.image.sizeBytes,
    meaning: meaning.slice(0, 120),
    mood: mood.slice(0, 24),
    tags,
    sceneHints: sceneHints.slice(0, 80),
    category: (opts.category || 'general').slice(0, 24),
    enabled: true,
    createdBy: session.userId,
    useCount: 0,
    lastUsedAt: 0,
    createdAt: now,
    expiresAt: now + ttlDays * DAY_MS,
  }

  await insertMemeRecord(ctx.db, meme)
  await recordMultimodalStats(ctx.db, { memeCollected: 1 }, now)

  return { ok: true, meme, visionUsed }
}

/** 删除表情包（先删 D1 元数据，若无其他范围引用同一 R2 对象则同步删 R2） */
export async function deleteMemeAsset(
  ctx: PluginContext<SocialConfig>,
  id: string,
  restrictGroupId?: string,
): Promise<{ deleted: boolean; reason?: string }> {
  await ensureSchema(ctx.db, ctx.logger)
  const meme = await getMemeById(ctx.db, id)
  if (!meme) return { deleted: false, reason: '未找到对应表情包' }
  if (restrictGroupId && (meme.scope !== 'group' || meme.groupId !== restrictGroupId)) {
    return { deleted: false, reason: '无权删除非本群的表情包' }
  }

  const changes = await deleteMemeRow(ctx.db, id)
  if (changes > 0) {
    const refs = await countR2KeyReferences(ctx.db, meme.r2Key)
    if (refs === 0) {
      await ctx.r2.delete(meme.r2Key).catch(() => undefined)
    }
  }
  return { deleted: changes > 0 }
}

/** 清理过期表情包（同步清理 D1 与孤立 R2 对象） */
export async function pruneExpiredMemes(ctx: PluginContext<SocialConfig>, now = Date.now()): Promise<number> {
  const expired = await listExpiredMemes(ctx.db, now, 30)
  let removed = 0
  for (const meme of expired) {
    const res = await deleteMemeAsset(ctx, meme.id)
    if (res.deleted) removed += 1
  }
  return removed
}

/** 按关键词检索表情包（支持群级隔离或管理页全局查询） */
export async function searchMemesByQuery(
  ctx: PluginContext<SocialConfig>,
  query: string,
  filter: { scope?: 'all' | 'global' | 'group'; groupId?: string; includeDisabled?: boolean; limit?: number } = {},
  now = Date.now(),
): Promise<MemeRecord[]> {
  await ensureSchema(ctx.db, ctx.logger)
  const all = await listMemesAdmin(ctx.db, { ...filter, limit: 150 }, now)
  const q = query.trim().toLowerCase()
  const limit = Math.min(100, Math.max(1, filter.limit ?? 30))
  if (!q) return all.slice(0, limit)
  const tokens = q.split(/\s+/).filter(Boolean)
  const matched = all.filter((m) => {
    const hay = `${m.id} ${m.meaning} ${m.mood} ${m.category} ${m.sceneHints} ${m.tags.join(' ')}`.toLowerCase()
    return tokens.some((t) => hay.includes(t))
  })
  return matched.slice(0, limit)
}

/** 构造可发给 QQ 的图片载荷：优先走 ctx.publicUrl 的 R2 流式公开路由，缺失时回落 base64 */
export async function resolveMemeOutgoingImage(
  ctx: PluginContext<SocialConfig>,
  meme: MemeRecord,
): Promise<{ url?: string; base64?: string } | null> {
  if (ctx.publicUrl) {
    return { url: `${ctx.publicUrl}/p/${ctx.plugin.name}/meme/${encodeURIComponent(meme.id)}` }
  }
  try {
    const bytes = await ctx.r2.get(meme.r2Key)
    if (!bytes) return null
    return { base64: arrayBufferToBase64(bytes) }
  } catch {
    return null
  }
}

export { getMemeById, updateMemeRecord }
