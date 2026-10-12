import type { Agent, AgentInput, AgentRun, AgentRunInput, AgentStatus, Endpoint, EndpointInput, EndpointKind, EndpointModel, EndpointStatus, Note, NoteSummary, Project, ProjectInput, ProjectMessage, ProjectMessageInput, PromptBudget, PromptBudgetInput, Skill, SkillInput, ToolInfo } from './types'

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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
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
    let message = 'Request failed'
    try {
      const body: unknown = await res.json()
      if (
        typeof body === 'object' &&
        body !== null &&
        'message' in body &&
        typeof (body as { message?: unknown }).message === 'string'
      ) {
        message = (body as { message: string }).message
      }
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

export const api = {
  async listAgents(): Promise<Agent[]> {
    return request<Agent[]>('/api/agents')
  },

  async getAgent(id: string): Promise<Agent> {
    return request<Agent>(`/api/agents/${encodeURIComponent(id)}`)
  },

  async listSkills(): Promise<Skill[]> {
    return request<Skill[]>('/api/skills')
  },

  async listTools(): Promise<ToolInfo[]> {
    return request<ToolInfo[]>('/api/tools')
  },

  async listNotes(): Promise<NoteSummary[]> {
    return request<NoteSummary[]>('/api/notes')
  },

  async getNote(id: string): Promise<Note> {
    return request<Note>(`/api/notes/${encodeURIComponent(id)}`)
  },

  async deleteNote(id: string): Promise<void> {
    return request<void>(`/api/notes/${encodeURIComponent(id)}`, { method: 'DELETE' })
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

  async createAgent(input: AgentInput): Promise<Agent> {
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

  /* -- Projects: a project owns a folder under the BE projects root and a team
     of library agents. Rename never moves the folder; delete leaves it on disk. */

  async listProjects(): Promise<Project[]> {
    return request<Project[]>('/api/projects')
  },

  async createProject(input: ProjectInput): Promise<Project> {
    return request<Project>('/api/projects', { method: 'POST', body: JSON.stringify(input) })
  },

  async updateProject(id: string, patch: Partial<ProjectInput>): Promise<Project> {
    return request<Project>(`/api/projects/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    })
  },

  /** 204; the folder stays on disk. */
  async deleteProject(id: string): Promise<void> {
    await request<void>(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' })
  },

  async listProjectMessages(id: string): Promise<ProjectMessage[]> {
    return request<ProjectMessage[]>(`/api/projects/${encodeURIComponent(id)}/messages`)
  },

  async postProjectMessage(id: string, input: ProjectMessageInput): Promise<ProjectMessage> {
    return request<ProjectMessage>(`/api/projects/${encodeURIComponent(id)}/messages`, {
      method: 'POST',
      body: JSON.stringify(input),
    })
  },

  async testEndpoint(id: string): Promise<{ ok: boolean; models: string[]; latencyMs: number }> {
    return request<{ ok: boolean; models: string[]; latencyMs: number }>(
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
