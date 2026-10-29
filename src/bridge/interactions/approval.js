/**
 * Approval cards: ask a human to confirm before a sensitive action runs.
 *
 * The registry holds the pending decision; this module owns the Discord side —
 * posting the card and translating the button click back into an outcome.
 */
import { APPROVE_BUTTON_PREFIX, REJECT_BUTTON_PREFIX } from '../../discord/renderer.js'
import { approvalCard, decidedApprovalCard } from '../../discord/cards-v2.js'
import { DELEGATE } from '../runtime.js'
import { startCountdown } from './countdown.js'

/**
 * Post a confirmation card and await the decision.
 *
 * Resolves to 'approved' | 'rejected' | 'timeout' and never rejects, so a caller
 * can treat a timeout as a refusal.
 */
export async function requestApproval(
  runtime,
  { channelId, userId, description, title, footer } = {},
) {
  if (!channelId) return 'timeout'
  const { approvals, transport, audit, logger } = runtime
  const request = approvals.create({ channelId, userId, description })
  let stopCountdown = () => {}
  try {
    /** Rebuilt on each tick so the footer's remaining time stays real. */
    const build = () =>
      approvalCard({
        requestId: request.id,
        title,
        description,
        footer,
        expiresAt: request.expiresAt,
        approvePrefix: APPROVE_BUTTON_PREFIX,
        rejectPrefix: REJECT_BUTTON_PREFIX,
      })
    const sent = await transport.send(channelId, build())
    audit.record({
      category: 'discord',
      action: 'approval.request',
      status: 'ok',
      channelId,
      conversation: channelId,
      userId,
      detail: { requestId: request.id, messageId: sent?.messageId },
    })
    stopCountdown = startCountdown(runtime, {
      channelId,
      messageId: sent?.messageId,
      expiresAt: request.expiresAt,
      build,
    })
    return await request.decided
  } catch (error) {
    approvals.finish(request.id, 'timeout')
    logger.warn('发送确认卡片失败:', error?.message || String(error))
    return 'timeout'
  } finally {
    stopCountdown()
  }
}

/**
 * One-line summary of a DSH approval request for the card body.
 *
 * The tool name is always shown; the asker's reason (localized when it sends
 * one) explains what is being granted and is the part the operator needs to
 * decide.
 */
export function describeApproval(request) {
  const toolName = String(request?.toolName || '未知工具')
  const localized = request?.displayReason?.zh || request?.displayReason?.en
  const reason = String(localized || request?.reason || '').trim()
  const lines = [`工具：\`${toolName}\``]
  if (reason) lines.push(reason)
  return lines.join('\n\n')
}

/** Map a card decision onto DSH's approval outcome vocabulary. */
export function approvalOutcome(decision) {
  if (decision === 'approved') return 'allowed-once'
  if (decision === 'cancelled') return 'cancelled'
  // A timeout is a refusal: the operator did not grant anything.
  return 'rejected'
}

/**
 * Answer a DSH `approval/request` from Discord.
 *
 * Returns an approval outcome, or `DELEGATE` when the asking agent is not one of
 * ours — the caller must `next()` so the Web answerer still gets a chance.
 * Every path settles: a request nobody answers times out and is refused, so the
 * tool call can never be left waiting on a promise.
 */
