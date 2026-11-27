import { definePlugin, meetsPermission } from '@qqbot/sdk'
import type { AgentPromptService, LLMService, SocialConfig, SocialMode } from './types.js'
import { configSchema, defaultConfig } from './config.js'
import { ensureSchema } from './store/schema.js'
import {
  clearGroupMemories,
  deleteMemberMemories,
  getGroupSettings,
  getGroupState,
  getMemberPrivacy,
  listActiveGroupMemories,
  setMemberOptOut,
  upsertGroupSettings,
} from './store/db.js'
import { listAvailableMemesForGroup, listMultimodalStats } from './store/multimodal-db.js'
import { countGroupVoiceSentToday, getGroupVoiceSettings } from './store/voice-db.js'
import {
  deletePromptFragment,
  getAgentToolPolicy,
  listLLMUsageStats,
  listPromptFragments,
  setPromptFragmentEnabled,
  upsertPromptFragment,
} from './store/agent-db.js'
import { resolveEffectiveVoiceConfig } from './voice/decision.js'
import { recordVoiceSendLog, synthesizeAndPrepareVoice } from './voice/service.js'
import { addGroupMemory, resolveMemoryTtlDays } from './memory/store.js'
import { listAllPersonas, resolvePersona, syncPersonaToAgent } from './persona/manager.js'
import { resolveEffectiveCooldownSeconds, resolveEffectiveMode } from './trigger/gate.js'
import { resolveVisionModelAlias } from './vision/analyzer.js'
import {
  collectMemeFromSession,
  deleteMemeAsset,
  parseCollectCommandArgs,
  searchMemesByQuery,
  updateMemeRecord,
} from './meme/store.js'
import { handleGroupChatEvent } from './chat/pipeline.js'
import { createSocialService, createSocialTools } from './chat/tools.js'
import { createAdminRoutes } from './admin/routes.js'
import { generateTestToneWavBase64 } from './voice/probe.js'

const HELP_TEXT = [
  '拟人群聊（social v0.11.0 · 独立 Social Agent）命令：',
  '/ask <问题>（/问）— 直接向 Social Agent 提问（支持工具调用）',
  '/social status — 查看本群状态、权限、模型用量与多模态/语音诊断',
  '/social tools — 查看当前启用的内置工具与外部插件工具白名单（群管理员）',
  '/social persona [名称|off] — 查看/切换本群人格（群管理员）',
  '/social mode <auto|at|off> — 切换本群发言模式（群管理员）',
  '/social memory [list|add <内容>|clear] — 管理本群记忆（群管理员）',
  '/social forgetme（/忘掉我）— 删除本人在本群的全部记忆',
  '/social privacy <on|off> — 开启/关闭本人在本群的记忆收集',
  '/social collect [标签] [分类:xxx]（/收藏表情）— 收藏当前或引用消息中的表情包',
  '/social memes [关键词|disable <id>|enable <id>|del <id>]（/表情库）— 搜索或管理表情包库',
  '/social say <内容>（/说）— 手动发送原生语音消息',
  '/social voicetest <wav-b64|wav-url|url> — 测试 QQ 原生语音发送（群管理员）',
].join('\n')

function formatTime(ts: number): string {
  if (!ts) return '未记录'
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
}

