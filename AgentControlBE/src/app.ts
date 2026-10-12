import cors from '@fastify/cors'
import Fastify, { type FastifyInstance } from 'fastify'
import { createStore, type WorkspaceStore } from './store.js'
import { SkillMarkdownError, parseSkillMarkdown } from './db/skill-md.js'
import {
  chatCompletion,
  fetchModels,
  type ChatMessage,
  type ChatResult,
  type ToolDeclaration,
} from './upstream.js'
import {
  executeToolCall,
  listToolInfo,
  resolveToolDeclarations,
  type ToolContext,
  type ToolOutcome,
} from './tools.js'
import { attachedSkills, planPrompt, RESPONSE_RESERVE } from './prompt.js'
import {
  DEFAULT_ENDPOINT_BASE_URL,
  OPENROUTER_DEFAULT_BASE_URL,
  type Agent,
  type AgentInput,
  type AgentRun,
  type Endpoint,
  type EndpointInput,
  type EndpointKind,
  type PromptBudget,
  type Skill,
  type SkillInput,
  type SkillTool,
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

    // Every agent has an endpoint; no hosted fallback exists.
    const endpoint = store.endpoints.find((e) => e.id === agent.endpointId)
    if (!endpoint) fail(400, `Agent "${agent.name}" has no valid endpoint. Pick one in its settings.`)
    const baseUrl = endpoint.baseUrl
    const apiKey = store.endpointKeys[endpoint.id]
    const timeoutMs = endpoint.timeoutMs ?? 30_000

    // System prompt = instructions + the full CONTENT of attached skills, or,
    // when that leaves too little of the window, summaries of the largest
    // skills plus get_skill to read them (see planPrompt). Offered tools are
    // the registry tools the skills declare; only these may execute.
    // Empty => no `tools` key upstream (pre-tool runs stay byte-identical).
    const injectedSkills = attachedSkills(store.skills, agent.skillIds)
    const plan = planPrompt({
      instructions: agent.instructions,
      skills: injectedSkills,
      input,
      contextWindow: endpoint.contextWindow,
    })
    const system = plan.system
    const toolDeclarations: ToolDeclaration[] = plan.toolDeclarations
    const summarized = new Set(plan.summarizedSkillIds)
    const sendTools = toolDeclarations.length > 0 ? toolDeclarations : undefined
    const toolSchemaChars = sendTools ? JSON.stringify(sendTools).length : 0

    // Prior turns: the most recent successful runs become user/assistant pairs
    // (oldest first). Placeholder seed runs with empty text are skipped.
    const history = store.runs
      .filter(
        (r) =>
          r.agentId === agent.id &&
          r.status === 'succeeded' &&
          r.input.trim() !== '' &&
          r.output.trim() !== '',
      )
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, 10)
      .reverse()

    // Context budget: a crude chars/4 estimate (no tokenizer dep) checked against
    // the endpoint's context window. Reserve room for the response, then drop the
    // oldest history turns until the prompt fits. The system prompt + this input
    // can't be trimmed, so if they alone overflow, reject with 413. Tool results
    // count toward the estimate and the whole check re-runs each loop iteration.
    // Tool-call turns (assistant content + call arguments) and tool results
    // count too, as do the tool schemas on calls that send them.
    const contextWindow = endpoint.contextWindow
    let loopChars = 0
    const estimate = (turns: AgentRun[], withSchemas: boolean): number => {
      let chars = system.length + input.length + loopChars + (withSchemas ? toolSchemaChars : 0)
      for (const t of turns) chars += t.input.length + t.output.length
      return Math.ceil(chars / 4)
    }

    // Tool loop: bounded by MAX_TOOL_ITERATIONS tool-enabled calls, then one
    // final tools-off call. Unknown tools / bad JSON come back as tool messages
    // so the model can recover; they never 500 the run.
    // Per-run caps keep one looping model from flooding the store or the
    // event loop; over-cap calls are still answered (every tool_call_id must be).
    const MAX_TOOL_ITERATIONS = 4
    const MAX_CALLS_PER_TURN = 8
    const MAX_CALLS_PER_RUN = 16
    const TOOL_RESULT_MAX_CHARS = 4_000
    const MIN_TOOL_RESULT_CHARS = 300
    const AUDIT_ARGUMENT_MAX_CHARS = 1_000
    const DIRECT_ANSWER_INSTRUCTION =
      'Tool use is no longer available. Answer the user directly in plain text now.'

    const loopMessages: ChatMessage[] = []
    const toolAudit: NonNullable<AgentRun['toolCalls']> = []
    let totalLatency = 0
    let steps = 0
    let exhausted = false
    let contextExhausted = false
    let forceFinal = false
    let callsThisRun = 0
    let result: ChatResult | undefined

    const runId = uid('run')
    const toolCtx: ToolContext = {
      store,
      agentId: agent.id,
      runId,
      input,
      allowed: new Set(toolDeclarations.map((t) => t.name)),
      now: () => new Date(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      writes: { count: 0 },
    }

    const startedAt = new Date().toISOString()
    for (let iteration = 0; ; iteration++) {
      const finalCall = iteration >= MAX_TOOL_ITERATIONS || forceFinal
      const withSchemas = !finalCall && sendTools !== undefined
      const systemText =
        finalCall && system ? `${system}\n\n${DIRECT_ANSWER_INSTRUCTION}` : system

      let turns = history
      let estimated = estimate(turns, withSchemas)
      while (estimated + RESPONSE_RESERVE > contextWindow && turns.length > 0) {
        turns = turns.slice(1)
        estimated = estimate(turns, withSchemas)
      }
      const baseEstimated = estimate([], withSchemas)
      if (baseEstimated + RESPONSE_RESERVE > contextWindow) {
        if (toolAudit.length === 0) {
          fail(
            413,
            `Prompt too large for this endpoint's context window: about ${baseEstimated} tokens of prompt ` +
              `plus ${RESPONSE_RESERVE} reserved for the reply exceed the ${contextWindow}-token window. ` +
              "Detach skills, shorten the instructions or the message, or raise the endpoint's context window in Settings.",
          )
        }
        // Tools already ran (and may have written notes): never drop the run.
        // Retry as the tools-off final call; if even that overflows, record a failure.
        if (!finalCall) {
          forceFinal = true
          continue
        }
        contextExhausted = true
        break
      }
      const maxTokens = Math.min(RESPONSE_RESERVE, contextWindow - estimated)

      const messages: ChatMessage[] = []
      if (systemText) messages.push({ role: 'system', content: systemText })
      for (const turn of turns) {
        messages.push({ role: 'user', content: turn.input })
        messages.push({ role: 'assistant', content: turn.output })
      }
      messages.push({ role: 'user', content: input })
      messages.push(...loopMessages)

      result = await chatCompletion(
        baseUrl,
        apiKey,
        agent.modelId,
        messages,
        timeoutMs,
        maxTokens,
        finalCall ? undefined : sendTools,
        agent.temperature,
      )
      steps += 1
      totalLatency += result.latencyMs

      if (!result.ok) break
      if (result.toolCalls && result.toolCalls.length > 0) {
        if (finalCall) {
          exhausted = true
          break
        }
        loopMessages.push({ role: 'assistant', content: result.content, toolCalls: result.toolCalls })
        loopChars += result.content.length
        for (const call of result.toolCalls) loopChars += call.name.length + call.arguments.length
        let callsThisTurn = 0
        for (const call of result.toolCalls) {
          callsThisTurn += 1
          let outcome: ToolOutcome
          if (callsThisTurn > MAX_CALLS_PER_TURN || callsThisRun >= MAX_CALLS_PER_RUN) {
            outcome = {
              ok: false,
              content: `Too many tool calls: at most ${MAX_CALLS_PER_TURN} per turn and ${MAX_CALLS_PER_RUN} per run. Answer with what you have.`,
            }
          } else {
            callsThisRun += 1
            outcome = await executeToolCall(call, toolCtx)
          }
          // Clip to what the context window still holds; when almost nothing is
          // left, say so and make the next call the tools-off final call.
          const remainingChars = (contextWindow - RESPONSE_RESERVE - estimate([], true)) * 4
          const limit = Math.min(TOOL_RESULT_MAX_CHARS, remainingChars - 400)
          let content = outcome.content
          let ok = outcome.ok
          if (content.length > limit) {
            if (limit < MIN_TOOL_RESULT_CHARS) {
              content = 'Context budget exhausted; answer with what you have.'
              ok = false
              forceFinal = true
            } else {
              const marker = '…[truncated]'
              content = `${content.slice(0, Math.max(0, limit - marker.length))}${marker}`
            }
          }
          loopChars += content.length
          loopMessages.push({ role: 'tool', content, toolCallId: call.id })
          toolAudit.push({
            name: call.name,
            arguments:
              call.arguments.length > AUDIT_ARGUMENT_MAX_CHARS
                ? `${call.arguments.slice(0, AUDIT_ARGUMENT_MAX_CHARS)}…[truncated]`
                : call.arguments,
            resultChars: content.length,
            ok,
          })
        }
        continue
      }
      break
    }

    const upstream = result as ChatResult
    const failed = exhausted || contextExhausted || !upstream.ok
    const run: AgentRun = {
      id: runId,
      agentId: agent.id,
      startedAt,
      status: failed ? 'failed' : 'succeeded',
      durationMs: totalLatency,
      steps,
      input,
      output: failed ? '' : upstream.content,
      error: failed
        ? exhausted
          ? `Tool-call loop exhausted after ${MAX_TOOL_ITERATIONS} iterations; the model kept requesting tools.`
          : contextExhausted
            ? "Context exhausted by tool results: the conversation no longer fits this endpoint's context window."
            : (upstream.error ?? 'Request failed')
        : null,
      // Audit: exactly what went upstream. Failed runs record it too —
      // injection happens before the upstream call.
      systemPrompt: system,
      skillSnapshot: injectedSkills.map((s) => ({
        id: s.id,
        name: s.name,
        contentChars: s.content.length,
        mode: summarized.has(s.id) ? ('summary' as const) : ('full' as const),
      })),
      ...(toolAudit.length > 0 ? { toolCalls: toolAudit } : {}),
    }

    // Prepend, then trim this agent's history to the newest 50.
    store.runs = [run, ...store.runs]
    const mine = store.runs.filter((r) => r.agentId === agent.id)
    if (mine.length > 50) {
      const drop = new Set(mine.slice(50).map((r) => r.id))
      store.runs = store.runs.filter((r) => !drop.has(r.id))
    }
    agent.lastRunAt = run.startedAt
    agent.runCount += 1
    agent.status = run.status === 'succeeded' ? 'idle' : 'error'
    const persisted = store.save()
    // Never report a successful run as stored when the write actually failed.
    if (!persisted && run.status === 'succeeded') {
      fail(500, 'Run completed but its result could not be persisted.')
    }
    return run
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
    return store.runs
      .filter((r) => r.agentId === id)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, 50)
  })

  app.delete('/api/agents/:id/runs', async (request, reply) => {
    const { id } = request.params as { id: string }
    const agent = store.agents.find((a) => a.id === id)
    if (!agent) fail(404, `No agent with id "${id}"`)
    store.runs = store.runs.filter((r) => r.agentId !== id)
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
      ...(input.timeoutMs !== undefined ? { timeoutMs: Math.floor(input.timeoutMs) } : {}),
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
      ...(merged.timeoutMs !== undefined ? { timeoutMs: Math.floor(merged.timeoutMs) } : {}),
    }
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
