import { adaptMarkdownForEmbed } from './markdown.js'

export const DISCORD_CONTENT_LIMIT = 2000
export const DISCORD_SAFE_LIMIT = 1850

/** Discord Embed hard limits (https://discord.com/developers/docs/resources/message#embed-object). */
export const EMBED_TITLE_LIMIT = 256
export const EMBED_DESCRIPTION_LIMIT = 4096
export const EMBED_FOOTER_LIMIT = 2048
export const EMBED_AUTHOR_NAME_LIMIT = 256
export const EMBED_FIELD_NAME_LIMIT = 256
export const EMBED_FIELD_VALUE_LIMIT = 1024
export const EMBED_FIELD_COUNT_LIMIT = 25
export const EMBED_TOTAL_LIMIT = 6000
/** Leave headroom for the CLI hints appended around the model output. */
export const EMBED_DESCRIPTION_SAFE_LIMIT = 3800

/** No answer / tool card ever sends more than this many embeds per message. */
export const MAX_CARD_EMBEDS = 10
/**
 * @deprecated The tool run is now a single list embed, sized by
 * TOOL_LIST_MAX_LINES, so a per-call card cap no longer applies.
 */
export const MAX_TOOL_CARDS = 6

export const EMBED_COLORS = {
  thinking: 0x5865f2,
  working: 0xfaa61a,
  completed: 0x57f287,
  cancelled: 0x99aab5,
  failed: 0xed4245,
  notice: 0x5865f2,
}

/** Neutralize all Discord mention syntax in Agent-controlled text. */
export function suppressMentions(text) {
  return String(text || '')
    .replaceAll('@everyone', '@\u200beveryone')
    .replaceAll('@here', '@\u200bhere')
    .replace(/<@([!&]?\d+)>/g, '<@\u200b$1>')
}

/** Split arbitrary DSH text into Discord-safe chunks without splitting surrogate pairs. */
export function chunkDiscordText(text, limit = DISCORD_SAFE_LIMIT) {
  const safe = suppressMentions(text)
  if (safe.length === 0) return ['']
  const chunks = []
  let rest = safe
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit)
    if (cut < Math.floor(limit * 0.4)) cut = limit
    let part = rest.slice(0, cut)
    if (/[\uD800-\uDBFF]$/.test(part)) part = part.slice(0, -1)
    chunks.push(part.trimEnd())
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest.length > 0) chunks.push(rest)
  return chunks.length ? chunks : ['']
}

