/**
 * Discord Markdown filter.
 *
 * Discord's own docs state that it "utilizes a subset of markdown" for
 * rendering message content, and the API reference then lists only the custom
 * syntaxes it adds (mentions, custom emoji, timestamps) — it never enumerates
 * the subset. Everything outside that subset is printed literally by the client,
 * so the model's prose has to be filtered before it reaches a card.
 *
 * Rendered by the client (keep as-is):
 *   `**bold**` `*italic*` `__underline__` `~~strike~~` `||spoiler||`
 *   `` `code` `` fenced blocks, `> quote`, `-` / `1.` lists,
 *   `[text](url)`, `#`/`##`/`###` headings, `-#` subtext
 *
 * NOT rendered (this filter rewrites them):
 *   - `|---|` tables            -> `a | b` lines (see convertTables)
 *   - horizontal rules `---`    -> dropped; printed literally otherwise
 *   - `####` and deeper         -> bold line (client stops at h3)
 *   - setext headings (`===`)   -> `#` heading
 *   - images `![alt](url)`      -> `[alt](url)` link
 *   - raw HTML tags             -> stripped, they would show as text
 *   - `<t:UNIX:R>` timestamps   -> never emitted; a Text Display does not expand
 *                                  message-formatting timestamps
 *
 * Fenced code blocks are protected first and never rewritten.
 */

const FENCE = '```'

/**
 * The filter itself: one pass, outside code fences only.
 *
 * Shared by both payload kinds — a Text Display and an embed description render
 * the same subset, so there is no reason to keep two rule sets.
 */
export function discordMarkdownFilter(text, { keepHeadings = true } = {}) {
  const source = String(text ?? '')
  if (!source) return ''
  return mapOutsideCode(source, (segment) => {
    let out = segment
    out = convertTables(out)
    out = convertSetextHeadings(out)
    out = keepHeadings ? clampHeadings(out) : downgradeHeadings(out)
    out = convertImages(out)
    out = stripHtmlTags(out)
    out = dropHorizontalRules(out)
    out = convertTaskLists(out)
    out = flattenDeepNesting(out)
    // Dropping a rule line leaves the blank lines that surrounded it.
    out = out.replace(/\n{3,}/g, '\n\n')
    return out
  })
}

/** `Title` over `=====` becomes `# Title`. */
export function convertSetextHeadings(text) {
  return String(text ?? '').replace(
    /^(?![ \t]*[-*+>#|`])([^\n]+)\n[ \t]*(=+|-{2,})[ \t]*$/gm,
    (match, title, rule) => {
      const clean = String(title).trim()
      if (!clean) return match
      return `${rule.startsWith('=') ? '#' : '##'} ${clean}`
    },
  )
}

/** The client renders `#` through `###`; deeper levels become bold text. */
export function clampHeadings(text) {
  return String(text ?? '').replace(/^(#{4,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, (_m, _hashes, title) => {
    const clean = String(title).trim()
    return clean ? `**${clean}**` : _m
  })
}

/** `![alt](url)` -> `[alt](url)`: a card cannot embed the image inline. */
export function convertImages(text) {
  return String(text ?? '').replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_m, alt, url) =>
    alt ? `[${alt}](${url})` : `<${url}>`,
  )
}

/** Strip HTML tags, which the client prints verbatim. */
export function stripHtmlTags(text) {
  return String(text ?? '').replace(/<\/?(?:div|span|p|br|hr|b|i|u|s|table|tr|td|th|ul|ol|li|h[1-6]|img|a|code|pre)\b[^>]*>/gi, '')
}

