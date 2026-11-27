import { describe, expect, it } from 'vitest'
import { createMockSession } from '@qqbot/sdk/testing'
import { defaultConfig } from '../src/config.js'
import { createEmptyGroupState } from '../src/store/db.js'
import { evaluateTrigger, recordReplyRate } from '../src/trigger/gate.js'

describe('trigger/gate', () => {
  it('skips addressedToOthers messages without recording context', () => {
    const session = createMockSession({
      scene: 'group',
      event: 'qq.group.message',
      content: '@全体成员 今晚开黑',
      atMe: false,
      addressedToOthers: true,
    })
    const decision = evaluateTrigger({
      session,
      config: defaultConfig,
      state: createEmptyGroupState('g1'),
      callNames: ['小Q'],
    })
    expect(decision.shouldReply).toBe(false)
    expect(decision.reason).toBe('addressed-to-others')
    expect(decision.recordContext).toBe(false)
  })

  it('yields @me messages to Agent when yield_at_to_agent is enabled, while recording context', () => {
    const session = createMockSession({
      scene: 'group',
      event: 'qq.group.at_message',
      content: '帮我查查天气',
      atMe: true,
    })
    const decision = evaluateTrigger({
      session,
      config: { ...defaultConfig, yield_at_to_agent: true },
      state: createEmptyGroupState('g1'),
      callNames: ['小Q'],
    })
    expect(decision.shouldReply).toBe(false)
    expect(decision.reason).toBe('yield-to-agent')
    expect(decision.recordContext).toBe(true)
  })

  it('replies to @me messages when yield_at_to_agent is disabled', () => {
    const session = createMockSession({
      scene: 'group',
      event: 'qq.group.at_message',
      content: '今晚吃什么好呀',
      atMe: true,
    })
    const decision = evaluateTrigger({
      session,
      config: { ...defaultConfig, yield_at_to_agent: false },
      state: createEmptyGroupState('g1'),
      callNames: ['小Q'],
    })
    expect(decision.shouldReply).toBe(true)
    expect(decision.reason).toBe('at-me')
  })

  it('triggers on non-@ message when call name is mentioned and cooldown passed', () => {
    const session = createMockSession({
      scene: 'group',
      event: 'qq.group.message',
      content: '小Q你觉得今晚吃火锅怎么样？',
      atMe: false,
    })
    const decision = evaluateTrigger({
      session,
      config: defaultConfig,
      state: createEmptyGroupState('g1'),
      callNames: ['小Q'],
      now: 1_000_000,
      random: () => 0.99,
    })
    expect(decision.shouldReply).toBe(true)
    expect(decision.reason).toBe('score-pass')
  })

  it('blocks reply during cooldown window and rate limit window', () => {
    const state = createEmptyGroupState('g1')
    recordReplyRate(state, 100_000)

    const session = createMockSession({
      scene: 'group',
      event: 'qq.group.message',
      content: '小Q还在吗？',
      atMe: false,
    })
    const inCooldown = evaluateTrigger({
      session,
      config: { ...defaultConfig, cooldown_seconds: 30 },
      state,
      callNames: ['小Q'],
      now: 110_000,
      random: () => 0.01,
    })
    expect(inCooldown.shouldReply).toBe(false)
    expect(inCooldown.reason).toBe('cooldown')

    // 超过冷却后，模拟分钟内超上限
    state.windowStartAt = 135_000
    state.windowReplyCount = 3
    const rateLimited = evaluateTrigger({
      session,
      config: { ...defaultConfig, cooldown_seconds: 0, max_replies_per_minute: 3 },
      state,
      callNames: ['小Q'],
      now: 140_000,
      random: () => 0.01,
    })
    expect(rateLimited.shouldReply).toBe(false)
    expect(rateLimited.reason).toBe('rate-limited')
  })

  it('replies immediately on first try for same-user continuous short follow-up after 3s', () => {
    const state = createEmptyGroupState('g1')
    state.recentMessages = [
      { role: 'user', speakerKey: 'u-owner', speakerName: '群主', text: '济南今天天气怎么样呢', atMe: false, ts: 100_000 },
      { role: 'assistant', speakerKey: 'bot', speakerName: '大肥銮', text: '济南现在晴，12.9度', atMe: false, ts: 102_000 },
    ]
    recordReplyRate(state, 102_000)

    const session = createMockSession({
      scene: 'group',
      event: 'qq.group.message',
      userId: 'u-owner',
      content: '那苍南呢',
      atMe: false,
    })

    // 刚回复完 6 秒内（仍小于默认 20s 冷却），且随机概率未命中（0.99），同人短追问仍应一次命中回复
    const decision = evaluateTrigger({
      session,
      config: { ...defaultConfig, cooldown_seconds: 20, trigger_threshold: 45, base_reply_probability: 0.28 },
      state,
      callNames: ['大肥銮'],
      now: 108_000,
      random: () => 0.99,
    })
    expect(decision.shouldReply).toBe(true)
    expect(decision.reason).toBe('score-pass')
  })
})
