import type { Route } from '@qqbot/sdk'
import type { SocialConfig } from '../types.js'
import { ensureSchema } from '../store/schema.js'
import {
  countCorpusSummary,
  deleteDialogueExample,
  deleteGroupMeme,
  getLearningGroupSettings,
  getPublishedStyleProfile,
  getStyleProfileById,
  insertLearningAudit,
  insertLearningFeedback,
  listCorpusRecords,
  listDialogueExamples,
  listGroupMemes,
  listLearningAudits,
  listLearningFeedback,
  listLearningSources,
  listLearningUsage,
  listRecentLearningJobs,
  listStyleProfiles,
  purgeGroupLearningData,
  updateDialogueExampleStatus,
  updateStyleProfileContent,
  updateStyleProfileStatus,
  upsertGroupMeme,
  upsertLearningGroupSettings,
} from '../store/learning-db.js'
import { importCorpusChunk, type ImportFieldMapping } from '../learning/importer.js'
import { invalidateStyleCache, type StyleCompileMode } from '../learning/prompt-compiler.js'
import {
  cascadeDeleteCorpusAndInvalidate,
  publishStyleProfileVersion,
  runGroupLearningJob,
} from '../learning/scheduler.js'
import { runStyleLabComparison } from '../learning/feedback.js'

