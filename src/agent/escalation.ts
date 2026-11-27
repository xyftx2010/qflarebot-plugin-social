/**
 * Fast Chat 模型自主升级协议（reply / escalate / silence）。
 *
 * 允许普通快通道模型在发现需要实时数据或工具才能准确回答时，
 * 输出结构化升级标记，由运行时严格按白名单、权限和共享预算执行一次升级。
 */

const SILENCE_RE = /^\s*\[\[silence\]\]\s*$/i
const ESCALATE_RE = /^\s*\[\[escalate(?::([^|\]]*))?(?:\|([^\]]*))?\]\]\s*/i

export type EscalationDirective =
  | { action: 'reply'; text: string }
  | { action: 'silence' }
  | { action: 'escalate'; requestedTools: string[]; reason: string }

export function buildEscalationPromptHint(enabled: boolean, availableToolIds: readonly string[]): string {
  if (!enabled || availableToolIds.length === 0) return ''
  const preview = availableToolIds.slice(0, 8).join(', ')
  return [
    `自主升级协议：当前可用工具包括 [${preview}]。`,
    '如果你能像真人群友一样直接回答，请直接输出自然回复正文；',
    '仅当你确实需要实时信息或外部工具才能准确回答时，只输出 [[escalate:工具ID1,工具ID2|简短原因]]（不要同时输出多余正文）；',
    '如果觉得此时保持沉默更自然，只输出 [[silence]]。',
  ].join('')
}

export function parseEscalationDirective(rawText: string): EscalationDirective {
  const trimmed = rawText.trim()
  if (!trimmed) return { action: 'reply', text: '' }
  if (SILENCE_RE.test(trimmed)) return { action: 'silence' }

  const match = trimmed.match(ESCALATE_RE)
  if (!match) {
    return { action: 'reply', text: trimmed }
  }

  const requestedTools = (match[1] ?? '')
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 5)
  const reason = (match[2] ?? '').trim().slice(0, 80) || 'model-requested-escalation'

  return {
    action: 'escalate',
    requestedTools,
    reason,
  }
}