export async function answerApprovalRequest(runtime, request) {
  const { agents, approvals, transport, audit, logger } = runtime
  const channelId = agents.channelForAgent(request?.agent)
  if (!channelId) return DELEGATE

  const entry = approvals.create({ channelId, description: request?.reason })
  audit.record({
    category: 'discord',
    action: 'approval.asked',
    status: 'ok',
    channelId,
    conversation: channelId,
    detail: { requestId: entry.id, toolName: request?.toolName },
  })

  const build = () =>
    approvalCard({
      requestId: entry.id,
      description: describeApproval(request),
      footer: '一次性授权，仅本次调用生效',
      expiresAt: entry.expiresAt,
      approvePrefix: APPROVE_BUTTON_PREFIX,
      rejectPrefix: REJECT_BUTTON_PREFIX,
    })

  let stopCountdown = () => {}
  let messageId
  try {
    const sent = await transport.send(channelId, build())
    messageId = sent?.messageId
    stopCountdown = startCountdown(runtime, {
      channelId,
      messageId,
      expiresAt: entry.expiresAt,
      build,
    })

    // DSH may withdraw the request (signal abort) while the card is up; settle
    // it as cancelled so the waiting tool stops instead of hanging.
    const onAbort = () => approvals.finish(entry.id, 'cancelled')
    request?.signal?.addEventListener?.('abort', onAbort, { once: true })
    const decision = await entry.decided
    request?.signal?.removeEventListener?.('abort', onAbort)

    audit.record({
      category: 'discord',
      action: 'approval.decided',
      status: 'ok',
      channelId,
      conversation: channelId,
      detail: { requestId: entry.id, decision, toolName: request?.toolName },
    })

    // A click already rewrote the card through the interaction; only a timeout
    // or a withdrawn request has to be reflected here.
    if (messageId && (decision === 'timeout' || decision === 'cancelled')) {
      await transport
        .edit(channelId, messageId, decidedApprovalCard(decision))
        .catch((error) => logger.warn?.('更新确认卡片失败:', error?.message || String(error)))
    }
    return approvalOutcome(decision)
  } catch (error) {
    approvals.finish(entry.id, 'timeout')
    logger.warn('发送确认卡片失败，按拒绝处理:', error?.message || String(error))
    return 'rejected'
  } finally {
    stopCountdown()
  }
}

/**
 * Handle an approve/reject click.
 *
 * The custom_id carries a short request id that indexes the registry; settling
 * it resolves the promise the requesting turn is awaiting. A second click finds
 * nothing pending and says so instead of deciding twice.
 *
 * @returns true when this module owned the interaction.
 */
export async function handleApprovalButton(runtime, interaction, customId, { authorized }) {
  const { approvals, transport, audit, logger, config } = runtime
  const approved = customId.startsWith(APPROVE_BUTTON_PREFIX)
  const rejected = customId.startsWith(REJECT_BUTTON_PREFIX)
  if (!approved && !rejected) return false

  const prefix = approved ? APPROVE_BUTTON_PREFIX : REJECT_BUTTON_PREFIX
  const requestId = customId.slice(prefix.length)
  const channelId = interaction.channelId
  const guildId = interaction.guildId || undefined
  await transport.deferButton(interaction).catch(() => undefined)

  if (!channelId || !authorized(config, interaction.user?.id, guildId, channelId)) {
    await transport.replyEphemeral(interaction, '你不在授权名单内。').catch(() => undefined)
    return true
  }

  const entry = approvals.get(requestId)
  if (!entry) {
    await transport.replyEphemeral(interaction, '这个确认已经失效或已被处理。').catch(() => undefined)
    return true
  }

  const decision = approved ? 'approved' : 'rejected'
  approvals.finish(requestId, decision)
  audit.record({
    category: 'discord',
    action: approved ? 'button.approve' : 'button.reject',
    status: 'ok',
    channelId,
    guildId,
    conversation: channelId,
    userId: interaction.user?.id,
    detail: { requestId },
  })

  try {
    // Editing through the interaction updates the exact message that was
    // clicked, and survives a stale channel cache the way a REST edit does not.
    await transport.editComponentReply(interaction, decidedApprovalCard(decision))
  } catch (error) {
    const messageId = interaction.message?.id
    if (messageId) {
      await transport
        .edit(channelId, messageId, decidedApprovalCard(decision))
        .catch((fallbackError) =>
          logger.warn('更新确认卡片失败:', fallbackError?.message || String(fallbackError)),
        )
    } else {
      logger.warn('更新确认卡片失败:', error?.message || String(error))
    }
  }

  await transport
    .replyEphemeral(interaction, approved ? '已批准。' : '已拒绝。')
    .catch(() => undefined)
  return true
}
