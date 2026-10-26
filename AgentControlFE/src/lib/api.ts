import { MAX_AVATAR_BYTES } from './types'
import type { EndpointTestResult } from './endpoint-proxy'
import { DEFAULT_ERROR_MESSAGE, errorMessageFrom } from './api-error'
import { normalizeSkillsResponse, skillPath, type SkillsResponse } from './skills-catalog'
import { CONVERSATION_PAGE_SIZE, type ConversationSendResult, type ChatMessagePage, type ConversationMessagesResponse, type ConversationSummary } from './types'
import type { SkillSummary } from './types'
import type { Agent, AgentInput, AgentRun, AgentRunInput, AgentStatus, Endpoint, EndpointInput, EndpointKind, EndpointModel, EndpointStatus, PromptBudget, PromptBudgetInput, Skill, SkillInput, ToolInfo } from './types'

/* ==========================================================================
   Live API (replaces the former localStorage mock).

   Every page goes through `api.*`. Bodies are thin fetch wrappers; the frozen
   contract (routes, shapes, 400/404/409 codes) is documented in ./types.ts.
   Requests use a relative `/api` base, proxied to the BE by Vite in dev and
   preview (see vite.config.ts). The server store is the source of truth — no
   local persistence or key vault here.
   ========================================================================== */

export class ApiError extends Error {
  status: number

  constructor(message: string, status = 500) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export const OPENROUTER_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1'

/**
 * Testing placeholder for the default OpenAI-compatible endpoint (mirrors the
 * BE seed): prefilled in Settings and preselected for the Team Lead. Every
 * endpoint stays editable; replace this for the final build.
 */
export const DEFAULT_ENDPOINT_BASE_URL = 'http://100.79.242.24:8791'

/**
 * Empty base -> relative `/api` requests ride Vite's proxy in dev and preview
 * (preview inherits server.proxy), so there is a single origin and no CORS.
 * VITE_API_BASE overrides when the BE lives elsewhere.
 */
const API_BASE = import.meta.env.VITE_API_BASE ?? ''

/**
 * Optional bearer token for self-hosted BE endpoints.
 * Set VITE_AUTH_TOKEN in your `.env` / `.env.local`; leave blank for unauthenticated use.
 * The token is embedded in the bundle at build time (Vite only exposes VITE_* to client code).
 */
const AUTH_TOKEN = import.meta.env.VITE_AUTH_TOKEN

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // Merge existing request headers, auth header, and the JSON content type.
  const headers: Record<string, string> = {}
  if (AUTH_TOKEN) {
    headers.Authorization = `Bearer ${AUTH_TOKEN}`
  }
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...headers,
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  })
  // Deletes answer 204 with no body.
  if (res.status === 204) return undefined as T
  if (!res.ok) {
    let message = DEFAULT_ERROR_MESSAGE
    try {
      message = errorMessageFrom(await res.json())
    } catch {
      // Non-JSON error body (e.g. upstream gateway HTML): keep the default.
    }
    throw new ApiError(message, res.status)
  }
  return (await res.json()) as T
}

/** Strip trailing slashes so `${baseUrl}/v1/models` never doubles up. */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '')
}

/* --------------------------------------------------------------------------
   Chat-first Part 1: avatar routes. Kept together so the contract is easy to
   adjust. Frozen by BE @ 5834fce:
     GET    /api/agents/:id/avatar  -> image bytes (404 when no image); ?v=<updatedAt> busts cache
     PUT    /api/agents/:id/avatar  -> raw image body (Content-Type = file type), 200 Agent
                                       (400 bad body, 413 over 1 MB, 415 wrong type)
     DELETE /api/agents/:id/avatar  -> 200 Agent
   -------------------------------------------------------------------------- */

/** Allowed upload types and size cap for the avatar picker (mirror the BE once frozen). */
export const AVATAR_MAX_BYTES = MAX_AVATAR_BYTES
export const AVATAR_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/** URL for an agent's uploaded avatar; `version` busts the browser cache after a re-upload. */
export function agentAvatarUrl(agentId: string, version?: string): string {
  const base = `${API_BASE}/api/agents/${encodeURIComponent(agentId)}/avatar`
  return version ? `${base}?v=${encodeURIComponent(version)}` : base
}

function avatarUploadMessage(status: number, serverMessage: string | null): string {
  if (status === 413) return 'That image is too large. Use one that is 1 MB or smaller.'
  if (status === 415) return 'That file type is not supported. Use a PNG, JPEG, WebP or GIF image.'
  if (status === 400) return serverMessage ?? 'That image could not be read. Try a different file.'
  return serverMessage ?? 'Could not upload the avatar.'
}

/** Absolute URL for an API path (honours VITE_API_BASE). */
export function apiUrl(path: string): string {
  return `${API_BASE}${path}`
}

