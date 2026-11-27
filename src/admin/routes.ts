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
import {
  getVoiceCacheEntry,
  listGroupVoiceSettings,
  listRecentVoiceLogs,
  summarizeVoiceUsage,
  upsertGroupVoiceSettings,
} from '../store/voice-db.js'
import { addGroupMemory, resolveMemoryTtlDays } from '../memory/store.js'
import { listAllPersonas, resolvePersona, syncPersonaToAgent } from '../persona/manager.js'
import { deleteMemeAsset, getMemeById, searchMemesByQuery, updateMemeRecord } from '../meme/store.js'
import { generateTestToneWav } from '../voice/probe.js'
import { synthesizeSpeech } from '../voice/providers.js'
import type { VoiceTriggerMode } from '../types.js'
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

function parseOptionalTriggerMode(value: unknown): VoiceTriggerMode | null | undefined {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  if (value === 'manual' || value === 'probability' || value === 'ai' || value === 'always') return value
  return undefined
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
    // 公开短期语音路由：供 QQ 拉取 R2 中的临时合成语音（过期自动 404）
    {
      method: 'GET',
      path: '/voice/:cacheKey',
      auth: 'public',
      handler: async ({ ctx, params }) => {
        const cacheKey = decodeURIComponent(params.cacheKey ?? '').trim()
        if (!cacheKey) return new Response('Not Found', { status: 404 })
        await ensureSchema(ctx.db, ctx.logger)
        const entry = await getVoiceCacheEntry(ctx.db, cacheKey, Date.now())
        if (!entry) return new Response('Not Found', { status: 404 })
        try {
          const stream = await ctx.r2.getStream(entry.r2Key)
          if (!stream) return new Response('Not Found', { status: 404 })
          return new Response(stream, {
            status: 200,
            headers: {
              'content-type': entry.contentType,
              'cache-control': 'public, max-age=3600',
            },
          })
        } catch {
          return new Response('Storage Unavailable', { status: 503 })
        }
      },
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
    // ---- V0.10.0 AI 语音管理、试听与日志接口 ----
    {
      method: 'GET',
      path: '/api/voice/overview',
      auth: 'admin',
      handler: async ({ ctx }) => {
        await ensureSchema(ctx.db, ctx.logger)
        const since7d = Date.now() - 7 * 24 * 3600 * 1000
        const [usage7d, groupSettings, logs] = await Promise.all([
          summarizeVoiceUsage(ctx.db, since7d),
          listGroupVoiceSettings(ctx.db, 100),
          listRecentVoiceLogs(ctx.db, 30),
        ])
        return Response.json({
          ok: true,
          config: {
            enableVoice: ctx.config.enable_voice,
            provider: ctx.config.tts_provider,
            hasApiKey: Boolean(ctx.config.tts_api_key.trim()),
            model: ctx.config.tts_model,
            voiceId: ctx.config.tts_voice_id,
            speed: ctx.config.tts_speed,
            emotion: ctx.config.tts_emotion,
            format: ctx.config.tts_audio_format,
            triggerMode: ctx.config.voice_trigger_mode,
            probability: ctx.config.voice_probability,
            dailyLimit: ctx.config.voice_daily_limit_per_group,
            maxChars: ctx.config.voice_max_chars,
            fallbackToText: ctx.config.voice_fallback_to_text,
            cacheTtlHours: ctx.config.voice_cache_ttl_hours,
            costPer1kChars: ctx.config.voice_cost_per_1k_chars,
          },
          usage7d,
          groupSettings,
          logs,
        })
      },
    },
    {
      method: 'PUT',
      path: '/api/voice/groups/:groupId',
      auth: 'admin',
      handler: async ({ ctx, params, request }) => {
        const groupId = decodeURIComponent(params.groupId ?? '').trim()
        if (!groupId) return jsonError(400, '缺少 groupId')
        const body = await readJsonBody(request)
        if (!body) return jsonError(400, '请求体必须是 JSON 对象')
        await ensureSchema(ctx.db, ctx.logger)
        const saved = await upsertGroupVoiceSettings(ctx.db, groupId, {
          enabled:
            body.enabled === undefined
              ? undefined
              : body.enabled === null || body.enabled === ''
                ? null
                : Boolean(body.enabled),
          triggerMode: parseOptionalTriggerMode(body.triggerMode),
          probability: parseOptionalNumber(body.probability, 0, 1),
          voiceId:
            body.voiceId === undefined
              ? undefined
              : body.voiceId === null || body.voiceId === ''
                ? null
                : String(body.voiceId).trim().slice(0, 64),
          speed: parseOptionalNumber(body.speed, 0.5, 2.0),
          emotion:
            body.emotion === undefined
              ? undefined
              : body.emotion === null || body.emotion === ''
                ? null
                : String(body.emotion).trim().slice(0, 24),
          dailyLimit: parseOptionalNumber(body.dailyLimit, 0, 500),
        })
        return Response.json({ ok: true, settings: saved })
      },
    },
    {
      method: 'POST',
      path: '/api/voice/preview',
      auth: 'admin',
      handler: async ({ ctx, request }) => {
        const body = await readJsonBody(request)
        const text = (typeof body?.text === 'string' ? body.text : '你好呀，这是一条拟人群聊的语音试听测试！').trim()
        if (!text || text.length > 100) return jsonError(400, '试听文本需在 1 ~ 100 字之间')
        if (!ctx.config.tts_api_key.trim()) return jsonError(400, '请先在插件配置中填写 TTS API Key')
        try {
          const res = await synthesizeSpeech({
            text,
            provider: ctx.config.tts_provider,
            apiBaseUrl: ctx.config.tts_api_base_url,
            apiKey: ctx.config.tts_api_key,
            model: ctx.config.tts_model,
            voiceId: typeof body?.voiceId === 'string' && body.voiceId.trim() ? body.voiceId.trim() : ctx.config.tts_voice_id,
            speed: typeof body?.speed === 'number' ? body.speed : ctx.config.tts_speed,
            pitch: ctx.config.tts_pitch,
            volume: ctx.config.tts_volume,
            emotion: typeof body?.emotion === 'string' ? body.emotion.trim() : ctx.config.tts_emotion,
            format: ctx.config.tts_audio_format,
            timeoutMs: ctx.config.tts_timeout_ms,
          })
          return new Response(res.bytes, {
            status: 200,
            headers: { 'content-type': res.contentType },
          })
        } catch (err) {
          return jsonError(502, err instanceof Error ? err.message : String(err))
        }
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
