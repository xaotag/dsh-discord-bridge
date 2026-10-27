import fsp from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * Append-only SQLite audit log for Discord bridge operations.
 *
 * Only operational metadata is recorded — commands, Discord REST calls, DSH
 * Agent lifecycle and tool calls, DeepSeek REST calls, errors. Conversation
 * content, prompts and model output are never stored.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS ops (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  iso           TEXT    NOT NULL,
  category      TEXT    NOT NULL,
  action        TEXT    NOT NULL,
  status        TEXT    NOT NULL,
  channel_id    TEXT,
  guild_id      TEXT,
  conversation  TEXT,
  session_id    TEXT,
  user_id       TEXT,
  duration_ms   INTEGER,
  detail        TEXT,
  error         TEXT
);
CREATE INDEX IF NOT EXISTS idx_ops_ts       ON ops(ts);
CREATE INDEX IF NOT EXISTS idx_ops_category ON ops(category, ts);
CREATE INDEX IF NOT EXISTS idx_ops_channel  ON ops(channel_id, ts);
CREATE INDEX IF NOT EXISTS idx_ops_session  ON ops(session_id, ts);
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

export class AuditLog {
  constructor({ filename, logger = console, enabled = true } = {}) {
    this.filename = filename
    this.logger = logger
    this.enabled = enabled
    this.db = undefined
    this.statement = undefined
    this.buffer = []
    this.flushing = Promise.resolve()
    this.closed = false
    this.dropped = 0
  }

  async open() {
    if (!this.enabled || this.db) return this
    try {
      await fsp.mkdir(path.dirname(this.filename), { recursive: true })
      const db = new DatabaseSync(this.filename)
      db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 3000;')
      db.exec(SCHEMA)
      db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema_version', '1')
      this.db = db
      this.statement = db.prepare(
        `INSERT INTO ops
         (ts, iso, category, action, status, channel_id, guild_id, conversation,
          session_id, user_id, duration_ms, detail, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      this.logger.log?.(`审计日志已启用: ${this.filename}`)
    } catch (error) {
      this.enabled = false
      this.logger.warn?.(`审计日志初始化失败（将停止记录）: ${error?.message || String(error)}`)
    }
    return this
  }

  /**
   * Record one operation. Detail/error are serialized as JSON with secrets
   * redacted; callers never pass message bodies.
   */
  record({
    category,
    action,
    status = 'ok',
    channelId,
    guildId,
    conversation,
    sessionId,
    userId,
    durationMs,
    detail,
    error,
  }) {
    if (!this.enabled || this.closed) return
    const now = Date.now()
    this.buffer.push([
      now,
      new Date(now).toISOString(),
      String(category || 'unknown'),
      String(action || 'unknown'),
      String(status || 'ok'),
      channelId === undefined ? null : String(channelId),
      guildId === undefined ? null : String(guildId),
      conversation === undefined ? null : String(conversation),
      sessionId === undefined ? null : String(sessionId),
      userId === undefined ? null : String(userId),
      Number.isFinite(durationMs) ? Math.round(durationMs) : null,
      detail === undefined ? null : safeJson(detail),
      error === undefined ? null : truncate(redact(String(error)), 2000),
    ])
    if (this.buffer.length >= 256) void this.flush()
    else if (this.buffer.length === 1) {
      const timer = setTimeout(() => void this.flush(), 250)
      timer.unref?.()
    }
  }

  async flush() {
    if (!this.db || this.buffer.length === 0) return this.flushing
    const rows = this.buffer.splice(0, this.buffer.length)
    this.flushing = this.flushing.then(() => {
      if (!this.db) return
      try {
        this.db.exec('BEGIN')
        for (const row of rows) this.statement.run(...row)
        this.db.exec('COMMIT')
      } catch (error) {
        try {
          this.db.exec('ROLLBACK')
        } catch {
          /* ignore */
        }
        this.dropped += rows.length
        this.logger.warn?.(`审计日志写入失败，丢弃 ${rows.length} 条: ${error?.message || String(error)}`)
      }
    })
    return this.flushing
  }

  /** Read recent rows for a local inspection command. */
  recent({ limit = 20, category, channelId } = {}) {
    if (!this.db) return []
    const clauses = []
    const params = []
    if (category) {
      clauses.push('category = ?')
      params.push(category)
    }
    if (channelId) {
      clauses.push('channel_id = ?')
      params.push(channelId)
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const statement = this.db.prepare(
      `SELECT iso, category, action, status, channel_id, session_id, duration_ms, detail, error
       FROM ops ${where} ORDER BY id DESC LIMIT ?`,
    )
    return statement.all(...params, Math.max(1, Math.min(200, limit)))
  }

  async close() {
    if (this.closed) return
    await this.flush()
    this.closed = true
    try {
      const db = this.db
      this.db = undefined
      this.statement = undefined
      db?.exec('PRAGMA wal_checkpoint(TRUNCATE);')
      db?.close()
    } catch (error) {
      this.logger.warn?.(`关闭审计日志失败: ${error?.message || String(error)}`)
    }
  }
}

function safeJson(value) {
  try {
    return truncate(redact(JSON.stringify(value)), 4000)
  } catch {
    return truncate(redact(String(value)), 4000)
  }
}

function redact(text) {
  return String(text)
    .replace(/MT[A-Za-z0-9._-]{20,}/g, '<discord-token>')
    .replace(/sk-[A-Za-z0-9]{10,}/g, '<api-key>')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{10,}/gi, '$1<redacted>')
}

function truncate(text, limit) {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}
