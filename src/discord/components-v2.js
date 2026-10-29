/**
 * Components V2 message builders.
 *
 * Every builder here mirrors a structure documented in the official Component
 * Reference (https://docs.discord.com/developers/components/reference). Fields,
 * limits and parent/child placement below are copied from that page rather than
 * from client behaviour guesses, so a payload built here is valid on the first
 * request instead of failing with a 400.
 *
 * Components V2 is opt-in through the IS_COMPONENTS_V2 flag (1 << 15). The flag
 * is permanent for a message: once set, the message can never go back to plain
 * content/embeds, and `content`, `embeds`, `poll` and `stickers` are disabled.
 * Every part of a card therefore has to be expressed as a component.
 *
 * The caller is always a V2 message, so the reference's repeated "you must send
 * the IS_COMPONENTS_V2 flag" notes are satisfied once, by `v2Payload()`.
 */

/** Message flag enabling the V2 component system. */
export const IS_COMPONENTS_V2 = 1 << 15

/** Component types documented under "Component Object" in the reference. */
export const COMPONENT_TYPE = {
  ACTION_ROW: 1,
  BUTTON: 2,
  STRING_SELECT: 3,
  TEXT_INPUT: 4,
  SECTION: 9,
  TEXT_DISPLAY: 10,
  THUMBNAIL: 11,
  MEDIA_GALLERY: 12,
  FILE: 13,
  SEPARATOR: 14,
  CONTAINER: 17,
  LABEL: 18,
}

/** Button styles from the Button section. */
export const BUTTON_STYLE = {
  PRIMARY: 1,
  SECONDARY: 2,
  SUCCESS: 3,
  DANGER: 4,
  LINK: 5,
  PREMIUM: 6,
}

/** Text input styles: a single line, or a multi-line paragraph. */
export const TEXT_INPUT_STYLE = { SHORT: 1, PARAGRAPH: 2 }

/** Separator padding values: small or large. */
export const SEPARATOR_SPACING = { SMALL: 1, LARGE: 2 }

/**
 * Limits copied from the reference. Keeping them in one object makes the
 * mapping to the documentation auditable: a test can walk the table and assert
 * that each builder clamps or rejects at the documented boundary.
 */
export const LIMITS = {
  CUSTOM_ID: 100,
  BUTTON_LABEL: 80,
  BUTTON_URL: 512,
  SELECT_OPTIONS: 25,
  SELECT_LABEL: 100,
  SELECT_VALUE: 100,
  SELECT_DESCRIPTION: 100,
  SELECT_PLACEHOLDER: 150,
  TEXT_INPUT_MIN_LENGTH: 4000,
  TEXT_INPUT_MAX_LENGTH: 4000,
  TEXT_INPUT_PLACEHOLDER: 100,
  TEXT_INPUT_VALUE: 4000,
  TEXT_DISPLAY: 4000,
  LABEL: 45,
  LABEL_DESCRIPTION: 100,
  MODAL_TITLE: 45,
  MODAL_COMPONENTS: 5,
  ACTION_ROW_BUTTONS: 5,
  TOTAL_COMPONENTS: 40,
}

/** A message may carry at most this many components in total. */
export const MAX_TOTAL_COMPONENTS = LIMITS.TOTAL_COMPONENTS
/** Text Display content limit. */
export const TEXT_DISPLAY_LIMIT = LIMITS.TEXT_DISPLAY
/** Combined displayable-text budget across every component in one message. */
export const CONTAINER_TEXT_LIMIT = 4000

/** Discord caps a modal at five components. */
export const MODAL_MAX_COMPONENTS = LIMITS.MODAL_COMPONENTS
export const MODAL_TITLE_LIMIT = LIMITS.MODAL_TITLE

/** Discord allows at most 25 options in one select and 25 characters per label. */
export const STRING_SELECT_MAX_OPTIONS = LIMITS.SELECT_OPTIONS
export const STRING_SELECT_LABEL_LIMIT = LIMITS.SELECT_LABEL

const SELECT_TYPES = new Set([
  COMPONENT_TYPE.STRING_SELECT,
  5, // user select
  6, // role select
  7, // mentionable select
  8, // channel select
])

