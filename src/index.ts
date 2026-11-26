import { definePlugin } from '@qqbot/sdk'
import type { LLMService, SocialConfig, SocialMode } from './types.js'
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
import { addGroupMemory, resolveMemoryTtlDays } from './memory/store.js'
import { listAllPersonas, resolvePersona, syncPersonaToAgent } from './persona/manager.js'
import { resolveEffectiveCooldownSeconds, resolveEffectiveMode } from './trigger/gate.js'
import { handleGroupChatEvent } from './chat/pipeline.js'
import { createSocialService, createSocialTools } from './chat/tools.js'
import { createAdminRoutes } from './admin/routes.js'

const HELP_TEXT = [
  '拟人群聊（social）命令：',
  '/social status — 查看本群状态与全量消息权限诊断',
  '/social persona [名称|off] — 查看/切换本群人格（群管理员）',
  '/social mode <auto|at|off> — 切换本群发言模式（群管理员）',
  '/social memory [list|add <内容>|clear] — 管理本群记忆（群管理员）',
  '/social forgetme（/忘掉我）— 删除本人在本群的全部记忆',
  '/social privacy <on|off> — 开启/关闭本人在本群的记忆收集',
  '/social sync — 将本群人格基调同步到 Agent 插件（群管理员）',
].join('\n')

function formatTime(ts: number): string {
  if (!ts) return '未记录'
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
}

export default definePlugin<SocialConfig>({
  name: 'social',
  apiVersion: 5,
  displayName: '拟人群聊',
  description: 'QQ 群聊娱乐互动插件：自然对话、人格设定、滑窗上下文、智能发言、冷却与群级隔离记忆。',
  permissions: ['db'],

  depends: {
    llm: '*',
    agent: 'optional',
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
  },

  tools: createSocialTools(),

  commands: {
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
        const [settings, state, memories] = await Promise.all([
          getGroupSettings(ctx.db, groupId),
          getGroupState(ctx.db, groupId),
          listActiveGroupMemories(ctx.db, groupId, Date.now(), 60),
        ])
        const mode = resolveEffectiveMode(ctx.config, settings)
        const persona = resolvePersona(ctx.config, settings)
        const cooldown = resolveEffectiveCooldownSeconds(ctx.config, settings)

        let llmStatus = '正常'
        try {
          const llm = ctx.service<LLMService>('llm')
          const resolved = await llm.resolve(ctx.config.model_alias.trim() || undefined)
          llmStatus = `正常（${resolved.alias}）`
        } catch {
          llmStatus = '未启用或未配置默认模型'
        }

        const nonAtDiag = state?.lastNonAtSeenAt
          ? `已收到（最近：${formatTime(state.lastNonAtSeenAt)}）`
          : '尚未观测到（若需自然插话，请群主在群内开启机器人「获取群内全部消息」权限）'

        return [
          '【本群拟人聊天状态】',
          `- 发言模式：${mode}`,
          `- 当前人格：${persona.name}（${persona.id}）`,
          `- @机器人让渡Agent：${ctx.config.yield_at_to_agent ? '开（防重复回复）' : '关（由本插件回复）'}`,
          `- 冷却时间：${cooldown} 秒（每分钟上限 ${ctx.config.max_replies_per_minute} 条）`,
          `- 非@全量消息权限：${nonAtDiag}`,
          `- 短期上下文：${state?.recentMessages.length ?? 0} 条`,
          `- 本群活跃记忆：${memories.length} 条（保留 ${resolveMemoryTtlDays(ctx.config, settings)} 天）`,
          `- LLM 服务：${llmStatus}`,
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
  },

  ui: {
    path: '/ui/',
    title: '拟人群聊',
  },

  routes: createAdminRoutes(),
})
