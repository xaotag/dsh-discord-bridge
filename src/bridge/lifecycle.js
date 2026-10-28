/**
 * Plugin startup: token resolution, Discord connect with backoff, command
 * registration, and the idle-Agent sweep.
 */
import fsp from 'node:fs/promises'
import { DSH_COMMAND_BODY } from '../discord/commands.js'
import { DEEPSEEK_COMMAND_BODY } from '../discord/deepseek-commands.js'

/**
 * Resolve the bot token, preferring the credential store over the environment so
 * a rotated token takes effect without editing the unit file.
 */
export async function resolveToken(runtime) {
  const { ctx, config, logger } = runtime
  let token =
    process.env[config.tokenRef] || process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_TOKEN
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

/**
 * Bring the bridge up.
 *
 * Refuses to start without an allowlist or a usable workspace — a Discord bot
 * that answers everyone is worse than one that stays offline.
 *
 * @param {object} hooks
 * @param {(message:any)=>any} hooks.onMessage
 * @param {(interaction:any)=>any} hooks.onInteraction
 * @returns {() => void} a cleanup-stopper for the idle sweep
 */
export async function startBridge(runtime, { onMessage, onInteraction }) {
  const { ctx, config, state, audit, transport, agents, logger } = runtime
  try {
    await ctx.get('loader')?.await()
  } catch {
    /* loader absent */
  }
  if (runtime.disposed) return () => {}

  if (config.ownerIds.length === 0 && config.allowedUsers.length === 0) {
    logger.warn('未配置 DSH_DISCORD_OWNER_ID 或授权用户，出于安全考虑插件拒绝启动')
    return () => {}
  }

  const token = await resolveToken(runtime)
  if (!token) {
    logger.log(`未配置 Discord Bot Token（tokenRef=${config.tokenRef}），插件跳过启动`)
    return () => {}
  }

  try {
    const info = await fsp.stat(config.workspace)
    if (!info.isDirectory()) throw new Error('不是目录')
  } catch (error) {
    logger.warn(`workspace 不可访问 (${error.message})，插件拒绝启动`)
    return () => {}
  }

  await state.load()
  await audit.open()
  if (runtime.disposed) return () => {}

  let identity
  for (let attempt = 1; !runtime.disposed; attempt += 1) {
    try {
      identity = await transport.start({
        token,
        onMessage: (message) => onMessage(message),
        onInteraction: (interaction) => onInteraction(interaction),
        onReady: async (ready) => {
          runtime.clientUser = ready.user
          if (!runtime.disposed && config.registerCommands) {
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

  if (!identity || runtime.disposed) {
    await transport.stop().catch(() => undefined)
    return () => {}
  }

  runtime.clientUser = identity.user
  if (runtime.disposed) {
    await transport.stop()
    return () => {}
  }

  const timer = setInterval(
    () => {
      void agents.cleanupIdle().catch((error) =>
        logger.warn('清理空闲 Agent 失败:', error?.message || String(error)),
      )
    },
    Math.max(5000, Math.min(60000, config.idleTimeoutMs / 4)),
  )
  timer.unref?.()
  return () => clearInterval(timer)
}
