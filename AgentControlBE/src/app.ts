import cors from '@fastify/cors'
import Fastify, { type FastifyInstance } from 'fastify'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createStore, slugifyProjectName, type WorkspaceStore } from './store.js'
import { SkillMarkdownError, parseSkillMarkdown } from './db/skill-md.js'
import { fetchModels } from './upstream.js'
import { listToolInfo, resolveToolDeclarations } from './tools.js'
import { attachedSkills, planPrompt, RESPONSE_RESERVE } from './prompt.js'
import { fail, uid } from './http.js'
import { runAgent, RUNS_PER_SCOPE } from './runs.js'
import {
  appendProjectMessage,
  applyTeamPlan,
  cancelTask,
  createTaskRunner,
  pauseWork,
  requestReview,
  requestTeamPlan,
  resumeWork,
  retryTask,
  stopWork,
} from './projects.js'
import {
  DEFAULT_ENDPOINT_BASE_URL,
  OPENROUTER_DEFAULT_BASE_URL,
  type Agent,
  type AgentInput,
  type Endpoint,
  type EndpointInput,
  type EndpointKind,
  type PromptBudget,
  type Project,
  type ProjectInput,
  type ProjectMessage,
  type Skill,
  type SkillInput,
  type SkillTool,
} from './shared/types.js'

function trimBase(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '')
}

function resolveBaseUrl(kind: EndpointKind, baseUrl: string): string {
  const trimmed = baseUrl.trim()
  if (!trimmed && kind === 'openrouter') return OPENROUTER_DEFAULT_BASE_URL
  return trimBase(trimmed)
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
      fail(400, 'Proxy must be a valid http(s) URL, e.g. http://localhost:1055.')
    }
    if (proxy.protocol !== 'http:' && proxy.protocol !== 'https:') fail(400, 'Proxy must start with http:// or https://.')
  }
}

/** Stored proxy after a create/update: undefined means none. */
function resolveProxy(raw: unknown, current: string | undefined): string | undefined {
  if (raw === undefined) return current
  if (raw === null || raw === '') return undefined
  return String(raw).trim().replace(/\/+$/, '')
}

/**
 * Validate a project create/patch body. `existing` is the record being
 * patched (name-uniqueness skips it) or null on create. Absent fields on a
 * patch come back as undefined and keep their stored value.
 */