export default definePlugin<SocialConfig>({
  name: 'social',
  apiVersion: 5,
  displayName: '拟人群聊',
  description:
    'QQ 群聊多模态拟人娱乐互动插件：自然对话、图片理解、表情包素材库、智能接梗、人格设定与群级隔离记忆。',
  permissions: ['db', 'net'],

  depends: {
    llm: '*',
    'core.tools': 'optional',
  },

  configSchema,
  defaultConfig,

  hooks: {
    async onInstall(ctx) {
      await ensureSchema(ctx.db, ctx.logger)
    },
    async onBoot(ctx) {
      await ensureSchema(ctx.db, ctx.logger)
    },
  },

  services: {
    social: (ctx) => createSocialService(ctx),
    /** 兼容生态插件的 AgentService 提示词扩展契约（不含已弃用的 registerTool） */
    agent: (ctx): AgentPromptService => ({
      async registerPrompt(plugin, fragment, priority) {
        await ensureSchema(ctx.db, ctx.logger)
        return upsertPromptFragment(ctx.db, plugin, fragment, priority)
      },
      async disablePrompt(plugin) {
        await ensureSchema(ctx.db, ctx.logger)
        return setPromptFragmentEnabled(ctx.db, plugin, false)
      },
      async clearPrompt(plugin) {
        await ensureSchema(ctx.db, ctx.logger)
        return deletePromptFragment(ctx.db, plugin)
      },
      async listPrompts() {
        await ensureSchema(ctx.db, ctx.logger)
        const rows = await listPromptFragments(ctx.db, false)
        return rows.map((r) => ({
          plugin: r.plugin,
          fragment: r.fragment,
          priority: r.priority,
          enabled: r.enabled,
        }))
      },
    }),
  },

  tools: createSocialTools(),

  commands: {
    ask: {
      aliases: ['问'],
      description: '向Social Agent提问',
      usage: '/ask <问题>',
      scenes: ['group', 'c2c'],
      async handler({ session, ctx, argText }) {
        const text = argText.trim()
        if (!text) return '用法：/ask <你的问题>'
        await handleGroupChatEvent(session, ctx, { forceReply: true, overrideText: text })
        return undefined
      },
    },

    social: {
      aliases: ['社交'],
      description: '拟人群聊帮助',
      scenes: ['group'],
      handler: () => HELP_TEXT,
    },

    'social status': {
      aliases: ['社交 状态'],
      description: '查看群状态与权限',
      scenes: ['group'],
      async handler({ session, ctx }) {
        await ensureSchema(ctx.db, ctx.logger)
        const groupId = session.targetId
        const now = Date.now()
        const [settings, state, memories, memes, stats, groupVoice, voiceToday, llmUsage, toolPolicy] = await Promise.all([
          getGroupSettings(ctx.db, groupId),
          getGroupState(ctx.db, groupId),
          listActiveGroupMemories(ctx.db, groupId, now, 60),
          listAvailableMemesForGroup(
            ctx.db,
            groupId,
            ctx.config.use_global_meme_library,
            now,
            100,
            ctx.config.share_memes_across_groups,
          ),
          listMultimodalStats(ctx.db, 1),
          getGroupVoiceSettings(ctx.db, groupId),
          countGroupVoiceSentToday(ctx.db, groupId, now),
          listLLMUsageStats(ctx.db, 1),
          getAgentToolPolicy(ctx.db),
        ])
        const effectiveVoice = resolveEffectiveVoiceConfig(ctx.config, groupVoice)
        const mode = resolveEffectiveMode(ctx.config, settings)
        const persona = resolvePersona(ctx.config, settings)
        const cooldown = resolveEffectiveCooldownSeconds(ctx.config, settings)

        const configuredAlias = (ctx.config.model_alias ?? '').trim()
        let llmStatus = '正常'
        let visionStatus = ctx.config.enable_vision ? '待检查' : '已关闭'
        try {
          const llm = ctx.service<LLMService>('llm')
          const resolved = await llm.resolve(configuredAlias || undefined)
          llmStatus = `正常（${resolved.alias}）`
          if (ctx.config.enable_vision) {
            const vAlias = resolveVisionModelAlias(ctx.config)
            const vResolved = await llm.resolve(vAlias)
            visionStatus = vResolved.capabilities.includes('image')
              ? `正常（${vResolved.alias}，支持看图）`
              : `已降级（${vResolved.alias} 未开启 image 能力）`
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          llmStatus = `不可用（配置别名：${configuredAlias || '默认'}；原因：${msg}）`
          if (ctx.config.enable_vision) visionStatus = '不可用'
        }

        const nonAtDiag = state?.lastNonAtSeenAt
          ? `已收到（最近：${formatTime(state.lastNonAtSeenAt)}）`
          : '尚未观测到（若需自然插话，请群主在群内开启机器人「获取群内全部消息」权限）'

        const today = stats[0]
        const todayLine = today
          ? `看图 ${today.visionCalls} 次（缓存命中 ${today.visionCacheHits}）/ 发图 ${today.memeSent} 次 / 收藏 ${today.memeCollected} 次`
          : '今日暂无多模态调用'

        const voiceLine = effectiveVoice.enabled
          ? `开（${ctx.config.tts_provider} / ${effectiveVoice.triggerMode} / 今日 ${voiceToday}${effectiveVoice.dailyLimit ? `/${effectiveVoice.dailyLimit}` : ''} 条）`
          : ctx.config.enable_voice
            ? '未就绪（缺少 TTS API Key）'
            : '关'

        const todayLlm = llmUsage[0]
        const llmUsageLine = todayLlm
          ? `${todayLlm.runs} 次调用 / ${todayLlm.toolCalls} 次工具 / ${todayLlm.inputTokens + todayLlm.outputTokens} tokens`
          : '今日暂无调用'

        return [
          '【本群拟人聊天状态 v0.11.1 · 自适应 Social Agent】',
          `- 发言模式：${mode}`,
          `- 当前人格：${persona.name}（${persona.id}）`,
          `- 自适应路由：${ctx.config.enable_agent_tools && ctx.config.adaptive_agent_enabled ? `${ctx.config.agent_routing_mode}（非@工具:${ctx.config.agent_allow_non_mention ? '开' : '关'} / 自主升级:${ctx.config.agent_auto_escalate ? '开' : '关'} / Top-${ctx.config.agent_candidate_top_k}）` : '关'}`,
          `- 冷却时间：${cooldown} 秒（每分钟上限 ${ctx.config.max_replies_per_minute} 条）`,
          `- 非@全量消息权限：${nonAtDiag}`,
          `- 短期上下文：${state?.recentMessages.length ?? 0} 条（预算 ${ctx.config.context_max_tokens} tokens）`,
          `- 本群活跃记忆：${memories.length} 条（保留 ${resolveMemoryTtlDays(ctx.config, settings)} 天）`,
          `- 可用表情包：${memes.length} 张（智能发图：${ctx.config.enable_meme_reply ? '开' : '关'}）`,
          `- AI 语音互动：${voiceLine}`,
          `- 对话模型：${llmStatus}`,
          `- 图片理解：${visionStatus}`,
          `- 今日模型用量：${llmUsageLine}`,
          `- 多模态统计：${todayLine}`,
        ].join('\n')
      },
    },

    'social persona': {
      aliases: ['社交 人格'],
      description: '查看或切换本群人格',
      usage: '/social persona [ID|名称|off]',
      permission: 'group_admin',
      scenes: ['group'],
      async handler({ session, ctx, argText }) {
        await ensureSchema(ctx.db, ctx.logger)
        const groupId = session.targetId
        const wanted = argText.trim()
        const all = listAllPersonas(ctx.config)

        if (!wanted) {
          const settings = await getGroupSettings(ctx.db, groupId)
          const active = resolvePersona(ctx.config, settings)
          const list = all.map((p) => `- ${p.id}（${p.name}）：${p.description}`).join('\n')
          return [`当前本群人格：${active.name}（${active.id}）`, '', '可选人格：', list].join('\n')
        }

        if (wanted === 'off' || wanted === 'default' || wanted === '默认') {
          await upsertGroupSettings(ctx.db, groupId, { personaId: null })
          const fallback = resolvePersona(ctx.config, null)
          return `已恢复本群默认人格：${fallback.name}（${fallback.id}）。`
        }

        const matched = all.find((p) => p.id === wanted || p.name === wanted)
        if (!matched) {
          return `未找到人格「${wanted}」。可选：${all.map((p) => `${p.id}(${p.name})`).join('、')}`
        }

        await upsertGroupSettings(ctx.db, groupId, { personaId: matched.id })
        return `本群人格已切换为「${matched.name}（${matched.id}）」。`
      },
    },

    'social mode': {
      aliases: ['社交 模式'],
      description: '切换本群发言模式',
      usage: '/social mode <auto|at|off>',
      permission: 'group_admin',
      scenes: ['group'],
      async handler({ session, ctx, args }) {
        await ensureSchema(ctx.db, ctx.logger)
        const next = (args[0] ?? '').toLowerCase()
        if (next !== 'auto' && next !== 'at' && next !== 'off') {
          return '用法：/social mode <auto|at|off>（auto=智能插话，at=仅@回复，off=关闭）'
        }
        await upsertGroupSettings(ctx.db, session.targetId, { mode: next as SocialMode })
        return `本群拟人聊天模式已切换为：${next}。`
      },
    },

    'social memory': {
      aliases: ['社交 记忆'],
      description: '管理本群长期记忆',
      usage: '/social memory [list|add <内容>|clear]',
      permission: 'group_admin',
      scenes: ['group'],
      async handler({ session, ctx, argText }) {
        await ensureSchema(ctx.db, ctx.logger)
        const groupId = session.targetId
        const trimmed = argText.trim()
        const [sub = 'list', ...rest] = trimmed ? trimmed.split(/\s+/) : ['list']

        if (sub === 'clear' || sub === '清空') {
          const count = await clearGroupMemories(ctx.db, groupId)
          return `已清空本群全部记忆（共 ${count} 条）。`
        }

        if (sub === 'add' || sub === '添加') {
          const content = rest.join(' ').trim()
          if (!content) return '用法：/social memory add <记忆内容>'
          const settings = await getGroupSettings(ctx.db, groupId)
          const res = await addGroupMemory(ctx.db, {
            groupId,
            scope: 'group',
            content,
            ttlDays: resolveMemoryTtlDays(ctx.config, settings),
            maxPerGroup: ctx.config.max_memories_per_group,
          })
          return res.ok ? `已添加本群公共记忆：${res.memory.content}` : `添加失败：${res.reason}`
        }

        const memories = await listActiveGroupMemories(ctx.db, groupId, Date.now(), 15)
        if (memories.length === 0) return '本群当前没有活跃的长期记忆。'
        const lines = memories.map((m, i) => {
          const tag = m.scope === 'member' ? `[${m.userName ?? '成员'}]` : '[群公共]'
          return `${i + 1}. ${tag} ${m.content}`
        })
        return ['本群近期记忆（最多展示 15 条）：', ...lines, '', '清空可用 /social memory clear'].join('\n')
      },
    },

    'social forgetme': {
      aliases: ['忘掉我'],
      description: '删除本人在本群记忆',
      scenes: ['group'],
      async handler({ session, ctx }) {
        await ensureSchema(ctx.db, ctx.logger)
        const deleted = await deleteMemberMemories(ctx.db, session.targetId, session.userId)
        return deleted > 0
          ? `已删除你在本群的 ${deleted} 条个人记忆。如需停止后续收集，可发送 /social privacy off。`
          : '我在本群目前没有关于你的个人记忆。如需停止后续收集，可发送 /social privacy off。'
      },
    },

    'social privacy': {
      aliases: ['社交 隐私'],
      description: '开关个人记忆收集',
      usage: '/social privacy <on|off>',
      scenes: ['group'],
      async handler({ session, ctx, args }) {
        await ensureSchema(ctx.db, ctx.logger)
        const groupId = session.targetId
        const arg = (args[0] ?? '').toLowerCase()
        if (!arg) {
          const cur = await getMemberPrivacy(ctx.db, groupId, session.userId)
          return cur?.optOut
            ? '当前状态：已关闭本人在本群的记忆收集（privacy off）。发送 /social privacy on 可重新开启。'
            : '当前状态：允许记录本人在本群的公开娱乐记忆（privacy on）。发送 /social privacy off 可关闭。'
        }
        if (arg === 'off' || arg === '关') {
          await setMemberOptOut(ctx.db, groupId, session.userId, true)
          return '已为你关闭本群的个人记忆收集。如需同时清除已有记忆，请发送 /social forgetme。'
        }
        if (arg === 'on' || arg === '开') {
          await setMemberOptOut(ctx.db, groupId, session.userId, false)
          return '已为你开启本群的公开娱乐记忆收集。'
        }
        return '用法：/social privacy <on|off>'
      },
    },

    'social collect': {
      aliases: ['收藏表情'],
      description: '收藏当前或引用表情包',
      usage: '/social collect [标签] [分类:xxx]',
      scenes: ['group'],
      async handler({ session, ctx, argText }) {
        const defaultScope = ctx.config.share_memes_across_groups ? 'global' : 'group'
        const parsed = parseCollectCommandArgs(argText, defaultScope)
        if (!ctx.config.share_memes_across_groups && parsed.scope === 'global' && !meetsPermission(session, 'group_admin')) {
          return '只有群管理员或 Bot 管理员才能将表情包收藏到全局素材库。'
        }
        const res = await collectMemeFromSession(session, ctx, {
          scope: ctx.config.share_memes_across_groups ? 'global' : parsed.scope,
          category: parsed.category,
          extraTags: parsed.extraTags,
          note: parsed.note,
        })
        if (!res.ok) return res.reason
        const tagLine = res.meme.tags.length ? res.meme.tags.join('、') : '无'
        return [
          `已收藏到${ctx.config.share_memes_across_groups ? '共享' : res.meme.scope === 'global' ? '全局' : '本群'}表情包库！`,
          `- ID：${res.meme.id}`,
          `- 含义：${res.meme.meaning}`,
          `- 情绪：${res.meme.mood}｜标签：${tagLine}`,
          `- 视觉自动识别：${res.visionUsed ? '是' : '否（使用手动/默认标签）'}`,
        ].join('\n')
      },
    },

    'social memes': {
      aliases: ['表情库'],
      description: '查看管理表情包库',
      usage: '/social memes [关键词|disable <id>|enable <id>|del <id>]',
      scenes: ['group'],
      async handler({ session, ctx, argText }) {
        await ensureSchema(ctx.db, ctx.logger)
        const groupId = session.targetId
        const trimmed = argText.trim()
        const [sub = '', ...rest] = trimmed ? trimmed.split(/\s+/) : ['']

        if (sub === 'del' || sub === 'delete' || sub === '删除') {
          if (!meetsPermission(session, 'group_admin')) return '只有群管理员或 Bot 管理员可以删除表情包。'
          const id = rest[0]?.trim()
          if (!id) return '用法：/social memes del <表情包ID>'
          const restrictGroup = ctx.config.share_memes_across_groups || session.isBotAdmin ? undefined : groupId
          const res = await deleteMemeAsset(ctx, id, restrictGroup)
          return res.deleted ? `已删除表情包 ${id}（同步清理 R2 原图）。` : (res.reason ?? '删除失败')
        }

        if (sub === 'disable' || sub === 'enable' || sub === '禁用' || sub === '启用') {
          if (!meetsPermission(session, 'group_admin')) return '只有群管理员或 Bot 管理员可以启停表情包。'
          const id = rest[0]?.trim()
          if (!id) return `用法：/social memes ${sub} <表情包ID>`
          const enable = sub === 'enable' || sub === '启用'
          const ok = await updateMemeRecord(ctx.db, id, { enabled: enable })
          return ok ? `已${enable ? '启用' : '禁用'}表情包 ${id}。` : `未找到表情包 ${id}。`
        }

        const query = sub === 'list' || sub === '列表' ? rest.join(' ') : trimmed
        const list = await searchMemesByQuery(ctx, query, {
          scope: ctx.config.share_memes_across_groups || ctx.config.use_global_meme_library ? 'all' : 'group',
          groupId: ctx.config.share_memes_across_groups ? undefined : groupId,
          includeDisabled: false,
          limit: 12,
        })
        if (list.length === 0) {
          return query
            ? `未找到包含「${query}」的表情包。`
            : '本群还没有收藏表情包。发送或引用图片后输入 /收藏表情 即可添加！'
        }
        const lines = list.map((m, i) => {
          const scopeTag = m.scope === 'global' ? '[全局]' : '[本群]'
          return `${i + 1}. ${scopeTag} ${m.meaning}（${m.mood}｜${m.tags.slice(0, 3).join('、') || '无标签'}）\n   id: ${m.id}`
        })
        return ['可用表情包（最多展示 12 条）：', ...lines].join('\n')
      },
    },

    'social say': {
      aliases: ['说'],
      description: '发送原生AI语音消息',
      usage: '/social say <想说的话>',
      scenes: ['group'],
      async handler({ session, ctx, argText }) {
        await ensureSchema(ctx.db, ctx.logger)
        const text = argText.trim()
        if (!text) return '用法：/说 <想让机器人说的话>'
        const groupId = session.targetId
        const now = Date.now()
        const groupVoice = await getGroupVoiceSettings(ctx.db, groupId)
        const effective = resolveEffectiveVoiceConfig(ctx.config, groupVoice)
        if (!effective.enabled) {
          return '本群未开启 AI 语音功能，或尚未配置 TTS API Key。'
        }
        if (text.length > ctx.config.voice_max_chars) {
          return `单次语音最多 ${ctx.config.voice_max_chars} 字（当前 ${text.length} 字）。`
        }
        if (effective.dailyLimit > 0) {
          const sentToday = await countGroupVoiceSentToday(ctx.db, groupId, now)
          if (sentToday >= effective.dailyLimit) {
            return `本群今日语音次数已达上限（${effective.dailyLimit} 条）。`
          }
        }
        const prepared = await synthesizeAndPrepareVoice(ctx, {
          groupId,
          text,
          voiceId: effective.voiceId,
          speed: effective.speed,
          emotion: effective.emotion,
          now,
        })
        if (!prepared.ok) {
          await recordVoiceSendLog(ctx, {
            groupId,
            provider: ctx.config.tts_provider,
            model: ctx.config.tts_model,
            voiceId: effective.voiceId,
            emotion: effective.emotion,
            charCount: text.length,
            estimatedCost: 0,
            format: ctx.config.tts_audio_format,
            cached: false,
            status: 'failed',
            error: prepared.error,
            createdAt: now,
          })
          return `语音合成失败：${prepared.error}`
        }
        const res = await session.reply({ media: prepared.media })
        await recordVoiceSendLog(ctx, {
          groupId,
          provider: ctx.config.tts_provider,
          model: ctx.config.tts_model,
          voiceId: effective.voiceId,
          emotion: effective.emotion,
          charCount: text.length,
          estimatedCost: prepared.estimatedCost,
          format: prepared.format,
          cached: prepared.cached,
          status: res.ok ? 'sent' : 'failed',
          error: res.ok ? '' : (res.error ?? `HTTP ${res.status}`),
          createdAt: now,
        })
        if (!res.ok) {
          return ctx.config.voice_fallback_to_text ? text : `语音发送失败：${res.error ?? `HTTP ${res.status}`}`
        }
        return undefined
      },
    },

    'social voicetest': {
      aliases: ['语音测试'],
      description: '测试QQ原生语音发送',
      usage: '/social voicetest <wav-b64|wav-url|url <音频URL>>',
      permission: 'group_admin',
      scenes: ['group'],
      async handler({ session, ctx, args }) {
        const mode = (args[0] ?? 'wav-b64').toLowerCase()
        let media: { type: 'voice'; url?: string; base64?: string; filename?: string }

        if (mode === 'wav-b64') {
          media = {
            type: 'voice',
            base64: generateTestToneWavBase64(1000),
            filename: 'test.wav',
          }
        } else if (mode === 'wav-url') {
          if (!ctx.publicUrl) {
            return '当前无法获取 ctx.publicUrl，请在面板「设置 → 运行 → 机器人公开地址」填写后再测试 wav-url。'
          }
          media = {
            type: 'voice',
            url: `${ctx.publicUrl}/p/${ctx.plugin.name}/voice-test/sample.wav`,
            filename: 'test.wav',
          }
        } else if (mode === 'url') {
          const rawUrl = (args[1] ?? '').trim()
          if (!/^https?:\/\//i.test(rawUrl)) {
            return '用法：/social voicetest url <https://音频地址>'
          }
          const ext = rawUrl.match(/\.(silk|mp3|wav|ogg|amr)(?:[?#]|$)/i)?.[1]?.toLowerCase() ?? 'silk'
          media = {
            type: 'voice',
            url: rawUrl,
            filename: `test.${ext}`,
          }
        } else {
          return '用法：/social voicetest <wav-b64 | wav-url | url <https://音频地址>>'
        }

        const res = await session.reply({ media })
        if (res.ok) {
          return [
            `【语音发送回执：成功 (${mode})】`,
            `- messageId：${res.messageId ?? '(无)'}`,
            `- 请在手机 QQ 确认是否为原生语音条且可正常播放。`,
          ].join('\n')
        }
        return [
          `【语音发送回执：失败 (${mode})】`,
          `- HTTP status：${res.status}`,
          `- QQ code：${res.code ?? '(无)'}`,
          `- error：${res.error ?? '(无)'}`,
          `- traceId：${res.traceId ?? '(无)'}`,
        ].join('\n')
      },
    },

    'social tools': {
      aliases: ['工具列表'],
      description: '查看Agent启用工具',
      permission: 'group_admin',
      scenes: ['group'],
      async handler({ ctx }) {
        await ensureSchema(ctx.db, ctx.logger)
        const policy = await getAgentToolPolicy(ctx.db)
        return [
          `Agent 工具总开关：${ctx.config.enable_agent_tools ? '开' : '关'}（最多 ${ctx.config.agent_max_tool_steps} 步 / ${ctx.config.agent_max_tool_calls} 次）`,
          `- 已启用内置工具：${policy.enabledBuiltins.join('、') || '无'}`,
          `- 联网搜索：${ctx.config.web_search_api_key.trim() ? ctx.config.web_search_provider : '未配置 API Key'}`,
          `- 外部 core.tools 白名单：${policy.enabledExternalTools.join('、') || '无（可在面板管理页开启）'}`,
        ].join('\n')
      },
    },

    'social sync': {
      aliases: ['同步人格'],
      description: '同步人格到Agent',
      permission: 'group_admin',
      scenes: ['group'],
      async handler({ session, ctx }) {
        await ensureSchema(ctx.db, ctx.logger)
        const settings = await getGroupSettings(ctx.db, session.targetId)
        const persona = resolvePersona(ctx.config, settings)
        const res = await syncPersonaToAgent(ctx, persona)
        if (!res.synced) return `同步未完成：${res.reason}`
        return res.changed
          ? `已将人格「${persona.name}」的互动基调同步到 Agent 插件。`
          : `Agent 插件中已是最新人格「${persona.name}」，无需重复写入。`
      },
    },
  },

  events: {
    'qq.group.at_message': async ({ session, ctx }) => {
      await handleGroupChatEvent(session, ctx)
    },
    'qq.group.message': async ({ session, ctx }) => {
      await handleGroupChatEvent(session, ctx)
    },
    'qq.c2c.message': async ({ session, ctx }) => {
      if (!ctx.config.enable_c2c_chat) return
      await handleGroupChatEvent(session, ctx)
    },
  },

  ui: {
    path: '/ui/',
    title: '拟人群聊',
  },

  routes: createAdminRoutes(),
})
