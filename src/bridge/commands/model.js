/**
 * `/dsh model` subcommands: list, set, reasoning.
 *
 * All three act on the Agent's current route without recreating the Session, so
 * the conversation history survives a model switch.
 */
export async function handleModelCommand(runtime, { command, arg, channelId, guildId, kind, target, replyToMessageId }) {
  const { agents, respond } = runtime
  const key = channelId
  const meta = { channelId: key, guildId, kind }

  switch (command) {
    case 'list': {
      const runtimeState = await agents.touch(key, meta)
      const current = runtimeState.agent?.options || agents.agentOptions(runtimeState)
      const models = await agents.listModels(current.provider)
      if (!models.length) {
        await respond(target, `provider \`${current.provider}\` 没有返回可用模型。`, {
          replyToMessageId,
        })
        return true
      }
      await respond(
        target,
        [
          `当前 provider：\`${current.provider}\``,
          ...models.map((model) => `- \`${model.provider}/${model.id}\` ${model.name || ''}`),
        ].join('\n'),
        { replyToMessageId },
      )
      return true
    }

    case 'set': {
      const value = String(arg || '').trim()
      if (!value) throw new Error('用法：/dsh model set <provider>/<model>')
      const runtimeState = await agents.touch(key, meta)
      const current = runtimeState.agent?.options || agents.agentOptions(runtimeState)
      const slash = value.indexOf('/')
      const provider = slash > 0 ? value.slice(0, slash).trim() : current.provider
      const model = slash > 0 ? value.slice(slash + 1).trim() : value
      if (!provider || !model) throw new Error('模型格式应为 provider/model')
      const sessionId = await agents.setSettings(key, { provider, model })
      await respond(
        target,
        `已切换模型为 \`${provider}/${model}\`，Session 保持为 \`${sessionId}\`（上下文不变）。`,
        { replyToMessageId },
      )
      return true
    }

    case 'reasoning': {
      const value = String(arg || '').trim().toLowerCase()
      const runtimeState = await agents.touch(key, meta)
      const current = runtimeState.agent?.options || agents.agentOptions(runtimeState)
      const supported = await agents.listReasoningEfforts(current.provider, current.model)
      const allowed = supported.length > 0 ? supported : ['off', 'low', 'high', 'max']
      if (!value) {
        await respond(
          target,
          [
            `当前模型：\`${current.provider}/${current.model}\``,
            `可用推理等级：${allowed.map((item) => `\`${item}\``).join(' / ')}`,
            '用法：`/dsh model reasoning <等级>`',
          ].join('\n'),
          { replyToMessageId },
        )
        return true
      }
      if (!allowed.includes(value)) {
        await respond(
          target,
          `\`${value}\` 不是当前模型支持的推理等级。可用：${allowed
            .map((item) => `\`${item}\``)
            .join(' / ')}`,
          { replyToMessageId },
        )
        return true
      }
      const sessionId = await agents.setSettings(key, { reasoningEffort: value })
      await respond(
        target,
        `已切换推理等级为 \`${value}\`，Session 保持为 \`${sessionId}\`（上下文不变）。`,
        { replyToMessageId },
      )
      return true
    }

    default:
      return false
  }
}
