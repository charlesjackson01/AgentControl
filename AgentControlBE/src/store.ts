import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  seedAgents,
  seedEndpointModels,
  seedEndpoints,
  seedModels,
  seedProjects,
  seedRuns,
  seedSettings,
  seedSkills,
} from './db/seed.js'
import { createVault } from './vault.js'
import type { Agent, AgentRun, Endpoint, Model, Project, Skill, WorkspaceSettings } from './shared/types.js'

export interface WorkspaceStore {
  agents: Agent[]
  /** All agent runs across the workspace; GET /runs filters + sorts. */
  runs: AgentRun[]
  projects: Project[]
  skills: Skill[]
  models: Model[]
  endpoints: Endpoint[]
  /** endpoint id -> cached model ids (live GET /v1/models refreshes this). */
  endpointModels: Record<string, string[]>
  /** Secret vault: endpoint id -> bearer key. Never serialized to clients. */
  endpointKeys: Record<string, string>
  settings: WorkspaceSettings
  /** Persist the current store to disk (secrets go to the encrypted vault). */
  save(): void
}

/** Everything written to `store.json`. Key material is deliberately excluded. */
interface Persisted {
  agents: Agent[]
  runs: AgentRun[]
  projects: Project[]
  skills: Skill[]
  models: Model[]
  endpoints: Endpoint[]
  endpointModels: Record<string, string[]>
  settings: WorkspaceSettings
}

/** Older workspaces stored `endpointKeys` in plaintext and runs on each agent. */
type StoredShape = Partial<Persisted> & {
  endpointKeys?: Record<string, string>
  agents?: (Agent & { recentRuns?: Partial<AgentRun>[] })[]
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
    models: structuredClone(seedModels),
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
  }
}

/** Backfill fields added after a workspace was first written. */
function reconcile(raw: StoredShape): Persisted {
  const base = seed()

  // Runs used to live on each agent (agent.recentRuns); hoist them to `runs`.
  const legacyRuns: AgentRun[] = []
  const rawAgentsList = (raw.agents ?? base.agents) as (Agent & { recentRuns?: Partial<AgentRun>[] })[]
  const agents: Agent[] = rawAgentsList.map((agent) => {
    const { recentRuns, ...rest } = agent
    if (Array.isArray(recentRuns)) {
      for (const r of recentRuns) legacyRuns.push(normalizeRun({ ...r, agentId: r.agentId ?? rest.id }))
    }
    return rest as Agent
  })

  const endpoints = (raw.endpoints ?? base.endpoints).map((e) => {
    const legacy = e as Partial<Endpoint> & { id: string }
    return { ...e, kind: legacy.kind ?? ('openai-compatible' as const), apiKeySet: false }
  })

  const runs = (raw.runs ?? (legacyRuns.length > 0 ? legacyRuns : base.runs)).map((r) =>
    normalizeRun(r as Partial<AgentRun>),
  )

  return {
    agents,
    runs,
    projects: raw.projects ?? base.projects,
    skills: raw.skills ?? base.skills,
    models: raw.models ?? base.models,
    endpoints,
    endpointModels: raw.endpointModels ?? base.endpointModels,
    settings: raw.settings ?? base.settings,
  }
}

function read(path: string): { data: Persisted; legacyKeys: Record<string, string> } {
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as StoredShape
      return { data: reconcile(raw), legacyKeys: raw.endpointKeys ?? {} }
    } catch {
      // Corrupt or unreadable file falls back to a fresh seed below.
    }
  }
  return { data: seed(), legacyKeys: {} }
}

export function createStore(path: string = DEFAULT_PATH): WorkspaceStore {
  const dir = dirname(path)
  const vault = createVault(join(dir, 'vault.enc'), join(dir, 'vault.key'))
  const { data, legacyKeys } = read(path)

  let endpointKeys = vault.load()
  let migrated = false
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
          models: store.models,
          endpoints: store.endpoints,
          endpointModels: store.endpointModels,
          settings: store.settings,
        }
        writeFileSync(path, JSON.stringify(snapshot, null, 2), 'utf8')
        vault.save(store.endpointKeys)
      } catch {
        // Persistence failure is non-fatal: the in-memory store keeps working.
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
