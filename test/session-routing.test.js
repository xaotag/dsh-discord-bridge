import test from 'node:test'
import assert from 'node:assert/strict'
import { AgentService } from '../src/bridge/agent-service.js'

/** Minimal Session stand-in: only `id` and `header` are read by the tree. */
function session(id, header = {}) {
  return { id, header: { id, ...header } }
}

/** Minimal Agent stand-in: the service reads `session`, `id` and a few methods. */
function agent(id, header = {}, extra = {}) {
  return {
    id,
    session: session(id, header),
    ctx: {},
    whenIdle: async () => {},
    cancel: () => {},
    ...extra,
  }
}

function childAgent(id, parentId, extra = {}) {
  return agent(id, { parentSession: parentId, origin: 'subagent', delegationDepth: 1 }, extra)
}

function collectSink() {
  return {
    toolCalls: [],
    toolResults: [],
    text: [],
    subagents: [],
    onToolCall(name, args) {
      this.toolCalls.push({ name, args })
    },
    onToolResult(result) {
      this.toolResults.push(result)
    },
    onTextDelta(text) {
      this.text.push(text)
    },
    onSubagentEvent(event) {
      this.subagents.push(event)
    },
  }
}

function harness({ agents, conversation = () => undefined, config = {} } = {}) {
  const handlers = new Map()
  const audit = []
  const warnings = []
  const ctx = {
    on(name, handler) {
      if (!handlers.has(name)) handlers.set(name, [])
      handlers.get(name).push(handler)
      return () => {}
    },
    get() {
      return undefined
    },
    agents: agents ?? {
      get: () => undefined,
      create: async () => {
        throw new Error('create not stubbed')
      },
      resume: async () => {
        throw new Error('resume not stubbed')
      },
      list: () => [],
    },
  }
  const state = {
    conversation,
    touchConversation: async () => {},
    setSessionId: async () => {},
    setSettings: async () => {},
  }
  const service = new AgentService({
    ctx,
    config: {
      workspace: '/tmp',
      agentPreset: 'standard',
      provider: 'p',
      model: 'm',
      subagentSettleMs: 1000,
      idleTimeoutMs: 60_000,
      maxLiveSessions: 8,
      ...config,
    },
    state,
    logger: {
      log() {},
      warn: (...parts) => warnings.push(parts.join(' ')),
    },
    audit: {
      record: (entry) => audit.push(entry),
    },
  })
  return { service, ctx, audit, warnings, handlers }
}

/** Attach a root Session through the resume path, as a real run would. */
async function attachRootViaResume({ service, runtime, rootAgent, saved = 'session-root' }) {
  runtime.agent = rootAgent
  service.tree.attachRoot(runtime.key, rootAgent.session)
  return { saved }
}

test('a resumed root Session is attached to its conversation', async () => {
  const root = agent('session-root')
  const handle = { agent: root, dispose: async () => {} }
  const { service } = harness({
    agents: {
      get: () => undefined,
      resume: async () => handle,
      create: async () => {
        throw new Error('create not used')
      },
    },
    conversation: () => ({ sessionId: 'session-root' }),
  })
  const runtime = service.runtime('chan-1', { channelId: 'chan-1' })

  const opened = await service.openAgent(runtime)

  assert.equal(opened, root)
  assert.equal(runtime.agent, root)
  assert.equal(service.resolveAgent(root).key, 'chan-1')
  assert.equal(service.resolveAgent(root).depth, 0)
  assert.equal(service.channelForAgent(root), 'chan-1')
})

test('a created Session is attached to its conversation', async () => {
  let created
  const { service } = harness({
    agents: {
      get: () => undefined,
      resume: async () => {
        throw new Error('resume not used')
      },
      create: async ({ sessionId }) => {
        created = agent(sessionId)
        return { agent: created, dispose: async () => {} }
      },
    },
  })
  const runtime = service.runtime('chan-2', { channelId: 'chan-2' })

  const opened = await service.openAgent(runtime)

  assert.equal(opened, created)
  assert.equal(service.resolveAgent(created).key, 'chan-2')
  // A created Session gets a durable id before the root is attached.
  assert.match(created.id, /^session-discord-/)
})

