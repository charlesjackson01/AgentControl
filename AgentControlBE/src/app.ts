import { defaultAgentVm } from './vm-defaults.js'
import { parseSearchQuery, search } from './search.js'
import cors from '@fastify/cors'
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assignAgentSlug, createStore, type WorkspaceStore } from './store.js'
import { NOTES_RETIRED, PROJECTS_RETIRED } from './archive.js'
import { addMemory, deleteMemory, listMemory, memoryPromptBlock, parseCategory, parseText, sameScope, updateMemory, type MemoryQuery, type MemoryScope } from './memory.js'
import { SkillMarkdownError, parseSkillMarkdown } from './db/skill-md.js'
import { fetchModels, PROXY_PROTOCOLS, redactUrlCredentials } from './upstream.js'
import { listToolInfo, resolveToolDeclarations } from './tools.js'
import { agentInstructions, attachedSkills, estimateTokens, planPrompt, replyReserve } from './prompt.js'
import { fail, uid } from './http.js'
import { archiveBotFolder, ensureAllBotFolders, ensureBotFolder, listFolder, listShared, makeFolder, MAX_UPLOAD_BYTES, movePath, readContent, trashPath, writeContent, type FileContent } from './files.js'
import { listGroupFolder, listGroupShared, makeGroupFolder, moveGroupPath, readGroupContent, trashGroupPath, writeGroupContent } from './group-files.js'
import { attachmentPrompt, resolveAttachments, uploadAttachment } from './attachments.js'
import { archiveGroup, createGroup, groupOr404, postGroupMessage, removeAgentFromGroups, updateGroup } from './groups.js'
import { runAgent, RUNS_PER_SCOPE } from './runs.js'
import { registerSandboxRoutes } from './sandbox.js'
import { createVmHostService, type VmHostService } from './vm-host.js'
import { FILE_TOOL_NAMES } from './tools/files.js'
import { clearAgentConversations, dmOf, ensureDm, messagesOf, summarize, syncGroupLeads } from './conversations.js'
import {
  CONVERSATION_PAGE_SIZE,
  MAX_CONVERSATION_PAGE_SIZE,
  MAX_USER_NAME_CHARS,
  DEFAULT_ENDPOINT_BASE_URL,
  MAX_AGENT_RULE_CHARS,
  MAX_AGENT_RULES,
  MAX_AVATAR_BYTES,
  OPENROUTER_DEFAULT_BASE_URL,
  type Agent,
  type AgentInput,
  type UserProfile,
  type Conversation,
  type Endpoint,
  type EndpointInput,
  type EndpointKind,
  type PromptBudget,
  INTERNET_POLICIES,
  type InternetPolicy,
  type Skill,
  type SkillInput,
  type SkillListResponse,
  type SkillSourceId,
  type SkillSourceInfo,
  type SkillTool,
  SKILL_SOURCE_IDS,
  type WorkspaceSettings,
} from './shared/types.js'
import { isVendoredSkillId, vendoredLibrary } from './db/vendored-skills.js'

/** BE-6 fields for a skill the user creates or imports. */
const CUSTOM_SKILL_FIELDS = { sourceId: 'custom', hasScripts: false, files: [] as string[], defaultOn: false } as const
const VENDORED_READ_ONLY = 'Vendored skills are read-only.'

function trimBase(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '')
}

function resolveBaseUrl(kind: EndpointKind, baseUrl: string): string {
  const trimmed = baseUrl.trim()
  if (!trimmed && kind === 'openrouter') return OPENROUTER_DEFAULT_BASE_URL
  return trimBase(trimmed)
}

/**
 * maxOutputTokens for a create/update: omitted keeps `current`, null clears.
 * Must be an integer with 0 < n < contextWindow (re-checked when only the
 * window changes, so a shrunk window cannot strand an oversized budget).
 */
function resolveMaxOutputTokens(raw: unknown, current: number | undefined, contextWindow: number): number | undefined {
  const value = raw === undefined ? current : raw === null ? undefined : raw
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value >= contextWindow) {
    fail(400, `"maxOutputTokens" must be a whole number above 0 and below the context window (${contextWindow}), or null for the default.`)
  }
  return value as number
}

function assertEndpointInput(input: EndpointInput, storedKey: string): void {
  if (input.kind !== 'openai-compatible' && input.kind !== 'openrouter') {
    fail(400, 'Endpoint kind must be "openai-compatible" or "openrouter".')
  }
  if (!input.name.trim()) fail(400, 'Give the endpoint a name.')
  const baseUrl = resolveBaseUrl(input.kind, input.baseUrl)
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    fail(400, `Base URL must be a valid http(s) URL, e.g. ${DEFAULT_ENDPOINT_BASE_URL}.`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    fail(400, 'Base URL must start with http:// or https://.')
  }
  if (!input.defaultModel.trim()) {
    fail(400, 'Set the default model id as reported by GET /v1/models.')
  }
  if (!Number.isFinite(input.contextWindow) || input.contextWindow <= 0) {
    fail(400, 'Context window must be a positive number of tokens.')
  }
  const effectiveKey = input.apiKey !== undefined ? input.apiKey : storedKey
  if (input.kind === 'openrouter' && !effectiveKey) {
    fail(400, 'OpenRouter endpoints require an API key.')
  }
  if (input.timeoutMs !== undefined && (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0)) {
    fail(400, 'Timeout must be a positive number of milliseconds.')
  }
  if (input.proxyUrl !== undefined && input.proxyUrl !== null && input.proxyUrl !== '') {
    let proxy: URL
    try {
      proxy = new URL(String(input.proxyUrl))
    } catch {
      fail(400, 'Proxy must be a valid URL, e.g. socks5://localhost:1055 or http://localhost:8080.')
    }
    if (!(PROXY_PROTOCOLS as readonly string[]).includes(proxy.protocol)) {
      fail(400, 'Proxy must start with http://, https://, socks5:// or socks5h://.')
    }
    if (!proxy.hostname) fail(400, 'Proxy needs a host, e.g. socks5h://localhost:1055.')
  }
}

/** Shown in place of a proxy password; sending it back keeps the stored one. */
export const PROXY_PASSWORD_MASK = '***'

/** The proxy URL with its password replaced by the mask (BE-11). */
export function maskProxyUrl(proxyUrl: string): string {
  try {
    const url = new URL(proxyUrl)
    if (!url.password) return proxyUrl
    url.password = PROXY_PASSWORD_MASK
    return url.toString().replace(/\/+$/, '')
  } catch {
    return proxyUrl
  }
}

/** An endpoint as the API returns it: key flag set, proxy password masked. */
function publicEndpoint(store: WorkspaceStore, endpoint: Endpoint): Endpoint {
  return {
    ...endpoint,
    apiKeySet: Boolean(store.endpointKeys[endpoint.id]),
    ...(endpoint.proxyUrl ? { proxyUrl: maskProxyUrl(endpoint.proxyUrl) } : {}),
  }
}

/** Stored proxy after a create/update: undefined means none. */
function resolveProxy(raw: unknown, current: string | undefined): string | undefined {
  if (raw === undefined) return current
  if (raw === null || raw === '') return undefined
  const next = String(raw).trim().replace(/\/+$/, '')
  // The client sent the masked URL back: keep the stored password, but only
  // for the same scheme, host, port and user, so the credential never goes to
  // a proxy it wasn't saved for.
  try {
    const url = new URL(next)
    if (url.password === PROXY_PASSWORD_MASK) {
      if (!current) fail(400, 'Send the proxy password itself, not the mask.')
      const saved = new URL(current)
      if (saved.protocol !== url.protocol || saved.hostname !== url.hostname || saved.port !== url.port ||
        saved.username !== url.username || !saved.password) {
        fail(400, 'Re-enter the proxy password for the new host')
      }
      url.password = saved.password
      return url.toString().replace(/\/+$/, '')
    }
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode) throw err
  }
  return next
}

