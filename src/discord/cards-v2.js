/**
 * Card renderers built on Components V2.
 *
 * These replace the embed-based cards in renderer.js. The key difference: a
 * Text Display renders the full Markdown rules, so headings survive as real
 * headings instead of being downgraded to bold lines, and a Separator gives a
 * real divider instead of a `---` that Discord would print literally.
 *
 * The colour bar that an embed's `color` used to provide comes from the
 * Container's `accent_color`, so cards keep their status tint.
 */
import {
  MAX_TOTAL_COMPONENTS,
  TEXT_DISPLAY_LIMIT,
  actionRow,
  button,
  container,
  countComponents,
  separator,
  textChunks,
  textDisplay,
  v2Payload,
} from './components-v2.js'
import { suppressMentions } from './renderer.js'
import { adaptMarkdownForTextDisplay } from './markdown.js'

/** Status tints, matching the embed palette used elsewhere. */
export const ACCENT = {
  thinking: 0x5865f2,
  working: 0xfaa61a,
  completed: 0x57f287,
  cancelled: 0x99aab5,
  failed: 0xed4245,
  notice: 0x5865f2,
}

/**
 * Build a card: an optional title line, the body split into Text Displays, an
 * optional footer, and optional component rows.
 *
 * `title` is emitted as a Markdown heading because Text Display renders it; the
 * old embed path had to flatten it to `**bold**`.
 */
export function cardPayload({
  accentColor = ACCENT.thinking,
  title,
  body,
  footer,
  rows = [],
  headingLevel = 2,
  emptyText = '（无内容）',
} = {}) {
  const children = []
  const cleanTitle = suppressMentions(String(title ?? '')).trim()
  if (cleanTitle) {
    children.push(textDisplay(`${'#'.repeat(clampHeading(headingLevel))} ${cleanTitle}`))
  }
  // Text Display renders full Markdown, so only table syntax is rewritten here;
  // headings and nesting are left exactly as the model wrote them.
  const adaptedBody = adaptMarkdownForTextDisplay(String(body ?? ''))
  const cleanBody = suppressMentions(adaptedBody).trim()
  for (const chunk of textChunks(cleanBody || emptyText)) {
    children.push(textDisplay(chunk))
  }
  const cleanFooter = suppressMentions(String(footer ?? '')).trim()
  if (cleanFooter) {
    children.push(separator({ spacing: 1 }))
    // Subtext is Discord's own small-print style for a footer line.
    children.push(textDisplay(`-# ${cleanFooter}`))
  }
  for (const row of rows) if (row) children.push(row)
  return v2Payload([container(children, { accentColor })])
}

function clampHeading(level) {
  const n = Number(level)
  if (!Number.isFinite(n)) return 2
  return Math.min(3, Math.max(1, Math.round(n)))
}

/** Placeholder card shown while the turn is starting. */
export function placeholderCard(text = '⏳ 已接收，正在处理…') {
  return cardPayload({ accentColor: ACCENT.thinking, body: text })
}

/**
 * Streaming answer card.
 *
 * Tool calls render **inline** at the top of the answer body rather than in a
 * separate message, so one turn is one card. The body itself is the aggregated
 * assistant Markdown; the footer carries model/effort/timing.
 */
export function streamCard(
  text,
  { startedAt, model, reasoningEffort, caption, title, accentColor, tools, toolLines } = {},
) {
  const parts = []
  const inline = toolLines === undefined ? inlineToolLines(tools) : toolLines
  if (inline) parts.push(inline)
  const body = String(text ?? '').trim()
  if (body) parts.push(body)
  return cardPayload({
    accentColor: accentColor ?? ACCENT.thinking,
    title,
    body: parts.join('\n\n'),
    footer: footerBits({ startedAt, model, reasoningEffort, caption }),
  })
}

/**
 * One subtext line per tool call, for inline display inside the answer card.
 *
 * `-#` is Discord's small-print style, so the run reads as a quiet log rather
 * than competing with the answer. Argument values are never included — only the
 * tool name and the caller-supplied description.
 */
export function inlineToolLines(tools = [], { maxLines = 12 } = {}) {
  const list = Array.isArray(tools) ? tools : []
  if (!list.length) return ''
  const recent = list.slice(-maxLines)
  const hidden = list.length - recent.length
  const rows = recent.map((tool) => {
    const name = String(tool?.name ?? 'tool').slice(0, 48)
    const running = tool?.endedAt === undefined
    const description = describeTool(tool?.args)
    const glyph = running ? '⟳' : '✓'
    return description ? `-# ${glyph} \`${name}\` · ${description}` : `-# ${glyph} \`${name}\``
  })
  if (hidden > 0) rows.unshift(`-# …更早的 ${hidden} 次已省略`)
  return rows.join('\n')
}

/** Tool-run card: one line per call, no argument values. */
/**
 * Tool-run card.
 *
 * The list of calls is wrapped in a fenced code block: tool names are
 * identifiers, and monospace keeps them aligned and visually distinct from
 * prose, instead of each line being its own bold bullet.
 */
