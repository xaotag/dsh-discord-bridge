/**
 * On-disk protocol shared by the DSH side and the root-side daemon.
 *
 * The DSH process runs under `no_new_privs`, so it can never escalate. Instead
 * it *submits* a request here and waits for the daemon — which runs as root
 * outside the sandbox — to pick it up, execute it, and write a result back.
 *
 * Layout (under $DSH_HOME/privileged):
 *
 *   queue/<id>.json      submitted, not yet claimed
 *   work/<id>.json       claimed by the daemon (moved atomically)
 *   done/<id>.json       result written by the daemon
 *   audit.jsonl          append-only record of every execution
 *
 * Every request carries an HMAC over its canonical body, computed with the
 * shared secret in `secret`. The daemon refuses anything it cannot verify,
 * so a stray file in `queue/` is not enough to run a command as root.
 */
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'

/** How long a submitted request stays executable before the daemon ignores it. */
export const REQUEST_TTL_MS = 5 * 60 * 1000
/** Hard cap on captured stdout+stderr, in bytes. */
export const OUTPUT_LIMIT_BYTES = 256 * 1024
/** Default time the daemon allows one command to run. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 120 * 1000

export function privilegedRoot(dshHome) {
  return path.join(dshHome || path.join(process.env.HOME || '/root', '.dsh'), 'privileged')
}

export function queueDir(root) {
  return path.join(root, 'queue')
}
export function workDir(root) {
  return path.join(root, 'work')
}
export function doneDir(root) {
  return path.join(root, 'done')
}
export function secretPath(root) {
  return path.join(root, 'secret')
}
export function auditPath(root) {
  return path.join(root, 'audit.jsonl')
}

/**
 * Canonical JSON: keys sorted, no whitespace. Both sides must sign the same
 * bytes, so this is the only serializer allowed here.
 */
/**
 * Canonical JSON: keys sorted, no whitespace.
 *
 * `undefined` keys are skipped rather than serialized: JSON.stringify drops
 * them when the request is written to disk, so a signer that kept them would
 * disagree with a verifier reading the file back.
 */
export function canonicalize(value) {
  if (value === null) return 'null'
  if (typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort()
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`)
  return `{${parts.join(',')}}`
}

/** Sign the body (everything except `sig`) with the shared secret. */
export function signRequest(request, secret) {
  const { sig: _ignored, ...body } = request
  return crypto.createHmac('sha256', secret).update(canonicalize(body)).digest('hex')
}

export function verifyRequest(request, secret) {
  if (!request || typeof request !== 'object') return false
  const { sig, ...body } = request
  if (typeof sig !== 'string' || sig.length === 0) return false
  const expected = crypto.createHmac('sha256', secret).update(canonicalize(body)).digest('hex')
  const a = Buffer.from(sig, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

export async function readSecret(root) {
  const raw = await fsp.readFile(secretPath(root), 'utf8')
  const secret = raw.trim()
  if (secret.length < 32) throw new Error('privileged secret is too short')
  return secret
}

/**
 * Write a request atomically so the daemon never reads a half-written file.
 * The temp name does not end in `.json`, and the file is renamed into place.
 */
export async function writeRequestAtomic(dir, request) {
  await fsp.mkdir(dir, { recursive: true })
  const tmp = path.join(dir, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  const target = path.join(dir, `${request.id}.json`)
  await fsp.writeFile(tmp, JSON.stringify(request), { mode: 0o600 })
  await fsp.rename(tmp, target)
  return target
}

export function makeRequest({ command, cwd, timeoutMs, requestedBy, channelId } = {}) {
  const id = `${Date.now().toString(36)}-${crypto.randomBytes(8).toString('hex')}`
  const now = Date.now()
  const request = {
    id,
    command: String(command ?? ''),
    timeoutMs: Number.isFinite(timeoutMs) ? Math.round(timeoutMs) : DEFAULT_COMMAND_TIMEOUT_MS,
    createdAt: now,
    expiresAt: now + REQUEST_TTL_MS,
  }
  // Only attach optional fields that actually carry a value: a key present here
  // but dropped by JSON.stringify would break the signature round-trip.
  if (cwd) request.cwd = String(cwd)
  if (requestedBy) request.requestedBy = String(requestedBy)
  if (channelId) request.channelId = String(channelId)
  return request
}
