import type { PluginContext, PluginTool } from '@qqbot/sdk'
import type { SocialConfig } from '../types.js'
import { ensureSchema } from '../store/schema.js'
import { getGroupState } from '../store/db.js'
import { formatContextTranscript, pruneContextWindow } from '../memory/context.js'
import { searchGroupMemories } from '../memory/store.js'

export interface SocialPublicService {
  getRecentContext(groupId: string, limit?: number): Promise<{ groupId: string; count: number; transcript: string }>
  searchMemory(
    groupId: string,
    query?: string,
    limit?: number,
  ): Promise<{ groupId: string; memories: Array<{ id: string; scope: string; userName: string | null; content: string }> }>
}

export function createSocialService(ctx: PluginContext<SocialConfig>): SocialPublicService {
  return {
    async getRecentContext(groupId: string, limit = 10) {
      await ensureSchema(ctx.db, ctx.logger)
      const state = await getGroupState(ctx.db, groupId)
      const fresh = state ? pruneContextWindow(state.recentMessages, ctx.config) : []
      const clamped = Math.min(20, Math.max(1, Math.floor(limit || 10)))
      const slice = fresh.slice(-clamped)
      return {
        groupId,
        count: slice.length,
        transcript: formatContextTranscript(slice),
      }
    },

    async searchMemory(groupId: string, query = '', limit = 8) {
      await ensureSchema(ctx.db, ctx.logger)
      const clamped = Math.min(20, Math.max(1, Math.floor(limit || 8)))
      const rows = await searchGroupMemories(ctx.db, groupId, query, clamped)
      return {
        groupId,
        memories: rows.map((m) => ({
          id: m.id,
          scope: m.scope,
          userName: m.userName,
          content: m.content,
        })),
      }
    },
  }
}

/**
 * SDK 契约 v5 统一插件工具：
 * 始终以框架签发的 `actor.targetId` 锁定当前群，防止模型跨群读取上下文或记忆。
 */
export function createSocialTools(): Record<string, PluginTool<SocialConfig>> {
  return {
    get_recent_context: {
      service: 'social',
      method: 'getRecentContext',
      description:
        '读取当前 QQ 群最近的公开聊天滑窗上下文，用于了解群里刚刚聊了什么话题或接梗。仅限群聊使用；返回当前群的最近对话摘要文本与条数。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          limit: {
            type: 'integer',
            description: '需要读取的最近消息条数，范围 1 到 20，默认 10。',
            minimum: 1,
            maximum: 20,
          },
        },
      },
      permission: 'member',
      sideEffect: 'none',
      scenes: ['group'],
      version: 1,
      timeoutMs: 8_000,
      mapInput: ({ input, actor }) => {
        const obj = (typeof input === 'object' && input !== null ? input : {}) as { limit?: number }
        return [actor.targetId, obj.limit ?? 10]
      },
      mapOutput: (output) => ({ status: 'success', output }),
    },

    search_memory: {
      service: 'social',
      method: 'searchMemory',
      description:
        '按关键词检索当前 QQ 群内已保存的娱乐互动记忆（群梗、成员公开偏好）。仅限当前群，严格群级隔离；query 留空时返回最新记忆列表。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: {
            type: 'string',
            description: '可选检索关键词（例如成员昵称或话题词）；留空返回最新记忆。',
            maxLength: 60,
          },
          limit: {
            type: 'integer',
            description: '返回条数上限，范围 1 到 20，默认 8。',
            minimum: 1,
            maximum: 20,
          },
        },
      },
      permission: 'member',
      sideEffect: 'none',
      scenes: ['group'],
      version: 1,
      timeoutMs: 8_000,
      mapInput: ({ input, actor }) => {
        const obj = (typeof input === 'object' && input !== null ? input : {}) as {
          query?: string
          limit?: number
        }
        return [actor.targetId, obj.query ?? '', obj.limit ?? 8]
      },
      mapOutput: (output) => ({ status: 'success', output }),
    },
  }
}
