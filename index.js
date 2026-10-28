/**
 * dsh-discord-bridge composition root.
 *
 * Layer boundaries:
 *   index.js                  -> lifecycle, auth, routing only
 *   src/discord/*             -> Discord transport, rendering, rate limits, commands
 *   src/bridge/agent-service  -> DSH Agent / model / session seam (no Discord)
 *   src/bridge/stream-reporter-> presentation of normalized Agent events
 *   src/bridge/untrusted      -> untrusted-input policy primitives
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { loadEnvFile, resolveConfig, authorized } from './src/config.js'
import { StateStore } from './src/state-store.js'
import { DiscordRateLimiter } from './src/discord/rate-limiter.js'
import { DiscordTransport } from './src/discord/transport.js'
import {
  DSH_COMMAND_BODY,
  HELP_TEXT,
  describeInteraction,
  normalizeInteraction,
  parseTextCommand,
} from './src/discord/commands.js'
import {
  DEEPSEEK_COMMAND_BODY,
  normalizeDeepSeekInteraction,
  parseDeepSeekTextCommand,
} from './src/discord/deepseek-commands.js'
import {
  APPROVE_BUTTON_PREFIX,
  REJECT_BUTTON_PREFIX,
  STOP_BUTTON_PREFIX,
  approvalPayload,
  chunkDiscordText,
  decidedApprovalPayload,
  finalEmbed,
  notificationPayload,
  placeholderPayload,
} from './src/discord/renderer.js'
import { readTextAttachments } from './src/discord/attachments.js'
import { mentionsUser, stripMentions } from './src/discord/mention.js'
import { AgentService, extractSessionId } from './src/bridge/agent-service.js'
import { StreamReporter } from './src/bridge/stream-reporter.js'
import { DeepSeekApiClient } from './src/deepseek/api-client.js'
import { ThreadManager, shouldCreateThread } from './src/bridge/thread-manager.js'
import { ApprovalRegistry } from './src/bridge/approval.js'
import { PrivilegedClient } from './src/bridge/privileged-client.js'
import { AuditLog } from './src/audit/db.js'
import { UNTRUSTED_INPUT_POLICY } from './src/bridge/untrusted.js'

export const name = 'dsh-discord-bridge'
export const inject = ['agents']
export const Config = undefined

const PLUGIN = '[dsh-discord-bridge]'
/** A bare @Bot followed by a message within this window continues the same turn. */
const MENTION_FOLLOWUP_WINDOW_MS = 60_000

function createLogger() {
  return {
    log: (...args) => console.log(PLUGIN, ...args),
    warn: (...args) => console.warn(PLUGIN, ...args),
  }
}

