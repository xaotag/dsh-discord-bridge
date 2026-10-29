/**
 * Shared runtime for the plugin.
 *
 * `apply()` builds one of these and hands it to every module. Modules never
 * reach back into the composition root, which keeps `index.js` to wiring and
 * lets each concern be read (and tested) on its own.
 *
 * Everything here is a long-lived dependency of the running bridge: config,
 * Discord transport, the Agent service, the audit log, and the registries for
 * in-flight approvals and questions.
 */
import { noticeCard } from '../discord/cards-v2.js'

/** `[dsh-discord-bridge]` prefix used by every log line. */
export const PLUGIN = '[dsh-discord-bridge]'

/** Sentinel: this answerer cannot handle the request, call next(). */
export const DELEGATE = Symbol('delegate')

/** A bare @Bot followed by a message within this window continues the same turn. */
export const MENTION_FOLLOWUP_WINDOW_MS = 60_000

/**
 * Key of one child's Discord thread inside a conversation's thread index.
 *
 * The index lives on the runtime because a different module opens the thread
 * (the stream reporter) than the one that has to find it later (the question
 * handler); the runtime is the only place both already hold.
 */
export function subagentThreadKey(conversationKey, childSessionId) {
  return `${conversationKey}\u0000${childSessionId}`
}

/**
 * Key of the conversation a Discord message belongs to.
 *
 * A Thread is a *view* of the conversation that spawned it, not a new
 * conversation: auto-threaded tasks used to key on the thread id, so every
 * complex prompt created a fresh DSH Session and lost the channel's context.
 * A thread therefore inherits its parent channel's key.
 *
 * Threads that already own a Session keep it. Bindings made before threads
 * inherited context (`/dsh session bind` inside a thread, or a task that ran
 * while the old keying was live) must keep resuming their own Session instead
 * of silently jumping to the parent's.
 */
export function conversationKeyFor(runtime, { channelId, kind, parentId } = {}) {
  if (!channelId) return channelId
  if (kind !== 'thread' || !parentId) return channelId
  return runtime?.state?.hasSession?.(channelId) ? channelId : parentId
}

export function createLogger() {
  return {
    log: (...args) => console.log(PLUGIN, ...args),
    warn: (...args) => console.warn(PLUGIN, ...args),
  }
}

/**
 * Build the shared runtime object.
 *
 * Mutable bits (`disposed`, `clientUser`, `lastActiveChannelId`) live on the
 * object rather than in closures so that every module sees the same value.
 */
export function createRuntime({
  ctx,
  config,
  state,
  audit,
  logger,
  transport,
  agents,
  approvals,
  questions,
  privileged,
  deepseek,
  threads,
}) {
  return {
    ctx,
    config,
    state,
    audit,
    logger,
    transport,
    agents,
    approvals,
    questions,
    privileged,
    deepseek,
    threads,

    /** Set on plugin unload; every entry point checks it. */
    disposed: false,
    /** The bot's own Discord user, once connected. */
    clientUser: undefined,
    /**
     * Channel of the most recent turn.
     *
     * `user-questions/request` carries the asking agent but no channel, so this
     * is the fallback when an agent is not one of ours.
     */
    lastActiveChannelId: undefined,
    /** conversation key -> bare-@Bot greeting awaiting the user's follow-up */
    pendingMentions: new Map(),
    /**
     * `subagentThreadKey(conversation, child)` -> thread id.
     *
     * Written when the reporter opens a child's thread, read when a question
     * names a child: the card belongs next to the activity it is about, not in
     * the parent channel.
     */
    subagentThreads: new Map(),

    /** Reply to a slash interaction or a channel, whichever `target` is. */
    async respond(target, text, { replyToMessageId, ephemeral = true, accentColor } = {}) {
      if (target?.isRepliable) {
        return transport
          .editInteraction(target, text, { accentColor })
          .catch(() => transport.replyInteraction(target, text, ephemeral, { accentColor }))
      }
      return transport.send(target, noticeCard(text, { accentColor }), { replyToMessageId })
    },
  }
}

/** Time-of-day greeting used when someone mentions the bot with no prompt. */
export function greeting(userName) {
  const hour = new Date().getHours()
  const part =
    hour < 5 ? '凌晨好' : hour < 11 ? '早上好' : hour < 13 ? '中午好' : hour < 18 ? '下午好' : '晚上好'
  return `${part}，${userName}！我在。直接告诉我要做什么就行 👇`
}

/**
 * Model route shown in the card footer.
 *
 * Falls back to the global default route so the card still names the model when
 * the channel has no override.
 */
export function routeMeta(runtime, conversationKey) {
  const { state, config, ctx } = runtime
  try {
    const stored = state.conversation(conversationKey) || {}
    let selection
    try {
      selection = ctx.get('agentDefaultModel')?.currentSelection?.()
    } catch {
      selection = undefined
    }
    const model = stored.model || config.model || selection?.model
    const reasoningEffort = stored.reasoningEffort || config.reasoningEffort || selection?.reasoningEffort
    const provider = stored.provider || config.provider || selection?.provider
    return {
      model: model ? `${provider ? provider + '/' : ''}${model}` : undefined,
      reasoningEffort,
    }
  } catch {
    return {}
  }
}

/** Fit command output inside one Discord message, keeping the tail (errors). */
export function clipForDiscord(text, limit = 1500) {
  const clean = String(text ?? '')
  if (clean.length <= limit) return clean
  return `…（前面已截断）\n${clean.slice(-limit)}`
}

/** Redact obvious secrets from an error before it reaches a channel. */
export function safeError(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/[A-Za-z0-9_-]{20,}/g, '***').slice(0, 500)
}
