/**
 * Whether a tool result means the operator refused, rather than the tool failing.
 *
 * DSH fails closed on approval: a refused escalation, a cancelled prompt and a
 * missing approval channel all come back as ordinary tool errors, and a sandbox
 * that refuses a path reports a denial the same way. The answer card paints
 * those turns red, while a run that merely hit a tool error keeps its normal
 * colour — the point is to separate "asked and was told no" from "something
 * broke".
 */
const DENIAL_PATTERNS = [
  /user rejected/i,
  /rejected escalating/i,
  /approval for escalating/i,
  /requires approval/i,
  /no approval channel/i,
  /approval (?:was )?cancelled/i,
  /sandbox:[^\]]*denied/i,
  /permission denied/i,
  /access denied/i,
]

/**
 * @param result - a `tool/result` event payload (`{ message, error }`).
 * @returns true when the error text shows a refusal, not a malfunction.
 */
export function isPermissionDenial(result) {
  const message = result?.message
  if (!message?.isError) return false
  const parts = Array.isArray(message.content) ? message.content : []
  const body = parts.map((part) => (part?.type === 'text' ? String(part.text ?? '') : '')).join('\n')
  const error = result?.error ?? {}
  const errorText = [error.code, error.reason, error.message].filter(Boolean).join(' ')
  const haystack = `${body}\n${errorText}`
  return DENIAL_PATTERNS.some((pattern) => pattern.test(haystack))
}
