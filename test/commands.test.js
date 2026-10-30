import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * Every `/dsh` subcommand, exercised through its handler.
 *
 * These are the paths a Discord user actually reaches, and they share one
 * `runtime` bag. A test per command keeps a rename or a dropped branch from
 * surfacing only when someone types the command in a channel.
 */

/** Minimal runtime whose collaborator calls are recorded. */
function fakeRuntime(overrides = {}) {
  const replies = []
  const calls = { stop: 0, steer: [], touch: [], bind: [], list: 0, listModels: 0 }
  const runtime = {
    replies,
    calls,
    audit: { record() {} },
    logger: { log() {}, warn() {} },
    config: { provider: 'deepseek-official', pollIntervalMs: 1000 },
    respond: async (_target, text) => replies.push(String(text)),
    agents: {
      touch: async (key) => {
        calls.touch.push(key)
        return { agent: { id: 'sess-1' }, key }
      },
      status: () => 'Session: `sess-1`\n状态: 空闲',
      listSessions: async () => {
        calls.list += 1
        return [
          { id: 'session-a', title: '任务 A', status: 'live' },
          { id: 'session-b', title: '', status: 'persisted' },
        ]
      },
      isLiveOrPersisted: async () => true,
      bindSession: async (key, id) => {
        calls.bind.push([key, id])
        return id
      },
      stop: async () => {
        calls.stop += 1
        return true
      },
      steer: async (_key, text) => calls.steer.push(text),
      listModels: async () => {
        calls.listModels += 1
        return [{ provider: 'deepseek-official', id: 'deepseek-flash', name: 'Flash' }]
      },
      listReasoningEfforts: async () => ['off', 'low', 'high'],
      setSettings: async (key, settings) => {
        calls.settings = [key, settings]
        calls.settingsHistory = [...(calls.settingsHistory || []), [key, settings]]
        return 'sess-1'
      },
      agentOptions: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }),
    },
    threads: {
      create: async (_channelId, name) => ({ channelId: 'thread-1', name }),
    },
    transport: { client: { ws: { ping: 42 } } },
    privileged: { available: () => false },
    ...overrides,
  }
  return runtime
}

const base = { channelId: 'c1', conversationKey: 'c1', guildId: 'g1', kind: 'channel', target: 'c1' }

test('session status / list / bind / stop all answer', async () => {
  const { handleSessionCommand } = await import('../src/bridge/commands/session.js')
  const runtime = fakeRuntime()

  await handleSessionCommand(runtime, { ...base, command: 'status' })
  assert.match(runtime.replies[0], /sess-1/)

  await handleSessionCommand(runtime, { ...base, command: 'list' })
  assert.match(runtime.replies[1], /任务 A/)
  assert.match(runtime.replies[1], /session-b/, 'untitled sessions still list by id')

  await handleSessionCommand(runtime, { ...base, command: 'bind', arg: 'session-a' })
  assert.deepEqual(runtime.calls.bind.at(-1), ['c1', 'session-a'])
  assert.match(runtime.replies[2], /绑定/)

  await handleSessionCommand(runtime, { ...base, command: 'stop' })
  assert.equal(runtime.calls.stop, 1)
  assert.match(runtime.replies[3], /已请求停止/)
})

test('session bind without an id explains how to find one', async () => {
  const { handleSessionCommand } = await import('../src/bridge/commands/session.js')
  const runtime = fakeRuntime()
  await handleSessionCommand(runtime, { ...base, command: 'bind', arg: '' })
  assert.match(runtime.replies[0], /update|用法|session list/i)
})

test('session new is gone', async () => {
  const { handleSessionCommand } = await import('../src/bridge/commands/session.js')
  const runtime = fakeRuntime()
  const handled = await handleSessionCommand(runtime, { ...base, command: 'new' })
  assert.equal(handled, false, 'unknown subcommands fall through')
  assert.equal(runtime.replies.length, 0)
})

test('model list / set / reasoning switch the route', async () => {
  const { handleModelCommand } = await import('../src/bridge/commands/model.js')
  const runtime = fakeRuntime()

  await handleModelCommand(runtime, { ...base, command: 'list' })
  assert.equal(runtime.calls.listModels, 1)
  assert.match(runtime.replies[0], /deepseek-flash/)

  await handleModelCommand(runtime, { ...base, command: 'set', arg: 'deepseek-official/deepseek-pro' })
  assert.deepEqual(runtime.calls.settings, [
    'c1',
    { provider: 'deepseek-official', model: 'deepseek-pro' },
  ])
  assert.match(runtime.replies[1], /已切换模型/)

  await handleModelCommand(runtime, { ...base, command: 'reasoning', arg: 'high' })
  assert.deepEqual(runtime.calls.settingsHistory.at(-1), ['c1', { reasoningEffort: 'high' }])
  assert.match(runtime.replies[2], /推理/)
})