function parseAgentInput(store: WorkspaceStore, body: unknown, opts: { checkModel?: boolean } = {}): AgentInput {
  const raw = (body ?? {}) as Record<string, unknown>
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (!name) fail(400, 'Give the agent a name.')

  const endpointId = typeof raw.endpointId === 'string' && raw.endpointId !== '' ? raw.endpointId : ''
  if (!endpointId) fail(400, 'Every agent needs an endpoint. Pick one before saving.')

  const endpoint = store.endpoints.find((e) => e.id === endpointId)
  if (!endpoint) fail(400, `No endpoint with id "${endpointId}". Pick an existing endpoint.`)

  const modelId = typeof raw.modelId === 'string' ? raw.modelId.trim() : ''
  if (!modelId) fail(400, 'Pick a model to run this agent on.')
  const served = store.endpointModels[endpoint.id] ?? []
  if (opts.checkModel !== false && served.length > 0 && !served.includes(modelId) && modelId !== endpoint.defaultModel) {
    fail(400, `Model "${modelId}" is not served by this endpoint.`)
  }

  const skillIds = Array.isArray(raw.skillIds)
    ? raw.skillIds.filter((s): s is string => typeof s === 'string')
    : []

  let temperature: number | null | undefined
  if (raw.temperature === null) {
    temperature = null
  } else if (raw.temperature !== undefined) {
    const t = raw.temperature
    if (typeof t !== 'number' || !Number.isFinite(t) || t < 0 || t > 2) {
      fail(400, 'Temperature must be a number between 0 and 2.')
    }
    temperature = t
  }

  return {
    ...parseProfileFields(raw),
    name,
    description: typeof raw.description === 'string' ? raw.description.trim() : '',
    instructions: typeof raw.instructions === 'string' ? raw.instructions.trim() : '',
    modelId,
    endpointId,
    isPrimary: raw.isPrimary === true,
    role: typeof raw.role === 'string' ? raw.role.trim() : '',
    ...(temperature !== undefined ? { temperature } : {}),
    skillIds,
  }
}

const PATCH_STRING_FIELDS = ['name', 'description', 'instructions', 'modelId', 'endpointId', 'role'] as const

/**
 * PATCH is strict about types: PUT's parser coerces a wrong-typed field to its
 * empty value (kept for existing PUT clients), which on a partial update would
 * silently wipe it. Values are still validated by parseAgentInput afterwards.
 */
function checkPatchTypes(patch: Record<string, unknown>): void {
  for (const key of PATCH_STRING_FIELDS) {
    if (key in patch && typeof patch[key] !== 'string') fail(400, `"${key}" must be a string.`)
  }
  if ('skillIds' in patch && (!Array.isArray(patch.skillIds) || !patch.skillIds.every((s) => typeof s === 'string'))) {
    fail(400, '"skillIds" must be a list of skill id strings.')
  }
  if ('isPrimary' in patch && typeof patch.isPrimary !== 'boolean') fail(400, '"isPrimary" must be true or false.')
  if ('temperature' in patch && patch.temperature !== null && typeof patch.temperature !== 'number') {
    fail(400, 'Temperature must be a number between 0 and 2.')
  }
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/
const MAX_EMOJI_CHARS = 16

/** Optional chat-first profile fields. Omitted keys stay omitted (PUT keeps the stored value). */
function parseProfileFields(raw: Record<string, unknown>): Partial<AgentInput> {
  const out: Partial<AgentInput> = {}
  if (raw.rules !== undefined) {
    if (!Array.isArray(raw.rules) || !raw.rules.every((r): r is string => typeof r === 'string')) {
      fail(400, '"rules" must be a list of strings.')
    }
    const rules = raw.rules.map((r) => r.trim()).filter(Boolean)
    if (rules.length > MAX_AGENT_RULES) fail(400, `An agent can have at most ${MAX_AGENT_RULES} rules.`)
    if (rules.some((r) => r.length > MAX_AGENT_RULE_CHARS)) {
      fail(400, `Each rule can be at most ${MAX_AGENT_RULE_CHARS} characters.`)
    }
    out.rules = rules
  }
  if (raw.color !== undefined) {
    if (raw.color !== null && (typeof raw.color !== 'string' || !HEX_COLOR.test(raw.color))) {
      fail(400, '"color" must look like #rrggbb, or be null to clear it.')
    }
    out.color = raw.color === null ? null : (raw.color as string).toLowerCase()
  }
  for (const key of ['pinned', 'hidden', 'memoryLearn'] as const) {
    if (raw[key] === undefined) continue
    if (typeof raw[key] !== 'boolean') fail(400, `"${key}" must be true or false.`)
    out[key] = raw[key] as boolean
  }
  if (raw.internetPolicy !== undefined) {
    if (!INTERNET_POLICIES.includes(raw.internetPolicy as InternetPolicy)) {
      fail(400, '"internetPolicy" must be "ask", "always" or "never".')
    }
    out.internetPolicy = raw.internetPolicy as InternetPolicy
  }
  if (raw.avatar !== undefined) {
    if (raw.avatar === null) {
      out.avatar = null
    } else {
      const a = raw.avatar as Record<string, unknown>
      const value = typeof a?.value === 'string' ? a.value.trim() : ''
      if (a?.kind !== 'emoji' || !value || value.length > MAX_EMOJI_CHARS || /[\s<>]/.test(value)) {
        fail(400, '"avatar" must be { kind: "emoji", value: "<one emoji>" } or null. Upload images with PUT /api/agents/:id/avatar.')
      }
      out.avatar = { kind: 'emoji', value }
    }
  }
  return out
}

/** Apply an AgentInput onto an agent: null clears color/avatar, omitted keeps them. */
/** GET/PATCH /api/settings: the Phase 1 fields only (VM settings live at /api/vm/settings). */
function publicSettings(s: WorkspaceSettings): WorkspaceSettings {
  return { autoRun: s.autoRun, notify: s.notify, telemetry: s.telemetry }
}

function mergeAgent(current: Agent, input: AgentInput): Agent {
  const { color, avatar, temperature, ...rest } = input
  const next: Agent = { ...current, ...rest }
  if (temperature === null) delete next.temperature
  else if (temperature !== undefined) next.temperature = temperature
  if (color === null) delete next.color
  else if (color !== undefined) next.color = color
  if (avatar === null) delete next.avatar
  else if (avatar !== undefined) next.avatar = avatar
  return next
}

const AVATAR_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

/** Resolve an avatar file inside avatarsDir; null for anything that escapes it. */
function avatarPath(store: WorkspaceStore, file: string): string | null {
  if (!/^[A-Za-z0-9_-]+\.(png|jpg|webp|gif)$/.test(file)) return null
  return join(store.avatarsDir, file)
}

function removeAvatarFile(store: WorkspaceStore, agent: Agent): void {
  if (agent.avatar?.kind !== 'image') return
  const path = avatarPath(store, agent.avatar.file)
  if (path) rmSync(path, { force: true })
}

function removeProfileAvatarFile(store: WorkspaceStore): void {
  const avatar = store.profile.avatar
  if (avatar?.kind !== 'image') return
  const path = avatarPath(store, avatar.file)
  if (path) rmSync(path, { force: true })
}

function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

const MAX_SKILL_TOOLS = 16
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/
/** Every defaultOn skill id, in library order (core first). */
export function defaultSkillIds(skills: readonly Skill[]): string[] {
  return [...new Set(skills.filter((s) => s.defaultOn === true).map((s) => s.id))]
}

/** POST /api/prompt-budget plans at most this many attached skill ids. */
const MAX_BUDGET_SKILL_IDS = 500

function parseSkillTools(raw: unknown): SkillTool[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) fail(400, '"tools" must be an array of tool declarations.')
  if (raw.length > MAX_SKILL_TOOLS) fail(400, `A skill can declare at most ${MAX_SKILL_TOOLS} tools.`)
  return raw.map((entry, i) => {
    const tool = (entry ?? {}) as Record<string, unknown>
    const name = typeof tool.name === 'string' ? tool.name.trim() : ''
    const description = typeof tool.description === 'string' ? tool.description.trim() : ''
    if (!name || !description) {
      fail(400, `Each tool needs a "name" and a "description" (tool #${i + 1}).`)
    }
    if (!TOOL_NAME.test(name)) fail(400, `Tool names use letters, digits, "_" or "-" (max 64): "${name.slice(0, 64)}".`)
    if (description.length > 1024) fail(400, `Tool "${name}" description is over 1,024 chars.`)
    const parameters =
      typeof tool.parameters === 'object' && tool.parameters !== null ? tool.parameters : {}
    if (JSON.stringify(parameters).length > 8192) fail(400, `Tool "${name}" parameters schema is over 8 KB.`)
    return { name, description, parameters }
  })
}

