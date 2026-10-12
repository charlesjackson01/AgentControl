import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  seedAgents,
  seedEndpointModels,
  seedEndpoints,
  seedProjects,
  seedRuns,
  seedSettings,
  seedSkills,
  vendoredSeedSkills,
} from './db/seed.js'
import { createVault } from './vault.js'
import type { Agent, AgentRun, Endpoint, Note, Project, Skill, WorkspaceSettings } from './shared/types.js'

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
  /** Shared workspace memory written by the notes tools. */
  notes: Note[]
  /** Migration bookkeeping. Persisted, never served by any route. */
  meta: StoreMeta
  /** Persist to disk; returns false (and logs) when the write fails. */
  save(): boolean
  /** Strip a skill id from every agent's skillIds (call before removing the skill, then save once). */
  detachSkill(skillId: string): void
}

export interface StoreMeta {
  /** One-shot migrations already applied to this store. */
  migrations: string[]
  /** Seed skill ids ever offered; a seed the user deleted is not re-added. */
  seededSkillIds: string[]
}

/** Every one-shot migration; fresh stores are born with all of them applied. */
const MIGRATIONS = ['seed-skill-tools-v1', 'seed-skill-upgrade-v2'] as const

/**
 * Seed skills whose shipped definition changed after installs could already
 * hold them (v2: new workspace/text/time tools). A stored copy that still
 * matches the previously shipped body (sha256) AND tool list exactly is
 * upgraded once to the current seed; anything the user edited is left alone.
 */
const SEED_UPGRADES_V2: { id: string; fromContentSha256: string; fromTools: string[] }[] = [
  { id: 'workspace-audit', fromContentSha256: '3ea11690d365886afa3b17ecb9fb8050066550fee1e937e61771e905a032caa5', fromTools: ['list_agents', 'list_skills', 'read_run_log'] },
  { id: 'date-arithmetic', fromContentSha256: '9264e35940d390adc46c5f86a0e9304b93dc5e26a83edfe4002de87f2f562549', fromTools: ['current_time', 'date_difference', 'add_date'] },
  { id: 'text-cleanup', fromContentSha256: '0f4d16c98168500b2b77e370d28d0b35c6dd7e674d351db88aca729664fd764a', fromTools: ['text_stats', 'transform_text', 'read_note'] },
  { id: 'multi-agent-orchestration', fromContentSha256: '519e7934e125feb8a3a8d2c56996a9c8e274207567a8115fc034387e312263a5', fromTools: [] },
]

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

/** Everything written to `store.json`. Key material is deliberately excluded. */
interface Persisted {
  agents: Agent[]
  runs: AgentRun[]
  projects: Project[]
  skills: Skill[]
  endpoints: Endpoint[]
  endpointModels: Record<string, string[]>
  settings: WorkspaceSettings
  notes: Note[]
  meta: StoreMeta
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

/**
 * The seeded default endpoint as older installs wrote it. Its successor (same
 * id) is the testing placeholder; a store still holding this untouched value
 * is repointed on load, while an endpoint the user edited is left alone.
 */
const LEGACY_SEED_ENDPOINT = { id: 'ep_local_llama', name: 'Local llama.cpp', baseUrl: 'http://127.0.0.1:8080' }

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
    notes: [],
    meta: { migrations: [...MIGRATIONS], seededSkillIds: seedSkills.map((s) => s.id) },
  }
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')

function normalizeMeta(raw: unknown): StoreMeta | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as Partial<StoreMeta>
  return {
    migrations: isStringArray(m.migrations) ? [...m.migrations] : [],
    seededSkillIds: isStringArray(m.seededSkillIds) ? [...m.seededSkillIds] : [],
  }
}

