import type { Route } from '@qqbot/sdk'
import type { SocialConfig, SocialMode } from '../types.js'
import { ensureSchema, listAppliedMigrations } from '../store/schema.js'
import {
  clearGroupMemories,
  deleteGroupMemoryById,
  getGroupSettings,
  listActiveGroupMemories,
  listGroupSettings,
  listTrackedGroups,
  upsertGroupSettings,
} from '../store/db.js'
import { listMultimodalStats } from '../store/multimodal-db.js'
import { addGroupMemory, resolveMemoryTtlDays } from '../memory/store.js'
import { listAllPersonas, resolvePersona, syncPersonaToAgent } from '../persona/manager.js'
import { deleteMemeAsset, getMemeById, searchMemesByQuery, updateMemeRecord } from '../meme/store.js'
import { generateTestToneWav } from '../voice/probe.js'
import { ADMIN_PAGE_HTML } from './page.js'

function jsonError(status: number, error: string): Response {
  return Response.json({ ok: false, error }, { status })
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await request.json()
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return null
  } catch {
    return null
  }
}

function parseOptionalMode(value: unknown): SocialMode | null | undefined {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  if (value === 'auto' || value === 'at' || value === 'off') return value
  return undefined
}

function parseOptionalNumber(value: unknown, min: number, max: number): number | null | undefined {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  const num = Number(value)
  if (!Number.isFinite(num)) return undefined
  return Math.min(max, Math.max(min, num))
}

