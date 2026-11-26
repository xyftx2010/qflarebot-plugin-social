import type { ScopedDB } from '@qqbot/sdk'
import type { GroupMemory, GroupSettings, GroupState, MemoryScope, SocialConfig } from '../types.js'
import {
  clearGroupMemories,
  deleteGroupMemoryById,
  deleteMemberMemories,
  getMemberPrivacy,
  insertGroupMemory,
  listActiveGroupMemories,
  pruneExpiredGroupMemories,
  trimExcessGroupMemories,
} from '../store/db.js'
import { sanitizeSensitiveText } from './privacy.js'

const DAY_MS = 24 * 3600 * 1000
/** 清理过期记忆节流间隔（10 分钟），避免高频 DELETE 消耗 D1 写入行 */
export const MEMORY_PRUNE_INTERVAL_MS = 10 * 60 * 1000
const MAX_MEMORY_CONTENT_LEN = 120

/** 零 LLM 成本的轻量娱乐偏好/群梗提取规则 */
const MEMBER_MEMORY_PATTERNS: readonly RegExp[] = [
  /^(?:以后叫我|叫我|我是)(.{1,20})$/,
  /^我(?:很|超|最)?(?:喜欢|爱玩|爱吃|爱看|讨厌|不爱吃)(.{2,40})$/,
  /^记住(?:一下)?[，,：:\s]*(.{3,60})$/,
]

/** 过滤玩笑、反讽、猜测与图片占位符，防止把非真实事实写入长期记忆 */
const NON_FACTUAL_OR_JOKE_RE =
  /(?:哈哈|笑死|开玩笑|骗你的|逗你|反讽|假装|大概|可能|猜的|听说|doge|滑稽|\/s|\[发送了|\[引用了|\[图意)/i

export function resolveMemoryTtlDays(config: SocialConfig, settings?: GroupSettings | null): number {
  const days = settings?.memoryTtlDays ?? config.memory_ttl_days
  return Math.min(90, Math.max(1, Math.floor(days || 30)))
}

export function extractCandidateMemory(text: string): { scope: MemoryScope; content: string } | null {
  const trimmed = text.trim()
  if (trimmed.length < 4 || trimmed.length > 80) return null
  if (NON_FACTUAL_OR_JOKE_RE.test(trimmed)) return null
  for (const pattern of MEMBER_MEMORY_PATTERNS) {
    if (pattern.test(trimmed)) {
      const sanitized = sanitizeSensitiveText(trimmed)
      // 包含敏感信息（手机号/身份证/邮箱/密钥等）的消息直接拒绝入长期记忆
      if (sanitized.hadSensitive) return null
      return {
        scope: 'member',
        content: sanitized.text.slice(0, MAX_MEMORY_CONTENT_LEN),
      }
    }
  }
  return null
}

export async function addGroupMemory(
  db: ScopedDB,
  input: {
    groupId: string
    userId?: string | null
    userName?: string | null
    scope: MemoryScope
    content: string
    ttlDays: number
    maxPerGroup: number
    now?: number
  },
): Promise<{ ok: true; memory: GroupMemory } | { ok: false; reason: string }> {
  const now = input.now ?? Date.now()
  const raw = input.content.trim()
  if (!raw) return { ok: false, reason: '记忆内容不能为空' }
  const sanitized = sanitizeSensitiveText(raw)
  if (sanitized.hadSensitive) {
    return { ok: false, reason: '内容包含敏感隐私信息，已拒绝保存' }
  }

  if (input.scope === 'member' && input.userId) {
    const privacy = await getMemberPrivacy(db, input.groupId, input.userId)
    if (privacy?.optOut) {
      return { ok: false, reason: '该成员已关闭记忆收集（privacy off）' }
    }
  }

  const normalizedContent = sanitized.text.slice(0, MAX_MEMORY_CONTENT_LEN)
  // 简单去重：相同群内已有完全一致的活跃记忆则不再重复写入
  const existing = await listActiveGroupMemories(db, input.groupId, now, input.maxPerGroup)
  if (existing.some((m) => m.content === normalizedContent && m.userId === (input.userId ?? null))) {
    return { ok: false, reason: '已存在相同记忆' }
  }

  const memory: GroupMemory = {
    id: `mem_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    groupId: input.groupId,
    userId: input.scope === 'member' ? (input.userId ?? null) : null,
    userName: input.scope === 'member' ? (input.userName ?? null) : null,
    scope: input.scope,
    content: normalizedContent,
    createdAt: now,
    expiresAt: now + Math.min(90, Math.max(1, input.ttlDays)) * DAY_MS,
  }

  await insertGroupMemory(db, memory)
  if (existing.length + 1 > input.maxPerGroup) {
    await trimExcessGroupMemories(db, input.groupId, input.maxPerGroup, now)
  }
  return { ok: true, memory }
}

export async function maybePruneGroupMemories(
  db: ScopedDB,
  state: GroupState,
  now = Date.now(),
): Promise<{ pruned: number; touched: boolean }> {
  if (now - state.lastPruneAt < MEMORY_PRUNE_INTERVAL_MS) {
    return { pruned: 0, touched: false }
  }
  const pruned = await pruneExpiredGroupMemories(db, state.groupId, now)
  state.lastPruneAt = now
  return { pruned, touched: true }
}

export async function searchGroupMemories(
  db: ScopedDB,
  groupId: string,
  query: string,
  limit = 8,
  now = Date.now(),
): Promise<GroupMemory[]> {
  const active = await listActiveGroupMemories(db, groupId, now, 60)
  const q = query.trim().toLowerCase()
  if (!q) return active.slice(0, limit)
  const tokens = q.split(/\s+/).filter(Boolean)
  const matched = active.filter((m) => {
    const haystack = `${m.userName ?? ''} ${m.content}`.toLowerCase()
    return tokens.some((t) => haystack.includes(t))
  })
  return (matched.length > 0 ? matched : active).slice(0, limit)
}

export function formatMemoriesForPrompt(memories: readonly GroupMemory[]): string {
  if (memories.length === 0) return ''
  const lines = memories.map((m) => {
    const who = m.scope === 'member' && m.userName ? `[关于 ${m.userName}] ` : '[群公共] '
    return `- ${who}${m.content}`
  })
  return `以下是本群近期积累的娱乐互动记忆（仅限本群使用，不要生硬背诵）：\n${lines.join('\n')}`
}

export { clearGroupMemories, deleteGroupMemoryById, deleteMemberMemories, listActiveGroupMemories }
