import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
} from 'discord.js'
import { DiscordRateLimiter } from './rate-limiter.js'
import { normalizePayload } from './renderer.js'
import { noticeCard } from './cards-v2.js'

/** Discord interaction/transport module. It knows nothing about LLM or DSH Agents. */
export class DiscordTransport {
  constructor({ logger = console, rateLimiter } = {}) {
    this.logger = logger
    this.limiter = rateLimiter || new DiscordRateLimiter({ logger })
    this.client = undefined
    this.token = undefined
  }

  /** Attach an audit sink; every REST operation is then recorded. */
  setAudit(audit) {
    this.audit = audit
  }

  async withAudit(category, action, meta, operation) {
    const started = Date.now()
    try {
      const result = await this.limiter.run(operation, `${category}:${action}`)
      this.audit?.record({
        category: 'discord',
        action,
        status: 'ok',
        durationMs: Date.now() - started,
        ...meta,
      })
      return result
    } catch (error) {
      this.audit?.record({
        category: 'discord',
        action,
        status: 'error',
        durationMs: Date.now() - started,
        error: error?.message || String(error),
        ...meta,
      })
      throw error
    }
  }

  async start({ token, onMessage, onInteraction, onReady }) {
    if (this.client) throw new Error('Discord transport already started')
    this.token = token
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel],
    })
    this.client = client
    client.on(Events.Error, (error) => this.logger.warn?.('Discord Gateway 错误:', error?.message || String(error)))
    client.on(Events.MessageCreate, (message) => {
      void Promise.resolve(onMessage(message)).catch((error) =>
        this.logger.warn?.('MessageCreate 处理失败:', error?.stack || error?.message || String(error)),
      )
    })
    client.on(Events.InteractionCreate, (interaction) => {
      void Promise.resolve(onInteraction(interaction)).catch((error) =>
        this.logger.warn?.('InteractionCreate 处理失败:', error?.stack || error?.message || String(error)),
      )
    })
    client.once(Events.ClientReady, (ready) => {
      this.logger.log?.(`✅ Discord 已连接: ${ready.user.tag} (${ready.user.id})`)
      void Promise.resolve(onReady?.(ready)).catch((error) =>
        this.logger.warn?.('Discord ready 回调失败:', error?.message || String(error)),
      )
    })
    try {
      await client.login(token)
      return { applicationId: client.application?.id, user: client.user }
    } catch (error) {
      // A failed initial Gateway login must not leave a half-created Client
      // behind: the caller may retry with the same transport instance.
      await this.stop().catch(() => undefined)
      throw error
    }
  }

  async stop() {
    const client = this.client
    this.client = undefined
    this.token = undefined
    if (client) await Promise.resolve(client.destroy())
  }

  async registerCommands(applicationId, body, guildId) {
    if (!this.token) return
    const rest = new REST({ version: '10' }).setToken(this.token)
    await this.withAudit(
      'discord',
      'registerCommands',
      { guildId, detail: { commands: body.length, applicationId } },
      () =>
        guildId
          ? rest.put(Routes.applicationGuildCommands(applicationId, guildId), { body })
          : rest.put(Routes.applicationCommands(applicationId), { body }),
    )
  }

  async send(channelId, payload, { replyToMessageId } = {}) {
    return this.withAudit(
      'discord',
      'message.send',
      {
        channelId,
        detail: {
          contentLength: payload?.content?.length ?? 0,
          embeds: payload?.embeds?.length ?? 0,
          reply: Boolean(replyToMessageId),
        },
      },
      async () => {
        const channel = await this.client.channels.fetch(channelId)
        if (!channel || typeof channel.send !== 'function') throw new Error('Discord channel 不可发送消息')
        const options = normalizePayload(payload)
        if (replyToMessageId) {
          options.reply = { messageReference: replyToMessageId, failIfNotExists: false }
        }
        const sent = await channel.send(options)
        return { channelId, messageId: sent.id }
      },
    )
  }

  /**
   * Edit a message.
   *
   * `audit: false` is for cosmetic refreshes such as a countdown tick: they are
   * the same operation repeated, and logging each one buries the real edits.
   */
  async edit(channelId, messageId, payload, { audit = true } = {}) {
    if (!audit) {
      const channel = await this.client.channels.fetch(channelId)
      if (!channel?.messages) throw new Error('Discord channel 不可编辑消息')
      await channel.messages.edit(messageId, normalizePayload(payload))
      return
    }
    return this.withAudit(
      'discord',
      'message.edit',
      {
        channelId,
        detail: {
          messageId,
          contentLength: payload?.content?.length ?? 0,
          embeds: payload?.embeds?.length ?? 0,
        },
      },
      async () => {
        const channel = await this.client.channels.fetch(channelId)
        if (!channel?.messages) throw new Error('Discord channel 不可编辑消息')
        await channel.messages.edit(messageId, normalizePayload(payload))
      },
    )
  }

  async createThread(channelId, name, autoArchiveDuration = 1440) {
    return this.withAudit(
      'discord',
      'thread.create',
      { channelId, detail: { autoArchiveDuration } },
      async () => {
        const channel = await this.client.channels.fetch(channelId)
        if (!channel?.threads?.create) throw new Error('当前频道不能创建 Thread')
        const thread = await channel.threads.create({
          name: String(name || 'DSH 子任务').slice(0, 100),
          autoArchiveDuration,
          reason: 'DSH 复杂子任务自动隔离',
        })
        return { channelId: thread.id, name: thread.name }
      },
    )
  }

  async deferInteraction(interaction, ephemeral = true) {
    if (interaction.deferred || interaction.replied) return
    await this.withAudit(
      'discord',
      'interaction.defer',
      { channelId: interaction.channelId, guildId: interaction.guildId || undefined, userId: interaction.user?.id },
      () => interaction.deferReply({ ephemeral }),
    )
  }

  async editInteraction(interaction, text) {
    await this.withAudit(
      'discord',
      'interaction.edit',
      {
        channelId: interaction.channelId,
        guildId: interaction.guildId || undefined,
        userId: interaction.user?.id,
        detail: { contentLength: String(text || '').length },
      },
      () => interaction.editReply(normalizePayload(noticeCard(text))),
    )
  }

  async followUpInteraction(interaction, text, ephemeral = true) {
    await this.withAudit(
      'discord',
      'interaction.followUp',
      { channelId: interaction.channelId, guildId: interaction.guildId || undefined, userId: interaction.user?.id },
      () => {
        const payload = normalizePayload(noticeCard(text))
        return interaction.followUp(ephemeral ? { ...payload, flags: payload.flags | (1 << 6) } : payload)
      },
    )
  }

  async replyInteraction(interaction, text, ephemeral = true) {
    if (interaction.deferred || interaction.replied) return this.editInteraction(interaction, text)
    await this.withAudit(
      'discord',
      'interaction.reply',
      { channelId: interaction.channelId, guildId: interaction.guildId || undefined, userId: interaction.user?.id },
      () => {
        const payload = normalizePayload(noticeCard(text))
        return interaction.reply(ephemeral ? { ...payload, flags: payload.flags | (1 << 6) } : payload)
      },
    )
  }

  /** Acknowledge a button click without consuming the interaction token. */
  async deferButton(interaction) {
    if (interaction.deferred || interaction.replied) return
    await this.limiter.run(() => interaction.deferUpdate(), 'button.defer')
  }

  /**
   * Open a modal in response to a button click.
   *
   * A modal opening is an initial response, not an update, so the interaction
   * must not be deferred first — `showModal` is the acknowledgement.
   */
  async showModal(interaction, modal) {
    await this.withAudit(
      'discord',
      'button.modal',
      { channelId: interaction.channelId, userId: interaction.user?.id, customId: interaction.customId },
      () => interaction.showModal(modal),
    )
  }

  /** Ephemeral reply to a modal submission. */
  async replyModalMessage(interaction, text) {
    await this.withAudit(
      'discord',
      'modal.reply',
      { channelId: interaction.channelId, userId: interaction.user?.id, customId: interaction.customId },
      () => {
        const payload = normalizePayload(noticeCard(text))
        return interaction.reply({ ...payload, flags: payload.flags | (1 << 6) })
      },
    )
  }

  /** Replace the card that owns a component interaction. */
  async editComponentReply(interaction, payload) {
    await this.withAudit(
      'discord',
      'button.edit',
      { channelId: interaction.channelId, userId: interaction.user?.id, customId: interaction.customId },
      () =>
        interaction.deferred || interaction.replied
          ? interaction.editReply(normalizePayload(payload))
          : interaction.update(normalizePayload(payload)),
    )
  }

  /**
   * Ephemeral answer for a component interaction.
   *
   * The reply must be Components V2: the card being answered already carries
   * IS_COMPONENTS_V2, and Discord rejects a payload that mixes the legacy
   * `content` field with that flag
   * (MESSAGE_CANNOT_USE_LEGACY_FIELDS_WITH_COMPONENTS_V2).
   *
   * A deferred component interaction (`deferUpdate`) is an acknowledgement of
   * the card itself, so the confirmation must be a **follow-up**: `editReply`
   * would overwrite the card the operator just acted on and wipe the state text
   * the interaction was updating.
   */
  async replyEphemeral(interaction, text, { accentColor } = {}) {
    // The receipt echoes a decision, so it takes the decision's colour: a blue
    // "已拒绝。" sitting next to a red card reads like two different outcomes.
    const payload = normalizePayload(noticeCard(text, { accentColor }))
    const ephemeral = { ...payload, flags: (payload.flags ?? 0) | (1 << 6) }
    await this.withAudit(
      'discord',
      'button.reply',
      { channelId: interaction.channelId, userId: interaction.user?.id, customId: interaction.customId },
      () =>
        interaction.deferred || interaction.replied
          ? interaction.followUp(ephemeral)
          : interaction.reply(ephemeral),
    )
  }

  async respondAutocomplete(interaction, choices) {
    await this.limiter.run(
      () => interaction.respond(choices.slice(0, 25)),
      'autocomplete',
    )
  }
}
