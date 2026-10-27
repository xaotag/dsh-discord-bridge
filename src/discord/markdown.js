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
 * Rewrite GitHub-flavoured Markdown so it renders acceptably inside an embed
 * description. Never touches text inside fenced code blocks.
 */
export function adaptMarkdownForEmbed(text) {
  const source = String(text ?? '')
  if (!source) return ''
  return mapOutsideCode(source, (segment) => {
    let out = segment
    out = convertTables(out)
    out = convertTaskLists(out)
    out = downgradeHeadings(out)
    out = flattenDeepNesting(out)
    return out
  })
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
 * Convert a GFM pipe table into an aligned fenced code block, which is the only
 * way Discord renders columns predictably. Wide tables are clipped per column so
 * the block does not wrap badly on mobile.
 */
export function convertTables(text, { maxColumnWidth = 24, maxRows = 60 } = {}) {
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
      out.push(renderCodeTable(header, rows, { maxColumnWidth, maxRows }))
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

function renderCodeTable(header, rows, { maxColumnWidth, maxRows }) {
  const columns = Math.max(header.length, ...rows.map((r) => r.length))
  const widths = []
  for (let c = 0; c < columns; c += 1) {
    const candidates = [header[c] ?? '', ...rows.map((r) => r[c] ?? '')]
    const longest = Math.max(...candidates.map((cell) => cell.length), 1)
    widths[c] = Math.min(longest, maxColumnWidth)
  }
  const fit = (cell, width) => {
    const text = String(cell ?? '')
    return text.length <= width ? text.padEnd(width) : `${text.slice(0, Math.max(1, width - 1))}…`
  }
  const body = []
  body.push(header.map((cell, c) => fit(cell, widths[c])).join(' | ').trimEnd())
  body.push(widths.map((w) => '-'.repeat(w)).join('-+-'))
  for (const row of rows.slice(0, maxRows)) {
    body.push(row.map((cell, c) => fit(cell, widths[c])).join(' | ').trimEnd())
  }
  if (rows.length > maxRows) body.push(`… (+${rows.length - maxRows} rows)`)
  return `${FENCE}text\n${body.join('\n')}\n${FENCE}`
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
