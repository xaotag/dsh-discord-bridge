/**
 * Live countdown for pending cards.
 *
 * A card's footer says how long is left, but the number is computed when the
 * payload is built — without a refresh it stays at its initial value while the
 * deadline quietly passes. This re-renders the card on an interval so the
 * seconds actually tick.
 *
 * Two constraints shape the design:
 *   - Discord allows 5 message edits per 5 seconds per channel, so the interval
 *     cannot be shorter than ~5s.
 *   - Each tick is the same operation repeated; it must not go through the audit
 *     log, or a single question would write dozens of rows.
 */

/** One tick per 5s: precise enough to read, well inside the edit rate limit. */
export const COUNTDOWN_INTERVAL_MS = 5_000

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
export function startCountdown(runtime, { channelId, messageId, expiresAt, build, intervalMs = COUNTDOWN_INTERVAL_MS }) {
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
    try {
      await transport.edit(channelId, messageId, build(), { audit: false })
    } catch (error) {
      // A deleted or locked message ends the countdown; anything else is worth a
      // line but not a retry storm.
      stop()
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
