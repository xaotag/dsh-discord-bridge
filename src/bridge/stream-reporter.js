import {
  MAX_CARD_EMBEDS,
  STOP_BUTTON_PREFIX,
  answerPayload,
  finalPayloads,
  formatDuration,
  placeholderPayload,
  progressCaption,
  toolCardsPayload,
  withStopButton,
} from '../discord/renderer.js'

/** Show the "已等待 …" caption only after this much silence. */
const QUIET_CAPTION_THRESHOLD_MS = 8000

/** Above this aggregated size each extra 1000 chars adds this much interval (capped). */
const LENGTH_BACKOFF_STEP = 4000
const LENGTH_BACKOFF_MAX_MULTIPLIER = 3

/**
 * Presentation-only streaming reporter.
 *
 * One turn owns up to two kinds of messages:
 * - toolMessageId: the tool-run message. One embed per call, appended and
 *   edited in place; nothing is removed when a call finishes, so the transcript
 *   keeps every tool call as its own card.
 * - messageId: the answer card, streamed and finally recoloured to the turn
 *   status. Long answers spill into follow-up messages.
 *
 * It has no DSH or discord.js imports; transport is injected.
 */
export class StreamReporter {
  constructor({
    transport,
    channelId,
    intervalMs = 1500,
    logger = console,
    showReasoning = false,
    existingMessageId,
    model,
    reasoningEffort,
    startedAt,
  }) {
    this.transport = transport
    this.channelId = channelId
    this.intervalMs = intervalMs
    this.logger = logger
    this.showReasoning = showReasoning
    this.messageId = existingMessageId
    this.toolMessageId = undefined
    this.model = model
    this.reasoningEffort = reasoningEffort
    this.startedAt = startedAt || Date.now()
    this.text = ''
    this.reasoning = ''
    /** Finished/started calls, oldest first. Each entry renders as one embed. */
    this.tools = []
    /** Index in tools of the call currently running, or undefined. */
    this.activeTool = undefined
    this.toolCount = 0
    this.lastTextAt = Date.now()
    /** custom_id of the live stop button; cleared once the turn is over. */
    this.stopButtonId = undefined
    this.timer = undefined
    this.lastEditAt = 0
    this.flushing = Promise.resolve()
    this.toolFlushing = Promise.resolve()
    this.closed = false
  }

  /** Route used by this turn, shown in the card footer. */
  setRoute({ model, reasoningEffort } = {}) {
    if (model) this.model = model
    if (reasoningEffort !== undefined) this.reasoningEffort = reasoningEffort
  }

  async begin() {
    if (this.messageId) return
    const sent = await this.transport.send(this.channelId, placeholderPayload())
    this.messageId = sent.messageId
    this.stopButtonId = `${STOP_BUTTON_PREFIX}${sent.messageId}`
    // Only the very first placeholder needs a second edit to gain the button;
    // every later stream edit rebuilds the same row, so this is a one-time cost.
    await this.flush(true).catch((error) =>
      this.logger.warn?.('停止按钮挂载失败:', error?.message || String(error)),
    )
  }

  onTextDelta(delta) {
    if (this.closed || !delta) return
    this.text += delta
    this.lastTextAt = Date.now()
    this.schedule()
  }

  onReasoningDelta(delta) {
    if (this.closed || !delta) return
    this.reasoning += delta
    if (this.showReasoning) this.schedule()
  }

  /**
   * A call started: it becomes the running card until onToolResult.
   *
   * Pending text is flushed synchronously into the current card *before* the
   * tool message is created, so the message order stays answer -> tools ->
   * next answer. The text buffer is then cleared: everything up to here has
   * been rendered and must not leak into the card opened after the call.
   */
  onToolCall(name, args) {
    if (this.closed) return
    if (this.text.trim() || this.showReasoning) {
      const payload = this.buildAnswerPayload()
      if (this.messageId) {
        void this.transport
          .edit(this.channelId, this.messageId, payload)
          .catch((error) => this.logger.warn?.('工具前文案落盘失败:', error?.message || String(error)))
      }
    }
    this.text = ''
    this.reasoning = ''
    this.tools.push({
      name: name || 'unknown',
      args: args || '{}',
      startedAt: Date.now(),
      endedAt: undefined,
    })
    this.activeTool = this.tools.length - 1
    this.toolCount += 1
    this.lastTextAt = Date.now()
    void this.flushTools().catch((error) =>
      this.logger.warn?.('工具卡片编辑失败:', error?.message || String(error)),
    )
  }

  /**
   * A call finished. Its card is kept (only stamped with its duration) and a
   * fresh answer card is opened after the tool run, so the following text does
   * not overwrite the tool history.
   */
  onToolResult() {
    if (this.closed) return
    if (this.activeTool !== undefined) {
      const tool = this.tools[this.activeTool]
      if (tool) tool.endedAt = Date.now()
      this.activeTool = undefined
    }
    this.lastTextAt = Date.now()
    void this.flushTools().catch((error) =>
      this.logger.warn?.('工具卡片编辑失败:', error?.message || String(error)),
    )
    void this.openAnswerCard().catch((error) =>
      this.logger.warn?.('新答案卡片创建失败:', error?.message || String(error)),
    )
  }

  /**
   * Start a new answer card below the tool run. The text deltas that arrived
   * before the call belong to the previous block, so the new card starts empty
   * instead of inheriting them.
   */
  async openAnswerCard() {
    if (this.closed) return
    const sent = await this.transport.send(this.channelId, this.buildAnswerPayload())
    this.messageId = sent.messageId
    this.stopButtonId = undefined
    this.lastEditAt = 0
  }

