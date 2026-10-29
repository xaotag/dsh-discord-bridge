import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * A failed interaction reply must never leave the operator waiting.
 *
 * The interaction token is single-use: once `editReply` fails there is nothing
 * left to edit, so the bridge falls back to a channel message instead of letting
 * the command look unanswered.
 */

function fakeInteraction({ channelId = 'c1', failEdit = false } = {}) {
  const calls = { edited: [], replied: [] }
  return {
    calls,
    channelId,
    guildId: 'g1',
    user: { id: 'u1' },
    editReply: async (payload) => {
      if (failEdit) throw new Error('Client network socket disconnected before secure TLS connection was established')
      calls.edited.push(payload)
    },
    reply: async (payload) => calls.replied.push(payload),
  }
}

function fakeTransport() {
  const sent = []
  return {
    sent,
    audit: { record() {} },
    limiter: { run: (fn) => fn() },
    withAudit(category, action, meta, operation) {
      return operation()
    },
    async send(channelId, payload) {
      sent.push({ channelId, payload })
      return { messageId: 'm-fallback' }
    },
  }
}

test('a failed editReply degrades into a channel message', async () => {
  const { DiscordTransport } = await import('../src/discord/transport.js')
  const transport = Object.assign(Object.create(DiscordTransport.prototype), fakeTransport())
  const interaction = fakeInteraction({ failEdit: true })

  await transport.editInteraction(interaction, '权限预设已切换')
  assert.equal(transport.sent.length, 1, 'the answer lands in the channel')
  assert.equal(transport.sent[0].channelId, 'c1')
})

test('a working editReply does not post a second message', async () => {
  const { DiscordTransport } = await import('../src/discord/transport.js')
  const transport = Object.assign(Object.create(DiscordTransport.prototype), fakeTransport())
  const interaction = fakeInteraction()

  await transport.editInteraction(interaction, '权限预设已切换')
  assert.equal(interaction.calls.edited.length, 1)
  assert.equal(transport.sent.length, 0, 'no duplicate channel message')
})

test('network failures are retried by the rate limiter', async () => {
  const { DiscordRateLimiter } = await import('../src/discord/rate-limiter.js')
  let attempts = 0
  const limiter = new DiscordRateLimiter({ logger: { warn() {} }, maxRetries: 2, baseDelayMs: 1 })
  const value = await limiter.run(() => {
    attempts += 1
    if (attempts === 1) {
      const error = new Error('Client network socket disconnected before secure TLS connection was established')
      error.code = 'ECONNRESET'
      throw error
    }
    return 'ok'
  }, 'test')
  assert.equal(value, 'ok')
  assert.equal(attempts, 2, 'one retry was enough')
})

test('a genuinely expired interaction is not retried', async () => {
  const { DiscordRateLimiter } = await import('../src/discord/rate-limiter.js')
  let attempts = 0
  const limiter = new DiscordRateLimiter({ logger: { warn() {} }, maxRetries: 3, baseDelayMs: 1 })
  await assert.rejects(
    () =>
      limiter.run(() => {
        attempts += 1
        const error = new Error('Unknown interaction')
        error.httpStatus = 10062
        throw error
      }, 'test'),
  )
  assert.equal(attempts, 1, 'retrying an expired token cannot help')
})

test('expired autocomplete is silent, real failures still warn', async () => {
  const { reportAutocompleteFailure } = await import('../src/bridge/interactions/index.js')
  const warnings = []
  const logger = { warn: (...args) => warnings.push(args.join(' ')) }

  const expired = new Error('Unknown interaction')
  expired.httpStatus = 10062
  reportAutocompleteFailure(logger, '自动补全', expired)
  assert.deepEqual(warnings, [], 'typing past the picker is not a fault')

  reportAutocompleteFailure(logger, '自动补全', new Error('boom'))
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /boom/)
})