test('an already-live Session is adopted and attached', async () => {
  const live = agent('session-live')
  const { service } = harness({
    agents: {
      get: (sessionId) => (sessionId === 'session-live' ? live : undefined),
      resume: async () => {
        throw new Error('resume not used')
      },
      create: async () => {
        throw new Error('create not used')
      },
    },
    conversation: () => ({ sessionId: 'session-live' }),
  })
  const runtime = service.runtime('chan-3', { channelId: 'chan-3' })

  assert.equal(await service.openAgent(runtime), live)
  assert.equal(service.resolveAgent(live).key, 'chan-3')
})

test('a delegated child resolves to the parent channel instead of being delegated away', async () => {
  const { service } = harness()
  const runtime = service.runtime('chan-1', { channelId: 'chan-1' })
  const root = agent('session-root')
  await attachRootViaResume({ service, runtime, rootAgent: root })
  const child = childAgent('child-1', 'session-root')

  assert.equal(service.channelForAgent(child), 'chan-1')
  assert.equal(service.resolveAgent(child).depth, 1)
  // Lineage that cannot be followed must stay unowned: never guess a channel.
  assert.equal(service.channelForAgent(agent('stranger')), undefined)
  assert.equal(service.channelForAgent(agent('orphan', { parentSession: 'never-seen' })), undefined)
})

test('the tree grows with catalog facts and reports the child label and depth', async () => {
  const { service } = harness()
  const runtime = service.runtime('chan-1', { channelId: 'chan-1' })
  const root = agent('session-root')
  await attachRootViaResume({ service, runtime, rootAgent: root })
  const sink = collectSink()
  runtime.sink = sink

  service.observeSession(root.session, {
    type: 'subagent/catalog',
    data: { childId: 'child-1', childCreatedAt: 1, version: 1, mode: 'continuable', label: '校验渲染器' },
  })

  assert.deepEqual(
    sink.subagents.map((event) => event.kind),
    ['child-start'],
  )
  assert.equal(sink.subagents[0].child.id, 'child-1')
  assert.equal(sink.subagents[0].child.label, '校验渲染器')
  assert.equal(sink.subagents[0].child.depth, 1)
  assert.equal(service.resolveAgent(childAgent('child-1', 'session-root')).label, '校验渲染器')
  assert.equal(service.subagentCount('chan-1'), 1)
  assert.equal(service.subagentCount('unknown'), 0)
})

test('root tool events keep the existing audit and sink behaviour', async () => {
  const { service, audit } = harness()
  const runtime = service.runtime('chan-1', { channelId: 'chan-1' })
  const root = agent('session-root')
  await attachRootViaResume({ service, runtime, rootAgent: root })
  const sink = collectSink()
  runtime.sink = sink

  service.observeSession(root.session, {
    type: 'tool/call',
    data: { name: 'bash', arguments: '{"command":"ls"}', callId: 'c1' },
  })
  service.observeSession(root.session, {
    type: 'tool/result',
    data: { message: { toolCallId: 'c1', isError: false } },
  })

  assert.equal(sink.toolCalls.length, 1)
  assert.equal(sink.toolCalls[0].name, 'bash')
  assert.equal(sink.toolResults.length, 1)
  assert.deepEqual(
    audit.filter((entry) => entry.category === 'tool').map((entry) => `${entry.action}:${entry.status}`),
    ['call:started', 'result:ok'],
  )
  assert.ok(audit.every((entry) => entry.conversation === 'chan-1'))
})

test('child tool events reach the sink but never pollute the parent audit', async () => {
  const { service, audit } = harness()
  const runtime = service.runtime('chan-1', { channelId: 'chan-1' })
  const root = agent('session-root')
  await attachRootViaResume({ service, runtime, rootAgent: root })
  const sink = collectSink()
  runtime.sink = sink
  const child = childAgent('child-1', 'session-root')

  service.observeSession(child.session, {
    type: 'tool/call',
    data: { name: 'read', arguments: '{"path":"secret.txt"}', callId: 'c1' },
  })
  service.observeSession(child.session, {
    type: 'tool/result',
    data: { message: { toolCallId: 'c1', isError: false } },
  })

  assert.deepEqual(
    sink.subagents.map((event) => event.kind),
    ['tool-call', 'tool-result'],
  )
  assert.equal(sink.subagents[0].name, 'read')
  assert.equal(sink.subagents[0].child.depth, 1)
  assert.equal(audit.filter((entry) => entry.category === 'tool').length, 0)
  assert.equal(service.activeSubagentCount('chan-1'), 1)
})

