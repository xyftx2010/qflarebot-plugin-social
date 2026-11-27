import type { PluginContext } from '@qqbot/sdk'
import type { LLMService, SocialConfig } from '../types.js'
import { getGroupSettings } from '../store/db.js'
import { getPublishedStyleProfile, getStyleProfileById, listStyleProfiles } from '../store/learning-db.js'
import { buildSocialSystemPrompt, resolvePersona } from '../persona/manager.js'
import { compileStylePromptFromData, type StyleCompileMode } from './prompt-compiler.js'
import { retrieveGroupStyleContext } from './retrieval.js'

export interface StyleLabRunItem {
  mode: StyleCompileMode
  label: string
  reply: string
  latencyMs: number
  retrievalMs: number
  inputTokens: number
  outputTokens: number
  styleTokens: number
  memesUsed: string[]
  examplesUsed: number
}

const MODE_LABELS: Readonly<Record<StyleCompileMode, string>> = {
  A: 'A：原始基础人格',
  B: 'B：基础人格 + 长期风格',
  C: 'C：基础人格 + 长期/近期风格',
  D: 'D：基础人格 + 双层风格 + 热梗与行为',
  E: 'E：完整风格 + 行为 + 热梗 + RAG 示例',
}

/**
 * 风格实验室（A/B/C/D/E 五模式同上下文对照）：
 * - 严格只读，绝不发送到 QQ 群，不写入聊天上下文、长期记忆或学习语料库；
 * - 返回真实模型输出、实际耗时与 Token 消耗。
 */
export async function runStyleLabComparison(opts: {
  ctx: PluginContext<SocialConfig>
  groupId: string
  testContext: string
  testMessage: string
  modes: readonly StyleCompileMode[]
  profileId?: string
  now?: number
}): Promise<{ ok: boolean; error?: string; profileVersion?: number; results: StyleLabRunItem[] }> {
  const { ctx, groupId, testContext, testMessage } = opts
  const now = opts.now ?? Date.now()

  let llm: LLMService
  try {
    llm = ctx.service<LLMService>('llm')
  } catch {
    return { ok: false, error: 'LLM 服务不可用', results: [] }
  }

  const [groupSettings, profile] = await Promise.all([
    getGroupSettings(ctx.db, groupId),
    opts.profileId
      ? getStyleProfileById(ctx.db, opts.profileId)
      : getPublishedStyleProfile(ctx.db, groupId).then(async (p) => p ?? (await listStyleProfiles(ctx.db, groupId, 1))[0] ?? null),
  ])

  const persona = resolvePersona(ctx.config, groupSettings)
  const basePrompt = buildSocialSystemPrompt(persona, [])

  const retrieved = profile
    ? await retrieveGroupStyleContext({
        db: ctx.db,
        groupId,
        queryText: testMessage,
        recentContextText: testContext,
        topK: ctx.config.style_retrieval_top_k,
        vectorEnabled: ctx.config.style_vector_enabled,
        now,
      })
    : { memes: [], examples: [], engine: 'd1' as const, latencyMs: 0 }

  const model = ctx.config.model_alias.trim() || undefined
  const results: StyleLabRunItem[] = []

  for (const mode of opts.modes) {
    const compiled =
      profile && mode !== 'A'
        ? compileStylePromptFromData({
            profile,
            memes: mode === 'D' || mode === 'E' ? retrieved.memes : [],
            examples: mode === 'E' ? retrieved.examples : [],
            mode,
            stableWeight: ctx.config.style_stable_weight,
            recentWeight: ctx.config.style_recent_weight,
            influenceStrength: ctx.config.style_influence_strength,
            budgets: {
              profile: ctx.config.style_profile_max_tokens,
              meme: ctx.config.style_meme_max_tokens,
              examples: ctx.config.style_examples_max_tokens,
              total: ctx.config.style_total_max_tokens,
            },
          })
        : { promptBlock: '', estimatedTokens: 0, voiceMoodHint: '' }

    const sysPrompt = compiled.promptBlock ? `${basePrompt}\n\n${compiled.promptBlock}` : basePrompt
    const userMsg = testContext.trim()
      ? `近期群聊片段：\n${testContext.trim()}\n\n群友最新发言：${testMessage.trim()}\n请自然接话（仅输出回复正文）。`
      : `群友发言：${testMessage.trim()}\n请自然接话（仅输出回复正文）。`

    const started = Date.now()
    const res = await llm.chat({
      model,
      messages: [
        { role: 'system', content: sysPrompt },
        { role: 'user', content: userMsg },
      ],
      temperature: ctx.config.temperature,
      max_tokens: ctx.config.max_output_tokens,
      timeout_ms: ctx.config.llm_timeout_ms,
    })

    results.push({
      mode,
      label: MODE_LABELS[mode],
      reply: (res.text ?? '').trim(),
      latencyMs: res.latency_ms ?? Date.now() - started,
      retrievalMs: mode === 'D' || mode === 'E' ? retrieved.latencyMs : 0,
      inputTokens: res.usage?.input_tokens ?? 0,
      outputTokens: res.usage?.output_tokens ?? 0,
      styleTokens: compiled.estimatedTokens,
      memesUsed: mode === 'D' || mode === 'E' ? retrieved.memes.map((m) => m.name) : [],
      examplesUsed: mode === 'E' ? retrieved.examples.length : 0,
    })
  }

  return {
    ok: true,
    profileVersion: profile?.version ?? 0,
    results,
  }
}
