import { randomUUID } from 'node:crypto'
import { UNTRUSTED_INPUT_POLICY } from './untrusted.js'
import { listModels, listReasoningEfforts } from './agent-catalog.js'

/**
 * DSH Agent / model interaction module.
 *
 * It owns ctx.agents.create/resume, per-channel live Agents, turn serialization,
 * assistant-stream aggregation, tool-call event observation, and system-prompt
 * safety registration. It has no Discord imports.
 */
export class AgentService {
  constructor({ ctx, config, state, logger = console, audit }) {
    this.ctx = ctx
    this.config = config
    this.state = state
    this.logger = logger
    this.audit = audit
    this.runtimes = new Map()
    this.disposed = false
    this.disposeStream = ctx.on('agent/assistant-stream', (payload) => this.observeStream(payload))
    this.disposeSession = ctx.on('session/event', (session, event) => this.observeSession(session, event))
    this.disposeAgent = ctx.on('agent/disposed', (payload) => this.observeDisposed(payload))
  }

  /**
   * Channel that owns an Agent.
   *
   * `user-questions/request` carries the asking agent but no channel, and a
   * question card has to be posted somewhere. Runtimes hold the live agent for
   * each channel, so matching on identity gives the exact destination rather
   * than guessing the most recently active channel.
   */
  channelForAgent(agent) {
    if (!agent) return undefined
    for (const [key, runtime] of this.runtimes) {
      if (runtime?.agent === agent || runtime?.handle?.agent === agent) return runtime.channelId || key
    }
    return undefined
  }

  runtime(key, meta = {}) {
    let runtime = this.runtimes.get(key)
    if (!runtime) {
      const saved = this.state.conversation(key)
      runtime = {
        key,
        channelId: meta.channelId || key,
        guildId: meta.guildId,
        kind: meta.kind || 'channel',
        provider: saved?.provider,
        model: saved?.model,
        reasoningEffort: saved?.reasoningEffort,
        handle: undefined,
        agent: undefined,
        opening: undefined,
        releasing: undefined,
        delivery: Promise.resolve(),
        pendingDeliveries: 0,
        sink: undefined,
        streamText: '',
        status: 'idle',
        lastUsed: Date.now(),
      }
      this.runtimes.set(key, runtime)
    }
    runtime.lastUsed = Date.now()
    return runtime
  }

  async touch(key, meta) {
    await this.state.touchConversation(key, meta)
    return this.runtime(key, meta)
  }

  status(key) {
    const runtime = this.runtimes.get(key)
    const saved = this.state.conversation(key)
    if (!runtime?.agent) {
      return saved?.sessionId ? `Session: \`${saved.sessionId}\`\n状态: 尚未恢复` : '当前频道还没有 DSH Session。'
    }
    const options = runtime.selection?.current || runtime.agent.options || this.agentOptions(runtime)
    return [
      `Session: \`${runtime.agent.id}\``,
      `状态: ${runtime.agent.status === 'running' ? '运行中' : '空闲'}`,
      `模型: \`${options.provider}/${options.model}\``,
      `推理等级: \`${options.reasoningEffort || 'provider-default'}\``,
      `Agent preset: \`${runtime.agentPreset || '(未挂载)'}\``,
      `工作目录: \`${this.config.workspace}\``,
      `隔离键: \`${key}\``,
    ].join('\n')
  }

  agentOptions(runtime) {
    let selection
    try {
      selection = this.ctx.get('agentDefaultModel')?.currentSelection?.()
    } catch {
      selection = undefined
    }
    const provider =
      runtime?.provider ||
      this.state.conversation(runtime?.key)?.provider ||
      this.config.provider ||
      selection?.provider
    const model =
      runtime?.model ||
      this.state.conversation(runtime?.key)?.model ||
      this.config.model ||
      selection?.model
    if (!provider || !model) {
      throw new Error('没有可用模型路由：请配置 provider/model，或使用 /dsh model')
    }
    const reasoningEffort =
      runtime?.reasoningEffort ||
      this.state.conversation(runtime?.key)?.reasoningEffort ||
      this.config.reasoningEffort ||
      selection?.reasoningEffort
    return {
      provider,
      model,
      ...(reasoningEffort ? { reasoningEffort } : {}),
    }
  }