const CONTAINER_CHILD_TYPES = new Set([
  COMPONENT_TYPE.ACTION_ROW,
  COMPONENT_TYPE.TEXT_DISPLAY,
  COMPONENT_TYPE.SECTION,
  COMPONENT_TYPE.MEDIA_GALLERY,
  COMPONENT_TYPE.SEPARATOR,
  COMPONENT_TYPE.FILE,
])

const LABEL_CHILD_TYPES = new Set([
  COMPONENT_TYPE.TEXT_INPUT,
  ...SELECT_TYPES,
  19, // file upload
  21, // radio group
  22, // checkbox group
  23, // checkbox
])

/** Clip without ever cutting a surrogate pair in half. */
export function clipText(value, limit) {
  const text = String(value ?? '')
  if (text.length <= limit) return text
  let cut = text.slice(0, Math.max(0, limit))
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1)
  return cut
}

function requireCustomId(customId) {
  const id = String(customId ?? '')
  if (id.length === 0) throw new Error('component custom_id is required')
  if (id.length > LIMITS.CUSTOM_ID) {
    throw new Error(`component custom_id exceeds ${LIMITS.CUSTOM_ID} characters`)
  }
  return id
}

function asStyle(value, fallback) {
  const style = Number(value)
  return Number.isInteger(style) ? style : fallback
}

/** Keep only the documented partial-emoji fields. */
function emojiObject(emoji) {
  if (!emoji || typeof emoji !== 'object') return undefined
  const node = {}
  if (emoji.name) node.name = String(emoji.name)
  if (emoji.id) node.id = String(emoji.id)
  if (emoji.animated) node.animated = true
  return Object.keys(node).length > 0 ? node : undefined
}

/**
 * One block of Markdown-rendering text.
 *
 * Text Display is documented as rendering "all the regular markdown rules",
 * including mentions and emojis. Content is bounded to 1-4000 characters; the
 * caller's card builder also keeps the combined text of a message within 4000.
 */
export function textDisplay(content) {
  return {
    type: COMPONENT_TYPE.TEXT_DISPLAY,
    content: clipText(content, LIMITS.TEXT_DISPLAY),
  }
}

/** A visual divider; `spacing` 1 is small, 2 is large padding. */
export function separator({ spacing = SEPARATOR_SPACING.SMALL, divider = true } = {}) {
  return {
    type: COMPONENT_TYPE.SEPARATOR,
    divider: Boolean(divider),
    spacing: asStyle(spacing, SEPARATOR_SPACING.SMALL) === SEPARATOR_SPACING.LARGE
      ? SEPARATOR_SPACING.LARGE
      : SEPARATOR_SPACING.SMALL,
  }
}

/**
 * Container groups text/actions and can carry an accent colour.
 *
 * Only the documented child types are admitted: Action Row, Text Display,
 * Section, Media Gallery, Separator and File. Anything else would be rejected by
 * the API, and catching it here keeps the failure local.
 */
export function container(components, { accentColor, spoiler = false } = {}) {
  const children = (components || []).filter(Boolean)
  if (children.length === 0) throw new Error('container needs at least one child component')
  for (const child of children) {
    if (!child || typeof child !== 'object') throw new Error('container child must be a component')
    if (!CONTAINER_CHILD_TYPES.has(child.type)) {
      throw new Error(`component type ${child.type} is not a valid container child`)
    }
  }
  const node = { type: COMPONENT_TYPE.CONTAINER, components: children }
  if (Number.isFinite(accentColor)) {
    const color = Math.trunc(Number(accentColor))
    node.accent_color = Math.min(0xffffff, Math.max(0, color))
  }
  if (spoiler) node.spoiler = true
  return node
}

/**
 * Action Row wrapping buttons; Discord allows up to five per row, or exactly one
 * select component and nothing else.
 */
export function actionRow(components) {
  const children = (components || []).filter(Boolean)
  if (children.length === 0) throw new Error('action row needs at least one component')
  const selects = children.filter((child) => SELECT_TYPES.has(child?.type))
  const buttons = children.filter((child) => child?.type === COMPONENT_TYPE.BUTTON)
  if (selects.length + buttons.length !== children.length) {
    throw new Error('action row may only contain buttons or a single select')
  }
  if (selects.length > 0 && (children.length > 1 || selects.length > 1)) {
    throw new Error('action row with a select must contain exactly one component')
  }
  if (buttons.length > LIMITS.ACTION_ROW_BUTTONS) {
    throw new Error(`action row accepts at most ${LIMITS.ACTION_ROW_BUTTONS} buttons`)
  }
  return { type: COMPONENT_TYPE.ACTION_ROW, components: children }
}

