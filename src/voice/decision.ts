import type { GroupVoiceSettings, SocialConfig, VoiceTriggerMode } from '../types.js'

const VOICE_TAG_RE = /^\s*\[\[voice(?::([a-zA-Z_-]{1,20}))?\]\]\s*/i
const EXPLICIT_VOICE_ASK_RE = /(?:发个?语音|用语音|语音回复|语音说|说出来听听|念一下|读出来)/

export interface EffectiveVoiceConfig {
  enabled: boolean
  triggerMode: VoiceTriggerMode
  probability: number
  voiceId: string
  speed: number
  emotion: string
  dailyLimit: number
}

export function resolveEffectiveVoiceConfig(
  config: SocialConfig,
  groupSettings?: GroupVoiceSettings | null,
): EffectiveVoiceConfig {
  const enabled = groupSettings?.enabled !== null && groupSettings?.enabled !== undefined
    ? groupSettings.enabled
    : config.enable_voice
  return {
    enabled: Boolean(enabled && config.tts_api_key.trim()),
    triggerMode: groupSettings?.triggerMode ?? config.voice_trigger_mode,
    probability: Math.min(1, Math.max(0, groupSettings?.probability ?? config.voice_probability)),
    voiceId: (groupSettings?.voiceId ?? config.tts_voice_id).trim(),
    speed: Math.min(2, Math.max(0.5, groupSettings?.speed ?? config.tts_speed)),
    emotion: (groupSettings?.emotion ?? config.tts_emotion).trim(),
    dailyLimit: Math.max(0, Math.floor(groupSettings?.dailyLimit ?? config.voice_daily_limit_per_group)),
  }
}

/**
 * 注入到主对话 System Prompt 的轻量语音决策提示：
 * 在同一次 LLM 请求中同时决定「是否用语音 + 情绪」，零额外模型调用。
 */
export function buildVoicePromptDirective(effective: EffectiveVoiceConfig): string {
  if (!effective.enabled || effective.triggerMode !== 'ai') return ''
  return '语音回复指令：如果当前语境特别适合用语音表达（如打招呼、安慰、撒娇、吐槽、开心接梗），可在回复最开头加上标记 [[voice:情绪]]（情绪可选 happy/calm/sad/angry/surprised），标记后面直接写要说的话；若更适合文字回复则不要加该标记。'
}

export interface ParsedVoiceDirective {
  aiRequestedVoice: boolean
  emotion: string
  cleanText: string
}

export function parseVoiceDirective(rawText: string): ParsedVoiceDirective {
  const match = rawText.match(VOICE_TAG_RE)
  if (!match) {
    return { aiRequestedVoice: false, emotion: '', cleanText: rawText.trim() }
  }
  const emotion = (match[1] ?? '').trim().toLowerCase()
  const cleanText = rawText.slice(match[0].length).trim()
  return {
    aiRequestedVoice: true,
    emotion,
    cleanText,
  }
}

export function userExplicitlyAskedForVoice(userText: string): boolean {
  return EXPLICIT_VOICE_ASK_RE.test(userText)
}

export interface VoiceDecisionInput {
  effective: EffectiveVoiceConfig
  maxChars: number
  sentToday: number
  userText: string
  replyText: string
  aiRequestedVoice: boolean
  aiEmotion: string
  random?: () => number
}

export interface VoiceDecision {
  useVoice: boolean
  emotion: string
  reason: string
}

export function decideVoiceReply(input: VoiceDecisionInput): VoiceDecision {
  const { effective, maxChars, sentToday, userText, replyText, aiRequestedVoice, aiEmotion } = input
  const rng = input.random ?? Math.random
  const emotion = aiEmotion || effective.emotion

  if (!effective.enabled) {
    return { useVoice: false, emotion: '', reason: 'voice-disabled' }
  }
  if (effective.dailyLimit > 0 && sentToday >= effective.dailyLimit) {
    return { useVoice: false, emotion: '', reason: 'daily-limit-reached' }
  }
  const cleanLen = replyText.trim().length
  if (cleanLen === 0 || cleanLen > maxChars) {
    return { useVoice: false, emotion: '', reason: 'exceeds-max-chars' }
  }

  switch (effective.triggerMode) {
    case 'always':
      return { useVoice: true, emotion, reason: 'mode-always' }
    case 'manual':
      return userExplicitlyAskedForVoice(userText)
        ? { useVoice: true, emotion, reason: 'manual-explicit-ask' }
        : { useVoice: false, emotion: '', reason: 'mode-manual-skip' }
    case 'probability':
      if (userExplicitlyAskedForVoice(userText)) {
        return { useVoice: true, emotion, reason: 'explicit-ask' }
      }
      return rng() < effective.probability
        ? { useVoice: true, emotion, reason: 'probability-hit' }
        : { useVoice: false, emotion: '', reason: 'probability-skip' }
    case 'ai':
      if (aiRequestedVoice || userExplicitlyAskedForVoice(userText)) {
        return { useVoice: true, emotion, reason: aiRequestedVoice ? 'ai-selected' : 'explicit-ask' }
      }
      return { useVoice: false, emotion: '', reason: 'ai-chose-text' }
  }
}