/** A `---` rule is printed literally, so remove the line entirely. */
export function dropHorizontalRules(text) {
  return String(text ?? '').replace(/^[ \t]{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, '')
}

/**
 * Text Display (Components V2): headings render, so only unsupported syntax is
 * rewritten.
 */
export function adaptMarkdownForTextDisplay(text) {
  return discordMarkdownFilter(text, { keepHeadings: true })
}

/**
 * Embed description: headings never render here, so they are flattened to bold
 * as well, and long code lines are wrapped.
 */
export function adaptMarkdownForEmbed(text) {
  return wrapLongCodeLines(discordMarkdownFilter(text, { keepHeadings: false }))
}

/**
 * Soft-wrap over-long lines inside fenced code blocks.
 *
 * A phone shows roughly 40 monospace characters per line; a 200-char command
 * or an ASCII "before/after" diagram pushed Discord into horizontal scrolling
 * and the surrounding text broke apart. Wrapping keeps every block inside the
 * viewport at the cost of some alignment.
 */
export const CODE_LINE_WIDTH = 88

export function wrapLongCodeLines(text, width = CODE_LINE_WIDTH) {
  const lines = String(text ?? '').split('\n')
  const out = []
  let inFence = false
  for (const line of lines) {
    if (line.trimStart().startsWith(FENCE)) {
      inFence = !inFence
      out.push(line)
      continue
    }
    if (!inFence || line.length <= width) {
      out.push(line)
      continue
    }
    for (const wrapped of wrapLine(line, width)) out.push(wrapped)
  }
  return out.join('\n')
}

/** Break one line into width-sized pieces, keeping the original indent. */
function wrapLine(line, width) {
  const indent = (line.match(/^[ 	]*/) || [''])[0]
  const continuation = ' '.repeat(Math.min(indent.length, 8))
  const pieces = []
  let rest = line
  while (rest.length > width) {
    // Prefer a space so commands break at word boundaries when possible.
    let cut = rest.lastIndexOf(' ', width)
    if (cut < Math.floor(width * 0.5)) cut = width
    pieces.push(rest.slice(0, cut))
    rest = continuation + rest.slice(cut).replace(/^\s+/, '')
  }
  pieces.push(rest)
  return pieces
}

/**
 * Split text into fenced / non-fenced segments and apply `fn` only to the
 * non-fenced ones. An unterminated fence swallows the remainder verbatim, which
 * is what a streaming answer looks like mid-generation.
 */
export function mapOutsideCode(text, fn) {
  const lines = String(text ?? '').split('\n')
  const out = []
  let buffer = []
  let inFence = false

  const flush = () => {
    if (buffer.length === 0) return
    out.push(fn(buffer.join('\n')))
    buffer = []
  }

  for (const line of lines) {
    if (line.trimStart().startsWith(FENCE)) {
      if (!inFence) {
        flush()
        inFence = true
        out.push(line)
      } else {
        inFence = false
        out.push(line)
      }
      continue
    }
    if (inFence) out.push(line)
    else buffer.push(line)
  }
  flush()
  return out.join('\n')
}

/** `# Heading` → `**Heading**` (embed headings do not render). */
export function downgradeHeadings(text) {
  return String(text ?? '').replace(
    /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/gm,
    (_match, _hashes, title) => {
      const clean = String(title).trim()
      if (!clean) return _match
      // Keep heading hierarchy readable without relying on unsupported syntax.
      return `**${clean}**`
    },
  )
}

/**
 * Convert a GFM pipe table into something Discord renders natively.
 *
 * Discord supports no table syntax. Narrow (2-column) tables become bullet
 * lists that wrap cleanly; wider ones stay in a fenced block whose columns are
 * padded by display width so CJK text lines up.
 */
export function convertTables(text, { maxRows = 60 } = {}) {
  const lines = String(text ?? '').split('\n')
  const out = []
  let i = 0

  const isSeparator = (line) => {
    const cells = splitRow(line)
    if (cells.length === 0) return false
    return cells.every((cell) => /^:?-{2,}:?$/.test(cell.trim()))
  }
  const isRow = (line) => line.includes('|') && line.trim() !== ''

  while (i < lines.length) {
    const line = lines[i]
    const next = lines[i + 1]
    if (isRow(line) && next !== undefined && isSeparator(next)) {
      const header = splitRow(line)
      const rows = []
      let j = i + 2
      while (j < lines.length && isRow(lines[j])) {
        // Two tables separated by nothing but a newline get merged by the row
        // scan above; treat the second one's rule row as a boundary, not data.
        if (isSeparator(lines[j])) break
        rows.push(splitRow(lines[j]))
        j += 1
      }
      out.push(renderCodeTable(header, rows, { maxRows }))
      i = j
      continue
    }
    out.push(line)
    i += 1
  }
  return out.join('\n')
}

function splitRow(line) {
  const trimmed = String(line).trim()
  if (!trimmed.includes('|')) return []
  let body = trimmed
  if (body.startsWith('|')) body = body.slice(1)
  if (body.endsWith('|')) body = body.slice(0, -1)
  return body.split('|').map((cell) => cell.trim())
}

/**
 * Display width in monospace cells.
 *
 * A CJK ideograph or an emoji occupies two cells, so `String.length` is the
 * wrong measure for alignment: "名称" is length 2 but renders four cells wide.
 * Padding by length is what made column tables look ragged.
 */
export function displayWidth(text) {
  let width = 0
  for (const ch of String(text ?? '')) {
    width += charWidth(ch.codePointAt(0))
  }
  return width
}

function charWidth(cp) {
  // Zero-width and combining marks.
  if (cp === 0x200b || cp === 0x200d || cp === 0xfeff) return 0
  if (cp >= 0x0300 && cp <= 0x036f) return 0
  // Wide / fullwidth ranges: CJK, Hangul, Hiragana, Katakana, fullwidth forms.
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    // Emoji presented as width-2 in Discord's monospace cells: dingbats and
    // misc symbols (✅ ❌ ⚠), plus the pictographic blocks.
    (cp >= 0x2600 && cp <= 0x27bf) ||
    (cp >= 0x2b00 && cp <= 0x2bff) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x1f680 && cp <= 0x1f6ff)
  ) {
    return 2
  }
  return 1
}

