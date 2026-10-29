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
  CONTAINER_TEXT_LIMIT,
  MAX_TOTAL_COMPONENTS,
  TEXT_DISPLAY_LIMIT,
  TEXT_INPUT_STYLE,
  actionRow,
  button,
  container,
  countComponents,
  label,
  modal,
  separator,
  stringSelect,
  textChunks,
  textDisplay,
  textInput,
  v2Payload,
} from './components-v2.js'
import { suppressMentions } from './renderer.js'
import { adaptMarkdownForTextDisplay } from './markdown.js'

/** Subtext marker for a footer line; counts toward the text budget. */
const FOOTER_PREFIX = '-# '

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
  // Discord caps the *total* displayable text in a container at 4000 characters,
  // not each Text Display. Budget the title and footer first, then give the body
  // whatever is left, or a long answer plus its chrome is rejected outright
  // (COMPONENT_DISPLAYABLE_TEXT_SIZE_EXCEEDED).
  let budget = CONTAINER_TEXT_LIMIT
  /** Reserve `prefix`+text against the budget; the prefix counts too. */
  const take = (text, prefix = '') => {
    const room = budget - prefix.length
    if (room <= 0) return ''
    const clipped = text.length <= room ? text : `${text.slice(0, Math.max(0, room - 1))}…`
    budget -= prefix.length + clipped.length
    return clipped
  }

  const headingPrefix = `${'#'.repeat(clampHeading(headingLevel))} `
  const cleanTitle = take(suppressMentions(String(title ?? '')).trim(), headingPrefix)
  if (cleanTitle) children.push(textDisplay(`${headingPrefix}${cleanTitle}`))

  // The footer prefix also occupies characters in the container.
  const cleanFooter = take(suppressMentions(String(footer ?? '')).trim(), FOOTER_PREFIX)

  // Text Display renders full Markdown, so only table syntax is rewritten here;
  // headings and nesting are left exactly as the model wrote them.
  const adaptedBody = adaptMarkdownForTextDisplay(String(body ?? ''))
  const cleanBody = take(suppressMentions(adaptedBody).trim())
  for (const chunk of textChunks(cleanBody || emptyText)) {
    children.push(textDisplay(chunk))
  }
  if (cleanFooter) {
    children.push(separator({ spacing: 1 }))
    // Subtext is Discord's own small-print style for a footer line.
    children.push(textDisplay(`${FOOTER_PREFIX}${cleanFooter}`))
  }
  for (const row of rows) if (row) children.push(row)
  return v2Payload([container(children, { accentColor })])
}

/**
 * Countdown text for a card footer.
 *
 * Two pieces on purpose: `<t:UNIX:R>` is rendered by Discord and keeps ticking on
 * the client with no message edit, while the remaining seconds are exact at the
 * moment the card is built. A countdown loop re-renders the card so the seconds
 * stay real; if a refresh is missed, the timestamp is still correct.
 */
