import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  seedAgents,
  seedEndpointModels,
  seedEndpoints,
  seedRuns,
  seedSettings,
  CORE_DEFAULT_SKILLS,
  coreSkillId,
  seedSkills,
  vendoredSeedSkills,
} from './db/seed.js'
import { isVendoredSkillId, vendoredLibrary } from './db/vendored-skills.js'
import { createVault } from './vault.js'
import { ARCHIVE_MIGRATION, writeProjectArchive, type ProjectArchive } from './archive.js'
import { backfillAuthors, backfillErrorFlags, migrateRunsToConversations, normalizeChatMessages, normalizeConversations } from './conversations.js'
import { AGENT_SLUG, INTERNET_POLICIES, MAX_MEMORY_TEXT_CHARS, MEMORY_CATEGORIES, SKILL_SOURCE_IDS } from './shared/types.js'
import type {
  Agent,
  AgentRun,
  ChatMessage,
  Conversation,
  UserProfile,
  Endpoint,
  MemoryItem,
  Note,
  ProjectArchiveFile,
  Skill,
  WorkspaceSettings,
} from './shared/types.js'

export interface WorkspaceStore {
  agents: Agent[]
  /** All agent runs across the workspace; GET /runs filters + sorts. */
  runs: AgentRun[]
  /** The workspace user's profile (first-run setup). */
  profile: UserProfile
  /** Chat-first 1:1 conversations (one DM per agent). */
  conversations: Conversation[]
  /** Messages for every conversation; routes filter + sort. */
  chatMessages: ChatMessage[]
  skills: Skill[]
  endpoints: Endpoint[]
  /** endpoint id -> cached model ids (live GET /v1/models refreshes this). */
  endpointModels: Record<string, string[]>
  /** Secret vault: endpoint id -> bearer key. Never serialized to clients. */
  endpointKeys: Record<string, string>
  settings: WorkspaceSettings
  /** Shared workspace memory written by the notes tools. */
  notes: Note[]
  /** Agent and group memory (BE-4 fills it). */
  memories: MemoryItem[]
  /** Folder holding uploaded agent avatars (data/avatars beside the store). */
  avatarsDir: string
  /** The data folder holding store.json (bots/, archive/ and avatars/ live here). */
  dataDir: string
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
  /** Archive files written by chat-first-archive-v1, oldest first. */
  archive: ProjectArchiveFile[]
}

/** Every one-shot migration; fresh stores are born with all of them applied. */
export const VENDOR_SKILLS_MIGRATION = 'vendor-skills-v1'
const MIGRATIONS = ['seed-skill-tools-v1', 'seed-skill-upgrade-v2', 'seed-skill-upgrade-v3', ARCHIVE_MIGRATION, VENDOR_SKILLS_MIGRATION] as const

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
  profile: UserProfile
  conversations: Conversation[]
  chatMessages: ChatMessage[]
  skills: Skill[]
  endpoints: Endpoint[]
  endpointModels: Record<string, string[]>
  settings: WorkspaceSettings
  notes: Note[]
  memories: MemoryItem[]
  meta: StoreMeta
}

/** Agents from older installs may lack `role`, `isPrimary`, or have a null `endpointId`. */
type LegacyAgent = Omit<Agent, 'endpointId' | 'isPrimary' | 'role' | 'slug' | 'internetPolicy' | 'memoryLearn'> & {
  endpointId?: string | null
  isPrimary?: boolean
  role?: string
  recentRuns?: Partial<AgentRun>[]
  slug?: unknown
  internetPolicy?: unknown
  memoryLearn?: unknown
  /** Retired with Projects (BE-1); cleared once the archive is written. */
  projectId?: unknown
}

/**
 * Older workspaces stored `endpointKeys` in plaintext, runs on each agent, and
 * a seeded `models` catalog (dropped: model choice comes from endpointModels).
 */
type StoredShape = Partial<Persisted> & {
  endpointKeys?: Record<string, string>
  models?: unknown
  agents?: LegacyAgent[]
  /** Retired (BE-1): archived by chat-first-archive-v1. */
  projects?: unknown
  projectMessages?: unknown
}