  /**
   * Mount the configured Agent preset on the freshly minted agent scope.
   *
   * The Web surface disables the host-plane tool rows (tool-bash, tool-fs,
   * tool-fs-search, …) and lets each Agent mount a preset instead. An Agent
   * created without a preset therefore sees only the plugin-level tools that
   * live on the host plane — which is exactly the "no bash, no file access"
   * symptom a Discord session used to report.
   */
  async mountPreset(agentCtx, runtime) {
    const presets = this.ctx.get('agentPresets')
    if (!presets?.mount) return undefined
    try {
      // A resumed Agent joins the preset recorded in its Session projection.
      const existing = presets.composedPreset?.(agentCtx)
      if (existing) {
        runtime.agentPreset = existing
        if (existing !== this.config.agentPreset) {
          // The Session keeps the preset it was created with; switching would
          // silently change a session's toolset mid-conversation.
          this.logger.log?.(
            'Session 记录的 preset 为「' + existing + '」，配置为「' + this.config.agentPreset +
              '」；沿用 Session 记录（用 /dsh session new 切换到新 preset）',
          )
        }
        return existing
      }
      const mounted = await presets.mount(agentCtx, this.config.agentPreset)
      runtime.agentPreset = mounted?.id || this.config.agentPreset
      this.audit?.record({
        category: 'agent',
        action: 'preset.mount',
        status: 'ok',
        channelId: runtime.channelId,
        conversation: runtime.key,
        detail: { agentPreset: runtime.agentPreset },
      })
      return runtime.agentPreset
    } catch (error) {
      // A failed preset must not strand the user without any tools at all:
      // log it and keep the host-plane toolset.
      runtime.agentPreset = undefined
      this.logger.warn?.(
        `挂载 Agent preset「${this.config.agentPreset}」失败: ${error?.message || String(error)}`,
      )
      this.audit?.record({
        category: 'agent',
        action: 'preset.mount',
        status: 'error',
        channelId: runtime.channelId,
        conversation: runtime.key,
        error: error?.message || String(error),
        detail: { agentPreset: this.config.agentPreset },
      })
      return undefined
    }
  }

  async setupAgent(agentCtx, runtime) {
    this.logger.log?.(`[agent-setup] 进入 setupAgent key=${runtime.key} hasCtx=${Boolean(agentCtx)} hasOn=${Boolean(agentCtx?.on)}`)
    await this.mountPreset(agentCtx, runtime)
    const systemPrompt = agentCtx?.systemPrompt || this.ctx.get('systemPrompt')
    if (systemPrompt?.section) {
      try {
        systemPrompt.section({
          name: 'discord:untrusted-input-policy',
          order: -1_000_000,
          text: UNTRUSTED_INPUT_POLICY,
          interpolate: false,
        })
      } catch (error) {
        this.logger.warn?.('注册不可信输入系统提示失败:', error?.message || String(error))
      }
    }
    this.installSelection(agentCtx, runtime)
  }