function formatCountdown(expiresAt, remainingMs) {
  const seconds = Math.max(0, Math.ceil(remainingMs / 1000))
  const unix = Math.floor(expiresAt / 1000)
  return `⏳ 剩余 ${seconds}s（<t:${unix}:R> 失效）`
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
 * Tool calls are interleaved into the answer body by their character offset, so
 * the card reads in the order things happened — prose, then the call it
 * triggered, then the prose that followed. One turn stays one card.
 */
export function streamCard(
  text,
  { startedAt, model, reasoningEffort, caption, title, accentColor, tools, toolLines } = {},
) {
  const body = toolLines === undefined ? interleaveTools(text, tools) : composeBody(text, toolLines)
  return cardPayload({
    accentColor: accentColor ?? ACCENT.thinking,
    title,
    body,
    footer: footerBits({ startedAt, model, reasoningEffort, caption }),
  })
}

/** Put a static tool block above the body (used when offsets are unknown). */
function composeBody(text, toolLines) {
  const parts = []
  if (toolLines) parts.push(toolLines)
  const body = String(text ?? '').trim()
  if (body) parts.push(body)
  return parts.join('\n\n')
}

/**
 * Merge tool lines into the prose at the point each call occurred.
 *
 * Calls carry a `textOffset` recorded when they started. Splitting on those
 * offsets reconstructs the transcript order without needing separate messages.
 * Calls without an offset (older records) are placed at the start.
 */
export function interleaveTools(text, tools = []) {
  const list = Array.isArray(tools) ? tools : []
  const source = String(text ?? '')
  if (!list.length) return source.trim()

  const anchored = list
    .map((tool, index) => ({ tool, index, at: Number.isFinite(tool?.textOffset) ? tool.textOffset : 0 }))
    .sort((a, b) => a.at - b.at || a.index - b.index)

  const parts = []
  let cursor = 0
  for (const { tool, at } of anchored) {
    const cut = Math.min(Math.max(at, cursor), source.length)
    const before = source.slice(cursor, cut).trim()
    if (before) parts.push(before)
    parts.push(inlineToolLines([tool]))
    cursor = cut
  }
  const rest = source.slice(cursor).trim()
  if (rest) parts.push(rest)
  return parts.join('\n\n')
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
  // One blank line between calls: consecutive `-#` lines render flush against
  // each other, so the gap has to come from a real paragraph break.
  const rows = recent.map((tool) => {
    const name = String(tool?.name ?? 'tool').slice(0, 48)
    const running = tool?.endedAt === undefined
    const description = describeTool(tool?.args, name)
    const glyph = running ? '⟳' : '✓'
    return description ? `-# ${glyph} \`${name}\` · ${description}` : `-# ${glyph} \`${name}\``
  })
  if (hidden > 0) rows.unshift(`-# …更早的 ${hidden} 次已省略`)
  return rows.join('\n\n')
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

/**
 * Tools whose arguments name the file (or pattern) they operate on.
 *
 * Only the file-operating tools are listed: for `grep` the same `pattern` field
 * is a search term, not a target, so showing it would misrepresent the call.
 */
const FILE_TOOL_FIELDS = {
  read: ['file_path', 'path', 'filePath', 'filename'],
  write: ['file_path', 'path', 'filePath', 'filename'],
  edit: ['file_path', 'path', 'filePath', 'filename'],
  multiedit: ['file_path', 'path', 'filePath', 'filename'],
  glob: ['pattern'],
}

/**
 * Describe a tool call for the transcript.
 *
 * Priority:
 *   1. an explicit intent field the model supplied (description/summary/…)
 *   2. for file tools, the file being operated on — the path is the single most
 *      useful fact about a read/write/edit, and it is not secret material
 *
 * Everything else stays blank rather than echoing raw argument values.
 */
function describeTool(args, toolName) {
  const raw = String(args ?? '').trim()
  if (!raw || raw === '{}') return ''
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return ''
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return ''

  for (const field of ['description', 'summary', 'label', 'title', 'reason', 'purpose']) {
    const value = parsed[field]
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 48)
  }

  const name = String(toolName ?? '').toLowerCase()
  const fields = FILE_TOOL_FIELDS[name]
  if (fields) {
    for (const field of fields) {
      const value = parsed[field]
      if (typeof value === 'string' && value.trim()) {
        return shortenPath(value.trim())
      }
    }
  }
  return ''
}

/**
 * Trim a path to something readable in one line: keep the last two segments
 * and mark the elision, so `/home/user/projects/app/src/deep/file.js` becomes
 * `…/src/deep/file.js` instead of flooding the card.
 */
function shortenPath(path, { maxWidth = 52 } = {}) {
  const clean = String(path).trim().replace(/\s+/g, ' ')
  if (clean.length <= maxWidth) return clean
  const parts = clean.split('/').filter(Boolean)
  if (parts.length >= 2) {
    const tail = parts.slice(-2).join('/')
    const candidate = `…/${tail}`
    if (candidate.length <= maxWidth) return candidate
  }
  return `…${clean.slice(-(maxWidth - 1))}`
}

/** Final answer card in one of the terminal states, with interleaved tool lines. */
export function finalCard(text, status = 'completed', meta = {}) {
  const { title, accent } = FINAL_STATES[status] ?? FINAL_STATES.completed
  return cardPayload({
    accentColor: accent,
    title,
    body: interleaveTools(text, meta.tools),
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

/** Custom-ID prefixes for the question card's controls. */
export const QUESTION_SELECT_PREFIX = 'dsh:q:sel:'
export const QUESTION_SKIP_PREFIX = 'dsh:q:skip:'
export const QUESTION_CUSTOM_PREFIX = 'dsh:q:custom:'
/** The modal's custom_id; the request/question key is appended. */
export const QUESTION_MODAL_PREFIX = 'dsh:q:modal:'

/**
 * One DSH question rendered as a Discord card.
 *
 * The dropdown carries the options; `custom_id` encodes request id + question
 * index so the handler knows which answer to record. A skip button is always
 * present because DSH treats an unanswered question as skipped, and an explicit
 * control makes that outcome discoverable rather than implied.
 */
export function questionCard({
  requestId,
  question,
  index,
  total,
  expiresAt,
  selectPrefix = QUESTION_SELECT_PREFIX,
  skipPrefix = QUESTION_SKIP_PREFIX,
  customPrefix = QUESTION_CUSTOM_PREFIX,
} = {}) {
  const q = question ?? {}
  const options = Array.isArray(q.options) ? q.options : []
  const children = []

  const heading = q.header ? `${q.header}` : '❓ 需要你的选择'
  children.push(textDisplay(`## ${heading}`))

  const body = []
  if (q.question) body.push(q.question)
  if (q.detail) body.push(q.detail)
  const position = total > 1 ? `-# 第 ${index + 1}/${total} 个问题` : undefined
  if (position) body.push(position)
  children.push(textDisplay(body.join('\n\n') || '（无内容）'))

  if (options.length) {
    children.push(
      actionRow([
        stringSelect({
          customId: `${selectPrefix}${requestId}:${index}`,
          options: options.map((option, i) => ({
            label: option?.label ?? `选项 ${i + 1}`,
            value: String(i),
            description: option?.description,
          })),
          placeholder: q.multiSelect ? '选择一项或多项' : '选择一项',
          multi: Boolean(q.multiSelect),
        }),
      ]),
    )
  }

  // Skip and custom share a row: neither is a listed option, both are ways out
  // of the choice.
  children.push(
    actionRow([
      button({
        customId: `${customPrefix}${requestId}:${index}`,
        label: '自定义',
        style: 2,
        emoji: { name: '✏️' },
      }),
      button({
        customId: `${skipPrefix}${requestId}:${index}`,
        label: '跳过',
        style: 2,
        emoji: { name: '⏭️' },
      }),
    ]),
  )

  const bits = []
  if (expiresAt) {
    const left = Math.max(0, expiresAt - Date.now())
    if (left > 0) bits.push(formatCountdown(expiresAt, left))
  }
  if (bits.length) {
    children.push(separator({ spacing: 1 }))
    children.push(textDisplay(`-# ${bits.join(' · ')}`))
  }

  return v2Payload([container(children, { accentColor: ACCENT.notice })])
}

/** The same card once answered, with the controls removed. */
export function answeredQuestionCard({ question, selected = [], custom, skipped = false } = {}) {
  const q = question ?? {}
  const lines = []
  if (q.question) lines.push(q.question)
  if (skipped) lines.push('-# ⏭️ 已跳过')
  else if (custom) lines.push(`-# ✅ 自定义：${custom}`)
  else if (selected.length) lines.push(`-# ✅ 已选：${selected.join('、')}`)
  else lines.push('-# ⏭️ 已跳过')
  return cardPayload({
    accentColor: skipped ? ACCENT.cancelled : ACCENT.completed,
    title: q.header || '❓ 已作答',
    body: lines.join('\n\n'),
  })
}

/**
 * The modal that collects a free-text answer.
 *
 * A modal is the only Discord surface that accepts typed input, so "custom"
 * opens one instead of trying to fit a text field into the card. The request id
 * and question index travel in the modal's custom_id, which MODAL_SUBMIT echoes
 * back untouched.
 */
export function questionCustomModal({
  requestId,
  question,
  index,
  modalPrefix = QUESTION_MODAL_PREFIX,
} = {}) {
  const q = question ?? {}
  const fieldLabel = String(q.header || q.question || '你的回答').slice(0, 45)
  return modal({
    customId: `${modalPrefix}${requestId}:${index}`,
    title: fieldLabel || '自定义回答',
    // The input must sit inside a Label: Discord deprecated the Text Input's own
    // `label` field, so a bare input would render without its question.
    components: [
      label({
        text: fieldLabel || '自定义回答',
        component: textInput({
          customId: 'answer',
          style: TEXT_INPUT_STYLE.PARAGRAPH,
          placeholder: '输入你的回答…',
          maxLength: 1000,
          required: false,
        }),
      }),
    ],
  })
}

/** Confirmation card with approve / reject buttons. */
export function approvalCard({
  requestId,  title = '⚠️ 需要确认',
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
    if (left > 0) bits.push(formatCountdown(expiresAt, left))
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

/**
 * Same card after a decision, with the buttons removed.
 *
 * `decision` covers the three terminal states a request can reach:
 * approved / rejected / denied. `denied` means the operator approved but the
 * system refused — a permission or policy failure rather than a human choice.
 */
export function decidedApprovalCard(decision, { title, description } = {}) {
  const state = APPROVAL_STATES[decision] ?? APPROVAL_STATES.rejected
  return cardPayload({
    accentColor: state.accent,
    title: title || state.title,
    body: description || state.body,
  })
}

export const APPROVAL_STATES = {
  approved: { title: '✅ 已批准', accent: ACCENT.completed, body: '操作已批准。' },
  rejected: { title: '🚫 已拒绝', accent: ACCENT.cancelled, body: '操作已拒绝。' },
  denied: { title: '⛔ 无权限', accent: ACCENT.failed, body: '已批准，但系统拒绝了该操作。' },
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
