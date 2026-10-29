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
    out = convertSetextHeadings(out)
    out = keepHeadings ? clampHeadings(out) : downgradeHeadings(out)
    out = convertImages(out)
    out = stripHtmlTags(out)
    out = dropHorizontalRules(out)
    out = convertTaskLists(out)
    out = flattenDeepNesting(out)
    // Dropping a rule line leaves the blank lines that surrounded it.
    out = out.replace(/\n{3,}/g, '\n\n')
    // Tables go last: the box they draw lives inside a fence, and any rewrite
    // running after it would shift the padding the borders depend on.
    out = convertTables(out)
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
 * Widest grid, in monospace cells, that still reads without horizontal scroll.
 * Kept under `CODE_LINE_WIDTH` so the embed path's line wrapper cannot reflow a
 * drawn table and break its alignment.
 */
export const TABLE_MAX_WIDTH = 84
/** Columns never shrink below this, so a wrapped cell still has visible room. */
const TABLE_MIN_COL_WIDTH = 4
/** A single column wider than this wraps instead of pushing the grid out. */
const TABLE_MAX_COL_WIDTH = 28

/**
 * Convert a GFM pipe table into an ASCII box inside a fenced block.
 *
 * Discord has no table syntax on any surface, so the grid can only be drawn in
 * the one place the client uses a monospace font: a code fence. Columns are
 * padded by display width (a CJK glyph or emoji counts as two cells), which is
 * why the raw pipe rows looked ragged.
 *
 * Column alignment follows the GFM rule row (`:---`, `:---:`, `---:`). A table
 * too wide for `maxWidth` is shrunk column by column and over-long cells wrap;
 * a table whose columns cannot fit at all falls back to pipe rows.
 */
export function convertTables(text, { maxRows = 60, maxWidth = TABLE_MAX_WIDTH } = {}) {
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
      const aligns = parseAlignments(splitRow(next), header.length)
      const rows = []
      let j = i + 2
      while (j < lines.length && isRow(lines[j])) {
        // Two tables separated by nothing but a newline get merged by the row
        // scan above; treat the second one's rule row as a boundary, not data.
        if (isSeparator(lines[j])) break
        rows.push(splitRow(lines[j]))
        j += 1
      }
      out.push(renderAsciiTable(header, aligns, rows, { maxRows, maxWidth }))
      i = j
      continue
    }
    out.push(line)
    i += 1
  }
  return out.join('\n')
}

/** Split a pipe row, honouring `\|` escapes so a cell can contain a pipe. */
function splitRow(line) {
  const trimmed = String(line).trim()
  if (!trimmed.includes('|')) return []
  let body = trimmed
  if (body.startsWith('|')) body = body.slice(1)
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1)

  const cells = []
  let cell = ''
  for (let k = 0; k < body.length; k += 1) {
    const ch = body[k]
    if (ch === '\\' && body[k + 1] === '|') {
      cell += '|'
      k += 1
      continue
    }
    if (ch === '|') {
      cells.push(cell.trim())
      cell = ''
      continue
    }
    cell += ch
  }
  cells.push(cell.trim())
  return cells
}