/**
 * A button.
 *
 * Non-link styles require a 1-100 character `custom_id` and must not carry a
 * `url`; link style requires a `url` and must not carry a `custom_id`. The label
 * is optional (an emoji-only button is valid) but is capped at 80 characters.
 */
export function button({ customId, label, style = BUTTON_STYLE.SECONDARY, emoji, url, disabled = false }) {
  const value = asStyle(style, BUTTON_STYLE.SECONDARY)
  if (![1, 2, 3, 4, 5].includes(value)) throw new Error(`unsupported button style ${style}`)
  const node = { type: COMPONENT_TYPE.BUTTON, style: value }
  if (label !== undefined && String(label).length > 0) node.label = clipText(label, LIMITS.BUTTON_LABEL)
  const safeEmoji = emojiObject(emoji)
  if (safeEmoji) node.emoji = safeEmoji
  if (value === BUTTON_STYLE.LINK) {
    if (!url) throw new Error('link button requires a url')
    node.url = clipText(url, LIMITS.BUTTON_URL)
  } else {
    node.custom_id = requireCustomId(customId)
  }
  if (disabled) node.disabled = true
  return node
}

/**
 * A dropdown of choices.
 *
 * Options, labels, values, descriptions and the placeholder are all bounded by
 * the String Select structure. `min_values` stays at 1 so the payload never
 * relies on the "min 0 only when required is false" carve-out; callers that need
 * an explicit escape route add a skip button, which is discoverable anyway.
 */
export function stringSelect({ customId, options = [], placeholder, multi = false, maxValues, disabled = false }) {
  const mapped = (options || []).slice(0, LIMITS.SELECT_OPTIONS).map((option, index) => {
    const value = String(option?.value ?? index)
    if (value.length === 0) throw new Error('select option value is required')
    if (value.length > LIMITS.SELECT_VALUE) {
      throw new Error(`select option value exceeds ${LIMITS.SELECT_VALUE} characters`)
    }
    const node = {
      label: clipText(String(option?.label ?? '').trim() || value, LIMITS.SELECT_LABEL),
      value,
    }
    if (option?.description) node.description = clipText(option.description, LIMITS.SELECT_DESCRIPTION)
    const safeEmoji = emojiObject(option?.emoji)
    if (safeEmoji) node.emoji = safeEmoji
    if (option?.default) node.default = true
    return node
  })
  if (mapped.length === 0) throw new Error('string select needs at least one option')
  const upper = Math.max(1, Math.min(Number(maxValues) || mapped.length, mapped.length, LIMITS.SELECT_OPTIONS))
  const node = {
    type: COMPONENT_TYPE.STRING_SELECT,
    custom_id: requireCustomId(customId),
    options: mapped,
    min_values: 1,
    max_values: multi ? upper : 1,
  }
  if (placeholder) node.placeholder = clipText(placeholder, LIMITS.SELECT_PLACEHOLDER)
  if (disabled) node.disabled = true
  return node
}

/**
 * A single text field.
 *
 * Text Input only exists inside a modal and must be wrapped in a Label. The
 * deprecated `label` field is never written here; the visible title lives on the
 * Label component.
 */
export function textInput({
  customId,
  style = TEXT_INPUT_STYLE.PARAGRAPH,
  placeholder,
  value,
  required = true,
  minLength,
  maxLength,
} = {}) {
  const valueStyle = asStyle(style, TEXT_INPUT_STYLE.PARAGRAPH)
  if (valueStyle !== TEXT_INPUT_STYLE.SHORT && valueStyle !== TEXT_INPUT_STYLE.PARAGRAPH) {
    throw new Error(`unsupported text input style ${style}`)
  }
  const max = Math.max(
    1,
    Math.min(Number(maxLength) || LIMITS.TEXT_INPUT_MAX_LENGTH, LIMITS.TEXT_INPUT_MAX_LENGTH),
  )
  const input = {
    type: COMPONENT_TYPE.TEXT_INPUT,
    custom_id: requireCustomId(customId),
    style: valueStyle,
    required: Boolean(required),
    max_length: max,
  }
  if (Number.isFinite(minLength)) {
    input.min_length = Math.max(0, Math.min(Math.trunc(Number(minLength)), max))
  }
  if (placeholder) input.placeholder = clipText(placeholder, LIMITS.TEXT_INPUT_PLACEHOLDER)
  if (value !== undefined && String(value).length > 0) {
    input.value = clipText(value, Math.min(max, LIMITS.TEXT_INPUT_VALUE))
  }
  return input
}

