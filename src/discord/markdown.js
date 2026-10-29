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
 * Widest table, in fullwidth characters, that a phone can show without
 * horizontal scrolling. A fullwidth glyph is roughly two ASCII cells, so this
 * has to stay well under the ASCII-oriented limits used elsewhere.
 */
export const TABLE_MAX_CHARS = 22
/** A single column wider than this wraps instead of pushing the grid out. */
const TABLE_MAX_COL_CHARS = 12
const FULLWIDTH_SPACE = '\u3000'

/**
 * Convert ASCII to its fullwidth form.
 *
 * Discord cannot line up CJK and Latin text by character count: in the code
 * font one ASCII advance is about 0.6em while a CJK glyph is 1em, so a CJK
 * character is about 1.7 cells, not 2, and the drift differs per client. The
 * only way to make a grid survive every client is to stop mixing fonts: every
 * glyph in the table — borders included — becomes fullwidth, so every glyph
 * comes from the same CJK font with the same advance. Alignment then depends
 * only on equal character counts per line, which is exactly what the renderer
 * controls.
 */
/**
 * Punctuation whose width is "ambiguous" in Unicode: Latin fonts draw it narrow,
 * CJK fonts draw it fullwidth, and which font wins depends on the client. Inside
 * the grid that inconsistency would shift a border, so each one is replaced by a
 * CJK-only glyph with the same meaning.
 */
const AMBIGUOUS_GLYPHS = new Map([
  [0x00b7, '\u30fb'], // · middle dot -> ・ katakana middle dot
  [0x2022, '\u30fb'], // • bullet
  [0x2010, '\uff0d'], // ‐ hyphen
  [0x2011, '\uff0d'], // ‑ non-breaking hyphen
  [0x2012, '\uff0d'], // ‒ figure dash
  [0x2013, '\uff0d'], // – en dash
  [0x2014, '\uff0d'], // — em dash
  [0x2015, '\uff0d'], // ― horizontal bar
  [0x2212, '\uff0d'], // − minus sign
  [0x2026, '\u30fb\u30fb\u30fb'], // … ellipsis -> three CJK dots
])

export function toFullwidth(text) {
  let out = ''
  for (const ch of String(text ?? '')) {
    const cp = ch.codePointAt(0)
    const mapped = AMBIGUOUS_GLYPHS.get(cp)
    if (mapped !== undefined) {
      out += mapped
      continue
    }
    if (cp === 0x20) {
      out += FULLWIDTH_SPACE
      continue
    }
    if (cp === 0x7c || cp === 0xff5c) {
      // A pipe inside a cell would read as a border; use the ideographic
      // vertical stroke, which has the same advance.
      out += '\u4e28'
      continue
    }
    if (cp >= 0x21 && cp <= 0x7e) {
      out += String.fromCodePoint(cp + 0xfee0)
      continue
    }
    out += ch
  }
  return out
}

const GRAPHEMES = new Intl.Segmenter('zh', { granularity: 'grapheme' })

/** Grapheme clusters: an emoji sequence is one advance, not several. */
function graphemes(text) {
  return Array.from(GRAPHEMES.segment(String(text ?? '')), (part) => part.segment)
}

function charCount(text) {
  return graphemes(text).length
}

/**
 * Convert a GFM pipe table into a fullwidth grid inside a fenced block.
 *
 * Every glyph, borders and spaces included, is a fullwidth character, so each
 * line has the same advance regardless of the client's fonts; equal character
 * counts per line are therefore enough to align the grid.
 *
 * Cells are packed without the usual padding around their content: the border
 * is the only separator, which keeps a three-column table narrow enough for a
 * phone. Short cells are still filled with fullwidth spaces at the end for
 * alignment — that filler is the one space character that cannot be avoided.
 *
 * Column alignment follows the GFM rule row (`:---`, `:---:`, `---:`). A table
 * too wide for `maxChars` is shrunk column by column and over-long cells wrap;
 * a table whose columns cannot fit at all falls back to pipe rows.
 */
