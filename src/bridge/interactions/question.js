/**
 * `ask_user_question` over Discord.
 *
 * DSH blocks the agent on a promise until a human answers. This module is the
 * answerer: it posts one card per question, records the choice, and settles the
 * request. Every path must settle — a question nobody answers locks the turn.
 */
import {
  QUESTION_CUSTOM_PREFIX,
  QUESTION_MODAL_PREFIX,
  QUESTION_SELECT_PREFIX,
  QUESTION_SKIP_PREFIX,
  answeredQuestionCard,
  questionCard,
  questionCustomModal,
} from '../../discord/cards-v2.js'
import { DELEGATE } from '../runtime.js'
import { startCountdown } from './countdown.js'

/** True for a custom_id owned by the question card's select or skip controls. */
export function isQuestionCustomId(customId) {
  const id = String(customId ?? '')
  return id.startsWith(QUESTION_SELECT_PREFIX) || id.startsWith(QUESTION_SKIP_PREFIX)
}

/** Split `<prefix><requestId>:<questionIndex>` into its two parts. */
export function parseQuestionKey(customId, prefix) {
  const rest = String(customId ?? '').slice(prefix.length)
  const sep = rest.lastIndexOf(':')
  if (sep <= 0) return undefined
  return { requestId: rest.slice(0, sep), index: Number(rest.slice(sep + 1)) }
}

/**
 * Answer a DSH `ask_user_question` call.
 *
 * Returns the answer batch, or `DELEGATE` when the asking agent is not one of
 * ours — in that case the caller must `next()` so the Web answerer gets it.
 */
export async function answerUserQuestions(runtime, request) {
  const { agents, questions: registry, audit, transport, logger } = runtime
  const questions = Array.isArray(request?.questions) ? request.questions : []
  if (!questions.length) return { answers: [] }

  // Only answer for an Agent this bridge owns. Falling back to the most recently
  // active channel would steal questions asked in the Web UI and post them to
  // Discord, where the person asking is not looking — hanging both surfaces.
  const channelId = agents.channelForAgent(request?.agent)
  if (!channelId) return DELEGATE

  const entry = registry.create({ questions, channelId })
  audit.record({
    category: 'discord',
    action: 'question.request',
    status: 'ok',
    channelId,
    conversation: channelId,
    detail: { requestId: entry.id, count: questions.length },
  })

  // Countdown stops for every card the moment the request settles, however it
  // settles (answered, skipped, timed out, or shutdown).
  const stopCountdowns = []
  try {
    for (let index = 0; index < questions.length; index += 1) {
      // A later question may already be settled if the request timed out.
      if (!registry.get(entry.id)) break
      const build = () =>
        questionCard({
          requestId: entry.id,
          question: questions[index],
          index,
          total: questions.length,
          expiresAt: entry.expiresAt,
        })
      const sent = await transport.send(channelId, build())
      registry.get(entry.id)?.messageIds.push({ index, messageId: sent.messageId })
      stopCountdowns.push(
        startCountdown(runtime, {
          channelId,
          messageId: sent.messageId,
          expiresAt: entry.expiresAt,
          build,
        }),
      )
    }
  } catch (error) {
    logger.warn('发送问题卡片失败，按跳过处理:', error?.message || String(error))
    registry.finish(entry.id, 'error')
    for (const stop of stopCountdowns) stop()
    return { answers: questions.map((q) => ({ id: q.id, selected: [] })) }
  }

  const settled = await entry.answered
  for (const stop of stopCountdowns) stop()
  audit.record({
    category: 'discord',
    action: 'question.answered',
    status: settled.reason === 'timeout' ? 'expired' : 'ok',
    channelId,
    conversation: channelId,
    detail: {
      requestId: entry.id,
      reason: settled.reason,
      answered: settled.answers.filter((a) => a.selected.length > 0 || a.custom).length,
      total: settled.answers.length,
    },
  })
  return { answers: settled.answers }
}

/**
 * Record a dropdown selection or a skip, then retire that card.
 *
 * The selected option values are indices into the original option list, so the
 * label text is recovered exactly as DSH sent it rather than re-parsed.
 */
