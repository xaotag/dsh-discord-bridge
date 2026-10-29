import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function listValue(value) {
  if (Array.isArray(value)) return value.map(String).map((s) => s.trim()).filter(Boolean)
  if (typeof value !== 'string') return []
  return value.split(',').map((s) => s.trim()).filter(Boolean)
}

function boolValue(value, fallback) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    if (/^(1|true|yes|on)$/i.test(value.trim())) return true
    if (/^(0|false|no|off)$/i.test(value.trim())) return false
  }
  return fallback
}

function nonEmpty(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/**
 * Resolve a user-supplied path. `path.resolve` does not expand `~`, so a
 * documented `~/.dsh/...` value would otherwise create a literal `~` directory
 * relative to the process cwd.
 */
function resolveUserPath(value) {
  const raw = nonEmpty(value)
  if (!raw) return undefined
  if (raw === '~') return os.homedir()
  if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2))
  return path.resolve(raw)
}

function positiveNumber(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** Zero is meaningful here ("do not wait"), unlike for the other timings. */
function nonNegativeNumber(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

export function loadEnvFile(file) {
  const filename =
    file ||
    process.env.DSH_DISCORD_ENV ||
    path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'discord-bridge.env')
  if (!fs.existsSync(filename)) return filename
  try {
    for (const line of fs.readFileSync(filename, 'utf8').split('\n')) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
      if (!match) continue
      let value = match[2].trim()
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      // Process environment wins over the local file, as in DSH conventions.
      if (!(match[1] in process.env)) process.env[match[1]] = value
    }
  } catch {
    /* fall back to process env */
  }
  return filename
}

export function resolveConfig(raw = {}) {
  const ownerIds = listValue(raw.ownerIds || raw.ownerId || process.env.DSH_DISCORD_OWNER_ID)
  const allowedUsers = listValue(
    raw.allowedUserIds || raw.allowedUsers || process.env.DSH_DISCORD_ALLOWED_USER_IDS,
  )
  const allowedGuilds = listValue(
    raw.allowedGuildIds || raw.allowedGuilds || process.env.DSH_DISCORD_ALLOWED_GUILD_IDS,
  )
  const allowedChannels = listValue(
    raw.allowedChannelIds || raw.allowedChannels || process.env.DSH_DISCORD_ALLOWED_CHANNEL_IDS,
  )
  const requestedIsolation =
    nonEmpty(raw.isolation) || nonEmpty(process.env.DSH_DISCORD_ISOLATION) || 'channel'
  const isolation = ['channel', 'user-channel', 'user', 'guild-user'].includes(requestedIsolation)
    ? requestedIsolation
    : 'channel'
  const statePath =
    resolveUserPath(raw.statePath) ||
    resolveUserPath(process.env.DSH_DISCORD_STATE) ||
    path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'dsh-discord', 'state.json')
  return {
    tokenRef:
      nonEmpty(raw.tokenRef) || nonEmpty(process.env.DSH_DISCORD_TOKEN_REF) || 'DISCORD_BOT_TOKEN',
    ownerIds,
    allowedUsers,
    allowedGuilds,
    allowedChannels,
    isolation,
    workspace: path.resolve(
      nonEmpty(raw.workspace) || nonEmpty(process.env.DSH_DISCORD_WORKSPACE) || process.cwd(),
    ),
    statePath,
    auditEnabled: boolValue(raw.auditEnabled ?? process.env.DSH_DISCORD_AUDIT, true),
    auditPath:
      resolveUserPath(raw.auditPath) ||
      resolveUserPath(process.env.DSH_DISCORD_AUDIT_DB) ||
      path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'dsh-discord', 'audit.sqlite'),
    requireMention: boolValue(raw.requireMention ?? process.env.DSH_DISCORD_REQUIRE_MENTION, true),
    registerCommands: boolValue(
      raw.registerCommands ?? process.env.DSH_DISCORD_REGISTER_COMMANDS,
      true,
    ),
    commandGuildId:
      nonEmpty(raw.commandGuildId) || nonEmpty(process.env.DSH_DISCORD_COMMAND_GUILD_ID),
    provider: nonEmpty(raw.provider) || nonEmpty(process.env.DSH_DISCORD_PROVIDER),
    model: nonEmpty(raw.model) || nonEmpty(process.env.DSH_DISCORD_MODEL),
    deepseekModel:
      nonEmpty(raw.deepseekModel) ||
      nonEmpty(process.env.DSH_DEEPSEEK_MODEL) ||
      nonEmpty(process.env.DSH_DISCORD_DEEPSEEK_MODEL) ||
      'deepseek-flash',
    reasoningEffort:
      nonEmpty(raw.reasoningEffort) || nonEmpty(process.env.DSH_DISCORD_REASONING_EFFORT),
    // Agent preset mounted into every Discord Agent. The Web surface disables
    // the host-plane tool rows and lets each Agent mount a preset instead, so
    // without this a Discord Agent only sees plugin-level tools (no bash/fs).
    agentPreset:
      nonEmpty(raw.agentPreset) ||
      nonEmpty(process.env.DSH_DISCORD_AGENT_PRESET) ||
      'standard',
    streamEditIntervalMs: positiveNumber(
      raw.streamEditIntervalMs ?? process.env.DSH_DISCORD_STREAM_EDIT_INTERVAL_MS,
      1500,
    ),
    idleTimeoutMs: positiveNumber(
      raw.idleTimeoutMs ?? process.env.DSH_DISCORD_IDLE_TIMEOUT_MS,
      30 * 60 * 1000,
    ),
    maxLiveSessions: Math.max(
      1,
      Math.floor(positiveNumber(raw.maxLiveSessions ?? process.env.DSH_DISCORD_MAX_LIVE_SESSIONS, 8)),
    ),
    // How long a finished turn keeps its card open for delegated children that
    // are still running. A child may outlive the parent turn (background
    // delivery); without this the parent card reports "完成" while a subagent is
    // still asking for approvals. 0 disables the wait.
    subagentSettleMs: nonNegativeNumber(
      raw.subagentSettleMs ?? process.env.DSH_DISCORD_SUBAGENT_SETTLE_MS,
      120 * 1000,
    ),
    autoThread: boolValue(raw.autoThread ?? process.env.DSH_DISCORD_AUTO_THREAD, true),
    complexityThreshold: Math.max(
      1,
      Math.floor(positiveNumber(raw.complexityThreshold ?? process.env.DSH_DISCORD_COMPLEXITY_THRESHOLD, 600)),
    ),
    threadArchiveMinutes: Math.max(
      60,
      Math.floor(positiveNumber(raw.threadArchiveMinutes ?? process.env.DSH_DISCORD_THREAD_ARCHIVE_MINUTES, 1440)),
    ),
    maxRateLimitRetries: Math.max(
      0,
      Math.floor(positiveNumber(raw.maxRateLimitRetries ?? process.env.DSH_DISCORD_MAX_RATE_LIMIT_RETRIES, 5)),
    ),
  }
}

export function authorized(config, userId, guildId, channelId) {
  if (config.ownerIds.length === 0 && config.allowedUsers.length === 0) return false
  if (config.ownerIds.length > 0 && !config.ownerIds.includes(userId)) return false
  if (config.allowedUsers.length > 0 && !config.allowedUsers.includes(userId)) return false
  if (config.allowedGuilds.length > 0 && (!guildId || !config.allowedGuilds.includes(guildId))) return false
  if (config.allowedChannels.length > 0 && !config.allowedChannels.includes(channelId)) return false
  return true
}

export { listValue, boolValue, nonEmpty, positiveNumber, nonNegativeNumber }