function jsonError(status: number, error: string): Response {
  return Response.json({ ok: false, error }, { status })
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await request.json()
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

export function createLearningRoutes(): Route<SocialConfig>[] {
  return [
    {
      method: 'GET',
      path: '/api/learning/overview',
      auth: 'admin',
      handler: async ({ ctx, request }) => {
        await ensureSchema(ctx.db, ctx.logger)
        const url = new URL(request.url)
        const groupId = (url.searchParams.get('groupId') ?? '').trim()
        if (!groupId) return jsonError(400, '缺少 groupId')
        const [settings, corpusSummary, published, profiles, memes, examples, jobs, sources, usage7d, feedback, audits] =
          await Promise.all([
            getLearningGroupSettings(ctx.db, groupId),
            countCorpusSummary(ctx.db, groupId),
            getPublishedStyleProfile(ctx.db, groupId),
            listStyleProfiles(ctx.db, groupId, 15),
            listGroupMemes(ctx.db, groupId, { status: 'all', limit: 40 }),
            listDialogueExamples(ctx.db, groupId, { activeOnly: false, limit: 30 }),
            listRecentLearningJobs(ctx.db, groupId, 10),
            listLearningSources(ctx.db, groupId, 15),
            listLearningUsage(ctx.db, 7),
            listLearningFeedback(ctx.db, groupId, 20),
            listLearningAudits(ctx.db, groupId, 15),
          ])
        return Response.json({
          ok: true,
          globalEnabled: ctx.config.style_learning_enabled,
          groupId,
          settings: settings ?? { groupId, authorized: false, freezeStable: false, updatedAt: 0 },
          corpusSummary,
          published,
          profiles,
          memes,
          examples,
          jobs,
          sources,
          usage7d,
          feedback,
          audits,
        })
      },
    },
    {
      method: 'PUT',
      path: '/api/learning/settings',
      auth: 'admin',
      handler: async ({ ctx, request }) => {
        await ensureSchema(ctx.db, ctx.logger)
        const body = await readJsonBody(request)
        const groupId = typeof body?.groupId === 'string' ? body.groupId.trim() : ''
        if (!groupId) return jsonError(400, '缺少 groupId')
        const saved = await upsertLearningGroupSettings(ctx.db, groupId, {
          authorized: typeof body?.authorized === 'boolean' ? body.authorized : undefined,
          freezeStable: typeof body?.freezeStable === 'boolean' ? body.freezeStable : undefined,
          stableWeight: typeof body?.stableWeight === 'number' ? body.stableWeight : undefined,
          recentWeight: typeof body?.recentWeight === 'number' ? body.recentWeight : undefined,
          influenceStrength: typeof body?.influenceStrength === 'number' ? body.influenceStrength : undefined,
          retentionDays: typeof body?.retentionDays === 'number' ? body.retentionDays : undefined,
          autoPublish: typeof body?.autoPublish === 'boolean' ? body.autoPublish : undefined,
        })
        invalidateStyleCache(groupId)
        await insertLearningAudit(ctx.db, groupId, 'settings_updated', 'admin', JSON.stringify(saved))
        return Response.json({ ok: true, settings: saved })
      },
    },
    {
      method: 'POST',
      path: '/api/learning/import',
      auth: 'admin',
      handler: async ({ ctx, request }) => {
        await ensureSchema(ctx.db, ctx.logger)
        const body = await readJsonBody(request)
        const groupId = typeof body?.groupId === 'string' ? body.groupId.trim() : ''
        const format = body?.format
        const rawText = typeof body?.rawText === 'string' ? body.rawText : ''
        const rows = Array.isArray(body?.rows) ? body.rows : undefined
        if (
          !groupId ||
          (format !== 'txt' && format !== 'csv' && format !== 'json' && format !== 'jsonl') ||
          (!rawText && (!rows || rows.length === 0))
        ) {
          return jsonError(400, '参数无效：需要 groupId、format (txt/csv/json/jsonl) 以及 rawText 或 rows')
        }
        const groupCfg = await getLearningGroupSettings(ctx.db, groupId)
        const res = await importCorpusChunk({
          db: ctx.db,
          groupId,
          sourceId: typeof body?.sourceId === 'string' ? body.sourceId.trim() : undefined,
          format,
          label: typeof body?.label === 'string' ? body.label.trim() : undefined,
          rawText: rows ? undefined : rawText,
          rows: rows as never,
          mapping: (body?.mapping as ImportFieldMapping | undefined) ?? undefined,
          timezoneOffsetMinutes: typeof body?.timezoneOffsetMinutes === 'number' ? body.timezoneOffsetMinutes : 480,
          blockedKeywords: ctx.config.blocked_keywords,
          retentionDays: groupCfg?.retentionDays ?? ctx.config.style_corpus_retention_days,
          excludeBotMessages: ctx.config.style_exclude_bot_messages,
        })
        await insertLearningAudit(
          ctx.db,
          groupId,
          'corpus_imported',
          'admin',
          `来源 ${res.sourceId}：总 ${res.totalRows} 条，入库 ${res.acceptedRows} 条，去重 ${res.duplicateRows} 条`,
        )
        return Response.json({ ok: true, ...res })
      },
    },
    {
      method: 'GET',
      path: '/api/learning/corpus',
      auth: 'admin',
      handler: async ({ ctx, request }) => {
        await ensureSchema(ctx.db, ctx.logger)
        const url = new URL(request.url)
        const groupId = (url.searchParams.get('groupId') ?? '').trim()
        if (!groupId) return jsonError(400, '缺少 groupId')
        const status = url.searchParams.get('status') || undefined
        const senderId = url.searchParams.get('senderId') || undefined
        const minQualityRaw = url.searchParams.get('minQuality')
        const minQuality = minQualityRaw ? Number(minQualityRaw) : undefined
        const items = await listCorpusRecords(ctx.db, {
          groupId,
          status,
          senderId,
          minQuality: Number.isFinite(minQuality) ? minQuality : undefined,
          limit: 100,
        })
        return Response.json({ ok: true, items })
      },
    },
    {
      method: 'DELETE',
      path: '/api/learning/corpus',
      auth: 'admin',
      handler: async ({ ctx, request }) => {
        await ensureSchema(ctx.db, ctx.logger)
        const body = await readJsonBody(request)
        const groupId = typeof body?.groupId === 'string' ? body.groupId.trim() : ''
        if (!groupId) return jsonError(400, '缺少 groupId')
        const corpusIds = Array.isArray(body?.corpusIds)
          ? body.corpusIds.filter((x): x is string => typeof x === 'string')
          : undefined
        const senderId = typeof body?.pseudonymousSenderId === 'string' ? body.pseudonymousSenderId.trim() : undefined
        const res = await cascadeDeleteCorpusAndInvalidate(ctx, groupId, {
          corpusIds,
          pseudonymousSenderId: senderId,
          actor: 'admin',
        })
        return Response.json({ ok: true, ...res })
      },
    },
    {
      method: 'POST',
      path: '/api/learning/run',
      auth: 'admin',
      handler: async ({ ctx, request }) => {
        await ensureSchema(ctx.db, ctx.logger)
        const body = await readJsonBody(request)
        const groupId = typeof body?.groupId === 'string' ? body.groupId.trim() : ''
        if (!groupId) return jsonError(400, '缺少 groupId')
        const res = await runGroupLearningJob({
          ctx,
          groupId,
          triggerType: 'manual',
          force: body?.force === true,
          actor: 'admin',
        })
        return Response.json(res, { status: res.ok ? 200 : 400 })
      },
    },
    {
      method: 'POST',
      path: '/api/learning/profiles/:profileId/publish',
      auth: 'admin',
      handler: async ({ ctx, params, request }) => {
        await ensureSchema(ctx.db, ctx.logger)
        const profileId = decodeURIComponent(params.profileId ?? '').trim()
        const body = await readJsonBody(request)
        const groupId = typeof body?.groupId === 'string' ? body.groupId.trim() : ''
        if (!profileId || !groupId) return jsonError(400, '缺少 profileId 或 groupId')
        const res = await publishStyleProfileVersion(ctx, groupId, profileId, 'admin')
        return Response.json(res, { status: res.ok ? 200 : 400 })
      },
    },
    {
      method: 'POST',
      path: '/api/learning/profiles/:profileId/status',
      auth: 'admin',
      handler: async ({ ctx, params, request }) => {
        await ensureSchema(ctx.db, ctx.logger)
        const profileId = decodeURIComponent(params.profileId ?? '').trim()
        const body = await readJsonBody(request)
        const status = body?.status
        if (
          !profileId ||
          (status !== 'frozen' && status !== 'rejected' && status !== 'archived' && status !== 'invalidated')
        ) {
          return jsonError(400, '无效的状态变更')
        }
        const existing = await getStyleProfileById(ctx.db, profileId)
        if (!existing) return jsonError(404, '未找到风格档案')
        await updateStyleProfileStatus(ctx.db, profileId, status)
        invalidateStyleCache(existing.groupId)
        await insertLearningAudit(ctx.db, existing.groupId, `profile_${status}`, 'admin', `v${existing.version} (${profileId})`)
        return Response.json({ ok: true })
      },
    },
    {
      method: 'PUT',
      path: '/api/learning/profiles/:profileId',
      auth: 'admin',
      handler: async ({ ctx, params, request }) => {
        await ensureSchema(ctx.db, ctx.logger)
        const profileId = decodeURIComponent(params.profileId ?? '').trim()
        const body = await readJsonBody(request)
        if (!profileId || !body) return jsonError(400, '参数无效')
        const existing = await getStyleProfileById(ctx.db, profileId)
        if (!existing) return jsonError(404, '未找到风格档案')
        const ok = await updateStyleProfileContent(ctx.db, profileId, {
          stableStyle: body.stableStyle as never,
          recentStyle: body.recentStyle as never,
          behaviorProfile: body.behaviorProfile as never,
          notes: typeof body.notes === 'string' ? body.notes : undefined,
        })
        invalidateStyleCache(existing.groupId)
        return Response.json({ ok })
      },
    },
    {
      method: 'PUT',
      path: '/api/learning/memes/:memeId',
      auth: 'admin',
      handler: async ({ ctx, params, request }) => {
        await ensureSchema(ctx.db, ctx.logger)
        const memeId = decodeURIComponent(params.memeId ?? '').trim()
        const body = await readJsonBody(request)
        const groupId = typeof body?.groupId === 'string' ? body.groupId.trim() : ''
        if (!memeId || !groupId) return jsonError(400, '缺少 memeId 或 groupId')
        const all = await listGroupMemes(ctx.db, groupId, { status: 'all', limit: 100 })
        const cur = all.find((m) => m.memeId === memeId)
        if (!cur) return jsonError(404, '未找到热梗')
        await upsertGroupMeme(ctx.db, {
          ...cur,
          meaning: typeof body?.meaning === 'string' ? body.meaning.trim() : cur.meaning,
          applicableContext: typeof body?.applicableContext === 'string' ? body.applicableContext.trim() : cur.applicableContext,
          inappropriateContext:
            typeof body?.inappropriateContext === 'string' ? body.inappropriateContext.trim() : cur.inappropriateContext,
          popularityWeight: typeof body?.popularityWeight === 'number' ? body.popularityWeight : cur.popularityWeight,
          status:
            body?.status === 'candidate' ||
            body?.status === 'active' ||
            body?.status === 'inactive' ||
            body?.status === 'blocked' ||
            body?.status === 'archived'
              ? body.status
              : cur.status,
          updatedAt: Date.now(),
        })
        return Response.json({ ok: true })
      },
    },
    {
      method: 'DELETE',
      path: '/api/learning/memes/:memeId',
      auth: 'admin',
      handler: async ({ ctx, params, request }) => {
        await ensureSchema(ctx.db, ctx.logger)
        const memeId = decodeURIComponent(params.memeId ?? '').trim()
        const url = new URL(request.url)
        const groupId = (url.searchParams.get('groupId') ?? '').trim()
        if (!memeId || !groupId) return jsonError(400, '缺少 memeId 或 groupId')
        const ok = await deleteGroupMeme(ctx.db, groupId, memeId)
        return Response.json({ ok })
      },
    },
    {
      method: 'PUT',
      path: '/api/learning/examples/:exampleId',
      auth: 'admin',
      handler: async ({ ctx, params, request }) => {
        await ensureSchema(ctx.db, ctx.logger)
        const exampleId = decodeURIComponent(params.exampleId ?? '').trim()
        const body = await readJsonBody(request)
        const groupId = typeof body?.groupId === 'string' ? body.groupId.trim() : ''
        const status = body?.status === 'active' || body?.status === 'excluded' ? body.status : null
        if (!exampleId || !groupId || !status) return jsonError(400, '参数无效')
        const ok = await updateDialogueExampleStatus(ctx.db, groupId, exampleId, status)
        return Response.json({ ok })
      },
    },
    {
      method: 'DELETE',
      path: '/api/learning/examples/:exampleId',
      auth: 'admin',
      handler: async ({ ctx, params, request }) => {
        await ensureSchema(ctx.db, ctx.logger)
        const exampleId = decodeURIComponent(params.exampleId ?? '').trim()
        const url = new URL(request.url)
        const groupId = (url.searchParams.get('groupId') ?? '').trim()
        if (!exampleId || !groupId) return jsonError(400, '缺少 exampleId 或 groupId')
        const ok = await deleteDialogueExample(ctx.db, groupId, exampleId)
        return Response.json({ ok })
      },
    },
    {
      method: 'POST',
      path: '/api/learning/lab',
      auth: 'admin',
      handler: async ({ ctx, request }) => {
        await ensureSchema(ctx.db, ctx.logger)
        const body = await readJsonBody(request)
        const groupId = typeof body?.groupId === 'string' ? body.groupId.trim() : ''
        const testMessage = typeof body?.testMessage === 'string' ? body.testMessage.trim() : ''
        const testContext = typeof body?.testContext === 'string' ? body.testContext : ''
        if (!groupId || !testMessage) return jsonError(400, '缺少 groupId 或 testMessage')
        const validModes: StyleCompileMode[] = ['A', 'B', 'C', 'D', 'E']
        const requestedModes = Array.isArray(body?.modes)
          ? body.modes.filter((m): m is StyleCompileMode => validModes.includes(m as StyleCompileMode))
          : validModes
        const res = await runStyleLabComparison({
          ctx,
          groupId,
          testContext,
          testMessage,
          modes: requestedModes.length > 0 ? requestedModes : validModes,
          profileId: typeof body?.profileId === 'string' ? body.profileId.trim() : undefined,
        })
        return Response.json(res, { status: res.ok ? 200 : 400 })
      },
    },
    {
      method: 'POST',
      path: '/api/learning/feedback',
      auth: 'admin',
      handler: async ({ ctx, request }) => {
        await ensureSchema(ctx.db, ctx.logger)
        const body = await readJsonBody(request)
        const groupId = typeof body?.groupId === 'string' ? body.groupId.trim() : ''
        const botReply = typeof body?.botReply === 'string' ? body.botReply.trim() : ''
        const rating = body?.rating
        if (
          !groupId ||
          !botReply ||
          (rating !== 'good' && rating !== 'unnatural' && rating !== 'bad' && rating !== 'meme_fail' && rating !== 'repetitive')
        ) {
          return jsonError(400, '参数无效')
        }
        await insertLearningFeedback(ctx.db, {
          feedbackId: `fb_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
          groupId,
          profileId: typeof body?.profileId === 'string' ? body.profileId : '',
          mode: typeof body?.mode === 'string' ? body.mode : 'lab',
          contextExcerpt: typeof body?.contextExcerpt === 'string' ? body.contextExcerpt : '',
          botReply,
          rating,
          note: typeof body?.note === 'string' ? body.note : '',
          source: body?.source === 'lab' ? 'lab' : 'admin',
          createdAt: Date.now(),
        })
        return Response.json({ ok: true })
      },
    },
    {
      method: 'DELETE',
      path: '/api/learning/group/:groupId',
      auth: 'admin',
      handler: async ({ ctx, params }) => {
        await ensureSchema(ctx.db, ctx.logger)
        const groupId = decodeURIComponent(params.groupId ?? '').trim()
        if (!groupId) return jsonError(400, '缺少 groupId')
        await purgeGroupLearningData(ctx.db, groupId)
        invalidateStyleCache(groupId)
        await insertLearningAudit(ctx.db, groupId, 'group_learning_purged', 'admin', '清空本群全部风格学习数据')
        return Response.json({ ok: true })
      },
    },
  ]
}
