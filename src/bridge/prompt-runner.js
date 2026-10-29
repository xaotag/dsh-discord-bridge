/**
 * Running one prompt through the Agent and presenting it.
 *
 * This is the single place a turn is started: it decides whether to open a
 * thread, creates the StreamReporter, and hands the prompt to AgentService.
 * Both the text path (`handleMessage`) and the slash path (`/dsh task ask`) go
 * through here so they cannot drift apart.
 */
import { StreamReporter } from './stream-reporter.js'
import { shouldCreateThread } from './thread-manager.js'
import { routeMeta, subagentThreadKey } from './runtime.js'
import { noticeCard } from '../discord/cards-v2.js'

/**
 * Run a prompt, creating a thread for complex tasks.
 *
 * @returns the Agent result plus the channel the answer landed in.
 */
export async function runPrompt(
  runtime,
  {
    channelId,
    guildId,
    kind,
    prompt,
    placeholder,
    replyToMessageId,
    attachmentCount = 0,
    images = [],
    boundChannelId,
    greeting: isGreeting = false,
  },
) {
  const { config, transport, agents, logger, threads } = runtime

  const shouldThread =
    !isGreeting &&
    shouldCreateThread({
      text: prompt,
      kind,
      attachments: attachmentCount,
      autoThread: config.autoThread,
      complexityThreshold: config.complexityThreshold,
    })
  const thread = shouldThread ? await threads.create(channelId, prompt) : undefined
  const targetChannelId = thread?.channelId || channelId
  // A manually bound conversation keeps its Session even when a thread is
  // created for presentation: route the turn to the binding key.
  const key = boundChannelId || targetChannelId

  // Child threads belong to the turn that opened them. Clearing the index first
  // keeps a question this turn from being routed to a thread from an earlier
  // one that happened to use the same child label.
  const threadIndex = runtime.subagentThreads
  if (threadIndex) {
    const prefix = `${key}\u0000`
    for (const indexed of [...threadIndex.keys()]) {
      if (indexed.startsWith(prefix)) threadIndex.delete(indexed)
    }
  }
  const onSubagentThread = (childId, threadId) =>
    threadIndex?.set(subagentThreadKey(key, childId), threadId)

  // Tell the main channel where the work went, reusing the placeholder if one
  // was already posted rather than leaving two messages behind.
  let reporter
  if (thread) {
    if (placeholder) {
      await transport.edit(
        channelId,
        placeholder.messageId,
        noticeCard(`🧵 子任务已转到子线程：<#${thread.channelId}>`),
      )
    } else {
      await transport.send(channelId, noticeCard(`🧵 子任务已转到子线程：<#${thread.channelId}>`), {
        replyToMessageId,
      })
    }
    reporter = new StreamReporter({
      transport,
      channelId: thread.channelId,
      intervalMs: config.streamEditIntervalMs,
      logger,
      showReasoning: true,
      subagentThreads: config.subagentThreads,
      onSubagentThread,
      ...routeMeta(runtime, boundChannelId || thread.channelId),
    })
    await reporter.begin()
  } else {
    reporter = new StreamReporter({
      transport,
      channelId,
      existingMessageId: placeholder?.messageId,
      intervalMs: config.streamEditIntervalMs,
      logger,
      showReasoning: false,
      subagentThreads: config.subagentThreads,
      onSubagentThread,
      ...routeMeta(runtime, boundChannelId || channelId),
    })
    await reporter.begin()
  }

  const meta = { channelId: key, guildId, kind }
  try {
    const result = await agents.run(key, meta, prompt, reporter, { greeting: isGreeting, images })
    await reporter.finish(result.text, result.status, result.usage)
    return { ...result, threadId: thread?.channelId, channelId: targetChannelId }
  } catch (error) {
    logger.warn('任务执行失败:', error?.stack || error?.message || String(error))
    await reporter.fail(error)
    throw error
  }
}
