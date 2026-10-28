/**
 * `/dsh session` subcommands: status, list, bind, new, stop.
 */
import { extractSessionId } from '../agent-service.js'

export async function handleSessionCommand(runtime, { command, arg, channelId, guildId, kind, target, replyToMessageId }) {
  const { agents, respond, logger } = runtime
  const key = channelId
  const meta = { channelId: key, guildId, kind }

  switch (command) {
    case 'status':
      await agents.touch(key, meta)
      await respond(target, agents.status(key), { replyToMessageId })
      return true

    case 'list': {
      await agents.touch(key, meta)
      const sessions = await agents.listSessions()
      if (!sessions.length) {
        await respond(target, '当前没有可绑定的 DSH Session。', { replyToMessageId })
        return true
      }
      await respond(
        target,
        [
          '**可绑定 Session（标题 + ID）**',
          ...sessions.slice(0, 20).flatMap((session) => [
            `- ${session.title ? `**${session.title}**` : '**(无标题)**'}`,
            `  ID: \`${session.id}\` · ${session.status}`,
          ]),
        ].join('\n'),
        { replyToMessageId },
      )
      return true
    }

    case 'bind': {
      const raw = String(arg || '').trim()
      const sessionId = extractSessionId(raw)
      logger.log(`bind ${key}: raw=${JSON.stringify(raw.slice(0, 200))} parsed=${JSON.stringify(sessionId)}`)
      if (!sessionId) {
        await respond(
          target,
          [
            '用法：`/dsh session bind <sessionId>`，可直接选自动补全项。',
            '先用 `/dsh session list` 查看标题与 ID。',
          ].join('\n'),
          { replyToMessageId },
        )
        return true
      }
      await agents.touch(key, meta)
      let targetId = sessionId
      if (!(await agents.isLiveOrPersisted(targetId))) {
        const sessions = await agents.listSessions()
        const byTitle = sessions.filter(
          (session) => session.title && session.title.toLowerCase() === raw.toLowerCase(),
        )
        if (byTitle.length === 1) targetId = byTitle[0].id
      }
      const bound = await agents.bindSession(key, targetId)
      logger.log(`bind ${key} -> ${bound} OK`)
      await respond(target, `已将当前频道绑定到 DSH Session：\`${bound}\`。后续消息会注入这个 Session。`, {
        replyToMessageId,
      })
      return true
    }

    case 'new': {
      await agents.touch(key, meta)
      const sessionId = await agents.newSession(key)
      await respond(target, `已创建新的独立 Session：\`${sessionId}\``, { replyToMessageId })
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
