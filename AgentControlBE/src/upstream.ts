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

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'

/** One model-requested tool call. `arguments` stays a raw JSON string (OpenAI contract). */
export interface ToolCall {
  id: string
  name: string
  arguments: string
}

export interface ChatMessage {
  role: ChatRole
  content: string
  /** role: 'tool' messages: the call this result answers. */
  toolCallId?: string
  /** assistant messages: tool calls the model requested. */
  toolCalls?: ToolCall[]
}

/** What we advertise upstream; serialized as { type: 'function', function: {...} }. */
export interface ToolDeclaration {
  name: string
  description: string
  parameters: object
}

export interface ChatResult {
  ok: boolean
  content: string
  latencyMs: number
  error?: string
  toolCalls?: ToolCall[]
  finishReason?: string
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

function parseToolCalls(raw: unknown): ToolCall[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const calls: ToolCall[] = []
  for (const entry of raw) {
    const record = (entry ?? {}) as { id?: unknown; function?: { name?: unknown; arguments?: unknown } }
    if (typeof record.function?.name !== 'string') continue
    calls.push({
      id: typeof record.id === 'string' ? record.id : `call_${calls.length}`,
      name: record.function.name,
      arguments:
        typeof record.function.arguments === 'string'
          ? record.function.arguments
          : JSON.stringify(record.function.arguments ?? {}),
    })
  }
  return calls.length > 0 ? calls : undefined
}

/** OpenAI wire shape: tool results carry tool_call_id, tool calls nest under function. */
function serializeMessage(message: ChatMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { role: message.role, content: message.content }
  if (message.role === 'tool' && message.toolCallId !== undefined) out.tool_call_id = message.toolCallId
  if (message.toolCalls && message.toolCalls.length > 0) {
    out.tool_calls = message.toolCalls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.arguments },
    }))
  }
  return out
}

/** User (or TaskRunner) aborted the call via an AbortSignal. Distinct from a timeout. */
export const STOPPED_BY_YOU = 'Stopped by you'

/** POST {baseUrl}/v1/chat/completions (or `{baseUrl}/chat/completions`). */
export async function chatCompletion(
  baseUrl: string,
  apiKey: string | undefined,
  model: string,
  messages: ChatMessage[],
  timeoutMs: number = CHAT_TIMEOUT_MS,
  maxTokens?: number,
  tools?: ToolDeclaration[],
  temperature?: number,
  /** Optional; combined with the timeout via AbortSignal.any (orchestration Part 2). */
  signal?: AbortSignal,
): Promise<ChatResult> {
  const started = Date.now()
  const timeout = AbortSignal.timeout(timeoutMs)
  const combined = signal ? AbortSignal.any([timeout, signal]) : timeout
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' }
    if (apiKey) headers.authorization = `Bearer ${apiKey}`
    const payload: Record<string, unknown> = { model, messages: messages.map(serializeMessage) }
    if (typeof maxTokens === 'number') payload.max_tokens = maxTokens
    if (typeof temperature === 'number') payload.temperature = temperature
    if (tools && tools.length > 0) {
      payload.tools = tools.map((tool) => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      }))
    }
    const response = await fetch(chatCompletionsUrl(baseUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: combined,
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
    const body = (await response.json()) as { choices?: unknown }
    const first = (Array.isArray(body.choices) ? body.choices[0] : undefined) as
      | { message?: { content?: unknown; tool_calls?: unknown }; finish_reason?: unknown }
      | undefined
    const finishReason = typeof first?.finish_reason === 'string' ? first.finish_reason : undefined
    const toolCalls = parseToolCalls(first?.message?.tool_calls)
    const content = extractContent(body)
    // A tool-call turn may legitimately carry no text content.
    if (toolCalls && toolCalls.length > 0) {
      return { ok: true, content: content ?? '', latencyMs, toolCalls, finishReason }
    }
    if (content === null) {
      return { ok: false, content: '', latencyMs, error: 'Upstream response had no message content.' }
    }
    return { ok: true, content, latencyMs, finishReason }
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError'
    // Prefer the caller's signal over the timeout when both may have fired.
    const stopped = aborted && signal?.aborted === true
    return {
      ok: false,
      content: '',
      latencyMs: Date.now() - started,
      error: stopped
        ? STOPPED_BY_YOU
        : aborted
          ? `Upstream timed out after ${timeoutMs}ms`
          : err instanceof Error
            ? err.message
            : 'Request failed',
    }
  }
}