/** PUT a raw image body to an avatar route; friendly 400/413/415 messages. */
export async function putAvatarImage<T>(path: string, file: Blob): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': file.type || 'application/octet-stream' }
  if (AUTH_TOKEN) headers.Authorization = `Bearer ${AUTH_TOKEN}`
  const res = await fetch(apiUrl(path), { method: 'PUT', headers, body: file })
  if (!res.ok) {
    let serverMessage: string | null = null
    try {
      const parsed = errorMessageFrom(await res.json())
      if (parsed !== DEFAULT_ERROR_MESSAGE) serverMessage = parsed
    } catch {
      // keep default
    }
    throw new ApiError(avatarUploadMessage(res.status, serverMessage), res.status)
  }
  return (await res.json()) as T
}

/** Raw PUT for BE-2 file uploads (Content-Type = the file's type); the caller reads status and body. */
export function putRaw(url: string, body: Blob): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': body.type || 'application/octet-stream' }
  if (AUTH_TOKEN) headers.Authorization = `Bearer ${AUTH_TOKEN}`
  return fetch(apiUrl(url), { method: 'PUT', headers, body })
}

/** The server's own error text, or null when it sent only a generic one. */
export function serverMessage(body: unknown): string | null {
  const m = errorMessageFrom(body)
  return m === DEFAULT_ERROR_MESSAGE ? null : m
}

function uploadAvatar(agentId: string, file: Blob): Promise<Agent> {
  return putAvatarImage<Agent>(`/api/agents/${encodeURIComponent(agentId)}/avatar`, file)
}

/* --------------------------------------------------------------------------
   Chat-first Part 2 (BE 8a9acd3):
     GET  /api/conversations                               -> ConversationSummary[] (auto-creates DMs)
     GET  /api/conversations/:id/messages?before=&limit=   -> { conversation, messages } oldest->newest
          `before` = ISO createdAt of the oldest message shown (exclusive); limit 1..200, default 50
     POST /api/conversations/:id/read                      -> ConversationSummary
   No send route: messages are sent with POST /api/agents/:id/run and the run
   appends both turns to the agent's DM.
   -------------------------------------------------------------------------- */

