import test from 'node:test'
import assert from 'node:assert/strict'
import { StreamReporter } from '../src/bridge/stream-reporter.js'
import { ApprovalRegistry } from '../src/bridge/approval.js'
import { QuestionRegistry } from '../src/bridge/question-registry.js'
import {
  MAX_SUBAGENT_LINES,
  approvalCard,
  questionCard,
  streamCard,
  subagentBlock,
} from '../src/discord/cards-v2.js'
import { answerApprovalRequest, resolveRequestAgent } from '../src/bridge/interactions/approval.js'
import { answerUserQuestions } from '../src/bridge/interactions/question.js'
import { DELEGATE } from '../src/bridge/runtime.js'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Collect every Text Display's content from a Components V2 payload. */
function flattenTexts(nodes) {
  const out = []
  const walk = (list) => {
    for (const node of list || []) {
      if (!node) continue
      if (node.type === 10) out.push(String(node.content ?? ''))
      if (node.components) walk(node.components)
    }
  }
  walk(nodes)
  return out
}

/** Find a button custom_id anywhere in a component tree. */
function findCustomId(nodes, wanted) {
  const walk = (list) => {
    for (const node of list || []) {
      if (!node) continue
      if (node.custom_id === wanted) return node.custom_id
      const nested = walk(node.components)
      if (nested) return nested
    }
    return undefined
  }
  return walk(nodes)
}

function fakeTransport() {
  const calls = { edits: [], sends: [] }
  return {
    calls,
    async send(channelId, payload) {
      calls.sends.push(payload)
      return { channelId, messageId: `m${calls.sends.length}` }
    },
    async edit(channelId, messageId, payload) {
      calls.edits.push({ messageId, payload })
    },
  }
}

