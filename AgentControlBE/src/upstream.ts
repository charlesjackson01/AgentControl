/**
 * Server-side upstream calls for saved endpoints. The browser never calls
 * `baseUrl` directly (CORS/LAN), and the bearer key never leaves the server.
 */

const MODELS_TIMEOUT_MS = 8_000

function trimBase(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '')
}

/** Append an OpenAI path, tolerating bases that already carry a `/v1` prefix. */
function joinApi(baseUrl: string, suffix: string): string {
  const base = trimBase(baseUrl)
  return /\/v\d+$/.test(base) ? `${base}/${suffix}` : `${base}/v1/${suffix}`
}

export function modelsUrl(baseUrl: string): string {
  return joinApi(baseUrl, 'models')
}

export function chatCompletionsUrl(baseUrl: string): string {
  return joinApi(baseUrl, 'chat/completions')
}

export interface ModelsResult {
  ok: boolean
  models: string[]
  latencyMs: number
  error?: string
}

/** GET {baseUrl}/v1/models (or `{baseUrl}/models` when base ends in /v1). */
export async function fetchModels(baseUrl: string, apiKey?: string): Promise<ModelsResult> {
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), MODELS_TIMEOUT_MS)
  try {
    const headers: Record<string, string> = { accept: 'application/json' }
    if (apiKey) headers.authorization = `Bearer ${apiKey}`
    const response = await fetch(modelsUrl(baseUrl), { headers, signal: controller.signal })
    const latencyMs = Date.now() - started
    if (!response.ok) {
      return { ok: false, models: [], latencyMs, error: `Upstream responded ${response.status}` }
    }
    const body = (await response.json()) as { data?: unknown }
    const models = Array.isArray(body.data)
      ? body.data
          .map((m) => (m && typeof m === 'object' && typeof (m as { id?: unknown }).id === 'string' ? (m as { id: string }).id : null))
          .filter((id): id is string => id !== null)
      : []
    return { ok: true, models, latencyMs }
  } catch (err) {
    return {
      ok: false,
      models: [],
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : 'Request failed',
    }
  } finally {
    clearTimeout(timer)
  }
}

const CHAT_TIMEOUT_MS = 30_000

export type ChatRole = 'system' | 'user' | 'assistant'

export interface ChatMessage {
  role: ChatRole
  content: string
}

export interface ChatResult {
  ok: boolean
  content: string
  latencyMs: number
  error?: string
}

function extractContent(body: { choices?: unknown }): string | null {
  const choices = Array.isArray(body.choices) ? body.choices : []
  const first = choices[0] as { message?: { content?: unknown } } | undefined
  const content = first?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : '',
      )
      .join('')
  }
  return null
}

/** POST {baseUrl}/v1/chat/completions (or `{baseUrl}/chat/completions`). */
export async function chatCompletion(
  baseUrl: string,
  apiKey: string | undefined,
  model: string,
  messages: ChatMessage[],
  timeoutMs: number = CHAT_TIMEOUT_MS,
  maxTokens?: number,
): Promise<ChatResult> {
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' }
    if (apiKey) headers.authorization = `Bearer ${apiKey}`
    const payload: Record<string, unknown> = { model, messages }
    if (typeof maxTokens === 'number') payload.max_tokens = maxTokens
    const response = await fetch(chatCompletionsUrl(baseUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    const latencyMs = Date.now() - started
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      return {
        ok: false,
        content: '',
        latencyMs,
        error: `Upstream responded ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`,
      }
    }
    const content = extractContent((await response.json()) as { choices?: unknown })
    if (content === null) {
      return { ok: false, content: '', latencyMs, error: 'Upstream response had no message content.' }
    }
    return { ok: true, content, latencyMs }
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError'
    return {
      ok: false,
      content: '',
      latencyMs: Date.now() - started,
      error: aborted ? `Upstream timed out after ${timeoutMs}ms` : err instanceof Error ? err.message : 'Request failed',
    }
  } finally {
    clearTimeout(timer)
  }
}
