import test from 'node:test'
import assert from 'node:assert/strict'
import { nonNegativeNumber, resolveConfig } from '../src/config.js'

test('subagent settle defaults to two minutes', () => {
  assert.equal(resolveConfig({}).subagentSettleMs, 120000)
})

test('subagent settle accepts zero, which disables the wait', () => {
  assert.equal(resolveConfig({ subagentSettleMs: 0 }).subagentSettleMs, 0)
  assert.equal(resolveConfig({ subagentSettleMs: '0' }).subagentSettleMs, 0)
})

test('subagent settle rejects garbage instead of hanging the turn', () => {
  assert.equal(resolveConfig({ subagentSettleMs: 'soon' }).subagentSettleMs, 120000)
  assert.equal(resolveConfig({ subagentSettleMs: -5 }).subagentSettleMs, 120000)
  assert.equal(nonNegativeNumber(undefined, 7), 7)
})