export function boundedText(text, limit = DISCORD_SAFE_LIMIT) {
  const safe = suppressMentions(text)
  if (safe.length <= limit) return safe
  let prefix = safe.slice(0, Math.max(0, limit - 1))
  if (/[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1)
  return `${prefix.trimEnd()}…`
}

function clipOneLine(text, limit) {
  const flat = String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
  if (flat.length <= limit) return flat
  let prefix = flat.slice(0, Math.max(0, limit - 1))
  if (/[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1)
  return `${prefix}…`
}

/** "1500" -> "1.5s", "950" -> "950ms". */
export function formatDuration(ms) {
  const value = Number(ms)
  if (!Number.isFinite(value) || value < 0) return ''
  if (value < 1000) return `${Math.round(value)}ms`
  if (value < 60_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}s`
  const minutes = Math.floor(value / 60_000)
  const seconds = Math.round((value % 60_000) / 1000)
  return seconds ? `${minutes}m${seconds}s` : `${minutes}m`
}

/**
 * Build an embed without ever exceeding Discord's per-embed limits: one embed
 * description carries up to EMBED_DESCRIPTION_SAFE_LIMIT characters, and the
 * long text is split across `parts` embeds (`(1/3)` in the footer) so a caller
 * can send them as separate messages.
 */
export function buildEmbed({
  color = EMBED_COLORS.working,
  title,
  description = '',
  url,
  authorName,
  footer,
  timestamp = true,
  emptyText = '（无内容）',
  maxEmbeds = 4,
} = {}) {
  // Adapt Markdown before chunking so headings/tables are converted while the
  // document is still whole; a table split across two embeds renders as garbage.
  const adapted = adaptMarkdownForEmbed(description)
  const cleanDescription = suppressMentions(adapted).trim()
  const chunks = cleanDescription ? chunkDiscordText(cleanDescription, EMBED_DESCRIPTION_SAFE_LIMIT) : [emptyText]
  const parts = chunks.length
  const limit = Math.max(1, Math.floor(maxEmbeds))
  const sliced = chunks.slice(0, limit)
  if (chunks.length > limit) {
    // Keep the truncation note inside the per-embed description budget.
    const last = sliced.length - 1
    const note = '\n\n…（后续内容已省略）'
    sliced[last] = `${sliced[last].slice(0, EMBED_DESCRIPTION_LIMIT - note.length)}…${note}`
  }
  const baseFooter = clipOneLine(suppressMentions(footer || ''), EMBED_FOOTER_LIMIT - 16)
  return sliced.map((chunk, index) => {
    const suffix = parts > 1 ? `${index + 1}/${parts}` : ''
    const footerText = [baseFooter, suffix].filter(Boolean).join(' · ')
    const embed = { color, description: chunk }
    const safeTitle = clipOneLine(suppressMentions(title || ''), EMBED_TITLE_LIMIT)
    if (safeTitle) embed.title = safeTitle
    if (url) embed.url = String(url)
    const safeAuthor = clipOneLine(suppressMentions(authorName || ''), EMBED_AUTHOR_NAME_LIMIT)
    if (safeAuthor) embed.author = { name: safeAuthor }
    if (footerText) embed.footer = { text: clipOneLine(footerText, EMBED_FOOTER_LIMIT) }
    if (timestamp) embed.timestamp = new Date().toISOString()
    return embed
  })
}

function toPayload(embeds, content) {
  const payload = {
    embeds,
    // Discord keeps the components of an edited message unless the edit sends
    // an explicit empty array, so every card without buttons must say so.
    components: [],
    allowedMentions: { parse: [], repliedUser: false },
  }
  const safeContent = content ? boundedText(content) : ''
  if (safeContent) payload.content = safeContent
  return payload
}

export function placeholderPayload(text = '⏳ 已接收，正在处理…') {
  return toPayload(buildEmbed({ color: EMBED_COLORS.thinking, description: text }))
}

/** Arguments longer than this collapse to a one-line summary. */
export const TOOL_ARGS_INLINE_LIMIT = 80
export const TOOL_ARGS_SUMMARY_LIMIT = 60

/**
 * Turn a raw tool-argument blob into a single readable line.
 *
 * A bash command or file body can be thousands of characters; printing it in
 * full turns one turn into a wall of text. The card keeps the tool name plus a
 * compact hint: the most descriptive field, or a truncated preview.
 */
export function summarizeToolArgs(args) {
  const raw = String(args ?? '').trim()
  if (!raw || raw === '{}') return ''
  if (raw.length <= TOOL_ARGS_INLINE_LIMIT) return raw.replace(/\s+/g, ' ')
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return clipOneLine(raw, TOOL_ARGS_SUMMARY_LIMIT)
  }
  const record = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
  if (record) {
    // Prefer the field that names what the call actually does.
    for (const key of ['description', 'command', 'path', 'file_path', 'pattern', 'query', 'prompt']) {
      const value = record[key]
      if (typeof value === 'string' && value.trim()) {
        return clipOneLine(value, TOOL_ARGS_SUMMARY_LIMIT)
      }
    }
    const keys = Object.keys(record)
    return keys.length ? clipOneLine(keys.join(', '), TOOL_ARGS_SUMMARY_LIMIT) : ''
  }
  return clipOneLine(raw, TOOL_ARGS_SUMMARY_LIMIT)
}

/**
 * A single tool-call card, kept in the transcript after the call finishes.
 *
 * Arguments are folded into one line by default so a long agent turn stays
 * readable on a phone; pass showArgs: 'full' to print them verbatim.
 */
export function toolEmbed({ name, args, startedAt, endedAt, showArgs = 'summary' } = {}) {
  const meta = []
  if (startedAt) {
    const clock = new Date(startedAt).toLocaleTimeString('zh-CN', { hour12: false })
    meta.push(`开始 ${clock}`)
  }
  if (startedAt && endedAt) {
    const took = formatDuration(endedAt - startedAt)
    if (took) meta.push(`用时 ${took}`)
  }
  const summary = summarizeToolArgs(args)
  const label = clipOneLine(name, 120) || 'unknown'
  let description
  if (showArgs === 'full') {
    description = [
      `💰 **工具**：\`${label}\``,
      `**参数**：\`${clipOneLine(args || '{}', 900) || '{}'}\``,
    ].join('\n')
  } else {
    description = summary
      ? `💰 **${label}** · \`${summary}\``
      : `💰 **${label}**`
  }
  return {
    color: EMBED_COLORS.working,
    title: '🛠 工具调用',
    description,
    ...(meta.length ? { footer: { text: meta.join(' · ') } } : {}),
  }
}

