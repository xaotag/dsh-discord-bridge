import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * DSH >= 0.2.2 fixes the request route during step preparation: `agent/request`
 * may not change provider/model (the loop throws). The bridge must therefore
 * record switches through `agent.model.select()` instead.
 */

test('the bridge never patches agent/request to change the route', async () => {
  const { readFile } = await import('node:fs/promises')
  const url = new URL('../src/bridge/agent-service.js', import.meta.url)
  const source = await readFile(url, 'utf8')
  assert.ok(
    !/on\(\s*['"]agent\/request['"]/.test(source),
    'agent/request listeners may not touch the prepared route',
  )
  assert.match(source, /agent\.model\.select/, 'route changes go through agent.model.select()')
})

test('applyModelSelection records provider, model and effort', async () => {
  const { AgentService } = await import('../src/bridge/agent-service.js')
  const calls = []
  const agent = { model: { select: (selection) => calls.push(selection) } }
  const service = new AgentService({
    ctx: { on: () => () => {}, get: () => undefined },
    config: { provider: 'p', model: 'm' },
    state: {},
    logger: { log() {}, warn() {} },
    audit: { record() {} },
  })
  assert.equal(service.applyModelSelection(agent, { provider: 'a', model: 'b' }), true)
  assert.deepEqual(calls[0], { provider: 'a', model: 'b' })
  assert.equal(service.applyModelSelection(agent, { provider: 'a', model: 'c', reasoningEffort: 'high' }), true)
  assert.deepEqual(calls[1], { provider: 'a', model: 'c', reasoningEffort: 'high' })
})

test('a route without provider/model is ignored, and so is an Agent without model', async () => {
  const { AgentService } = await import('../src/bridge/agent-service.js')
  const calls = []
  const service = new AgentService({
    ctx: { on: () => () => {}, get: () => undefined },
    config: { provider: 'p', model: 'm' },
    state: {},
    logger: { log() {}, warn() {} },
    audit: { record() {} },
  })
  assert.equal(service.applyModelSelection({ model: { select: (s) => calls.push(s) } }, { provider: 'a' }), false)
  assert.equal(service.applyModelSelection({}, { provider: 'a', model: 'b' }), false)
  assert.equal(service.applyModelSelection(undefined, { provider: 'a', model: 'b' }), false)
  assert.deepEqual(calls, [], 'nothing is recorded for an incomplete route')
})

test('setSettings records the new route on the live Agent', async () => {
  const { AgentService } = await import('../src/bridge/agent-service.js')
  const calls = []
  const agent = {
    id: 'sess-1',
    ctx: { on: () => () => {} },
    options: { provider: 'p', model: 'm' },
    model: { select: (selection) => calls.push(selection) },
  }
  const service = new AgentService({
    ctx: { on: () => () => {}, get: () => undefined },
    config: { provider: 'p', model: 'm' },
    state: {
      conversation: () => ({ provider: 'p', model: 'm', sessionId: 'sess-1' }),
      setSettings: async () => {},
    },
    logger: { log() {}, warn() {} },
    audit: { record() {} },
  })
  service.runtime('c1').agent = agent
  const sessionId = await service.setSettings('c1', { provider: 'deepseek-official', model: 'deepseek-pro' })
  assert.equal(sessionId, 'sess-1')
  assert.deepEqual(calls.at(-1), { provider: 'deepseek-official', model: 'deepseek-pro' })
})
