/**
 * Every Discord interaction entering the bridge.
 *
 * Order matters: buttons and component interactions are answered synchronously
 * (they own their own acknowledgement), while a `/dsh` slash command defers
 * first because its work can exceed Discord's 3-second token.
 */
import { authorized } from '../../config.js'
import { describeInteraction, normalizeInteraction } from '../../discord/commands.js'
import { normalizeDeepSeekInteraction } from '../../discord/deepseek-commands.js'
import {
  QUESTION_CUSTOM_PREFIX,
  QUESTION_MODAL_PREFIX,
  QUESTION_SKIP_PREFIX,
  finalCard,
} from '../../discord/cards-v2.js'
import { STOP_BUTTON_PREFIX } from '../../discord/renderer.js'
import { handleCommand } from '../commands/index.js'
import { handleApprovalButton } from './approval.js'
import {
  handleQuestionCustom,
  handleQuestionModalSubmit,
  handleQuestionSelect,
  isQuestionCustomId,
} from './question.js'
import {
  handleAutocomplete,
  handleDeepSeekAutocomplete,
  handleDeepSeekInteraction,
} from './slash.js'
import { conversationKeyFor, safeError } from '../runtime.js'

/**
 * Autocomplete failures are mostly the operator's own typing.
 *
 * An expired interaction ("Unknown interaction" / 10062) means Discord threw the
 * autocomplete request away before the answer arrived — the user kept typing or
 * closed the picker. That is normal traffic, not a bridge fault, and logging it
 * at warn level buries real problems under dozens of lines.
 */
export function reportAutocompleteFailure(logger, label, error) {
  const message = error?.message || String(error)
  const status = Number(error?.httpStatus ?? error?.status ?? error?.rawError?.code)
  if (status === 10062 || /unknown interaction/i.test(message)) return
  logger.warn(`${label}失败:`, message)
}

/**
 * "停止" button on a streaming card.
 *
 * The custom_id carries the card message id; the conversation key is that same
 * channel, so the button can stop the turn without a server-side registry.
 */
async function handleStopButton(runtime, interaction, messageId) {
  const { transport, agents, audit, logger, config } = runtime
  const channelId = interaction.channelId
  const guildId = interaction.guildId || undefined
  await transport.deferButton(interaction).catch(() => undefined)
  if (!channelId || !authorized(config, interaction.user?.id, guildId, channelId)) {
    await transport.replyEphemeral(interaction, '你不在授权名单内。').catch(() => undefined)
    return
  }
  try {
    const stopped = await agents.stop(channelId)
    audit.record({
      category: 'discord',
      action: 'button.stop',
      status: stopped ? 'ok' : 'noop',
      channelId,
      guildId,
      conversation: channelId,
      userId: interaction.user?.id,
      detail: { messageId },
    })
    if (stopped) {
      await transport
        .editComponentReply(interaction, finalCard('已按你的请求停止当前任务。', 'cancelled'))
        .catch((error) => logger.warn('按钮停止后更新卡片失败:', error?.message || String(error)))
    } else {
      await transport.replyEphemeral(interaction, '当前没有运行中的任务。').catch(() => undefined)
    }
  } catch (error) {
    logger.warn('按钮停止失败:', error?.stack || error?.message || String(error))
    await transport
      .replyEphemeral(interaction, `❌ 停止失败：${safeError(error)}`)
      .catch(() => undefined)
  }
}

/** Route a button click; returns true when the interaction was consumed. */
async function handleButton(runtime, interaction) {
  const { logger } = runtime
  const customId = String(interaction?.customId || '')

  switch (classifyButton(customId)) {
    case 'question-custom':
      await handleQuestionCustom(runtime, interaction, { authorized }).catch((error) =>
        logger.warn('打开自定义输入失败:', error?.message || String(error)),
      )
      return true

    // Skip is a *button*, not a select, but it records the same "no choice"
    // answer — so it goes through the select handler. Missing this case left the
    // click unanswered until Discord reported the interaction as timed out.
    case 'question-skip':
      await handleQuestionSelect(runtime, interaction, { authorized }).catch((error) =>
        logger.warn('记录跳过失败:', error?.message || String(error)),
      )
      return true

    case 'stop':
      await handleStopButton(runtime, interaction, customId.slice(STOP_BUTTON_PREFIX.length))
      return true

    default:
      return handleApprovalButton(runtime, interaction, customId, { authorized })
  }
}

/**
 * Which handler owns a button custom_id.
 *
 * Extracted so the routing can be tested: the skip button is a plain button yet
 * belongs to the question flow, and missing that case leaves Discord waiting.
 *
 * @returns 'question-custom' | 'question-skip' | 'stop' | 'approval'
 */
