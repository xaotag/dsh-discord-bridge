/**
 * Serialized Discord REST executor with 429/5xx exponential backoff.
 *
 * discord.js already handles ordinary REST rate limits internally; this layer
 * protects the bridge's high-frequency Message.edit calls from bursting and
 * adds explicit retry-after handling when the API still returns 429.
 */
export class DiscordRateLimiter {
  constructor({ logger = console, maxRetries = 5, baseDelayMs = 500, maxDelayMs = 30_000 } = {}) {
    this.logger = logger
    this.maxRetries = maxRetries
    this.baseDelayMs = baseDelayMs
    this.maxDelayMs = maxDelayMs
    this.tail = Promise.resolve()
    this.blockedUntil = 0
  }

  run(operation, label = 'discord') {
    const task = this.tail.then(() => this.execute(operation, label))
    this.tail = task.catch(() => undefined)
    return task
  }

  async execute(operation, label) {
    for (let attempt = 0; ; attempt += 1) {
      const wait = this.blockedUntil - Date.now()
      if (wait > 0) await sleep(wait)
      try {
        return await operation()
      } catch (error) {
        const retryAfter = retryAfterMs(error)
        const retryable = retryAfter !== undefined || isTransient(error)
        if (!retryable || attempt >= this.maxRetries) throw error
        const delay =
          retryAfter ??
          Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** attempt) + Math.floor(Math.random() * 250)
        this.blockedUntil = Math.max(this.blockedUntil, Date.now() + delay)
        this.logger.warn?.(`[discord-rate-limit] ${label} 退避 ${delay}ms (attempt ${attempt + 1})`)
        await sleep(delay)
      }
    }
  }
}

function retryAfterMs(error) {
  const candidates = [
    error?.rawError?.retry_after,
    error?.retryAfter,
    error?.retry_after,
    error?.headers?.get?.('retry-after'),
  ]
  for (const value of candidates) {
    const seconds = Number(value)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000)
  }
  return undefined
}

/**
 * Errors worth one more attempt.
 *
 * HTTP 429/5xx are Discord's own answer. The other family is the network
 * failing *below* the API: an outbound TLS connection that never came up
 * (`Client network socket disconnected before secure TLS connection was
 * established`). That is a momentary gap on this host, not a rejection, and a
 * single retry after a short delay usually lands — which matters most for
 * interaction replies, where the 15-minute token cannot be replayed by anyone
 * else.
 */
const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
])

function isTransient(error) {
  // Discord's JSON error code travels in `rawError.code`; the HTTP status is a
  // separate field. Check the expiry codes FIRST: they are neither transport
  // noise nor worth a retry, and they must not fall through to the message match.
  const jsonCode = Number(error?.rawError?.code)
  if (jsonCode === 10062 || jsonCode === 40060) return false // Unknown / already acknowledged
  const status = Number(error?.httpStatus ?? error?.status ?? error?.rawError?.code)
  // Expiry codes are > 5000, so they must be excluded before the 5xx test.
  if (status === 10062 || status === 40060) return false
  if (status === 429 || (status >= 500 && status < 1000)) return true
  const code = String(error?.code ?? error?.cause?.code ?? '')
  if (NETWORK_CODES.has(code)) return true
  const message = String(error?.message ?? '')
  return /secure TLS connection|socket disconnected|network socket|socket hang up|fetch failed/i.test(
    message,
  )
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
