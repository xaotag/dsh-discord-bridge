/**
 * Markdown → Discord embed adapter.
 *
 * Discord's embed `description` renders only a small subset of Markdown:
 * bold / italic / underline / strikethrough, inline code, fenced code blocks,
 * block quotes, and bare links. It does NOT render:
 *
 *   - ATX headings (`#`, `##`, ...) — shown as literal "#" text
 *     (see https://github.com/discord/discord-api-docs/issues/7167)
 *   - tables — shown as raw pipes
 *   - nested / ordered list indentation
 *
 * Ordinary message `content` *does* render headings. So instead of dropping
 * the structure we downgrade it into something an embed renders correctly:
 * headings become bold lines, tables become aligned fenced blocks, and task
 * lists become checkbox glyphs.
 *
 * Fenced code blocks are protected first: their content is never rewritten.
 */

const FENCE = '```'

/**
 * Rewrite GitHub-flavoured Markdown for a Text Display (Components V2).
 *
 * A Text Display renders the full Markdown rules, so headings, nested lists and
 * emphasis all survive untouched. Only the constructs Discord still lacks are
 * converted — tables, since no Discord surface has table syntax.
 */
export function adaptMarkdownForTextDisplay(text) {
  const source = String(text ?? '')
  if (!source) return ''
  return mapOutsideCode(source, (segment) => convertTables(segment))
}

/**
 * Rewrite GitHub-flavoured Markdown so it renders acceptably inside an embed
 * description. Never touches text inside fenced code blocks.
 */
export function adaptMarkdownForEmbed(text) {
  const source = String(text ?? '')
  if (!source) return ''
  const converted = mapOutsideCode(source, (segment) => {
    let out = segment
    out = convertTables(out)
    out = convertTaskLists(out)
    out = downgradeHeadings(out)
    out = flattenDeepNesting(out)
    return out
  })
  return wrapLongCodeLines(converted)
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
 * Lay a table out as records inside a fenced block.
 *
 * Each row is a bold first cell followed by `key：value` lines. Nothing is
 * padded, so mixed CJK/Latin content cannot drift: Discord's monospace font
 * does not give CJK glyphs exactly two ASCII cells, which is what made
 * space-padded columns misalign. The whole thing sits in a fence so it reads as
 * a distinct block rather than ordinary prose.
 */
function renderRecordTable(header, rows, maxRows) {
  const visible = rows.slice(0, maxRows)
  const lines = []
  visible.forEach((row, rowIndex) => {
    if (rowIndex > 0) lines.push('')
    const [first, ...rest] = row
    const title = String(first ?? '').trim()
    lines.push(title || '（未命名）')
    rest.forEach((cell, index) => {
      const value = String(cell ?? '').trim()
      if (!value) return
      const label = String(header[index + 1] ?? '').trim()
      lines.push(label ? `  ${label}：${value}` : `  ${value}`)
    })
  })
  if (rows.length > maxRows) {
    if (lines.length) lines.push('')
    lines.push(`… 另有 ${rows.length - maxRows} 行`)
  }
  return `${FENCE}text\n${lines.join('\n')}\n${FENCE}`
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
