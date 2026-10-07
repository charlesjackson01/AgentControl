import type { Agent, AgentRun, Endpoint, Model, Project, Skill, WorkspaceSettings } from '../shared/types.js'
import { OPENROUTER_DEFAULT_BASE_URL } from '../shared/types.js'

const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString()

export const seedModels: Model[] = [
  { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', provider: 'Anthropic', tier: 'deep', contextWindow: 200_000 },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', provider: 'Anthropic', tier: 'balanced', contextWindow: 200_000 },
  { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', provider: 'Anthropic', tier: 'fast', contextWindow: 200_000 },
  { id: 'gpt-5.2', name: 'GPT-5.2', provider: 'OpenAI', tier: 'balanced', contextWindow: 400_000 },
  { id: 'gpt-5.2-mini', name: 'GPT-5.2 mini', provider: 'OpenAI', tier: 'fast', contextWindow: 400_000 },
  { id: 'o5-pro', name: 'o5-pro', provider: 'OpenAI', tier: 'deep', contextWindow: 200_000 },
  { id: 'llama-4-405b', name: 'Llama 4 405B', provider: 'Meta', tier: 'balanced', contextWindow: 128_000 },
  { id: 'mistral-large-3', name: 'Mistral Large 3', provider: 'Mistral', tier: 'balanced', contextWindow: 128_000 },
  { id: 'llama-3-70b-local', name: 'Llama 3 70B (local)', provider: 'Self-hosted', tier: 'fast', contextWindow: 8_192 },
]

export const seedSkills: Skill[] = [
  { id: 'web-research', name: 'Web Research', description: 'Search, fetch, and cite with source ranking.', tag: 'Core' },
  { id: 'summarize', name: 'Summarize', description: 'Condenses long documents to key points.', tag: 'Core' },
  { id: 'code-interpreter', name: 'Code Interpreter', description: 'Runs sandboxed snippets and plots results.', tag: 'Sandbox' },
  { id: 'sql-query', name: 'SQL Query', description: 'Read-only warehouse access with a query guard.', tag: 'Integration' },
  { id: 'crm-lookup', name: 'CRM Lookup', description: 'Reads contact and deal history.', tag: 'Integration' },
  { id: 'email-draft', name: 'Email Draft', description: 'Writes replies in the account owner’s voice.', tag: 'Core' },
  { id: 'calendar', name: 'Calendar', description: 'Reads availability and books time.', tag: 'Integration' },
  { id: 'webhook', name: 'Webhook', description: 'POSTs structured payloads to a signed endpoint.', tag: 'Integration' },
]

export const seedEndpoints: Endpoint[] = [
  {
    id: 'ep_local_llama',
    kind: 'openai-compatible',
    name: 'Local llama.cpp',
    baseUrl: 'http://127.0.0.1:8080',
    defaultModel: 'llama-3-8b',
    contextWindow: 8192,
    apiKeySet: false,
    status: 'unknown',
    lastCheckedAt: null,
    createdAt: daysAgo(9),
  },
  {
    id: 'ep_openrouter',
    kind: 'openrouter',
    name: 'OpenRouter',
    baseUrl: OPENROUTER_DEFAULT_BASE_URL,
    defaultModel: 'anthropic/claude-sonnet-4',
    contextWindow: 200_000,
    apiKeySet: false,
    status: 'unknown',
    lastCheckedAt: null,
    createdAt: daysAgo(9),
  },
]

/** Cached model ids per endpoint, used until a live GET /v1/models succeeds. */
export const seedEndpointModels: Record<string, string[]> = {
  ep_local_llama: ['llama-3-8b', 'llama-3-70b'],
  ep_openrouter: ['anthropic/claude-sonnet-4', 'openai/gpt-5.2', 'meta-llama/llama-3-70b'],
}

export const seedProjects: Project[] = [
  {
    id: 'proj-support-automation',
    name: 'Support Automation',
    desc: 'Triage and reply pipeline for inbound tickets.',
    updatedAt: daysAgo(0),
  },
  {
    id: 'proj-docs-refresh',
    name: 'Docs Refresh',
    desc: 'Rewrites stale guides from the product changelog.',
    updatedAt: daysAgo(1),
  },
  {
    id: 'proj-data-platform',
    name: 'Data Platform',
    desc: 'Nightly ETL plus schema drift monitoring.',
    updatedAt: daysAgo(3),
  },
]

// Fresh installs start empty: no agents and no runs. The first agent created
// becomes the Team Lead (primary), and its endpoint is the workspace default.
export const seedAgents: Agent[] = []

export const seedRuns: AgentRun[] = []

export const seedSettings: WorkspaceSettings = {
  autoRun: true,
  notify: true,
  telemetry: false,
}
