import assert from 'node:assert/strict'
import test from 'node:test'

test('a subagent gets its own thread with an activity card', async () => {
  const { SubagentThreads, subagentActivityCard } = await import('../src/bridge/subagent-threads.js')
  const created = []
  const sent = []
  const edited = []
  const links = []
  const transport = {
    createThread: async (channelId, name, archive) => {
      created.push({ channelId, name, archive })
      return { channelId: 't1', name }
    },
    send: async (channelId, payload) => {
      sent.push({ channelId, payload })
      return { messageId: 'm1' }
    },
    edit: async (channelId, messageId, payload) => {
      edited.push({ channelId, messageId, payload })
      return undefined
    },
  }
  const cards = new SubagentThreads({
    transport,
    parentChannelId: 'c1',
    refreshMs: 0,
    onThread: (childId, threadId) => links.push({ childId, threadId }),
  })

  const child = {
    id: 's1',
    label: '校验渲染器',
    depth: 1,
    running: true,
    status: 'running',
    text: '正在读文件',
    name: 'read',
    args: '{"file_path":"src/a.js"}',
  }
  cards.track(child)
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.equal(created.length, 1, 'one thread per child')
  assert.match(created[0].name, /校验渲染器/)
  assert.equal(created[0].channelId, 'c1', 'thread hangs under the parent channel')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].channelId, 't1')
  assert.deepEqual(links, [{ childId: 's1', threadId: 't1' }])

  // A later event edits the same card instead of posting another message.
  child.name = 'bash'
  child.args = '{"description":"跑测试"}'
  cards.track(child)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(sent.length, 1, 'no second message')
  assert.ok(edited.length >= 1)
  assert.equal(edited.at(-1).messageId, 'm1')

  cards.track({ ...child, running: false, status: 'completed' })
  await cards.closeAll()
  const final = edited.at(-1).payload.components[0]
  assert.equal(final.accent_color, 0x57f287, 'finished children turn green')
})

test('thread creation is best-effort and can be switched off', async () => {
  const { SubagentThreads } = await import('../src/bridge/subagent-threads.js')
  const calls = []
  const failing = {
    createThread: async () => {
      calls.push('create')
      throw new Error('当前频道不能创建 Thread')
    },
    send: async () => ({ messageId: 'm1' }),
    edit: async () => undefined,
  }
  const warns = []
  const cards = new SubagentThreads({
    transport: failing,
    parentChannelId: 'c1',
    refreshMs: 0,
    logger: { warn: (message) => warns.push(message) },
  })
  assert.equal(cards.track({ id: 's1', running: true }), undefined)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(calls.length, 1)
  assert.equal(warns.length, 1, 'the failure is logged, not thrown')

  const disabled = new SubagentThreads({
    transport: failing,
    parentChannelId: 'c1',
    enabled: false,
  })
  assert.equal(disabled.track({ id: 's1', running: true }), undefined)
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(calls.length, 1, 'disabled mode never creates a thread')
})

test('the activity card colours itself by the child state', async () => {
  const { subagentActivityCard, summarizeChildText } = await import('../src/bridge/subagent-threads.js')
  const running = subagentActivityCard({ label: 'a', running: true, depth: 1 })
  assert.equal(running.components[0].accent_color, 0xfaa61a, 'amber while running')
  const failed = subagentActivityCard({ label: 'a', running: false, status: 'failed', depth: 1 })
  assert.equal(failed.components[0].accent_color, 0xed4245, 'red when the child failed')
  const done = subagentActivityCard({ label: 'a', running: false, status: 'completed', depth: 1 })
  assert.equal(done.components[0].accent_color, 0x57f287, 'green when the child finished')

  const long = 'x'.repeat(600)
  assert.ok(summarizeChildText(long).length <= 400)
  assert.match(summarizeChildText(long), /…$/)
})

test('the parent card links to a child thread once it exists', async () => {
  const { finalCard } = await import('../src/discord/cards-v2.js')
  const payload = finalCard('done', 'completed', {
    subagents: [
      { label: '校验渲染器', running: false, status: 'completed', name: 'read', threadId: 't9' },
    ],
  })
  const texts = []
  const walk = (nodes) => {
    for (const node of nodes || []) {
      if (node.type === 10) texts.push(String(node.content ?? ''))
      walk(node.components)
    }
  }
  walk(payload.components)
  assert.ok(texts.some((text) => text.includes('<#t9>')), 'thread link is rendered')
})
