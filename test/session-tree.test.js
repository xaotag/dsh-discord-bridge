import test from 'node:test'
import assert from 'node:assert/strict'
import { SessionTree, fallbackLabel, trimLabel } from '../src/bridge/session-tree.js'

/** Minimal Session stand-in: only `id` and `header` are read by the tree. */
function session(id, header = {}) {
  return { id, header: { id, ...header } }
}

test('a root session resolves to its own conversation', () => {
  const tree = new SessionTree()
  tree.attachRoot('channel-1', session('root'))
  assert.deepEqual(tree.resolve(session('root')), {
    key: 'channel-1',
    rootId: 'root',
    sessionId: 'root',
    parentId: undefined,
    depth: 0,
    label: undefined,
  })
})

test('a catalog fact names the child and its approvals resolve to the parent channel', () => {
  const tree = new SessionTree()
  tree.attachRoot('channel-1', session('root'))
  tree.learnChild('root', { childId: 'child', label: '校验渲染器', mode: 'continuable' })

  const entry = tree.resolve(session('child', { parentSession: 'root', origin: 'subagent', delegationDepth: 1 }))
  assert.equal(entry.key, 'channel-1')
  assert.equal(entry.depth, 1)
  assert.equal(entry.label, '校验渲染器')
  assert.equal(entry.parentId, 'root')
})

test('without a catalog fact the child still resolves, under a fallback label', () => {
  const tree = new SessionTree()
  tree.attachRoot('channel-1', session('root'))
  const entry = tree.resolve(session('abcdef123456', { parentSession: 'root', origin: 'subagent' }))
  assert.equal(entry.depth, 1)
  assert.equal(entry.label, fallbackLabel('abcdef123456'))
  assert.match(entry.label, /^子代理 /)
})

test('grandchildren inherit the conversation and their depth', () => {
  const tree = new SessionTree()
  tree.attachRoot('channel-1', session('root'))
  tree.learnChild('root', { childId: 'child', label: 'A' })
  tree.learnChild('child', { childId: 'grandchild', label: 'B' })

  const entry = tree.resolve(session('grandchild', { parentSession: 'child', origin: 'subagent', delegationDepth: 2 }))
  assert.equal(entry.key, 'channel-1')
  assert.equal(entry.depth, 2)
  assert.equal(entry.label, 'B')
  assert.equal(tree.childCount('channel-1'), 2)
})

test('an unrelated session is not filed under any conversation', () => {
  const tree = new SessionTree()
  tree.attachRoot('channel-1', session('root'))
  assert.equal(tree.resolve(session('someone-else')), undefined)
  assert.equal(tree.resolve(session('orphan', { parentSession: 'never-seen' })), undefined)
  assert.equal(tree.childCount('channel-1'), 0)
})

test('a child observed before its root is adopted when the root is attached', () => {
  const tree = new SessionTree()
  const child = session('child', { parentSession: 'root' })
  assert.equal(tree.resolve(child), undefined)
  tree.attachRoot('channel-1', session('root'))
  const entry = tree.resolve(child)
  assert.equal(entry.key, 'channel-1')
  assert.equal(entry.depth, 1)
})

test('detaching a conversation forgets its root and descendants', () => {
  const tree = new SessionTree()
  tree.attachRoot('channel-1', session('root'))
  tree.learnChild('root', { childId: 'child', label: 'A' })
  tree.resolve(session('child', { parentSession: 'root' }))

  tree.detachRoot('channel-1')
  assert.equal(tree.resolve(session('root')), undefined)
  assert.equal(tree.resolve(session('child', { parentSession: 'root' })), undefined)
})

test('a lineage cycle terminates instead of hanging', () => {
  const tree = new SessionTree()
  // Nothing anchors this pair to a conversation, so the walk must give up.
  tree.learnChild('a', { childId: 'b', label: 'B' })
  tree.learnChild('b', { childId: 'a', label: 'A' })
  assert.equal(tree.resolve(session('a', { parentSession: 'b' })), undefined)
})

test('long catalog labels are trimmed for cards', () => {
  assert.equal(trimLabel('  校验   渲染器  '), '校验 渲染器')
  const long = trimLabel('x'.repeat(60))
  assert.equal(long.length, 32)
  assert.ok(long.endsWith('…'))
})
