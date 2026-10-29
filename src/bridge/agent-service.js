import { randomUUID } from 'node:crypto'
import { UNTRUSTED_INPUT_POLICY } from './untrusted.js'
import { SUBAGENT_PERMISSION_GUIDE, SUBAGENT_QUESTION_GUIDE } from './prompt-guidance.js'
import { listModels, listReasoningEfforts } from './agent-catalog.js'
import { SessionTree } from './session-tree.js'

/** How long a finished turn waits for delegated children by default. */
const DEFAULT_SUBAGENT_SETTLE_MS = 120 * 1000

/** Poll interval used while waiting for children to finish. */
const SETTLE_POLL_MS = 250

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
    // Lineage of every Session observed under a bridge conversation. Identity
    // matching on `runtime.agent` cannot see delegated Agents at all, so the
    // tree is what lets their requests and events find the owning channel.
    this.tree = new SessionTree()
    // childSessionId -> conversation key, for children between their start and
    // their turn end. settleChildren() waits on this; the tree alone keeps
    // ended children forever.
    this.activeSubagents = new Map()
    // Pending settleChildren() resolvers, so dispose() can unblock them.
    this.settleWaiters = new Set()
    // childSessionId -> sink that owns the child's Discord thread. A child the
    // operator is chatting with directly renders there, not on the parent card.
    this.childSinks = new Map()
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
    // A delegated Agent is a different object from the root agent held by the
    // runtime, so the identity loop above always misses it. The tree knows
    // which root session owns the child; when lineage cannot be followed the
    // request stays unowned instead of being guessed onto some channel.
    const entry = this.tree.resolve(agent)
    if (!entry) return undefined
    return this.runtimes.get(entry.key)?.channelId
  }

  /**
   * Conversation entry ({ key, depth, label, … }) for an Agent or Session.
   *
   * Exposed for the interaction layer: it needs the child's label/depth to
   * title an approval or question card, and `undefined` keeps the root wording.
   */
  resolveAgent(agent) {
    return this.tree.resolve(agent)
  }

  /** Children of one conversation that resolve to a depth above the root. */
  subagentCount(key) {
    return this.tree.childrenOf(key).filter((node) => (node.depth ?? 0) > 0).length
  }

  /** Live Agent for a delegated child Session, if it is still resident. */
  childAgent(childSessionId) {
    if (!childSessionId) return undefined
    try {
      return this.ctx.agents.get(childSessionId) ?? undefined
    } catch {
      return undefined
    }
  }

  /** Live root Agent for a conversation key, resuming it when needed. */
  async ensureConversationAgent(key) {
    if (this.disposed) return undefined
    try {
      return await this.ensureAgent(this.runtime(key))
    } catch (error) {
      this.logger.warn?.('恢复父会话失败:', error?.message || String(error))
      return undefined
    }
  }

  /** Route one child's activity to the Discord thread that owns it. */
  bindChildSink(childSessionId, sink) {
    if (childSessionId) this.childSinks.set(childSessionId, sink)
  }

  unbindChildSink(childSessionId) {
    this.childSinks.delete(childSessionId)
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
        // Presentation-only: tells the root Agent to name the child in a
        // question header so the card can be filed under the child's thread.
        systemPrompt.section({
          name: 'discord:subagent-question-guide',
          order: -999_999,
          text: SUBAGENT_QUESTION_GUIDE,
          interpolate: false,
        })
        // Delegation-time fact: a child's approval policy is pinned to `never`,
        // so the root has to switch the preset before delegating instead of
        // expecting the child to ask.
        systemPrompt.section({
          name: 'discord:subagent-permission-guide',
          order: -999_998,
          text: SUBAGENT_PERMISSION_GUIDE,
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
        this.tree.attachRoot(runtime.key, live.session)
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
        this.tree.attachRoot(runtime.key, handle.agent.session)
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
      this.tree.attachRoot(runtime.key, handle.agent.session)
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
      // Nothing under this Session can reach a conversation any more, and a
      // settled child must not keep reporting as running on a future card.
      this.tree.detachRoot(runtime.key)
      this.#forgetSubagents(runtime.key)
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

  async run(key, meta, text, sink, { greeting = false, images = [] } = {}) {
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
        agent.followup(makeUserMessage(greeting ? greetingPrompt(text) : text, { images }))
        await agent.whenIdle()
        // A delegated child can outlive the parent turn (background delivery or
        // a blocked approval). Give the card a bounded window to keep showing it
        // instead of freezing the answer while the child is still running. A
        // timeout is reported in the audit, never thrown: the parent turn is
        // already complete.
        const settleMs = this.config.subagentSettleMs ?? DEFAULT_SUBAGENT_SETTLE_MS
        const settled =
          settleMs > 0
            ? await this.settleChildren(runtime.key, { timeoutMs: settleMs })
            : { settled: true, remaining: 0 }
        if (!settled.settled) {
          this.logger.warn?.(
            `子代理在 ${settleMs}ms 内未结束，剩余 ${settled.remaining} 个；父回复继续`,
          )
        }
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
          detail: {
            replyLength: finalText.trim().length,
            ...(settled.settled ? {} : { subagentRemaining: settled.remaining }),
          },
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
   * `request` is the provider-reported usage of the newest billed request — the
   * same number the official console shows for a call, which is why the cache
   * hit rate is taken from it rather than from the session-wide average.
   * `tokenUsage` totals stay as the fallback for a session whose last step
   * recorded no buckets, and `contextPressure` carries the newest prompt size
   * and the route's capacity. Everything is optional: a turn where the
   * provider reported nothing omits the footer bits instead of inventing
   * numbers.
   */
  usageSnapshot(session) {
    if (!session) return undefined
    try {
      const projections = this.ctx.get('sessionProjections')
      const snapshot = projections?.snapshot?.(session, ['tokenUsage', 'contextPressure'])
      const usage = snapshot?.values?.tokenUsage
      const pressure = snapshot?.values?.contextPressure
      // The wire view only carries session totals; the last request's buckets
      // live in the unit's host state.
      const last = projections?.stateOf?.(session, 'tokenUsage')?.last
      if (!usage && !pressure && !last) return undefined
      return {
        ...(usage ?? {}),
        ...(pressure ?? {}),
        ...(last ? { request: { turn: last.turn, step: last.step, ...last.buckets } } : {}),
      }
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
    if (!runtime) {
      this.observeSubagentStream(agent, frame)
      return
    }
    if (!runtime.sink) return
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

  /**
   * Streaming half of subagent observation.
   *
   * Child text is forwarded as a sink event only. It must never touch the root
   * runtime's `streamText`: that buffer is the parent's final answer, and mixing
   * a child's narration into it would present delegated work as the parent's.
   */
  observeSubagentStream(agent, frame) {
    const entry = this.tree.resolve(agent)
    if (!entry || entry.depth === 0) return
    if (frame.type !== 'chunk') return
    const direct = this.childSinks.get(entry.sessionId)
    if (direct) {
      // The operator opened this child's thread, so its prose is that card's
      // answer rather than a line on the parent's card.
      if (frame.chunk?.type === 'text-delta') direct.onTextDelta?.(frame.chunk.text)
      else if (frame.chunk?.type === 'reasoning-delta') direct.onReasoningDelta?.(frame.chunk.text)
      return
    }
    const runtime = this.runtimes.get(entry.key)
    if (!runtime?.sink) return
    if (frame.chunk?.type !== 'text-delta') return
    this.activeSubagents.set(entry.sessionId, entry.key)
    runtime.sink.onSubagentEvent?.({
      kind: 'text',
      child: { id: entry.sessionId, label: entry.label, depth: entry.depth },
      text: frame.chunk.text,
    })
  }

  observeSession(session, event) {
    if (!session?.id) return
    this.tree.note(session)
    const entry = this.tree.resolve(session)
    if (event?.type === 'subagent/catalog') {
      this.observeCatalog(session, event.data, entry)
      return
    }
    if (!entry) return
    const runtime = this.runtimes.get(entry.key)
    if (!runtime) return
    if (entry.depth > 0) {
      this.observeSubagentEvent(runtime, entry, event)
      return
    }
    // Root events keep their existing audit and sink contract unchanged.
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

  /**
   * `subagent/catalog` is emitted on the *parent* Session and is the only place
   * DSH names a child. Recording it lets cards show a label instead of an id.
   */
  observeCatalog(session, data, parentEntry) {
    const childId = data?.childId ?? data?.id
    if (!childId) return
    this.tree.learnChild(session.id, data)
    const entry = this.tree.resolve({ id: childId })
    if (!entry || entry.depth === 0) return
    this.activeSubagents.set(childId, entry.key)
    const runtime = this.runtimes.get(parentEntry?.key ?? entry.key)
    runtime?.sink?.onSubagentEvent?.({
      kind: 'child-start',
      child: { id: childId, label: entry.label, depth: entry.depth },
    })
  }

  /**
   * Child tool/turn events feed the card, not the audit.
   *
   * Writing them into the parent conversation's audit rows would attribute a
   * child's tool calls to the parent turn; the presentation layer counts them
   * through the sink instead.
   */
  observeSubagentEvent(runtime, entry, event) {
    const child = { id: entry.sessionId, label: entry.label, depth: entry.depth }
    const direct = this.childSinks.get(entry.sessionId)
    if (direct && event.type === 'tool/call') {
      this.activeSubagents.set(entry.sessionId, entry.key)
      direct.onToolCall?.(event.data?.name, event.data?.arguments)
      return
    }
    if (direct && event.type === 'tool/result') {
      direct.onToolResult?.(event.data)
      return
    }
    if (event.type === 'tool/call') {
      this.activeSubagents.set(entry.sessionId, entry.key)
      runtime.sink?.onSubagentEvent?.({
        kind: 'tool-call',
        child,
        name: event.data?.name,
        args: event.data?.arguments,
      })
    } else if (event.type === 'tool/result') {
      this.activeSubagents.set(entry.sessionId, entry.key)
      runtime.sink?.onSubagentEvent?.({ kind: 'tool-result', child, result: event.data })
    } else if (event.type === 'turn/end') {
      this.activeSubagents.delete(entry.sessionId)
      const kind = event.data?.reason?.kind
      const status = kind === 'aborted' ? 'cancelled' : kind === 'completed' ? 'completed' : 'failed'
      runtime.sink?.onSubagentEvent?.({ kind: 'turn-end', child, status })
    }
  }

  /**
   * Wait until the delegated children of one conversation have ended.
   *
   * Bounded by `timeoutMs` and never rejects: a child stuck on an approval must
   * not keep the parent turn (and its card) open forever.
   */
  settleChildren(key, { timeoutMs = this.config.subagentSettleMs ?? DEFAULT_SUBAGENT_SETTLE_MS } = {}) {
    const limit = Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_SUBAGENT_SETTLE_MS
    const remaining = () => this.activeSubagentCount(key)
    if (this.disposed || limit <= 0 || remaining() === 0) {
      return Promise.resolve({ settled: remaining() === 0, remaining: remaining() })
    }
    return new Promise((resolve) => {
      const deadline = Date.now() + limit
      let timer
      const finish = () => {
        if (timer) clearTimeout(timer)
        this.settleWaiters.delete(finish)
        const left = remaining()
        resolve({ settled: left === 0, remaining: left })
      }
      const tick = () => {
        if (this.disposed || remaining() === 0 || Date.now() >= deadline) {
          finish()
          return
        }
        timer = setTimeout(tick, Math.min(SETTLE_POLL_MS, Math.max(0, deadline - Date.now())))
        // A wait must never hold the process open on its own.
        timer.unref?.()
      }
      this.settleWaiters.add(finish)
      timer = setTimeout(tick, Math.min(SETTLE_POLL_MS, limit))
      timer.unref?.()
    })
  }

  /** Running children of one conversation, used by settleChildren(). */
  activeSubagentCount(key) {
    let count = 0
    for (const childKey of this.activeSubagents.values()) {
      if (childKey === key) count += 1
    }
    return count
  }

  #forgetSubagents(key) {
    for (const [childId, childKey] of [...this.activeSubagents]) {
      if (childKey === key) this.activeSubagents.delete(childId)
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
    // A disposed child can no longer produce a turn/end, so it must not keep
    // a parent turn waiting for the whole settle budget.
    const childId = agent.session?.id
    if (childId) this.activeSubagents.delete(childId)
    for (const runtime of this.runtimes.values()) {
      if (runtime.agent !== agent) continue
      runtime.agent = undefined
      runtime.handle = undefined
      this.tree.detachRoot(runtime.key)
      this.#forgetSubagents(runtime.key)
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
    // Unblock any run() still waiting on settleChildren(); shutdown must not
    // wait out the settle timeout.
    for (const finish of [...this.settleWaiters]) finish()
    this.settleWaiters.clear()
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
    this.tree.clear()
    this.activeSubagents.clear()
  }
}

/**
 * Build a user message, with images appended as `image` content blocks.
 *
 * A message with nothing but images still carries an empty text part, because
 * every provider path expects at least one block.
 */
export function makeUserMessage(text, { images = [] } = {}) {
  const content = []
  const body = String(text ?? '')
  if (body) content.push({ type: 'text', text: body })
  for (const image of images) content.push({ type: 'image', attachment: image })
  if (content.length === 0) content.push({ type: 'text', text: '' })
  return {
    id: randomUUID(),
    role: 'user',
    content,
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