test('streamCard renders the subagent block after the body, leaving tools alone', () => {
  const payload = streamCard('父答案正文', {
    tools: [{ name: 'read', args: '{"file_path":"src/x.js"}', startedAt: 1, endedAt: 2 }],
    subagents: [
      {
        id: 'child-1',
        label: '校验渲染器',
        depth: 1,
        name: 'bash',
        description: '检查状态',
        status: 'running',
        running: true,
      },
    ],
  })
  const texts = flattenTexts(payload.components)
  const joined = texts.join('\n\n')

  // The existing inline tool line is unchanged.
  assert.match(joined, /-# ✓ `read` · src\/x\.js/)
  assert.match(joined, /父答案正文/)

  // The block is its own Text Display, after the answer body.
  const block = texts.find((text) => text.startsWith('-# 🧩'))
  assert.ok(block, 'a subagent block is emitted')
  assert.match(block, /-# 🧩 子代理 1 个运行中/)
  assert.match(block, /-# ↳ 「校验渲染器」⟳ `bash` · 检查状态/)
  assert.ok(joined.indexOf('父答案正文') < joined.indexOf('🧩'), 'the block follows the body')
})

test('subagentBlock caps at MAX_SUBAGENT_LINES and folds the overflow', () => {
  const many = Array.from({ length: 12 }, (_, index) => ({
    id: `child-${index}`,
    label: `子代理${index}`,
    depth: 1,
    name: 'read',
    status: 'running',
    running: true,
  }))
  const lines = subagentBlock(many).split('\n\n')
  assert.equal(lines.length, MAX_SUBAGENT_LINES)
  assert.equal(lines[0], '-# 🧩 子代理 12 个运行中')
  assert.match(lines.at(-1), /^-# …还有 \d+ 个子代理动作$/)
  // The newest children win the scarce lines.
  assert.ok(lines.some((line) => line.includes('子代理11')))
  assert.ok(!lines.some((line) => line.includes('子代理0」')))
})

test('the block marks finished and failed children, and says when all are done', () => {
  const block = subagentBlock([
    { id: 'a', label: 'A', depth: 1, name: 'read', status: 'completed', running: false },
    { id: 'b', label: 'B', depth: 1, name: 'bash', status: 'failed', running: false },
  ])
  assert.match(block, /-# 🧩 子代理已全部结束/)
  assert.match(block, /「A」✓ `read`/)
  assert.match(block, /「B」✖ `bash`/)
})

test('long subagent labels are clipped to 24 characters', () => {
  const block = subagentBlock([
    { id: 'a', label: '标'.repeat(40), depth: 1, name: 'read', status: 'running', running: true },
  ])
  const row = block.split('\n\n')[1]
  const label = row.slice(row.indexOf('「') + 1, row.indexOf('」'))
  assert.equal(label.length, 24)
  assert.ok(label.endsWith('…'))
})

test('child prose is summarised for the reporter but never enters the parent answer', async () => {
  const transport = fakeTransport()
  const reporter = new StreamReporter({ transport, channelId: 'c1', intervalMs: 0, logger: { warn() {} } })
  await reporter.begin()

  reporter.onTextDelta('父答案')
  reporter.onSubagentEvent({ kind: 'start', child: { id: 'child-1', label: '校验渲染器', depth: 1 } })
  reporter.onSubagentEvent({
    kind: 'tool-call',
    child: { id: 'child-1' },
    name: 'read',
    args: JSON.stringify({ file_path: 'src/secret/file.js' }),
  })
  reporter.onSubagentEvent({
    kind: 'text',
    child: { id: 'child-1' },
    text: '这是子代理的内部正文，不应出现在父卡片',
  })
  await reporter.flush(true)

  const joined = flattenTexts(transport.calls.edits.at(-1).payload.components).join('\n\n')
  assert.match(joined, /父答案/)
  assert.match(joined, /「校验渲染器」/)
  assert.match(joined, /`read`/)
  // describeTool owns what a call may reveal: the file path is allowed, the raw
  // argument object never is.
  assert.match(joined, /src\/secret\/file\.js/)
  assert.ok(!joined.includes('file_path'), 'argument keys stay out of the card')
  assert.ok(!joined.includes('内部正文'), 'child prose stays out of the parent body')

  // The summary is retained for the block, not merged into the answer text.
  assert.match(reporter.subagents.get('child-1').text, /内部正文/)
  assert.equal(reporter.text, '父答案')
})

test('captions and the final card count running children, then show the total', async () => {
  const transport = fakeTransport()
  const reporter = new StreamReporter({ transport, channelId: 'c1', intervalMs: 0, logger: { warn() {} } })
  await reporter.begin()

  reporter.onSubagentEvent({ kind: 'start', child: { id: 'a', label: 'A', depth: 1 } })
  reporter.onSubagentEvent({ kind: 'child-start', child: { id: 'b', label: 'B', depth: 1 } })
  assert.equal(reporter.subagentRunning, 2)
  assert.match(reporter.caption(), /子代理 2 运行中/)

  await reporter.flush(true)
  let joined = flattenTexts(transport.calls.edits.at(-1).payload.components).join('\n\n')
  assert.match(joined, /-# 🧩 子代理 2 个运行中/)

  reporter.onSubagentEvent({ kind: 'end', child: { id: 'a' }, status: 'failed' })
  reporter.onSubagentEvent({ kind: 'end', child: { id: 'b' }, status: 'completed' })
  assert.equal(reporter.subagentRunning, 0)

  await reporter.flush(true)
  joined = flattenTexts(transport.calls.edits.at(-1).payload.components).join('\n\n')
  assert.match(joined, /-# 🧩 子代理已全部结束/)
  assert.match(joined, /「A」✖/)
  assert.match(joined, /「B」✓/)

  await reporter.finish('完成', 'completed')
  const finalTexts = flattenTexts(transport.calls.edits.at(-1).payload.components)
  assert.match(finalTexts.join('\n\n'), /子代理已全部结束/)
  assert.match(finalTexts.at(-1), /子代理 2/, 'the footer keeps the total after the turn ends')
})

test('subagent events after close are a safe no-op', async () => {
  const transport = fakeTransport()
  const reporter = new StreamReporter({ transport, channelId: 'c1', intervalMs: 0, logger: { warn() {} } })
  await reporter.begin()
  await reporter.finish('完成')
  const known = reporter.subagents.size
  const edits = transport.calls.edits.length

  reporter.onSubagentEvent({ kind: 'start', child: { id: 'late', label: '迟到' } })
  assert.equal(reporter.subagents.size, known)
  assert.equal(transport.calls.edits.length, edits)
})

test('approvalCard labels a subagent request and leaves root copy untouched', () => {
  const base = { requestId: 'r1', description: '执行命令', approvePrefix: 'dsh:approve:', rejectPrefix: 'dsh:reject:' }

  const root = approvalCard(base)
  const rootTexts = flattenTexts(root.components)
  assert.equal(rootTexts[0], '## ⚠️ 需要确认')
  assert.ok(!rootTexts.join('\n').includes('来自子代理'), 'root requests keep the old copy')

  const child = approvalCard({
    ...base,
    child: { label: '校验渲染器', depth: 2, sessionId: 'child-1' },
  })
  const texts = flattenTexts(child.components)
  assert.equal(texts[0], '## 子代理「校验渲染器」请求授权')
  assert.match(texts.join('\n'), /-# 来自子代理（深度 2）/)
  assert.match(texts.join('\n'), /执行命令/)
  // The buttons are unchanged by the new identity.
  assert.equal(findCustomId(child.components, 'dsh:approve:r1'), 'dsh:approve:r1')
  assert.equal(findCustomId(child.components, 'dsh:reject:r1'), 'dsh:reject:r1')
})

test('questionCard appends the subagent label to the heading', () => {
  const question = { header: '确认方案', question: '选哪个', options: [{ label: 'A' }] }
  const withChild = questionCard({
    requestId: 'r',
    question,
    index: 0,
    total: 1,
    child: { label: '校验渲染器', depth: 1, sessionId: 'child-1' },
  })
  assert.equal(flattenTexts(withChild.components)[0], '## 确认方案 · 子代理「校验渲染器」')

  const root = questionCard({ requestId: 'r', question, index: 0, total: 1 })
  assert.equal(flattenTexts(root.components)[0], '## 确认方案')
  assert.ok(!flattenTexts(root.components).join('\n').includes('子代理'))
})

test('the agent seam prefers resolveAgent, falls back to tree.resolve, then identity', () => {
  const viaMethod = resolveRequestAgent(
    { resolveAgent: () => ({ key: 'c1', sessionId: 's1', depth: 1, label: 'A' }) },
    {},
  )
  assert.equal(viaMethod.channelId, 'c1')
  assert.equal(viaMethod.child.label, 'A')
  assert.equal(viaMethod.child.sessionId, 's1')

  const viaTree = resolveRequestAgent(
    { tree: { resolve: () => ({ key: 'c2', sessionId: 's2', depth: 2, label: 'B' }) } },
    {},
  )
  assert.equal(viaTree.channelId, 'c2')
  assert.equal(viaTree.child.depth, 2)

  // A depth-0 entry is the root agent: no child identity is attached.
  const root = resolveRequestAgent({ resolveAgent: () => ({ key: 'c3', depth: 0 }) }, {})
  assert.equal(root.channelId, 'c3')
  assert.equal(root.child, undefined)

  // No seam at all (the pre-SessionTree AgentService) keeps the old behaviour.
  const legacy = resolveRequestAgent({ channelForAgent: () => 'c4' }, {})
  assert.equal(legacy.channelId, 'c4')
  assert.equal(legacy.child, undefined)

  // A seam that throws must not make the request unanswerable.
  const thrown = resolveRequestAgent(
    {
      resolveAgent: () => {
        throw new Error('boom')
      },
      channelForAgent: () => 'c5',
    },
    {},
  )
  assert.equal(thrown.channelId, 'c5')

  // Without a catalog label the child still gets a stable identity.
  const unlabeled = resolveRequestAgent(
    { resolveAgent: () => ({ key: 'c6', sessionId: 'abcdef123456', depth: 1 }) },
    {},
  )
  assert.equal(unlabeled.child.label, '子代理 abcdef')

  assert.equal(resolveRequestAgent({ channelForAgent: () => undefined }, {}).channelId, undefined)
})

test('answerApprovalRequest labels the card and audits the child ids', async () => {
  const records = []
  const cards = []
  const runtime = {
    agents: {
      resolveAgent: () => ({ channelId: 'c1', sessionId: 'child-1', depth: 1, label: '校验渲染器' }),
      channelForAgent: () => 'c1',
    },
    approvals: new ApprovalRegistry({ timeoutMs: 60_000, logger: { warn() {} } }),
    transport: {
      send: async (_channelId, payload) => {
        cards.push(payload)
        return { messageId: 'm1' }
      },
      edit: async () => {},
    },
    audit: { record: (entry) => records.push(entry) },
    logger: { warn() {} },
  }

  const pending = answerApprovalRequest(runtime, {
    agent: {},
    toolName: 'bash',
    reason: '升级沙箱',
    arguments: '{"cmd":"rm -rf /"}',
  })
  await delay(20)

  assert.equal(cards.length, 1)
  const joined = flattenTexts(cards[0].components).join('\n')
  assert.match(joined, /## 子代理「校验渲染器」请求授权/)
  assert.match(joined, /-# 来自子代理（深度 1）/)
  assert.ok(!joined.includes('rm -rf'), 'command content never reaches the card')

  const asked = records.find((entry) => entry.action === 'approval.asked')
  assert.equal(asked.detail.childSessionId, 'child-1')
  assert.equal(asked.detail.depth, 1)
  assert.equal(asked.sessionId, 'child-1')

  const requestId = [...runtime.approvals.pending.keys()][0]
  runtime.approvals.finish(requestId, 'rejected')
  assert.equal(await pending, 'rejected')

  const decided = records.find((entry) => entry.action === 'approval.decided')
  assert.equal(decided.detail.childSessionId, 'child-1')
  assert.equal(decided.detail.depth, 1)
})

test('answerUserQuestions labels the heading and audits the child ids', async () => {
  const records = []
  const cards = []
  const runtime = {
    agents: {
      resolveAgent: () => ({ channelId: 'c1', sessionId: 'child-9', depth: 1, label: '校验渲染器' }),
    },
    questions: new QuestionRegistry({ timeoutMs: 60_000, logger: { warn() {} } }),
    transport: {
      send: async (_channelId, payload) => {
        cards.push(payload)
        return { messageId: `m${cards.length}` }
      },
      edit: async () => {},
    },
    audit: { record: (entry) => records.push(entry) },
    logger: { warn() {} },
  }

  const pending = answerUserQuestions(runtime, {
    agent: {},
    questions: [{ id: 'q1', header: '确认方案', question: '选哪个', options: [{ label: 'A' }] }],
  })
  await delay(20)

  assert.equal(cards.length, 1)
  assert.equal(flattenTexts(cards[0].components)[0], '## 确认方案 · 子代理「校验渲染器」')

  const asked = records.find((entry) => entry.action === 'question.request')
  assert.equal(asked.detail.childSessionId, 'child-9')
  assert.equal(asked.detail.depth, 1)
  assert.equal(asked.sessionId, 'child-9')

  const requestId = [...runtime.questions.pending.keys()][0]
  runtime.questions.answer(requestId, 'q1', { selected: ['A'] })
  const result = await pending
  assert.deepEqual(result.answers, [{ id: 'q1', selected: ['A'] }])

  const answered = records.find((entry) => entry.action === 'question.answered')
  assert.equal(answered.detail.childSessionId, 'child-9')
  assert.equal(answered.detail.depth, 1)
})

test('an agent outside the tree is still delegated to the Web answerer', async () => {
  const runtime = {
    agents: { channelForAgent: () => undefined },
    questions: new QuestionRegistry({ timeoutMs: 60_000, logger: { warn() {} } }),
    transport: { send: async () => ({ messageId: 'm' }), edit: async () => {} },
    audit: { record() {} },
    logger: { warn() {} },
  }
  assert.equal(
    await answerUserQuestions(runtime, { agent: {}, questions: [{ id: 'q1' }] }),
    DELEGATE,
  )
})
