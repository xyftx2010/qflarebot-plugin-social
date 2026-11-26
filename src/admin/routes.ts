import type { Route } from '@qqbot/sdk'
import type { SocialConfig, SocialMode } from '../types.js'
import { ensureSchema } from '../store/schema.js'
import {
  clearGroupMemories,
  deleteGroupMemoryById,
  getGroupSettings,
  listActiveGroupMemories,
  listGroupSettings,
  listTrackedGroups,
  upsertGroupSettings,
} from '../store/db.js'
import { addGroupMemory, resolveMemoryTtlDays } from '../memory/store.js'
import { listAllPersonas, resolvePersona, syncPersonaToAgent } from '../persona/manager.js'
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
        const [settingsList, stateList] = await Promise.all([
          listGroupSettings(ctx.db, 100),
          listTrackedGroups(ctx.db, 100),
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
            defaultMode: ctx.config.default_mode,
            defaultPersona: ctx.config.default_persona,
            yieldAtToAgent: ctx.config.yield_at_to_agent,
            enableMemory: ctx.config.enable_memory,
            memoryTtlDays: ctx.config.memory_ttl_days,
          },
          personas: listAllPersonas(ctx.config),
          groups,
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