/** Create: name and content are required; description/tag default to "". */
function parseSkillInput(body: unknown): SkillInput {
  const raw = (body ?? {}) as Record<string, unknown>
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (!name) fail(400, 'Give the skill a name.')
  const content = typeof raw.content === 'string' ? raw.content.trim() : ''
  if (!content) fail(400, 'Skills need "content" — the instructions injected into the run prompt.')
  const tools = parseSkillTools(raw.tools)
  return {
    name,
    description: typeof raw.description === 'string' ? raw.description.trim() : '',
    tag: typeof raw.tag === 'string' ? raw.tag.trim() : '',
    content,
    ...(tools ? { tools } : {}),
    ...(typeof raw.source === 'string' && raw.source.trim() ? { source: raw.source.trim() } : {}),
  }
}

export interface BuildAppOptions {
  /** BE-P2-2: engine/machine service; tests inject one with a fake CommandRunner. */
  vmHost?: VmHostService
}

export function buildApp(store: WorkspaceStore = createStore(), opts: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' })

  // Reflect the request origin so the app works from localhost, LAN, and
  // Tailscale alike. Set CORS_ORIGINS (comma-separated) to pin an allowlist.
  const corsOrigins = process.env.CORS_ORIGINS
  app.register(cors, {
    origin: corsOrigins
      ? corsOrigins.split(',').map((o) => o.trim()).filter(Boolean)
      : true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  })

  // Clients (including our own FE) send `Content-Type: application/json` even on
  // bodyless requests like POST /test or DELETE. Treat an empty body as absent
  // instead of Fastify's default 400.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    const text = (body as string).trim()
    if (text === '') return done(null, undefined)
    try {
      done(null, JSON.parse(text))
    } catch {
      const err = new SyntaxError('Request body is not valid JSON.') as SyntaxError & { statusCode?: number }
      err.statusCode = 400
      done(err, undefined)
    }
  })

  app.setErrorHandler((error, _request, reply) => {
    const err = error as Error & { statusCode?: number }
    const status = typeof err.statusCode === 'number' ? err.statusCode : 500
    const message = redactUrlCredentials(err.message ?? '')
    if (status >= 500) app.log.error({ err: { message, stack: redactUrlCredentials(err.stack ?? '') } }, message)
    void reply.status(status).send({
      statusCode: status,
      error: status >= 500 ? 'Internal Server Error' : 'Request Error',
      message,
    })
  })

  // Optional gate: when AGENTCONTROL_AUTH_TOKEN is set, every /api/* call must
  // present `Authorization: Bearer <token>`. Off by default (no token -> open).
  const authToken = process.env.AGENTCONTROL_AUTH_TOKEN
  if (authToken) {
    app.addHook('onRequest', async (request, reply) => {
      if (!request.url.startsWith('/api/')) return
      if (request.headers.authorization === `Bearer ${authToken}`) return
      await reply
        .code(401)
        .send({ statusCode: 401, error: 'Unauthorized', message: 'Missing or invalid bearer token.' })
    })
  }

  app.get('/health', async () => ({ status: 'ok' }))
  // BE-6: summaries (no bodies) with optional filters, plus one entry per source.
  app.get('/api/skills', async (request): Promise<SkillListResponse> => {
    const query = (request.query ?? {}) as { source?: unknown; q?: unknown; defaultOn?: unknown }
    let source: SkillSourceId | undefined
    if (query.source !== undefined && query.source !== '') {
      if (typeof query.source !== 'string' || !(SKILL_SOURCE_IDS as readonly string[]).includes(query.source)) {
        fail(400, `"source" must be one of: ${SKILL_SOURCE_IDS.join(', ')}.`)
      }
      source = query.source as SkillSourceId
    }
    let defaultOn: boolean | undefined
    if (query.defaultOn !== undefined && query.defaultOn !== '') {
      if (query.defaultOn !== 'true' && query.defaultOn !== 'false') fail(400, '"defaultOn" must be true or false.')
      defaultOn = query.defaultOn === 'true'
    }
    const q = typeof query.q === 'string' ? query.q.trim().toLowerCase() : ''
    const skills = store.skills
      .filter((s) => source === undefined || s.sourceId === source)
      .filter((s) => defaultOn === undefined || s.defaultOn === defaultOn)
      .filter((s) => !q || [s.id, s.name, s.description, s.tag].some((v) => v.toLowerCase().includes(q)))
      .map(({ content: _content, ...summary }) => summary)
    const vendored = vendoredLibrary().sources
    const count = (id: SkillSourceId): number => store.skills.filter((s) => s.sourceId === id).length
    const sources: SkillSourceInfo[] = [
      { id: 'core', repo: null, commit: null, license: null, count: count('core') },
      ...vendored.map((v) => ({ ...v, count: count(v.id) })),
      { id: 'custom', repo: null, commit: null, license: null, count: count('custom') },
    ]
    return { skills, sources }
  })
  app.get('/api/tools', async () => listToolInfo())

  // Notes were folded into memory (BE-4, migration notes-to-memory-v1).
  for (const url of ['/api/notes', '/api/notes/*']) {
    app.all(url, async (_request, reply) =>
      reply.status(410).send({ statusCode: 410, error: 'Request Error', message: NOTES_RETIRED }))
  }

  // BE-4 memory, under /api/agents/:id (a bot's) and /api/groups/:id (BE-5, a group's).
  const agentScope = (id: string): MemoryScope => {
    if (!store.agents.some((a) => a.id === id)) fail(404, `No agent with id "${id}"`)
    return { kind: 'agent', agentId: id }
  }
  const groupScope = (id: string): MemoryScope => ({ kind: 'group', groupId: groupOr404(store, id).id })
  for (const [base, scopeOf] of [['/api/agents', agentScope], ['/api/groups', groupScope]] as const) {
    app.get(`${base}/:id/memory`, async (request) => {
      const { id } = request.params as { id: string }
      return listMemory(store, scopeOf(id), request.query as MemoryQuery)
    })
    app.post(`${base}/:id/memory`, async (request, reply) => {
      const { id } = request.params as { id: string }
      const scope = scopeOf(id)
      const raw = (request.body ?? {}) as Record<string, unknown>
      if (typeof raw !== 'object' || Array.isArray(raw)) fail(400, 'Send { text, category }.')
      const text = parseText(raw.text, true)!
      const category = parseCategory(raw.category, 'other')!
      return reply.status(201).send(addMemory(store, scope, text, category, { kind: 'user' }))
    })
    app.patch(`${base}/:id/memory/:memoryId`, async (request) => {
      const { id, memoryId } = request.params as { id: string; memoryId: string }
      return updateMemory(store, scopeOf(id), memoryId, request.body)
    })
    app.delete(`${base}/:id/memory/:memoryId`, async (request, reply) => {
      const { id, memoryId } = request.params as { id: string; memoryId: string }
      deleteMemory(store, scopeOf(id), memoryId)
      return reply.status(204).send()
    })
  }
  // Projects were retired (BE-1): every old route answers 410. The data is in
  // data/archive/projects-*.json; this lists those files (names only).
  for (const url of ['/api/projects', '/api/projects/*']) {
    app.all(url, async (_request, reply) => reply.status(410).send({ error: PROJECTS_RETIRED }))
  }
  app.get('/api/archive/projects', async () => ({ files: store.meta.archive }))

  app.get('/api/settings', async () => publicSettings(store.settings))

  // Partial update; only known boolean fields.
  app.patch('/api/settings', async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>
    if (typeof body !== 'object' || Array.isArray(body)) fail(400, 'Send a JSON object.')
    const next = { ...store.settings }
    for (const key of ['autoRun', 'notify', 'telemetry'] as const) {
      if (body[key] === undefined) continue
      if (typeof body[key] !== 'boolean') fail(400, `${key} must be a boolean`)
      next[key] = body[key] as boolean
    }
    store.settings = next
    store.save()
    return publicSettings(store.settings)
  })

  app.get('/api/agents', async () => store.agents)

  app.get('/api/agents/:id', async (request) => {
    const { id } = request.params as { id: string }
    const agent = store.agents.find((a) => a.id === id)
    if (!agent) fail(404, `No agent with id "${id}"`)
    return agent
  })

  app.post('/api/agents/:id/runs', async (request) => {
    const { id } = request.params as { id: string }
    const agent = store.agents.find((a) => a.id === id)
    if (!agent) fail(404, `No agent with id "${id}"`)

    const body = (request.body ?? {}) as { input?: unknown }
    const input = typeof body.input === 'string' ? body.input.trim() : ''
    if (!input) fail(400, 'Provide an "input" string to run the agent.')
    return runAgent(store, agent, input)
  })

  // Prompt budget preview for an agent draft: the same planPrompt a run uses
  // (with an empty input), so the form can show whether the skills fit in
  // full, as summaries, or not at all before anything is saved or run.
  app.post('/api/prompt-budget', async (request): Promise<PromptBudget> => {
    const body = request.body
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      fail(400, 'Send a JSON object, e.g. {"endpointId":"ep_local_llama","skillIds":["summarization"]}.')
    }
    const raw = body as Record<string, unknown>
    const endpointId = typeof raw.endpointId === 'string' ? raw.endpointId : ''
    if (!endpointId) fail(400, 'Provide "endpointId", the endpoint the agent runs on.')
    const skillIds = raw.skillIds ?? []
    if (!Array.isArray(skillIds) || !skillIds.every((s): s is string => typeof s === 'string')) {
      fail(400, '"skillIds" must be an array of skill id strings.')
    }
    if (skillIds.length > MAX_BUDGET_SKILL_IDS) {
      fail(400, `"skillIds" can list at most ${MAX_BUDGET_SKILL_IDS} skills.`)
    }
    if (raw.instructions !== undefined && typeof raw.instructions !== 'string') {
      fail(400, '"instructions" must be a string.')
    }
    if (raw.memoryLearn !== undefined && typeof raw.memoryLearn !== 'boolean') {
      fail(400, '"memoryLearn" must be true or false.')
    }
    if (raw.agentId !== undefined && typeof raw.agentId !== 'string') fail(400, '"agentId" must be a string.')
    // A saved bot's preview counts its memory block and recall, as its DM run would.
    const saved = typeof raw.agentId === 'string' ? store.agents.find((a) => a.id === raw.agentId) : undefined
    if (typeof raw.agentId === 'string' && !saved) fail(404, `No agent with id "${raw.agentId.slice(0, 100)}"`)
    const memoryScope: MemoryScope | undefined = saved ? { kind: 'agent', agentId: saved.id } : undefined
    const learn = typeof raw.memoryLearn === 'boolean' ? raw.memoryLearn : (saved?.memoryLearn ?? true)
    const hasMemory = memoryScope ? store.memories.some((m) => sameScope(m.scope, memoryScope)) : false
    const endpoint = store.endpoints.find((e) => e.id === endpointId)
    if (!endpoint) fail(400, `No endpoint with id "${endpointId.slice(0, 100)}". Pick an existing endpoint.`)

    // Unknown skill ids are skipped, as a run skips deleted skills; the
    // instructions are trimmed the way saving the agent trims them.
    const rules = parseProfileFields({ rules: raw.rules }).rules
    const ownInstructions = typeof raw.instructions === 'string' ? raw.instructions.trim() : ''
    const withRules = agentInstructions(ownInstructions, rules)
    const rulesTokens = withRules === ownInstructions ? 0 : estimateTokens(withRules.length - ownInstructions.length)
    const plan = planPrompt({
      instructions: withRules,
      skills: attachedSkills(store.skills, skillIds),
      // BE-4: remember like a run's (memoryLearn defaults on); a saved bot adds its memories and recall.
      memory: memoryScope ? memoryPromptBlock(store, memoryScope) : '',
      memoryTools: [...(learn ? ['remember'] : []), ...(hasMemory ? ['recall'] : []), ...FILE_TOOL_NAMES],
      input: '',
      contextWindow: endpoint.contextWindow,
      responseReserve: replyReserve(endpoint),
    })
    return {
      contextWindow: endpoint.contextWindow,
      responseReserve: replyReserve(endpoint),
      estimatedTokens: plan.estimatedTokens,
      mode: plan.mode,
      catalogTokens: plan.catalogTokens,
      summarizedSkillIds: [],
      toolNames: plan.toolDeclarations.map((t) => t.name),
      rulesTokens,
    }
  })

  app.get('/api/agents/:id/runs', async (request) => {
    const { id } = request.params as { id: string }
    const agent = store.agents.find((a) => a.id === id)
    if (!agent) fail(404, `No agent with id "${id}"`)
    // The agent's own chat only: project task runs are kept apart.
    return store.runs
      .filter((r) => r.agentId === id && r.projectId === undefined && r.groupId === undefined)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, RUNS_PER_SCOPE)
  })

  // Chat-first conversations. Every agent has a DM; it is created on first list.
  const conversationOr404 = (id: string) => {
    const conversation = store.conversations.find((c) => c.id === id && (c.kind !== 'group' || c.archivedAt === undefined))
    if (!conversation) fail(404, `No conversation with id "${id}"`)
    return conversation as Conversation
  }

  app.get('/api/search', async (request) => {
    const { q, limit } = parseSearchQuery(request.query as { q?: unknown; limit?: unknown })
    return search(store, q, limit)
  })

  app.get('/api/conversations', async () => {
    let created = false
    for (const agent of store.agents) {
      if (!dmOf(store, agent.id)) {
        ensureDm(store, agent.id)
        created = true
      }
    }
    if (syncGroupLeads(store.conversations, store.agents)) created = true
    if (created) store.save()
    return store.conversations
      .filter((c) => c.kind !== 'group' || c.archivedAt === undefined)
      .map((c) => summarize(store, c))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  })

  app.get('/api/conversations/:id/messages', async (request) => {
    const { id } = request.params as { id: string }
    const conversation = conversationOr404(id)
    const query = request.query as { before?: unknown; after?: unknown; limit?: unknown }
    let limit = CONVERSATION_PAGE_SIZE
    if (query.limit !== undefined) {
      const n = Number(query.limit)
      if (!Number.isInteger(n) || n < 1 || n > MAX_CONVERSATION_PAGE_SIZE) {
        fail(400, `limit must be an integer from 1 to ${MAX_CONVERSATION_PAGE_SIZE}`)
      }
      limit = n
    }
    let messages = messagesOf(store, conversation.id)
    if (query.after !== undefined) {
      // BE-5 polling: everything after a message id, oldest first, a page at a time.
      if (query.before !== undefined) fail(400, 'Use either "before" or "after", not both.')
      const index = typeof query.after === 'string' ? messages.findIndex((m) => m.id === query.after) : -1
      if (index === -1) fail(400, `No message "${String(query.after)}" in this conversation.`)
      const newer = messages.slice(index + 1)
      return { conversation: summarize(store, conversation), messages: newer.slice(0, limit), hasMore: newer.length > limit }
    }
    if (query.before !== undefined) {
      if (typeof query.before !== 'string' || Number.isNaN(Date.parse(query.before))) {
        fail(400, 'before must be an ISO timestamp')
      }
      const before = query.before as string
      messages = messages.filter((m) => m.createdAt < before)
    }
    // BE-10: the first page carries the same summary as ?after= (unread count, typing).
    return { conversation: summarize(store, conversation), messages: messages.slice(-limit), hasMore: messages.length > limit }
  })

  // Send in a DM: runs the agent (same as POST /api/agents/:id/runs) and
  // returns the turn's messages. A failed run still returns its user message
  // and, when there is one, the error as the assistant message.
  app.post('/api/conversations/:id/messages', async (request, reply) => {
    const { id } = request.params as { id: string }
    const conversation = conversationOr404(id)
    // `content` is the Phase 1 field; `text` stays as an alias through
    // Phase 1. When both are sent, `content` wins.
    const body = (request.body ?? {}) as { content?: unknown; text?: unknown; attachments?: unknown }
    const raw = typeof body.content === 'string' ? body.content : typeof body.text === 'string' ? body.text : ''
    const text = raw.trim()
    // BE-9: attachments must come from earlier uploads to this conversation.
    const attachments = resolveAttachments(store, conversation, body.attachments)
    if (!text && attachments.length === 0) fail(400, 'Provide a "content" string.')
    if (conversation.kind === 'group') {
      // BE-5: 202 with the user's message; replies arrive in the background (poll with ?after=).
      const userMessage = postGroupMessage(store, groupOr404(store, conversation.id), text, attachments)
      void reply.status(202)
      return { conversation: summarize(store, conversation), messages: [userMessage] }
    }
    const agentId = conversation.agentId
    const agent = store.agents.find((a) => a.id === agentId)
    if (!agent) fail(404, `No agent for conversation "${id}"`)
    const note = attachmentPrompt(attachments)
    const run = await runAgent(store, agent as Agent, note ? (text ? `${text}\n\n${note}` : note) : text)
    if (attachments.length > 0) {
      // The run's input carries the "User attached: …" line; the chat shows the user's own words plus the cards.
      const userMessage = store.chatMessages.find((m) => m.runId === run.id && m.role === 'user')
      if (userMessage) {
        userMessage.content = text
        userMessage.attachments = attachments
        store.save()
      }
    }
    const messages = messagesOf(store, conversation.id).filter((m) => m.runId === run.id)
    return { conversation: summarize(store, conversation), messages, run: { id: run.id, status: run.status, error: run.error } }
  })

  app.post('/api/conversations/:id/read', async (request) => {
    const { id } = request.params as { id: string }
    const conversation = conversationOr404(id)
    const newest = messagesOf(store, conversation.id).at(-1)?.createdAt
    const now = new Date().toISOString()
    // Never move backwards, and cover messages stamped slightly in the future.
    const readAt = newest && newest > now ? newest : now
    if (conversation.lastReadAt === null || readAt > conversation.lastReadAt) conversation.lastReadAt = readAt
    store.save()
    return summarize(store, conversation)
  })

  app.delete('/api/agents/:id/runs', async (request, reply) => {
    const { id } = request.params as { id: string }
    const agent = store.agents.find((a) => a.id === id)
    if (!agent) fail(404, `No agent with id "${id}"`)
    // Clears the agent's own chat; its project task runs stay (deleting the agent removes them).
    store.runs = store.runs.filter((r) => r.agentId !== id || r.projectId !== undefined || r.groupId !== undefined)
    clearAgentConversations(store, id, false)
    store.save()
    void reply.status(204)
    return null
  })

  app.post('/api/agents', async (request, reply) => {
    const input = parseAgentInput(store, request.body)
    const hasPrimary = store.agents.some((a) => a.isPrimary)
    if (input.isPrimary && hasPrimary) {
      fail(409, 'A Team Lead already exists. Transfer the role from the other agent instead.')
    }
    // Exactly one primary: honor the request, otherwise promote the first agent.
    const isPrimary = input.isPrimary === true || !hasPrimary
    // BE-7: a new bot with no "skillIds" in the body gets every defaultOn skill.
    const body = request.body as Record<string, unknown>
    const skillIds = body.skillIds === undefined ? defaultSkillIds(store.skills) : input.skillIds
    const agent: Agent = mergeAgent(
      {
        id: uid('agt'),
        name: input.name,
        description: input.description,
        instructions: input.instructions ?? '',
        modelId: input.modelId,
        endpointId: input.endpointId,
        isPrimary,
        role: input.role,
        ...(typeof input.temperature === 'number' ? { temperature: input.temperature } : {}),
        skillIds,
        slug: assignAgentSlug(input.name, isPrimary, new Set(store.agents.map((a) => a.slug))),
        internetPolicy: 'ask',
        memoryLearn: true,
        vm: defaultAgentVm(),
        status: 'idle',
        createdAt: new Date().toISOString(),
        lastRunAt: null,
        runCount: 0,
      },
      { ...input, skillIds, isPrimary },
    )
    store.agents = [agent, ...store.agents]
    store.save()
    try {
      ensureBotFolder(store, agent)
    } catch (err) {
      request.log.warn(`[files] could not create the folder for ${agent.slug}: ${err instanceof Error ? err.message : String(err)}`)
    }
    void reply.status(201)
    return agent
  })

  // BE-7: merge every defaultOn skill into an existing bot (its own skills stay, in order).
  app.post('/api/agents/:id/skills/defaults', async (request) => {
    const { id } = request.params as { id: string }
    const agent = store.agents.find((a) => a.id === id)
    if (!agent) fail(404, `No agent with id "${id}"`)
    const current = (agent as Agent).skillIds
    const added = defaultSkillIds(store.skills).filter((s) => !current.includes(s))
    if (added.length > 0) {
      ;(agent as Agent).skillIds = [...current, ...added]
      store.save()
    }
    return agent
  })

  const applyAgentUpdate = (index: number, input: AgentInput): Agent => {
    const current = store.agents[index] as Agent
    const transferPrimary = input.isPrimary === true
    // The primary flag never flips off here; transfer by promoting another agent.
    const next: Agent = { ...mergeAgent(current, input), isPrimary: transferPrimary || current.isPrimary }
    if (transferPrimary) {
      store.agents = store.agents.map((a, i) =>
        i === index ? next : a.isPrimary ? { ...a, isPrimary: false } : a,
      )
    } else {
      store.agents = store.agents.map((a, i) => (i === index ? next : a))
    }
    store.save()
    try { ensureBotFolder(store, next) } catch { /* BOT.md catches up on the next change or boot */ }
    return next
  }

  app.put('/api/agents/:id', async (request) => {
    const { id } = request.params as { id: string }
    const index = store.agents.findIndex((a) => a.id === id)
    if (index === -1) fail(404, `No agent with id "${id}"`)
    return applyAgentUpdate(index, parseAgentInput(store, request.body))
  })

  // BE-4: any subset of the PUT fields, same rules; omitted fields keep their
  // stored value. The model is re-checked only when modelId or endpointId changes.
  app.patch('/api/agents/:id', async (request) => {
    const { id } = request.params as { id: string }
    const index = store.agents.findIndex((a) => a.id === id)
    if (index === -1) fail(404, `No agent with id "${id}"`)
    const body = request.body ?? {}
    if (typeof body !== 'object' || Array.isArray(body)) fail(400, 'Send a JSON object with the fields to change.')
    const patch = body as Record<string, unknown>
    checkPatchTypes(patch)
    const current = store.agents[index] as Agent
    const base: Record<string, unknown> = {
      name: current.name, description: current.description, instructions: current.instructions,
      modelId: current.modelId, endpointId: current.endpointId, role: current.role,
      skillIds: current.skillIds, ...(current.temperature !== undefined ? { temperature: current.temperature } : {}),
    }
    const checkModel = 'modelId' in patch || 'endpointId' in patch
    return applyAgentUpdate(index, parseAgentInput(store, { ...base, ...patch }, { checkModel }))
  })

  // Image avatars: raw image body, stored as data/avatars/<agentId>.<ext>.
  app.register(async (scope) => {
    for (const type of Object.keys(AVATAR_TYPES)) {
      scope.addContentTypeParser(type, { parseAs: 'buffer', bodyLimit: MAX_AVATAR_BYTES }, (_req, body, done) =>
        done(null, body),
      )
    }
    scope.put('/api/agents/:id/avatar', { bodyLimit: MAX_AVATAR_BYTES }, async (request) => {
      const { id } = request.params as { id: string }
      const index = store.agents.findIndex((a) => a.id === id)
      if (index === -1) fail(404, `No agent with id "${id}"`)
      const type = String(request.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase()
      const ext = AVATAR_TYPES[type]
      const body = request.body
      if (!ext || !Buffer.isBuffer(body)) fail(415, 'Upload a PNG, JPEG, WebP or GIF image.')
      if (body.length === 0) fail(400, 'The image is empty.')
      const current = store.agents[index] as Agent
      mkdirSync(store.avatarsDir, { recursive: true })
      const file = `${id}.${ext}`
      const temporary = join(store.avatarsDir, `.${file}.${process.pid}.tmp`)
      writeFileSync(temporary, body, { mode: 0o600 })
      renameSync(temporary, join(store.avatarsDir, file))
      if (current.avatar?.kind === 'image' && current.avatar.file !== file) removeAvatarFile(store, current)
      const next: Agent = { ...current, avatar: { kind: 'image', file, updatedAt: new Date().toISOString() } }
      store.agents = store.agents.map((a, i) => (i === index ? next : a))
      store.save()
      return next
    })

    // The user's own image avatar, stored as data/avatars/_profile.<ext> (agent ids never start with _).
    scope.put('/api/profile/avatar', { bodyLimit: MAX_AVATAR_BYTES }, async (request) => {
      const type = String(request.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase()
      const ext = AVATAR_TYPES[type]
      const body = request.body
      if (!ext || !Buffer.isBuffer(body)) fail(415, 'Upload a PNG, JPEG, WebP or GIF image.')
      if (body.length === 0) fail(400, 'The image is empty.')
      mkdirSync(store.avatarsDir, { recursive: true })
      const file = `_profile.${ext}`
      const temporary = join(store.avatarsDir, `.${file}.${process.pid}.tmp`)
      writeFileSync(temporary, body, { mode: 0o600 })
      renameSync(temporary, join(store.avatarsDir, file))
      const current = store.profile.avatar
      if (current?.kind === 'image' && current.file !== file) removeProfileAvatarFile(store)
      store.profile = { ...store.profile, avatar: { kind: 'image', file, updatedAt: new Date().toISOString() } }
      store.save()
      return store.profile
    })
  })

  // User profile. Saving a name for the first time completes onboarding.
  app.get('/api/profile', async () => store.profile)

  app.put('/api/profile', async (request) => {
    const raw = (request.body ?? {}) as Record<string, unknown>
    const name = typeof raw.name === 'string' ? raw.name.trim() : ''
    if (!name) fail(400, '"name" is required.')
    if (name.length > MAX_USER_NAME_CHARS) fail(400, `"name" is at most ${MAX_USER_NAME_CHARS} characters.`)
    const next: UserProfile = { ...store.profile, name, onboardedAt: store.profile.onboardedAt ?? new Date().toISOString() }
    if (raw.avatar !== undefined) {
      if (raw.avatar === null) {
        removeProfileAvatarFile(store)
        delete next.avatar
      } else {
        const a = raw.avatar as Record<string, unknown>
        const value = typeof a?.value === 'string' ? a.value.trim() : ''
        if (a?.kind !== 'emoji' || !value || value.length > MAX_EMOJI_CHARS || /[\s<>]/.test(value)) {
          fail(400, '"avatar" must be { kind: "emoji", value: "<one emoji>" } or null. Upload images with PUT /api/profile/avatar.')
        }
        removeProfileAvatarFile(store)
        next.avatar = { kind: 'emoji', value }
      }
    }
    store.profile = next
    store.save()
    return store.profile
  })

  app.get('/api/profile/avatar', async (_request, reply) => {
    const avatar = store.profile.avatar
    const path = avatar?.kind === 'image' ? avatarPath(store, avatar.file) : null
    if (!avatar || avatar.kind !== 'image' || !path || !existsSync(path)) fail(404, 'The profile has no image avatar.')
    const ext = avatar.file.slice(avatar.file.lastIndexOf('.') + 1)
    const type = Object.entries(AVATAR_TYPES).find(([, e]) => e === ext)?.[0] ?? 'application/octet-stream'
    void reply.header('content-type', type).header('cache-control', 'private, no-cache')
    return reply.send(readFileSync(path))
  })

  app.delete('/api/profile/avatar', async () => {
    removeProfileAvatarFile(store)
    const { avatar: _dropped, ...next } = store.profile
    store.profile = next
    store.save()
    return store.profile
  })

  app.get('/api/agents/:id/avatar', async (request, reply) => {
    const { id } = request.params as { id: string }
    const agent = store.agents.find((a) => a.id === id)
    if (!agent) fail(404, `No agent with id "${id}"`)
    const avatar = agent.avatar
    const path = avatar?.kind === 'image' ? avatarPath(store, avatar.file) : null
    if (!avatar || avatar.kind !== 'image' || !path || !existsSync(path)) fail(404, 'This agent has no image avatar.')
    const ext = avatar.file.slice(avatar.file.lastIndexOf('.') + 1)
    const type = Object.entries(AVATAR_TYPES).find(([, e]) => e === ext)?.[0] ?? 'application/octet-stream'
    void reply.header('content-type', type).header('cache-control', 'private, max-age=31536000, immutable')
    return reply.send(readFileSync(path))
  })

  app.delete('/api/agents/:id/avatar', async (request) => {
    const { id } = request.params as { id: string }
    const index = store.agents.findIndex((a) => a.id === id)
    if (index === -1) fail(404, `No agent with id "${id}"`)
    const current = store.agents[index] as Agent
    removeAvatarFile(store, current)
    const { avatar: _dropped, ...next } = current
    store.agents = store.agents.map((a, i) => (i === index ? next : a))
    store.save()
    return next
  })

  app.delete('/api/agents/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const agent = store.agents.find((a) => a.id === id)
    if (!agent) fail(404, `No agent with id "${id}"`)
    if (agent.isPrimary) {
      fail(409, 'Move the Team Lead role to another agent before deleting it.')
    }
    // BE-2: the folder is archived (never removed) before the bot goes away.
    archiveBotFolder(store, agent)
    store.agents = store.agents.filter((a) => a.id !== id)
    store.runs = store.runs.filter((r) => r.agentId !== id)
    // BE-4: the bot's private memory goes with it (memory/MEMORY.md is in the archived folder).
    store.memories = store.memories.filter((m) => !(m.scope.kind === 'agent' && m.scope.agentId === id))
    removeAvatarFile(store, agent)
    clearAgentConversations(store, id, true)
    removeAgentFromGroups(store, agent)
    store.save()
    void reply.status(204)
    return null
  })

  // --- BE-2: per-bot folders + Files API -------------------------------------
  const sendFile = (reply: FastifyReply, file: FileContent, download: unknown) => {
    const ascii = file.name.replace(/[^\x20-\x7e]|["\\]/g, '_')
    void reply
      .header('Content-Type', file.mime.startsWith('text/') ? `${file.mime}; charset=utf-8` : file.mime)
      .header('Content-Length', String(file.size))
      .header('X-Content-Type-Options', 'nosniff')
      // Served files never run in the app's origin (HTML, SVG).
      .header('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'")
      .header('Cache-Control', 'no-store')
    if (download === '1' || download === 'true') {
      void reply.header('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.name)}`)
    } else {
      void reply.header('Content-Disposition', `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.name)}`)
    }
    return reply.send(file.body)
  }

  const fileAgent = (id: string): Agent => {
    const agent = store.agents.find((a) => a.id === id)
    if (!agent) fail(404, `No agent with id "${id}"`)
    return agent
  }

  app.get('/api/agents/:id/files', async (request) => {
    const { id } = request.params as { id: string }
    const { path } = (request.query ?? {}) as { path?: unknown }
    return listFolder(store, fileAgent(id), path)
  })

  app.get('/api/agents/:id/files/shared', async (request) => {
    const { id } = request.params as { id: string }
    return listShared(store, fileAgent(id))
  })

  app.get('/api/agents/:id/files/content', async (request, reply) => {
    const { id } = request.params as { id: string }
    const { path, download } = (request.query ?? {}) as { path?: unknown; download?: unknown }
    return sendFile(reply, await readContent(store, fileAgent(id), path), download)
  })

  // Raw uploads (any content type, up to 25 MiB) are parsed only in this scope.
  app.register(async (scope) => {
    scope.removeAllContentTypeParsers()
    scope.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_BYTES }, (_req, body, done) => done(null, body))
    scope.put('/api/agents/:id/files/content', { bodyLimit: MAX_UPLOAD_BYTES }, async (request, reply) => {
      const { id } = request.params as { id: string }
      const { path, overwrite } = (request.query ?? {}) as { path?: unknown; overwrite?: unknown }
      const agent = fileAgent(id)
      if (path === undefined || path === '') fail(400, '"path" is required.')
      const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0)
      const entry = writeContent(store, agent, path, body, overwrite === '1' || overwrite === 'true')
      void reply.status(201)
      return entry
    })
    scope.put('/api/conversations/:id/uploads', { bodyLimit: MAX_UPLOAD_BYTES }, async (request, reply) => {
      const { id } = request.params as { id: string }
      const { name } = (request.query ?? {}) as { name?: unknown }
      const conversation = conversationOr404(id)
      const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0)
      const attachment = uploadAttachment(store, conversation, name, body)
      void reply.status(201)
      return attachment
    })
    scope.put('/api/groups/:id/files/content', { bodyLimit: MAX_UPLOAD_BYTES }, async (request, reply) => {
      const { id } = request.params as { id: string }
      const { path, overwrite } = (request.query ?? {}) as { path?: unknown; overwrite?: unknown }
      const group = groupOr404(store, id)
      if (path === undefined || path === '') fail(400, '"path" is required.')
      const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0)
      const entry = writeGroupContent(store, group, path, body, overwrite === '1' || overwrite === 'true')
      void reply.status(201)
      return entry
    })
  })

  app.post('/api/agents/:id/files/folders', async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = (request.body ?? {}) as { path?: unknown }
    const agent = fileAgent(id)
    if (typeof body.path !== 'string' || body.path.trim() === '') fail(400, '"path" is required.')
    const entry = makeFolder(store, agent, body.path)
    void reply.status(201)
    return entry
  })

  app.patch('/api/agents/:id/files', async (request) => {
    const { id } = request.params as { id: string }
    const body = (request.body ?? {}) as { from?: unknown; to?: unknown }
    return movePath(store, fileAgent(id), body.from, body.to)
  })

  app.delete('/api/agents/:id/files', async (request, reply) => {
    const { id } = request.params as { id: string }
    const { path } = (request.query ?? {}) as { path?: unknown }
    const agent = fileAgent(id)
    if (path === undefined || path === '') fail(400, '"path" is required.')
    trashPath(store, agent, path)
    void reply.status(204)
    return null
  })

  // --- BE-5: group chats ------------------------------------------------------
  app.post('/api/groups', async (request, reply) => {
    const group = createGroup(store, request.body)
    store.save()
    void reply.status(201)
    return summarize(store, group)
  })

  app.get('/api/groups/:id', async (request) => {
    const { id } = request.params as { id: string }
    return summarize(store, groupOr404(store, id))
  })

  app.patch('/api/groups/:id', async (request) => {
    const { id } = request.params as { id: string }
    const group = updateGroup(store, groupOr404(store, id), request.body)
    store.save()
    return summarize(store, group)
  })

  app.delete('/api/groups/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    archiveGroup(store, groupOr404(store, id))
    store.save()
    void reply.status(204)
    return null
  })

  app.get('/api/groups/:id/files', async (request) => {
    const { id } = request.params as { id: string }
    const { path } = (request.query ?? {}) as { path?: unknown }
    return listGroupFolder(store, groupOr404(store, id), path)
  })

  app.get('/api/groups/:id/files/shared', async (request) => {
    const { id } = request.params as { id: string }
    return listGroupShared(store, groupOr404(store, id))
  })

  app.get('/api/groups/:id/files/content', async (request, reply) => {
    const { id } = request.params as { id: string }
    const { path, download } = (request.query ?? {}) as { path?: unknown; download?: unknown }
    return sendFile(reply, await readGroupContent(store, groupOr404(store, id), path), download)
  })

  app.post('/api/groups/:id/files/folders', async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = (request.body ?? {}) as { path?: unknown }
    const group = groupOr404(store, id)
    if (typeof body.path !== 'string' || body.path.trim() === '') fail(400, '"path" is required.')
    const entry = makeGroupFolder(store, group, body.path)
    void reply.status(201)
    return entry
  })

  app.patch('/api/groups/:id/files', async (request) => {
    const { id } = request.params as { id: string }
    const body = (request.body ?? {}) as { from?: unknown; to?: unknown }
    return moveGroupPath(store, groupOr404(store, id), body.from, body.to)
  })

  app.delete('/api/groups/:id/files', async (request, reply) => {
    const { id } = request.params as { id: string }
    const { path } = (request.query ?? {}) as { path?: unknown }
    const group = groupOr404(store, id)
    if (path === undefined || path === '') fail(400, '"path" is required.')
    trashGroupPath(store, group, path)
    void reply.status(204)
    return null
  })

  app.get('/api/endpoints', async () => store.endpoints.map((e) => publicEndpoint(store, e)))

  app.post('/api/endpoints', async (request, reply) => {
    const raw = (request.body ?? {}) as Partial<EndpointInput>
    const input: EndpointInput = {
      kind: raw.kind as EndpointKind,
      name: typeof raw.name === 'string' ? raw.name : '',
      baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : '',
      defaultModel: typeof raw.defaultModel === 'string' ? raw.defaultModel : '',
      contextWindow: typeof raw.contextWindow === 'number' ? raw.contextWindow : Number.NaN,
      ...(raw.apiKey !== undefined ? { apiKey: raw.apiKey } : {}),
      ...(raw.timeoutMs !== undefined ? { timeoutMs: raw.timeoutMs } : {}),
      ...(raw.proxyUrl !== undefined ? { proxyUrl: raw.proxyUrl } : {}),
    }
    assertEndpointInput(input, '')
    const maxOutputTokens = resolveMaxOutputTokens(raw.maxOutputTokens, undefined, input.contextWindow)
    if (raw.disableThinking !== undefined && typeof raw.disableThinking !== 'boolean') fail(400, '"disableThinking" must be true or false.')
    const proxyUrl = resolveProxy(raw.proxyUrl, undefined)
    const id = uid('ep')
    const apiKey = typeof raw.apiKey === 'string' ? raw.apiKey : ''
    if (apiKey) store.endpointKeys[id] = apiKey
    const endpoint: Endpoint = {
      id,
      kind: input.kind,
      name: input.name.trim(),
      baseUrl: resolveBaseUrl(input.kind, input.baseUrl),
      defaultModel: input.defaultModel.trim(),
      contextWindow: Math.floor(input.contextWindow),
      apiKeySet: Boolean(apiKey),
      status: 'unknown',
      lastCheckedAt: null,
      createdAt: new Date().toISOString(),
      ...(input.timeoutMs !== undefined ? { timeoutMs: Math.floor(input.timeoutMs) } : {}),
      ...(proxyUrl ? { proxyUrl } : {}),
      ...(raw.disableThinking === true ? { disableThinking: true } : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    }
    store.endpoints = [endpoint, ...store.endpoints]
    store.endpointModels[id] = [endpoint.defaultModel]
    store.save()
    void reply.status(201)
    return publicEndpoint(store, endpoint)
  })

  app.patch('/api/endpoints/:id', async (request) => {
    const { id } = request.params as { id: string }
    const index = store.endpoints.findIndex((e) => e.id === id)
    if (index === -1) fail(404, `No endpoint with id "${id}"`)
    const current = store.endpoints[index] as Endpoint
    const raw = (request.body ?? {}) as Partial<EndpointInput>
    const merged: EndpointInput = {
      kind: (raw.kind ?? current.kind) as EndpointKind,
      name: raw.name ?? current.name,
      baseUrl: raw.baseUrl ?? current.baseUrl,
      defaultModel: raw.defaultModel ?? current.defaultModel,
      contextWindow: raw.contextWindow ?? current.contextWindow,
      ...(raw.apiKey !== undefined ? { apiKey: raw.apiKey } : {}),
      timeoutMs: raw.timeoutMs ?? current.timeoutMs,
      ...(raw.proxyUrl !== undefined ? { proxyUrl: raw.proxyUrl } : {}),
    }
    assertEndpointInput(merged, store.endpointKeys[id] ?? '')
    const maxOutputTokens = resolveMaxOutputTokens(raw.maxOutputTokens, current.maxOutputTokens, Math.floor(merged.contextWindow))
    if (raw.disableThinking !== undefined && typeof raw.disableThinking !== 'boolean') fail(400, '"disableThinking" must be true or false.')
    const proxyUrl = resolveProxy(raw.proxyUrl, current.proxyUrl)
    // Write-only key semantics: omitted keeps, non-empty replaces, "" clears.
    if (raw.apiKey !== undefined) {
      if (raw.apiKey) store.endpointKeys[id] = raw.apiKey
      else delete store.endpointKeys[id]
    }
    const next: Endpoint = {
      ...current,
      kind: merged.kind,
      name: merged.name.trim(),
      baseUrl: resolveBaseUrl(merged.kind, merged.baseUrl),
      defaultModel: merged.defaultModel.trim(),
      contextWindow: Math.floor(merged.contextWindow),
      apiKeySet: Boolean(store.endpointKeys[id]),
      status: 'unknown',
      lastCheckedAt: null,
      ...(merged.timeoutMs !== undefined ? { timeoutMs: Math.floor(merged.timeoutMs) } : {}),
    }
    if (proxyUrl) next.proxyUrl = proxyUrl
    else delete next.proxyUrl
    if (raw.disableThinking === true) next.disableThinking = true
    else if (raw.disableThinking === false) delete next.disableThinking
    if (maxOutputTokens !== undefined) next.maxOutputTokens = maxOutputTokens
    else delete next.maxOutputTokens
    store.endpoints = store.endpoints.map((e, i) => (i === index ? next : e))
    const models = store.endpointModels[id] ?? []
    if (!models.includes(next.defaultModel)) store.endpointModels[id] = [...models, next.defaultModel]
    store.save()
    return publicEndpoint(store, next)
  })

  app.delete('/api/endpoints/:id', async (request) => {
    const { id } = request.params as { id: string }
    const endpoint = store.endpoints.find((e) => e.id === id)
    if (!endpoint) fail(404, `No endpoint with id "${id}"`)

    const primary = store.agents.find((a) => a.isPrimary)
    if (primary && primary.endpointId === id) {
      fail(409, 'Move the Team Lead to another endpoint first.')
    }
    const fallbackEndpointId = primary?.endpointId

    // Reassign attached agents to the Team Lead's endpoint (the default).
    const reassignedAgents: string[] = []
    for (const agent of store.agents) {
      if (agent.endpointId === id) {
        if (!fallbackEndpointId) {
          fail(409, 'No default endpoint available. Move the Team Lead to another endpoint first.')
        }
        agent.endpointId = fallbackEndpointId
        reassignedAgents.push(agent.id)
      }
    }

    store.endpoints = store.endpoints.filter((e) => e.id !== id)
    delete store.endpointModels[id]
    delete store.endpointKeys[id]
    store.save()
    return { ok: true, reassignedAgents }
  })

  app.get('/api/endpoints/:id/models', async (request) => {
    const { id } = request.params as { id: string }
    const endpoint = store.endpoints.find((e) => e.id === id)
    if (!endpoint) fail(404, `No endpoint with id "${id}"`)
    const live = await fetchModels(endpoint.baseUrl, store.endpointKeys[id], endpoint.proxyUrl)
    if (live.ok) {
      store.endpointModels[id] = live.models
      endpoint.status = 'reachable'
      endpoint.lastCheckedAt = new Date().toISOString()
      store.save()
      return { models: live.models.map((m) => ({ id: m, name: m })) }
    }
    endpoint.status = 'unreachable'
    endpoint.lastCheckedAt = new Date().toISOString()
    store.save()
    // Fall back to the cached list so the agent form still works offline.
    const cached = store.endpointModels[id] ?? []
    if (cached.length > 0) return { models: cached.map((m) => ({ id: m, name: m })) }
    fail(502, `Could not reach ${endpoint.name}: ${live.error ?? 'request failed'}`)
  })

  app.post('/api/endpoints/:id/test', async (request) => {
    const { id } = request.params as { id: string }
    const endpoint = store.endpoints.find((e) => e.id === id)
    if (!endpoint) fail(404, `No endpoint with id "${id}"`)
    const live = await fetchModels(endpoint.baseUrl, store.endpointKeys[id], endpoint.proxyUrl)
    endpoint.status = live.ok ? 'reachable' : 'unreachable'
    endpoint.lastCheckedAt = new Date().toISOString()
    if (live.ok) store.endpointModels[id] = live.models
    store.save()
    return { ok: live.ok, models: live.ok ? live.models : [], latencyMs: live.latencyMs, ...(live.error ? { error: live.error } : {}) }
  })

  app.get('/api/skills/:id', async (request) => {
    const { id } = request.params as { id: string }
    const skill = store.skills.find((s) => s.id === id)
    if (!skill) fail(404, `No skill with id "${id}"`)
    return skill
  })

  app.post('/api/skills', async (request, reply) => {
    const input = parseSkillInput(request.body)
    const skill: Skill = {
      id: uid('skl'),
      ...input,
      tools: input.tools ?? [],
      ...CUSTOM_SKILL_FIELDS,
    }
    store.skills = [...store.skills, skill]
    store.save()
    void reply.status(201)
    return skill
  })

  // SKILL.md import: YAML frontmatter -> name + description, body -> content.
  app.post('/api/skills/import', async (request, reply) => {
    const raw = (request.body ?? {}) as { markdown?: unknown }
    const markdown = typeof raw.markdown === 'string' ? raw.markdown : ''
    if (!markdown.trim()) fail(400, 'Provide the SKILL.md text in "markdown".')
    let parsed: ReturnType<typeof parseSkillMarkdown>
    try {
      parsed = parseSkillMarkdown(markdown)
    } catch (err) {
      if (err instanceof SkillMarkdownError) fail(422, err.message)
      throw err
    }
    const id = slugify(parsed.name) || uid('skl')
    if (store.skills.some((s) => s.id === id)) {
      fail(409, `A skill with id "${id}" already exists.`)
    }
    // Keep built-in tool names only: third-party SKILL.md files (e.g. Claude
    // Code's `tools: Read, Bash`) still import, and nothing unknown is granted.
    const { tools, ignored } = resolveToolDeclarations(parsed.tools, { max: MAX_SKILL_TOOLS })
    const skill: Skill = {
      id,
      name: parsed.name,
      description: parsed.description,
      tag: parsed.tag,
      content: parsed.content,
      tools,
      ...(parsed.license ? { license: parsed.license } : {}),
      ...(parsed.compatibility ? { compatibility: parsed.compatibility } : {}),
      ...(parsed.metadata ? { metadata: parsed.metadata } : {}),
      ...(parsed.allowedTools ? { allowedTools: parsed.allowedTools } : {}),
      ...CUSTOM_SKILL_FIELDS,
    }
    store.skills = [...store.skills, skill]
    store.save()
    void reply.status(201)
    return ignored.length > 0 ? { ...skill, ignoredTools: ignored } : skill
  })

  app.patch('/api/skills/:id', async (request) => {
    const { id } = request.params as { id: string }
    const index = store.skills.findIndex((s) => s.id === id)
    if (index === -1) fail(404, `No skill with id "${id}"`)
    const current = store.skills[index] as Skill
    if (isVendoredSkillId(current.id)) fail(403, VENDORED_READ_ONLY)
    const raw = (request.body ?? {}) as Record<string, unknown>
    const next: Skill = { ...current }
    if (raw.name !== undefined) {
      const name = typeof raw.name === 'string' ? raw.name.trim() : ''
      if (!name) fail(400, 'Skill name cannot be empty.')
      next.name = name
    }
    if (raw.content !== undefined) {
      const content = typeof raw.content === 'string' ? raw.content.trim() : ''
      if (!content) fail(400, 'Skill content cannot be empty.')
      next.content = content
    }
    if (raw.description !== undefined) {
      next.description = typeof raw.description === 'string' ? raw.description.trim() : ''
    }
    if (raw.tag !== undefined) {
      next.tag = typeof raw.tag === 'string' ? raw.tag.trim() : ''
    }
    if (raw.source !== undefined) {
      const source = typeof raw.source === 'string' ? raw.source.trim() : ''
      if (source) next.source = source
      else delete next.source
    }
    if (raw.tools !== undefined) {
      const tools = parseSkillTools(raw.tools)
      if (tools) next.tools = tools
    }
    store.skills = store.skills.map((s, i) => (i === index ? next : s))
    store.save()
    return next
  })

  app.delete('/api/skills/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const skill = store.skills.find((s) => s.id === id)
    if (!skill) fail(404, `No skill with id "${id}"`)
    if (isVendoredSkillId(id)) fail(403, VENDORED_READ_ONLY)
    // Same-transaction detach: strip the id from every agent before removal.
    store.detachSkill(id)
    store.skills = store.skills.filter((s) => s.id !== id)
    store.save()
    void reply.status(204)
    return null
  })

  // BE-2: every existing bot gets its folder on boot.
  ensureAllBotFolders(store, (msg) => app.log.warn(msg))

  registerSandboxRoutes(app, store, { defaultSkillIds: () => defaultSkillIds(store.skills) })

  // BE-P2-2: engine and the `agentcontrol` machine.
  const vmHost =
    opts.vmHost ??
    createVmHostService({
      getDiskBudgetGb: () => store.settings.vm?.machine?.diskGb,
      setDiskBudgetGb: (diskGb) => {
        if (store.settings.vm) store.settings.vm.machine = { diskGb }
        store.save()
      },
    })
  app.get('/api/vm/host', async () => vmHost.hostInfo())
  app.post('/api/vm/machine/grow', async (request) => {
    const body = request.body as { toGb?: unknown } | null | undefined
    return vmHost.grow(body && typeof body === 'object' ? body.toGb : undefined)
  })

  return app
}
