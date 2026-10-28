/**
 * Approval cards: ask a human to confirm before a sensitive action runs.
 *
 * The registry holds the pending decision; this module owns the Discord side —
 * posting the card and translating the button click back into an outcome.
 */
import { APPROVE_BUTTON_PREFIX, REJECT_BUTTON_PREFIX } from '../../discord/renderer.js'
import { approvalCard, decidedApprovalCard } from '../../discord/cards-v2.js'

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
  try {
    const payload = approvalCard({
      requestId: request.id,
      title,
      description,
      footer,
      expiresAt: request.expiresAt,
      approvePrefix: APPROVE_BUTTON_PREFIX,
      rejectPrefix: REJECT_BUTTON_PREFIX,
    })
    const sent = await transport.send(channelId, payload)
    audit.record({
      category: 'discord',
      action: 'approval.request',
      status: 'ok',
      channelId,
      conversation: channelId,
      userId,
      detail: { requestId: request.id, messageId: sent?.messageId },
    })
    return await request.decided
  } catch (error) {
    approvals.finish(request.id, 'timeout')
    logger.warn('发送确认卡片失败:', error?.message || String(error))
    return 'timeout'
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
    const messageId = interaction.message?.id
    if (messageId) {
      await transport.edit(channelId, messageId, decidedApprovalCard(decision))
    }
  } catch (error) {
    logger.warn('更新确认卡片失败:', error?.message || String(error))
  }

  await transport
    .replyEphemeral(interaction, approved ? '已批准。' : '已拒绝。')
    .catch(() => undefined)
  return true
}
