/**
 * Components V2 message builders.
 *
 * Discord's message `content` and `embeds` only render a subset of Markdown:
 * embed descriptions drop ATX headings entirely, which is why headings used to
 * be downgraded to bold lines. Components V2 replaces them with a Text Display
 * component that renders **the full Markdown rules**, so `# Heading`, lists and
 * code blocks all work natively.
 *
 * Opting in means setting the IS_COMPONENTS_V2 flag (1 << 15). That flag is
 * permanent for the message: once sent, the message can never go back to plain
 * content/embeds. It also disables `content`, `embeds`, `poll` and `stickers`,
 * so every part of the card has to be expressed as a component.
 *
 * Reference: https://docs.discord.com/developers/components/reference
 */

/** Message flag enabling the V2 component system. */
export const IS_COMPONENTS_V2 = 1 << 15

export const COMPONENT_TYPE = {
  ACTION_ROW: 1,
  BUTTON: 2,
  STRING_SELECT: 3,
  TEXT_DISPLAY: 10,
  SEPARATOR: 14,
  CONTAINER: 17,
}

/** A message may carry at most this many components in total. */
export const MAX_TOTAL_COMPONENTS = 40
/** Text Display content limit, same as message content. */
export const TEXT_DISPLAY_LIMIT = 4000
/** Container total character budget (sum of text children). */
export const CONTAINER_TEXT_LIMIT = 4000

/**
 * One block of Markdown-rendering text.
 *
 * Unlike an embed description this accepts headings, so callers can pass
 * Markdown through without downgrading it first.
 */
export function textDisplay(content) {
  return { type: COMPONENT_TYPE.TEXT_DISPLAY, content: String(content ?? '') }
}

/** A visual divider; `spacing` 1 is small, 2 is large padding. */
export function separator({ spacing = 1, divider = true } = {}) {
  return { type: COMPONENT_TYPE.SEPARATOR, divider: Boolean(divider), spacing }
}

/** Container groups text/actions and can carry an accent colour. */
export function container(components, { accentColor, spoiler = false } = {}) {
  const node = { type: COMPONENT_TYPE.CONTAINER, components: (components || []).filter(Boolean) }
  if (Number.isFinite(accentColor)) node.accent_color = accentColor >>> 0
  if (spoiler) node.spoiler = true
  return node
}

/** Action Row wrapping buttons; Discord allows up to five per row. */
export function actionRow(components) {
  return { type: COMPONENT_TYPE.ACTION_ROW, components: (components || []).filter(Boolean) }
}

export function button({ customId, label, style = 2, emoji, disabled = false }) {
  const node = { type: COMPONENT_TYPE.BUTTON, style, custom_id: String(customId), label }
  if (emoji) node.emoji = emoji
  if (disabled) node.disabled = true
  return node
}

/** Discord allows at most 25 options in one select and 25 chars per label. */
export const STRING_SELECT_MAX_OPTIONS = 25
export const STRING_SELECT_LABEL_LIMIT = 100

/**
 * A dropdown of choices.
 *
 * Buttons cap out at five per row and turn a long question into a wall of
 * buttons; a select scales to 25 options in one control and supports
 * multi-select. Values travel as the option index so the label text never has to
 * be parsed back out of a custom_id.
 */
export function stringSelect({ customId, options = [], placeholder, multi = false, maxValues }) {
  const mapped = options.slice(0, STRING_SELECT_MAX_OPTIONS).map((option, index) => {
    const value = option?.value ?? String(index)
    const node = {
      label: String(option?.label ?? value).slice(0, STRING_SELECT_LABEL_LIMIT),
      value: String(value),
    }
    if (option?.description) node.description = String(option.description).slice(0, STRING_SELECT_LABEL_LIMIT)
    return node
  })
  const node = {
    type: COMPONENT_TYPE.STRING_SELECT,
    custom_id: String(customId),
    options: mapped,
    min_values: multi ? 0 : 1,
    max_values: multi ? Math.max(1, Math.min(maxValues ?? mapped.length, mapped.length)) : 1,
  }
  if (placeholder) node.placeholder = String(placeholder).slice(0, 150)
  return node
}

/**
 * Count components recursively, since the 40-component cap covers the whole
 * tree rather than just the top level.
 */
export function countComponents(nodes) {
  if (!Array.isArray(nodes)) return 0
  let total = 0
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue
    total += 1
    total += countComponents(node.components)
  }
  return total
}

/**
 * Finalize a Components V2 payload.
 *
 * `content` and `embeds` must be absent: sending them alongside the flag is
 * rejected by the API, and any leftover empty arrays are also trimmed so the
 * payload matches the documented shape.
 */
export function v2Payload(components, { allowedMentions } = {}) {
  const tree = (components || []).filter(Boolean)
  const payload = {
    flags: IS_COMPONENTS_V2,
    components: tree,
  }
  if (allowedMentions) payload.allowedMentions = allowedMentions
  return payload
}

/**
 * Split text into Text Display chunks that respect the per-component limit
 * without cutting surrogate pairs.
 */
export function textChunks(text, limit = TEXT_DISPLAY_LIMIT) {
  const source = String(text ?? '')
  if (source.length === 0) return ['']
  const chunks = []
  let rest = source
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit)
    if (cut < Math.floor(limit * 0.5)) cut = limit
    let part = rest.slice(0, cut)
    // Never leave half a surrogate pair behind.
    if (/[\uD800-\uDBFF]$/.test(part)) part = part.slice(0, -1)
    chunks.push(part)
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest.length > 0) chunks.push(rest)
  return chunks.length ? chunks : ['']
}
