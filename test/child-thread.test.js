import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { StateStore } from '../src/state-store.js'
import { runChildPrompt } from '../src/bridge/child-prompt.js'

function fakeChild() {
  return {
    id: 'child-1',
    messages: [],
    whenIdleCalls: 0,
    followup(message) {
      this.messages.push(message)
    },
    async whenIdle() {
      this.whenIdleCalls += 1
    },
  }
}

function fakeRuntime({ child, childLive = true, subagents, audits = [] } = {}) {
  const sent = []
  const edits = []
  let sink
  const agents = {
    childAgent: () => (childLive ? (child ??= fakeChild()) : undefined),
    bindChildSink: (_id, bound) => {
      sink = bound
      // Stand in for the child's streaming turn.
      sink.onTextDelta('子代理的回答')
    },
    unbindChildSink: () => {
      sink = undefined
    },
    ensureConversationAgent: async () => ({ id: 'parent-session' }),
  }
  return {
    sent,
    edits,
    getSink: () => sink,
    runtime: {
      config: { streamEditIntervalMs: 1500 },
      logger: { log() {}, warn() {} },
      state: { conversation: () => undefined },
      ctx: { get: (name) => (name === 'subagents' ? subagents : undefined) },
      transport: {
        async send(channelId, payload) {
          sent.push({ channelId, payload })
          return { messageId: `m${sent.length}` }
        },
        async edit(channelId, messageId, payload) {
          edits.push({ channelId, messageId, payload })
        },
      },
      audit: { record: (entry) => audits.push(entry) },
      agents,
    },
  }
}

test('a reply in a child thread continues the child, not a new Session', async () => {
  const child = fakeChild()
  const audits = []
  const { runtime, sent, edits } = fakeRuntime({ child, audits })

  const result = await runChildPrompt(runtime, {
    childId: 'child-1',
    conversationKey: 'parent-channel',
    channelId: 'child-thread',
    prompt: '继续把测试补完',
    replyToMessageId: 'msg-1',
    label: '校验渲染器',
  })

  assert.equal(result.status, 'completed')
  assert.equal(child.messages.length, 1)
  assert.equal(child.messages[0].content[0].text, '继续把测试补完')
  assert.equal(child.whenIdleCalls, 1)
  assert.match(result.text, /子代理的回答/)
  // Everything is posted into the thread; no Session is created anywhere.
  assert.ok(sent.every((item) => item.channelId === 'child-thread'))
  assert.ok(edits.every((item) => item.channelId === 'child-thread'))
  assert.ok(audits.some((entry) => entry.action === 'child.run.end' && entry.sessionId === 'child-1'))
})

test('a parked child is cold-resumed through the subagent service', async () => {
  const prompts = []
  const child = fakeChild()
  let live = false
  const subagents = {
    async prompt(request) {
      prompts.push(request)
      live = true
      return { messageId: 'inbox-1' }
    },
  }
  const { runtime } = fakeRuntime({ childLive: false, subagents })
  runtime.agents.childAgent = () => (live ? child : undefined)

  const result = await runChildPrompt(runtime, {
    childId: 'child-9',
    conversationKey: 'parent-channel',
    channelId: 'child-thread',
    prompt: '接着说',
  })

  assert.equal(result.status, 'completed')
  assert.equal(prompts.length, 1)
  assert.equal(prompts[0].childSessionId, 'child-9')
  assert.equal(prompts[0].mode, 'continuable')
  assert.equal(prompts[0].delivery, 'queue')
  assert.deepEqual(prompts[0].content, [{ type: 'text', text: '接着说' }])
  // The continuation already carried the message; it must not be sent twice.
  assert.equal(child.messages.length, 0)
})

test('when the child cannot be resumed the thread stays read-only', async () => {
  const { runtime, sent } = fakeRuntime({ childLive: false })

  const result = await runChildPrompt(runtime, {
    childId: 'child-404',
    conversationKey: 'parent-channel',
    channelId: 'child-thread',
    prompt: '还在吗',
    label: '旧子代理',
  })

  assert.equal(result.status, 'unavailable')
  const notice = sent.find((item) => JSON.stringify(item.payload).includes('不会新开 Session'))
  assert.ok(notice, 'expected a notice explaining no Session was created')
})

test('thread bindings survive a restart', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-thread-binding-'))
  const file = path.join(dir, 'state.json')
  try {
    const first = new StateStore(file)
    await first.load()
    await first.setThreadAgent('thread-1', { childId: 'child-1', conversationKey: 'chan', label: 'A' })
    await first.close()

    const second = new StateStore(file)
    await second.load()
    assert.deepEqual(second.threadAgent('thread-1')?.childId, 'child-1')
    assert.equal(second.threadForChild('child-1'), 'thread-1')

    await second.forgetThreadAgent('thread-1')
    assert.equal(second.threadAgent('thread-1'), undefined)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})