  /**
   * Install a mutable model-selection route on the exact Agent scope.
   * The Session is never recreated: only the next request's provider/model/
   * reasoning route changes, so the whole conversation history is preserved.
   */
  installSelection(agentCtx, runtime) {
    if (!agentCtx?.on) return
    try {
      runtime.selectionDispose?.()
    } catch {
      /* ignore old disposer */
    }
    if (!runtime.selection) {
      runtime.selection = {
        current: this.routeFor(runtime),
        assembled: undefined,
      }
    }
    const selection = runtime.selection
    const disposers = []
    disposers.push(
      agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
        const selected = selection.current
        const assembled = await next()
        selection.assembled = selected
        if (!selected) return assembled
        return {
          ...assembled,
          variables: {
            ...assembled.variables,
            provider: selected.provider,
            model: selected.model,
          },
        }
      }),
    )
    disposers.push(
      agentCtx.on('agent/request', async (_payload, next) => {
        const resolved = await next()
        const selected = selection.assembled
        if (!selected) return resolved
        const { reasoningEffort: _inherited, ...withoutInherited } = resolved
        return {
          ...withoutInherited,
          provider: selected.provider,
          model: selected.model,
          ...(selected.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: selected.reasoningEffort }),
        }
      }),
    )
    runtime.selectionDispose = () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* ignore */
        }
      }
    }
  }

  routeFor(runtime) {
    const options = this.agentOptions(runtime)
    return {
      provider: options.provider,
      model: options.model,
      ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
    }
  }

  async ensureAgent(runtime) {
    if (this.disposed) throw new Error('Discord bridge 正在关闭')
    if (runtime.releasing) throw new Error('当前对话正在释放，请稍后重试')
    if (runtime.agent) {
      // A Web-GUI-owned Agent disappears from the registry when that session is
      // archived/cleared. Never inject into a dead reference; fall through to
      // resume/create so the next message still gets an answer.
      const live = this.ctx.agents.get(runtime.agent.id)
      if (live === runtime.agent) return runtime.agent
      runtime.agent = undefined
      runtime.handle = undefined
    }
    runtime.opening ??= this.openAgent(runtime)
    try {
      return await runtime.opening
    } finally {
      runtime.opening = undefined
    }
  }

  async openAgent(runtime) {
    const saved = this.state.conversation(runtime.key)?.sessionId
    const options = this.agentOptions(runtime)
    if (saved) {
      // If the session is already live (for example the user's current Web GUI
      // session), adopt that exact Agent instead of resuming a duplicate.
      const live = this.ctx.agents.get(saved)
      if (live) {
        runtime.agent = live
        this.installSelection(live.ctx, runtime)
        this.logger.log?.(`绑定已存在 live session ${saved}`)
        return live
      }
      let handle
      try {
        handle = await this.ctx.agents.resume({
          resumeSessionId: saved,
          agentOptions: options,
          setup: (agentCtx) => this.setupAgent(agentCtx, runtime),
        })
        await handle.agent.whenIdle()
        runtime.handle = handle
        runtime.agent = handle.agent
        this.audit?.record({
          category: 'agent',
          action: 'resume',
          status: 'ok',
          channelId: runtime.channelId,
          conversation: runtime.key,
          sessionId: saved,
        })
        return handle.agent
      } catch (error) {
        await handle?.dispose().catch(() => undefined)
        this.audit?.record({
          category: 'agent',
          action: 'resume',
          status: 'error',
          channelId: runtime.channelId,
          conversation: runtime.key,
          sessionId: saved,
          error: error?.message || String(error),
        })
        throw new Error(`恢复 Session ${saved} 失败：${error.message}。可使用 /dsh session new 重置当前对话`)
      }
    }
    const sessionId = `session-discord-${randomUUID()}`
    let handle
    try {
      handle = await this.ctx.agents.create({
        sessionId,
        // Record the preset durably: a later resume reads it back from the
        // Session projection and rejoins the same composition.
        meta: {
          cwd: this.config.workspace,
          ...(this.config.agentPreset ? { agentPreset: this.config.agentPreset } : {}),
        },
        agentOptions: options,
        setup: (agentCtx) => this.setupAgent(agentCtx, runtime),
      })
      await handle.agent.whenIdle()
      await this.state.setSessionId(runtime.key, sessionId)
      runtime.handle = handle
      runtime.agent = handle.agent
      this.audit?.record({
        category: 'agent',
        action: 'create',
        status: 'ok',
        channelId: runtime.channelId,
        conversation: runtime.key,
        sessionId,
        detail: { provider: options.provider, model: options.model, reasoningEffort: options.reasoningEffort },
      })
      return handle.agent
    } catch (error) {
      if (runtime.handle === handle) runtime.handle = undefined
      await handle?.dispose().catch(() => undefined)
      this.audit?.record({
        category: 'agent',
        action: 'create',
        status: 'error',
        channelId: runtime.channelId,
        conversation: runtime.key,
        error: error?.message || String(error),
      })
      throw new Error(`创建 Session 失败：${error.message}`)
    }
  }

  async releaseRuntime(runtime) {
    if (runtime.releasing) return runtime.releasing
    runtime.releasing = (async () => {
      await runtime.delivery.catch(() => undefined)
      if (runtime.opening) await runtime.opening.catch(() => undefined)
      const handle = runtime.handle
      runtime.handle = undefined
      runtime.agent = undefined
      runtime.sink = undefined
      try {
        runtime.selectionDispose?.()
      } catch {
        /* ignore */
      }
      runtime.selectionDispose = undefined
      runtime.selection = undefined
      if (!handle) return
      try {
        handle.agent.cancel({ kind: 'disposed' })
      } catch {
        /* already stopped */
      }
      await handle.dispose().catch((error) =>
        this.logger.warn?.('dispose agent 失败:', error?.message || String(error)),
      )
      this.audit?.record({
        category: 'agent',
        action: 'dispose',
        status: 'ok',
        channelId: runtime.channelId,
        conversation: runtime.key,
      })
    })()
    try {
      await runtime.releasing
    } finally {
      runtime.releasing = undefined
    }
  }

  async run(key, meta, text, sink, { greeting = false } = {}) {
    if (this.disposed) throw new Error('Discord bridge 正在关闭')
    const runtime = await this.touch(key, meta)
    runtime.pendingDeliveries += 1
    const operation = runtime.delivery.then(async () => {
      const agent = await this.ensureAgent(runtime)
      runtime.sink = sink
      runtime.streamText = ''
      runtime.status = 'running'
      runtime.greeting = greeting
      const before = assistantTexts(agent.session)
      const startedAt = Date.now()
      this.audit?.record({
        category: 'agent',
        action: 'run.start',
        status: 'ok',
        channelId: runtime.channelId,
        conversation: runtime.key,
        sessionId: agent.id,
        detail: { greeting, promptLength: text.length },
      })
      try {
        agent.followup(makeUserMessage(greeting ? greetingPrompt(text) : text))
        await agent.whenIdle()
        try {
          await this.ctx.get('sessions')?.flush?.(agent.session)
        } catch (error) {
          this.logger.warn?.('session flush 失败:', error?.message || String(error))
        }
        let finalText = runtime.streamText
        if (!finalText.trim()) {
          const after = assistantTexts(agent.session)
          finalText = after.length > before.length ? after[after.length - 1] || '' : ''
        }
        this.audit?.record({
          category: 'agent',
          action: 'run.end',
          status: runtime.status,
          channelId: runtime.channelId,
          conversation: runtime.key,
          sessionId: agent.id,
          durationMs: Date.now() - startedAt,
          detail: { replyLength: finalText.trim().length },
        })
        return { text: finalText.trim(), status: runtime.status, usage: this.usageSnapshot(agent.session) }
      } catch (error) {
        this.audit?.record({
          category: 'agent',
          action: 'run.error',
          status: 'error',
          channelId: runtime.channelId,
          conversation: runtime.key,
          sessionId: agent.id,
          durationMs: Date.now() - startedAt,
          error: error?.message || String(error),
        })
        throw error
      } finally {
        if (runtime.sink === sink) runtime.sink = undefined
      }
    })
    runtime.delivery = operation.catch(() => undefined)
    try {
      return await operation
    } finally {
      runtime.pendingDeliveries -= 1
      runtime.lastUsed = Date.now()
    }
  }

  /**
   * Exact usage for the card footer, read from the session projections.
   *
   * `tokenUsage` accumulates every billed request in the session, which is what
   * the cache hit rate means; `contextPressure` carries the newest prompt size
   * and the route's capacity. Both are optional — a turn where the provider
   * reported nothing simply omits the footer bits instead of inventing numbers.
   */
  usageSnapshot(session) {
    if (!session) return undefined
    try {
      const projections = this.ctx.get('sessionProjections')
      const snapshot = projections?.snapshot?.(session, ['tokenUsage', 'contextPressure'])
      const usage = snapshot?.values?.tokenUsage
      const pressure = snapshot?.values?.contextPressure
      if (!usage && !pressure) return undefined
      return { ...(usage ?? {}), ...(pressure ?? {}) }
    } catch (error) {
      this.logger.warn?.('读取 token 用量失败:', error?.message || String(error))
      return undefined
    }
  }

  async steer(key, text) {
    const runtime = this.runtimes.get(key)
    const agent = runtime?.agent
    if (!agent || agent.status !== 'running') throw new Error('当前没有运行中的任务')
    agent.steer(makeUserMessage(text))
  }

  async stop(key) {
    const agent = this.runtimes.get(key)?.agent
    if (!agent || agent.status === 'idle') return false
    agent.cancel({ kind: 'user' })
    return true
  }

  async newSession(key) {
    const runtime = this.runtime(key)
    const agent = runtime.agent
    if (agent) agent.cancel({ kind: 'user' })
    await runtime.delivery.catch(() => undefined)
    await this.releaseRuntime(runtime)
    await this.state.setSessionId(key, undefined)
    const created = await this.ensureAgent(runtime)
    return created.id
  }

  async setSettings(key, settings) {
    const runtime = this.runtime(key)
    // Resolve the route this change will apply to: explicit settings this call
    // wins, then the runtime's stored route, then the live Agent options.
    const stored = this.state.conversation(key) || {}
    const provider =
      settings.provider || runtime.provider || stored.provider || runtime.agent?.options?.provider || this.config.provider
    const model =
      settings.model || runtime.model || stored.model || runtime.agent?.options?.model || this.config.model
    let reasoningEffort = settings.reasoningEffort
    this.logger.log?.(
      `setSettings: key=${key} route=${provider}/${model} ` +
        `requested=${JSON.stringify(settings)}`,
    )
    if (reasoningEffort !== undefined) {
      const supported = await this.listReasoningEfforts(provider, model)
      this.logger.log?.(`setSettings: supported efforts=${JSON.stringify(supported)}`)
      if (supported.length > 0 && !supported.includes(reasoningEffort)) {
        throw new Error(
          `模型 ${provider}/${model} 支持 ${supported.join(' / ')}，不支持 ${reasoningEffort}`,
        )
      }
    }
    await this.state.setSettings(key, settings)
    this.audit?.record({
      category: 'config',
      action: 'settings.changed',
      status: 'ok',
      channelId: key,
      conversation: key,
      sessionId: runtime.agent?.id,
      detail: { ...settings, route: `${provider}/${model}` },
    })
    Object.assign(runtime, settings)
    const route = this.routeFor(runtime)
    runtime.selection = { current: route, assembled: undefined }
    // Force the next request to refresh its header instead of inheriting the
    // previous effort from the last `request/header` snapshot.
    if (runtime.agent) {
      this.installSelection(runtime.agent.ctx, runtime)
      return runtime.agent.id
    }
    return this.state.conversation(key)?.sessionId
  }

  /**
   * Reasoning efforts the current adapter advertises for this exact route.
   * Returned ids are the only values that survive `prepareCall()` validation.
   */
  /** Selectable reasoning efforts for a route; see agent-catalog.js. */
  async listReasoningEfforts(provider, model) {
    return listReasoningEfforts(this.ctx, this.logger, provider, model)
  }

  /** Models a provider offers; see agent-catalog.js. */
  async listModels(provider) {
    return listModels(this.ctx, this.logger, provider)
  }

  observeStream({ agent, frame }) {
    if (!agent || !frame) return
    const runtime = findRuntime(this.runtimes, agent)
    if (!runtime?.sink) return
    if (frame.type === 'start') {
      runtime.streamText = ''
      return
    }
    if (frame.type !== 'chunk') return
    const chunk = frame.chunk
    if (chunk.type === 'text-delta') {
      runtime.streamText += chunk.text
      runtime.sink.onTextDelta?.(chunk.text)
    } else if (chunk.type === 'reasoning-delta') {
      runtime.sink.onReasoningDelta?.(chunk.text)
    }
  }

  observeSession(session, event) {
    const runtime = [...this.runtimes.values()].find((item) => item.agent?.session === session)
    if (!runtime) return
    if (event.type === 'tool/call') {
      this.audit?.record({
        category: 'tool',
        action: 'call',
        status: 'started',
        channelId: runtime.channelId,
        conversation: runtime.key,
        sessionId: runtime.agent?.id,
        detail: { name: event.data.name, callId: event.data.callId, argumentBytes: String(event.data.arguments || '').length },
      })
      runtime.sink?.onToolCall?.(event.data.name, event.data.arguments)
    } else if (event.type === 'tool/result') {
      this.audit?.record({
        category: 'tool',
        action: 'result',
        status: event.data?.message?.isError ? 'error' : 'ok',
        channelId: runtime.channelId,
        conversation: runtime.key,
        sessionId: runtime.agent?.id,
        error: event.data?.error?.reason,
        detail: { callId: event.data?.message?.toolCallId, errorCode: event.data?.error?.code },
      })
      runtime.sink?.onToolResult?.(event.data)
    } else if (event.type === 'turn/end') {
      const kind = event.data?.reason?.kind
      runtime.status = kind === 'aborted' ? 'cancelled' : kind === 'completed' ? 'completed' : 'failed'
    }
  }

  async listSessions() {
    const byId = new Map()

    // Preferred public seam: sessionQuery lists the live-preferred corpus and
    // folds the durable `session/title` event, so we can show ID + title.
    try {
      const query = this.ctx.get('sessionQuery')
      if (query?.listSessions) {
        const records = await query.listSessions()
        const ids = records.map((record) => record.header.id)
        const titleResults = query.readTitleSnapshots
          ? await query.readTitleSnapshots(ids)
          : []
        const titles = new Map()
        for (const result of titleResults) {
          if (result.status === 'fulfilled') {
            titles.set(result.sessionId, result.value?.title?.title)
          }
        }
        for (const record of records) {
          byId.set(record.header.id, {
            id: record.header.id,
            status: record.live ? 'live' : 'persisted',
            source: record.live ? 'live' : 'persisted',
            title: titles.get(record.header.id) || '',
          })
        }
      }
    } catch (error) {
      this.logger.warn?.('通过 sessionQuery 读取 Session 列表失败:', error?.message || String(error))
    }

    // Fallbacks keep the command useful in compositions without sessionQuery.
    for (const agent of this.ctx.agents.list()) {
      const existing = byId.get(agent.id)
      byId.set(agent.id, {
        ...(existing || {}),
        id: agent.id,
        status: 'live',
        source: 'live',
        title: existing?.title || agent.session?.metadata?.title || '',
      })
    }
    try {
      const persistence = this.ctx.get('sessionPersistence')
      if (persistence?.list) {
        const snapshots = await persistence.list()
        for (const snapshot of snapshots || []) {
          const id = snapshot?.header?.id
          if (!id || byId.has(id)) continue
          byId.set(id, {
            id,
            status: 'persisted',
            source: 'persisted',
            title: snapshot?.header?.title || '',
          })
        }
      }
    } catch (error) {
      this.logger.warn?.('读取持久化 Session 列表失败:', error?.message || String(error))
    }

    return [...byId.values()]
  }

  async bindSession(key, sessionId) {
    const trimmed = String(sessionId || '').trim()
    if (!trimmed) throw new Error('Session ID 不能为空')
    const exists = await this.isLiveOrPersisted(trimmed)
    if (!exists) {
      throw new Error(`找不到 Session ${trimmed}：它可能已被归档或删除。请用 /dsh session list 重新选择`)
    }
    const runtime = this.runtime(key)
    await runtime.delivery.catch(() => undefined)
    await this.releaseRuntime(runtime)
    await this.state.setSessionId(key, trimmed)
    const agent = await this.ensureAgent(runtime)
    this.installSelection(agent.ctx, runtime)
    return agent.id
  }

  observeDisposed(payload) {
    const agent = payload?.agent
    if (!agent) return
    for (const runtime of this.runtimes.values()) {
      if (runtime.agent !== agent) continue
      runtime.agent = undefined
      runtime.handle = undefined
      this.logger.log?.(`检测到 Session ${agent.id} 已销毁，频道 ${runtime.key} 下次消息将重新恢复`)
    }
  }

  /** Whether a stored Session id can still be resumed. */
  async isLiveOrPersisted(sessionId) {
    if (this.ctx.agents.get(sessionId)) return true
    try {
      const persistence = this.ctx.get('sessionPersistence')
      if (persistence?.stat) return Boolean(await persistence.stat(sessionId))
      const query = this.ctx.get('sessionQuery')
      if (query?.listSessions) {
        const records = await query.listSessions()
        return records.some((record) => record.header.id === sessionId)
      }
    } catch {
      return false
    }
    return false
  }

  async cleanupIdle() {
    if (this.disposed) return
    const now = Date.now()
    for (const runtime of this.runtimes.values()) {
      if (
        runtime.handle &&
        !runtime.releasing &&
        runtime.pendingDeliveries === 0 &&
        !runtime.sink &&
        now - runtime.lastUsed > this.config.idleTimeoutMs
      ) {
        await this.releaseRuntime(runtime)
      }
    }
    const live = [...this.runtimes.values()].filter((runtime) => runtime.handle)
    if (live.length > this.config.maxLiveSessions) {
      live.sort((a, b) => a.lastUsed - b.lastUsed)
      for (const runtime of live.slice(0, live.length - this.config.maxLiveSessions)) {
        if (runtime.pendingDeliveries === 0 && !runtime.sink) await this.releaseRuntime(runtime)
      }
    }
  }

  async dispose() {
    if (this.disposed) return
    this.disposed = true
    try {
      this.disposeStream?.()
    } catch {
      /* ignore */
    }
    try {
      this.disposeSession?.()
    } catch {
      /* ignore */
    }
    try {
      this.disposeAgent?.()
    } catch {
      /* ignore */
    }
    const active = [...this.runtimes.values()]
    this.runtimes.clear()
    await Promise.allSettled(active.map((runtime) => this.releaseRuntime(runtime)))
  }
}

function makeUserMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

function assistantTexts(session) {
  try {
    return (session?.deriveMessages?.() ?? [])
      .filter((message) => message?.role === 'assistant')
      .map((message) =>
        (message.content || [])
          .filter((block) => block?.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join(''),
      )
      .filter((text) => text.trim())
  } catch {
    return []
  }
}

function findRuntime(runtimes, agent) {
  for (const runtime of runtimes.values()) {
    if (runtime.agent === agent) return runtime
  }
  return undefined
}

/**
 * Extract a DSH Session ID from an arbitrary Discord autocomplete/title string.
 *
 * Autocomplete choices are rendered as:
 *   "<title> · session-<uuid> · live"
 * and users may paste "/dsh session bind <title> · session-<uuid> · persisted".
 * DSH ids are `session-` followed by a UUID (or a plain slug for older ids).
 */
const SESSION_ID_PATTERN = /(session-[0-9a-zA-Z][0-9a-zA-Z-]*(?:\.[0-9a-zA-Z]+)?)/

export function extractSessionId(value) {
  const text = String(value ?? '').trim()
  if (!text) return ''
  // Prefer a full session-… token anywhere in the string.
  const match = SESSION_ID_PATTERN.exec(text)
  if (match) return match[1].replace(/[.,;:]+$/, '')
  // A bare UUID pasted without the session- prefix.
  const uuid = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(text)
  if (uuid) return `session-${uuid[1]}`
  // A single bare token (custom session id without spaces).
  if (!/\s/.test(text) && text !== '(无标题)') return text
  return ''
}

/**
 * Greeting turns keep the chat friendly without polluting the Session with a
 * robotic instruction. The model sees the user's own words plus a short
 * conversational hint that is not a tool-driving task.
 */
function greetingPrompt(text) {
  return [
    '[对话开场] 用户在 Discord 里 @ 了你，但还没有提出具体任务。',
    '请像真人助理一样回一两句自然的中文：先打招呼，再邀请对方直接说出需求。',
    '不要调用任何工具，不要读取文件，不要输出代码块，不要复述这段说明。',
    text ? `用户随后补充的内容：${text}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}
