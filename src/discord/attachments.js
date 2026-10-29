import { wrapUntrusted } from '../bridge/untrusted.js'

const MAX_TEXT_ATTACHMENT_BYTES = 512 * 1024
const MAX_TEXT_ATTACHMENTS_TOTAL = 1024 * 1024
/** Discord's own ceiling for a normal account is 10 MiB per file. */
const MAX_IMAGE_ATTACHMENT_BYTES = 10 * 1024 * 1024
/** One turn accepts at most this many images; more bloats every later request. */
const MAX_IMAGES_PER_MESSAGE = 4

const TEXT_EXTENSION =
  /\.(?:txt|md|markdown|json|jsonl|ya?ml|toml|xml|csv|tsv|log|js|jsx|mjs|cjs|ts|tsx|css|scss|html|py|go|rs|java|kt|c|cc|cpp|h|hpp|cs|php|rb|sh|ps1|sql|graphql|vue|svelte)$/i

/** Media types the attachment service can normalize; anything else is refused. */
const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const EXTENSION_MEDIA_TYPES = new Map([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['webp', 'image/webp'],
  ['gif', 'image/gif'],
])

/** True for text/code attachments, which are read and wrapped as untrusted input. */
export function isTextAttachment(attachment) {
  const type = String(attachment?.contentType || '').toLowerCase()
  const name = String(attachment?.name || '')
  return (
    type.startsWith('text/') ||
    /^(application\/(json|xml|javascript|x-yaml))$/.test(type) ||
    TEXT_EXTENSION.test(name)
  )
}

/**
 * Declared media type for an image attachment, or undefined when it is not one.
 *
 * Discord reports a contentType for most uploads; the extension is the fallback
 * for clients that omit it. Bytes are still validated by the attachment service
 * before anything is stored, so a lying header cannot smuggle a wrong type in.
 */
export function imageMediaType(attachment) {
  const declared = String(attachment?.contentType || '')
    .toLowerCase()
    .split(';')[0]
    .trim()
  if (IMAGE_MEDIA_TYPES.has(declared)) return declared
  const match = /\.([a-z0-9]+)$/i.exec(String(attachment?.name || ''))
  const byExtension = match ? EXTENSION_MEDIA_TYPES.get(match[1].toLowerCase()) : undefined
  return byExtension
}

/**
 * Split a message's attachments into the three destinations the bridge has:
 * text (read into the prompt), images (stored and attached to the user
 * message), and everything else (refused with a clear error).
 */
export function splitAttachments(attachments) {
  const text = []
  const images = []
  const unsupported = []
  for (const attachment of attachments || []) {
    if (imageMediaType(attachment)) images.push(attachment)
    else if (isTextAttachment(attachment)) text.push(attachment)
    else unsupported.push(attachment)
  }
  return { text, images, unsupported }
}

/** Download and validate text/code attachments, wrapping each as untrusted input. */
export async function readTextAttachments(attachments) {
  if (!attachments?.length) return ''
  let total = 0
  const parts = []
  for (const attachment of attachments) {
    const name = attachment.name || 'attachment'
    if (!isTextAttachment(attachment)) {
      throw new Error(`暂不支持二进制附件：${name}（仅支持文本/代码附件与图片）`)
    }
    if (attachment.size > MAX_TEXT_ATTACHMENT_BYTES) throw new Error(`附件过大：${name}`)
    total += attachment.size
    if (total > MAX_TEXT_ATTACHMENTS_TOTAL) throw new Error('文本附件总大小超过 1 MiB')
    const response = await fetch(attachment.url)
    if (!response.ok) throw new Error(`无法下载附件：${name}`)
    const buffer = new Uint8Array(await response.arrayBuffer())
    if (buffer.byteLength !== attachment.size) throw new Error(`附件大小不一致：${name}`)
    let decoded
    try {
      decoded = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    } catch {
      throw new Error(`附件不是有效 UTF-8 文本：${name}`)
    }
    parts.push(wrapUntrusted(decoded, `discord-attachment:${name}`))
  }
  return parts.join('\n\n')
}

/**
 * Download image attachments and store them through the attachment service.
 *
 * The service owns validation and normalization (magic bytes, EXIF, scaling),
 * so the bridge only checks the cheap things first: count, declared type and
 * byte length. The returned references go into the user message as `image`
 * blocks; a text-only route projects them to a placeholder on its own.
 */
export async function readImageAttachments(attachments, { store, fetchImpl = fetch } = {}) {
  if (!attachments?.length) return []
  if (typeof store?.saveImage !== 'function') {
    throw new Error('当前部署没有挂载附件服务（ctx.attachments），无法接收图片')
  }
  if (attachments.length > MAX_IMAGES_PER_MESSAGE) {
    throw new Error(`一次最多发送 ${MAX_IMAGES_PER_MESSAGE} 张图片`)
  }

  const refs = []
  for (const attachment of attachments) {
    const name = attachment.name || 'image'
    const mediaType = imageMediaType(attachment)
    if (!mediaType) throw new Error(`不支持的图片格式：${name}（支持 png/jpeg/webp/gif）`)
    if (attachment.size > MAX_IMAGE_ATTACHMENT_BYTES) throw new Error(`图片过大：${name}`)

    const response = await fetchImpl(attachment.url)
    if (!response.ok) throw new Error(`无法下载图片：${name}`)
    const data = new Uint8Array(await response.arrayBuffer())
    if (data.byteLength !== attachment.size) throw new Error(`图片大小不一致：${name}`)

    refs.push(await store.saveImage({ data, mediaType, name }))
  }
  return refs
}