/** One tool name per line, newest last; a running call is marked with its glyph. */
export const TOOL_LIST_MAX_LINES = 24

function toolListLine(tool, index) {
  const name = clipOneLine(tool?.name, 64) || 'unknown'
  const running = tool?.endedAt === undefined
  const glyph = running ? '⟳' : '✓'
  return `${glyph} \`${name}\``
}

/**
 * The tool-run message: a single embed listing every call one per line.
 *
 * One card per call pushed the transcript into a column of near-identical
 * embeds; a compact list keeps the turn readable while still showing which
 * tools ran, in order, and which one is still running.
 */
export function toolCardsPayload(tools = []) {
  if (!tools.length) return toPayload([])
  const recent = tools.slice(-TOOL_LIST_MAX_LINES)
  const hidden = tools.length - recent.length
  const lines = recent.map((tool, i) => toolListLine(tool, i))
  if (hidden > 0) lines.unshift(`… 更早的 ${hidden} 次已省略`)
  const running = tools.filter((tool) => tool?.endedAt === undefined).length
  const footerBits = [`共 ${tools.length} 次`]
  if (running > 0) footerBits.push(`${running} 个运行中`)
  const description = lines.join('\n')
  return toPayload([
    {
      color: EMBED_COLORS.working,
      title: '🛠 工具调用',
      description,
      footer: { text: footerBits.join(' · ') },
    },
  ])
}

/** Message holding the aggregated assistant answer, in 1..N embeds. */
export function answerPayload(text, meta = {}) {
  const { startedAt, model, reasoningEffort, caption, title = '⏳ 正在生成…', color = EMBED_COLORS.thinking } = meta
  const body = String(text || '').trim()
  return toPayload(
    buildEmbed({
      color,
      title,
      description: [body || '（等待模型输出…）', caption ? `\n> ${suppressMentions(caption)}` : ''].join(''),
      footer: cardFooter(meta),
    }),
  )
}

/** "model (effort) · 耗时 1.5s" shared footer for the answer card. */
function cardFooter({ startedAt, model, reasoningEffort } = {}) {
  const bits = []
  if (model) bits.push(`${model}${reasoningEffort ? ` (effort:${reasoningEffort})` : ''}`)
  if (startedAt) {
    const elapsed = formatDuration(Date.now() - startedAt)
    if (elapsed) bits.push(`耗时 ${elapsed}`)
  }
  return bits.join(' · ')
}

/**
 * Legacy single-card streaming payload: the whole turn in one card (text, or
 * the tool call that is currently running). Kept for callers that do not want
 * the split layout; the bridge itself uses answerPayload + toolCardsPayload.
 */
export function streamPayload(text, { toolName, toolArgs, reasoning, startedAt, caption, model, reasoningEffort } = {}) {
  const footerBits = []
  if (model) footerBits.push(`${model}${reasoningEffort ? ` (effort:${reasoningEffort})` : ''}`)
  if (startedAt) {
    const elapsed = formatDuration(Date.now() - startedAt)
    if (elapsed) footerBits.push(`耗时 ${elapsed}`)
  }
  const title = toolName ? '🛠 正在调用工具' : '⏳ 正在生成…'
  if (toolName) {
    const args = clipOneLine(toolArgs || '{}', EMBED_DESCRIPTION_SAFE_LIMIT - 120)
    const preview = boundedText(text || '').trim()
    const description = [
      `**工具**：\`${clipOneLine(toolName, 120) || 'unknown'}\``,
      `**参数**：\`${args || '{}'}\``,
      preview ? `\n**已生成**\n${clipOneLine(preview, 300)}` : '',
      caption ? `\n> ${suppressMentions(caption)}` : '',
    ].join('\n')
    return toPayload(
      buildEmbed({ color: EMBED_COLORS.working, title, description, footer: footerBits.join(' · ') }),
    )
  }
  const body = String(text || reasoning || '').trim()
  const description = [body || '（等待模型输出…）', caption ? `\n> ${suppressMentions(caption)}` : ''].join('')
  return toPayload(
    buildEmbed({ color: EMBED_COLORS.thinking, title, description, footer: footerBits.join(' · ') }),
  )
}