/** Project data still waiting to be archived (the archive write failed or has not run). */
interface PendingArchive {
  projects: unknown[]
  projectMessages: unknown[]
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

const MAX_SLUG = 40

/** Slug base for a name: lowercase alphanumerics and dashes; empty names fall back to `bot`. */
function slugBase(name: string): string {
  return (
    name
      .normalize('NFKD')
      .replace(/\p{M}+/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, MAX_SLUG)
      .replace(/-+$/, '') || 'bot'
  )
}

/**
 * A unique agent slug ([a-z0-9-]{1,40}). The Primary agent gets `primary`
 * when it is free; `primary` is otherwise never handed out from a name, so a
 * bot named "Primary" becomes `primary-2`. Collisions get -2, -3, … (the base
 * is shortened so the suffix still fits). Adds the result to `taken`.
 */
export function assignAgentSlug(name: string, isPrimary: boolean, taken: Set<string>): string {
  if (isPrimary && !taken.has('primary')) {
    taken.add('primary')
    return 'primary'
  }
  const base = slugBase(name)
  let slug = base
  for (let n = 2; taken.has(slug) || slug === 'primary'; n++) {
    const suffix = `-${n}`
    slug = `${base.slice(0, MAX_SLUG - suffix.length).replace(/-+$/, '')}${suffix}`
  }
  taken.add(slug)
  return slug
}

function seed(): Persisted {
  const data = seedData()
  const state = { agents: data.agents, runs: data.runs, conversations: data.conversations, chatMessages: data.chatMessages }
  migrateRunsToConversations(state, data.meta.migrations)
  return { ...data, conversations: state.conversations, chatMessages: state.chatMessages }
}

/** Core seeds plus every vendored skill (bodies loaded from skills-vendor/). */
function librarySkills(): Skill[] {
  return [...structuredClone(seedSkills), ...structuredClone(vendoredLibrary().skills)]
}

/**
 * Fills in the BE-6 skill fields on a stored skill. Core and vendored ids
 * carry their source; anything else is a user skill (`custom`).
 */
function normalizeSkillSource(skill: Skill): { skill: Skill; changed: boolean } {
  const prefix = skill.id.includes('/') ? skill.id.slice(0, skill.id.indexOf('/')) : ''
  const sourceId = (SKILL_SOURCE_IDS as readonly string[]).includes(prefix) && prefix !== 'custom' ? (prefix as Skill['sourceId']) : 'custom'
  const next = { ...skill }
  let changed = false
  if (next.sourceId !== sourceId) { next.sourceId = sourceId; changed = true }
  if (typeof next.hasScripts !== 'boolean') { next.hasScripts = false; changed = true }
  if (!Array.isArray(next.files) || !next.files.every((f) => typeof f === 'string')) { next.files = []; changed = true }
  if (typeof next.defaultOn !== 'boolean') {
    next.defaultOn = sourceId === 'core' && CORE_DEFAULT_SKILLS.includes(skill.id.slice('core/'.length))
    changed = true
  }
  return { skill: next, changed }
}

function seedData(): Persisted {
  const skills = librarySkills()
  return {
    profile: { name: '', onboardedAt: null },
    conversations: [],
    chatMessages: [],
    agents: structuredClone(seedAgents),
    runs: structuredClone(seedRuns),
    skills,
    endpoints: structuredClone(seedEndpoints),
    endpointModels: structuredClone(seedEndpointModels),
    settings: structuredClone(seedSettings),
    notes: [],
    memories: [],
    meta: { migrations: [...MIGRATIONS], seededSkillIds: skills.map((s) => s.id), archive: [] },
  }
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')

function normalizeMeta(raw: unknown): StoreMeta | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as Partial<StoreMeta>
  return {
    migrations: isStringArray(m.migrations) ? [...m.migrations] : [],
    seededSkillIds: isStringArray(m.seededSkillIds) ? [...m.seededSkillIds] : [],
    archive: Array.isArray(m.archive)
      ? (m.archive as Partial<ProjectArchiveFile>[]).flatMap((f) =>
          f && typeof f.name === 'string' && typeof f.createdAt === 'string' && typeof f.projectCount === 'number'
            ? [{ name: f.name, createdAt: f.createdAt, projectCount: f.projectCount }]
            : [],
        )
      : [],
  }
}

/** Keep well-formed memory items only (BE-4 writes them). */
function normalizeMemories(raw: unknown): MemoryItem[] {
  if (!Array.isArray(raw)) return []
  const out: MemoryItem[] = []
  for (const item of raw as Partial<MemoryItem>[]) {
    if (!item || typeof item.id !== 'string' || typeof item.text !== 'string') continue
    if (!item.text || item.text.length > MAX_MEMORY_TEXT_CHARS) continue
    const scope = item.scope as Record<string, unknown> | undefined
    const validScope =
      (scope?.kind === 'agent' && typeof scope.agentId === 'string') ||
      (scope?.kind === 'group' && typeof scope.groupId === 'string')
    if (!validScope || !MEMORY_CATEGORIES.includes(item.category as MemoryItem['category'])) continue
    const source = item.source as Record<string, unknown> | undefined
    const validSource =
      source?.kind === 'user' ||
      (source?.kind === 'chat' &&
        typeof source.conversationId === 'string' &&
        typeof source.runId === 'string' &&
        typeof source.agentId === 'string')
    if (!validSource || typeof item.createdAt !== 'string') continue
    out.push({
      id: item.id,
      scope: structuredClone(item.scope!),
      text: item.text,
      category: item.category!,
      source: structuredClone(item.source!),
      createdAt: item.createdAt,
      updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : item.createdAt,
    })
  }
  return out
}

function normalizeProfile(raw: unknown): UserProfile {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Partial<UserProfile>
  const out: UserProfile = {
    name: typeof p.name === 'string' ? p.name : '',
    onboardedAt: typeof p.onboardedAt === 'string' ? p.onboardedAt : null,
  }
  const a = p.avatar as Record<string, unknown> | undefined
  if (a?.kind === 'emoji' && typeof a.value === 'string') out.avatar = { kind: 'emoji', value: a.value }
  else if (a?.kind === 'image' && typeof a.file === 'string' && typeof a.updatedAt === 'string') {
    out.avatar = { kind: 'image', file: a.file, updatedAt: a.updatedAt }
  }
  return out
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
    ...(Array.isArray(r.activatedSkills) && r.activatedSkills.length > 0 ? { activatedSkills: r.activatedSkills } : {}),
    ...(typeof r.projectId === 'string' ? { projectId: r.projectId } : {}),
  }
}

