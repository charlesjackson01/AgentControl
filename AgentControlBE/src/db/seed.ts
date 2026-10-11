import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Agent, AgentRun, Endpoint, Project, Skill, WorkspaceSettings } from '../shared/types.js'
import { OPENROUTER_DEFAULT_BASE_URL } from '../shared/types.js'
import { parseSkillMarkdown } from './skill-md.js'

const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString()

/**
 * Real SKILL.md files (MIT, seb1n/awesome-ai-agent-skills) shipped under
 * `src/db/seed-skills/` and loaded through the same parser the import
 * endpoint uses. The frontmatter `name` becomes the skill id.
 */
const SEED_SKILL_FILES = [
  'code-review',
  'debugging',
  'deep-research',
  'multi-agent-orchestration',
  'summarization',
  'technical-writing',
]

const SEED_SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'seed-skills')

export const seedSkills: Skill[] = SEED_SKILL_FILES.map((file) => {
  const parsed = parseSkillMarkdown(readFileSync(join(SEED_SKILLS_DIR, `${file}.md`), 'utf8'))
  return {
    id: parsed.name,
    name: parsed.name,
    description: parsed.description,
    tag: 'Core',
    content: parsed.content,
    tools: [],
    source: 'seb1n/awesome-ai-agent-skills',
  }
})

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