test('an invalid model value or effort is refused with guidance', async () => {
  const { handleModelCommand } = await import('../src/bridge/commands/model.js')
  const runtime = fakeRuntime()
  await assert.rejects(
    () => handleModelCommand(runtime, { ...base, command: 'set', arg: '' }),
    /用法/,
  )
  // An unsupported effort is reported, not thrown: the operator can see the list.
  await handleModelCommand(runtime, { ...base, command: 'reasoning', arg: 'ultra' })
  assert.match(runtime.replies.at(-1), /不是当前模型支持的推理等级/)
  assert.equal(runtime.calls.settings, undefined, 'nothing is applied')
})

test('task ask / steer / stop route through the shared pieces', async () => {
  const { handleTaskCommand } = await import('../src/bridge/commands/task.js')
  const runtime = fakeRuntime()
  const { handleTaskCommand: run } = await import('../src/bridge/commands/task.js')
  await run(runtime, { ...base, command: 'steer', arg: '往左一点' })
  assert.deepEqual(runtime.calls.steer, ['往左一点'])

  await run(runtime, { ...base, command: 'stop' })
  assert.equal(runtime.calls.stop, 1)

  await assert.rejects(() => run(runtime, { ...base, command: 'steer', arg: '' }), /用法/)
})

test('thread create and info answer', async () => {
  const { handleThreadCommand } = await import('../src/bridge/commands/thread.js')
  const runtime = fakeRuntime()
  await handleThreadCommand(runtime, { ...base, command: 'create', arg: '子任务' })
  assert.match(runtime.replies[0], /<#thread-1>/)

  await handleThreadCommand(runtime, { ...base, command: 'info' })
  assert.match(runtime.replies[1], /c1/)
  assert.match(runtime.replies[1], /guild|Guild|g1/)
})

test('system help / audit / ping respond, confirm is gone', async () => {
  const { handleSystemCommand } = await import('../src/bridge/commands/system.js')
  const runtime = fakeRuntime()
  runtime.audit = {
    record() {},
    recent: async () => [{ iso: '2026-10-30T00:00:00Z', category: 'discord', action: 'message.send', status: 'ok' }],
  }

  await handleSystemCommand(runtime, { ...base, command: 'help' })
  assert.match(runtime.replies[0], /\/dsh session/)

  await handleSystemCommand(runtime, { ...base, command: 'ping' })
  assert.match(runtime.replies[1], /42/)

  const handled = await handleSystemCommand(runtime, { ...base, command: 'confirm', arg: 'x' })
  assert.equal(handled, false, 'confirm no longer has a branch')
})

test('removed commands are rejected with a clear error, not silently ignored', async () => {
  const { handleCommand } = await import('../src/bridge/commands/index.js')
  const runtime = fakeRuntime()
  for (const [group, command] of [
    ['session', 'new'],
    ['system', 'confirm'],
  ]) {
    await assert.rejects(
      () => handleCommand(runtime, { ...base, group, command }),
      new RegExp(`未知命令.*${command}`),
      `${group} ${command} was removed`,
    )
  }
  assert.equal(runtime.replies.length, 0, 'nothing was answered')
  assert.equal(runtime.calls.settings, undefined, 'nothing was applied')
})

test('the slash tree and help text agree on the command surface', async () => {
  const { dshCommand, HELP_TEXT } = await import('../src/discord/commands.js')
  const tree = dshCommand.toJSON()
  const groups = tree.options.map((group) => group.name)
  for (const group of groups) assert.ok(HELP_TEXT.includes(`/dsh ${group}`), `${group} appears in help`)

  const subs = tree.options.flatMap((group) => group.options.map((sub) => `${group.name} ${sub.name}`))
  assert.ok(!subs.includes('session new'), 'session new is gone from the slash tree')
  assert.ok(!subs.includes('system confirm'), 'system confirm is gone from the slash tree')
  assert.match(HELP_TEXT, /`sudo <命令>`/)
})
