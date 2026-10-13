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
import type {
  Agent,
  AgentRun,
  Endpoint,
  Note,
  Project,
  ProjectMessage,
  ProjectMessageKind,
  Skill,
  TaskStatus,
  WorkspaceSettings,
} from './shared/types.js'

export interface WorkspaceStore {
  agents: Agent[]
  /** All agent runs across the workspace; GET /runs filters + sorts. */
  runs: AgentRun[]
  projects: Project[]
  /** Flat project chat log; GET /projects/:id/messages filters + sorts. */
  projectMessages: ProjectMessage[]
  skills: Skill[]
  endpoints: Endpoint[]
  /** endpoint id -> cached model ids (live GET /v1/models refreshes this). */
  endpointModels: Record<string, string[]>
  /** Secret vault: endpoint id -> bearer key. Never serialized to clients. */
  endpointKeys: Record<string, string>
  settings: WorkspaceSettings
  /** Shared workspace memory written by the notes tools. */
  notes: Note[]
  /** Absolute root under which project folders are created. */
  projectsRoot: string
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
const MIGRATIONS = ['seed-skill-tools-v1', 'seed-skill-upgrade-v2', 'seed-skill-upgrade-v3'] as const

/** A seed exactly as an earlier release shipped it: body sha256 and tool names in order. */
interface SeedUpgrade {
  id: string
  fromContentSha256: string
  fromTools: string[]
}

/**
 * Seed skills whose shipped definition changed after installs could already
 * hold them, one batch per one-shot migration. A stored copy that still
 * matches the previously shipped body (sha256) AND tool list exactly is
 * upgraded once to the current seed (description, body, tools); anything the
 * user edited, cleared or deleted is left alone. Batches run oldest first, so
 * an older store reaches the current seed through whichever batch matches.
 * The previous versions are snapshotted in src/db/seed-upgrade-fixtures/.
 */
const SEED_UPGRADES: readonly { migration: (typeof MIGRATIONS)[number]; skills: readonly SeedUpgrade[] }[] = [
  {
    // v2: new workspace/text/time tools.
    migration: 'seed-skill-upgrade-v2',
    skills: [
      { id: 'workspace-audit', fromContentSha256: '3ea11690d365886afa3b17ecb9fb8050066550fee1e937e61771e905a032caa5', fromTools: ['list_agents', 'list_skills', 'read_run_log'] },
      { id: 'date-arithmetic', fromContentSha256: '9264e35940d390adc46c5f86a0e9304b93dc5e26a83edfe4002de87f2f562549', fromTools: ['current_time', 'date_difference', 'add_date'] },
      { id: 'text-cleanup', fromContentSha256: '0f4d16c98168500b2b77e370d28d0b35c6dd7e674d351db88aca729664fd764a', fromTools: ['text_stats', 'transform_text', 'read_note'] },
      { id: 'multi-agent-orchestration', fromContentSha256: '519e7934e125feb8a3a8d2c56996a9c8e274207567a8115fc034387e312263a5', fromTools: [] },
    ],
  },
  {
    // v3: get_skill, diff_text, encode_text and the data/math upgrades; the
    // vendored seeds (bodies unchanged) gain frontmatter tools.
    migration: 'seed-skill-upgrade-v3',
    skills: [
      { id: 'code-review', fromContentSha256: '306c451504e224af7b2b02839e71c5c72ec9b7eb1734980e29a7b73c5db88af0', fromTools: [] },
      { id: 'debugging', fromContentSha256: 'e4163cedaecee9abf765750fe8813fea8569d969819eab30abd1e2a5800552c2', fromTools: [] },
      { id: 'deep-research', fromContentSha256: 'c1b37bd73105e2860955e19082f52555f6e72d8d2f338b0c7708e062e5080e67', fromTools: [] },
      { id: 'multi-agent-orchestration', fromContentSha256: '519e7934e125feb8a3a8d2c56996a9c8e274207567a8115fc034387e312263a5', fromTools: ['list_agents', 'get_agent', 'workspace_overview', 'read_run_log'] },
      { id: 'summarization', fromContentSha256: 'd0489707af6cd52a188e8b15dbec05c326894915a7641157d701a7e954a0485a', fromTools: [] },
      { id: 'technical-writing', fromContentSha256: '385f4d1d0e3619a3b58df43393efc83c28c5c0502f121bbdebeb854327610229', fromTools: [] },
      { id: 'calculation-checker', fromContentSha256: 'e6fa9cd2c096cfe7e0bbfa775779f185d160cba9d01bebecf2992656866e0337', fromTools: ['calculate'] },
      { id: 'unit-conversion', fromContentSha256: '21346d77d42a53a8477eb19002103cbcd6c03a57ea11c2eeb5a15600893d7690', fromTools: ['convert_units', 'calculate'] },
      { id: 'text-comparison', fromContentSha256: 'f1e4e77680b36a8f927edf079e7d934c6f98376eee0c50c75029569242ad1c22', fromTools: ['compare_text', 'read_note'] },
      { id: 'json-inspection', fromContentSha256: '0554323d8f540b857f8c2b9076619cac60af54f73af958b5cf66834b7538fca7', fromTools: ['json_query', 'read_note'] },
      { id: 'csv-analysis', fromContentSha256: '63ad70fea13c2bb21d3327b93904827b2c92b1897caae988482f55b45fcccb7b', fromTools: ['csv_summary', 'read_note'] },
      { id: 'workspace-audit', fromContentSha256: '60ac72c694861e4f9361c4452db690107426df2634e6b28b73f8f6c3768b7ccd', fromTools: ['list_agents', 'list_skills', 'read_run_log', 'get_agent', 'workspace_overview'] },
    ],
  },
]

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

/** True when a stored copy is byte-for-byte the shipped body with the shipped tool names, in order. */
function isUntouchedSeed(saved: Skill, upgrade: SeedUpgrade): boolean {
  // Tolerate hand-edited entries (a null tool) rather than failing the whole load.
  const tools = Array.isArray(saved.tools) ? saved.tools.map((t) => (t as { name?: unknown } | null)?.name) : []
  return (
    typeof saved.content === 'string' &&
    sha256(saved.content) === upgrade.fromContentSha256 &&
    tools.length === upgrade.fromTools.length &&
    tools.every((name, k) => name === upgrade.fromTools[k])
  )
}

/** Everything written to `store.json`. Key material is deliberately excluded. */
interface Persisted {
  agents: Agent[]
  runs: AgentRun[]
  projects: Project[]
  projectMessages: ProjectMessage[]
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

/**
 * Folder name for a project: lowercase, alphanumerics and dashes. Names that
 * slugify to nothing fall back to `project`.
 */
export function slugifyProjectName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'project'
}

function seed(projectsRoot: string): Persisted {
  return {
    agents: structuredClone(seedAgents),
    runs: structuredClone(seedRuns),
    projects: seedProjects(projectsRoot),
    projectMessages: [],
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

/** Keep well-formed projects; backfill fields added after the first shape. */
function normalizeProjects(raw: unknown, projectsRoot: string): Project[] {
  if (!Array.isArray(raw)) return []
  const out: Project[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const p = item as Partial<Project>
    if (typeof p.id !== 'string' || typeof p.name !== 'string') continue
    const updatedAt = typeof p.updatedAt === 'string' ? p.updatedAt : new Date(0).toISOString()
    out.push({
      id: p.id,
      name: p.name,
      desc: typeof p.desc === 'string' ? p.desc : '',
      folder:
        typeof p.folder === 'string' && p.folder
          ? p.folder
          : join(projectsRoot, slugifyProjectName(p.name)),
      teamAgentIds: isStringArray(p.teamAgentIds) ? [...p.teamAgentIds] : [],
      createdAt: typeof p.createdAt === 'string' ? p.createdAt : updatedAt,
      updatedAt,
    })
  }
  return out
}

const MESSAGE_KINDS: readonly ProjectMessageKind[] = ['message', 'team-update', 'task-assignment']
const TASK_STATUSES: readonly TaskStatus[] = ['queued', 'running', 'done', 'failed']

/**
 * Keep well-formed project messages and the task fields the contract has.
 * Any other kind loads as a 'message', which covers the pre-handoff kinds a
 * development build wrote: a 'team-plan' (Primary's reply; its stored plan
 * and planStatus are dropped) and a 'task-result' (it keeps taskId, runId
 * and taskStatus, as a task's result message does now). Messages that named
 * their plan by planId reply to that plan's prompt instead, and a plan that
 * was never applied no longer counts as an answer, so its prompt can be
 * asked again.
 */
function normalizeProjectMessages(raw: unknown): ProjectMessage[] {
  if (!Array.isArray(raw)) return []
  type Legacy = Partial<ProjectMessage> & { planId?: unknown; planStatus?: unknown }
  const planPrompt = new Map<string, string>()
  for (const item of raw) {
    const m = item as Legacy | null
    if (m && m.kind === ('team-plan' as string) && typeof m.id === 'string' && typeof m.replyTo === 'string') {
      planPrompt.set(m.id, m.replyTo)
    }
  }
  const out: ProjectMessage[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const m = item as Partial<ProjectMessage>
    if (typeof m.id !== 'string' || typeof m.projectId !== 'string') continue
    if (typeof m.text !== 'string') continue
    const kind = MESSAGE_KINDS.includes(m.kind as ProjectMessageKind) ? (m.kind as ProjectMessageKind) : 'message'
    const legacy = m as Legacy
    const unapplied = legacy.kind === ('team-plan' as string) && legacy.planStatus !== undefined && legacy.planStatus !== 'applied'
    const replyTo = unapplied
      ? undefined
      : typeof m.replyTo === 'string'
        ? m.replyTo
        : typeof legacy.planId === 'string'
          ? planPrompt.get(legacy.planId)
          : undefined
    out.push({
      id: m.id,
      projectId: m.projectId,
      author: typeof m.author === 'string' ? m.author : 'user',
      text: m.text,
      kind,
      createdAt: typeof m.createdAt === 'string' ? m.createdAt : new Date(0).toISOString(),
      ...(typeof m.updatedAt === 'string' ? { updatedAt: m.updatedAt } : {}),
      ...(replyTo !== undefined ? { replyTo } : {}),
      ...(typeof m.assigneeId === 'string' ? { assigneeId: m.assigneeId } : {}),
      ...(TASK_STATUSES.includes(m.taskStatus as TaskStatus) ? { taskStatus: m.taskStatus } : {}),
      ...(typeof m.taskId === 'string' ? { taskId: m.taskId } : {}),
      ...(typeof m.runId === 'string' ? { runId: m.runId } : {}),
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
    ...(typeof r.projectId === 'string' ? { projectId: r.projectId } : {}),
  }
}

/** Backfill fields added after a workspace was first written. */
function reconcile(raw: StoredShape, projectsRoot: string): { data: Persisted; changed: boolean } {
  const base = seed(projectsRoot)
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

  // One-shot, oldest batch first: untouched copies of seeds whose definition
  // changed since they were offered get the current definition.
  for (const { migration, skills } of SEED_UPGRADES) {
    if (meta.migrations.includes(migration)) continue
    for (const upgrade of skills) {
      const i = savedSkills.findIndex((s) => s.id === upgrade.id)
      const seed = base.skills.find((s) => s.id === upgrade.id)
      const saved = savedSkills[i]
      if (saved && seed && isUntouchedSeed(saved, upgrade)) {
        savedSkills[i] = { ...saved, description: seed.description, content: seed.content, tools: structuredClone(seed.tools) }
      }
    }
    meta.migrations.push(migration)
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

  // Teams and project tags only point at things that exist: a team holding a
  // deleted agent's id could not be saved again (PATCH rejects unknown ids).
  const agentIds = new Set((agents as Agent[]).map((a) => a.id))
  const projects = (raw.projects === undefined ? base.projects : normalizeProjects(raw.projects, projectsRoot)).map((p) => {
    const team = p.teamAgentIds.filter((id) => agentIds.has(id))
    if (team.length === p.teamAgentIds.length) return p
    changed = true
    return { ...p, teamAgentIds: team }
  })
  const projectIds = new Set(projects.map((p) => p.id))
  for (const agent of agents as Agent[]) {
    if (agent.projectId !== undefined && !projectIds.has(agent.projectId)) {
      delete agent.projectId
      changed = true
    }
  }

  return {
    data: {
      agents: agents as Agent[],
      runs,
      projects,
      projectMessages: normalizeProjectMessages(raw.projectMessages),
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

function read(path: string, projectsRoot: string): { data: Persisted; legacyKeys: Record<string, string>; changed: boolean } {
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as StoredShape
      const { data, changed } = reconcile(raw, projectsRoot)
      return { data, legacyKeys: raw.endpointKeys ?? {}, changed }
    } catch {
      // Corrupt or unreadable file falls back to a fresh seed below.
    }
  }
  return { data: seed(projectsRoot), legacyKeys: {}, changed: false }
}

export function createStore(path: string = DEFAULT_PATH): WorkspaceStore {
  const dir = dirname(path)
  const vault = createVault(join(dir, 'vault.enc'), join(dir, 'vault.key'))
  // Projects live under AGENTCONTROL_PROJECTS_DIR, defaulting beside the store.
  const projectsRoot = resolve(process.env.AGENTCONTROL_PROJECTS_DIR ?? join(dir, 'projects'))
  const { data, legacyKeys, changed } = read(path, projectsRoot)

  let endpointKeys = vault.load()
  let migrated = changed
  // One-time migration: move any plaintext keys into the encrypted vault.
  if (Object.keys(endpointKeys).length === 0 && Object.keys(legacyKeys).length > 0) {
    endpointKeys = { ...legacyKeys }
    migrated = true
  }

  const store: WorkspaceStore = {
    ...data,
    projectsRoot,
    endpointKeys,
    save() {
      const temporary = `${path}.${randomUUID()}.tmp`
      try {
        mkdirSync(dir, { recursive: true })
        const snapshot: Persisted = {
          agents: store.agents,
          runs: store.runs,
          projects: store.projects,
          projectMessages: store.projectMessages,
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
