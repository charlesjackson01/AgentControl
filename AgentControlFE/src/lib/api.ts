import { MAX_AVATAR_BYTES } from './types'
import { CONVERSATION_PAGE_SIZE, type ConversationSendResult, type ChatMessagePage, type ConversationMessagesResponse, type ConversationSummary } from './types'
import type { Agent, AgentInput, AgentRun, AgentRunInput, AgentStatus, Endpoint, EndpointInput, EndpointKind, EndpointModel, EndpointStatus, Note, NoteSummary, Project, ProjectInput, ProjectMessage, ProjectMessageInput, ProjectUpdate, PromptBudget, PromptBudgetInput, ReviewResult, Skill, SkillInput, TeamPlanApply, TeamPlanRequest, TeamPlanResult, ToolInfo } from './types'

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
      const body = (await res.json()) as { message?: unknown }
      if (typeof body.message === 'string') serverMessage = body.message
    } catch {
      // keep default
    }
    throw new ApiError(avatarUploadMessage(res.status, serverMessage), res.status)
  }
  return (await res.json()) as T
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
   * Send in a DM: POST /api/conversations/:id/messages {text} -> {conversation, messages, run}.
   * The only place the chat screen sends from. Falls back to the agent run route
   * (+ refetch) when the BE predates the send route (404 with no conversation match).
   */
  async sendConversationMessage(conversationId: string, agentId: string, text: string): Promise<ConversationSendResult> {
    try {
      return await request<ConversationSendResult>(`/api/conversations/${encodeURIComponent(conversationId)}/messages`, {
        method: 'POST',
        body: JSON.stringify({ text }),
      })
    } catch (err) {
      if (!(err instanceof ApiError) || (err.status !== 404 && err.status !== 405) || !/^Route /.test(err.message)) throw err
      const run = await api.runAgent(agentId, text)
      const page = await api.listConversationMessages(conversationId)
      const [summary] = (await api.listConversations()).filter((c) => c.id === conversationId)
      return {
        conversation: summary,
        messages: page.messages.filter((m) => m.runId === run.id),
        run: { id: run.id, status: run.status, error: run.error },
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

  /** There is no GET /api/projects/:id: read the list and pick the project (404 when it is gone). */
  async getProject(id: string): Promise<Project> {
    const project = (await request<Project[]>('/api/projects')).find((p) => p.id === id)
    if (!project) throw new ApiError(`No project with id "${id}"`, 404)
    return project
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

  /** D-O11: answers with the project and every message the write created
     (the message plus any direct tasks the user's @tags queued). */
  async postProjectMessage(id: string, input: ProjectMessageInput): Promise<ProjectUpdate> {
    return request<ProjectUpdate>(`/api/projects/${encodeURIComponent(id)}/messages`, {
      method: 'POST',
      body: JSON.stringify(input),
    })
  },

  /* -- Project team plans and tasks (D-P1). POST team-plan only returns
     Primary's plan; nothing is stored until the user applies it, so Cancel is
     local. Apply and retry answer with the project and the messages they
     created or changed. */

  /**
   * Ask Primary for a plan: `messageId` names the user's message it answers,
   * or `prompt` asks without one. 400 when the message is not a user message
   * of this project, 409 without a Team Lead, 413 when the prompt cannot fit,
   * 502 when Primary's answer is unusable. Writes nothing.
   */
  async requestTeamPlan(projectId: string, body: TeamPlanRequest): Promise<TeamPlanResult> {
    return request<TeamPlanResult>(`/api/projects/${encodeURIComponent(projectId)}/team-plan`, {
      method: 'POST',
      body: JSON.stringify(body),
    })
  },

  /**
   * Commit a plan the user confirmed: the BE validates `plan` again against
   * the current library and team, creates and adds the accepted agents, then
   * queues the accepted tasks. 400 for a bad selection, 409 when a new
   * specialist's name is taken. Pass `round` when applying a review (Part 5).
   */
  async applyTeamPlan(projectId: string, body: TeamPlanApply): Promise<ProjectUpdate> {
    return request<ProjectUpdate>(`/api/projects/${encodeURIComponent(projectId)}/team-plan/apply`, {
      method: 'POST',
      body: JSON.stringify(body),
    })
  },

  /**
   * Ask Primary to review a settled round (Part 5). Writes nothing; returns
   * the next-round plan (or a closing summary/question). 409 when there is no
   * Primary, the round is still open, or the request is closed.
   */
  async requestReview(projectId: string, body: { promptId: string }): Promise<ReviewResult> {
    return request<ReviewResult>(`/api/projects/${encodeURIComponent(projectId)}/review`, {
      method: 'POST',
      body: JSON.stringify(body),
    })
  },

  /**
   * One project task run (Part 6 "What it saw"). 404 when the run is missing,
   * belongs to another project, or is a chat-only run (no projectId).
   */
  async getProjectRun(projectId: string, runId: string): Promise<AgentRun> {
    return request<AgentRun>(
      `/api/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}`,
    )
  },

  /** 409 unless the task failed or was cancelled; re-queues it. */
  async retryProjectTask(projectId: string, messageId: string): Promise<ProjectUpdate> {
    return request<ProjectUpdate>(
      `/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(messageId)}/retry`,
      { method: 'POST' },
    )
  },

  /** Cancel a task and its non-done dependents. 409 when the task is already done. */
  async cancelProjectTask(projectId: string, messageId: string): Promise<ProjectUpdate> {
    return request<ProjectUpdate>(
      `/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(messageId)}/cancel`,
      { method: 'POST' },
    )
  },

  /** Pause: start nothing new; the in-flight call keeps going. */
  async pauseProjectWork(projectId: string): Promise<ProjectUpdate> {
    return request<ProjectUpdate>(`/api/projects/${encodeURIComponent(projectId)}/work/pause`, {
      method: 'POST',
    })
  },

  /** Resume: clear pause and kick the queue. */
  async resumeProjectWork(projectId: string): Promise<ProjectUpdate> {
    return request<ProjectUpdate>(`/api/projects/${encodeURIComponent(projectId)}/work/resume`, {
      method: 'POST',
    })
  },

  /** Stop: abort the in-flight call and cancel every queued/running task. */
  async stopProjectWork(projectId: string): Promise<ProjectUpdate> {
    return request<ProjectUpdate>(`/api/projects/${encodeURIComponent(projectId)}/work/stop`, {
      method: 'POST',
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