export function apply(ctx, rawConfig = {}) {
  loadEnvFile()
  const logger = createLogger()
  const config = resolveConfig(rawConfig)
  const state = new StateStore(config.statePath)
  const audit = new AuditLog({
    filename: config.auditPath,
    logger,
    enabled: config.auditEnabled,
  })
  const limiter = new DiscordRateLimiter({ logger, maxRetries: config.maxRateLimitRetries })
  const transport = new DiscordTransport({ logger, rateLimiter: limiter })
  transport.setAudit(audit)
  const agents = new AgentService({ ctx, config, state, logger, audit })
  const approvals = new ApprovalRegistry({ logger })
  const privileged = new PrivilegedClient({
    dshHome: process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
    logger,
  })
  const deepseek = new DeepSeekApiClient({ ctx, logger, audit })
  const threads = new ThreadManager({ transport, archiveMinutes: config.threadArchiveMinutes, logger })

  let disposed = false
  let cleanupTimer
  let clientUser
  /** conversation key -> bare-@Bot greeting awaiting the user's follow-up */
  const pendingMentions = new Map()

  function greeting(userName) {
    const hour = new Date().getHours()
    const part =
      hour < 5 ? '凌晨好' : hour < 11 ? '早上好' : hour < 13 ? '中午好' : hour < 18 ? '下午好' : '晚上好'
    return `${part}，${userName}！我在。直接告诉我要做什么就行 👇`
  }

  /**
   * Model route shown in the card footer. Falls back to the global default
   * route so the card still names the model when the channel has no override.
   */
  function routeMeta(conversationKey) {
    try {
      const stored = state.conversation(conversationKey) || {}
      let selection
      try {
        selection = ctx.get('agentDefaultModel')?.currentSelection?.()
      } catch {
        selection = undefined
      }
      const model = stored.model || config.model || selection?.model
      const reasoningEffort = stored.reasoningEffort || config.reasoningEffort || selection?.reasoningEffort
      const provider = stored.provider || config.provider || selection?.provider
      return {
        model: model ? `${provider ? provider + '/' : ''}${model}` : undefined,
        reasoningEffort,
      }
    } catch {
      return {}
    }
  }

  function replyPayload(text, message) {
    return {
      content: text,
      allowedMentions: { parse: [], repliedUser: false },
    }
  }

  async function respond(target, text, { replyToMessageId, ephemeral = true } = {}) {
    if (target?.isRepliable) {
      return transport
        .editInteraction(target, text)
        .catch(() => transport.replyInteraction(target, text, ephemeral))
    }
    return transport.send(target, notificationPayload(text), { replyToMessageId })
  }

  // ------------------------------------------------------------------ tasks

  async function runPrompt({
    channelId,
    guildId,
    kind,
    prompt,
    placeholder,
    replyToMessageId,
    attachmentCount = 0,
    boundChannelId,
    greeting: isGreeting = false,
  }) {
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

    let reporter
    if (thread) {
      if (placeholder) {
        await transport.edit(
          channelId,
          placeholder.messageId,
          notificationPayload(`🧵 子任务已转到子线程：<#${thread.channelId}>`),
        )
      } else {
        await transport.send(channelId, notificationPayload(`🧵 子任务已转到子线程：<#${thread.channelId}>`), {
          replyToMessageId,
        })
      }
      reporter = new StreamReporter({
        transport,
        channelId: thread.channelId,
        intervalMs: config.streamEditIntervalMs,
        logger,
        showReasoning: true,
        ...routeMeta(boundChannelId || thread.channelId),
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
        ...routeMeta(boundChannelId || channelId),
      })
      await reporter.begin()
    }

    // A manually bound conversation keeps its Session even when a thread is
    // created for presentation: route the turn to the binding key.
    const key = boundChannelId || targetChannelId
    const meta = { channelId: key, guildId, kind }
    try {
      const result = await agents.run(key, meta, prompt, reporter, { greeting: isGreeting })
      await reporter.finish(result.text, result.status)
      return { ...result, threadId: thread?.channelId, channelId: targetChannelId }
    } catch (error) {
      logger.warn('任务执行失败:', error?.stack || error?.message || String(error))
      await reporter.fail(error)
      throw error
    }
  }

  // --------------------------------------------------------------- commands

  async function handleCommand({ group, command, arg, channelId, guildId, kind, target, replyToMessageId }) {
    const key = channelId
    const meta = { channelId: key, guildId, kind }
    const route = `${group}/${command}`
    // `target` is the interaction for slash commands and may be a channel for
    // text commands; read the user defensively so both shapes work.
    const commandUserId = target?.user?.id || target?.author?.id || target?.member?.user?.id
    switch (route) {
      case 'system/help':
        await respond(target, HELP_TEXT, { replyToMessageId })
        return
      case 'system/ping': {
        const start = Date.now()
        const ws = Math.round(transport.client?.ws?.ping ?? 0)
        await respond(target, `🏓 pong\nWebSocket: ${ws}ms\n处理耗时: ${Date.now() - start}ms`, {
          replyToMessageId,
        })
        return
      }
      case 'session/status':
        await agents.touch(key, meta)
        await respond(target, agents.status(key), { replyToMessageId })
        return
      case 'session/list': {
        await agents.touch(key, meta)
        const sessions = await agents.listSessions()
        if (!sessions.length) {
          await respond(target, '当前没有可绑定的 DSH Session。', { replyToMessageId })
          return
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
        return
      }
      case 'session/bind': {
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
          return
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
        return
      }
      case 'session/new': {
        await agents.touch(key, meta)
        const sessionId = await agents.newSession(key)
        await respond(target, `已创建新的独立 Session：\`${sessionId}\``, { replyToMessageId })
        return
      }
      case 'session/stop':
      case 'task/stop': {
        const stopped = await agents.stop(key)
        await respond(target, stopped ? '已请求停止当前任务。' : '当前没有运行中的任务。', { replyToMessageId })
        return
      }
      case 'model/list': {
        const runtime = await agents.touch(key, meta)
        const current = runtime.agent?.options || agents.agentOptions(runtime)
        const models = await agents.listModels(current.provider)
        if (!models.length) {
          await respond(target, `provider \`${current.provider}\` 没有返回可用模型。`, { replyToMessageId })
          return
        }
        await respond(
          target,
          [
            `当前 provider：\`${current.provider}\``,
            ...models.map((model) => `- \`${model.provider}/${model.id}\` ${model.name || ''}`),
          ].join('\n'),
          { replyToMessageId },
        )
        return
      }
      case 'model/set': {
        const value = String(arg || '').trim()
        if (!value) throw new Error('用法：/dsh model set <provider>/<model>')
        const runtime = await agents.touch(key, meta)
        const current = runtime.agent?.options || agents.agentOptions(runtime)
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
        return
      }
      case 'model/reasoning': {
        const value = String(arg || '').trim().toLowerCase()
        const runtime = await agents.touch(key, meta)
        const current = runtime.agent?.options || agents.agentOptions(runtime)
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
          return
        }
        if (!allowed.includes(value)) {
          await respond(
            target,
            `\`${value}\` 不是当前模型支持的推理等级。可用：${allowed
              .map((item) => `\`${item}\``)
              .join(' / ')}`,
            { replyToMessageId },
          )
          return
        }
        const sessionId = await agents.setSettings(key, { reasoningEffort: value })
        await respond(
          target,
          `已切换推理等级为 \`${value}\`，Session 保持为 \`${sessionId}\`（上下文不变）。`,
          { replyToMessageId },
        )
        return
      }
      case 'task/steer': {
        if (!String(arg || '').trim()) throw new Error('用法：/dsh task steer <文本>')
        await agents.steer(key, String(arg).trim())
        await respond(target, '已将引导排入当前任务最近的步骤。', { replyToMessageId })
        return
      }
      case 'task/ask': {
        if (!String(arg || '').trim()) throw new Error('用法：/dsh task ask <文本>')
        await respond(target, '⏳ 已提交，正在处理…', { replyToMessageId })
        await runPrompt({
          channelId,
          guildId,
          kind,
          prompt: String(arg).trim(),
          placeholder: undefined,
          replyToMessageId,
          boundChannelId: channelId,
        })
        return
      }
      case 'system/audit': {
        if (!audit.enabled) {
          await respond(target, '审计日志未启用（DSH_DISCORD_AUDIT=false）。', { replyToMessageId })
          return
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
        return
      }
      case 'system/confirm': {
        const action = String(arg || '').trim()
        if (!action) {
          await respond(target, '用法：`/dsh system confirm <要确认的操作>`', { replyToMessageId })
          return
        }
        const channelIdForApproval = target.channelId || channelId
        const decision = await requestApproval({
          channelId: channelIdForApproval,
          userId: commandUserId,
          description: action,
          footer: '点击按钮决定是否继续',
        })
        audit.record({
          category: 'discord',
          action: 'approval.decided',
          status: decision === 'timeout' ? 'expired' : 'ok',
          channelId: channelIdForApproval,
          conversation: channelIdForApproval,
          userId: commandUserId,
          detail: { decision, action },
        })
        if (decision === 'timeout') {
          await respond(target, '⏱ 确认已超时，操作未执行。', { replyToMessageId })
        } else if (decision === 'approved') {
          await respond(target, `✅ 已批准：${action}`, { replyToMessageId })
        } else {
          await respond(target, '🚫 已拒绝，操作未执行。', { replyToMessageId })
        }
        return
      }
      case 'system/sudo': {
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

        const decision = await requestApproval({
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
            { replyToMessageId },
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

        const lines = []
        if (result.status === 'ok') {
          lines.push(`✅ 执行完成（退出码 ${result.exitCode ?? 0}，用时 ${elapsed}ms）`)
        } else if (result.status === 'timeout') {
          lines.push('⏱ 等待执行结果超时。')
        } else if (result.status === 'denied') {
          lines.push('🚫 守护进程拒绝了该请求。')
        } else {
          lines.push(`❌ 执行失败${result.exitCode !== undefined ? `（退出码 ${result.exitCode}）` : ''}`)
        }
        if (result.message) lines.push(result.message)
        if (result.stdout?.trim()) {
          lines.push('', '**stdout**', '```', clipForDiscord(result.stdout), '```')
        }
        if (result.stderr?.trim()) {
          lines.push('', '**stderr**', '```', clipForDiscord(result.stderr), '```')
        }
        await respond(target, lines.join('\n'), { replyToMessageId })
        return
      }
      case 'thread/create': {
        const name = String(arg || 'DSH 子任务').trim()
        const thread = await threads.create(channelId, name)
        if (!thread) throw new Error('当前频道不能创建 Thread')
        await respond(target, `🧵 已创建子线程：<#${thread.channelId}>`, { replyToMessageId })
        return
      }
      case 'thread/info': {
        await respond(
          target,
          [
            `Channel ID: \`${channelId}\``,
            ...(guildId ? [`Guild ID: \`${guildId}\``] : []),
            `类型: ${kind}`,
            `隔离键: \`${key}\``,
          ].join('\n'),
          { replyToMessageId },
        )
        return
      }
      default:
        throw new Error(`未知命令 /dsh ${group || ''} ${command || ''}`.trim())
    }
  }

  // ------------------------------------------------------- inbound messages

  async function handleMessage(message) {
    if (disposed || !clientUser || message.author?.bot) return
    if (message.author.id === clientUser.id) return
    if (!message.channelId) return

    const guildId = message.guildId || undefined
    const channelId = message.channelId
    if (!authorized(config, message.author.id, guildId, channelId)) return

    const kind = guildId === undefined ? 'dm' : message.channel?.isThread?.() ? 'thread' : 'channel'
    const key = channelId
    audit.record({
      category: 'discord',
      action: 'message.received',
      status: 'ok',
      channelId,
      guildId,
      conversation: key,
      userId: message.author.id,
      detail: { kind, length: String(message.content || '').length },
    })
    const mention = mentionsUser(message.mentions, clientUser.id)
    const bound = state.hasSession(key)
    const awaiting = pendingMentions.get(key)
    const inMentionTurn =
      awaiting !== undefined &&
      awaiting.userId === message.author.id &&
      Date.now() - awaiting.at < MENTION_FOLLOWUP_WINDOW_MS
    if (kind === 'channel' && config.requireMention && !mention && !inMentionTurn) return
    if (kind === 'thread' && config.requireMention && !mention && !bound && !inMentionTurn) return

    let text = stripMentions(message.content, clientUser.id)
    const attachments = [...(message.attachments?.values?.() || [])]

    // A bare "@bot" is a greeting, not a usage error. Remember the turn so the
    // user's next message continues the same conversation naturally.
    if (!text && attachments.length === 0) {
      if (!mention) return
      if (!(await state.claimEvent(`message:${message.id}`))) return
      // Bare @Bot: greet the user and open a 60s window in which their next
      // message (without another mention) continues the same conversation.
      pendingMentions.set(key, { userId: message.author.id, at: Date.now() })
      await transport
        .send(channelId, notificationPayload(greeting(message.author.username)), {
          replyToMessageId: message.id,
        })
        .catch((error) => logger.warn('发送 greeting 失败:', error?.message || String(error)))
      return
    }

    if (!(await state.claimEvent(`message:${message.id}`))) return

    const pending = pendingMentions.get(key)
    const continuesGreeting =
      pending !== undefined &&
      pending.userId === message.author.id &&
      Date.now() - pending.at < MENTION_FOLLOWUP_WINDOW_MS
    if (continuesGreeting) pendingMentions.delete(key)

    try {
      let prompt = text
      if (attachments.length) {
        const attachmentText = await readTextAttachments(attachments)
        prompt = prompt ? `${prompt}\n\n${attachmentText}` : attachmentText
      }
      const deepseekCommand = parseDeepSeekTextCommand(prompt)
      if (deepseekCommand) {
        await transport.send(
          channelId,
          notificationPayload(
            'DeepSeek 原生 API 请使用 Slash Command：`/deepseek models list`、`/deepseek chat create` 等。',
          ),
          { replyToMessageId: message.id },
        )
        return
      }
      const command = parseTextCommand(prompt)
      if (command) {
        await handleCommand({
          ...command,
          channelId,
          guildId,
          kind,
          target: channelId,
          replyToMessageId: message.id,
        })
        return
      }
      const placeholder = await transport.send(channelId, placeholderPayload(), {
        replyToMessageId: message.id,
      })
      await runPrompt({
        channelId,
        guildId,
        kind,
        prompt,
        placeholder,
        replyToMessageId: message.id,
        attachmentCount: attachments.length,
        boundChannelId: kind === 'thread' ? channelId : undefined,
      })
    } catch (error) {
      logger.warn(`处理消息失败 (${channelId}):`, error?.stack || error?.message || String(error))
      audit.record({
        category: 'discord',
        action: 'message.handle',
        status: 'error',
        channelId,
        guildId,
        conversation: channelId,
        userId: message.author.id,
        error: error?.message || String(error),
      })
      await transport
        .send(channelId, notificationPayload(`❌ 执行失败：${safeError(error)}`), {
          replyToMessageId: message.id,
        })
        .catch(() => undefined)
    }
  }

  // ------------------------------------------------------ Slash interactions

  async function handleAutocomplete(interaction) {
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
        .filter((session) => !query || session.id.toLowerCase().includes(query) || session.title?.toLowerCase().includes(query))
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
      .filter((choice) => !query || choice.value.toLowerCase().includes(query) || choice.name.toLowerCase().includes(query))
      .slice(0, 25)
    await transport.respondAutocomplete(interaction, choices)
  }

  async function handleDeepSeekAutocomplete(interaction) {
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

  async function handleDeepSeekInteraction(interaction, request) {
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
          ...routeMeta(channelId),
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
              .catch((error) => logger.warn('DeepSeek 工具卡片渲染失败:', error?.message || String(error)))
          }
        }
        await reporter.finish(finalText)
        await transport.editInteraction(interaction, `✅ 已通过 DeepSeek 官方 API 完成，结果在 <#${channelId}>。`)
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
        const chunks = chunkDiscordText(text)
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

  // ---------------------------------------------------------------- buttons

  /**
   * "批准" / "拒绝" buttons on a confirmation card.
   *
   * The custom_id carries a short request id that indexes the approval
   * registry; settling it resolves the promise the requesting turn is awaiting.
   * A second click finds nothing pending and reports that instead of double
   * deciding.
   */
  async function handleApprovalButton(interaction, customId) {
    const approved = customId.startsWith(APPROVE_BUTTON_PREFIX)
    const rejected = customId.startsWith(REJECT_BUTTON_PREFIX)
    if (!approved && !rejected) return false
    const prefix = approved ? APPROVE_BUTTON_PREFIX : REJECT_BUTTON_PREFIX
    const requestId = customId.slice(prefix.length)
    const channelId = interaction.channelId
    const guildId = interaction.guildId || undefined
    await transport.deferButton(interaction).catch(() => undefined)
    if (!channelId || !authorized(config, interaction.user?.id, guildId, channelId)) {
      await transport.replyEphemeral(interaction, '你不在授权名单内。').catch(() => undefined)
      return true
    }
    const entry = approvals.get(requestId)
    if (!entry) {
      await transport
        .replyEphemeral(interaction, '这个确认已经失效或已被处理。')
        .catch(() => undefined)
      return true
    }
    const decision = approved ? 'approved' : 'rejected'
    approvals.finish(requestId, decision)
    audit.record({
      category: 'discord',
      action: approved ? 'button.approve' : 'button.reject',
      status: 'ok',
      channelId,
      guildId,
      conversation: channelId,
      userId: interaction.user?.id,
      detail: { requestId },
    })
    try {
      const messageId = interaction.message?.id
      if (messageId) {
        await transport.edit(channelId, messageId, decidedApprovalPayload(decision))
      }
    } catch (error) {
      logger.warn('更新确认卡片失败:', error?.message || String(error))
    }
    await transport
      .replyEphemeral(interaction, approved ? '已批准。' : '已拒绝。')
      .catch(() => undefined)
    return true
  }

  /**
   * "停止" button on a streaming card.
   *
   * The custom_id carries the card message id; the conversation key is that
   * same channel (cards are always posted into the channel the turn runs in),
   * so the button can stop the turn without any server-side registry.
   */
  async function handleButton(interaction) {
    const customId = String(interaction?.customId || '')
    if (!customId.startsWith(STOP_BUTTON_PREFIX)) {
      return handleApprovalButton(interaction, customId)
    }
    const channelId = interaction.channelId
    const messageId = customId.slice(STOP_BUTTON_PREFIX.length)
    const guildId = interaction.guildId || undefined
    await transport.deferButton(interaction).catch(() => undefined)
    if (!channelId || !authorized(config, interaction.user?.id, guildId, channelId)) {
      await transport
        .replyEphemeral(interaction, '你不在授权名单内。')
        .catch(() => undefined)
      return true
    }
    try {
      const stopped = await agents.stop(channelId)
      audit.record({
        category: 'discord',
        action: 'button.stop',
        status: stopped ? 'ok' : 'noop',
        channelId,
        guildId,
        conversation: channelId,
        userId: interaction.user?.id,
        detail: { messageId },
      })
      if (stopped) {
        await transport
          .editComponentReply(interaction, {
            embeds: finalEmbed('已按你的请求停止当前任务。', 'cancelled'),
          })
          .catch((error) =>
            logger.warn('按钮停止后更新卡片失败:', error?.message || String(error)),
          )
      } else {
        await transport.replyEphemeral(interaction, '当前没有运行中的任务。').catch(() => undefined)
      }
    } catch (error) {
      logger.warn('按钮停止失败:', error?.stack || error?.message || String(error))
      await transport
        .replyEphemeral(interaction, `❌ 停止失败：${safeError(error)}`)
        .catch(() => undefined)
    }
    return true
  }

  async function handleInteraction(interaction) {
    if (disposed) return
    if (interaction?.isButton?.() && (await handleButton(interaction))) return
    if (interaction?.isAutocomplete?.() && interaction.commandName === 'dsh') {
      await handleAutocomplete(interaction).catch((error) =>
        logger.warn('自动补全失败:', error?.message || String(error)),
      )
      return
    }
    if (interaction?.isAutocomplete?.() && interaction.commandName === 'deepseek') {
      await handleDeepSeekAutocomplete(interaction).catch((error) =>
        logger.warn('DeepSeek 自动补全失败:', error?.message || String(error)),
      )
      return
    }
    if (interaction?.isChatInputCommand?.() && interaction.commandName === 'deepseek') {
      if (!authorized(config, interaction.user.id, interaction.guildId || undefined, interaction.channelId || '')) {
        await interaction.reply({ content: '你不在授权名单内。', ephemeral: true }).catch(() => undefined)
        return
      }
      await transport.deferInteraction(interaction, false)
      const request = normalizeDeepSeekInteraction(interaction)
      if (request) await handleDeepSeekInteraction(interaction, request)
      return
    }

    const channelId = interaction.channelId
    if (!channelId) return

    // Discord invalidates an interaction token 3 seconds after the event.
    let deferred = false
    try {
      await transport.deferInteraction(interaction, true)
      deferred = true
    } catch (error) {
      logger.warn('deferReply 失败（交互可能已过期）:', error?.message || String(error))
      return
    }

    const guildId = interaction.guildId || undefined
    const kind = guildId === undefined ? 'dm' : interaction.channel?.isThread?.() ? 'thread' : 'channel'
    try {
      if (!authorized(config, interaction.user.id, guildId, channelId)) {
        await transport.editInteraction(interaction, '你不在授权名单内。')
        return
      }
      const normalized = normalizeInteraction(interaction)
      logger.log(`interaction ${describeInteraction(interaction)} -> ${JSON.stringify(normalized)}`)
      audit.record({
        category: 'discord',
        action: 'slash.command',
        status: 'ok',
        channelId,
        guildId,
        conversation: channelId,
        userId: interaction.user?.id,
        detail: { group: normalized?.group, command: normalized?.command },
      })
      if (!normalized) {
        await transport.editInteraction(interaction, '未知的 /dsh 子命令。')
        return
      }
      if (!normalized.command) {
        await transport.editInteraction(interaction, '缺少子命令，请使用 `/dsh system help` 查看用法。')
        return
      }
      await handleCommand({
        ...normalized,
        channelId,
        guildId,
        kind,
        target: interaction,
        replyToMessageId: undefined,
      })
    } catch (error) {
      logger.warn('Slash command 失败:', error?.stack || error?.message || String(error))
      audit.record({
        category: 'discord',
        action: 'slash.command',
        status: 'error',
        channelId,
        guildId,
        conversation: channelId,
        userId: interaction.user?.id,
        error: error?.message || String(error),
      })
      if (deferred) {
        await transport.editInteraction(interaction, `❌ 命令执行失败：${safeError(error)}`).catch(() => undefined)
      } else {
        await interaction
          .reply({ content: `❌ 命令执行失败：${safeError(error)}`, ephemeral: true })
          .catch(() => undefined)
      }
    }
  }

  // --------------------------------------------------------------- lifecycle

  async function resolveToken() {
    let token =
      process.env[config.tokenRef] ||
      process.env.DISCORD_BOT_TOKEN ||
      process.env.DISCORD_TOKEN
    try {
      const credentials = ctx.get('credentials')
      if (credentials?.resolve) {
        const resolved = await credentials.resolve(config.tokenRef)
        if (resolved?.value) token = resolved.value
      }
    } catch (error) {
      logger.warn('通过 ctx.credentials 解析 Token 失败:', error?.message || String(error))
    }
    return token?.trim() || undefined
  }

  async function start() {
    try {
      await ctx.get('loader')?.await()
    } catch {
      /* loader absent */
    }
    if (disposed) return
    if (config.ownerIds.length === 0 && config.allowedUsers.length === 0) {
      logger.warn('未配置 DSH_DISCORD_OWNER_ID 或授权用户，出于安全考虑插件拒绝启动')
      return
    }
    const token = await resolveToken()
    if (!token) {
      logger.log(`未配置 Discord Bot Token（tokenRef=${config.tokenRef}），插件跳过启动`)
      return
    }
    try {
      const info = await fsp.stat(config.workspace)
      if (!info.isDirectory()) throw new Error('不是目录')
    } catch (error) {
      logger.warn(`workspace 不可访问 (${error.message})，插件拒绝启动`)
      return
    }
    await state.load()
    await audit.open()
    if (disposed) return

    let identity
    for (let attempt = 1; !disposed; attempt += 1) {
      try {
        identity = await transport.start({
          token,
          onMessage: (message) => handleMessage(message),
          onInteraction: (interaction) => handleInteraction(interaction),
          onReady: async (ready) => {
            clientUser = ready.user
            if (!disposed && config.registerCommands) {
              await transport.registerCommands(
                ready.application?.id || ready.user.id,
                [DSH_COMMAND_BODY, DEEPSEEK_COMMAND_BODY],
                config.commandGuildId,
              )
              logger.log(
                config.commandGuildId
                  ? `已注册 /dsh 到 guild ${config.commandGuildId}`
                  : '已注册全局 /dsh 命令（Discord 可能需要几分钟同步）',
              )
            }
          },
        })
        break
      } catch (error) {
        const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempt - 1, 5))
        logger.warn(
          `Discord Gateway 连接失败（第 ${attempt} 次），${delay}ms 后重试:`,
          error?.message || String(error),
        )
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }
    if (!identity || disposed) {
      await transport.stop().catch(() => undefined)
      return
    }
    clientUser = identity.user
    if (disposed) {
      await transport.stop()
      return
    }
    cleanupTimer = setInterval(() => {
      void agents.cleanupIdle().catch((error) =>
        logger.warn('清理空闲 Agent 失败:', error?.message || String(error)),
      )
    }, Math.max(5000, Math.min(60000, config.idleTimeoutMs / 4)))
    cleanupTimer.unref?.()
  }

  /**
   * Post a confirmation card and await the operator's decision.
   *
   * Used by the bridge (and available to other host-plane code) before a
   * sensitive action runs. Resolves to 'approved' | 'rejected' | 'timeout';
   * it never rejects, so a caller can treat a timeout as a refusal.
   */
  async function requestApproval({ channelId, userId, description, title, footer } = {}) {
    if (!channelId) return 'timeout'
    const request = approvals.create({ channelId, userId, description })
    try {
      const payload = approvalPayload({
        requestId: request.id,
        title,
        description,
        footer,
        expiresAt: request.expiresAt,
      })
      const sent = await transport.send(channelId, payload)
      audit.record({
        category: 'discord',
        action: 'approval.request',
        status: 'ok',
        channelId,
        conversation: channelId,
        userId,
        detail: { requestId: request.id, messageId: sent?.messageId },
      })
      return await request.decided
    } catch (error) {
      approvals.finish(request.id, 'timeout')
      logger.warn('发送确认卡片失败:', error?.message || String(error))
      return 'timeout'
    }
  }

  ctx.effect(
    () => () => {
      if (disposed) return
      disposed = true
      if (cleanupTimer) clearInterval(cleanupTimer)
      return (async () => {
        // Settle any awaited confirmation so no turn hangs on shutdown.
        approvals.clear('timeout')
        await Promise.allSettled([agents.dispose(), transport.stop(), state.close(), audit.close()])
        logger.log('插件卸载，Discord 连接和 Agent 已释放')
      })()
    },
    'dsh-discord-bridge.lifecycle',
  )

  void start().catch((error) => {
    if (!disposed) logger.warn('启动失败:', error?.stack || error?.message || String(error))
  })

  logger.log(
    `初始化 tokenRef=${config.tokenRef} workspace=${config.workspace} isolation=${config.isolation} ` +
      `owner=${config.ownerIds.length ? config.ownerIds.join(',') : '(未设置)'} ` +
      `requireMention=${config.requireMention} streamEdit=${config.streamEditIntervalMs}ms`,
  )
}

function safeError(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/[A-Za-z0-9_-]{20,}/g, '***').slice(0, 500)
}

/** Fit command output inside one Discord message, keeping the tail (errors). */
function clipForDiscord(text, limit = 1500) {
  const clean = String(text ?? '')
  if (clean.length <= limit) return clean
  return `…（前面已截断）\n${clean.slice(-limit)}`
}