export const FINAL_TITLES = {
  completed: '✅ 已完成',
  cancelled: '⏹️ 已停止',
  failed: '❌ 执行失败',
}

const FINAL_COLORS = {
  completed: EMBED_COLORS.completed,
  cancelled: EMBED_COLORS.cancelled,
  failed: EMBED_COLORS.failed,
}

/**
 * Final answer card. Returns one payload per message: the first one replaces the
 * streaming message, the rest are sent as follow-ups in order.
 */
export function finalPayloads(text, status = 'completed', meta = {}) {
  return finalEmbed(text, status, meta).map((embed) => toPayload([embed]))
}

/** Same card as finalPayloads, one embed per message. */
export function finalEmbed(text, status = 'completed', { startedAt, model, reasoningEffort, caption } = {}) {
  const kind = FINAL_TITLES[status] ? status : 'completed'
  const safe = suppressMentions(text || '').trim()
  const footerBits = []
  if (model) footerBits.push(`${model}${reasoningEffort ? ` (effort:${reasoningEffort})` : ''}`)
  if (startedAt) {
    const elapsed = formatDuration(Date.now() - startedAt)
    if (elapsed) footerBits.push(`耗时 ${elapsed}`)
  }
  const description = [safe || '（本轮没有文本输出）', caption ? `\n> ${suppressMentions(caption)}` : ''].join('')
  return buildEmbed({
    color: FINAL_COLORS[kind],
    title: FINAL_TITLES[kind],
    description,
    footer: footerBits.join(' · '),
    emptyText: '（本轮没有文本输出）',
  })
}
/** Single-payload variant kept for simple call sites. */
export function finalPayload(text, status = 'completed', meta = {}) {
  return finalPayloads(text, status, meta)[0]
}

export function notificationPayload(text, { title, color = EMBED_COLORS.notice, caption, footer } = {}) {
  const body = boundedText(text || '')
  const description = [body, caption ? `\n> ${suppressMentions(caption)}` : ''].join('')
  return toPayload(buildEmbed({ color, title, description, footer }), body)
}

/** Custom-ID scheme for the card buttons handled by index.js. */
export const STOP_BUTTON_PREFIX = 'dsh:stop:'

export function stopButton(messageId) {
  return {
    type: 1,
    components: [
      {
        type: 2,
        style: 4,
        label: '停止',
        emoji: { name: '⏹️' },
        custom_id: `${STOP_BUTTON_PREFIX}${messageId}`,
      },
    ],
  }
}

/** Attach the stop button to a single-message payload; no-op for other shapes. */
export function withStopButton(payload, messageId) {
  if (!messageId) return payload
  return { ...payload, components: [stopButton(messageId)] }
}

/** Streaming progress caption shown above the model output ("正在调用 3 个工具…"). */
export function progressCaption(activity) {
  if (!activity) return ''
  const { tools = 0, toolName, sinceLastText } = activity
  if (toolName) return `正在执行 \`${clipOneLine(toolName, 60)}\`…`
  if (tools > 0) return `已完成 ${tools} 个工具调用，正在整理结果…`
  if (sinceLastText) return `已等待 ${formatDuration(sinceLastText)}…`
  return ''
}

/**
 * Normalize any outgoing payload so Discord never rejects it:
 * embed-array payloads get their 10-embed / 6000-char budget enforced, and
 * plain content is mention-neutralized and bounded.
 */
export function normalizePayload(payload) {
  const source = payload || {}
  const result = {
    ...source,
    allowedMentions: { parse: [], repliedUser: false, ...(source.allowedMentions || {}) },
  }
  // Discord keeps an edited message's components unless the edit sends an
  // explicit empty array, so a card without buttons must always say so.
  if (!('components' in source)) result.components = []
  if (Array.isArray(source.embeds) && source.embeds.length === 0) delete result.embeds
  if (Array.isArray(source.embeds) && source.embeds.length > 0) {
    const embeds = []
    let total = 0
    for (const embed of source.embeds.slice(0, 10)) {
      const size = (embed?.title?.length || 0) + (embed?.description?.length || 0) + (embed?.footer?.text?.length || 0)
      if (total + size > EMBED_TOTAL_LIMIT) break
      total += size
      embeds.push(embed)
    }
    if (embeds.length > 0) {
      result.embeds = embeds
    } else {
      delete result.embeds
    }
  }
  if (source.content !== undefined) {
    const content = boundedText(source.content)
    if (content) result.content = content
    else delete result.content
  }
  return result
}