export async function handleQuestionSelect(runtime, interaction, { authorized }) {
  const { questions: registry, transport, logger, config } = runtime
  const customId = String(interaction.customId ?? '')
  const skip = customId.startsWith(QUESTION_SKIP_PREFIX)
  const prefix = skip ? QUESTION_SKIP_PREFIX : QUESTION_SELECT_PREFIX
  const parsed = parseQuestionKey(customId, prefix)

  await transport.deferButton(interaction).catch(() => undefined)

  if (!authorized(config, interaction.user?.id, interaction.guildId || undefined, interaction.channelId || '')) {
    await transport.replyEphemeral(interaction, '你不在授权名单内。').catch(() => undefined)
    return
  }

  const entry = parsed ? registry.get(parsed.requestId) : undefined
  const question = entry?.questions?.[parsed?.index]
  if (!entry || !question) {
    await transport.replyEphemeral(interaction, '这个问题已经失效或已作答。').catch(() => undefined)
    return
  }

  let selected = []
  const custom = undefined
  if (!skip) {
    const values = Array.isArray(interaction.values) ? interaction.values : []
    const options = Array.isArray(question.options) ? question.options : []
    selected = values
      .map((value) => options[Number(value)])
      .filter(Boolean)
      .map((option) => option.label)
    if (!selected.length) {
      await transport.replyEphemeral(interaction, '没有识别到有效的选择。').catch(() => undefined)
      return
    }
  }

  const result = registry.answer(parsed.requestId, question.id, { selected, custom })
  if (!result.ok) {
    await transport.replyEphemeral(interaction, '这个问题已经失效或已作答。').catch(() => undefined)
    return
  }

  // Replace this question's controls with its outcome.
  try {
    const messageId = interaction.message?.id
    if (messageId) {
      await transport.edit(
        interaction.channelId,
        messageId,
        answeredQuestionCard({ question, selected, custom, skipped: skip }),
      )
    }
  } catch (error) {
    logger.warn('更新问题卡片失败:', error?.message || String(error))
  }

  await transport
    .replyEphemeral(interaction, skip ? '已跳过。' : `已记录：${selected.join('、')}`)
    .catch(() => undefined)
}

/**
 * "自定义" button: open the modal that collects typed input.
 *
 * The card stays untouched until the modal is submitted — abandoning the modal
 * sends nothing, so the question remains answerable.
 */
export async function handleQuestionCustom(runtime, interaction, { authorized }) {
  const { questions: registry, transport, logger, config } = runtime
  // No defer here: opening a modal IS the initial response, and deferring first
  // makes showModal fail with "the reply has already been sent".
  if (!authorized(config, interaction.user?.id, interaction.guildId || undefined, interaction.channelId || '')) {
    await transport.replyEphemeral(interaction, '你不在授权名单内。').catch(() => undefined)
    return
  }
  const parsed = parseQuestionKey(interaction.customId, QUESTION_CUSTOM_PREFIX)
  const entry = parsed ? registry.get(parsed.requestId) : undefined
  const question = entry?.questions?.[parsed?.index]
  if (!entry || !question) {
    await transport.replyEphemeral(interaction, '这个问题已经失效或已作答。').catch(() => undefined)
    return
  }
  try {
    await transport.showModal(
      interaction,
      questionCustomModal({
        requestId: parsed.requestId,
        question,
        index: parsed.index,
      }),
    )
  } catch (error) {
    logger.warn('打开自定义输入框失败:', error?.message || String(error))
    await transport.replyEphemeral(interaction, '打开输入框失败，请重试。').catch(() => undefined)
  }
}

/**
 * MODAL_SUBMIT for a custom answer.
 *
 * A submitted-but-empty field counts as a skip, because DSH encodes "no choice,
 * no text" as skipped.
 */
export async function handleQuestionModalSubmit(runtime, interaction) {
  const { questions: registry, transport, logger } = runtime
  const parsed = parseQuestionKey(interaction.customId, QUESTION_MODAL_PREFIX)
  const entry = parsed ? registry.get(parsed.requestId) : undefined
  const question = entry?.questions?.[parsed?.index]
  if (!entry || !question) {
    await transport.replyModalMessage(interaction, '这个问题已经失效或已作答。').catch(() => undefined)
    return
  }

  const raw = interaction.fields?.getTextInputValue?.('answer') ?? ''
  const custom = String(raw).trim()
  const result = registry.answer(parsed.requestId, question.id, {
    selected: [],
    custom: custom || undefined,
  })

  try {
    const messageId = interaction.message?.id
    if (messageId && interaction.channelId) {
      await transport.edit(
        interaction.channelId,
        messageId,
        answeredQuestionCard({ question, selected: [], custom, skipped: !custom }),
      )
    }
  } catch (error) {
    logger.warn('更新问题卡片失败:', error?.message || String(error))
  }

  await transport
    .replyModalMessage(interaction, custom ? `已记录：${custom.slice(0, 200)}` : '已跳过。')
    .catch(() => undefined)
  if (!result.ok) {
    logger.warn('记录自定义答案失败:', result.reason || 'unknown')
  }
}
