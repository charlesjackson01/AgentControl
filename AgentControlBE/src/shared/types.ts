export type AgentStatus = 'running' | 'idle' | 'queued' | 'error'

export type RunStatus = 'succeeded' | 'failed' | 'running'

export type ModelTier = 'fast' | 'balanced' | 'deep'

export type EndpointStatus = 'unknown' | 'reachable' | 'unreachable'

export type EndpointKind = 'openai-compatible' | 'openrouter'

/** Curated hosted-model catalog served from the seed (GET /api/models). */
export interface Model {
  id: string
  name: string
  provider: string
  tier: ModelTier
  contextWindow: number
}

/**
 * Self-hosted OpenAI-compatible server (llama.cpp `--server`, vLLM) or
 * OpenRouter. `apiKey` is never part of this read shape; reads expose
 * `apiKeySet` only.
 */
export interface Endpoint {
  id: string
  kind: EndpointKind
  name: string
  /** Origin + optional path prefix, no trailing slash. */
  baseUrl: string
  /** Model id as reported by GET /v1/models. */
  defaultModel: string
  contextWindow: number
  /** True when the server holds a key for this endpoint. The key is never returned. */
  apiKeySet: boolean
  status: EndpointStatus
  lastCheckedAt: string | null
  createdAt: string
}

/** One model served by an endpoint (GET /api/endpoints/:id/models). */
export interface EndpointModel {
  id: string
  name: string
}

export interface EndpointInput {
  kind: EndpointKind
  name: string
  /** Optional for kind 'openrouter' (defaults to https://openrouter.ai/api/v1). */
  baseUrl: string
  defaultModel: string
  contextWindow: number
  /** Write-only. Omit to keep the stored key on update, "" to clear it. Never returned on read. */
  apiKey?: string
}

export type EndpointPatch = Partial<EndpointInput>

export interface Skill {
  id: string
  name: string
  description: string
  tag: string
}

export interface AgentRun {
  id: string
  agentId: string
  startedAt: string
  status: RunStatus
  durationMs: number
  steps: number
  input: string
  output: string
  error: string | null
}

export interface Agent {
  id: string
  name: string
  description: string
  instructions: string
  modelId: string
  /** Null = built-in hosted model; set = model id on a saved endpoint. */
  endpointId: string | null
  skillIds: string[]
  status: AgentStatus
  createdAt: string
  lastRunAt: string | null
  runCount: number
  recentRuns: AgentRun[]
}

export interface AgentInput {
  name: string
  description: string
  instructions: string
  modelId: string
  endpointId: string | null
  skillIds: string[]
}

export interface Project {
  id: string
  name: string
  desc: string
  updatedAt: string
}

export interface WorkspaceSettings {
  autoRun: boolean
  notify: boolean
  telemetry: boolean
}

export const OPENROUTER_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1'
