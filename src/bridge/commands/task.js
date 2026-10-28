/**
 * `/dsh task` subcommands: ask, steer, stop.
 *
 * `ask` goes through the shared prompt runner so the slash path and the plain
 * mention path cannot drift apart.
 */
import { runPrompt } from '../prompt-runner.js'

export async function handleTaskCommand(runtime, { command, arg, channelId, guildId, kind, target, replyToMessageId }) {
  const { agents, respond } = runtime
  const key = channelId
  const meta = { channelId: key, guildId, kind }

  switch (command) {
    case 'ask': {
      const text = String(arg || '').trim()
      if (!text) throw new Error('用法：/dsh task ask <文本>')
      await respond(target, '⏳ 已提交，正在处理…', { replyToMessageId })
      await runPrompt(runtime, {
        channelId,
        guildId,
        kind,
        prompt: text,
        placeholder: undefined,
        replyToMessageId,
        boundChannelId: channelId,
      })
      return true
    }

    case 'steer': {
      const text = String(arg || '').trim()
      if (!text) throw new Error('用法：/dsh task steer <文本>')
      await agents.steer(key, text)
      await respond(target, '已将引导排入当前任务最近的步骤。', { replyToMessageId })
      return true
    }

    case 'stop': {
      const stopped = await agents.stop(key)
      await respond(target, stopped ? '已请求停止当前任务。' : '当前没有运行中的任务。', {
        replyToMessageId,
      })
      return true
    }

    default:
      return false
  }
}
