/**
 * Pending confirmation requests.
 *
 * A request is created when the bridge wants the operator to approve a
 * sensitive action. It is settled exactly once — by the button, by the
 * timeout, or by shutdown — and the promise resolves to the decision so the
 * caller can await it without knowing about Discord.
 */

/** How long an unanswered request stays clickable. */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000

let counter = 0

function nextRequestId() {
  counter += 1
  // Short and opaque: it travels inside a Discord custom_id (100 char cap).
  return `${Date.now().toString(36)}${counter.toString(36)}`
}

export class ApprovalRegistry {
  constructor({ timeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS, logger = console } = {}) {
    this.timeoutMs = timeoutMs
    this.logger = logger
    this.pending = new Map()
  }

  /**
   * Register a request and return { id, expiresAt, decided }.
   *
   * `decided` resolves to 'approved' | 'rejected' | 'timeout'. The request is
   * removed from the map as soon as it settles, so a second click is a no-op.
   */
  create({ channelId, userId, description } = {}) {
    const id = nextRequestId()
    const expiresAt = Date.now() + this.timeoutMs
    let settle
    const decided = new Promise((resolve) => {
      settle = resolve
    })
    const entry = { id, channelId, userId, description, expiresAt, settle, timer: undefined }
    // Deliberately not unref'd: an awaited confirmation is real pending work,
    // and an unref'd timer would let the process exit before it settles.
    entry.timer = setTimeout(() => {
      this.finish(id, 'timeout')
    }, this.timeoutMs)
    this.pending.set(id, entry)
    return { id, expiresAt, decided }
  }

  /** Settle a request. Returns the decision, or undefined if already settled. */
  finish(id, decision) {
    const entry = this.pending.get(id)
    if (!entry) return undefined
    this.pending.delete(id)
    if (entry.timer) clearTimeout(entry.timer)
    entry.settle(decision)
    return decision
  }

  /** Look up a live request without settling it. */
  get(id) {
    return this.pending.get(id)
  }

  /** Channel a request belongs to, for authorization checks. */
  channelOf(id) {
    return this.pending.get(id)?.channelId
  }

  /** Settle everything as 'timeout'; used on shutdown so no caller hangs. */
  clear(reason = 'timeout') {
    for (const id of [...this.pending.keys()]) this.finish(id, reason)
  }

  get size() {
    return this.pending.size
  }
}
