/**
 * Classify why a privileged command failed.
 *
 * The operator approving a command does not guarantee the system allows it: a
 * kernel LSM (SELinux, AppArmor), the filesystem, or a service manager can still
 * refuse. Those are reported as a distinct `denied` outcome instead of a
 * generic error, so the card can say "approved, but refused" rather than
 * blaming the command.
 *
 * Reference markers, all observed from real tooling:
 *   - SELinux:   "Permission denied", "avc:  denied", audit.log AVC entries
 *   - AppArmor:  "operation not permitted" with an apparmor profile name
 *   - systemd:   "Access denied", "Interactive authentication required"
 *   - generic:   EACCES / EPERM
 */

/** Signals that an operation was refused by policy rather than failing. */
const DENIAL_PATTERNS = [
  // SELinux
  /\bavc:\s+denied\b/i,
  /\bselinux\b.*\bdenied\b/i,
  /\bdenied\b.*\bselinux\b/i,
  /\btype=\w+.*\bavc\b/i,
  // AppArmor
  /\bapparmor\b.*\bdenied\b/i,
  /\boperation not permitted\b/i,
  // DAC / filesystem
  /\bpermission denied\b/i,
  /\bEACCES\b/,
  /\bEPERM\b/,
  /\bOperation not permitted\b/i,
  // systemd / polkit
  /\bAccess denied\b/i,
  /\binteractive authentication required\b/i,
  /\bFailed to .*: Access denied\b/i,
  // capabilities
  /\bcannot open.*: Permission denied\b/i,
  /\brequires root\b/i,
  /\bmust be root\b/i,
  /\bnot permitted\b/i,
]

/** Whether the output looks like a policy refusal rather than a plain failure. */
export function looksLikePermissionDenial({ stdout, stderr, message } = {}) {
  const haystack = [stdout, stderr, message].filter(Boolean).join('\n')
  if (!haystack) return false
  return DENIAL_PATTERNS.some((pattern) => pattern.test(haystack))
}

/**
 * SELinux advisory: when an AVC denial is present, the fix is a policy change,
 * not a retry, so surface that explicitly.
 */
export function selinuxHint({ stdout, stderr, message } = {}) {
  const haystack = [stdout, stderr, message].filter(Boolean).join('\n')
  if (!/avc:\s*denied/i.test(haystack)) return undefined
  return [
    'SELinux 拒绝了该操作。',
    '- 查看详情：`ausearch -m avc -ts recent` 或 `dmesg | grep avc`',
    '- 临时放行：`setenforce 0`（重启后失效）',
    '- 永久放行：生成并安装策略模块 `audit2allow -a -M mypolicy && semodule -i mypolicy.pp`',
  ].join('\n')
}

/**
 * Map a privileged result to the state the card should show.
 *
 * - approved: ran and succeeded
 * - denied:   ran but the system refused (permission / policy)
 * - rejected: the daemon refused to run it at all
 * - failed:   ran and failed for an ordinary reason (bad path, non-zero exit)
 */
export function classifyPrivilegedOutcome(result = {}) {
  if (result.status === 'ok') return 'approved'
  if (result.status === 'denied') return 'denied'
  if (looksLikePermissionDenial(result)) return 'denied'
  return 'failed'
}

/**
 * Condense a denial into one short, readable line.
 *
 * A raw AVC record is hundreds of characters of key=value pairs; pasting it into
 * a card buries the actual reason. Pull out the decisive parts — the syscall
 * permission, the target, and the SELinux types — and drop the rest.
 */
export function summarizeDenial(result = {}) {
  const text = [result.stderr, result.stdout, result.message].filter(Boolean).join('\n').trim()
  if (!text) return '权限不足'

  const avc = /avc:\s*denied\s*\{([^}]+)\}([^\n]*)/i.exec(text)
  if (avc) {
    const permission = avc[1].trim()
    const rest = avc[2] || ''
    const field = (key) => {
      const m = new RegExp(`${key}="?([^"\\s]+)"?`).exec(rest)
      return m ? m[1] : undefined
    }
    const target = field('name') || field('path') || field('saddr')
    const source = field('scontext')
    const targetType = field('tcontext')
    const parts = [`SELinux 拒绝 ${permission}`]
    if (target) parts.push(`目标 ${target}`)
    if (source && targetType) parts.push(`${shortenContext(source)} → ${shortenContext(targetType)}`)
    return parts.join(' · ')
  }

  const line = text.split('\n')[0].trim()
  return clipLine(line, 140) || '权限不足'
}

/** `system_u:system_r:unconfined_t:s0` → `unconfined_t`. */
function shortenContext(context) {
  const parts = String(context).split(':')
  return parts[2] || context
}

function clipLine(text, limit) {
  const clean = String(text ?? '').trim()
  if (clean.length <= limit) return clean
  return `${clean.slice(0, limit - 1)}…`
}

/** One-line human summary of a privileged outcome. */
export function describePrivilegedOutcome(result = {}) {
  if (result.status === 'ok') {
    return `已执行（退出码 ${result.exitCode ?? 0}）`
  }
  if (result.status === 'denied') {
    return clipLine(result.message, 140) || '守护进程拒绝了该请求。'
  }
  if (looksLikePermissionDenial(result)) {
    return `系统拒绝执行：${summarizeDenial(result)}`
  }
  if (result.status === 'timeout') return '等待结果超时。'
  const detail = (result.stderr || result.message || '').trim().split('\n')[0]
  return `执行失败${result.exitCode !== undefined ? `（退出码 ${result.exitCode}）` : ''}${detail ? `：${clipLine(detail, 140)}` : ''}`
}
