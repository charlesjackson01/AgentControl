import type { Agent, AgentInput, AgentRun, AgentRunInput, AgentStatus, Endpoint, EndpointInput, EndpointKind, EndpointModel, EndpointStatus, Model, Skill, SkillInput } from './types'

/* ==========================================================================
   Live API (replaces the former localStorage mock).

   Every page goes through `api.*`. Bodies are thin fetch wrappers; the frozen
   contract (routes, shapes, 400/404/409 codes) is documented in ./types.ts.
   BE base: http://127.0.0.1:3001 (override with VITE_API_BASE). The server
   store is the source of truth — no local persistence or key vault here.
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
 * Dev: empty base -> relative `/api` requests ride Vite's dev proxy
 * (see vite.config.ts server.proxy), so no CORS is involved. Prod: follows
 * however the app was opened (localhost, LAN IP, Tailscale IP) so the BE host
 * matches the FE host. VITE_API_BASE overrides in either mode.
 */
const API_BASE =
  import.meta.env.VITE_API_BASE ?? (import.meta.env.DEV ? '' : `http://${window.location.hostname}:3001`)

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

  async listModels(): Promise<Model[]> {
    return request<Model[]>('/api/models')
  },

  async listSkills(): Promise<Skill[]> {
    return request<Skill[]>('/api/skills')
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

export const TIER_LABELS: Record<Model['tier'], string> = {
  fast: 'Fast',
  balanced: 'Balanced',
  deep: 'Deep reasoning',
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
