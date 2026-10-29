import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * `/dsh permission` is the lever a delegating Agent uses before spawning a
 * child: DSH inherits `auto` / `danger-full-access` onto the child and pins the
 * approval policy to `never`, so switching here is the only way to give a
 * subagent wider access.
 */

function fakeRuntime({ preset = 'workspace-write', names = ['workspace-write', 'danger-full-access', 'auto'], apply } = {}) {
  const replies = []
  const sessions = []
  const session = { id: 'session-x', append: (type, data) => sessions.push([type, data]) }
  const presets = {
    names,
    current: () => preset,
    set: (target, name) => {
      assert.equal(target, session, 'the live session is switched')
      preset = name
      apply?.(name)
    },
  }
  return {
    replies,
    sessions,
    preset: () => preset,
    runtime: {
      ctx: { get: (name) => (name === 'permissionPresets' ? presets : undefined) },
      logger: { log() {} },
      audit: { record() {} },
      respond: async (_target, text) => replies.push(text),
      agents: {
        touch: async () => ({ agent: { session } }),
      },
    },
  }
}

const base = { channelId: 'c1', guildId: 'g1', kind: 'channel', target: 'c1' }

test('permission show reports the preset and the delegation rule', async () => {
  const { handlePermissionCommand } = await import('../src/bridge/commands/permission.js')
  const { runtime, replies } = fakeRuntime({ preset: 'workspace-write' })
  await handlePermissionCommand(runtime, { ...base, command: 'show' })
  assert.match(replies[0], /workspace-write/)
  assert.match(replies[0], /danger-full-access/)
  assert.match(replies[0], /子代理会继承/)
})

test('permission set switches through the live service', async () => {
  const { handlePermissionCommand } = await import('../src/bridge/commands/permission.js')
  const applied = []
  const { runtime, replies } = fakeRuntime({ apply: (name) => applied.push(name) })
  await handlePermissionCommand(runtime, { ...base, command: 'set', arg: 'auto' })
  assert.deepEqual(applied, ['auto'])
  assert.match(replies[0], /workspace-write.*→.*auto/)
  assert.match(replies[0], /子代理会继承/)
})

test('an unknown preset is refused instead of applied', async () => {
  const { handlePermissionCommand } = await import('../src/bridge/commands/permission.js')
  const applied = []
  const { runtime, replies } = fakeRuntime({ apply: (name) => applied.push(name) })
  await handlePermissionCommand(runtime, { ...base, command: 'set', arg: 'root' })
  assert.deepEqual(applied, [], 'nothing is switched')
  assert.match(replies[0], /未知预设/)
})

test('a deployment without permissionPresets says so', async () => {
  const { handlePermissionCommand } = await import('../src/bridge/commands/permission.js')
  const runtime = { ctx: { get: () => undefined }, respond: async () => {}, agents: { touch: async () => ({ agent: {} }) } }
  await assert.rejects(
    () => handlePermissionCommand(runtime, { ...base, command: 'show' }),
    /没有挂载 permissionPresets/,
  )
})

test('the guidance tells the root to switch before delegating', async () => {
  const { SUBAGENT_PERMISSION_GUIDE } = await import('../src/bridge/prompt-guidance.js')
  assert.match(SUBAGENT_PERMISSION_GUIDE, /never/)
  assert.match(SUBAGENT_PERMISSION_GUIDE, /\/dsh permission set auto/)
  assert.match(SUBAGENT_PERMISSION_GUIDE, /不会被子代理继承/)
})

test('slash and text forms both reach the permission group', async () => {
  const { parseTextCommand } = await import('../src/discord/commands.js')
  assert.deepEqual(parseTextCommand('!dsh permission set auto'), {
    group: 'permission',
    command: 'set',
    arg: 'auto',
  })
  assert.deepEqual(parseTextCommand('/dsh permission show'), {
    group: 'permission',
    command: 'show',
    arg: undefined,
  })
})