export function convertTables(text, { maxRows = 60, maxChars = TABLE_MAX_CHARS } = {}) {
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
      const grid = renderFullwidthTable(header, aligns, rows, { maxRows, maxChars })
      out.push(grid ?? renderRecordTable(header, rows, maxRows))
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

/** Pad a cell with fullwidth spaces; the filler is what keeps borders aligned. */
function padFullwidth(text, width, align = 'left') {
  const source = String(text ?? '')
  const fill = Math.max(0, width - charCount(source))
  if (fill === 0) return source
  if (align === 'right') return FULLWIDTH_SPACE.repeat(fill) + source
  if (align === 'center') {
    const left = Math.floor(fill / 2)
    return FULLWIDTH_SPACE.repeat(left) + source + FULLWIDTH_SPACE.repeat(fill - left)
  }
  return source + FULLWIDTH_SPACE.repeat(fill)
}

/** Wrap one cell on grapheme boundaries, preferring a break at a space. */
function wrapFullwidth(text, width) {
  const units = graphemes(text)
  if (units.length <= width) return [units.join('')]
  const lines = []
  let line = []
  for (const unit of units) {
    if (line.length >= width) {
      const space = line.lastIndexOf(FULLWIDTH_SPACE)
      if (space > 0) {
        lines.push(line.slice(0, space).join(''))
        line = line.slice(space + 1)
      } else {
        lines.push(line.join(''))
        line = []
      }
      // A space at the start of a continuation line would look like padding.
      while (line[0] === FULLWIDTH_SPACE) line.shift()
    }
    if (line.length === 0 && unit === FULLWIDTH_SPACE) continue
    line.push(unit)
  }
  if (line.length) lines.push(line.join(''))
  return lines.length ? lines : ['']
}

/**
 * Content widths in fullwidth characters, capped so the frame stays inside
 * `maxChars`. Returns null when even one character per column cannot fit, so
 * the caller can fall back to pipe rows instead of overflowing the viewport.
 */
function columnWidths(rows, columns, maxChars) {
  const widths = Array.from({ length: columns }, (_, i) => {
    let width = 1
    for (const row of rows) width = Math.max(width, charCount(row[i] ?? ''))
    return Math.min(width, TABLE_MAX_COL_CHARS)
  })
  const frame = columns + 1
  let content = widths.reduce((sum, width) => sum + width, 0)
  while (content + frame > maxChars) {
    let widest = 0
    for (let i = 1; i < widths.length; i += 1) {
      if (widths[i] > widths[widest]) widest = i
    }
    if (widths[widest] <= 1) return null
    widths[widest] -= 1
    content -= 1
  }
  return widths
}

/**
 * Draw the table as a fullwidth grid inside a ```text fence.
 *
 * There is no space between a cell's content and its borders: the border is the
 * only separator, which keeps the grid narrow enough for a phone. Alignment
 * still relies on fullwidth padding at the end of short cells, and that works
 * on every client because all glyphs come from the same CJK font.
 */
function renderFullwidthTable(header, aligns, rows, { maxRows, maxChars }) {
  const headerCells = header.map((cell) => toFullwidth(plainCellText(cell)))
  const columns = headerCells.length
  const shown = rows
    .slice(0, maxRows)
    .map((row) => headerCells.map((_, i) => toFullwidth(plainCellText(row[i] ?? ''))))
  const widths = columnWidths([headerCells, ...shown], columns, maxChars)
  if (!widths) return null

  const rule = () => '＋' + widths.map((width) => '－'.repeat(width)).join('＋') + '＋'
  const lines = [rule()]

  const pushRow = (cells) => {
    const wrapped = cells.map((cell, i) => wrapFullwidth(cell, widths[i]))
    const height = Math.max(...wrapped.map((cell) => cell.length), 1)
    for (let line = 0; line < height; line += 1) {
      const parts = wrapped.map((cellLines, i) =>
        padFullwidth(cellLines[line] ?? '', widths[i], aligns[i]),
      )
      lines.push(`｜${parts.join('｜')}｜`)
    }
  }

  pushRow(headerCells)
  lines.push(rule())
  for (const row of shown) pushRow(row)
  lines.push(rule())

  const block = ['```text', ...lines, '```'].join('\n')
  const clipped = rows.length > maxRows ? `\n… 另有 ${rows.length - maxRows} 行` : ''
  return `${block}${clipped}`
}

/**
 * Fallback for a table that cannot be drawn inside `maxChars`: raw `|` rows
 * with a bolded header, which survive every client even without alignment.
 */
function renderRecordTable(header, rows, maxRows) {
  const lines = []
  const headerCells = header.map((cell) => plainCellText(cell))
  if (headerCells.some(Boolean)) {
    lines.push(headerCells.map((cell) => (cell ? `**${cell}**` : '')).join(' | '))
  }
  const escape = (cell) => plainCellText(cell).replace(/\|/g, '\\|')
  for (const row of rows.slice(0, maxRows)) {
    lines.push(headerCells.map((_, i) => escape(row[i] ?? '')).join(' | '))
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
