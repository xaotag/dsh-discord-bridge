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

function isTransient(error) {
  const status = Number(error?.httpStatus ?? error?.status ?? error?.rawError?.code)
  return status === 429 || status >= 500
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
