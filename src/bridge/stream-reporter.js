import { STOP_BUTTON_PREFIX, formatDuration, progressCaption } from '../discord/renderer.js'
import {
  ACCENT,
  describeTool,
  finalCard,
  placeholderCard,
  streamCard,
  withStopRow,
} from '../discord/cards-v2.js'
import { isPermissionDenial } from './denial.js'
import { SubagentThreads } from './subagent-threads.js'

/** Show the "已等待 …" caption only after this much silence. */
const QUIET_CAPTION_THRESHOLD_MS = 8000

/** Above this aggregated size each extra 1000 chars adds this much interval (capped). */
const LENGTH_BACKOFF_STEP = 4000
const LENGTH_BACKOFF_MAX_MULTIPLIER = 3

/** How much of a child's latest line a card row can show. */
const SUBAGENT_SUMMARY_MAX = 40

/** Catalog labels are model-authored and unbounded; the row is one line. */
const SUBAGENT_LABEL_MAX = 24

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
    subagentThreads = true,
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
    /** A refusal (approval or sandbox) turns the finished card red. */
    this.denied = false
    /** One thread per subagent; created on the first child event. */
    this.subagentThreadsEnabled = subagentThreads
    this.subagentCards = undefined
    /** Index in tools of the call currently running, or undefined. */
    this.activeTool = undefined
    this.toolCount = 0
    /** Child sessions seen under this turn, keyed by child Session id. */
    this.subagents = new Map()
    /** How many of them are still running; drives the caption and footer. */
    this.subagentRunning = 0
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
   * Single entry point for subagent activity forwarded by AgentService.
   *
   * The parent turn owns the card, so children never get their own message and
   * their streaming prose never joins the parent answer: each child contributes
   * at most one row (latest tool + its description) to a small-print block.
   * `child-start` is accepted as an alias of `start` because the sink contract
   * and the event observer do not have to agree on a name.
   */
  onSubagentEvent(event) {
    if (this.closed || !event) return
    const child = event.child ?? {}
    const id = String(child.id ?? event.childId ?? '')
    if (!id) return

    let entry = this.subagents.get(id)
    if (!entry) {
      entry = {
        id,
        label: trimSubagentLabel(child.label) || fallbackSubagentLabel(id),
        depth: 0,
        name: '',
        description: '',
        status: 'running',
        updatedAt: Date.now(),
        running: true,
      }
      this.subagents.set(id, entry)
    }
    if (child.label) entry.label = trimSubagentLabel(child.label) || entry.label
    if (Number.isFinite(child.depth)) entry.depth = child.depth
    entry.updatedAt = Date.now()

    const kind = String(event.kind ?? '')
    if (kind === 'child-start' || kind === 'start') {
      entry.running = true
      entry.status = 'running'
    } else if (kind === 'tool-call') {
      entry.running = true
      entry.status = 'running'
      entry.name = String(event.name ?? '').slice(0, 48)
      // Reuses the parent's privacy rule: description fields only, no arguments.
      entry.description = describeTool(event.args, entry.name)
    } else if (kind === 'tool-result') {
      // One call finishing does not finish the child, so it keeps its ⟳.
      entry.running = true
      entry.status = 'running'
    } else if (kind === 'text') {
      // Kept as a summary only; it must never enter this.text (parent body).
      entry.text = summarizeSubagentText(event.text)
    } else if (kind === 'turn-end') {
      entry.running = false
      entry.status = 'completed'
    } else if (kind === 'end') {
      entry.running = false
      entry.status = isFailedStatus(event.status) ? 'failed' : 'completed'
    }

    this.refreshSubagentRunning()
    this.ensureSubagentThreads()?.track(entry)
    this.schedule()
  }

  /**
   * Lazily create the thread manager: most turns have no subagents at all, and a
   * thread is only worth opening for a child that actually reports activity.
   */
  ensureSubagentThreads() {
    if (this.subagentCards || !this.subagentThreadsEnabled) return this.subagentCards
    this.subagentCards = new SubagentThreads({
      transport: this.transport,
      parentChannelId: this.channelId,
      logger: this.logger,
      onThread: (childId, threadId) => {
        const entry = this.subagents.get(childId)
        if (!entry) return
        entry.threadId = threadId
        // The parent block now has a link to show.
        this.schedule()
      },
    })
    return this.subagentCards
  }

  /** Children in the order they were first seen. */
  subagentList() {
    return [...this.subagents.values()]
  }

  /** Recompute the running count after any child state change. */
  refreshSubagentRunning() {
    let running = 0
    for (const entry of this.subagents.values()) if (entry.running) running += 1
    this.subagentRunning = running
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
  onToolResult(result) {
    if (this.closed) return
    // A refused approval or sandbox denial is not a tool malfunction: the turn
    // still finishes, but its bar turns red so it is not read as success.
    if (isPermissionDenial(result)) this.denied = true
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
    const quiet = running === undefined && sinceLastText < QUIET_CAPTION_THRESHOLD_MS
    const base = quiet
      ? ''
      : progressCaption({
          tools: this.toolCount,
          toolName: running,
          sinceLastText,
        })
    const children = this.subagentRunning > 0 ? `子代理 ${this.subagentRunning} 运行中` : ''
    return [base, children].filter(Boolean).join(' · ')
  }

  buildAnswerPayload() {
    const payload = streamCard(this.text, {
      startedAt: this.startedAt,
      model: this.model,
      reasoningEffort: this.reasoningEffort,
      caption: this.caption(),
      tools: this.tools,
      subagents: this.subagentList(),
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
    // replacing it with an empty "waiting" card. Subagent activity is content
    // too, so a parent with only children running still gets its block drawn.
    if (!this.text.trim() && !this.showReasoning && this.subagents.size === 0) return
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
    await this.subagentCards?.closeAll()
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
      accentColor: this.denied ? ACCENT.failed : undefined,
      caption: this.toolCount > 0 ? `共调用 ${this.toolCount} 次工具，用时 ${formatDuration(elapsed)}` : undefined,
      tools: this.tools,
      subagents: this.subagentList(),
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
      subagents: this.subagentList(),
    })
    if (this.messageId) {
      await this.transport.edit(this.channelId, this.messageId, payload).catch(() => undefined)
    }
  }

  async dispose() {
    this.closed = true
    await this.subagentCards?.closeAll()
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    await this.flushing.catch(() => undefined)
    await this.toolFlushing.catch(() => undefined)
  }
}

/** Trim a catalog label to one card row. */
function trimSubagentLabel(value) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return ''
  return text.length <= SUBAGENT_LABEL_MAX ? text : `${text.slice(0, SUBAGENT_LABEL_MAX - 1)}…`
}

/** Anonymous children are still told apart by a short id prefix. */
function fallbackSubagentLabel(id) {
  return `子代理 ${String(id ?? '').slice(0, 6)}`
}

/** Only the latest line of child prose is kept, and only as a short summary. */
function summarizeSubagentText(text) {
  const lines = String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const line = lines.length ? lines[lines.length - 1] : ''
  return line.length <= SUBAGENT_SUMMARY_MAX ? line : `${line.slice(0, SUBAGENT_SUMMARY_MAX - 1)}…`
}

/** DSH reports a failed child as `failed` (or a provider-ish `error`). */
function isFailedStatus(status) {
  const text = String(status ?? '').toLowerCase()
  return text === 'failed' || text === 'error'
}
