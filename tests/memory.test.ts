import { beforeEach, describe, expect, it } from 'vitest'
import { createMockContext } from '@qqbot/sdk/testing'
import plugin from '../src/index.js'
import { defaultConfig } from '../src/config.js'
import { ensureSchema, resetSchemaReadyForTest } from '../src/store/schema.js'
import { createEmptyGroupState, setMemberOptOut } from '../src/store/db.js'
import {
  addGroupMemory,
  deleteMemberMemories,
  listActiveGroupMemories,
  maybePruneGroupMemories,
} from '../src/memory/store.js'
import { sanitizeSensitiveText } from '../src/memory/privacy.js'
import { createSqliteTestDB } from './helpers/sqlite-db.js'

describe('memory & privacy', () => {
  beforeEach(() => {
    resetSchemaReadyForTest()
  })

  it('redacts sensitive patterns and refuses storing sensitive text into long-term memory', async () => {
    const res = sanitizeSensitiveText('我的手机号是 13800138000，邮箱 test@example.com')
    expect(res.hadSensitive).toBe(true)
    expect(res.text).not.toContain('13800138000')
    expect(res.text).not.toContain('test@example.com')

    const ctx = createMockContext(plugin, {
      config: defaultConfig,
      db: createSqliteTestDB(),
    })
    await ensureSchema(ctx.db)

    const blocked = await addGroupMemory(ctx.db, {
      groupId: 'g1',
      userId: 'u1',
      userName: '小明',
      scope: 'member',
      content: '我手机号是13912345678',
      ttlDays: 30,
      maxPerGroup: 60,
    })
    expect(blocked.ok).toBe(false)
  })

  it('enforces strict group isolation, TTL expiration, opt-out, and member self-deletion', async () => {
    const ctx = createMockContext(plugin, {
      config: defaultConfig,
      db: createSqliteTestDB(),
    })
    await ensureSchema(ctx.db)

    const t0 = 1_700_000_000_000
    const m1 = await addGroupMemory(ctx.db, {
      groupId: 'group-A',
      userId: 'user-1',
      userName: '阿明',
      scope: 'member',
      content: '我超喜欢玩塞尔达',
      ttlDays: 1,
      maxPerGroup: 60,
      now: t0,
    })
    expect(m1.ok).toBe(true)

    const m2 = await addGroupMemory(ctx.db, {
      groupId: 'group-B',
      userId: 'user-1',
      userName: '阿明',
      scope: 'member',
      content: '我喜欢喝冰美式',
      ttlDays: 30,
      maxPerGroup: 60,
      now: t0,
    })
    expect(m2.ok).toBe(true)

    // 群级隔离校验
    const groupAMems = await listActiveGroupMemories(ctx.db, 'group-A', t0 + 1000)
    const groupBMems = await listActiveGroupMemories(ctx.db, 'group-B', t0 + 1000)
    expect(groupAMems.map((m) => m.content)).toEqual(['我超喜欢玩塞尔达'])
    expect(groupBMems.map((m) => m.content)).toEqual(['我喜欢喝冰美式'])

    // 成员在 group-A 开启 opt-out 后无法继续写入
    await setMemberOptOut(ctx.db, 'group-A', 'user-1', true, t0 + 2000)
    const optOutAdd = await addGroupMemory(ctx.db, {
      groupId: 'group-A',
      userId: 'user-1',
      userName: '阿明',
      scope: 'member',
      content: '我爱吃火锅',
      ttlDays: 30,
      maxPerGroup: 60,
      now: t0 + 3000,
    })
    expect(optOutAdd.ok).toBe(false)

    // 成员自助删除仅影响当前群
    const deleted = await deleteMemberMemories(ctx.db, 'group-A', 'user-1')
    expect(deleted).toBe(1)
    expect(await listActiveGroupMemories(ctx.db, 'group-A', t0 + 4000)).toHaveLength(0)
    expect(await listActiveGroupMemories(ctx.db, 'group-B', t0 + 4000)).toHaveLength(1)

    // TTL 过期 + 节流清理
    const stateB = createEmptyGroupState('group-B', t0)
    const after31Days = t0 + 31 * 24 * 3600 * 1000
    expect(await listActiveGroupMemories(ctx.db, 'group-B', after31Days)).toHaveLength(0)
    const pruned = await maybePruneGroupMemories(ctx.db, stateB, after31Days)
    expect(pruned.touched).toBe(true)
    expect(pruned.pruned).toBe(1)
  })
})