/** Map the GFM rule row onto alignments; anything unmarked is left-aligned. */
function parseAlignments(separatorCells, columns) {
  return Array.from({ length: columns }, (_, i) => {
    const cell = String(separatorCells[i] ?? '').trim()
    if (cell.startsWith(':') && cell.endsWith(':')) return 'center'
    if (cell.endsWith(':')) return 'right'
    return 'left'
  })
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
 * Strip inline Markdown from a cell before it is measured.
 *
 * The grid is printed inside a code fence, where `**bold**` and `` `code` ``
 * would appear literally and also inflate the measured width, so the markers
 * have to go first.
 */
function plainCellText(text) {
  let out = String(text ?? '').trim()
  out = out.replace(/`{2,}/g, ' ')
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  out = out.replace(/`([^`]*)`/g, '$1')
  out = out.replace(/\*\*([^*]+)\*\*/g, '$1')
  out = out.replace(/__([^_]+)__/g, '$1')
  out = out.replace(/~~([^~]+)~~/g, '$1')
  out = out.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1$2')
  out = out.replace(/(^|[^_\w])_([^_\n]+)_/g, '$1$2')
  out = out.replace(/<[^>]+>/g, '')
  return out.replace(/\s+/g, ' ').trim()
}

/** Pad a cell to a display width. Padding by `String.length` drifts on CJK. */
function padDisplay(text, width, align = 'left') {
  const source = String(text ?? '')
  const current = displayWidth(source)
  if (current >= width) return source
  const pad = width - current
  if (align === 'right') return ' '.repeat(pad) + source
  if (align === 'center') {
    const left = Math.floor(pad / 2)
    return ' '.repeat(left) + source + ' '.repeat(pad - left)
  }
  return source + ' '.repeat(pad)
}

/**
 * Wrap one cell to a column width, preferring a break at the last space so
 * Latin words stay whole; CJK has no spaces and breaks anywhere.
 */
function wrapToWidth(text, width) {
  const source = String(text ?? '')
  if (displayWidth(source) <= width) return [source]
  const lines = []
  let line = ''
  let used = 0
  for (const ch of source) {
    const w = charWidth(ch.codePointAt(0))
    if (used + w > width && line) {
      const space = line.lastIndexOf(' ')
      if (space > 0) {
        lines.push(line.slice(0, space))
        line = line.slice(space + 1)
      } else {
        lines.push(line)
        line = ''
      }
      used = displayWidth(line)
    }
    line += ch
    used += w
  }
  if (line) lines.push(line)
  return lines.length ? lines : ['']
}

/**
 * Content widths for the grid, capped so the frame stays inside `maxWidth`.
 * Returns null when even the minimum widths cannot fit — the caller falls back
 * to pipe rows rather than drawing a grid that overflows the viewport.
 */
function columnWidths(rows, columns, maxWidth) {
  const widths = Array.from({ length: columns }, (_, i) => {
    let width = TABLE_MIN_COL_WIDTH
    for (const row of rows) width = Math.max(width, displayWidth(row[i] ?? ''))
    return Math.min(width, TABLE_MAX_COL_WIDTH)
  })
  const frame = columns + 1 + columns * 2
  let content = widths.reduce((sum, width) => sum + width, 0)
  while (content + frame > maxWidth) {
    let widest = 0
    for (let i = 1; i < widths.length; i += 1) {
      if (widths[i] > widths[widest]) widest = i
    }
    if (widths[widest] <= TABLE_MIN_COL_WIDTH) return null
    widths[widest] -= 1
    content -= 1
  }
  return widths
}

/**
 * Draw the table as a box inside a ```text fence.
 *
 * A monospace cell is not a pixel unit, so wide glyphs can still drift by a
 * fraction of a cell; the borders only line up as long as every line is padded
 * by measured display width, which is exactly what this does.
 */
function renderAsciiTable(header, aligns, rows, { maxRows, maxWidth }) {
  const headerCells = header.map((cell) => plainCellText(cell))
  const columns = headerCells.length
  const shown = rows
    .slice(0, maxRows)
    .map((row) => headerCells.map((_, i) => plainCellText(row[i] ?? '')))
  const widths = columnWidths([headerCells, ...shown], columns, maxWidth)
  if (!widths) return renderRecordTable(headerCells, rows, maxRows)

  const border = (left, mid, right) =>
    left + widths.map((width) => '─'.repeat(width + 2)).join(mid) + right
  const lines = [border('┌', '┬', '┐')]

  const pushRow = (cells) => {
    const wrapped = cells.map((cell, i) => wrapToWidth(cell, widths[i]))
    const height = Math.max(...wrapped.map((cell) => cell.length), 1)
    for (let line = 0; line < height; line += 1) {
      const parts = wrapped.map(
        (cellLines, i) => ` ${padDisplay(cellLines[line] ?? '', widths[i], aligns[i])} `,
      )
      lines.push(`│${parts.join('│')}│`)
    }
  }

  pushRow(headerCells)
  lines.push(border('├', '┼', '┤'))
  for (const row of shown) pushRow(row)
  lines.push(border('└', '┴', '┘'))

  const block = ['```text', ...lines, '```'].join('\n')
  const clipped = rows.length > maxRows ? `\n… 另有 ${rows.length - maxRows} 行` : ''
  return `${block}${clipped}`
}

/**
 * Fallback for a table that cannot be drawn inside `maxWidth`: raw `|` rows
 * with a bolded header, which survive every client even without alignment.
 */
function renderRecordTable(header, rows, maxRows) {
  const lines = []
  if (header.some(Boolean)) {
    lines.push(header.map((cell) => (cell ? `**${cell}**` : '')).join(' | '))
  }
  const escape = (cell) => plainCellText(cell).replace(/\|/g, '\\|')
  for (const row of rows.slice(0, maxRows)) {
    lines.push(header.map((_, i) => escape(row[i] ?? '')).join(' | '))
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
