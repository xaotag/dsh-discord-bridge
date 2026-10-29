/**
 * Conversation-keyed view of one root Session and every Session descended from
 * it.
 *
 * DSH gives every delegated Agent its own Session, linked durably through
 * `session.header.parentSession` (and classified by `origin: 'subagent'` /
 * `delegationDepth`). A bridge conversation only owns the *root* Session, so
 * every child had to be resolved by object identity before this module existed:
 * a child's approvals, questions, tool calls and streaming text were dropped
 * because no runtime matched them.
 *
 * This tree is the one place that answers "which conversation does this Session
 * belong to, and how deep under it is it?". It is deliberately presentation-free
 * and Discord-free: it only maps ids and labels.
 *
 * Lineage sources, in priority order:
 *   1. `attachRoot()` — a Session the bridge created or resumed for a channel.
 *   2. `learnChild()` — a `subagent/catalog` fact read from the parent's log; the
 *      only source of a human label.
 *   3. `note()` — any Session object the bridge happens to observe; its header
 *      supplies the parent id, which is enough to walk up.
 *
 * Resolution never guesses. A Session whose lineage cannot be followed to an
 * attached root returns `undefined`, and the caller keeps its existing
 * behaviour (delegate the request to the next answerer).
 */

/** How many ancestor hops resolution will follow before giving up. */
export const DEFAULT_MAX_DEPTH = 8

/** Placeholder label for a child whose catalog fact was not observed. */
export function fallbackLabel(sessionId) {
  const id = String(sessionId ?? '')
  return id ? `子代理 ${id.slice(0, 6)}` : '子代理'
}

/**
 * Shorten a catalog label to what a Discord card can show without wrapping.
 * Catalog labels are model-authored and unbounded; cards are not.
 */
