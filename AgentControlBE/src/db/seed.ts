import type { Agent, AgentRun, Endpoint, Model, Project, RunStatus, Skill, WorkspaceSettings } from '../shared/types.js'
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

type SeedRun = Omit<AgentRun, 'agentId' | 'input' | 'output' | 'error'>
type SeedAgent = Agent & { recentRuns: SeedRun[] }

function run(id: string, days: number, status: RunStatus, durationMs: number, steps: number): SeedRun {
  return { id, startedAt: daysAgo(days), status, durationMs, steps }
}

const rawAgents: SeedAgent[] = [
  {
    id: 'agt_research',
    name: 'Research Runner',
    description: 'Multi-step web research with a citation pass before it answers.',
    instructions:
      'Break the request into sub-questions, research each one, then reconcile the findings into a single cited answer. Flag disagreements between sources instead of silently picking one.',
    modelId: 'claude-opus-4-6',
    endpointId: null,
    skillIds: ['web-research', 'summarize'],
    status: 'running',
    createdAt: daysAgo(84),
    lastRunAt: daysAgo(0),
    runCount: 1_284,
    recentRuns: [run('r1', 0, 'running', 0, 4), run('r2', 1, 'succeeded', 184_000, 11), run('r3', 2, 'succeeded', 162_000, 9)],
  },
  {
    id: 'agt_inbox',
    name: 'Inbox Triage',
    description: 'Classifies, tags, and drafts replies for inbound support mail.',
    instructions: 'Sort into billing, bug, or how-to. Draft a reply for anything not billing. Never send without review.',
    modelId: 'claude-sonnet-4-6',
    endpointId: null,
    skillIds: ['summarize', 'email-draft', 'crm-lookup'],
    status: 'running',
    createdAt: daysAgo(61),
    lastRunAt: daysAgo(0),
    runCount: 4_112,
    recentRuns: [run('r1', 0, 'succeeded', 42_000, 5), run('r2', 0, 'running', 0, 2)],
  },
  {
    id: 'agt_review',
    name: 'Code Reviewer',
    description: 'Reviews open diffs against the conventions in CONTRIBUTING.md.',
    instructions: 'Comment only on correctness, security, and convention breaks. Skip formatting nits.',
    modelId: 'gpt-5.2',
    endpointId: null,
    skillIds: ['code-interpreter'],
    status: 'idle',
    createdAt: daysAgo(45),
    lastRunAt: daysAgo(3),
    runCount: 968,
    recentRuns: [run('r1', 3, 'succeeded', 96_000, 7), run('r2', 4, 'failed', 22_000, 2)],
  },
  {
    id: 'agt_release',
    name: 'Release Notes',
    description: 'Turns merged pull requests into a customer-facing changelog entry.',
    instructions: 'Group by Added, Changed, Fixed. Skip internal refactors. Write for someone who has not used the product this week.',
    modelId: 'claude-haiku-4-5',
    endpointId: null,
    skillIds: ['summarize'],
    status: 'idle',
    createdAt: daysAgo(30),
    lastRunAt: daysAgo(1),
    runCount: 74,
    recentRuns: [run('r1', 1, 'succeeded', 31_000, 3)],
  },
  {
    id: 'agt_migrate',
    name: 'Data Migrator',
    description: 'Plans and applies schema migrations against a staging copy first.',
    instructions: 'Always plan before applying. Stop and ask if the plan would drop a column that has data.',
    modelId: 'o5-pro',
    endpointId: null,
    skillIds: ['sql-query', 'code-interpreter'],
    status: 'queued',
    createdAt: daysAgo(21),
    lastRunAt: daysAgo(2),
    runCount: 46,
    recentRuns: [run('r1', 2, 'succeeded', 610_000, 18), run('r2', 5, 'failed', 120_000, 6)],
  },
  {
    id: 'agt_support',
    name: 'Support Bot',
    description: 'First-line answers drawn from the help center, escalating when unsure.',
    instructions: 'Only answer from the help center. If there is no matching article, escalate to a human with a summary.',
    modelId: 'llama-4-405b',
    endpointId: null,
    skillIds: ['web-research'],
    status: 'error',
    createdAt: daysAgo(12),
    lastRunAt: daysAgo(1),
    runCount: 231,
    recentRuns: [run('r1', 1, 'failed', 12_000, 1), run('r2', 2, 'failed', 12_000, 1)],
  },
  {
    id: 'agt_standup',
    name: 'Standup Digest',
    description: 'Summarizes merged PRs and closed tickets into a daily post.',
    instructions: 'One paragraph. Lead with anything that blocked someone.',
    modelId: 'llama-3-70b-local',
    endpointId: null,
    skillIds: ['summarize', 'webhook'],
    status: 'idle',
    createdAt: daysAgo(5),
    lastRunAt: daysAgo(0),
    runCount: 5,
    recentRuns: [run('r1', 0, 'succeeded', 8_000, 2)],
  },
]

export const seedAgents: Agent[] = rawAgents.map((agent) => {
  const { recentRuns: _runs, ...rest } = agent
  return rest
})

export const seedRuns: AgentRun[] = rawAgents.flatMap((agent) =>
  agent.recentRuns.map((r) => ({ ...r, agentId: agent.id, input: '', output: '', error: null })),
)

export const seedSettings: WorkspaceSettings = {
  autoRun: true,
  notify: true,
  telemetry: false,
}
