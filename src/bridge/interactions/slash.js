/**
 * Slash-command interactions that are not plain `/dsh` routes:
 * autocomplete for `/dsh` and `/deepseek`, and the DeepSeek REST API commands.
 */
import { authorized } from '../../config.js'
import { StreamReporter } from '../stream-reporter.js'
import { routeMeta, safeError } from '../runtime.js'
import { textChunks } from '../../discord/components-v2.js'
import { UNTRUSTED_INPUT_POLICY } from '../untrusted.js'

/** Autocomplete for `/dsh session bind` and `/dsh model set`. */
export async function handleAutocomplete(runtime, interaction) {
  const { config, transport, agents, logger, ctx } = runtime
  if (!authorized(config, interaction.user.id, interaction.guildId || undefined, interaction.channelId || '')) {
    await transport.respondAutocomplete(interaction, [])
    return
  }
  let focused
  try {
    focused = interaction.options.getFocused(true)
  } catch {
    await transport.respondAutocomplete(interaction, []).catch(() => undefined)
    return
  }
  const query = String(focused.value || '').toLowerCase()

  if (focused.name === 'session') {
    let sessions = []
    try {
      sessions = await agents.listSessions()
    } catch (error) {
      logger.warn('自动补全读取 Session 列表失败:', error?.message || String(error))
    }
    const choices = sessions
      .filter(
        (session) =>
          !query ||
          session.id.toLowerCase().includes(query) ||
          session.title?.toLowerCase().includes(query),
      )
      .slice(0, 25)
      .map((session) => ({
        name: `${session.title || '(无标题)'} · ${session.id} · ${session.status}`.slice(0, 100),
        value: session.id,
      }))
    await transport.respondAutocomplete(interaction, choices)
    return
  }

  if (focused.name !== 'value') {
    await transport.respondAutocomplete(interaction, [])
    return
  }

  let provider = config.provider
  if (!provider) {
    try {
      provider = ctx.get('agentDefaultModel')?.currentSelection?.()?.provider
    } catch {
      provider = undefined
    }
  }
  if (query.includes('/')) provider = query.split('/')[0]
  const models = provider ? await agents.listModels(provider) : []
  const choices = models
    .map((model) => {
      const value = `${model.provider}/${model.id}`
      return { name: `${model.name} (${value})`.slice(0, 100), value }
    })
    .filter(
      (choice) =>
        !query ||
        choice.value.toLowerCase().includes(query) ||
        choice.name.toLowerCase().includes(query),
    )
    .slice(0, 25)
  await transport.respondAutocomplete(interaction, choices)
}

/** Autocomplete for `/deepseek <group> <cmd> model:`. */
export async function handleDeepSeekAutocomplete(runtime, interaction) {
  const { config, transport, deepseek } = runtime
  if (!authorized(config, interaction.user.id, interaction.guildId || undefined, interaction.channelId || '')) {
    await transport.respondAutocomplete(interaction, [])
    return
  }
  const focused = interaction.options.getFocused(true)
  if (focused.name !== 'model') {
    await transport.respondAutocomplete(interaction, [])
    return
  }
  const query = String(focused.value || '').toLowerCase()
  try {
    const data = await deepseek.listModels()
    const models = Array.isArray(data?.data) ? data.data : []
    await transport.respondAutocomplete(
      interaction,
      models
        .map((model) => ({ name: model.id, value: model.id }))
        .filter((choice) => !query || choice.value.toLowerCase().includes(query))
        .slice(0, 25),
    )
  } catch {
    await transport.respondAutocomplete(interaction, [])
  }
}

/**
 * `/deepseek` REST API commands.
 *
 * These bypass the DSH Agent entirely and call api.deepseek.com directly, so the
 * answer is rendered by a StreamReporter in the channel while the interaction
 * only acknowledges.
 */
export async function handleDeepSeekInteraction(runtime, interaction, request) {
  const { config, transport, deepseek, logger } = runtime
  const channelId = interaction.channelId
  const route = `${request.group}/${request.command}`
  const options = request.options || {}

  try {
    if (route === 'models/list') {
      const data = await deepseek.listModels()
      const models = Array.isArray(data?.data) ? data.data : []
      await transport.editInteraction(
        interaction,
        models.length
          ? ['**DeepSeek 官方模型**', ...models.map((model) => `- \`${model.id}\``)].join('\n')
          : '官方 API 未返回模型。',
      )
      return
    }

    if (route === 'balance/get') {
      const data = await deepseek.getBalance()
      const lines = (data?.balance_infos || []).map(
        (item) =>
          `- ${item.currency}: 总额 ${item.total_balance}，赠送 ${item.granted_balance}，充值 ${item.topped_up_balance}`,
      )
      await transport.editInteraction(
        interaction,
        [`**DeepSeek 账户余额**`, `可用：${data?.is_available ? '✅' : '❌'}`, ...lines].join('\n'),
      )
      return
    }

    if (route === 'chat/create') {
      const model = options.model || config.deepseekModel
      const messages = [
        {
          role: 'system',
          content: `${UNTRUSTED_INPUT_POLICY}\n\n${options.system || 'You are a helpful assistant.'}`,
        },
        { role: 'user', content: options.prompt },
      ]
      const reporter = new StreamReporter({
        transport,
        channelId,
        intervalMs: config.streamEditIntervalMs,
        logger,
        showReasoning: false,
        ...routeMeta(runtime, channelId),
      })
      await reporter.begin()
      let finalText = ''
      const toolCalls = []
      for await (const part of deepseek.streamChatCompletion({
        model,
        messages,
        temperature: options.temperature,
        maxTokens: options.maxTokens,
      })) {
        if (typeof part === 'string') {
          finalText += part
          reporter.onTextDelta(part)
        } else if (part?.toolCalls) {
          // The REST API returns tool calls in one batch: render them as tool
          // cards (they are kept), then reopen the answer card for the text.
          for (const call of part.toolCalls) {
            toolCalls.push({
              name: call?.function?.name || 'deepseek_tool',
              args: call?.function?.arguments || '{}',
              startedAt: Date.now(),
              endedAt: Date.now(),
            })
          }
          await reporter
            .renderToolCards(toolCalls)
            .catch((error) =>
              logger.warn('DeepSeek 工具卡片渲染失败:', error?.message || String(error)),
            )
        }
      }
      await reporter.finish(finalText)
      await transport.editInteraction(
        interaction,
        `✅ 已通过 DeepSeek 官方 API 完成，结果在 <#${channelId}>。`,
      )
      return
    }

    if (route === 'fim/create') {
      const data = await deepseek.createFimCompletion({
        model: options.model || config.deepseekModel,
        prompt: options.prompt,
        suffix: options.suffix,
        maxTokens: options.maxTokens,
      })
      const text = data?.choices?.[0]?.text || '(无文本输出)'
      const chunks = textChunks(text)
      await transport.editInteraction(interaction, chunks[0] || '(无文本输出)')
      for (const chunk of chunks.slice(1)) await transport.followUpInteraction(interaction, chunk, false)
      return
    }

    throw new Error(`未知 DeepSeek API 命令 /deepseek ${request.group} ${request.command}`)
  } catch (error) {
    logger.warn('DeepSeek API 命令失败:', error?.stack || error?.message || String(error))
    await transport.editInteraction(interaction, `❌ ${safeError(error)}`).catch(() => undefined)
  }
}
