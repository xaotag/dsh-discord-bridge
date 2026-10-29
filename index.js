/**
 * dsh-discord-bridge composition root.
 *
 * This file only wires things together. Every behaviour lives in `src/`:
 *
 *   src/discord/*                  -> transport, rendering, rate limits, command shapes
 *   src/bridge/runtime.js          -> the shared runtime object handed to each module
 *   src/bridge/lifecycle.js        -> startup, token, connect, idle sweep
 *   src/bridge/message-router.js   -> inbound messages -> commands or prompts
 *   src/bridge/prompt-runner.js    -> running one turn through the Agent
 *   src/bridge/commands/*          -> /dsh subcommand groups
 *   src/bridge/interactions/*      -> buttons, selects, modals, slash interactions
 *   src/bridge/agent-service.js    -> DSH Agent / model / session seam (no Discord)
 */
import path from 'node:path'
import os from 'node:os'
import { loadEnvFile, resolveConfig } from './src/config.js'
import { StateStore } from './src/state-store.js'
import { DiscordRateLimiter } from './src/discord/rate-limiter.js'
import { DiscordTransport } from './src/discord/transport.js'
import { AgentService } from './src/bridge/agent-service.js'
import { DeepSeekApiClient } from './src/deepseek/api-client.js'
import { ThreadManager } from './src/bridge/thread-manager.js'
import { ApprovalRegistry } from './src/bridge/approval.js'
import { QuestionRegistry } from './src/bridge/question-registry.js'
import { PrivilegedClient } from './src/bridge/privileged-client.js'
import { AuditLog } from './src/audit/db.js'
import { DELEGATE, createLogger, createRuntime } from './src/bridge/runtime.js'
import { startBridge } from './src/bridge/lifecycle.js'
import { handleMessage } from './src/bridge/message-router.js'
import { createInteractionHandler } from './src/bridge/interactions/index.js'
import { answerUserQuestions } from './src/bridge/interactions/question.js'
import { answerApprovalRequest } from './src/bridge/interactions/approval.js'

export const name = 'dsh-discord-bridge'
export const inject = ['agents']
export const Config = undefined

export function apply(ctx, rawConfig = {}) {
  loadEnvFile()
  const logger = createLogger()
  const config = resolveConfig(rawConfig)

  // Build the primitives first: several services need the same audit/transport
  // instances, and the runtime is just the bag that carries them.
  const state = new StateStore(config.statePath)
  const audit = new AuditLog({ filename: config.auditPath, logger, enabled: config.auditEnabled })
  const transport = new DiscordTransport({
    logger,
    rateLimiter: new DiscordRateLimiter({ logger, maxRetries: config.maxRateLimitRetries }),
  })
  transport.setAudit(audit)

  const runtime = createRuntime({
    ctx,
    config,
    logger,
    state,
    audit,
    transport,
    agents: new AgentService({ ctx, config, state, logger, audit }),
    approvals: new ApprovalRegistry({ logger }),
    questions: new QuestionRegistry({ logger }),
    privileged: new PrivilegedClient({
      dshHome: process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
      logger,
    }),
    deepseek: new DeepSeekApiClient({ ctx, logger, audit }),
    threads: new ThreadManager({
      transport,
      archiveMinutes: config.threadArchiveMinutes,
      logger,
    }),
  })

  const handleInteraction = createInteractionHandler(runtime)
  let stopSweep = () => {}

  /**
   * Answer `ask_user_question` from Discord.
   *
   * Scope-filtered dispatch admits untagged listeners — a root listener sees
   * every agent's request (see `@deepseek-ai/dsh-scope`). Without any answerer
   * DSH rejects with `no user-questions answerer accepted the request`, which is
   * why a turn that called this tool used to hang forever.
   *
   * A request whose channel cannot be resolved is handed to `next()` so the Web
   * answerer still gets a chance, and any failure settles as all-skipped: the
   * agent must never be left waiting on a promise nobody will resolve.
   */
  ctx.on('user-questions/request', async (request, next) => {
    if (runtime.disposed) return next()
    const questions = Array.isArray(request?.questions) ? request.questions : []
    if (!questions.length) return next()

    const channelId = runtime.agents.channelForAgent(request?.agent)
    logger.log(
      `[user-questions] 收到 ${questions.length} 个问题 agent=${Boolean(request?.agent)} channel=${channelId || '(未匹配)'}`,
    )
    if (!channelId) return next()

    try {
      const answer = await answerUserQuestions(runtime, request)
      return answer === DELEGATE ? next() : answer
    } catch (error) {
      logger.warn('处理 ask_user_question 失败，按跳过处理:', error?.message || String(error))
      return { answers: questions.map((q) => ({ id: q.id, selected: [] })) }
    }
  })

  /**
   * Answer DSH `approval/request` from Discord.
   *
   * DSH asks before a tool escalates its sandbox (or a hook demands a
   * decision). Without an answerer it fails closed, so a refused or unanswered
   * card is the difference between "allowed once" and "the turn ends red".
   * Requests for an agent this bridge does not own are handed to `next()` so
   * the Web answerer keeps its chance.
   */
  ctx.on('approval/request', async (request, next) => {
    if (runtime.disposed) return next()
    try {
      const outcome = await answerApprovalRequest(runtime, request)
      return outcome === DELEGATE ? next() : outcome
    } catch (error) {
      logger.warn('处理 approval 请求失败，交由下一个 answerer:', error?.message || String(error))
      return next()
    }
  })

  ctx.effect(
    () => () => {
      if (runtime.disposed) return
      runtime.disposed = true
      stopSweep()
      return (async () => {
        // Settle any awaited confirmation or question so no turn hangs.
        runtime.approvals.clear('timeout')
        runtime.questions.clear('timeout')
        await Promise.allSettled([
          runtime.agents.dispose(),
          runtime.transport.stop(),
          runtime.state.close(),
          runtime.audit.close(),
        ])
        logger.log('插件卸载，Discord 连接和 Agent 已释放')
      })()
    },
    'dsh-discord-bridge.lifecycle',
  )

  startBridge(runtime, {
    onMessage: (message) => handleMessage(runtime, message),
    onInteraction: (interaction) => handleInteraction(interaction),
  })
    .then((stop) => {
      stopSweep = stop
    })
    .catch((error) => logger.warn('启动失败:', error?.stack || error?.message || String(error)))
}
