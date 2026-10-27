/**
 * DeepSeek Platform official REST client.
 *
 * Endpoints implemented (current official API):
 *   GET  /models
 *   GET  /user/balance
 *   POST /chat/completions  (SSE streaming)
 *   POST /beta/completions  (FIM, beta)
 *
 * Native fetch is fully asynchronous. Every request has timeout, 429/5xx
 * retry-after backoff, and never logs the API key.
 */
export class DeepSeekApiClient {
  constructor({ ctx, logger = console, tokenRef = 'DEEPSEEK_API_KEY', baseUrl = 'https://api.deepseek.com', audit } = {}) {
    this.ctx = ctx
    this.logger = logger
    this.audit = audit
    this.tokenRef = tokenRef
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.timeoutMs = 120_000
    this.maxRetries = 4
  }

  async resolveToken() {
    let token = process.env[this.tokenRef] || process.env.DEEPSEEK_API_KEY
    try {
      const credentials = this.ctx.get('credentials')
      if (credentials?.resolve) {
        const resolved = await credentials.resolve(this.tokenRef)
        if (resolved?.value) token = resolved.value
      }
    } catch (error) {
      this.logger.warn?.('解析 DeepSeek API Key 失败:', error?.message || String(error))
    }
    return token?.trim() || undefined
  }

  async request(path, { method = 'GET', body, signal } = {}) {
    const token = await this.resolveToken()
    if (!token) throw new Error(`未配置 DeepSeek API Key（credentialRef=${this.tokenRef}）`)
    const startedAt = Date.now()
    const auditDetail = {
      endpoint: path,
      method,
      stream: Boolean(body?.stream),
      model: body?.model,
    }
    try {
      const response = await this.requestWithRetry(path, { method, body, signal, token })
      this.audit?.record({
        category: 'deepseek',
        action: 'api.request',
        status: 'ok',
        durationMs: Date.now() - startedAt,
        detail: { ...auditDetail, httpStatus: response.status },
      })
      return response
    } catch (error) {
      this.audit?.record({
        category: 'deepseek',
        action: 'api.request',
        status: 'error',
        durationMs: Date.now() - startedAt,
        detail: auditDetail,
        error: error?.message || String(error),
      })
      throw error
    }
  }

  async requestWithRetry(path, { method, body, signal, token }) {
    for (let attempt = 0; ; attempt += 1) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
      const fused = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
      try {
        const response = await fetch(`${this.baseUrl}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            Accept: body?.stream ? 'text/event-stream' : 'application/json',
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: fused,
        })
        if (response.status === 429 || response.status >= 500) {
          if (attempt >= this.maxRetries) throw await apiError(response)
          const retryAfter = Number(response.headers.get('retry-after'))
          const delay = Number.isFinite(retryAfter)
            ? retryAfter * 1000
            : Math.min(30_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250)
          this.logger.warn?.(`[deepseek-api] ${path} HTTP ${response.status}，退避 ${delay}ms`)
          await sleep(delay)
          continue
        }
        if (!response.ok) throw await apiError(response)
        return response
      } finally {
        clearTimeout(timeout)
      }
    }
  }

  async listModels() {
    const response = await this.request('/models')
    return response.json()
  }

  async getBalance() {
    const response = await this.request('/user/balance')
    return response.json()
  }

  async createChatCompletion({ model, messages, temperature, maxTokens, stream = false }) {
    const response = await this.request('/chat/completions', {
      method: 'POST',
      body: {
        model,
        messages,
        stream,
        ...(temperature === undefined ? {} : { temperature }),
        ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
      },
    })
    return response.json()
  }

  async *streamChatCompletion({ model, messages, temperature, maxTokens, signal }) {
    const response = await this.request('/chat/completions', {
      method: 'POST',
      body: {
        model,
        messages,
        stream: true,
        ...(temperature === undefined ? {} : { temperature }),
        ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
      },
      signal,
    })
    if (!response.body) throw new Error('DeepSeek API 没有返回流式响应体')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let newline
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (!data || data === '[DONE]') continue
          let payload
          try {
            payload = JSON.parse(data)
          } catch {
            continue
          }
          const delta = payload?.choices?.[0]?.delta
          if (delta?.content) yield delta.content
          if (Array.isArray(delta?.tool_calls) && delta.tool_calls.length) {
            yield { toolCalls: delta.tool_calls }
          }
        }
      }
    } finally {
      reader.releaseLock?.()
    }
  }

  async createFimCompletion({ model, prompt, suffix, temperature, maxTokens }) {
    const response = await this.request('/beta/completions', {
      method: 'POST',
      body: {
        model,
        prompt,
        ...(suffix ? { suffix } : {}),
        ...(temperature === undefined ? {} : { temperature }),
        ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
      },
    })
    return response.json()
  }
}

async function apiError(response) {
  let detail = ''
  try {
    const data = await response.json()
    detail = data?.error?.message || data?.message || ''
  } catch {
    /* ignore non-JSON error body */
  }
  return new Error(`DeepSeek API HTTP ${response.status}${detail ? `: ${detail}` : ''}`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
