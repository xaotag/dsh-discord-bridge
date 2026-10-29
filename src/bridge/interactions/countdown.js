/**
 * Live countdown for pending cards.
 *
 * A card's footer says how long is left, but the number is computed when the
 * payload is built — without a refresh it stays at its initial value while the
 * deadline quietly passes. This re-renders the card so the seconds actually tick.
 *
 * Discord allows only **5 message edits per 5 seconds per channel**, and that
 * budget is shared by every card in the channel. A per-card 1s interval is fine
 * for one question but blows the budget with three, so edits also pass through a
 * per-channel gate: at most one refresh per `MIN_EDIT_GAP_MS` across all cards.
 * With a single pending card that yields a smooth 1s countdown; with several, the
 * cards take turns and each ticks at a slower but still correct rate.
 *
 * Ticks also skip the audit log: they are the same operation repeated, and
 * logging each one would write dozens of rows for a single question.
 */

/**
 * Target refresh rate while one card is pending.
 *
 * Matched to MIN_EDIT_GAP_MS: a shorter timer would be rejected by the gate on
 * every other tick, halving the effective rate.
 */
export const COUNTDOWN_INTERVAL_MS = 1_100

/**
 * Floor between any two countdown edits in the same channel.
 *
 * Discord allows 5 edits per 5s. A 1000ms floor works out to six edits in some
 * five-second windows because timer jitter lands the boundary early, so 1100ms
 * keeps the budget strictly under the limit.
 */
export const MIN_EDIT_GAP_MS = 1_100

/** channelId -> epoch ms of the last countdown edit. */
const lastEditAt = new Map()

/** Test hook: forget the per-channel clock. */
export function resetCountdownClock() {
  lastEditAt.clear()
}

/**
 * Refresh a card until it expires or the caller stops it.
 *
 * @param {object} runtime
 * @param {object} options
 * @param {string} options.channelId
 * @param {string} options.messageId
 * @param {number} options.expiresAt  epoch ms
 * @param {() => object} options.build  rebuilds the payload for the current time
 * @returns {() => void} stop function; always safe to call
 */
export function startCountdown(
  runtime,
  { channelId, messageId, expiresAt, build, intervalMs = COUNTDOWN_INTERVAL_MS },
) {
  const { transport, logger } = runtime
  if (!channelId || !messageId || !Number.isFinite(expiresAt) || typeof build !== 'function') {
    return () => {}
  }

  let stopped = false
  const tick = async () => {
    if (stopped) return
    if (Date.now() >= expiresAt) {
      stop()
      return
    }
    // Shared per-channel budget: a skipped tick is retried on the next one, so
    // the countdown stays accurate without ever exceeding the edit limit.
    const now = Date.now()
    const last = lastEditAt.get(channelId) ?? 0
    if (now - last < MIN_EDIT_GAP_MS) return
    lastEditAt.set(channelId, now)

    try {
      await transport.edit(channelId, messageId, build(), { audit: false })
    } catch (error) {
      // A deleted or locked message ends the countdown; anything else is worth a
      // line but not a retry storm.
      stop()
      lastEditAt.delete(channelId)
      logger.warn?.('倒计时刷新失败，已停止:', error?.message || String(error))
    }
  }

  const timer = setInterval(() => void tick(), intervalMs)
  timer.unref?.()

  function stop() {
    if (stopped) return
    stopped = true
    clearInterval(timer)
  }
  return stop
}
