import cors from '@fastify/cors'
import Fastify, { type FastifyInstance } from 'fastify'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assignAgentSlug, createStore, type WorkspaceStore } from './store.js'
import { PROJECTS_RETIRED } from './archive.js'
import { SkillMarkdownError, parseSkillMarkdown } from './db/skill-md.js'
import { fetchModels, PROXY_PROTOCOLS } from './upstream.js'
import { listToolInfo, resolveToolDeclarations } from './tools.js'
import { agentInstructions, attachedSkills, estimateTokens, planPrompt, replyReserve } from './prompt.js'
import { fail, uid } from './http.js'
import { runAgent, RUNS_PER_SCOPE } from './runs.js'
import { clearAgentConversations, dmOf, ensureDm, messagesOf, summarize } from './conversations.js'
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

function parseAgentInput(store: WorkspaceStore, body: unknown): AgentInput {
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
  if (served.length > 0 && !served.includes(modelId) && modelId !== endpoint.defaultModel) {
    fail(400, `Model "${modelId}" is not served by this endpoint.`)
  }

  const skillIds = Array.isArray(raw.skillIds)
    ? raw.skillIds.filter((s): s is string => typeof s === 'string')
    : []

  let temperature: number | undefined
  if (raw.temperature !== undefined && raw.temperature !== null) {
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
function mergeAgent(current: Agent, input: AgentInput): Agent {
  const { color, avatar, ...rest } = input
  const next: Agent = { ...current, ...rest }
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

export function buildApp(store: WorkspaceStore = createStore()): FastifyInstance {
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
    if (status >= 500) app.log.error(err)
    void reply.status(status).send({
      statusCode: status,
      error: status >= 500 ? 'Internal Server Error' : 'Request Error',
      message: err.message,
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

  // Notes: shared memory written by agents' notes tools. Users read and delete here.
  const authorName = (agentId: string): string | null => store.agents.find((a) => a.id === agentId)?.name ?? null
  app.get('/api/notes', async () =>
    [...store.notes]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((n) => ({
        id: n.id,
        title: n.title,
        tags: n.tags,
        authorAgentId: n.authorAgentId,
        authorName: authorName(n.authorAgentId),
        updatedByAgentId: n.updatedByAgentId,
        runId: n.runId,
        createdAt: n.createdAt,
        updatedAt: n.updatedAt,
        chars: n.body.length,
        snippet: n.body.length > 160 ? `${n.body.slice(0, 159)}…` : n.body,
      })),
  )
  app.get('/api/notes/:id', async (request) => {
    const { id } = request.params as { id: string }
    const note = store.notes.find((n) => n.id === id)
    if (!note) fail(404, `No note with id "${id}"`)
    return { ...note, authorName: authorName(note.authorAgentId) }
  })
  app.delete('/api/notes/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    if (!store.notes.some((n) => n.id === id)) fail(404, `No note with id "${id}"`)
    const previous = store.notes
    store.notes = store.notes.filter((n) => n.id !== id)
    if (!store.save()) {
      store.notes = previous
      fail(500, 'The note could not be deleted from storage. Please retry.')
    }
    return reply.status(204).send()
  })
  // Projects were retired (BE-1): every old route answers 410. The data is in
  // data/archive/projects-*.json; this lists those files (names only).
  for (const url of ['/api/projects', '/api/projects/*']) {
    app.all(url, async (_request, reply) => reply.status(410).send({ error: PROJECTS_RETIRED }))
  }
  app.get('/api/archive/projects', async () => ({ files: store.meta.archive }))

  app.get('/api/settings', async () => store.settings)

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
    return store.settings
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
      input: '',
      contextWindow: endpoint.contextWindow,
      responseReserve: replyReserve(endpoint),
    })
    return {
      contextWindow: endpoint.contextWindow,
      responseReserve: replyReserve(endpoint),
      estimatedTokens: plan.estimatedTokens,
      mode: plan.mode,
      summarizedSkillIds: plan.summarizedSkillIds,
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
      .filter((r) => r.agentId === id && r.projectId === undefined)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, RUNS_PER_SCOPE)
  })

  // Chat-first conversations. Every agent has a DM; it is created on first list.
  const conversationOr404 = (id: string) => {
    const conversation = store.conversations.find((c) => c.id === id)
    if (!conversation) fail(404, `No conversation with id "${id}"`)
    return conversation as Conversation
  }

  app.get('/api/conversations', async () => {
    let created = false
    for (const agent of store.agents) {
      if (!dmOf(store, agent.id)) {
        ensureDm(store, agent.id)
        created = true
      }
    }
    if (created) store.save()
    return store.conversations
      .map((c) => summarize(store, c))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  })

  app.get('/api/conversations/:id/messages', async (request) => {
    const { id } = request.params as { id: string }
    const conversation = conversationOr404(id)
    const query = request.query as { before?: unknown; limit?: unknown }
    let limit = CONVERSATION_PAGE_SIZE
    if (query.limit !== undefined) {
      const n = Number(query.limit)
      if (!Number.isInteger(n) || n < 1 || n > MAX_CONVERSATION_PAGE_SIZE) {
        fail(400, `limit must be an integer from 1 to ${MAX_CONVERSATION_PAGE_SIZE}`)
      }
      limit = n
    }
    let messages = messagesOf(store, conversation.id)
    if (query.before !== undefined) {
      if (typeof query.before !== 'string' || Number.isNaN(Date.parse(query.before))) {
        fail(400, 'before must be an ISO timestamp')
      }
      const before = query.before as string
      messages = messages.filter((m) => m.createdAt < before)
    }
    return { conversation, messages: messages.slice(-limit), hasMore: messages.length > limit }
  })

  // Send in a DM: runs the agent (same as POST /api/agents/:id/runs) and
  // returns the turn's messages. A failed run still returns its user message
  // and, when there is one, the error as the assistant message.
  app.post('/api/conversations/:id/messages', async (request) => {
    const { id } = request.params as { id: string }
    const conversation = conversationOr404(id)
    if (conversation.kind !== 'dm') fail(400, 'Group chats arrive with BE-5.')
    const agentId = conversation.agentId
    const agent = store.agents.find((a) => a.id === agentId)
    if (!agent) fail(404, `No agent for conversation "${id}"`)
    // `content` is the Phase 1 field; `text` stays as an alias through
    // Phase 1. When both are sent, `content` wins.
    const body = (request.body ?? {}) as { content?: unknown; text?: unknown }
    const raw = typeof body.content === 'string' ? body.content : typeof body.text === 'string' ? body.text : ''
    const text = raw.trim()
    if (!text) fail(400, 'Provide a "content" string.')
    const run = await runAgent(store, agent as Agent, text)
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
    store.runs = store.runs.filter((r) => r.agentId !== id || r.projectId !== undefined)
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
    const agent: Agent = mergeAgent(
      {
        id: uid('agt'),
        name: input.name,
        description: input.description,
        instructions: input.instructions,
        modelId: input.modelId,
        endpointId: input.endpointId,
        isPrimary,
        role: input.role,
        skillIds: input.skillIds,
        slug: assignAgentSlug(input.name, isPrimary, new Set(store.agents.map((a) => a.slug))),
        internetPolicy: 'ask',
        memoryLearn: true,
        status: 'idle',
        createdAt: new Date().toISOString(),
        lastRunAt: null,
        runCount: 0,
      },
      { ...input, isPrimary },
    )
    store.agents = [agent, ...store.agents]
    store.save()
    void reply.status(201)
    return agent
  })

  app.put('/api/agents/:id', async (request) => {
    const { id } = request.params as { id: string }
    const index = store.agents.findIndex((a) => a.id === id)
    if (index === -1) fail(404, `No agent with id "${id}"`)
    const current = store.agents[index] as Agent
    const input = parseAgentInput(store, request.body)
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
    return next
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
    store.agents = store.agents.filter((a) => a.id !== id)
    store.runs = store.runs.filter((r) => r.agentId !== id)
    removeAvatarFile(store, agent)
    clearAgentConversations(store, id, true)
    store.save()
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

  return app
}