/** Backfill fields added after a workspace was first written. */
function reconcile(raw: StoredShape): { data: Persisted; pending: PendingArchive | null; changed: boolean } {
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
  const meta: StoreMeta = storedMeta ?? { migrations: [], seededSkillIds: [], archive: [] }

  // One-shot: vendored seed skills the user never edited (same content, no
  // tools) gain the tools they now ship with. Runs once, so tools a user
  // later clears stay cleared.
  if (!meta.migrations.includes('seed-skill-tools-v1')) {
    for (let i = 0; i < savedSkills.length; i++) {
      const saved = savedSkills[i] as Skill
      // Stores this old still use bare seed ids; vendor-skills-v1 renames them below.
      const seed = vendoredSeedSkills.find((v) => v.id === saved.id || v.id === coreSkillId(saved.id))
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
      const i = savedSkills.findIndex((s) => s.id === upgrade.id || s.id === coreSkillId(upgrade.id))
      const seed = base.skills.find((s) => s.id === coreSkillId(upgrade.id))
      const saved = savedSkills[i]
      if (saved && seed && isUntouchedSeed(saved, upgrade)) {
        savedSkills[i] = { ...saved, description: seed.description, content: seed.content, tools: structuredClone(seed.tools) }
      }
    }
    meta.migrations.push(migration)
    changed = true
  }

  // vendor-skills-v1: core seeds move to `core/<name>` ids (a same-named user
  // skill, which has no seed source, keeps its id), every agent's skillIds
  // and the offered-seed list follow, and vendored skills are offered below
  // like any never-offered seed.
  if (!meta.migrations.includes(VENDOR_SKILLS_MIGRATION)) {
    const renamed = new Map<string, string>()
    for (let i = 0; i < savedSkills.length; i++) {
      const saved = savedSkills[i] as Skill
      if (saved.id.includes('/')) continue
      const seed = seedSkills.find((s) => s.id === coreSkillId(saved.id))
      if (seed && saved.source === seed.source && !savedSkills.some((s) => s.id === seed.id)) {
        renamed.set(saved.id, seed.id)
        savedSkills[i] = { ...saved, id: seed.id }
      }
    }
    for (const agent of agents as Agent[]) {
      if (Array.isArray(agent.skillIds) && agent.skillIds.some((id) => renamed.has(id))) {
        agent.skillIds = [...new Set(agent.skillIds.map((id) => renamed.get(id) ?? id))]
      }
    }
    meta.seededSkillIds = [...new Set(meta.seededSkillIds.map((id) =>
      !id.includes('/') && seedSkills.some((s) => s.id === coreSkillId(id)) ? coreSkillId(id) : id,
    ))]
    meta.migrations.push(VENDOR_SKILLS_MIGRATION)
    changed = true
  }

  // BE-6 fields on every stored skill; vendored skills are read-only, so
  // their stored metadata is refreshed from disk along with the body.
  const library = vendoredLibrary()
  for (let i = 0; i < savedSkills.length; i++) {
    const normalized = normalizeSkillSource(savedSkills[i] as Skill)
    if (normalized.changed) changed = true
    const disk = isVendoredSkillId(normalized.skill.id) ? library.skills.find((s) => s.id === normalized.skill.id) : undefined
    savedSkills[i] = disk ? structuredClone(disk) : normalized.skill
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

  const agentIds = new Set((agents as Agent[]).map((a) => a.id))

  // Chat-first schema: every agent has an immutable slug (Primary first, so
  // it gets `primary`), an internet policy and the "learn from chat" flag.
  const taken = new Set<string>()
  for (const agent of agents) {
    if (typeof agent.slug === 'string' && AGENT_SLUG.test(agent.slug) && !taken.has(agent.slug)) taken.add(agent.slug)
    else delete agent.slug
  }
  for (const agent of [...agents].sort((a, b) => Number(b.isPrimary === true) - Number(a.isPrimary === true))) {
    if (agent.slug === undefined) {
      agent.slug = assignAgentSlug(agent.name ?? '', agent.isPrimary === true, taken)
      changed = true
    }
  }
  for (const agent of agents) {
    // No run survives a restart, so a saved 'running' would show typing forever.
    if (agent.status === 'running') {
      agent.status = 'idle'
      changed = true
    }
    if (!INTERNET_POLICIES.includes(agent.internetPolicy as Agent['internetPolicy'])) {
      agent.internetPolicy = 'ask'
      changed = true
    }
    if (typeof agent.memoryLearn !== 'boolean') {
      agent.memoryLearn = true
      changed = true
    }
  }

  // Projects were retired. Until chat-first-archive-v1 has written them to
  // the archive they are held aside, exactly as stored, and never served.
  let pending: PendingArchive | null = null
  if (!meta.migrations.includes(ARCHIVE_MIGRATION)) {
    pending = {
      projects: Array.isArray(raw.projects) ? raw.projects : [],
      projectMessages: Array.isArray(raw.projectMessages) ? raw.projectMessages : [],
    }
  } else if (raw.projects !== undefined || raw.projectMessages !== undefined) {
    changed = true
  }

  const conversations = normalizeConversations(raw.conversations, agentIds)
  const chatMessages = normalizeChatMessages(raw.chatMessages, new Set(conversations.map((c) => c.id)))
  const conversationState = { agents: agents as Agent[], runs, conversations, chatMessages }
  if (migrateRunsToConversations(conversationState, meta.migrations)) changed = true
  if (backfillErrorFlags(conversationState)) changed = true
  if (backfillAuthors(conversationState)) changed = true

  return {
    data: {
      agents: agents as Agent[],
      runs,
      profile: normalizeProfile(raw.profile),
      conversations: conversationState.conversations,
      chatMessages: conversationState.chatMessages,
      skills: missingSkills.length > 0 ? [...savedSkills, ...missingSkills] : savedSkills,
      endpoints,
      endpointModels: raw.endpointModels ?? base.endpointModels,
      settings: raw.settings ?? base.settings,
      notes,
      memories: normalizeMemories(raw.memories),
      meta,
    },
    pending,
    changed,
  }
}

interface Loaded {
  data: Persisted
  pending: PendingArchive | null
  legacyKeys: Record<string, string>
  changed: boolean
}

function read(path: string): Loaded {
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as StoredShape
      const { data, pending, changed } = reconcile(raw)
      return { data, pending, legacyKeys: raw.endpointKeys ?? {}, changed }
    } catch {
      // Corrupt or unreadable file falls back to a fresh seed below.
    }
  }
  return { data: seed(), pending: null, legacyKeys: {}, changed: false }
}

