import { wrapUntrusted } from '../bridge/untrusted.js'

const MAX_TEXT_ATTACHMENT_BYTES = 512 * 1024
const MAX_TEXT_ATTACHMENTS_TOTAL = 1024 * 1024

/** Download and validate text/code attachments, wrapping each as untrusted input. */
export async function readTextAttachments(attachments) {
  if (!attachments?.length) return ''
  let total = 0
  const parts = []
  for (const attachment of attachments) {
    const name = attachment.name || 'attachment'
    const type = attachment.contentType || ''
    const textual =
      type.startsWith('text/') ||
      /^(application\/(json|xml|javascript|x-yaml))$/.test(type) ||
      /\.(?:txt|md|markdown|json|jsonl|ya?ml|toml|xml|csv|tsv|log|js|jsx|mjs|cjs|ts|tsx|css|scss|html|py|go|rs|java|kt|c|cc|cpp|h|hpp|cs|php|rb|sh|ps1|sql|graphql|vue|svelte)$/i.test(
        name,
      )
    if (!textual) throw new Error(`暂不支持二进制附件：${name}（仅支持文本/代码附件）`)
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
