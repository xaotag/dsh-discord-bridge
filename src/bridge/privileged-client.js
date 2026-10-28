/**
 * DSH-side client for the privileged executor.
 *
 * The bridge cannot escalate, so a request is written to the shared queue and
 * this client polls for the daemon's result. The caller awaits the outcome, so
 * a gated action reads like an ordinary blocking call.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import {
  OUTPUT_LIMIT_BYTES,
  doneDir,
  makeRequest,
  privilegedRoot,
  queueDir,
  readSecret,
  signRequest,
  writeRequestAtomic,
} from './privileged-protocol.js'

const POLL_INTERVAL_MS = 200

export class PrivilegedClient {
  /**
   * @param {object} options
   * @param {string} options.dshHome   $DSH_HOME
   * @param {object} [options.logger]
   */
  constructor({ dshHome, logger = console } = {}) {
    this.root = privilegedRoot(dshHome)
    this.logger = logger
    this.secret = undefined
  }

  async ensureSecret() {
    if (this.secret) return this.secret
    this.secret = await readSecret(this.root)
    return this.secret
  }

  /** True when the daemon has been provisioned (secret file present). */
  async available() {
    try {
      await this.ensureSecret()
      return true
    } catch {
      return false
    }
  }

  /**
   * Submit a command and await its result.
   *
   * @returns {Promise<{status:'ok'|'denied'|'timeout'|'error', exitCode?:number,
   *   stdout?:string, stderr?:string, message?:string}>}
   * Never throws: an unavailable daemon or a timeout resolves to a status the
   * caller renders, so a gated action cannot wedge a turn.
   */
  async run({ command, cwd, timeoutMs, requestedBy, channelId, waitMs } = {}) {
    let secret
    try {
      secret = await this.ensureSecret()
    } catch {
      return {
        status: 'error',
        message: '提权执行器未安装（缺少 secret），请先运行守护进程安装脚本。',
      }
    }

    const body = makeRequest({ command, cwd, timeoutMs, requestedBy, channelId })
    const request = { ...body, sig: signRequest(body, secret) }

    try {
      await writeRequestAtomic(queueDir(this.root), request)
    } catch (error) {
      return { status: 'error', message: `提交提权请求失败：${error?.message || String(error)}` }
    }

    const deadline = Date.now() + (Number.isFinite(waitMs) ? waitMs : body.timeoutMs + 15_000)
    const resultFile = path.join(doneDir(this.root), `${body.id}.json`)

    while (Date.now() < deadline) {
      const result = await this.readResult(resultFile)
      if (result) return result
      await sleep(POLL_INTERVAL_MS)
    }
    return { status: 'timeout', message: '等待提权执行结果超时。' }
  }

  async readResult(file) {
    let raw
    try {
      raw = await fsp.readFile(file, 'utf8')
    } catch {
      return undefined
    }
    try {
      const parsed = JSON.parse(raw)
      return normalizeResult(parsed)
    } catch {
      return { status: 'error', message: '提权执行器返回了无法解析的结果。' }
    }
  }
}

function normalizeResult(parsed) {
  const stdout = clip(parsed.stdout)
  const stderr = clip(parsed.stderr)
  const out = {
    status: parsed.status === 'ok' ? 'ok' : parsed.status === 'denied' ? 'denied' : 'error',
    exitCode: Number.isFinite(parsed.exitCode) ? parsed.exitCode : undefined,
    stdout,
    stderr,
    message: parsed.message ? String(parsed.message) : undefined,
    durationMs: Number.isFinite(parsed.durationMs) ? parsed.durationMs : undefined,
  }
  // A non-zero exit is a normal command outcome, not a transport failure.
  if (out.status === 'ok' && out.exitCode !== 0) out.status = 'error'
  return out
}

function clip(text) {
  if (typeof text !== 'string') return undefined
  if (text.length <= OUTPUT_LIMIT_BYTES) return text
  return `${text.slice(0, OUTPUT_LIMIT_BYTES)}\n…（输出已截断）`
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
