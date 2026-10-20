import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Agent, AgentRun, Endpoint, Skill, WorkspaceSettings } from '../shared/types.js'
import { DEFAULT_ENDPOINT_BASE_URL, OPENROUTER_DEFAULT_BASE_URL } from '../shared/types.js'
import { resolveToolDeclarations } from '../tools.js'
import { parseSkillMarkdown } from './skill-md.js'

const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString()

const VENDORED_SOURCE = 'seb1n/awesome-ai-agent-skills'

/**
 * Seed skills, loaded through the same SKILL.md parser the import endpoint
 * uses; the frontmatter `name` becomes the id and its `tools:` list is
 * resolved strictly against the built-in registry (an unknown name is a bug).
 * The first six are vendored (MIT, seb1n/awesome-ai-agent-skills): their
 * bodies must stay byte-identical — the seed-skill migrations compare
 * content — so only their frontmatter `tools:` line is ours. Changing any
 * shipped seed's body, description or tools needs a seed-upgrade entry in
 * store.ts, or existing installs keep the old copy.
 */
const SEED_SKILL_MANIFEST: { file: string; tag: string; source: string }[] = [
  { file: 'code-review', tag: 'Core', source: VENDORED_SOURCE },
  { file: 'debugging', tag: 'Core', source: VENDORED_SOURCE },
  { file: 'deep-research', tag: 'Core', source: VENDORED_SOURCE },
  { file: 'multi-agent-orchestration', tag: 'Core', source: VENDORED_SOURCE },
  { file: 'summarization', tag: 'Core', source: VENDORED_SOURCE },
  { file: 'technical-writing', tag: 'Core', source: VENDORED_SOURCE },
  // Locally authored replacements: the interrupted work's original ten names
  // were not recoverable. These names describe the available offline tools.
  { file: 'calculation-checker', tag: 'Math', source: 'AgentControl' },
  { file: 'unit-conversion', tag: 'Math', source: 'AgentControl' },
  { file: 'date-arithmetic', tag: 'Time', source: 'AgentControl' },
  { file: 'text-cleanup', tag: 'Text', source: 'AgentControl' },
  { file: 'text-comparison', tag: 'Text', source: 'AgentControl' },
  { file: 'json-inspection', tag: 'Data', source: 'AgentControl' },
  { file: 'csv-analysis', tag: 'Data', source: 'AgentControl' },
  { file: 'notes-organizer', tag: 'Notes', source: 'AgentControl' },
  { file: 'meeting-notes', tag: 'Notes', source: 'AgentControl' },
  { file: 'workspace-audit', tag: 'Workspace', source: 'AgentControl' },
  // Added with seed-skill-upgrade-v3; existing stores gain them as never-offered seeds.
  { file: 'encoding-and-hashing', tag: 'Data', source: 'AgentControl' },
  { file: 'release-notes', tag: 'Text', source: 'AgentControl' },
]

const SEED_SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'seed-skills')

export const seedSkills: Skill[] = SEED_SKILL_MANIFEST.map(({ file, tag, source }) => {
  const parsed = parseSkillMarkdown(readFileSync(join(SEED_SKILLS_DIR, `${file}.md`), 'utf8'))
  return {
    id: parsed.name,
    name: parsed.name,
    description: parsed.description,
    tag,
    content: parsed.content,
    tools: resolveToolDeclarations(parsed.tools, { strict: true }).tools,
    source,
  }
})

/** The vendored seeds (bodies pinned by a test; the tools migration targets them). */
export const vendoredSeedSkills: Skill[] = seedSkills.filter((s) => s.source === VENDORED_SOURCE)

export const seedEndpoints: Endpoint[] = [
  {
    id: 'ep_local_llama',
    kind: 'openai-compatible',
    name: 'Test endpoint (placeholder)',
    baseUrl: DEFAULT_ENDPOINT_BASE_URL,
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

// Fresh installs start empty: no agents and no runs. The first agent created
// becomes the Team Lead (primary), and its endpoint is the workspace default.
export const seedAgents: Agent[] = []

export const seedRuns: AgentRun[] = []

export const seedSettings: WorkspaceSettings = {
  autoRun: true,
  notify: true,
  telemetry: false,
}
