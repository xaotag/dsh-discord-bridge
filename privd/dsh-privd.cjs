#!/usr/bin/env node
/**
 * dsh-privd — privileged executor for DSH.
 *
 * Runs as root, outside the DSH sandbox. Polls the request queue written by the
 * DSH process, verifies each request's HMAC, executes it, and writes the result
 * back. It never reads commands from anywhere else, so a stray file is useless
 * without the shared secret.
 *
 * Deliberately dependency-free: it must run as root on a minimal install, so it
 * uses only Node built-ins.
 */
const crypto = require('node:crypto')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { spawn } = require('node:child_process')

const DSH_HOME =
  process.env.DSH_HOME || path.join(process.env.HOME || '/root', '.dsh')
const ROOT = path.join(DSH_HOME, 'privileged')
const QUEUE = path.join(ROOT, 'queue')
const WORK = path.join(ROOT, 'work')
const DONE = path.join(ROOT, 'done')
const SECRET_FILE = path.join(ROOT, 'secret')
const AUDIT = path.join(ROOT, 'audit.jsonl')
const POLL_MS = 200
const OUTPUT_LIMIT = 256 * 1024
const MAX_COMMAND_BYTES = 64 * 1024

function log(...args) {
  process.stdout.write(`${new Date().toISOString()} ${args.join(' ')}\n`)
}

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  // Skip undefined so the signer and verifier always see the same key set:
  // JSON.stringify drops such keys when the request is written to disk.
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`
}

function verify(request, secret) {
  if (!request || typeof request !== 'object') return false
  const { sig, ...body } = request
  if (typeof sig !== 'string' || !sig) return false
  const expected = crypto.createHmac('sha256', secret).update(canonicalize(body)).digest('hex')
  const a = Buffer.from(sig, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

async function appendAudit(entry) {
  try {
    await fsp.appendFile(AUDIT, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
  } catch (error) {
    log('audit write failed:', error.message)
  }
}

function clip(text) {
  if (typeof text !== 'string') return ''
  return text.length <= OUTPUT_LIMIT ? text : text.slice(0, OUTPUT_LIMIT)
}

/**
 * Run one command. Uses /bin/sh -c because the operator approved a shell
 * command, and a shell is what sudo itself would have run.
 */
function execute({ command, cwd, timeoutMs }) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    let stdout = ''
    let stderr = ''
    let settled = false

    let child
    try {
      child = spawn('/bin/sh', ['-c', command], {
        cwd: cwd && path.isAbsolute(cwd) ? cwd : '/',
        env: {
          PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
          HOME: '/root',
          LANG: 'C.UTF-8',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ status: 'error', message: `spawn failed: ${error.message}` })
      return
    }

    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ...result, durationMs: Date.now() - startedAt })
    }

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      finish({ status: 'error', message: `timeout after ${timeoutMs}ms` })
    }, Math.max(1000, Math.min(timeoutMs || 120000, 600000)))

    child.stdout.on('data', (chunk) => {
      if (stdout.length < OUTPUT_LIMIT) stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk) => {
      if (stderr.length < OUTPUT_LIMIT) stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => finish({ status: 'error', message: error.message }))
    child.on('close', (code, signal) => {
      finish({
        status: 'ok',
        exitCode: typeof code === 'number' ? code : undefined,
        signal: signal || undefined,
        stdout: clip(stdout),
        stderr: clip(stderr),
      })
    })
  })
}

async function writeResult(id, payload) {
  await fsp.mkdir(DONE, { recursive: true })
  const tmp = path.join(DONE, `.tmp-${id}`)
  const target = path.join(DONE, `${id}.json`)
  await fsp.writeFile(tmp, JSON.stringify(payload), { mode: 0o644 })
  await fsp.rename(tmp, target)
}

async function handle(requestFile, secret) {
  const id = path.basename(requestFile, '.json')
  let request
  try {
    request = JSON.parse(await fsp.readFile(requestFile, 'utf8'))
  } catch (error) {
    log(`reject ${id}: unreadable (${error.message})`)
    await appendAudit({ ts: Date.now(), id, status: 'rejected', reason: 'unreadable' })
    await fsp.unlink(requestFile).catch(() => {})
    return
  }

  if (!verify(request, secret)) {
    log(`reject ${id}: bad signature`)
    await appendAudit({ ts: Date.now(), id, status: 'rejected', reason: 'bad-signature' })
    await fsp.unlink(requestFile).catch(() => {})
    await writeResult(id, { status: 'denied', message: 'signature verification failed' })
    return
  }

  if (request.id !== id) {
    log(`reject ${id}: id mismatch`)
    await appendAudit({ ts: Date.now(), id, status: 'rejected', reason: 'id-mismatch' })
    await fsp.unlink(requestFile).catch(() => {})
    return
  }

  if (typeof request.expiresAt === 'number' && Date.now() > request.expiresAt) {
    log(`reject ${id}: expired`)
    await appendAudit({ ts: Date.now(), id, status: 'rejected', reason: 'expired' })
    await fsp.unlink(requestFile).catch(() => {})
    await writeResult(id, { status: 'error', message: 'request expired before execution' })
    return
  }

  const command = String(request.command || '')
  if (!command.trim()) {
    await appendAudit({ ts: Date.now(), id, status: 'rejected', reason: 'empty-command' })
    await fsp.unlink(requestFile).catch(() => {})
    await writeResult(id, { status: 'error', message: 'empty command' })
    return
  }
  if (Buffer.byteLength(command, 'utf8') > MAX_COMMAND_BYTES) {
    await appendAudit({ ts: Date.now(), id, status: 'rejected', reason: 'command-too-long' })
    await fsp.unlink(requestFile).catch(() => {})
    await writeResult(id, { status: 'error', message: 'command too long' })
    return
  }

  log(`exec ${id} (${request.requestedBy || 'unknown'}): ${command.slice(0, 120)}`)
  await appendAudit({
    ts: Date.now(),
    id,
    status: 'executing',
    command,
    requestedBy: request.requestedBy,
    channelId: request.channelId,
    cwd: request.cwd,
  })

  const result = await execute({
    command,
    cwd: request.cwd,
    timeoutMs: request.timeoutMs,
  })

  await writeResult(id, { ...result, id, command })
  await appendAudit({
    ts: Date.now(),
    id,
    status: result.status,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    message: result.message,
  })
  await fsp.unlink(requestFile).catch(() => {})

  // Keep done/ small: results older than an hour are no longer useful.
  void pruneDone().catch(() => {})
}

async function pruneDone() {
  let entries
  try {
    entries = await fsp.readdir(DONE)
  } catch {
    return
  }
  const cutoff = Date.now() - 60 * 60 * 1000
  for (const name of entries) {
    if (!name.endsWith('.json')) continue
    const file = path.join(DONE, name)
    try {
      const stat = await fsp.stat(file)
      if (stat.mtimeMs < cutoff) await fsp.unlink(file)
    } catch {
      /* ignore */
    }
  }
}

async function main() {
  let secret
  try {
    secret = (await fsp.readFile(SECRET_FILE, 'utf8')).trim()
  } catch {
    log(`fatal: cannot read ${SECRET_FILE}`)
    process.exit(1)
  }
  if (secret.length < 32) {
    log('fatal: secret too short')
    process.exit(1)
  }

  await fsp.mkdir(QUEUE, { recursive: true })
  await fsp.mkdir(WORK, { recursive: true })
  await fsp.mkdir(DONE, { recursive: true })
  log(`dsh-privd started; uid=${process.getuid?.()} root=${ROOT}`)

  if (process.getuid && process.getuid() !== 0) {
    log('warning: not running as root — commands will not be able to escalate')
  }

  let stopping = false
  const stop = (signal) => {
    stopping = true
    log(`received ${signal}, stopping`)
    process.exit(0)
  }
  process.on('SIGTERM', () => stop('SIGTERM'))
  process.on('SIGINT', () => stop('SIGINT'))

  while (!stopping) {
    let names = []
    try {
      names = await fsp.readdir(QUEUE)
    } catch (error) {
      log(`queue read failed: ${error.message}`)
      await sleep(POLL_MS)
      continue
    }
    const requests = names.filter((n) => n.endsWith('.json')).sort()
    if (requests.length === 0) {
      await sleep(POLL_MS)
      continue
    }
    for (const name of requests) {
      const src = path.join(QUEUE, name)
      const dst = path.join(WORK, name)
      // Claim atomically so a second daemon (or a restart race) cannot run it.
      try {
        await fsp.rename(src, dst)
      } catch {
        continue
      }
      try {
        await handle(dst, secret)
      } catch (error) {
        log(`handle ${name} failed: ${error.stack || error.message}`)
        await fsp.unlink(dst).catch(() => {})
      }
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

main().catch((error) => {
  log(`fatal: ${error.stack || error.message}`)
  process.exit(1)
})