export function createAdminRoutes(): Route<SocialConfig>[] {
  return [
    // Phase 1 语音发送可行性测试音频路由（公开只读 1 秒 440Hz WAV 提示音）
    {
      method: 'GET',
      path: '/voice-test/sample.wav',
      auth: 'public',
      handler: () =>
        new Response(generateTestToneWav(1000), {
          status: 200,
          headers: {
            'content-type': 'audio/wav',
            'cache-control': 'public, max-age=3600',
          },
        }),
    },
    // 公开路由：供 QQ 平台拉取 R2 中已授权收藏的表情包原图（流式返回，零 base64 内存开销）
    {
      method: 'GET',
      path: '/meme/:id',
      auth: 'public',
      handler: async ({ ctx, params }) => {
        const id = decodeURIComponent(params.id ?? '').trim()
        if (!id) return new Response('Not Found', { status: 404 })
        await ensureSchema(ctx.db, ctx.logger)
        const meme = await getMemeById(ctx.db, id)
        if (!meme || !meme.enabled || meme.expiresAt <= Date.now()) {
          return new Response('Not Found', { status: 404 })
        }
        try {
          const stream = await ctx.r2.getStream(meme.r2Key)
          if (!stream) return new Response('Not Found', { status: 404 })
          return new Response(stream, {
            status: 200,
            headers: {
              'content-type': meme.contentType,
              'cache-control': 'public, max-age=86400',
            },
          })
        } catch {
          return new Response('Storage Unavailable', { status: 503 })
        }
      },
    },
    {
      method: 'GET',
      path: '/ui/*',
      auth: 'admin',
      handler: () =>
        new Response(ADMIN_PAGE_HTML, {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
    },
    {
      method: 'GET',
      path: '/api/overview',
      auth: 'admin',
      handler: async ({ ctx }) => {
        await ensureSchema(ctx.db, ctx.logger)
        const [settingsList, stateList, stats, migrations] = await Promise.all([
          listGroupSettings(ctx.db, 100),
          listTrackedGroups(ctx.db, 100),
          listMultimodalStats(ctx.db, 7),
          listAppliedMigrations(ctx.db),
        ])
        const settingsMap = new Map(settingsList.map((s) => [s.groupId, s]))
        const stateMap = new Map(stateList.map((s) => [s.groupId, s]))
        const groupIds = new Set<string>([...settingsMap.keys(), ...stateMap.keys()])

        const groups = [...groupIds].map((groupId) => {
          const settings = settingsMap.get(groupId) ?? null
          const state = stateMap.get(groupId) ?? null
          const persona = resolvePersona(ctx.config, settings)
          return {
            groupId,
            mode: settings?.mode ?? ctx.config.default_mode,
            modeOverride: settings?.mode ?? null,
            personaId: persona.id,
            personaName: persona.name,
            personaOverride: settings?.personaId ?? null,
            cooldownSeconds: settings?.cooldownSeconds ?? ctx.config.cooldown_seconds,
            replyProbability: settings?.replyProbability ?? ctx.config.base_reply_probability,
            memoryTtlDays: resolveMemoryTtlDays(ctx.config, settings),
            contextCount: state?.recentMessages.length ?? 0,
            lastReplyAt: state?.lastReplyAt ?? 0,
            lastNonAtSeenAt: state?.lastNonAtSeenAt ?? 0,
            updatedAt: Math.max(settings?.updatedAt ?? 0, state?.updatedAt ?? 0),
          }
        })

        groups.sort((a, b) => b.updatedAt - a.updatedAt)

        return Response.json({
          ok: true,
          config: {
            modelAlias: ctx.config.model_alias || '(默认模型)',
            visionModelAlias: ctx.config.vision_model_alias || '(跟随对话模型)',
            defaultMode: ctx.config.default_mode,
            defaultPersona: ctx.config.default_persona,
            yieldAtToAgent: ctx.config.yield_at_to_agent,
            enableMemory: ctx.config.enable_memory,
            memoryTtlDays: ctx.config.memory_ttl_days,
            enableVision: ctx.config.enable_vision,
            visionRateLimitPerMinute: ctx.config.vision_rate_limit_per_minute,
            enableMemeReply: ctx.config.enable_meme_reply,
            memeSendProbability: ctx.config.meme_send_probability,
            memeRepeatCooldownSeconds: ctx.config.meme_repeat_cooldown_seconds,
            memeTtlDays: ctx.config.meme_ttl_days,
            useGlobalMemeLibrary: ctx.config.use_global_meme_library,
          },
          personas: listAllPersonas(ctx.config),
          groups,
          multimodalStats: stats,
          migrations,
        })
      },
    },
    {
      method: 'PUT',
      path: '/api/groups/:groupId',
      auth: 'admin',
      handler: async ({ ctx, params, request }) => {
        const groupId = decodeURIComponent(params.groupId ?? '').trim()
        if (!groupId) return jsonError(400, '缺少 groupId')
        const body = await readJsonBody(request)
        if (!body) return jsonError(400, '请求体必须是 JSON 对象')

        await ensureSchema(ctx.db, ctx.logger)
        const saved = await upsertGroupSettings(ctx.db, groupId, {
          mode: parseOptionalMode(body.mode),
          personaId:
            body.personaId === undefined
              ? undefined
              : body.personaId === null || body.personaId === ''
                ? null
                : String(body.personaId).trim(),
          cooldownSeconds: parseOptionalNumber(body.cooldownSeconds, 0, 3600),
          replyProbability: parseOptionalNumber(body.replyProbability, 0, 1),
          memoryTtlDays: parseOptionalNumber(body.memoryTtlDays, 1, 90),
        })
        return Response.json({ ok: true, settings: saved })
      },
    },
    {
      method: 'GET',
      path: '/api/groups/:groupId/memories',
      auth: 'admin',
      handler: async ({ ctx, params }) => {
        const groupId = decodeURIComponent(params.groupId ?? '').trim()
        if (!groupId) return jsonError(400, '缺少 groupId')
        await ensureSchema(ctx.db, ctx.logger)
        const memories = await listActiveGroupMemories(ctx.db, groupId, Date.now(), 100)
        return Response.json({ ok: true, groupId, memories })
      },
    },
    {
      method: 'POST',
      path: '/api/groups/:groupId/memories',
      auth: 'admin',
      handler: async ({ ctx, params, request }) => {
        const groupId = decodeURIComponent(params.groupId ?? '').trim()
        if (!groupId) return jsonError(400, '缺少 groupId')
        const body = await readJsonBody(request)
        if (!body || typeof body.content !== 'string') return jsonError(400, '缺少记忆内容 content')

        await ensureSchema(ctx.db, ctx.logger)
        const settings = await getGroupSettings(ctx.db, groupId)
        const res = await addGroupMemory(ctx.db, {
          groupId,
          scope: 'group',
          content: body.content,
          ttlDays: resolveMemoryTtlDays(ctx.config, settings),
          maxPerGroup: ctx.config.max_memories_per_group,
        })
        if (!res.ok) return jsonError(400, res.reason)
        return Response.json({ ok: true, memory: res.memory })
      },
    },
    {
      method: 'DELETE',
      path: '/api/groups/:groupId/memories/:id',
      auth: 'admin',
      handler: async ({ ctx, params }) => {
        const groupId = decodeURIComponent(params.groupId ?? '').trim()
        const id = decodeURIComponent(params.id ?? '').trim()
        if (!groupId || !id) return jsonError(400, '缺少 groupId 或记忆 id')
        await ensureSchema(ctx.db, ctx.logger)
        const deleted = await deleteGroupMemoryById(ctx.db, groupId, id)
        return Response.json({ ok: true, deleted })
      },
    },
    {
      method: 'DELETE',
      path: '/api/groups/:groupId/memories',
      auth: 'admin',
      handler: async ({ ctx, params }) => {
        const groupId = decodeURIComponent(params.groupId ?? '').trim()
        if (!groupId) return jsonError(400, '缺少 groupId')
        await ensureSchema(ctx.db, ctx.logger)
        const deleted = await clearGroupMemories(ctx.db, groupId)
        return Response.json({ ok: true, deleted })
      },
    },
    // ---- V0.5.0 表情包素材库管理接口 ----
    {
      method: 'GET',
      path: '/api/memes',
      auth: 'admin',
      handler: async ({ ctx, request }) => {
        const url = new URL(request.url)
        const scopeParam = url.searchParams.get('scope') ?? 'all'
        const scope = scopeParam === 'global' || scopeParam === 'group' ? scopeParam : 'all'
        const groupId = url.searchParams.get('groupId')?.trim() || undefined
        const q = url.searchParams.get('q')?.trim() || ''
        const memes = await searchMemesByQuery(ctx, q, {
          scope,
          groupId,
          includeDisabled: true,
          limit: 100,
        })
        return Response.json({ ok: true, memes })
      },
    },
    {
      method: 'PATCH',
      path: '/api/memes/:id',
      auth: 'admin',
      handler: async ({ ctx, params, request }) => {
        const id = decodeURIComponent(params.id ?? '').trim()
        if (!id) return jsonError(400, '缺少表情包 id')
        const body = await readJsonBody(request)
        if (!body) return jsonError(400, '请求体必须是 JSON 对象')
        await ensureSchema(ctx.db, ctx.logger)
        const tags = Array.isArray(body.tags)
          ? body.tags.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).map((t) => t.trim())
          : undefined
        const updated = await updateMemeRecord(ctx.db, id, {
          enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
          category: typeof body.category === 'string' ? body.category.trim().slice(0, 24) : undefined,
          meaning: typeof body.meaning === 'string' ? body.meaning.trim().slice(0, 120) : undefined,
          mood: typeof body.mood === 'string' ? body.mood.trim().slice(0, 24) : undefined,
          sceneHints: typeof body.sceneHints === 'string' ? body.sceneHints.trim().slice(0, 80) : undefined,
          tags,
        })
        if (!updated) return jsonError(404, '未找到对应表情包')
        return Response.json({ ok: true })
      },
    },
    {
      method: 'DELETE',
      path: '/api/memes/:id',
      auth: 'admin',
      handler: async ({ ctx, params }) => {
        const id = decodeURIComponent(params.id ?? '').trim()
        if (!id) return jsonError(400, '缺少表情包 id')
        const res = await deleteMemeAsset(ctx, id)
        if (!res.deleted) return jsonError(404, res.reason ?? '删除失败')
        return Response.json({ ok: true, deleted: 1 })
      },
    },
    {
      method: 'POST',
      path: '/api/sync-agent',
      auth: 'admin',
      handler: async ({ ctx, request }) => {
        const body = await readJsonBody(request)
        const personaId = typeof body?.personaId === 'string' ? body.personaId.trim() : undefined
        const persona = resolvePersona(ctx.config, null, personaId)
        const result = await syncPersonaToAgent(ctx, persona)
        return Response.json({ ok: result.synced, personaId: persona.id, ...result })
      },
    },
  ]
}
