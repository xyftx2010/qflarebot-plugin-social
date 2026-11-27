import type { CorpusRecord, DialogueBehaviorType } from './types.js'
import { extractSearchTokens } from './cleaner.js'

export interface DialogueWindow {
  windowId: string
  groupId: string
  messages: CorpusRecord[]
  sourceCorpusIds: string[]
  distinctSenders: number
  behaviorHint: DialogueBehaviorType
  confidence: number
  startTs: number
  endTs: number
}

export interface MemberBalanceResult {
  selected: CorpusRecord[]
  effectiveCapRatio: number
  distinctSenders: number
  droppedByCap: number
}

/**
 * 成员采样均衡器：
 * - 默认单成员权重上限 20%（0.2），防止高活跃单成员主导全群风格；
 * - 小规模群聊（有效成员 < 5 人）自动适配上限为 `max(memberMaxWeight, min(0.5, 1 / distinctSenders + 0.1))`；
 * - 同成员内按质量分与去重排序，重复发言降权。
 */
export function balanceMemberSampling(
  records: readonly CorpusRecord[],
  memberMaxWeight = 0.2,
  maxTotal = 200,
): MemberBalanceResult {
  if (records.length === 0) {
    return { selected: [], effectiveCapRatio: memberMaxWeight, distinctSenders: 0, droppedByCap: 0 }
  }

  const bySender = new Map<string, CorpusRecord[]>()
  for (const r of records) {
    const list = bySender.get(r.pseudonymousSenderId) ?? []
    list.push(r)
    bySender.set(r.pseudonymousSenderId, list)
  }

  const distinctSenders = bySender.size
  const adaptiveRatio =
    distinctSenders <= 1
      ? 1
      : distinctSenders < Math.ceil(1 / Math.max(0.05, memberMaxWeight))
        ? Math.min(0.6, Math.max(memberMaxWeight, 1 / distinctSenders + 0.1))
        : memberMaxWeight

  const targetTotal = Math.min(maxTotal, records.length)
  const perMemberCap = Math.max(1, Math.floor(targetTotal * adaptiveRatio))

  // 每位成员内部按质量分降序并去重近似内容
  const queues = [...bySender.values()].map((list) => {
    const sorted = [...list].sort((a, b) => b.qualityScore - a.qualityScore || b.timestamp - a.timestamp)
    const seenNorm = new Set<string>()
    const deduped: CorpusRecord[] = []
    for (const item of sorted) {
      const norm = item.content.toLowerCase().replace(/\s+/g, '')
      if (seenNorm.has(norm)) continue
      seenNorm.add(norm)
      deduped.push(item)
      if (deduped.length >= perMemberCap) break
    }
    return deduped
  })

  // 轮询多成员代表性采样，保证低活跃成员也能入选
  const selected: CorpusRecord[] = []
  let round = 0
  while (selected.length < targetTotal) {
    let addedInRound = 0
    for (const q of queues) {
      if (round < q.length && selected.length < targetTotal) {
        selected.push(q[round]!)
        addedInRound += 1
      }
    }
    if (addedInRound === 0) break
    round += 1
  }

  selected.sort((a, b) => a.timestamp - b.timestamp)
  return {
    selected,
    effectiveCapRatio: Number(adaptiveRatio.toFixed(3)),
    distinctSenders,
    droppedByCap: Math.max(0, records.length - selected.length),
  }
}

function classifyWindowBehavior(messages: readonly CorpusRecord[]): DialogueBehaviorType {
  const joined = messages.map((m) => m.content).join(' ')
  if (/(?:难过|好累|崩溃|焦虑|压力大|委屈|加油|抱抱|没事的|摸摸)/.test(joined)) return 'comfort'
  if (/(?:哈哈|笑死|离谱|抽象|逆天|绷|典|乐|草)/.test(joined)) {
    return /(?:真有你的|不愧是你|行吧行吧|笑死我了|太典了)/.test(joined) ? 'sarcasm_roast' : 'humor_banter'
  }
  if (/[？?]|(?:怎么|为啥|推荐|多少|哪里|能不能|请问)/.test(joined)) return 'normal_qa'
  if (messages.every((m) => m.content.length <= 8)) return 'short_ack'
  return 'casual'
}

function tokenOverlapScore(a: string, b: string): number {
  const ta = new Set(extractSearchTokens(a, 16))
  const tb = extractSearchTokens(b, 16)
  if (ta.size === 0 || tb.length === 0) return 0
  let hits = 0
  for (const tok of tb) {
    if (ta.has(tok)) hits += 1
  }
  return hits / Math.max(1, Math.min(ta.size, tb.length))
}

/**
 * 对话场景重建（Dialogue Segmentation）：
 * 结合时间间隔、引用关系、@关系、发送者切换与语义重合度切分群聊窗口，
 * 不将孤立时间相邻消息直接强行绑定为问答对。
 */
export function segmentDialogues(records: readonly CorpusRecord[], gapMs = 5 * 60_000): DialogueWindow[] {
  if (records.length === 0) return []
  const sorted = [...records].sort((a, b) => a.timestamp - b.timestamp)
  const rawWindows: CorpusRecord[][] = []
  let current: CorpusRecord[] = [sorted[0]!]

  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1]!
    const cur = sorted[i]!
    const dt = cur.timestamp - prev.timestamp
    const hasExplicitLink = Boolean(
      cur.replyTo && current.some((m) => m.messageId && m.messageId === cur.replyTo),
    )
    const hasMention = cur.mentions.length > 0
    const semanticOverlap = tokenOverlapScore(prev.content, cur.content)

    const shouldJoin =
      current.length < 8 &&
      (hasExplicitLink || dt <= 90_000 || (dt <= gapMs && (hasMention || semanticOverlap >= 0.15)))

    if (shouldJoin) {
      current.push(cur)
    } else {
      rawWindows.push(current)
      current = [cur]
    }
  }
  rawWindows.push(current)

  return rawWindows
    .filter((w) => w.length >= 2)
    .map((msgs, idx) => {
      const senders = new Set(msgs.map((m) => m.pseudonymousSenderId))
      const hasReplyRef = msgs.some((m) => Boolean(m.replyTo))
      const avgQuality = msgs.reduce((s, m) => s + m.qualityScore, 0) / msgs.length
      // 只有多成员互动或显式引用才给高置信度，单人连发降低置信度
      const confidence = Number(
        Math.min(
          0.95,
          Math.max(0.2, avgQuality * 0.6 + (senders.size >= 2 ? 0.25 : -0.15) + (hasReplyRef ? 0.15 : 0)),
        ).toFixed(3),
      )
      return {
        windowId: `win_${idx}_${msgs[0]!.timestamp}`,
        groupId: msgs[0]!.groupId,
        messages: msgs,
        sourceCorpusIds: msgs.map((m) => m.corpusId),
        distinctSenders: senders.size,
        behaviorHint: classifyWindowBehavior(msgs),
        confidence,
        startTs: msgs[0]!.timestamp,
        endTs: msgs[msgs.length - 1]!.timestamp,
      }
    })
}
