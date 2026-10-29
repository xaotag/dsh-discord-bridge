/**
 * Inbound Discord messages.
 *
 * Decides whether a message is addressed to the bot, then routes it to either a
 * text command or a prompt run. Mention policy, attachment handling and the
 * bare-@Bot greeting window all live here.
 */
import { authorized } from '../config.js'
import { mentionsUser, stripMentions } from '../discord/mention.js'
import { readImageAttachments, readTextAttachments, splitAttachments } from '../discord/attachments.js'
import { parseTextCommand } from '../discord/commands.js'
import { parseDeepSeekTextCommand } from '../discord/deepseek-commands.js'
import { noticeCard, placeholderCard } from '../discord/cards-v2.js'
import { conversationKeyFor, greeting, MENTION_FOLLOWUP_WINDOW_MS, safeError } from './runtime.js'
import { handleCommand } from './commands/index.js'
import { runPrompt } from './prompt-runner.js'

export async function handleMessage(runtime, message) {
  const { config, state, audit, transport, logger, pendingMentions } = runtime
  const clientUser = runtime.clientUser
  if (runtime.disposed || !clientUser || message.author?.bot) return
  if (message.author.id === clientUser.id) return
  if (!message.channelId) return

  const guildId = message.guildId || undefined
  const channelId = message.channelId
  if (!authorized(config, message.author.id, guildId, channelId)) return

  const kind = guildId === undefined ? 'dm' : message.channel?.isThread?.() ? 'thread' : 'channel'
  const parentId = message.channel?.parentId || undefined
  // A thread answers into the conversation that created it; keying on the
  // thread id would spawn a new Session for every auto-threaded prompt.
  const key = conversationKeyFor(runtime, { channelId, kind, parentId })
  // Remember where the conversation is happening: a user-questions request
  // carries no channel, and this is the card's only sensible destination.
  runtime.lastActiveChannelId = channelId
  audit.record({
    category: 'discord',
    action: 'message.received',
    status: 'ok',
    channelId,
    guildId,
    conversation: key,
    userId: message.author.id,
    detail: { kind, length: String(message.content || '').length },
  })

  const mention = mentionsUser(message.mentions, clientUser.id)
  const bound = state.hasSession(key)
  const awaiting = pendingMentions.get(key)
  const inMentionTurn =
    awaiting !== undefined &&
    awaiting.userId === message.author.id &&
    Date.now() - awaiting.at < MENTION_FOLLOWUP_WINDOW_MS
  if (kind === 'channel' && config.requireMention && !mention && !inMentionTurn) return
  if (kind === 'thread' && config.requireMention && !mention && !bound && !inMentionTurn) return

  const text = stripMentions(message.content, clientUser.id)
  const attachments = [...(message.attachments?.values?.() || [])]

  // A bare "@bot" is a greeting, not a usage error. Remember the turn so the
  // user's next message continues the same conversation naturally.
  if (!text && attachments.length === 0) {
    if (!mention) return
    if (!(await state.claimEvent(`message:${message.id}`))) return
    pendingMentions.set(key, { userId: message.author.id, at: Date.now() })
    await transport
      .send(channelId, noticeCard(greeting(message.author.username)), {
        replyToMessageId: message.id,
      })
      .catch((error) => logger.warn('发送 greeting 失败:', error?.message || String(error)))
    return
  }

  if (!(await state.claimEvent(`message:${message.id}`))) return

  const pending = pendingMentions.get(key)
  const continuesGreeting =
    pending !== undefined &&
    pending.userId === message.author.id &&
    Date.now() - pending.at < MENTION_FOLLOWUP_WINDOW_MS
  if (continuesGreeting) pendingMentions.delete(key)

  try {
    let prompt = text
    let images = []
    if (attachments.length) {
      const split = splitAttachments(attachments)
      if (split.unsupported.length) {
        const name = split.unsupported[0]?.name || 'attachment'
        throw new Error(`暂不支持该附件：${name}（支持文本/代码文件与 png/jpeg/webp/gif 图片）`)
      }
      if (split.text.length) {
        const attachmentText = await readTextAttachments(split.text)
        prompt = prompt ? `${prompt}\n\n${attachmentText}` : attachmentText
      }
      if (split.images.length) {
        images = await readImageAttachments(split.images, {
          store: runtime.ctx.get('attachments'),
        })
      }
    }
    const deepseekCommand = parseDeepSeekTextCommand(prompt)
    if (deepseekCommand) {
      await transport.send(
        channelId,
        noticeCard(
          'DeepSeek 原生 API 请使用 Slash Command：`/deepseek models list`、`/deepseek chat create` 等。',
        ),
        { replyToMessageId: message.id },
      )
      return
    }
    const command = parseTextCommand(prompt)
    if (command) {
      await handleCommand(runtime, {
        ...command,
        channelId,
        conversationKey: key,
        guildId,
        kind,
        target: channelId,
        replyToMessageId: message.id,
      })
      return
    }
    const placeholder = await transport.send(channelId, placeholderCard(), {
      replyToMessageId: message.id,
    })
    await runPrompt(runtime, {
      channelId,
      guildId,
      kind,
      prompt,
      placeholder,
      replyToMessageId: message.id,
      attachmentCount: attachments.length,
      images,
      // The resolved conversation, not the channel: an auto-created thread is
      // a presentation surface and must not take the Session with it.
      boundChannelId: key,
    })
  } catch (error) {
    logger.warn(`处理消息失败 (${channelId}):`, error?.stack || error?.message || String(error))
    audit.record({
      category: 'discord',
      action: 'message.handle',
      status: 'error',
      channelId,
      guildId,
      conversation: key,
      userId: message.author.id,
      error: error?.message || String(error),
    })
    await transport
      .send(channelId, noticeCard(`❌ 执行失败：${safeError(error)}`), {
        replyToMessageId: message.id,
      })
      .catch(() => undefined)
  }
}
