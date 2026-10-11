import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  seedAgents,
  seedEndpointModels,
  seedEndpoints,
  seedProjects,
  seedRuns,
  seedSettings,
  seedSkills,
} from './db/seed.js'
import { createVault } from './vault.js'
import type { Agent, AgentRun, Endpoint, Project, Skill, WorkspaceSettings } from './shared/types.js'

export interface WorkspaceStore {
  agents: Agent[]
  /** All agent runs across the workspace; GET /runs filters + sorts. */
  runs: AgentRun[]
  projects: Project[]
  skills: Skill[]
  endpoints: Endpoint[]
  /** endpoint id -> cached model ids (live GET /v1/models refreshes this). */
  endpointModels: Record<string, string[]>
  /** Secret vault: endpoint id -> bearer key. Never serialized to clients. */
  endpointKeys: Record<string, string>
  settings: WorkspaceSettings
  /** Persist to disk; returns false (and logs) when the write fails. */
  save(): boolean
  /** Strip a skill id from every agent's skillIds (call before removing the skill, then save once). */
  detachSkill(skillId: string): void
}

/** Everything written to `store.json`. Key material is deliberately excluded. */
interface Persisted {
  agents: Agent[]
  runs: AgentRun[]
  projects: Project[]
  skills: Skill[]
  endpoints: Endpoint[]
  endpointModels: Record<string, string[]>
  settings: WorkspaceSettings
}

/** Agents from older installs may lack `role`, `isPrimary`, or have a null `endpointId`. */
type LegacyAgent = Omit<Agent, 'endpointId' | 'isPrimary' | 'role'> & {
  endpointId?: string | null
  isPrimary?: boolean
  role?: string
  recentRuns?: Partial<AgentRun>[]
}

/**
 * Older workspaces stored `endpointKeys` in plaintext, runs on each agent, and
 * a seeded `models` catalog (dropped: model choice comes from endpointModels).
 */
type StoredShape = Partial<Persisted> & {
  endpointKeys?: Record<string, string>
  models?: unknown
  agents?: LegacyAgent[]
}

/** Resolved from AGENTCONTROL_DATA_DIR so tests can point at a temp dir. */
const DATA_DIR = process.env.AGENTCONTROL_DATA_DIR ?? resolve(process.cwd(), 'data')
const DEFAULT_PATH = resolve(DATA_DIR, 'store.json')

function seed(): Persisted {
  return {
    agents: structuredClone(seedAgents),
    runs: structuredClone(seedRuns),
    projects: structuredClone(seedProjects),
    skills: structuredClone(seedSkills),
    endpoints: structuredClone(seedEndpoints),
    endpointModels: structuredClone(seedEndpointModels),
    settings: structuredClone(seedSettings),
  }
}

function normalizeRun(r: Partial<AgentRun>): AgentRun {
  return {
    id: r.id ?? `run_${Math.random().toString(36).slice(2, 10)}`,
    agentId: r.agentId ?? '',
    startedAt: r.startedAt ?? new Date().toISOString(),
    status: r.status ?? 'failed',
    durationMs: r.durationMs ?? 0,
    steps: r.steps ?? 0,
    input: r.input ?? '',
    output: r.output ?? '',
    error: r.error ?? null,
    // Audit fields are optional: pre-audit runs parse without them.
    ...(r.systemPrompt !== undefined ? { systemPrompt: r.systemPrompt } : {}),
    ...(r.skillSnapshot !== undefined ? { skillSnapshot: r.skillSnapshot } : {}),
    ...(r.toolCalls !== undefined ? { toolCalls: r.toolCalls } : {}),
  }
}