function parseProjectInput(store: WorkspaceStore, body: unknown, existing: Project | null): ProjectInput {
  const raw = (body ?? {}) as Record<string, unknown>

  let name: string | undefined
  if (raw.name !== undefined) {
    name = typeof raw.name === 'string' ? raw.name.trim() : ''
    if (!name) fail(400, 'Give the project a name.')
    if (name.length > 80) fail(400, 'Project name must be 80 characters or fewer.')
    if (store.projects.some((p) => p.id !== existing?.id && p.name.toLowerCase() === name!.toLowerCase())) {
      fail(409, `A project named "${name}" already exists.`)
    }
  } else if (existing === null) {
    fail(400, 'Give the project a name.')
  }

  let desc: string | undefined
  if (raw.desc !== undefined) {
    if (typeof raw.desc !== 'string') fail(400, 'Description must be a string.')
    desc = raw.desc.trim()
  }

  let teamAgentIds: string[] | undefined
  if (raw.teamAgentIds !== undefined) {
    if (!Array.isArray(raw.teamAgentIds) || !raw.teamAgentIds.every((s) => typeof s === 'string')) {
      fail(400, 'teamAgentIds must be a list of agent ids.')
    }
    const ids = [...new Set(raw.teamAgentIds as string[])]
    for (const id of ids) {
      if (!store.agents.some((a) => a.id === id)) fail(400, `No agent with id "${id}". Pick agents from the library.`)
    }
    teamAgentIds = ids
  }

  return { ...(name !== undefined ? { name } : {}), ...(desc !== undefined ? { desc } : {}), ...(teamAgentIds !== undefined ? { teamAgentIds } : {}) } as ProjectInput
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

  // Project task queues. Tasks a previous process left queued or running are
  // failed first (so they can be retried); closing the app waits for the
  // task runs in flight and starts no new ones.
  const tasks = createTaskRunner(store, (err) => app.log.error(err))
  app.addHook('onClose', async () => {
    await tasks.close()
  })

  app.get('/health', async () => ({ status: 'ok' }))
  app.get('/api/skills', async () => store.skills)
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
  app.get('/api/projects', async () => store.projects)

  app.post('/api/projects', async (request, reply) => {
    const input = parseProjectInput(store, request.body, null)
    const id = uid('proj')
    const now = new Date().toISOString()
    // Folder name: slug of the project name, suffixed on collision with an
    // existing project folder or a real directory on disk.
    let folder = join(store.projectsRoot, slugifyProjectName(input.name))
    for (let n = 2; store.projects.some((p) => p.folder === folder) || existsSync(folder); n++) {
      folder = join(store.projectsRoot, `${slugifyProjectName(input.name)}-${n}`)
    }
    const project: Project = {
      id,
      name: input.name,
      desc: input.desc ?? '',
      folder,
      teamAgentIds: input.teamAgentIds ?? [],
      createdAt: now,
      updatedAt: now,
    }
    try {
      mkdirSync(folder, { recursive: true })
    } catch (err) {
      fail(500, `Could not create the project folder: ${err instanceof Error ? err.message : String(err)}`)
    }
    store.projects = [...store.projects, project]
    if (!store.save()) {
      store.projects = store.projects.filter((p) => p.id !== id)
      fail(500, 'The project could not be saved. Please retry.')
    }
    return reply.status(201).send(project)
  })

  app.patch('/api/projects/:id', async (request) => {
    const { id } = request.params as { id: string }
    const existing = store.projects.find((p) => p.id === id)
    if (!existing) fail(404, `No project with id "${id}"`)
    const input = parseProjectInput(store, request.body, existing)
    const updated: Project = {
      ...existing,
      name: input.name ?? existing.name,
      desc: input.desc !== undefined ? input.desc : existing.desc,
      teamAgentIds: input.teamAgentIds !== undefined ? input.teamAgentIds : existing.teamAgentIds,
      updatedAt: new Date().toISOString(),
    }
    // Rename never moves the folder; the folder is the stable identity on disk.
    store.projects = store.projects.map((p) => (p.id === id ? updated : p))
    if (!store.save()) {
      store.projects = store.projects.map((p) => (p.id === id ? existing : p))
      fail(500, 'The project could not be saved. Please retry.')
    }
    return updated
  })

  app.delete('/api/projects/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    if (!store.projects.some((p) => p.id === id)) fail(404, `No project with id "${id}"`)
    // The record and its chat go; the folder stays on disk (removal is an
    // explicit user action, a later milestone). Its specialists stay in the
    // library, untagged; its task queue starts nothing more.
    // Its task runs go too: no route lists them once the project is gone, and
    // agents could otherwise still read them through read_run_log.
    const previousProjects = store.projects
    const previousMessages = store.projectMessages
    const previousRuns = store.runs
    const tagged = store.agents.filter((a) => a.projectId === id)
    store.projects = store.projects.filter((p) => p.id !== id)
    store.projectMessages = store.projectMessages.filter((m) => m.projectId !== id)
    store.runs = store.runs.filter((r) => r.projectId !== id)
    for (const agent of tagged) delete agent.projectId
    if (!store.save()) {
      store.projects = previousProjects
      store.projectMessages = previousMessages
      store.runs = previousRuns
      for (const agent of tagged) agent.projectId = id
      fail(500, 'The project could not be deleted from storage. Please retry.')
    }
    tasks.stop(id)
    return reply.status(204).send()
  })

  app.get('/api/projects/:id/messages', async (request) => {
    const { id } = request.params as { id: string }
    if (!store.projects.some((p) => p.id === id)) fail(404, `No project with id "${id}"`)
    return store.projectMessages
      .filter((m) => m.projectId === id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  })

  app.post('/api/projects/:id/messages', async (request, reply) => {
    const { id } = request.params as { id: string }
    // D-O11: mentions are resolved by the BE; tagging team members queues
    // direct tasks (the user's own delegation). See appendProjectMessage.
    const update = appendProjectMessage(store, id, request.body)
    return reply.status(201).send(update)
  })

  // D-P1: team-plan returns Primary's PLAN and writes nothing; the user
  // confirms it (or a part of it) and apply commits it. Cancel is client-side.
  app.post('/api/projects/:id/team-plan', async (request) => {
    const { id } = request.params as { id: string }
    return requestTeamPlan(store, id, request.body)
  })

  app.post('/api/projects/:id/team-plan/apply', async (request) => {
    const { id } = request.params as { id: string }
    return applyTeamPlan(store, tasks, id, request.body)
  })

  // Part 5: review a settled round; writes nothing until the user applies.
  app.post('/api/projects/:id/review', async (request) => {
    const { id } = request.params as { id: string }
    return requestReview(store, id, request.body)
  })

  app.post('/api/projects/:id/tasks/:messageId/retry', async (request) => {
    const { id, messageId } = request.params as { id: string; messageId: string }
    return retryTask(store, tasks, id, messageId)
  })

  app.post('/api/projects/:id/tasks/:messageId/cancel', async (request) => {
    const { id, messageId } = request.params as { id: string; messageId: string }
    return cancelTask(store, tasks, id, messageId)
  })

  // D-O5: pause starts nothing new; resume clears the flag and kicks; stop
  // aborts the in-flight call and cancels queued tasks (retryable).
  app.post('/api/projects/:id/work/pause', async (request) => {
    const { id } = request.params as { id: string }
    return pauseWork(store, id)
  })

  app.post('/api/projects/:id/work/resume', async (request) => {
    const { id } = request.params as { id: string }
    return resumeWork(store, tasks, id)
  })

  app.post('/api/projects/:id/work/stop', async (request) => {
    const { id } = request.params as { id: string }
    return stopWork(store, tasks, id)
  })

  // Part 6: one project task run (for "What it saw"). Chat-only runs and
  // runs of other projects 404. The AgentRun shape never holds vault keys.
  app.get('/api/projects/:id/runs/:runId', async (request) => {
    const { id, runId } = request.params as { id: string; runId: string }
    if (!store.projects.some((p) => p.id === id)) fail(404, `No project with id "${id}"`)
    const run = store.runs.find((r) => r.id === runId)
    if (!run || run.projectId !== id) fail(404, `No run with id "${runId}" in this project`)
    return run
  })

  app.get('/api/settings', async () => store.settings)

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
    const plan = planPrompt({
      instructions: typeof raw.instructions === 'string' ? raw.instructions.trim() : '',
      skills: attachedSkills(store.skills, skillIds),
      input: '',
      contextWindow: endpoint.contextWindow,
    })
    return {
      contextWindow: endpoint.contextWindow,
      responseReserve: RESPONSE_RESERVE,
      estimatedTokens: plan.estimatedTokens,
      mode: plan.mode,
      summarizedSkillIds: plan.summarizedSkillIds,
      toolNames: plan.toolDeclarations.map((t) => t.name),
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

  app.delete('/api/agents/:id/runs', async (request, reply) => {
    const { id } = request.params as { id: string }
    const agent = store.agents.find((a) => a.id === id)
    if (!agent) fail(404, `No agent with id "${id}"`)
    // Clears the agent's own chat; its project task runs stay (deleting the agent removes them).
    store.runs = store.runs.filter((r) => r.agentId !== id || r.projectId !== undefined)
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
    const agent: Agent = {
      id: uid('agt'),
      ...input,
      endpointId: input.endpointId,
      isPrimary,
      status: 'idle',
      createdAt: new Date().toISOString(),
      lastRunAt: null,
      runCount: 0,
    }
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
    const next: Agent = { ...current, ...input, isPrimary: transferPrimary || current.isPrimary }
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

  app.delete('/api/agents/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const agent = store.agents.find((a) => a.id === id)
    if (!agent) fail(404, `No agent with id "${id}"`)
    if (agent.isPrimary) {
      fail(409, 'Move the Team Lead role to another agent before deleting it.')
    }
    store.agents = store.agents.filter((a) => a.id !== id)
    store.runs = store.runs.filter((r) => r.agentId !== id)
    // It leaves every project team too, so a team PATCH never trips on a stale id.
    store.projects = store.projects.map((p) =>
      p.teamAgentIds.includes(id) ? { ...p, teamAgentIds: p.teamAgentIds.filter((x) => x !== id) } : p,
    )
    store.save()
    void reply.status(204)
    return null
  })

  app.get('/api/endpoints', async () =>
    store.endpoints.map((e) => ({ ...e, apiKeySet: Boolean(store.endpointKeys[e.id]) })),
  )

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
    }
    store.endpoints = [endpoint, ...store.endpoints]
    store.endpointModels[id] = [endpoint.defaultModel]
    store.save()
    void reply.status(201)
    return endpoint
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
    store.endpoints = store.endpoints.map((e, i) => (i === index ? next : e))
    const models = store.endpointModels[id] ?? []
    if (!models.includes(next.defaultModel)) store.endpointModels[id] = [...models, next.defaultModel]
    store.save()
    return next
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
    return { ok: live.ok, models: live.ok ? live.models : [], latencyMs: live.latencyMs }
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
    // Same-transaction detach: strip the id from every agent before removal.
    store.detachSkill(id)
    store.skills = store.skills.filter((s) => s.id !== id)
    store.save()
    void reply.status(204)
    return null
  })

  return app
}