/** Keep well-formed notes only (model-written data; be strict on load). */
function normalizeNotes(raw: unknown): Note[] {
  if (!Array.isArray(raw)) return []
  const out: Note[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const n = item as Partial<Note>
    if (typeof n.id !== 'string' || typeof n.title !== 'string' || typeof n.body !== 'string') continue
    const createdAt = typeof n.createdAt === 'string' ? n.createdAt : new Date(0).toISOString()
    out.push({
      id: n.id,
      title: n.title,
      body: n.body,
      tags: isStringArray(n.tags) ? n.tags : [],
      authorAgentId: typeof n.authorAgentId === 'string' ? n.authorAgentId : '',
      updatedByAgentId: typeof n.updatedByAgentId === 'string' ? n.updatedByAgentId : (n.authorAgentId ?? ''),
      runId: typeof n.runId === 'string' ? n.runId : '',
      createdAt,
      updatedAt: typeof n.updatedAt === 'string' ? n.updatedAt : createdAt,
    })
  }
  return out
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

  const seedDefault = base.endpoints.find((e) => e.id === LEGACY_SEED_ENDPOINT.id)
  const endpoints = (raw.endpoints ?? base.endpoints).map((e) => {
    const legacy = e as Partial<Endpoint> & { id: string }
    const endpoint = { ...e, kind: legacy.kind ?? ('openai-compatible' as const), apiKeySet: false }
    const untouchedOldSeed =
      legacy.id === LEGACY_SEED_ENDPOINT.id &&
      legacy.name === LEGACY_SEED_ENDPOINT.name &&
      legacy.baseUrl === LEGACY_SEED_ENDPOINT.baseUrl
    if (untouchedOldSeed && seedDefault) {
      changed = true
      return { ...endpoint, name: seedDefault.name, baseUrl: seedDefault.baseUrl }
    }
    return endpoint
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
  // Pre-SKILL.md placeholder skills have no `content`/`tools`; the FE assumes
  // both, so backfill them instead of crashing the Skill Library.
  const savedSkills = (raw.skills ?? base.skills).map((s) => {
    const legacy = s as Partial<Skill> & { id: string }
    if (typeof legacy.content === 'string' && Array.isArray(legacy.tools)) return s
    changed = true
    return { ...s, content: typeof legacy.content === 'string' ? legacy.content : '', tools: Array.isArray(legacy.tools) ? legacy.tools : [] }
  })
  const storedMeta = normalizeMeta(raw.meta)
  if (!storedMeta) changed = true
  const meta: StoreMeta = storedMeta ?? { migrations: [], seededSkillIds: [] }

  // One-shot: vendored seed skills the user never edited (same content, no
  // tools) gain the tools they now ship with. Runs once, so tools a user
  // later clears stay cleared.
  if (!meta.migrations.includes('seed-skill-tools-v1')) {
    for (let i = 0; i < savedSkills.length; i++) {
      const saved = savedSkills[i] as Skill
      const seed = vendoredSeedSkills.find((v) => v.id === saved.id)
      if (seed && seed.tools.length > 0 && saved.tools.length === 0 && saved.content === seed.content) {
        savedSkills[i] = { ...saved, tools: structuredClone(seed.tools) }
      }
    }
    meta.migrations.push('seed-skill-tools-v1')
    changed = true
  }

  // One-shot: untouched copies of seeds whose definition changed since they
  // were offered get the current definition (body, description, tools).
  if (!meta.migrations.includes('seed-skill-upgrade-v2')) {
    for (const upgrade of SEED_UPGRADES_V2) {
      const i = savedSkills.findIndex((s) => s.id === upgrade.id)
      const seed = base.skills.find((s) => s.id === upgrade.id)
      const saved = savedSkills[i]
      if (!saved || !seed) continue
      const savedTools = saved.tools.map((t) => t.name)
      const untouched =
        typeof saved.content === 'string' &&
        sha256(saved.content) === upgrade.fromContentSha256 &&
        savedTools.length === upgrade.fromTools.length &&
        savedTools.every((name, k) => name === upgrade.fromTools[k])
      if (untouched) {
        savedSkills[i] = { ...saved, description: seed.description, content: seed.content, tools: structuredClone(seed.tools) }
      }
    }
    meta.migrations.push('seed-skill-upgrade-v2')
    changed = true
  }

  // Append seed skills that are missing and were never offered before; a seed
  // the user deleted (already in seededSkillIds) stays deleted.
  const missingSkills = base.skills.filter(
    (s) => !savedSkills.some((saved) => saved.id === s.id) && !meta.seededSkillIds.includes(s.id),
  )
  if (missingSkills.length > 0) changed = true
  const neverOffered = base.skills.filter((s) => !meta.seededSkillIds.includes(s.id)).map((s) => s.id)
  if (neverOffered.length > 0) {
    meta.seededSkillIds.push(...neverOffered)
    changed = true
  }

  const notes = normalizeNotes(raw.notes)
  if (Array.isArray(raw.notes) && notes.length !== raw.notes.length) changed = true

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
      notes,
      meta,
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
      const temporary = `${path}.${randomUUID()}.tmp`
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
          notes: store.notes,
          meta: store.meta,
        }
        // Finish fallible vault work before publishing the workspace snapshot.
        // Atomic replacement keeps failed note writes/deletes off disk as well
        // as out of memory; an interrupted write cannot truncate store.json.
        const serialized = JSON.stringify(snapshot, null, 2)
        vault.save(store.endpointKeys)
        writeFileSync(temporary, serialized, { encoding: 'utf8', mode: 0o600 })
        renameSync(temporary, path)
        return true
      } catch (err) {
        console.error(
          `[store] failed to persist ${path}: ${err instanceof Error ? err.message : String(err)}`,
        )
        return false
      } finally {
        try { rmSync(temporary, { force: true }) } catch { /* Preserve the original failure. */ }
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
