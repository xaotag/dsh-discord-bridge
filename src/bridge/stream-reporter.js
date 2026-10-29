import { STOP_BUTTON_PREFIX, formatDuration, progressCaption } from '../discord/renderer.js'
import {
  finalCard,
  placeholderCard,
  streamCard,
  withStopRow,
} from '../discord/cards-v2.js'

/** Show the "已等待 …" caption only after this much silence. */
const QUIET_CAPTION_THRESHOLD_MS = 8000

/** Above this aggregated size each extra 1000 chars adds this much interval (capped). */
const LENGTH_BACKOFF_STEP = 4000
const LENGTH_BACKOFF_MAX_MULTIPLIER = 3

/**
 * Presentation-only streaming reporter.
 *
 * One turn owns exactly one message: the answer card (messageId). Tool calls
 * render **inline** at the top of that card as subtext lines, so a turn never
 * spawns a second message for its tool run. The card is edited in place and
 * finally recoloured to the turn status.
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
    const sent = await this.transport.send(this.channelId, placeholderCard())
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
   * The answer card is NOT split here. One turn owns exactly one answer card
   * and one tool message, however many calls it makes: the text keeps
   * accumulating in a single card, and the tool run renders beside it. Earlier
   * versions opened a new answer card per tool result, which left one-word
   * cards scattered through the channel.
   */
  onToolCall(name, args) {
    if (this.closed) return
    // Persist whatever text exists so far before the tool card appears.
    if (this.text.trim() || this.showReasoning) {
      void this.flush(true).catch((error) =>
        this.logger.warn?.('工具前文案落盘失败:', error?.message || String(error)),
      )
    }
    this.tools.push({
      name: name || 'unknown',
      args: args || '{}',
      startedAt: Date.now(),
      endedAt: undefined,
      // Character offset in the aggregated text where this call happened. The
      // card interleaves tools with prose by this anchor, so the transcript
      // reads in the order things actually occurred.
      textOffset: this.text.length,
    })
    this.activeTool = this.tools.length - 1
    this.toolCount += 1
    this.lastTextAt = Date.now()
    void this.flushTools().catch((error) =>
      this.logger.warn?.('工具卡片编辑失败:', error?.message || String(error)),
    )
  }

  /**
   * A call finished. Its card is kept (only stamped with its duration); the
   * answer card continues to be edited in place, so a turn never leaves orphan
   * fragments behind.
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
    const payload = streamCard(this.text, {
      startedAt: this.startedAt,
      model: this.model,
      reasoningEffort: this.reasoningEffort,
      caption: this.caption(),
      title: '⏳ 正在生成…',
      tools: this.tools,
    })
    // The stop button only makes sense while the turn is still running.
    if (!this.closed && this.stopButtonId) {
      return withStopRow(payload, this.messageId, { prefix: STOP_BUTTON_PREFIX })
    }
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

  /**
   * Re-render the answer card so newly started/finished tool calls appear
   * inline. No separate message is created, so a turn stays one card.
   */
  async flushTools() {
    if (!this.tools.length || !this.messageId) return
    const messageId = this.messageId
    this.toolFlushing = this.toolFlushing
      .catch(() => undefined)
      .then(() => this.transport.edit(this.channelId, messageId, this.buildAnswerPayload()))
    await this.toolFlushing
  }

  async finish(text, status = 'completed', usage) {
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
    // A single card holds the answer; textChunks inside cardPayload already
    // splits the body across Text Displays, so no follow-up messages are needed
    // unless the answer exceeds the per-message component budget.
    const payload = finalCard(finalText, status, {
      startedAt: this.startedAt,
      model: this.model,
      reasoningEffort: this.reasoningEffort,
      usage,
      caption: this.toolCount > 0 ? `共调用 ${this.toolCount} 次工具，用时 ${formatDuration(elapsed)}` : undefined,
      tools: this.tools,
    })
    await this.transport.edit(this.channelId, this.messageId, payload)
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
    const payload = finalCard(message, 'failed', {
      startedAt: this.startedAt,
      model: this.model,
      reasoningEffort: this.reasoningEffort,
    })
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
