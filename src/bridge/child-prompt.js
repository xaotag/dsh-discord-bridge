/**
 * Talking to one delegated child from its own Discord thread.
 *
 * A subagent thread is bound to a child Session, not to a channel: a message
 * typed there is addressed to that child, so it must continue the child's
 * conversation. Nothing here may create a Session — the child already owns one,
 * and a new Session would silently detach the thread from its agent.
 *
 * Delivery has two paths:
 *   - the child is resident  -> hand the message to its inbox (`followup`);
 *   - the child is parked    -> ask the subagent service to cold-resume it
 *     through the live parent Session, then wait for the turn to settle.
 *
 * Per-child queueing keeps two quick replies from interleaving their turns.
 */
import { randomUUID } from 'node:crypto'
import { StreamReporter } from './stream-reporter.js'
import { routeMeta } from './runtime.js'
import { noticeCard } from '../discord/cards-v2.js'
import { makeUserMessage } from './agent-service.js'

/** How long a cold resume may take before the thread gives up politely. */
const COLD_RESUME_WAIT_MS = 10_000
const COLD_RESUME_POLL_MS = 250

/** One chain per child Session, so replies are answered in order. */
const queues = new Map()

function enqueue(childId, task) {
  const previous = queues.get(childId) || Promise.resolve()
  const run = previous.then(task, task)
  const tail = run.catch(() => undefined)
  queues.set(childId, tail)
  void tail.then(() => {
    if (queues.get(childId) === tail) queues.delete(childId)
  })
  return run
}

async function waitForLiveChild(agents, childId, timeoutMs = COLD_RESUME_WAIT_MS) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const agent = agents.childAgent(childId)
    if (agent) return agent
    await new Promise((resolve) => setTimeout(resolve, COLD_RESUME_POLL_MS).unref?.())
  }
  return undefined
}

/**
 * Run one message addressed to a child in the child's thread.
 *
 * @returns {{status: 'completed'|'unavailable'|'failed', text?: string}}
 */
export async function runChildPrompt(
  runtime,
  { childId, conversationKey, channelId, prompt, replyToMessageId, images = [], label },
) {
  const { agents, transport, config, logger, audit } = runtime
  if (!childId) return { status: 'unavailable' }
  return enqueue(childId, async () => {
    const reporter = new StreamReporter({
      transport,
      channelId,
      intervalMs: config.streamEditIntervalMs,
      logger,
      showReasoning: false,
      ...routeMeta(runtime, conversationKey),
    })
    await reporter.begin()

    audit?.record?.({
      category: 'agent',
      action: 'child.run.start',
      status: 'ok',
      channelId,
      conversation: conversationKey,
      sessionId: childId,
      detail: { promptLength: String(prompt || '').length },
    })
    agents.bindChildSink?.(childId, reporter)
    try {
      let agent = agents.childAgent?.(childId)
      let delivered = false
      if (!agent) {
        const resumed = await coldResume(runtime, { childId, conversationKey, prompt })
        agent = resumed?.agent
        // The cold-resume request already carries the message; sending it
        // again through followup() would make the child answer twice.
        delivered = Boolean(resumed?.delivered)
      }
      if (!agent) {
        await reporter.fail(new Error('该子代理已结束，无法继续'))
        await transport
          .send(
            channelId,
            noticeCard(
              `子代理「${label || '未知'}」已经结束，无法继续对话。（它的会话仍可在 Web 里查看，这里不会新开 Session）`,
            ),
            { replyToMessageId },
          )
          .catch(() => undefined)
        return { status: 'unavailable' }
      }

      if (!delivered) agent.followup(makeUserMessage(prompt, { images }))
      await agent.whenIdle()
      const text = String(reporter.text || '').trim()
      await reporter.finish(text, 'completed')
      audit?.record?.({
        category: 'agent',
        action: 'child.run.end',
        status: 'ok',
        channelId,
        conversation: conversationKey,
        sessionId: childId,
        detail: { replyLength: text.length },
      })
      return { status: 'completed', text }
    } catch (error) {
      logger.warn?.('子代理线程回合失败:', error?.stack || error?.message || String(error))
      await reporter.fail(error).catch(() => undefined)
      return { status: 'failed' }
    } finally {
      agents.unbindChildSink?.(childId)
    }
  })
}

/**
 * Ask the subagent service to bring a parked child back for one message.
 *
 * Cold resume needs the child's live parent, so the parent Agent is resumed
 * first. Both services are optional: a composition without them leaves the
 * thread read-only instead of throwing.
 */
async function coldResume(runtime, { childId, conversationKey, prompt }) {
  const { agents, ctx, logger } = runtime
  const subagents = ctx?.get?.('subagents') ?? ctx?.subagents
  if (!subagents || typeof subagents.prompt !== 'function') return undefined

  const parent = await agents.ensureConversationAgent?.(conversationKey)
  if (!parent) return undefined

  try {
    await subagents.prompt(
      {
        requestId: randomUUID(),
        parentSessionId: parent.id,
        childSessionId: childId,
        mode: 'continuable',
        delivery: 'queue',
        content: [{ type: 'text', text: String(prompt ?? '') }],
      },
      AbortSignal.timeout(30_000),
    )
  } catch (error) {
    logger.warn?.('冷恢复子代理失败:', error?.message || String(error))
    return undefined
  }
  const agent = await waitForLiveChild(agents, childId)
  return agent ? { agent, delivered: true } : undefined
}