/** Backfill fields added after a workspace was first written. */
function reconcile(raw: StoredShape): { data: Persisted; changed: boolean } {
  const base = seed()
  let changed = false

  // Runs used to live on each agent (agent.recentRuns); hoist them to `runs`.
  const legacyRuns: AgentRun[] = []
  const rawAgentsList = (raw.agents ?? base.agents) as LegacyAgent[]
  const agents: LegacyAgent[] = rawAgentsList.map((agent) => {
    const { recentRuns, ...rest } = agent
    if (Array.isArray(recentRuns)) {
      for (const r of recentRuns) legacyRuns.push(normalizeRun({ ...r, agentId: r.agentId ?? rest.id }))
    }
    if (rest.role === undefined) {
      rest.role = ''
      changed = true
    }
    return rest
  })

  const endpoints = (raw.endpoints ?? base.endpoints).map((e) => {
    const legacy = e as Partial<Endpoint> & { id: string }
    return { ...e, kind: legacy.kind ?? ('openai-compatible' as const), apiKeySet: false }
  })

  // DD-7 migration: exactly one primary (the Team Lead) and every agent must
  // reference an endpoint. Promote the oldest agent and backfill nulls.
  if (agents.length > 0) {
    let primary = agents.find((a) => a.isPrimary === true)
    if (!primary) {
      primary = [...agents].sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))[0]
      changed = true
    }
    if (primary) {
      const fallbackEndpointId = primary.endpointId ?? endpoints[0]?.id ?? ''
      for (const agent of agents) {
        if (!agent.endpointId) {
          agent.endpointId = fallbackEndpointId
          changed = true
        }
        const shouldBePrimary = agent === primary
        if (agent.isPrimary !== shouldBePrimary) {
          agent.isPrimary = shouldBePrimary
          changed = true
        }
      }
    }
  }

  const runs = (raw.runs ?? (legacyRuns.length > 0 ? legacyRuns : base.runs)).map((r) =>
    normalizeRun(r as Partial<AgentRun>),
  )

  // Seed-skill upgrades: keep saved skills but append seed skills whose ids are
  // missing (e.g. after the placeholder seeds were replaced by real SKILL.md).
  const savedSkills = raw.skills ?? base.skills
  const missingSkills = base.skills.filter((s) => !savedSkills.some((saved) => saved.id === s.id))
  if (missingSkills.length > 0) changed = true

  // Drop the retired model catalog so the next save rewrites store.json without it.
  if (raw.models !== undefined) changed = true

  return {
    data: {
      agents: agents as Agent[],
      runs,
      projects: raw.projects ?? base.projects,
      skills: missingSkills.length > 0 ? [...savedSkills, ...missingSkills] : savedSkills,
      endpoints,
      endpointModels: raw.endpointModels ?? base.endpointModels,
      settings: raw.settings ?? base.settings,
    },
    changed,
  }
}

function read(path: string): { data: Persisted; legacyKeys: Record<string, string>; changed: boolean } {
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as StoredShape
      const { data, changed } = reconcile(raw)
      return { data, legacyKeys: raw.endpointKeys ?? {}, changed }
    } catch {
      // Corrupt or unreadable file falls back to a fresh seed below.
    }
  }
  return { data: seed(), legacyKeys: {}, changed: false }
}

export function createStore(path: string = DEFAULT_PATH): WorkspaceStore {
  const dir = dirname(path)
  const vault = createVault(join(dir, 'vault.enc'), join(dir, 'vault.key'))
  const { data, legacyKeys, changed } = read(path)

  let endpointKeys = vault.load()
  let migrated = changed
  // One-time migration: move any plaintext keys into the encrypted vault.
  if (Object.keys(endpointKeys).length === 0 && Object.keys(legacyKeys).length > 0) {
    endpointKeys = { ...legacyKeys }
    migrated = true
  }

  const store: WorkspaceStore = {
    ...data,
    endpointKeys,
    save() {
      try {
        mkdirSync(dir, { recursive: true })
        const snapshot: Persisted = {
          agents: store.agents,
          runs: store.runs,
          projects: store.projects,
          skills: store.skills,
          endpoints: store.endpoints,
          endpointModels: store.endpointModels,
          settings: store.settings,
        }
        writeFileSync(path, JSON.stringify(snapshot, null, 2), 'utf8')
        vault.save(store.endpointKeys)
        return true
      } catch (err) {
        console.error(
          `[store] failed to persist ${path}: ${err instanceof Error ? err.message : String(err)}`,
        )
        return false
      }
    },
    detachSkill(skillId: string) {
      for (const agent of store.agents) {
        if (agent.skillIds.includes(skillId)) {
          agent.skillIds = agent.skillIds.filter((id) => id !== skillId)
        }
      }
    },
  }

  for (const endpoint of store.endpoints) {
    endpoint.apiKeySet = Boolean(store.endpointKeys[endpoint.id])
  }

  // Rewrite store.json without secrets now that the vault holds them.
  if (migrated) store.save()

  return store
}
