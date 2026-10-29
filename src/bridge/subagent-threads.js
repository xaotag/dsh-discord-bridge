/**
 * One Discord thread per subagent.
 *
 * The parent card only has room for a line or two per child, and a child that
 * runs for a while deserves somewhere to read. Each subagent therefore gets its
 * own thread under the parent channel, with a single activity card that is
 * edited in place — the same shape as the parent card, one level down.
 *
 * Creation is lazy (first event of that child) and best-effort: a channel that
 * cannot host a thread, or a Discord failure, leaves the child on the parent
 * card exactly as before. Nothing here may hold up the turn.
 */
import { ACCENT, cardPayload, describeTool } from '../discord/cards-v2.js'

/** Refreshes are throttled per child: a thread card is not worth a rate limit. */
export const SUBAGENT_THREAD_REFRESH_MS = 1_200

/** Activity body lines are summaries; the thread is not a transcript. */
const TEXT_SUMMARY_MAX = 400

const GLYPH = { running: '⟳', completed: '✓', failed: '✖' }

/** Trim a child's prose to one short paragraph. */
export function summarizeChildText(value) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length <= TEXT_SUMMARY_MAX) return text
  return `${text.slice(0, TEXT_SUMMARY_MAX - 1)}…`
}

/** Card shown inside a child's thread. */
export function subagentActivityCard(child) {
  const label = String(child?.label || '子代理').slice(0, 40)
  const running = Boolean(child?.running)
  const failed = child?.status === 'failed'
  const accent = failed ? ACCENT.failed : running ? ACCENT.working : ACCENT.completed
  const glyph = GLYPH[failed ? 'failed' : running ? 'running' : 'completed']

  const lines = [`-# ${glyph} ${running ? '运行中' : failed ? '已失败' : '已结束'}`]
  const text = summarizeChildText(child?.text)
  if (text) lines.push('', text)
  const name = String(child?.name ?? '').trim().slice(0, 48)
  if (name) {
    // Reuses the parent's privacy rule: description fields only, no arguments.
    const description = describeTool(child?.args, name)
    lines.push('', description ? `-# \`${name}\` · ${description}` : `-# \`${name}\``)
  }

  return cardPayload({
    accentColor: accent,
    title: `🧩 ${label}`,
    body: lines.join('\n'),
    footer: `子代理 · 深度 ${Number.isFinite(child?.depth) && child.depth > 0 ? child.depth : 1}`,
  })
}

export class SubagentThreads {
  /**
   * @param options.parentChannelId - channel the parent card lives in.
   * @param options.onThread - called once per child with its new thread id.
   */
  constructor({
    transport,
    parentChannelId,
    logger = console,
    refreshMs = SUBAGENT_THREAD_REFRESH_MS,
    enabled = true,
    onThread,
  } = {}) {
    this.transport = transport
    this.parentChannelId = parentChannelId
    this.logger = logger
    this.refreshMs = refreshMs
    this.onThread = onThread
    this.enabled = Boolean(enabled && parentChannelId && transport?.createThread)
    this.children = new Map()
  }

  /**
   * Record one child state and return its thread id, when one already exists.
   * The first call opens the thread; later calls only mark the card dirty.
   */
  track(child) {
    if (!this.enabled || !child?.id) return undefined
    let state = this.children.get(child.id)
    if (!state) {
      state = {
        id: child.id,
        label: child.label,
        depth: child.depth,
        threadId: undefined,
        messageId: undefined,
        opening: undefined,
        timer: undefined,
        lastEditAt: 0,
        closed: false,
        child: { ...child },
      }
      this.children.set(child.id, state)
      state.opening = this.open(state)
    }
    state.child = { ...state.child, ...child }
    state.label = child.label || state.label
    if (state.messageId && !state.closed) this.schedule(state)
    return state.threadId
  }

  /** Stop every timer and make sure each thread card shows its final state. */
  async closeAll() {
    const pendings = []
    for (const state of this.children.values()) {
      state.closed = true
      if (state.timer) {
        clearTimeout(state.timer)
        state.timer = undefined
      }
      if (state.opening) pendings.push(state.opening)
      pendings.push(this.flush(state))
    }
    await Promise.allSettled(pendings)
  }

  async open(state) {
    try {
      const thread = await this.transport.createThread(
        this.parentChannelId,
        `🧩 ${String(state.label || '子代理').slice(0, 80)}`,
        60,
      )
      if (!thread?.channelId) return
      state.threadId = thread.channelId
      const sent = await this.transport.send(state.threadId, subagentActivityCard(state.child))
      state.messageId = sent?.messageId
      this.onThread?.(state.id, state.threadId)
      // The snapshot may have moved on while the thread was being created.
      if (state.messageId) this.schedule(state)
    } catch (error) {
      this.logger.warn?.('创建子代理 Thread 失败，保留父卡片摘要:', error?.message || String(error))
    }
  }

  schedule(state) {
    if (state.closed || state.timer) return
    const delay = Math.max(0, this.refreshMs - (Date.now() - state.lastEditAt))
    state.timer = setTimeout(() => {
      state.timer = undefined
      void this.flush(state)
    }, delay)
    state.timer.unref?.()
  }

  async flush(state) {
    if (!state.threadId || !state.messageId) return
    state.lastEditAt = Date.now()
    try {
      await this.transport.edit(state.threadId, state.messageId, subagentActivityCard(state.child))
    } catch (error) {
      this.logger.warn?.('更新子代理 Thread 卡片失败:', error?.message || String(error))
    }
  }
}