test('a child turn end closes the child counter without touching the parent status', async () => {
  const { service } = harness()
  const runtime = service.runtime('chan-1', { channelId: 'chan-1' })
  const root = agent('session-root')
  await attachRootViaResume({ service, runtime, rootAgent: root })
  runtime.sink = collectSink()
  const child = childAgent('child-1', 'session-root')
  runtime.status = 'running'

  service.observeSession(child.session, { type: 'tool/call', data: { name: 'read', arguments: '{}' } })
  service.observeSession(child.session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })

  assert.equal(runtime.status, 'running')
  assert.equal(service.activeSubagentCount('chan-1'), 0)
  assert.equal(runtime.sink.subagents.at(-1).kind, 'turn-end')
  assert.equal(runtime.sink.subagents.at(-1).status, 'completed')
})

test('child streaming text is forwarded as a subagent event, not into the parent answer', async () => {
  const { service } = harness()
  const runtime = service.runtime('chan-1', { channelId: 'chan-1' })
  const root = agent('session-root')
  await attachRootViaResume({ service, runtime, rootAgent: root })
  const sink = collectSink()
  runtime.sink = sink
  const child = childAgent('child-1', 'session-root')

  service.observeStream({ agent: root, frame: { type: 'chunk', chunk: { type: 'text-delta', text: '父答案' } } })
  service.observeStream({ agent: child, frame: { type: 'chunk', chunk: { type: 'text-delta', text: '子代理内部文本' } } })

  assert.equal(runtime.streamText, '父答案')
  assert.deepEqual(sink.text, ['父答案'])
  assert.deepEqual(
    sink.subagents.map((event) => ({ kind: event.kind, text: event.text })),
    [{ kind: 'text', text: '子代理内部文本' }],
  )
})

test('an unrelated stream is ignored instead of being filed under a channel', async () => {
  const { service } = harness()
  const runtime = service.runtime('chan-1', { channelId: 'chan-1' })
  const root = agent('session-root')
  await attachRootViaResume({ service, runtime, rootAgent: root })
  runtime.sink = collectSink()

  service.observeStream({ agent: agent('stranger'), frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'x' } } })

  assert.equal(runtime.streamText, '')
  assert.equal(runtime.sink.subagents.length, 0)
})

