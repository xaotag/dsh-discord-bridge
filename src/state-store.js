import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

/** Durable Discord channel -> DSH session mapping and bounded event dedupe. */
export class StateStore {
  constructor(filename, maxSeen = 2048) {
    this.filename = filename
    this.maxSeen = maxSeen
    this.state = { version: 1, conversations: {}, subagentThreads: {}, seenEventIds: [] }
    this.writes = Promise.resolve()
    this.closed = false
  }

  async load() {
    try {
      const parsed = JSON.parse(await fsp.readFile(this.filename, 'utf8'))
      if (parsed?.version !== 1 || typeof parsed.conversations !== 'object') {
        throw new Error('invalid state document')
      }
      this.state = {
        version: 1,
        conversations: parsed.conversations || {},
        subagentThreads: parsed.subagentThreads || {},
        seenEventIds: Array.isArray(parsed.seenEventIds) ? parsed.seenEventIds.slice(-this.maxSeen) : [],
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        // Corrupt state is retained on disk for recovery, but the bridge starts
        // with an empty in-memory view rather than preventing DSH from booting.
        this.state = { version: 1, conversations: {}, subagentThreads: {}, seenEventIds: [] }
      }
    }
  }

  conversation(key) {
    return this.state.conversations[key]
  }

  hasSession(key) {
    return Boolean(this.state.conversations[key]?.sessionId)
  }

  async touchConversation(key, meta) {
    const current = this.state.conversations[key]
    if (current && current.channelId === meta.channelId && current.kind === meta.kind) return
    this.state.conversations[key] = {
      ...(current || {}),
      key,
      channelId: meta.channelId,
      ...(meta.guildId ? { guildId: meta.guildId } : {}),
      kind: meta.kind,
      updatedAt: Date.now(),
    }
    await this.persist()
  }

  async setSessionId(key, sessionId) {
    const current = this.state.conversations[key] || { key, channelId: key, kind: 'channel' }
    if (sessionId === undefined) delete current.sessionId
    else current.sessionId = sessionId
    current.updatedAt = Date.now()
    this.state.conversations[key] = current
    await this.persist()
  }

  async setSettings(key, settings) {
    const current = this.state.conversations[key] || { key, channelId: key, kind: 'channel' }
    for (const [name, value] of Object.entries(settings)) {
      if (value === undefined) delete current[name]
      else current[name] = value
    }
    current.updatedAt = Date.now()
    this.state.conversations[key] = current
    await this.persist()
  }

  /**
   * Durable binding of one Discord thread to a delegated child Session.
   *
   * A subagent thread is the child's own conversation surface: replying there
   * continues that child, it never starts a Session of its own. The binding has
   * to outlive a restart, because the child (and its thread) can still be
   * resumed long after the turn that created them.
   */
  threadAgent(threadId) {
    return this.state.subagentThreads?.[threadId]
  }

  /** Thread currently bound to a child Session, if any. */
  threadForChild(childSessionId) {
    for (const [threadId, binding] of Object.entries(this.state.subagentThreads || {})) {
      if (binding?.childId === childSessionId) return threadId
    }
    return undefined
  }

  async setThreadAgent(threadId, binding) {
    if (!threadId || !binding?.childId) return
    if (!this.state.subagentThreads) this.state.subagentThreads = {}
    this.state.subagentThreads[threadId] = { ...binding, updatedAt: Date.now() }
    await this.persist()
  }

  async forgetThreadAgent(threadId) {
    if (!this.state.subagentThreads?.[threadId]) return
    delete this.state.subagentThreads[threadId]
    await this.persist()
  }

  async claimEvent(eventId) {
    if (this.state.seenEventIds.includes(eventId)) return false
    this.state.seenEventIds.push(eventId)
    if (this.state.seenEventIds.length > this.maxSeen) {
      this.state.seenEventIds.splice(0, this.state.seenEventIds.length - this.maxSeen)
    }
    await this.persist()
    return true
  }

  async persist() {
    if (this.closed) return
    const snapshot = JSON.stringify(this.state, null, 2) + '\n'
    const operation = this.writes.then(async () => {
      await fsp.mkdir(path.dirname(this.filename), { recursive: true })
      const temporary = `${this.filename}.${randomUUID()}.tmp`
      await fsp.writeFile(temporary, snapshot, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      await fsp.rename(temporary, this.filename)
    })
    this.writes = operation.catch(() => undefined)
    return operation
  }

  async close() {
    this.closed = true
    await this.writes.catch(() => undefined)
  }
}