/** Pad to a display width, never splitting a surrogate pair. */
function padTo(text, width) {
  const source = String(text ?? '')
  const current = displayWidth(source)
  if (current >= width) return source
  return source + ' '.repeat(width - current)
}

/** Truncate to a display width, appending an ellipsis when clipped. */
function clipToWidth(text, width) {
  const source = String(text ?? '')
  if (displayWidth(source) <= width) return source
  let out = ''
  let used = 0
  for (const ch of source) {
    const w = charWidth(ch.codePointAt(0))
    if (used + w > width - 1) break
    out += ch
    used += w
  }
  return `${out}…`
}

/**
 * Discord has no table syntax at all, on any surface, so a pipe table is always
 * rewritten. Every table becomes a fenced record block.
 */
function renderCodeTable(header, rows, { maxRows }) {
  return renderRecordTable(header, rows, maxRows)
}

/**
 * Render a pipe table as plain `|`-separated lines.
 *
 * Discord has no table syntax on any surface, so the grid itself cannot be
 * reproduced. Attempts to fake it — padding columns, fencing them in monospace —
 * all fail on mixed CJK/Latin content, because a CJK glyph is not exactly two
 * monospace cells. Keeping the original `|` separators is what survives every
 * client: each row reads as one line of `a | b | c` without pretending to align.
 *
 * The header row is bolded so it still reads as a header, and the `---` rule row
 * is dropped because Discord would print it literally.
 */
function renderRecordTable(header, rows, maxRows) {
  const lines = []
  const headerCells = header.map((cell) => String(cell ?? '').trim())
  if (headerCells.some(Boolean)) {
    lines.push(headerCells.map((cell) => (cell ? `**${cell}**` : '')).join(' | '))
  }
  for (const row of rows.slice(0, maxRows)) {
    const cells = row.map((cell) => String(cell ?? '').trim())
    lines.push(cells.join(' | '))
  }
  if (rows.length > maxRows) lines.push(`… 另有 ${rows.length - maxRows} 行`)
  return lines.join('\n')
}

/** `- [ ] task` → `- ☐ task`, `- [x] done` → `- ☑ done`. */
export function convertTaskLists(text) {
  return String(text ?? '').replace(
    /^([ \t]*)[-*+][ \t]+\[([ xX])\][ \t]+(.+)$/gm,
    (_m, indent, mark, body) => `${indent}- ${mark.trim() === '' ? '☐' : '☑'} ${body}`,
  )
}

/** Deep list nesting collapses badly in embeds; cap the indent at two levels. */
export function flattenDeepNesting(text) {
  return String(text ?? '').replace(/^([ \t]{4,})([-*+]|\d+\.)[ \t]+/gm, '  $2 ')
}
