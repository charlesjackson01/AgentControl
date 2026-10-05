import cors from '@fastify/cors'
import Fastify, { type FastifyInstance } from 'fastify'
import { createStore, type WorkspaceStore } from './store.js'
import { chatCompletion, fetchModels, type ChatMessage } from './upstream.js'
import {
  OPENROUTER_DEFAULT_BASE_URL,
  type Agent,
  type AgentInput,
  type AgentRun,
  type Endpoint,
  type EndpointInput,
  type EndpointKind,
  type Skill,
} from './shared/types.js'

function fail(status: number, message: string): never {
  const err = new Error(message) as Error & { statusCode: number }
  err.statusCode = status
  throw err
}

function uid(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`
}

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
    fail(400, 'Base URL must be a valid http(s) URL, e.g. http://127.0.0.1:8080.')
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
}

function parseAgentInput(store: WorkspaceStore, body: unknown): AgentInput {
  const raw = (body ?? {}) as Record<string, unknown>
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (!name) fail(400, 'Give the agent a name.')

  const endpointId = typeof raw.endpointId === 'string' && raw.endpointId !== '' ? raw.endpointId : null
  const modelId = typeof raw.modelId === 'string' ? raw.modelId.trim() : ''
  if (!modelId) fail(400, 'Pick a model to run this agent on.')

  if (endpointId !== null) {
    const endpoint = store.endpoints.find((e) => e.id === endpointId)
    if (!endpoint) fail(404, `No endpoint with id "${endpointId}"`)
    const served = store.endpointModels[endpoint.id] ?? []
    if (served.length > 0 && !served.includes(modelId) && modelId !== endpoint.defaultModel) {
      fail(400, `Model "${modelId}" is not served by this endpoint.`)
    }
  } else if (!store.models.some((m) => m.id === modelId)) {
    fail(400, `Unknown hosted model "${modelId}".`)
  }

  const skillIds = Array.isArray(raw.skillIds)
    ? raw.skillIds.filter((s): s is string => typeof s === 'string')
    : []

  return {
    name,
    description: typeof raw.description === 'string' ? raw.description.trim() : '',
    instructions: typeof raw.instructions === 'string' ? raw.instructions.trim() : '',
    modelId,
    endpointId,
    skillIds,
  }
}

export function buildApp(store: WorkspaceStore = createStore()): FastifyInstance {
  const app = Fastify({ logger: true })

  // Reflect the request origin so the app works from localhost, LAN, and
  // Tailscale alike. Set CORS_ORIGINS (comma-separated) to pin an allowlist.
  const corsOrigins = process.env.CORS_ORIGINS
  app.register(cors, {
    origin: corsOrigins
      ? corsOrigins.split(',').map((o) => o.trim()).filter(Boolean)
      : true,
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

  app.get('/health', async () => ({ status: 'ok' }))
  app.get('/api/models', async () => store.models)
  app.get('/api/skills', async () => store.skills)
  app.get('/api/projects', async () => store.projects)
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

    // Resolve transport: attached endpoint (key from the vault) or hosted default.
    let baseUrl: string | undefined
    let apiKey: string | undefined
    if (agent.endpointId !== null) {
      const endpoint = store.endpoints.find((e) => e.id === agent.endpointId)
      if (!endpoint) fail(404, `No endpoint with id "${agent.endpointId}"`)
      baseUrl = endpoint.baseUrl
      apiKey = store.endpointKeys[endpoint.id]
    } else {
      baseUrl = process.env.HOSTED_BASE_URL
      apiKey = process.env.HOSTED_API_KEY
    }

    // System prompt = instructions + the content of attached skills.
    const skillLines = agent.skillIds
      .map((sid) => store.skills.find((s) => s.id === sid))
      .filter((s): s is Skill => s !== undefined)
      .map((s) => `- ${s.name}: ${s.description}`)
    const system = [agent.instructions, skillLines.length > 0 ? `Skills:\n${skillLines.join('\n')}` : '']
      .filter(Boolean)
      .join('\n\n')
    const messages: ChatMessage[] = []
    if (system) messages.push({ role: 'system', content: system })
    messages.push({ role: 'user', content: input })

    const startedAt = new Date().toISOString()
    let run: AgentRun
    if (!baseUrl) {
      run = {
        id: uid('run'),
        agentId: agent.id,
        startedAt,
        status: 'failed',
        durationMs: 0,
        steps: 0,
        input,
        output: '',
        error: 'No endpoint configured for this agent. Attach an endpoint or set HOSTED_BASE_URL.',
      }
    } else {
      const result = await chatCompletion(baseUrl, apiKey, agent.modelId, messages, 30_000)
      run = {
        id: uid('run'),
        agentId: agent.id,
        startedAt,
        status: result.ok ? 'succeeded' : 'failed',
        durationMs: result.latencyMs,
        steps: 1,
        input,
        output: result.content,
        error: result.ok ? null : (result.error ?? 'Request failed'),
      }
    }

    // Newest first, capped so history cannot grow without bound.
    agent.recentRuns = [run, ...agent.recentRuns].slice(0, 50)
    agent.lastRunAt = run.startedAt
    agent.runCount += 1
    agent.status = run.status === 'succeeded' ? 'idle' : 'error'
    store.save()
    return run
  })

  app.get('/api/agents/:id/runs', async (request) => {
    const { id } = request.params as { id: string }
    const agent = store.agents.find((a) => a.id === id)
    if (!agent) fail(404, `No agent with id "${id}"`)
    return agent.recentRuns
  })

  app.post('/api/agents', async (request, reply) => {
    const input = parseAgentInput(store, request.body)
    const agent: Agent = {
      id: uid('agt'),
      ...input,
      status: 'idle',
      createdAt: new Date().toISOString(),
      lastRunAt: null,
      runCount: 0,
      recentRuns: [],
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
    const input = parseAgentInput(store, request.body)
    const next: Agent = { ...(store.agents[index] as Agent), ...input }
    store.agents = store.agents.map((a, i) => (i === index ? next : a))
    store.save()
    return next
  })

  app.delete('/api/agents/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const next = store.agents.filter((a) => a.id !== id)
    if (next.length === store.agents.length) fail(404, `No agent with id "${id}"`)
    store.agents = next
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
    }
    assertEndpointInput(input, '')
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
    }
    assertEndpointInput(merged, store.endpointKeys[id] ?? '')
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
    }
    store.endpoints = store.endpoints.map((e, i) => (i === index ? next : e))
    const models = store.endpointModels[id] ?? []
    if (!models.includes(next.defaultModel)) store.endpointModels[id] = [...models, next.defaultModel]
    store.save()
    return next
  })

  app.delete('/api/endpoints/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    if (store.agents.some((a) => a.endpointId === id)) {
      fail(409, 'This endpoint is still attached to an agent. Move those agents first.')
    }
    const next = store.endpoints.filter((e) => e.id !== id)
    if (next.length === store.endpoints.length) fail(404, `No endpoint with id "${id}"`)
    store.endpoints = next
    delete store.endpointModels[id]
    delete store.endpointKeys[id]
    store.save()
    void reply.status(204)
    return null
  })

  app.get('/api/endpoints/:id/models', async (request) => {
    const { id } = request.params as { id: string }
    const endpoint = store.endpoints.find((e) => e.id === id)
    if (!endpoint) fail(404, `No endpoint with id "${id}"`)
    const live = await fetchModels(endpoint.baseUrl, store.endpointKeys[id])
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
    const live = await fetchModels(endpoint.baseUrl, store.endpointKeys[id])
    endpoint.status = live.ok ? 'reachable' : 'unreachable'
    endpoint.lastCheckedAt = new Date().toISOString()
    if (live.ok) store.endpointModels[id] = live.models
    store.save()
    return { ok: live.ok, models: live.ok ? live.models : [], latencyMs: live.latencyMs }
  })

  return app
}
