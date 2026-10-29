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