export function toolListCard(tools = [], { maxLines = 24, title = '🛠 工具调用' } = {}) {
  if (!tools.length) return cardPayload({ accentColor: ACCENT.working, title, body: '（无调用）' })
  const recent = tools.slice(-maxLines)
  const hidden = tools.length - recent.length
  const lines = recent.map((tool) => {
    const name = String(tool?.name ?? 'unknown').slice(0, 64)
    const running = tool?.endedAt === undefined
    const description = describeTool(tool?.args)
    const glyph = running ? '⟳' : '✓'
    return description ? `${glyph} ${name}  ${description}` : `${glyph} ${name}`
  })
  if (hidden > 0) lines.unshift(`… 更早的 ${hidden} 次已省略`)
  const running = tools.filter((tool) => tool?.endedAt === undefined).length
  const footer = [`共 ${tools.length} 次`, running > 0 ? `${running} 个运行中` : ''].filter(Boolean).join(' · ')
  const body = ['```', ...lines, '```'].join('\n')
  return cardPayload({ accentColor: ACCENT.working, title, body, footer })
}

/** Intent-only description; argument values are never rendered. */
function describeTool(args) {
  const raw = String(args ?? '').trim()
  if (!raw || raw === '{}') return ''
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return ''
    for (const field of ['description', 'summary', 'label', 'title', 'reason', 'purpose']) {
      const value = parsed[field]
      if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 48)
    }
  } catch {
    /* ignore malformed arguments */
  }
  return ''
}

/** Final answer card in one of the terminal states, with inline tool lines. */
export function finalCard(text, status = 'completed', meta = {}) {
  const { title, accent } = FINAL_STATES[status] ?? FINAL_STATES.completed
  const parts = []
  const inline = inlineToolLines(meta.tools)
  if (inline) parts.push(inline)
  const body = String(text ?? '').trim()
  if (body) parts.push(body)
  return cardPayload({
    accentColor: accent,
    title,
    body: parts.join('\n\n'),
    footer: footerBits({ ...meta, caption: meta.caption }),
  })
}

export const FINAL_STATES = {
  completed: { title: '✅ 已完成', accent: ACCENT.completed },
  cancelled: { title: '⏹️ 已停止', accent: ACCENT.cancelled },
  failed: { title: '❌ 执行失败', accent: ACCENT.failed },
}

/** Notification / command reply card. */
export function noticeCard(text, { title, accentColor = ACCENT.notice, footer } = {}) {
  return cardPayload({ accentColor, title, body: text, footer })
}

/** Confirmation card with approve / reject buttons. */
export function approvalCard({
  requestId,
  title = '⚠️ 需要确认',
  description,
  footer,
  expiresAt,
  approvePrefix,
  rejectPrefix,
} = {}) {
  const bits = []
  if (footer) bits.push(footer)
  if (expiresAt) {
    const left = Math.max(0, expiresAt - Date.now())
    if (left > 0) bits.push(`${Math.ceil(left / 1000)}s 后失效`)
  }
  const row = actionRow([
    button({ customId: `${approvePrefix}${requestId}`, label: '批准', style: 3, emoji: { name: '✅' } }),
    button({ customId: `${rejectPrefix}${requestId}`, label: '拒绝', style: 4, emoji: { name: '🚫' } }),
  ])
  return cardPayload({
    accentColor: ACCENT.working,
    title,
    body: description || '（无描述）',
    footer: bits.join(' · '),
    rows: [row],
  })
}

/** Same card after a decision, with the buttons removed. */
export function decidedApprovalCard(decision, { title, description } = {}) {
  const approved = decision === 'approved'
  return cardPayload({
    accentColor: approved ? ACCENT.completed : ACCENT.cancelled,
    title: title || (approved ? '✅ 已批准' : '🚫 已拒绝'),
    body: description || (approved ? '操作已批准。' : '操作已拒绝。'),
  })
}

/** Attach a stop button row to a card payload. */
export function withStopRow(payload, messageId, { prefix, label = '停止' } = {}) {
  if (!messageId || !prefix) return payload
  const tree = payload.components || []
  const root = tree[0]
  if (!root || root.type !== 17) return payload
  const row = actionRow([
    button({ customId: `${prefix}${messageId}`, label, style: 4, emoji: { name: '⏹️' } }),
  ])
  return { ...payload, components: [{ ...root, components: [...root.components, row] }] }
}

function footerBits({ startedAt, model, reasoningEffort, caption } = {}) {
  const bits = []
  if (model) bits.push(`${model}${reasoningEffort ? ` (effort:${reasoningEffort})` : ''}`)
  if (startedAt) {
    const elapsed = Date.now() - startedAt
    if (elapsed > 0) bits.push(`耗时 ${formatElapsed(elapsed)}`)
  }
  if (caption) bits.push(caption)
  return bits.join(' · ')
}

function formatElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m${Math.round(seconds % 60)}s`
}

/**
 * Guard against the 40-component ceiling before sending, rather than letting
 * the API reject the whole message.
 */
export function assertComponentBudget(payload) {
  const total = countComponents(payload?.components)
  if (total > MAX_TOTAL_COMPONENTS) {
    throw new Error(`Components V2 payload has ${total} components, limit is ${MAX_TOTAL_COMPONENTS}`)
  }
  return payload
}

export { TEXT_DISPLAY_LIMIT, MAX_TOTAL_COMPONENTS }
