/**
 * `/dsh system` subcommands: help, ping, audit, sudo.
 *
 * `confirm` was removed: it only ever confirmed its own description, while real
 * confirmations come from the approval cards (`/dsh system sudo` and the Agent's
 * own `approval/request`).
 *
 * `sudo` is the interesting one: it routes a root command through the
 * privileged daemon and reports the *real* outcome — approved-and-ran,
 * approved-but-refused (SELinux/AppArmor/DAC/polkit), or failed.
 */
import { HELP_TEXT } from '../../discord/commands.js'
import { ACCENT } from '../../discord/cards-v2.js'
import {
  classifyPrivilegedOutcome,
  describePrivilegedOutcome,
  selinuxHint,
} from '../privilege-outcome.js'
import { requestApproval } from '../interactions/approval.js'
import { clipForDiscord } from '../runtime.js'

/**
 * Colour of a `/dsh system` receipt.
 *
 * Green means "nothing went wrong" — the operator's click is not the outcome,
 * the result is. A refusal is red, and a timeout is the neutral grey used by
 * every other expired card.
 */
export function decisionAccent(decision) {
  if (decision === 'approved') return ACCENT.completed
  if (decision === 'timeout') return ACCENT.cancelled
  return ACCENT.failed
}

/** Same rule applied to a finished privileged run. */
export function executionAccent(result = {}) {
  if (result.status === 'ok') return ACCENT.completed
  if (result.status === 'timeout') return ACCENT.cancelled
  return ACCENT.failed
}

export async function handleSystemCommand(
  runtime,
  { command, arg, channelId, guildId, kind, target, replyToMessageId, commandUserId },
) {
  const { transport, agents, audit, privileged, respond, logger } = runtime
  const key = channelId

  switch (command) {
    case 'help':
      await respond(target, HELP_TEXT, { replyToMessageId })
      return true

    case 'ping': {
      const start = Date.now()
      const ws = Math.round(transport.client?.ws?.ping ?? 0)
      await respond(target, `🏓 pong\nWebSocket: ${ws}ms\n处理耗时: ${Date.now() - start}ms`, {
        replyToMessageId,
      })
      return true
    }

    case 'audit': {
      if (!audit.enabled) {
        await respond(target, '审计日志未启用（DSH_DISCORD_AUDIT=false）。', { replyToMessageId })
        return true
      }
      await audit.flush()
      const rows = audit.recent({ limit: 15, channelId: key })
      await respond(
        target,
        rows.length
          ? [
              '**最近操作日志**（不含对话内容）',
              ...rows.map(
                (row) =>
                  `\`${row.iso.slice(11, 19)}\` ${row.category}/${row.action} ${row.status}` +
                  `${row.duration_ms ? ` ${row.duration_ms}ms` : ''}${row.error ? ` · ${String(row.error).slice(0, 80)}` : ''}`,
              ),
            ].join('\n')
          : '当前频道还没有操作记录。',
        { replyToMessageId },
      )
      return true
    }

    case 'sudo':
      await runSudo(runtime, {
        arg,
        channelId,
        target,
        replyToMessageId,
        commandUserId,
        agents,
        audit,
        privileged,
        respond,
        logger,
      })
      return true

    default:
      return false
  }
}

/** Approve-then-execute flow for `/dsh system sudo <cmd>`. */
async function runSudo(
  runtime,
  { arg, channelId, target, replyToMessageId, commandUserId, audit, privileged, respond },
) {
  const { config } = runtime
  const command = String(arg || '').trim()
  if (!command) {
    await respond(target, '用法：`/dsh system sudo <命令>`', { replyToMessageId })
    return
  }
  const channelIdForApproval = target.channelId || channelId

  if (!(await privileged.available())) {
    await respond(
      target,
      '提权执行器未安装。请先运行 `sudo ./privd/install-privd.sh`（见插件 privd 目录）。',
      { replyToMessageId },
    )
    return
  }

  const decision = await requestApproval(runtime, {
    channelId: channelIdForApproval,
    userId: commandUserId,
    title: '🔐 需要 root 权限',
    description: `将要执行：\n\`\`\`bash\n${command.slice(0, 1500)}\n\`\`\``,
    footer: '批准后由 root 守护进程执行',
  })
  audit.record({
    category: 'discord',
    action: 'sudo.decision',
    status: decision === 'timeout' ? 'expired' : 'ok',
    channelId: channelIdForApproval,
    conversation: channelIdForApproval,
    userId: commandUserId,
    detail: { decision, commandLength: command.length },
  })

  if (decision !== 'approved') {
    await respond(
      target,
      decision === 'timeout' ? '⏱ 确认已超时，未执行。' : '🚫 已拒绝，未执行。',
      { replyToMessageId, accentColor: decisionAccent(decision) },
    )
    return
  }

  const startedAt = Date.now()
  const result = await privileged.run({
    command,
    cwd: config.workspace,
    requestedBy: commandUserId,
    channelId: channelIdForApproval,
  })
  const elapsed = Date.now() - startedAt
  audit.record({
    category: 'discord',
    action: 'sudo.exec',
    status: result.status,
    channelId: channelIdForApproval,
    conversation: channelIdForApproval,
    userId: commandUserId,
    durationMs: elapsed,
    detail: { exitCode: result.exitCode, commandLength: command.length },
    ...(result.status !== 'ok' ? { error: result.message || result.stderr } : {}),
  })

  // Distinguish "approved and ran" from "approved but the system refused it"
  // (SELinux, AppArmor, DAC, polkit) so the reply never blames the command for
  // a policy denial.
  const outcome = classifyPrivilegedOutcome(result)
  const lines = []
  if (outcome === 'approved') {
    lines.push(`✅ 已批准并执行（退出码 ${result.exitCode ?? 0}，用时 ${elapsed}ms）`)
  } else if (outcome === 'denied') {
    lines.push('⛔ 已批准，但无权限执行')
  } else if (result.status === 'timeout') {
    lines.push('⏱ 等待执行结果超时。')
  } else {
    lines.push('❌ 执行失败')
  }
  const detail = describePrivilegedOutcome(result)
  if (detail && outcome !== 'approved') lines.push(detail)
  const hint = selinuxHint(result)
  if (hint) lines.push('', hint)
  if (result.stdout?.trim()) {
    lines.push('', '**stdout**', '```', clipForDiscord(result.stdout), '```')
  }
  if (result.stderr?.trim()) {
    lines.push('', '**stderr**', '```', clipForDiscord(result.stderr), '```')
  }
  await respond(target, lines.join('\n'), {
    replyToMessageId,
    accentColor: executionAccent(result),
  })
}