export const api = {
  async listConversations(): Promise<ConversationSummary[]> {
    return request<ConversationSummary[]>('/api/conversations')
  },

  async listConversationMessages(id: string, options?: { before?: string; limit?: number }): Promise<ChatMessagePage> {
    const limit = options?.limit ?? CONVERSATION_PAGE_SIZE
    const qs = new URLSearchParams({ limit: String(limit) })
    if (options?.before) qs.set('before', options.before)
    const body = await request<ConversationMessagesResponse>(`/api/conversations/${encodeURIComponent(id)}/messages?${qs}`)
    // BE 2a6078c sends hasMore; older BEs: a full page means there may be more.
    return { conversation: body.conversation, messages: body.messages, hasMore: body.hasMore ?? body.messages.length >= limit }
  },

  /**
   * Send in a DM: POST /api/conversations/:id/messages {content} -> {conversation, messages, run}.
   * Final Phase 1 send shape is { content, attachments? }; clients send `content` only (BE a30a385).
   * The only place the chat screen sends from. Falls back to the agent run route
   * (+ refetch) when the BE predates the send route (404 with no conversation match).
   */
  async sendConversationMessage(conversationId: string, agentId: string, text: string): Promise<ConversationSendResult> {
    try {
      return await request<ConversationSendResult>(`/api/conversations/${encodeURIComponent(conversationId)}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: text }),
      })
    } catch (err) {
      if (!(err instanceof ApiError) || (err.status !== 404 && err.status !== 405) || !/^Route /.test(err.message)) throw err
      const run = await api.runAgent(agentId, text)
      const page = await api.listConversationMessages(conversationId)
      const [summary] = (await api.listConversations()).filter((c) => c.id === conversationId)
      return {
        conversation: summary,
        messages: page.messages.filter((m) => m.runId === run.id),
        // The run route returns the whole run, so its top-level filesChanged (BE-3) comes along.
        run: { id: run.id, status: run.status, error: run.error, ...(Array.isArray(run.filesChanged) ? { filesChanged: run.filesChanged } : {}) },
      }
    }
  },

  async markConversationRead(id: string): Promise<ConversationSummary> {
    return request<ConversationSummary>(`/api/conversations/${encodeURIComponent(id)}/read`, { method: 'POST', body: '{}' })
  },



  /** Upload (replace) an agent's image avatar. Resolves with the updated agent when the BE returns it. */
  async uploadAgentAvatar(id: string, file: Blob): Promise<Agent> {
    return uploadAvatar(id, file)
  },

  /** Remove an agent's avatar (image file and/or emoji); falls back to initials. */
  async deleteAgentAvatar(id: string): Promise<Agent> {
    return request<Agent>(`/api/agents/${encodeURIComponent(id)}/avatar`, { method: 'DELETE' })
  },


  async listAgents(): Promise<Agent[]> {
    return request<Agent[]>('/api/agents')
  },

  async getAgent(id: string): Promise<Agent> {
    return request<Agent>(`/api/agents/${encodeURIComponent(id)}`)
  },

  async listSkills(): Promise<SkillSummary[]> {
    return normalizeSkillsResponse(await request<unknown>('/api/skills')).skills
  },

  /** One skill with its `content` (BE-6 list rows leave it out). Ids like `core/x` are encoded. */
  async getSkill(id: string): Promise<Skill> {
    return request<Skill>(skillPath(id))
  },

  /** Today's Skill[] or BE-6's { skills, sources }; `legacy` marks the former. */
  async listSkillCatalog(): Promise<SkillsResponse> {
    return normalizeSkillsResponse(await request<unknown>('/api/skills'))
  },

  async listTools(): Promise<ToolInfo[]> {
    return request<ToolInfo[]>('/api/tools')
  },

  async createSkill(input: SkillInput): Promise<Skill> {
    return request<Skill>('/api/skills', { method: 'POST', body: JSON.stringify(input) })
  },

  async updateSkill(id: string, patch: Partial<SkillInput>): Promise<Skill> {
    return request<Skill>(`/api/skills/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    })
  },

  /** 204; the BE detaches the skill from every agent in the same transaction. */
  async deleteSkill(id: string): Promise<void> {
    await request<void>(`/api/skills/${encodeURIComponent(id)}`, { method: 'DELETE' })
  },

  /** Paste a SKILL.md file; the BE parses frontmatter -> name/description, body -> content. */
  async importSkill(markdown: string): Promise<Skill> {
    return request<Skill>('/api/skills/import', { method: 'POST', body: JSON.stringify({ markdown }) })
  },

  /**
   * How an agent draft's instructions and skills fit its endpoint's window
   * (full, skills as summaries, or too large). Pass `signal` to abort a
   * superseded preview.
   */
  async getPromptBudget(body: PromptBudgetInput, options?: { signal?: AbortSignal }): Promise<PromptBudget> {
    return request<PromptBudget>('/api/prompt-budget', {
      method: 'POST',
      body: JSON.stringify(body),
      ...(options?.signal ? { signal: options.signal } : {}),
    })
  },

  /** Leave `skillIds` out to get the backend's defaults (BE-7: every defaultOn skill). */
  async createAgent(input: Omit<AgentInput, 'skillIds'> & { skillIds?: string[] }): Promise<Agent> {
    return request<Agent>('/api/agents', { method: 'POST', body: JSON.stringify(input) })
  },

  async updateAgent(id: string, patch: AgentInput): Promise<Agent> {
    return request<Agent>(`/api/agents/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    })
  },

  async deleteAgent(id: string): Promise<void> {
    await request<void>(`/api/agents/${encodeURIComponent(id)}`, { method: 'DELETE' })
  },

  async runAgent(id: string, input: string): Promise<AgentRun> {
    const body: AgentRunInput = { input }
    return request<AgentRun>(`/api/agents/${encodeURIComponent(id)}/runs`, {
      method: 'POST',
      body: JSON.stringify(body),
    })
  },

  async listAgentRuns(id: string): Promise<AgentRun[]> {
    return request<AgentRun[]>(`/api/agents/${encodeURIComponent(id)}/runs`)
  },

  /* -- Endpoints: kind 'openai-compatible' (llama.cpp / vLLM) or 'openrouter'.
     Test and model discovery run server-side; apiKey is write-only and is
     omitted from update bodies when blank so the stored key survives. */

  async listEndpoints(): Promise<Endpoint[]> {
    return request<Endpoint[]>('/api/endpoints')
  },

  async createEndpoint(input: EndpointInput): Promise<Endpoint> {
    return request<Endpoint>('/api/endpoints', { method: 'POST', body: JSON.stringify(input) })
  },

  async updateEndpoint(id: string, patch: EndpointInput): Promise<Endpoint> {
    return request<Endpoint>(`/api/endpoints/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    })
  },

  async deleteEndpoint(id: string): Promise<{ ok: true; reassignedAgents: string[] }> {
    return request<{ ok: true; reassignedAgents: string[] }>(
      `/api/endpoints/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    )
  },

  async listEndpointModels(id: string): Promise<EndpointModel[]> {
    const body = await request<{ models: EndpointModel[] }>(
      `/api/endpoints/${encodeURIComponent(id)}/models`,
    )
    return body.models
  },

  /** `error` (BE-11) explains a failed test, e.g. "fetch failed (ECONNREFUSED: ...)". */
  async testEndpoint(id: string): Promise<EndpointTestResult> {
    return request<EndpointTestResult>(
      `/api/endpoints/${encodeURIComponent(id)}/test`,
      { method: 'POST' },
    )
  },

  /** Clear an agent's chat transcript (DELETE /api/agents/:id/runs). */
  async deleteAgentRuns(id: string): Promise<void> {
    return request<void>(`/api/agents/${encodeURIComponent(id)}/runs`, { method: 'DELETE' })
  },
}

export const STATUS_LABELS: Record<AgentStatus, string> = {
  running: 'Running',
  idle: 'Idle',
  queued: 'Queued',
  error: 'Error',
}

export const ENDPOINT_STATUS_LABELS: Record<EndpointStatus, string> = {
  unknown: 'Not tested',
  reachable: 'Reachable',
  unreachable: 'Unreachable',
}

export const ENDPOINT_KIND_LABELS: Record<EndpointKind, string> = {
  'openai-compatible': 'OpenAI-compatible',
  openrouter: 'OpenRouter',
}