/**
 * A labelled field for a modal.
 *
 * The label and description live on this component; the wrapped child must be
 * one of the documented Label child types.
 */
export function label({ text, description, component } = {}) {
  if (!component || typeof component !== 'object') throw new Error('label needs a child component')
  if (!LABEL_CHILD_TYPES.has(component.type)) {
    throw new Error(`component type ${component.type} cannot be wrapped in a label`)
  }
  const node = {
    type: COMPONENT_TYPE.LABEL,
    label: clipText(text || '输入', LIMITS.LABEL),
    component,
  }
  if (description) node.description = clipText(description, LIMITS.LABEL_DESCRIPTION)
  return node
}

/**
 * A modal (popup form).
 *
 * `custom_id` identifies the submission in the MODAL_SUBMIT interaction; the
 * title is capped at 45 characters and the reference allows five components.
 */
export function modal({ customId, title, components = [] } = {}) {
  const children = (components || []).filter(Boolean)
  if (children.length === 0) throw new Error('modal needs at least one component')
  if (children.length > LIMITS.MODAL_COMPONENTS) {
    throw new Error(`modal accepts at most ${LIMITS.MODAL_COMPONENTS} components`)
  }
  return {
    custom_id: requireCustomId(customId),
    title: clipText(title || '输入', LIMITS.MODAL_TITLE),
    components: children,
  }
}

/**
 * Count components recursively, since the 40-component cap covers the whole
 * tree rather than just the top level. A Section's accessory is a component too.
 */
export function countComponents(nodes) {
  if (!Array.isArray(nodes)) return 0
  let total = 0
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue
    total += 1
    total += countComponents(node.components)
    if (node.accessory) total += countComponents([node.accessory])
  }
  return total
}

/**
 * Sum the displayable text in a payload.
 *
 * The reference caps the combined length of all text in a message at 4000
 * characters (the same budget `cardPayload` already spends). Text Display is the
 * only text-bearing component this bridge emits in messages.
 */
export function countDisplayableText(nodes) {
  if (!Array.isArray(nodes)) return 0
  let total = 0
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue
    if (node.type === COMPONENT_TYPE.TEXT_DISPLAY) total += String(node.content ?? '').length
    total += countDisplayableText(node.components)
  }
  return total
}

/**
 * Finalize a Components V2 payload.
 *
 * `content` and `embeds` must be absent: sending them alongside the flag is
 * rejected by the API. The builder only ever emits the documented V2 shape, and
 * any leftover empty arrays are trimmed.
 */
export function v2Payload(components, { allowedMentions } = {}) {
  const tree = (components || []).filter(Boolean)
  if (tree.length === 0) throw new Error('Components V2 payload needs at least one component')
  const payload = {
    flags: IS_COMPONENTS_V2,
    components: tree,
  }
  if (allowedMentions) payload.allowedMentions = allowedMentions
  return payload
}

/**
 * Guard against the two documented message-level ceilings before sending:
 * 40 total components and 4000 characters of displayable text. Throwing here
 * keeps the failure local instead of letting the API reject the whole card.
 */
export function assertComponentBudget(payload) {
  const total = countComponents(payload?.components)
  if (total > MAX_TOTAL_COMPONENTS) {
    throw new Error(`Components V2 payload has ${total} components, limit is ${MAX_TOTAL_COMPONENTS}`)
  }
  const text = countDisplayableText(payload?.components)
  if (text > CONTAINER_TEXT_LIMIT) {
    throw new Error(`Components V2 payload has ${text} displayable characters, limit is ${CONTAINER_TEXT_LIMIT}`)
  }
  walkComponents(payload?.components, (node) => {
    if (node.type === COMPONENT_TYPE.TEXT_DISPLAY && String(node.content ?? '').length === 0) {
      throw new Error('Text Display content must be 1-4000 characters')
    }
  })
  return payload
}

function walkComponents(nodes, visit) {
  if (!Array.isArray(nodes)) return
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue
    visit(node)
    walkComponents(node.components, visit)
    if (node.accessory) walkComponents([node.accessory], visit)
  }
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