/**
 * chat-first-archive-v1. Writes the archive (when there is any project data),
 * then, only after it is on disk, clears agents' project tags and marks the
 * migration. Returns false when the write failed: nothing was changed.
 */
function archiveProjects(dir: string, data: Persisted, pending: PendingArchive, now: Date): boolean {
  const hasData = pending.projects.length > 0 || pending.projectMessages.length > 0
  if (hasData) {
    const archive: ProjectArchive = {
      version: 1,
      createdAt: now.toISOString(),
      projects: pending.projects,
      projectMessages: pending.projectMessages,
      projectRuns: data.runs.filter((r) => r.projectId !== undefined),
      notes: data.notes,
      folders: pending.projects.flatMap((p) => {
        const folder = (p as { folder?: unknown } | null)?.folder
        return typeof folder === 'string' && folder ? [folder] : []
      }),
    }
    try {
      data.meta.archive.push(writeProjectArchive(dir, archive, now))
    } catch (err) {
      console.error(`[store] ${ARCHIVE_MIGRATION} aborted, store left unchanged: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }
  for (const agent of data.agents as (Agent & { projectId?: unknown })[]) delete agent.projectId
  data.meta.migrations.push(ARCHIVE_MIGRATION)
  return true
}

export function createStore(path: string = DEFAULT_PATH): WorkspaceStore {
  const dir = dirname(path)
  const vault = createVault(join(dir, 'vault.enc'), join(dir, 'vault.key'))
  const { data, pending: loadedPending, legacyKeys, changed } = read(path)

  let endpointKeys = vault.load()
  let migrated = changed
  // Project data held aside until it is archived; saves keep writing it back
  // so a failed archive loses nothing and is retried on the next boot.
  let pending = loadedPending
  let archiveFailed = false
  if (pending) {
    if (archiveProjects(dir, data, pending, new Date())) {
      pending = null
      migrated = true
    } else {
      archiveFailed = true
    }
  }
  // One-time migration: move any plaintext keys into the encrypted vault.
  if (Object.keys(endpointKeys).length === 0 && Object.keys(legacyKeys).length > 0) {
    endpointKeys = { ...legacyKeys }
    migrated = true
  }

  const store: WorkspaceStore = {
    ...data,
    avatarsDir: join(dir, 'avatars'),
    dataDir: dir,
    endpointKeys,
    save() {
      const temporary = `${path}.${randomUUID()}.tmp`
      try {
        mkdirSync(dir, { recursive: true })
        const snapshot: Persisted & Partial<PendingArchive> = {
          agents: store.agents,
          runs: store.runs,
          ...(pending ? { projects: pending.projects, projectMessages: pending.projectMessages } : {}),
          profile: store.profile,
          conversations: store.conversations,
          chatMessages: store.chatMessages,
          // Vendored bodies live in skills-vendor/; store.json keeps their metadata only.
          skills: store.skills.map((s) => (isVendoredSkillId(s.id) ? { ...s, content: '' } : s)),
          endpoints: store.endpoints,
          endpointModels: store.endpointModels,
          settings: store.settings,
          notes: store.notes,
          memories: store.memories,
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

  // Rewrite store.json without secrets now that the vault holds them. A
  // failed archive leaves store.json exactly as it was until the next boot.
  if (migrated && !archiveFailed) store.save()

  return store
}
