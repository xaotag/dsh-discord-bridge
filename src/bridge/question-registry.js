/**
 * Pending `ask_user_question` requests.
 *
 * DSH pauses the agent until a human answers. On Discord the question becomes a
 * card with a dropdown (plus a skip button); this registry holds the promise the
 * bridge is waiting on, keyed by a short request id that fits in a custom_id.
 *
 * One request may carry several questions, answered one card at a time. The
 * registry accumulates selections and settles when every question is answered or
 * skipped, or when the timeout fires.
 */

/**
 * How long an unanswered question stays answerable.
 *
 * Deliberately short: DSH blocks the agent on this promise, so a question nobody
 * can answer (a card the user cannot act on, a channel they are not watching)
 * locks the whole turn. Two minutes bounds that worst case while still leaving
 * plenty of time to pick an option.
 */
export const DEFAULT_QUESTION_TIMEOUT_MS = 2 * 60 * 1000

let counter = 0
function nextId() {
  counter += 1
  return `${Date.now().toString(36)}${counter.toString(36)}`
}

export class QuestionRegistry {
  constructor({ timeoutMs = DEFAULT_QUESTION_TIMEOUT_MS, logger = console } = {}) {
    this.timeoutMs = timeoutMs
    this.logger = logger
    this.pending = new Map()
  }

  /**
   * Register a request.
   *
   * @param {object} params
   * @param {Array} params.questions DSH question items.
   * @returns {{id: string, expiresAt: number, answered: Promise<object>}}
   *   `answered` resolves to `{ answers: [{id, selected, custom?}] }` shaped for
   *   `ctx.userQuestions`. Unanswered questions come back as `selected: []`,
   *   which is how DSH represents a skipped item.
   */
  create({ questions = [], channelId, userId } = {}) {
    const id = nextId()
    const expiresAt = Date.now() + this.timeoutMs
    const answers = new Map()

    let settle
    const answered = new Promise((resolve) => {
      settle = resolve
    })

    const entry = {
      id,
      questions,
      answers,
      channelId,
      userId,
      expiresAt,
      settle,
      timer: undefined,
      // Card message ids, one per question, so a later edit can find them.
      messageIds: [],
    }
    // Not unref'd: an awaited answer is real pending work.
    entry.timer = setTimeout(() => this.finish(id, 'timeout'), this.timeoutMs)
    this.pending.set(id, entry)
    return { id, expiresAt, answered }
  }

  get(id) {
    return this.pending.get(id)
  }

  channelOf(id) {
    return this.pending.get(id)?.channelId
  }

  /**
   * Record one question's answer.
   *
   * `selected` are option labels; `custom` is free text. An empty selection with
   * no custom text records a *skip*, which DSH represents as `selected: []`.
   * Returns the next unanswered question index, or -1 when the set is complete.
   */
  answer(id, questionId, { selected = [], custom } = {}) {
    const entry = this.pending.get(id)
    if (!entry) return { ok: false, reason: 'unknown-request' }

    const question = entry.questions.find((q) => q.id === questionId)
    if (!question) return { ok: false, reason: 'unknown-question' }

    const record = { id: questionId, selected: [...selected] }
    if (typeof custom === 'string' && custom.trim()) record.custom = custom.trim()
    entry.answers.set(questionId, record)

    const next = entry.questions.findIndex((q) => !entry.answers.has(q.id))
    if (next === -1) {
      this.finish(id, 'answered')
      return { ok: true, next: -1 }
    }
    return { ok: true, next }
  }

  /** Settle a request. Returns the decision, or undefined if already settled. */
  finish(id, reason = 'answered') {
    const entry = this.pending.get(id)
    if (!entry) return undefined
    this.pending.delete(id)
    if (entry.timer) clearTimeout(entry.timer)
    entry.settle(buildAnswer(entry, reason))
    return reason
  }

  /** Settle everything; used on shutdown so no turn hangs. */
  clear(reason = 'timeout') {
    for (const id of [...this.pending.keys()]) this.finish(id, reason)
  }

  get size() {
    return this.pending.size
  }
}

/**
 * Shape a request's collected answers for DSH.
 *
 * Every question must appear exactly once — DSH rejects a batch that does not
 * name each question of the call — so a question the user never touched is
 * emitted as `selected: []`, the documented skip form.
 */
export function buildAnswer(entry, reason) {
  const answers = entry.questions.map((question) => {
    const recorded = entry.answers.get(question.id)
    if (recorded) return recorded
    return { id: question.id, selected: [] }
  })
  return { answers, reason }
}