export function classifyButton(customId) {
  const id = String(customId ?? '')
  if (id.startsWith(QUESTION_CUSTOM_PREFIX)) return 'question-custom'
  if (id.startsWith(QUESTION_SKIP_PREFIX)) return 'question-skip'
  if (id.startsWith(STOP_BUTTON_PREFIX)) return 'stop'
  return 'approval'
}

export function createInteractionHandler(runtime) {
  const { config, transport, audit, logger } = runtime

  return async function handleInteraction(interaction) {
    if (runtime.disposed) return

    if (interaction?.isButton?.() && (await handleButton(runtime, interaction))) return

    if (
      interaction?.isModalSubmit?.() &&
      String(interaction.customId || '').startsWith(QUESTION_MODAL_PREFIX)
    ) {
      await handleQuestionModalSubmit(runtime, interaction).catch((error) =>
        logger.warn('处理自定义输入失败:', error?.message || String(error)),
      )
      return
    }

    if (interaction?.isStringSelectMenu?.() && isQuestionCustomId(interaction.customId)) {
      await handleQuestionSelect(runtime, interaction, { authorized }).catch((error) =>
        logger.warn('记录问题答案失败:', error?.message || String(error)),
      )
      return
    }

    if (interaction?.isAutocomplete?.() && interaction.commandName === 'dsh') {
      await handleAutocomplete(runtime, interaction).catch((error) =>
        reportAutocompleteFailure(logger, '自动补全', error),
      )
      return
    }

    if (interaction?.isAutocomplete?.() && interaction.commandName === 'deepseek') {
      await handleDeepSeekAutocomplete(runtime, interaction).catch((error) =>
        reportAutocompleteFailure(logger, 'DeepSeek 自动补全', error),
      )
      return
    }

    if (interaction?.isChatInputCommand?.() && interaction.commandName === 'deepseek') {
      if (
        !authorized(
          config,
          interaction.user.id,
          interaction.guildId || undefined,
          interaction.channelId || '',
        )
      ) {
        await interaction.reply({ content: '你不在授权名单内。', ephemeral: true }).catch(() => undefined)
        return
      }
      await transport.deferInteraction(interaction, false)
      const request = normalizeDeepSeekInteraction(interaction)
      if (request) await handleDeepSeekInteraction(runtime, interaction, request)
      return
    }

    const channelId = interaction.channelId
    if (!channelId) return

    // Discord invalidates an interaction token 3 seconds after the event.
    try {
      await transport.deferInteraction(interaction, true)
    } catch (error) {
      logger.warn('deferReply 失败（交互可能已过期）:', error?.message || String(error))
      return
    }

    const guildId = interaction.guildId || undefined
    const kind = guildId === undefined ? 'dm' : interaction.channel?.isThread?.() ? 'thread' : 'channel'
    // Slash commands obey the same session ownership as plain messages: a
    // thread routes to the conversation that owns it, not to a new one.
    const conversationKey = conversationKeyFor(runtime, {
      channelId,
      kind,
      parentId: interaction.channel?.parentId || undefined,
    })
    try {
      if (!authorized(config, interaction.user.id, guildId, channelId)) {
        await transport.editInteraction(interaction, '你不在授权名单内。')
        return
      }
      const normalized = normalizeInteraction(interaction)
      logger.log(`interaction ${describeInteraction(interaction)} -> ${JSON.stringify(normalized)}`)
      audit.record({
        category: 'discord',
        action: 'slash.command',
        status: 'ok',
        channelId,
        guildId,
        conversation: channelId,
        userId: interaction.user?.id,
        detail: { group: normalized?.group, command: normalized?.command },
      })
      if (!normalized) {
        await transport.editInteraction(interaction, '未知的 /dsh 子命令。')
        return
      }
      if (!normalized.command) {
        await transport.editInteraction(interaction, '缺少子命令，请使用 `/dsh system help` 查看用法。')
        return
      }
      await handleCommand(runtime, {
        ...normalized,
        channelId,
        conversationKey,
        guildId,
        kind,
        target: interaction,
        replyToMessageId: undefined,
      })
    } catch (error) {
      logger.warn('Slash command 失败:', error?.stack || error?.message || String(error))
      audit.record({
        category: 'discord',
        action: 'slash.command',
        status: 'error',
        channelId,
        guildId,
        conversation: channelId,
        userId: interaction.user?.id,
        error: error?.message || String(error),
      })
      await transport
        .editInteraction(interaction, `❌ 命令执行失败：${safeError(error)}`)
        .catch(() => undefined)
    }
  }
}