export function trimLabel(label, { max = 32 } = {}) {
  const text = String(label ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return ''
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/** Read `{ id, header }` shapes from a Session or a bare agent. */
function sessionOf(value) {
  if (!value) return undefined
  if (value.session) return value.session
  if (value.header || typeof value.id === 'string') return value
  return undefined
}

export class SessionTree {
  constructor({ maxDepth = DEFAULT_MAX_DEPTH, maxNodes = 512 } = {}) {
    this.maxDepth = maxDepth
    // Every observed Session creates a node, including sessions this bridge will
    // never own (the Web UI's). Unresolved nodes are dropped once the map grows
    // past this bound; a root or catalog fact recreates whatever still matters.
    this.maxNodes = maxNodes
    /** sessionId -> node */
    this.nodes = new Map()
    /** conversation key -> root sessionId */
    this.roots = new Map()
  }

  /** Attach (or re-attach) the root Session owned by one conversation key. */
  attachRoot(key, session) {
    const live = sessionOf(session)
    if (!key || !live?.id) return undefined
    const previous = this.roots.get(key)
    if (previous && previous !== live.id) this.nodes.delete(previous)
    this.roots.set(key, live.id)
    const node = { sessionId: live.id, parentId: undefined, depth: 0, key, label: undefined, origin: live.header?.origin }
    this.nodes.set(live.id, node)
    // Children observed before their root was resumed are adopted now.
    for (const other of this.nodes.values()) {
      if (other.key === undefined && other.parentId !== undefined) this.#walk(other.sessionId)
    }
    return node
  }

  /** Forget one conversation and every node resolved through it. */
  detachRoot(key) {
    const rootId = this.roots.get(key)
    if (!rootId) return
    this.roots.delete(key)
    this.nodes.delete(rootId)
    for (const [sessionId, node] of [...this.nodes]) {
      if (node.key === key) this.nodes.delete(sessionId)
    }
  }

  /**
   * Record a parent-owned `subagent/catalog` fact.
   *
   * The event is emitted on the *parent* Session and carries the child id plus
   * the label frozen at creation, which is the only human-readable name DSH
   * ever gives a child. Recording it is what lets a card say
   * `子代理「校验渲染器」` instead of an opaque id.
   */
  learnChild(parentSessionId, entry = {}) {
    const parentId = parentSessionId ?? entry.parentId
    const childId = entry.childId ?? entry.id
    if (!parentId || !childId) return undefined
    const node = this.#node(childId)
    node.parentId = parentId
    if (entry.label !== undefined) node.label = trimLabel(entry.label)
    if (entry.mode !== undefined) node.mode = entry.mode
    this.#walk(childId)
    return node
  }

  /**
   * Index an observed Session, without assuming the bridge owns it.
   *
   * Returns the resolved entry when the lineage reaches an attached root, so a
   * caller can decide to act on it; otherwise the node stays indexed for a
   * later attach.
   */
  note(session) {
    const live = sessionOf(session)
    if (!live?.id) return undefined
    const node = this.#node(live.id)
    const header = live.header
    if (header) {
      if (header.parentSession && node.parentId === undefined) node.parentId = header.parentSession
      if (node.origin === undefined) node.origin = header.origin
    }
    return this.#walk(live.id)
  }

  /**
   * Resolve a Session (or Agent) to the conversation that owns it.
   *
   * @returns {{key: string, rootId: string, sessionId: string, parentId?: string,
   *   depth: number, label?: string}|undefined}
   */
  resolve(session) {
    const live = sessionOf(session)
    if (!live?.id) return undefined
    const entry = this.note(live) ?? this.#walk(live.id)
    return entry
  }

  /** Node for one session id, if known. */
  get(sessionId) {
    return this.nodes.get(sessionId)
  }

  /** Children of a root conversation key (direct and deeper), newest last. */
  childrenOf(key) {
    const rootId = this.roots.get(key) ?? key
    return [...this.nodes.values()].filter(
      (node) => node.sessionId !== rootId && node.key !== undefined && this.#rootIdOf(node) === rootId,
    )
  }

  /** How many live children the bridge currently knows under a conversation. */
  childCount(key) {
    return this.childrenOf(key).length
  }

  /** Presentation label for a session id. */
  labelFor(sessionId) {
    const node = this.nodes.get(sessionId)
    return node?.label || fallbackLabel(sessionId)
  }

  clear() {
    this.nodes.clear()
    this.roots.clear()
  }

  #node(sessionId) {
    let node = this.nodes.get(sessionId)
    if (!node && this.nodes.size >= this.maxNodes) this.#pruneUnresolved()
    if (!node) {
      node = { sessionId, parentId: undefined, depth: undefined, key: undefined, label: undefined, origin: undefined }
      this.nodes.set(sessionId, node)
    }
    return node
  }

  /**
   * Walk to the owning root, memoizing the path.
   *
   * Returns `undefined` when the chain leaves the known corpus (no root attached
   * yet, or the parent was never observed) — the caller must then leave the
   * session alone instead of filing it under a guessed channel.
   */
  #walk(sessionId) {
    const start = this.nodes.get(sessionId)
    if (!start) return undefined
    if (start.key !== undefined) return this.#entry(start)

    const path = []
    const seen = new Set()
    let current = start
    while (current) {
      if (current.key !== undefined) break
      if (seen.has(current.sessionId) || path.length > this.maxDepth) return undefined
      seen.add(current.sessionId)
      path.push(current)
      if (!current.parentId) return undefined
      const parent = this.nodes.get(current.parentId)
      if (!parent) return undefined
      current = parent
    }
    if (!current || current.key === undefined) return undefined

    const base = current.depth ?? 0
    for (let index = path.length - 1; index >= 0; index -= 1) {
      const node = path[index]
      node.key = current.key
      node.depth = base + (path.length - index)
      current = node
    }
    return this.#entry(start)
  }

  /**
   * Drop observations that never reached a conversation, oldest first.
   *
   * A node that never resolved carries no fact this bridge can act on, so losing
   * it only costs a fallback label the next time that Session is observed. Roots
   * and resolved descendants are never pruned.
   */
  #pruneUnresolved() {
    const keep = Math.max(2, Math.floor(this.maxNodes / 2))
    let removed = 0
    for (const [sessionId, node] of [...this.nodes]) {
      if (node.key !== undefined) continue
      if (this.nodes.size - removed <= keep) break
      this.nodes.delete(sessionId)
      removed += 1
    }
  }

  #rootIdOf(node) {
    return node.key === undefined ? undefined : this.roots.get(node.key)
  }

  #entry(node) {
    if (node.key === undefined) return undefined
    return {
      key: node.key,
      rootId: this.roots.get(node.key),
      sessionId: node.sessionId,
      parentId: node.parentId,
      depth: node.depth ?? 0,
      label: node.depth > 0 ? node.label || fallbackLabel(node.sessionId) : undefined,
    }
  }
}
