/**
 * `/dsh permission` — read or switch the permission preset.
 *
 * DSH's permission preset is the pair (sandbox mode, approval policy), and it is
 * what a delegated child inherits at spawn time: `auto` and `danger-full-access`
 * are captured onto the child, `workspace-write` is not. So this command is also
 * the lever for "let my subagents do wider work": switch here first, then
 * delegate, and the children come up with the same access.
 *
 * The switch goes through the live service the same way the Web UI's own
 * `/permission` command does, so both surfaces stay consistent; no session is
 * recreated and the history survives.
 */
export async function handlePermissionCommand(
  runtime,
  { command, arg, channelId, guildId, kind, target, replyToMessageId },
) {
  const { agents, respond, logger } = runtime
  const key = channelId
  const meta = { channelId: key, guildId, kind }
  const presets = runtime.ctx.get('permissionPresets')

  if (!presets || typeof presets.current !== 'function') {
    throw new Error('当前部署没有挂载 permissionPresets 服务，无法读写权限预设')
  }

  const runtimeState = await agents.touch(key, meta)
  const agent = runtimeState.agent
  if (!agent) throw new Error('当前频道还没有活跃的 Agent，先发一条消息再切换权限')
  const session = agent.session

  const names = Array.isArray(presets.names) ? presets.names : []
  const current = presets.current(session)

  if (!command || command === 'show') {
    await respond(
      target,
      [
        `当前权限预设：\`${current}\``,
        names.length ? `可选：${names.map((name) => `\`${name}\``).join(' / ')}` : '',
        '子代理会继承 `auto` / `danger-full-access`；`workspace-write` 不继承，子代理需要更宽权限时先在这里切。',
      ]
        .filter(Boolean)
        .join('\n'),
      { replyToMessageId },
    )
    return true
  }

  const name = String(arg || '').trim()
  if (!name) {
    const list = names.length ? names.join(' / ') : '（该部署没有配置预设）'
    await respond(target, `用法：\`/dsh permission <预设>\`\n可选：${list}`, { replyToMessageId })
    return true
  }
  if (!names.includes(name)) {
    await respond(target, `未知预设 \`${name}\`，可选：${names.join(' / ') || '（无）'}`, {
      replyToMessageId,
    })
    return true
  }

  presets.set(session, name)
  const applied = presets.current(session)
  logger.log?.(`permission: key=${key} ${current} -> ${applied}`)
  runtime.audit?.record?.({
    category: 'config',
    action: 'permission.set',
    status: 'ok',
    channelId,
    guildId,
    conversation: key,
    sessionId: session.id,
    detail: { from: current, to: applied },
  })
  await respond(
    target,
    [
      `权限预设已切换：\`${current}\` → \`${applied}\``,
      applied === 'workspace-write'
        ? '子代理不会继承这个预设；需要子代理做更宽的操作时，先切到 `auto` 或 `danger-full-access` 再派发。'
        : '接下来派发的子代理会继承同一套权限。',
    ].join('\n'),
    { replyToMessageId },
  )
  return true
}
