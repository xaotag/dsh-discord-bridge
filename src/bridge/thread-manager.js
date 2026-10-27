const COMPLEX_PATTERNS = [
  /分析|调研|研究|排查|重构|架构|多步|子任务|详细|日志|思考|实现.*并|设计.*并/i,
  /refactor|debug|investigate|analy[sz]e|architecture|multi[- ]step|subtask|implement.*and|design.*and/i,
]

/** Decide whether this prompt deserves an automatically isolated Discord thread. */
export function shouldCreateThread({ text, kind, attachments = 0, autoThread, complexityThreshold }) {
  if (!autoThread || kind !== 'channel') return false
  if (attachments > 0) return true
  if ((text || '').length >= complexityThreshold) return true
  return COMPLEX_PATTERNS.some((pattern) => pattern.test(text || ''))
}

export function threadTitle(prompt) {
  const clean = String(prompt || 'DSH 子任务')
    .replace(/\s+/g, ' ')
    .replace(/[`<>@#]/g, '')
    .trim()
  return `DSH: ${clean.slice(0, 80) || '子任务'}`
}

/** Discord-only thread orchestration, injected transport keeps this testable. */
export class ThreadManager {
  constructor({ transport, archiveMinutes = 1440, logger = console }) {
    this.transport = transport
    this.archiveMinutes = archiveMinutes
    this.logger = logger
  }

  async create(channelId, prompt) {
    try {
      return await this.transport.createThread(channelId, threadTitle(prompt), this.archiveMinutes)
    } catch (error) {
      this.logger.warn?.('创建 Thread 失败，回退到主频道:', error?.message || String(error))
      return undefined
    }
  }
}
