/**
 * `/dsh thread` subcommands: create, info.
 */
export async function handleThreadCommand(runtime, { command, arg, channelId, guildId, kind, target, replyToMessageId }) {
  const { threads, respond } = runtime

  switch (command) {
    case 'create': {
      const name = String(arg || 'DSH 子任务').trim()
      const thread = await threads.create(channelId, name)
      if (!thread) throw new Error('当前频道不能创建 Thread')
      await respond(target, `🧵 已创建子线程：<#${thread.channelId}>`, { replyToMessageId })
      return true
    }

    case 'info': {
      await respond(
        target,
        [
          `Channel ID: \`${channelId}\``,
          ...(guildId ? [`Guild ID: \`${guildId}\``] : []),
          `类型: ${kind}`,
          `隔离键: \`${channelId}\``,
        ].join('\n'),
        { replyToMessageId },
      )
      return true
    }

    default:
      return false
  }
}
