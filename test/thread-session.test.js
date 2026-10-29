import test from 'node:test'
import assert from 'node:assert/strict'
import { conversationKeyFor } from '../src/bridge/runtime.js'
import { runPrompt } from '../src/bridge/prompt-runner.js'

/** Just enough runtime for the conversation-key decision. */
function fakeRuntime({ sessioned = [] } = {}) {
  const sessions = new Set(sessioned)
  return {
    state: {
      hasSession: (key) => sessions.has(key),
      conversation: () => undefined,
    },
  }
}

test('a plain channel owns its own conversation', () => {
  const runtime = fakeRuntime()
  assert.equal(conversationKeyFor(runtime, { channelId: 'chan', kind: 'channel' }), 'chan')
})

test('a direct message owns its own conversation', () => {
  const runtime = fakeRuntime()
  assert.equal(conversationKeyFor(runtime, { channelId: 'dm', kind: 'dm' }), 'dm')
})

test('a thread inherits the conversation it was created from', () => {
  const runtime = fakeRuntime()
  assert.equal(
    conversationKeyFor(runtime, { channelId: 'thread-1', kind: 'thread', parentId: 'chan' }),
    'chan',
  )
})

test('a thread that already owns a Session keeps it', () => {
  // Bindings made before threads inherited context must not jump to the parent.
  const runtime = fakeRuntime({ sessioned: ['thread-1'] })
  assert.equal(
    conversationKeyFor(runtime, { channelId: 'thread-1', kind: 'thread', parentId: 'chan' }),
    'thread-1',
  )
})

test('a thread without a known parent falls back to itself', () => {
  const runtime = fakeRuntime()
  assert.equal(conversationKeyFor(runtime, { channelId: 'thread-1', kind: 'thread' }), 'thread-1')
})

test('an auto-created thread does not take the Session with it', async () => {
  const sent = []
  const runs = []
  const runtime = {
    config: {
      autoThread: true,
      complexityThreshold: 10,
      streamEditIntervalMs: 1500,
      subagentThreads: false,
    },
    state: { hasSession: () => false, conversation: () => undefined },
    ctx: { get: () => undefined },
    subagentThreads: new Map(),
    logger: { log() {}, warn() {} },
    threads: {
      async create() {
        return { channelId: 'thread-1' }
      },
    },
    transport: {
      async send(channelId, payload) {
        sent.push({ channelId, payload })
        return { messageId: 'm1' }
      },
      async edit() {},
    },
    agents: {
      async run(key, meta, prompt, reporter) {
        runs.push({ key, meta, prompt, channelId: reporter.channelId })
        return { text: '好的', status: 'completed' }
      },
    },
  }

  const result = await runPrompt(runtime, {
    channelId: 'chan',
    guildId: 'guild',
    kind: 'channel',
    prompt: '帮我重构这个模块，很复杂',
    placeholder: { messageId: 'p1' },
    replyToMessageId: 'r1',
    boundChannelId: 'chan',
  })

  // The answer renders in the thread, but the turn stays in the channel's
  // conversation — the regression that created one Session per thread.
  assert.equal(runs.length, 1)
  assert.equal(runs[0].key, 'chan')
  assert.equal(runs[0].meta.channelId, 'chan')
  assert.equal(runs[0].channelId, 'thread-1')
  assert.equal(result.threadId, 'thread-1')
  assert.ok(sent.some((item) => item.channelId === 'thread-1'))
})

test('a message already in a thread reuses the parent conversation', async () => {
  const runs = []
  const runtime = {
    config: { autoThread: true, complexityThreshold: 10, streamEditIntervalMs: 1500, subagentThreads: false },
    state: { hasSession: () => false, conversation: () => undefined },
    ctx: { get: () => undefined },
    subagentThreads: new Map(),
    logger: { log() {}, warn() {} },
    threads: { async create() { return undefined } },
    transport: { async send() { return { messageId: 'm2' } }, async edit() {} },
    agents: {
      async run(key, meta) {
        runs.push({ key, meta })
        return { text: '好', status: 'completed' }
      },
    },
  }
  await runPrompt(runtime, {
    channelId: 'thread-2',
    guildId: 'guild',
    kind: 'thread',
    prompt: '继续刚才那个改动',
    attachmentCount: 0,
    boundChannelId: conversationKeyFor(runtime, {
      channelId: 'thread-2',
      kind: 'thread',
      parentId: 'chan',
    }),
  })
  assert.equal(runs[0].key, 'chan')
})