test('settleChildren waits for a running child and resolves once its turn ends', async () => {
  const { service } = harness()
  const runtime = service.runtime('chan-1', { channelId: 'chan-1' })
  const root = agent('session-root')
  await attachRootViaResume({ service, runtime, rootAgent: root })
  runtime.sink = collectSink()
  const child = childAgent('child-1', 'session-root')

  service.observeSession(child.session, { type: 'tool/call', data: { name: 'read', arguments: '{}' } })
  const settled = service.settleChildren('chan-1', { timeoutMs: 1000 })
  setTimeout(() => {
    service.observeSession(child.session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  }, 40).unref()

  assert.deepEqual(await settled, { settled: true, remaining: 0 })
})

test('settleChildren times out with a count instead of throwing', async () => {
  const { service } = harness()
  const runtime = service.runtime('chan-1', { channelId: 'chan-1' })
  const root = agent('session-root')
  await attachRootViaResume({ service, runtime, rootAgent: root })
  runtime.sink = collectSink()
  const child = childAgent('child-1', 'session-root')

  service.observeSession(child.session, { type: 'tool/call', data: { name: 'read', arguments: '{}' } })
  const result = await service.settleChildren('chan-1', { timeoutMs: 60 })

  assert.deepEqual(result, { settled: false, remaining: 1 })
})

test('settleChildren returns immediately when no child is running', async () => {
  const { service } = harness()
  const runtime = service.runtime('chan-1', { channelId: 'chan-1' })
  const root = agent('session-root')
  await attachRootViaResume({ service, runtime, rootAgent: root })

  assert.deepEqual(await service.settleChildren('chan-1', { timeoutMs: 60_000 }), {
    settled: true,
    remaining: 0,
  })
  // A zero budget disables the wait even while a child is running.
  runtime.sink = collectSink()
  const child = childAgent('child-1', 'session-root')
  service.observeSession(child.session, { type: 'tool/call', data: { name: 'read', arguments: '{}' } })
  assert.deepEqual(await service.settleChildren('chan-1', { timeoutMs: 0 }), {
    settled: false,
    remaining: 1,
  })
})

test('dispose interrupts a pending settleChildren wait', async () => {
  const { service } = harness()
  const runtime = service.runtime('chan-1', { channelId: 'chan-1' })
  const root = agent('session-root')
  await attachRootViaResume({ service, runtime, rootAgent: root })
  runtime.sink = collectSink()
  runtime.handle = { agent: root, dispose: async () => {} }
  const child = childAgent('child-1', 'session-root')
  service.observeSession(child.session, { type: 'tool/call', data: { name: 'read', arguments: '{}' } })

  const startedAt = Date.now()
  const waiting = service.settleChildren('chan-1', { timeoutMs: 5000 })
  await new Promise((resolve) => setTimeout(resolve, 20))
  await service.dispose()
  const result = await waiting

  assert.ok(Date.now() - startedAt < 2000, 'dispose unblocked the wait instead of timing it out')
  assert.equal(result.settled, false)
  // dispose() drops the whole tree, so a later event cannot resurrect the child.
  assert.equal(service.resolveAgent(child), undefined)
})

test('releasing a runtime forgets its root and delegated children', async () => {
  const { service } = harness()
  const runtime = service.runtime('chan-1', { channelId: 'chan-1' })
  const root = agent('session-root')
  await attachRootViaResume({ service, runtime, rootAgent: root })
  runtime.handle = { agent: root, dispose: async () => {} }
  runtime.sink = collectSink()
  const child = childAgent('child-1', 'session-root')
  service.observeSession(child.session, { type: 'tool/call', data: { name: 'read', arguments: '{}' } })
  assert.equal(service.subagentCount('chan-1'), 1, 'the resolved child is visible in the tree')

  await service.releaseRuntime(runtime)

  assert.equal(service.resolveAgent(root), undefined)
  assert.equal(service.resolveAgent(child), undefined)
  assert.equal(service.channelForAgent(child), undefined)
  assert.equal(service.subagentCount('chan-1'), 0)
  assert.equal(service.activeSubagentCount('chan-1'), 0)
})

test('an agent disposal detaches its root and children', async () => {
  const { service, handlers } = harness()
  const runtime = service.runtime('chan-1', { channelId: 'chan-1' })
  const root = agent('session-root')
  await attachRootViaResume({ service, runtime, rootAgent: root })
  const child = childAgent('child-1', 'session-root')
  service.observeSession(child.session, { type: 'tool/call', data: { name: 'read', arguments: '{}' } })
  assert.equal(service.channelForAgent(child), 'chan-1')

  for (const handler of handlers.get('agent/disposed') || []) handler({ agent: root })

  assert.equal(runtime.agent, undefined)
  assert.equal(service.resolveAgent(root), undefined)
  assert.equal(service.channelForAgent(child), undefined)
})

test('a disposed child stops blocking the parent settle wait', async () => {
  const { service, handlers } = harness()
  const runtime = service.runtime('chan-1', { channelId: 'chan-1' })
  const root = agent('session-root')
  await attachRootViaResume({ service, runtime, rootAgent: root })
  runtime.sink = collectSink()
  const child = childAgent('child-1', 'session-root')
  service.observeSession(child.session, { type: 'tool/call', data: { name: 'read', arguments: '{}' } })
  assert.equal(service.activeSubagentCount('chan-1'), 1)

  for (const handler of handlers.get('agent/disposed') || []) handler({ agent: child })

  assert.equal(service.activeSubagentCount('chan-1'), 0)
  // The root runtime is untouched: only the child was disposed.
  assert.equal(service.channelForAgent(root), 'chan-1')
})
