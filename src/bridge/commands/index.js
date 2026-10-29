/**
 * `/dsh` command dispatch.
 *
 * Each group lives in its own module; this file only picks the group and, when
 * none of them claims the route, raises the unknown-command error.
 */
import { handleSessionCommand } from './session.js'
import { handleModelCommand } from './model.js'
import { handlePermissionCommand } from './permission.js'
import { handleTaskCommand } from './task.js'
import { handleThreadCommand } from './thread.js'
import { handleSystemCommand } from './system.js'

const GROUPS = {
  session: handleSessionCommand,
  model: handleModelCommand,
  permission: handlePermissionCommand,
  task: handleTaskCommand,
  thread: handleThreadCommand,
  system: handleSystemCommand,
}

/**
 * Run one `/dsh <group> <command> [arg]`.
 *
 * `target` is the interaction for slash commands and may be a channel for text
 * commands; the user id is read defensively so both shapes work.
 */
export async function handleCommand(
  runtime,
  { group, command, arg, channelId, conversationKey, guildId, kind, target, replyToMessageId },
) {
  const commandUserId = target?.user?.id || target?.author?.id || target?.member?.user?.id
  const handler = GROUPS[group]
  if (handler) {
    const handled = await handler(runtime, {
      command,
      arg,
      channelId,
      conversationKey,
      guildId,
      kind,
      target,
      replyToMessageId,
      commandUserId,
    })
    if (handled) return
  }
  throw new Error(`未知命令 /dsh ${group || ''} ${command || ''}`.trim())
}