  /** Footer/status caption describing what the Agent is doing right now. */
  caption() {
    const sinceLastText = Date.now() - this.lastTextAt
    const running = this.activeTool === undefined ? undefined : this.tools[this.activeTool]?.name
    // Without a running call, only a long silence deserves a progress line.
    if (running === undefined && sinceLastText < QUIET_CAPTION_THRESHOLD_MS) return ''
    return progressCaption({
      tools: this.toolCount,
      toolName: running,
      sinceLastText,
    })
  }

  buildAnswerPayload() {
    const payload = answerPayload(this.text, {
      startedAt: this.startedAt,
      model: this.model,
      reasoningEffort: this.reasoningEffort,
      caption: this.caption(),
    })
    // The stop button only makes sense while the turn is still running.
    if (!this.closed && this.stopButtonId) return withStopButton(payload, this.messageId)
    return payload
  }

  /**
   * Re-serializing a long card costs more than editing a short one, so the
   * edit interval stretches with the aggregated text while staying under the
   * Discord rate limit (5 edits / 5s per channel).
   */
  currentInterval() {
    const size = this.text.length + (this.showReasoning ? this.reasoning.length : 0)
    if (size <= LENGTH_BACKOFF_STEP) return this.intervalMs
    const progress = (size - LENGTH_BACKOFF_STEP) / LENGTH_BACKOFF_STEP
    const multiplier = Math.min(LENGTH_BACKOFF_MAX_MULTIPLIER, 1 + progress * 0.5)
    return Math.min(4500, Math.round(this.intervalMs * multiplier))
  }

  schedule() {
    if (this.closed || this.timer !== undefined) return
    const delay = Math.max(0, this.currentInterval() - (Date.now() - this.lastEditAt))
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush(false).catch((error) =>
        this.logger.warn?.('流式消息编辑失败:', error?.message || String(error)),
      )
    }, delay)
    this.timer.unref?.()
  }

  async flush(force = false) {
    if (this.closed || !this.messageId) return
    if (!force && Date.now() - this.lastEditAt < this.currentInterval()) {
      this.schedule()
      return
    }
    // Nothing generated yet: keep the untouched placeholder instead of
    // replacing it with an empty "waiting" card.
    if (!this.text.trim() && !this.showReasoning) return
    const payload = this.buildAnswerPayload()
    this.lastEditAt = Date.now()
    this.flushing = this.flushing
      .catch(() => undefined)
      .then(() => this.transport.edit(this.channelId, this.messageId, payload))
    await this.flushing
  }

  /**
   * Render a batch of already-finished calls (REST APIs return tool calls in
   * one shot instead of start/result pairs) as persistent tool cards.
   */
  async renderToolCards(calls = []) {
    if (this.closed || !calls.length) return
    this.tools = calls.map((call) => ({
      name: call.name || 'tool',
      args: call.args || '{}',
      startedAt: call.startedAt,
      endedAt: call.endedAt,
    }))
    this.toolCount = this.tools.length
    this.activeTool = undefined
    await this.flushTools()
  }

  /** Create-or-update the tool-run message. Never deletes a call. */
  async flushTools() {
    if (!this.tools.length) return
    const payload = toolCardsPayload(this.tools)
    const target = { ...payload, embeds: payload.embeds.slice(-MAX_CARD_EMBEDS) }
    if (this.toolMessageId) {
      const messageId = this.toolMessageId
      this.toolFlushing = this.toolFlushing
        .catch(() => undefined)
        .then(() => this.transport.edit(this.channelId, messageId, target))
      await this.toolFlushing
      return
    }
    this.toolFlushing = this.toolFlushing
      .catch(() => undefined)
      .then(async () => {
        if (this.toolMessageId) return
        const sent = await this.transport.send(this.channelId, target)
        this.toolMessageId = sent.messageId
      })
    await this.toolFlushing
  }

  async finish(text, status = 'completed') {
    if (this.closed) return
    this.closed = true
    this.stopButtonId = undefined
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    await this.flushing.catch(() => undefined)
    await this.toolFlushing.catch(() => undefined)
    const finalText = text || this.text
    if (!this.messageId) return
    const elapsed = Date.now() - this.startedAt
    const payloads = finalPayloads(finalText, status, {
      startedAt: this.startedAt,
      model: this.model,
      reasoningEffort: this.reasoningEffort,
      caption: this.toolCount > 0 ? `共调用 ${this.toolCount} 次工具，用时 ${formatDuration(elapsed)}` : undefined,
    })
    const [first, ...rest] = payloads
    await this.transport.edit(this.channelId, this.messageId, first)
    // Long answers spill into follow-up messages; the answer card stays the
    // anchor so a later edit/cleanup can still find this turn.
    for (const payload of rest) {
      const sent = await this.transport.send(this.channelId, payload)
      this.extraMessageIds = [...(this.extraMessageIds || []), sent.messageId]
    }
  }

  async fail(error) {
    if (this.closed) return
    this.closed = true
    this.stopButtonId = undefined
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    await this.flushing.catch(() => undefined)
    await this.toolFlushing.catch(() => undefined)
    const message = error instanceof Error ? error.message : String(error)
    const payload = finalPayloads(message, 'failed', {
      startedAt: this.startedAt,
      model: this.model,
      reasoningEffort: this.reasoningEffort,
    })[0]
    if (this.messageId) {
      await this.transport.edit(this.channelId, this.messageId, payload).catch(() => undefined)
    }
  }

  async dispose() {
    this.closed = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    await this.flushing.catch(() => undefined)
    await this.toolFlushing.catch(() => undefined)
  }
}
