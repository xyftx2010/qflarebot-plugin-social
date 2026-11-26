export interface ScoreInput {
  text: string
  callNames: readonly string[]
  baseProbability: number
  msSinceLastReply: number
  /** 可注入随机源便于单元测试确定性断言 */
  random?: () => number
}

export interface ScoreResult {
  score: number
  reasons: string[]
}

const QUESTION_RE = /[?？]|(?:吗|呢|嘛|么|啥|谁|怎么|为啥|为什么|推荐|有没有|好不好|行不行|能不能)$/
const BANTER_RE = /(?:哈哈|笑死|离谱|救命|绝了|好耶|冲鸭|芜湖|太强|牛啊|草|hhh|[!！]{2,})/i
const PURE_LINK_RE = /^https?:\/\/\S+$/i

/**
 * 零 LLM 成本的启发式群聊插话评分器（0 ~ 100）。
 *
 * 目标：在免费版 10ms CPU / 50 子请求约束下，不额外消耗模型调用即可判断
 * 一条非 @ 群消息是否适合自然插话。
 */
export function scoreGroupMessage(input: ScoreInput): ScoreResult {
  const text = input.text.trim()
  const reasons: string[] = []
  let score = 0

  if (text.length < 3) {
    score -= 20
    reasons.push('too-short')
  } else if (PURE_LINK_RE.test(text)) {
    score -= 30
    reasons.push('pure-link')
  } else if (text.length >= 6 && text.length <= 80) {
    score += 12
    reasons.push('good-length')
  }

  const lower = text.toLowerCase()
  const hitCallName = input.callNames.find((name) => name.length > 0 && lower.includes(name.toLowerCase()))
  if (hitCallName) {
    score += 60
    reasons.push(`call-name:${hitCallName}`)
  }

  if (QUESTION_RE.test(text)) {
    score += 24
    reasons.push('question')
  }

  if (BANTER_RE.test(text)) {
    score += 18
    reasons.push('banter')
  }

  // 超过 3 分钟没说话时稍微提高互动意愿
  if (input.msSinceLastReply >= 3 * 60_000) {
    score += 10
    reasons.push('quiet-gap')
  }

  const prob = Math.min(1, Math.max(0, input.baseProbability))
  const rng = (input.random ?? Math.random)()
  if (prob > 0 && rng < prob) {
    const bonus = Math.round(25 + prob * 25)
    score += bonus
    reasons.push('random-boost')
  }

  return {
    score: Math.max(0, Math.min(100, score)),
    reasons,
  }
}
