import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  seedAgents,
  seedEndpointModels,
  seedEndpoints,
  seedModels,
  seedProjects,
  seedSettings,
  seedSkills,
} from './db/seed.js'
import { createVault } from './vault.js'
import type { Agent, Endpoint, Model, Project, Skill, WorkspaceSettings } from './shared/types.js'

export interface WorkspaceStore {
  agents: Agent[]
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
  projects: Project[]
  skills: Skill[]
  models: Model[]
  endpoints: Endpoint[]
  endpointModels: Record<string, string[]>
  settings: WorkspaceSettings
}

/** Older workspaces stored `endpointKeys` in plaintext alongside the rest. */
type StoredShape = Partial<Persisted> & { endpointKeys?: Record<string, string> }

const DEFAULT_PATH = resolve(process.cwd(), 'data', 'store.json')

function seed(): Persisted {
  return {
    agents: structuredClone(seedAgents),
    projects: structuredClone(seedProjects),
    skills: structuredClone(seedSkills),
    models: structuredClone(seedModels),
    endpoints: structuredClone(seedEndpoints),
    endpointModels: structuredClone(seedEndpointModels),
    settings: structuredClone(seedSettings),
  }
}

/** Backfill fields added after a workspace was first written. */
function reconcile(raw: StoredShape): Persisted {
  const base = seed()
  const endpoints = (raw.endpoints ?? base.endpoints).map((e) => {
    const legacy = e as Partial<Endpoint> & { id: string }
    return { ...e, kind: legacy.kind ?? ('openai-compatible' as const), apiKeySet: false }
  })
  return {
    agents: raw.agents ?? base.agents,
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
