import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { catalogLine } from './prompt.js'
import { buildApp } from './app.js'
import { createStore, type WorkspaceStore } from './store.js'
import type { Agent, AgentRun, ChatMessage, Conversation, ConversationSummary, Endpoint, Note, Skill } from './shared/types.js'
import { DEFAULT_ENDPOINT_BASE_URL } from './shared/types.js'
import { seedEndpointModels, seedEndpoints, seedSkills, vendoredSeedSkills } from './db/seed.js'
import { builtinTools, executeToolCall, toolDeclaration, type ToolEntry } from './tools.js'
import { FILE_TOOL_NAMES } from './tools/files.js'

/** BE-3: chars/4 of the file tools' schema JSON, which every run now carries. */
const FILE_TOOL_TOKENS = Math.ceil(JSON.stringify(FILE_TOOL_NAMES.map((n) => toolDeclaration(n))).length / 4)

/**
 * Hermetic HTTP tests via fastify.inject() — no sockets, no real network.
 * Each test gets a throwaway store under a temp dir, and the vault is keyed
 * from a fixed secret so no DPAPI/PowerShell is involved.
 */

let dir = ''
let app: FastifyInstance
let store: WorkspaceStore

async function inject(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
) {
  return app.inject({
    method,
    url,
    payload: payload as object | undefined,
    headers: { 'content-type': 'application/json' },
  })
}

function mockChat(content: string) {
  const mock = vi.fn(async (_url: string, _init?: { body?: string }) => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ index: 0, message: { role: 'assistant', content } }] }),
  }))
  vi.stubGlobal('fetch', mock)
  return mock
}

type ChatRequest = {
  model?: string
  messages?: {
    role: string
    content: string
    tool_call_id?: string
    tool_calls?: { id: string; type?: string; function?: { name?: string; arguments?: string } }[]
  }[]
  max_tokens?: number
  temperature?: number
  tools?: unknown
}

/** Parse the body of the most recent mocked fetch call. */
function lastRequest(mock: ReturnType<typeof mockChat>): ChatRequest {
  const call = mock.mock.calls[mock.mock.calls.length - 1]
  return JSON.parse(call?.[1]?.body ?? '{}') as ChatRequest
}

/** Upstream that answers each call from a scripted sequence. */
function mockChatSequence(responses: unknown[]) {
  const mock = vi.fn(async (_url: string, _init?: { body?: string }) => ({
    ok: true,
    status: 200,
    json: async () =>
      responses.shift() ?? { choices: [{ index: 0, message: { role: 'assistant', content: 'done' } }] },
  }))
  vi.stubGlobal('fetch', mock)
  return mock
}

function toolCallResponse(name: string, args = '{}', id = 'call_1') {
  return {
    choices: [
      {
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ id, type: 'function', function: { name, arguments: args } }],
        },
      },
    ],
  }
}

function contentResponse(content: string) {
  return { choices: [{ index: 0, message: { role: 'assistant', content } }] }
}

/** Agent attached to a skill that declares the given built-in tool names. */
async function makeToolRunner(toolNames: string[]) {
  const sk = await inject('POST', '/api/skills', {
    name: 'Workspace tools',
    description: 'Workspace introspection.',
    content: 'Use the workspace tools when helpful.',
    tools: toolNames.map((name) => ({ name, description: `Built-in ${name}` })),
  })
  expect(sk.statusCode).toBe(201)
  const skillId = (sk.json() as Skill).id

  const ep = await inject('POST', '/api/endpoints', {
    kind: 'openai-compatible',
    name: 'Tool endpoint',
    baseUrl: 'http://127.0.0.1:9',
    defaultModel: 'test-model',
    contextWindow: 8192,
  })
  const endpointId = (ep.json() as Endpoint).id
  const ag = await inject('POST', '/api/agents', {
    name: 'Tool Runner',
    description: '',
    instructions: 'Be brief.',
    modelId: 'test-model',
    endpointId,
    skillIds: [skillId],
  })
  expect(ag.statusCode).toBe(201)
  return { agent: ag.json() as Agent, endpointId }
}

async function makeRunner() {
  const ep = await inject('POST', '/api/endpoints', {
    kind: 'openai-compatible',
    name: 'Test endpoint',
    baseUrl: 'http://127.0.0.1:9',
    defaultModel: 'test-model',
    contextWindow: 8192,
  })
  expect(ep.statusCode).toBe(201)
  const endpoint = ep.json() as Endpoint

  const ag = await inject('POST', '/api/agents', {
    name: 'Runner',
    description: '',
    instructions: 'Be brief.',
    modelId: 'test-model',
    endpointId: endpoint.id,
    skillIds: ['core/summarization'],
  })
  expect(ag.statusCode).toBe(201)
  return { endpoint, agent: ag.json() as Agent }
}

beforeEach(() => {
  process.env.AGENTCONTROL_SECRET = 'test-secret'
  dir = mkdtempSync(join(tmpdir(), 'agentcontrol-test-'))
  store = createStore(join(dir, 'store.json'))
  app = buildApp(store)
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await app.close()
  rmSync(dir, { recursive: true, force: true })
  delete process.env.AGENTCONTROL_SECRET
})

describe('agents CRUD', () => {
  it('round-trips create/get/list/update/delete', async () => {
    // A fresh store has no agents, so create the Team Lead first (the CRUD agent
    // must not be primary or it could not be deleted).
    const lead = await inject('POST', '/api/agents', {
      name: 'Team Lead',
      description: '',
      instructions: '',
      modelId: 'llama-3-8b',
      endpointId: 'ep_local_llama',
      isPrimary: true,
      skillIds: [],
    })
    expect(lead.statusCode).toBe(201)

    const ep = await inject('POST', '/api/endpoints', {
      kind: 'openai-compatible',
      name: 'CRUD endpoint',
      baseUrl: 'http://127.0.0.1:9',
      defaultModel: 'crud-model',
      contextWindow: 4096,
    })
    const endpoint = ep.json() as Endpoint

    const create = await inject('POST', '/api/agents', {
      name: 'Crud Agent',
      description: 'd',
      instructions: 'i',
      modelId: 'crud-model',
      endpointId: endpoint.id,
      skillIds: ['core/summarization'],
    })
    expect(create.statusCode).toBe(201)
    const agent = create.json() as Agent
    expect(agent.id).toBeTruthy()
    expect(agent.status).toBe('idle')
    expect(agent.endpointId).toBe(endpoint.id)
    expect(agent.isPrimary).toBe(false)
    expect(agent).not.toHaveProperty('recentRuns')

    const got = await inject('GET', `/api/agents/${agent.id}`)
    expect(got.statusCode).toBe(200)
    expect((got.json() as Agent).name).toBe('Crud Agent')
    expect(got.json()).not.toHaveProperty('recentRuns')

    const upd = await inject('PUT', `/api/agents/${agent.id}`, {
      name: 'Crud Agent v2',
      description: 'd2',
      instructions: 'i2',
      modelId: 'crud-model',
      endpointId: endpoint.id,
      skillIds: ['core/summarization', 'core/debugging'],
    })
    expect(upd.statusCode).toBe(200)
    expect((upd.json() as Agent).name).toBe('Crud Agent v2')

    const list = await inject('GET', '/api/agents')
    expect(list.statusCode).toBe(200)
    expect((list.json() as Agent[]).some((a) => a.id === agent.id)).toBe(true)

    expect((await inject('DELETE', `/api/agents/${agent.id}`)).statusCode).toBe(204)
    expect((await inject('GET', `/api/agents/${agent.id}`)).statusCode).toBe(404)
  })

  it('rejects saving an agent with no endpoint (400)', async () => {
    const res = await inject('POST', '/api/agents', {
      name: 'No endpoint',
      description: '',
      instructions: '',
      modelId: 'gpt-5.2',
      skillIds: [],
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('POST /api/agents/:id/runs', () => {
  it('succeeds with mocked upstream and persists error: null', async () => {
    mockChat('hello there')
    const { agent } = await makeRunner()
    const res = await inject('POST', `/api/agents/${agent.id}/runs`, { input: 'hi' })
    expect(res.statusCode).toBe(200)

    const run = res.json() as AgentRun
    expect(run.status).toBe('succeeded')
    expect(run.output).toBe('hello there')
    expect(run.error).toBeNull()
    expect(run.agentId).toBe(agent.id)
    expect(run.input).toBe('hi')

    // Persisted in the store and readable via GET.
    expect(store.runs.find((r) => r.id === run.id)?.error).toBeNull()
    const listed = await inject('GET', `/api/agents/${agent.id}/runs`)
    expect((listed.json() as AgentRun[])[0]?.id).toBe(run.id)
  })

  it('records a string error on upstream failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down')
      }),
    )
    const { agent } = await makeRunner()
    const res = await inject('POST', `/api/agents/${agent.id}/runs`, { input: 'hi' })
    expect(res.statusCode).toBe(200)

    const run = res.json() as AgentRun
    expect(run.status).toBe('failed')
    expect(typeof run.error).toBe('string')
    expect(run.error).toContain('network down')
    expect(run.output).toBe('')
    expect(store.runs.find((r) => r.id === run.id)?.error).toContain('network down')
  })

  it('404s for an unknown agent', async () => {
    mockChat('x')
    expect((await inject('POST', '/api/agents/nope/runs', { input: 'hi' })).statusCode).toBe(404)
  })

  it('404s on the old /run path (Task 2b regression)', async () => {
    mockChat('x')
    const { agent } = await makeRunner()
    expect((await inject('POST', `/api/agents/${agent.id}/run`, { input: 'hi' })).statusCode).toBe(404)
  })

  it('400s without an input', async () => {
    mockChat('x')
    const { agent } = await makeRunner()
    expect((await inject('POST', `/api/agents/${agent.id}/runs`, {})).statusCode).toBe(400)
  })

  it('lists the skill in the catalog (never its body) and offers only activate_skill', async () => {
    const mock = mockChat('ok')
    const { agent } = await makeRunner() // attached: the real "summarization" seed
    // The seed now declares tools; with them cleared it is a content-only skill.
    store.skills.find((s) => s.id === 'core/summarization')!.tools = []
    const res = await inject('POST', `/api/agents/${agent.id}/runs`, { input: 'hi' })
    expect(res.statusCode).toBe(200)

    const req = lastRequest(mock)
    const system = req.messages?.[0]?.content ?? ''
    const skill = store.skills.find((s) => s.id === 'core/summarization') as Skill
    expect(system).toContain('Be brief.')
    expect(system).toContain('Skills (call activate_skill to use one):\n- core/summarization: ')
    expect(system).toContain(catalogLine(skill))
    expect(system).not.toContain(skill.content.slice(0, 120))
    expect((req as { tools?: { function: { name: string } }[] }).tools?.map((t) => t.function.name)).toEqual(['activate_skill', 'remember', ...FILE_TOOL_NAMES])
  })
})

describe('run audit fields', () => {
  it('records systemPrompt and skillSnapshot for an injected skill', async () => {
    const mock = mockChat('ok')
    const { agent } = await makeRunner() // attached: the real "summarization" seed
    const res = await inject('POST', `/api/agents/${agent.id}/runs`, { input: 'hi' })
    expect(res.statusCode).toBe(200)

    const run = res.json() as AgentRun
    const skill = store.skills.find((s) => s.id === 'core/summarization') as Skill
    expect(run.systemPrompt).toContain('Be brief.')
    expect(run.systemPrompt).toContain('- core/summarization: ')
    expect(run.systemPrompt).not.toContain(skill.content.slice(0, 120))
    expect(run.skillSnapshot).toEqual([
      { id: 'core/summarization', name: 'summarization', contentChars: skill.content.length, mode: 'catalog' },
    ])

    // Byte-identical to what went upstream.
    expect(lastRequest(mock).messages?.[0]?.content).toBe(run.systemPrompt)

    // GET returns the fields whole (no field-picking strips them).
    const listed = (await inject('GET', `/api/agents/${agent.id}/runs`)).json() as AgentRun[]
    expect(listed[0]?.systemPrompt).toBe(run.systemPrompt)
    expect(listed[0]?.skillSnapshot).toEqual(run.skillSnapshot)
  })

  it('systemPrompt is just the instructions (or "") with no skills', async () => {
    mockChat('ok')
    const ep = await inject('POST', '/api/endpoints', {
      kind: 'openai-compatible',
      name: 'Audit endpoint',
      baseUrl: 'http://127.0.0.1:9',
      defaultModel: 'm',
      contextWindow: 8192,
    })
    const endpointId = (ep.json() as Endpoint).id
    const ag = await inject('POST', '/api/agents', {
      name: 'No skills',
      description: '',
      instructions: 'Only instructions.',
      modelId: 'm',
      endpointId,
      skillIds: [],
    })
    const run1 = (await inject('POST', `/api/agents/${(ag.json() as Agent).id}/runs`, { input: 'hi' })).json() as AgentRun
    expect(run1.systemPrompt).toBe('Only instructions.')
    expect(run1.skillSnapshot).toEqual([])

    const ag2 = await inject('POST', '/api/agents', {
      name: 'No skills no instructions',
      description: '',
      instructions: '',
      modelId: 'm',
      endpointId,
      skillIds: [],
    })
    const run2 = (await inject('POST', `/api/agents/${(ag2.json() as Agent).id}/runs`, { input: 'hi' })).json() as AgentRun
    expect(run2.systemPrompt).toBe('')
    expect(run2.skillSnapshot).toEqual([])
  })

  it('excludes dangling skill ids from the snapshot and the prompt', async () => {
    mockChat('ok')
    const ag = await inject('POST', '/api/agents', {
      name: 'Dangling',
      description: '',
      instructions: 'Base.',
      modelId: 'llama-3-8b',
      endpointId: 'ep_local_llama',
      skillIds: ['deleted-skill'],
    })
    const run = (await inject('POST', `/api/agents/${(ag.json() as Agent).id}/runs`, { input: 'hi' })).json() as AgentRun
    expect(run.skillSnapshot).toEqual([])
    expect(run.systemPrompt).toBe('Base.')
    expect(run.systemPrompt).not.toContain('##')
  })

  it('failed runs record the audit fields too', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down')
      }),
    )
    const { agent } = await makeRunner()
    const run = (await inject('POST', `/api/agents/${agent.id}/runs`, { input: 'hi' })).json() as AgentRun
    expect(run.status).toBe('failed')
    expect(run.systemPrompt).toContain('- core/summarization: ')
    expect(run.skillSnapshot).toHaveLength(1)
  })
})

describe('GET /api/agents/:id/runs', () => {
  it('returns newest-first and caps at 50', async () => {
    mockChat('ok')
    const { agent } = await makeRunner()

    const created: string[] = []
    for (let i = 0; i < 51; i++) {
      const res = await inject('POST', `/api/agents/${agent.id}/runs`, { input: `msg ${i}` })
      expect(res.statusCode).toBe(200)
      created.push((res.json() as AgentRun).id)
    }

    const res = await inject('GET', `/api/agents/${agent.id}/runs`)
    expect(res.statusCode).toBe(200)
    const runs = res.json() as AgentRun[]
    expect(runs).toHaveLength(50)
    expect(runs[0]?.id).toBe(created[50])
    expect(runs.some((r) => r.id === created[0])).toBe(false)
  })

  it('404s for an unknown agent', async () => {
    expect((await inject('GET', '/api/agents/nope/runs')).statusCode).toBe(404)
  })
})

describe('multi-turn context', () => {
  it('sends prior successful runs as user/assistant pairs', async () => {
    const mock = mockChat('answer')
    const { agent } = await makeRunner()
    await inject('POST', `/api/agents/${agent.id}/runs`, { input: 'first' })
    await inject('POST', `/api/agents/${agent.id}/runs`, { input: 'second' })
    await inject('POST', `/api/agents/${agent.id}/runs`, { input: 'third' })

    const { messages } = lastRequest(mock)
    expect(messages?.[0]?.role).toBe('system')
    expect(messages?.slice(1)).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'third' },
    ])
  })

  it('excludes failed runs from context', async () => {
    const mock = mockChat('ok')
    const { agent } = await makeRunner()
    await inject('POST', `/api/agents/${agent.id}/runs`, { input: 'good' })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('boom')
      }),
    )
    await inject('POST', `/api/agents/${agent.id}/runs`, { input: 'bad' })
    vi.stubGlobal('fetch', mock)
    await inject('POST', `/api/agents/${agent.id}/runs`, { input: 'again' })

    const { messages } = lastRequest(mock)
    expect(messages?.slice(1)).toEqual([
      { role: 'user', content: 'good' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'again' },
    ])
  })

  it('caps prior context at the last 10 successful runs', async () => {
    const mock = mockChat('r')
    const { agent } = await makeRunner()
    for (let i = 0; i < 15; i++) {
      await inject('POST', `/api/agents/${agent.id}/runs`, { input: `m${i}` })
    }

    const { messages } = lastRequest(mock)
    expect(messages).toHaveLength(22) // system + 10 pairs + new input
    expect(messages?.[1]).toEqual({ role: 'user', content: 'm4' })
    expect(messages?.[messages.length - 1]).toEqual({ role: 'user', content: 'm14' })
  })
})

describe('context budget before upstream', () => {
  async function makeBudgetRunner(contextWindow: number) {
    const ep = await inject('POST', '/api/endpoints', {
      kind: 'openai-compatible',
      name: 'Budget endpoint',
      baseUrl: 'http://127.0.0.1:9',
      defaultModel: 'm',
      contextWindow,
    })
    const endpointId = (ep.json() as Endpoint).id
    const ag = await inject('POST', '/api/agents', {
      name: 'Budget agent',
      description: '',
      instructions: '',
      modelId: 'm',
      endpointId,
      skillIds: [],
    })
    const id = (ag.json() as Agent).id
    // Budget arithmetic only: keep the remember tool out of the prompt.
    store.agents.find((a) => a.id === id)!.memoryLearn = false
    return id
  }

  it('drops oldest history turns and keeps the newest', async () => {
    // 400-char turns => 200 tokens each. Window fits system+input+reserve plus
    // exactly two turns, so a five-turn history trims down to the two newest.
    const mock = mockChat('A'.repeat(400))
    const agentId = await makeBudgetRunner(4600 + FILE_TOOL_TOKENS)

    const mk = (i: number): string => `u${i}`.padEnd(400, 'x')
    const hist: string[] = []
    for (let i = 1; i <= 5; i++) {
      const text = mk(i)
      hist.push(text)
      expect((await inject('POST', `/api/agents/${agentId}/runs`, { input: text })).statusCode).toBe(200)
    }

    const res = await inject('POST', `/api/agents/${agentId}/runs`, { input: 'q' })
    expect(res.statusCode).toBe(200)

    const { messages } = lastRequest(mock)
    // No system prompt (empty instructions, no skills): 2 kept pairs + new input.
    expect(messages).toHaveLength(5)
    expect(messages?.map((m) => m.content)).toEqual([hist[3], 'A'.repeat(400), hist[4], 'A'.repeat(400), 'q'])
    for (const dropped of hist.slice(0, 3)) {
      expect(messages?.some((m) => m.content === dropped)).toBe(false)
    }
  })

  it('413s when system + input alone overflow the window', async () => {
    mockChat('ok')
    const agentId = await makeBudgetRunner(100)
    const res = await inject('POST', `/api/agents/${agentId}/runs`, { input: 'x'.repeat(1000) })
    expect(res.statusCode).toBe(413)
    // ceil((1000 + file tool schema) / 4) estimated, plus the reply reserve, against a 100-token window.
    const { message } = res.json() as { message: string }
    const schemaChars = JSON.stringify(FILE_TOOL_NAMES.map((n) => toolDeclaration(n))).length
    expect(message).toContain("Prompt too large for this endpoint's context window")
    expect(message).toContain(`about ${Math.ceil((1000 + schemaChars) / 4)} tokens of prompt plus 4096 reserved for the reply exceed the 100-token window`)
  })

  it('sends an explicit max_tokens in the upstream payload', async () => {
    const mock = mockChat('ok')
    const { agent } = await makeRunner() // 8192-token window
    expect((await inject('POST', `/api/agents/${agent.id}/runs`, { input: 'hi' })).statusCode).toBe(200)

    const req = lastRequest(mock)
    const estimated = Math.ceil((req.messages ?? []).reduce((n, m) => n + m.content.length, 0) / 4)
    expect(typeof req.max_tokens).toBe('number')
    expect(req.max_tokens).toBe(Math.min(4096, 8192 - estimated))
    expect(req.max_tokens! + estimated).toBeLessThanOrEqual(8192)
  })
})

describe('tool execution loop', () => {
  it('runs the tool loop and feeds the tool result back upstream', async () => {
    const mock = mockChatSequence([toolCallResponse('list_skills'), contentResponse('all good')])
    const { agent } = await makeToolRunner(['list_skills'])
    const res = await inject('POST', `/api/agents/${agent.id}/runs`, { input: 'what skills exist?' })
    expect(res.statusCode).toBe(200)
    const run = res.json() as AgentRun
    expect(run.status).toBe('succeeded')
    expect(run.output).toBe('all good')
    expect(mock).toHaveBeenCalledTimes(2)

    // Call 1 advertised the declared tool in OpenAI function format, with the
    // registry's current description and schema (not the skill's stored copy).
    const first = JSON.parse(mock.mock.calls[0]?.[1]?.body ?? '{}') as ChatRequest
    const decl = toolDeclaration('list_skills')
    const activate = toolDeclaration('activate_skill')
    expect(first.tools).toEqual([
      {
        type: 'function',
        function: { name: 'list_skills', description: decl?.description, parameters: decl?.parameters },
      },
      {
        type: 'function',
        function: { name: 'activate_skill', description: activate?.description, parameters: activate?.parameters },
      },
      {
        type: 'function',
        function: { name: 'remember', description: toolDeclaration('remember')?.description, parameters: toolDeclaration('remember')?.parameters },
      },
      ...FILE_TOOL_NAMES.map((name) => ({ type: 'function', function: { name, description: toolDeclaration(name)?.description, parameters: toolDeclaration(name)?.parameters } })),
    ])

    // Call 2 carries the assistant tool_calls turn and the matching tool result.
    const req = lastRequest(mock)
    const assistantTurn = req.messages?.find((m) => m.role === 'assistant' && m.tool_calls)
    expect(assistantTurn?.tool_calls?.[0]?.function?.name).toBe('list_skills')
    const toolMsg = req.messages?.find((m) => m.role === 'tool')
    expect(toolMsg?.tool_call_id).toBe('call_1')
    const listed = JSON.parse(toolMsg?.content ?? '[]') as { id: string }[]
    expect(listed.some((s) => s.id === 'core/summarization')).toBe(true)

    expect(run.toolCalls).toEqual([
      { name: 'list_skills', arguments: '{}', resultChars: expect.any(Number), ok: true },
    ])
  })

  it('caps the loop at 4 tool iterations and fails with a clear error', async () => {
    const mock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => toolCallResponse('list_agents'),
    }))
    vi.stubGlobal('fetch', mock)
    const { agent } = await makeToolRunner(['list_agents'])
    const res = await inject('POST', `/api/agents/${agent.id}/runs`, { input: 'go' })
    expect(res.statusCode).toBe(200)
    const run = res.json() as AgentRun
    expect(run.status).toBe('failed')
    expect(run.error).toContain('exhausted after 4 iterations')
    // 4 tool-enabled calls + 1 final tools-off call.
    expect(mock).toHaveBeenCalledTimes(5)
    const finalReq = lastRequest(mock)
    expect(finalReq).not.toHaveProperty('tools')
    expect(finalReq.messages?.[0]?.content).toContain('Answer the user directly')
    expect(run.toolCalls).toHaveLength(4)
  })

  it('feeds an unknown-tool error back so the model recovers', async () => {
    const mock = mockChatSequence([toolCallResponse('frobnicate'), contentResponse('recovered')])
    const { agent } = await makeToolRunner(['list_skills'])
    const res = await inject('POST', `/api/agents/${agent.id}/runs`, { input: 'frobnicate it' })
    expect(res.statusCode).toBe(200)
    const run = res.json() as AgentRun
    expect(run.status).toBe('succeeded')
    expect(run.output).toBe('recovered')

    const toolMsg = lastRequest(mock).messages?.find((m) => m.role === 'tool')
    expect(toolMsg?.content).toContain('Unknown tool "frobnicate"')
    // Only the tools this run offered are listed, not the whole registry.
    expect(toolMsg?.content).toContain('Available: list_skills')
    expect(toolMsg?.content).not.toContain('list_agents')
    expect(run.toolCalls).toEqual([
      { name: 'frobnicate', arguments: '{}', resultChars: expect.any(Number), ok: false },
    ])
  })

  it('offers only the file tools when the agent has no skills and memory learning is off', async () => {
    const mock = mockChat('ok')
    const { agent } = await makeRunner()
    const stored = store.agents.find((a) => a.id === agent.id)!
    stored.skillIds = []
    stored.memoryLearn = false
    expect((await inject('POST', `/api/agents/${agent.id}/runs`, { input: 'hi' })).statusCode).toBe(200)
    const tools = (lastRequest(mock) as { tools?: { function: { name: string } }[] }).tools
    expect(tools?.map((t) => t.function.name)).toEqual([...FILE_TOOL_NAMES])
  })

  it('offers remember and the file tools when the agent has no skills but memory learning is on', async () => {
    const mock = mockChat('ok')
    const { agent } = await makeRunner()
    store.agents.find((a) => a.id === agent.id)!.skillIds = []
    expect((await inject('POST', `/api/agents/${agent.id}/runs`, { input: 'hi' })).statusCode).toBe(200)
    const tools = (lastRequest(mock) as { tools?: { function: { name: string } }[] }).tools
    expect(tools?.map((t) => t.function.name)).toEqual(['remember', ...FILE_TOOL_NAMES])
  })

  it('truncates tool results at 4,000 chars with a marker', async () => {
    const { agent, endpointId } = await makeToolRunner(['list_agents'])
    for (let i = 0; i < 15; i++) {
      const created = await inject('POST', '/api/agents', {
        name: `Bulk ${i} ${'x'.repeat(300)}`,
        description: '',
        instructions: '',
        modelId: 'test-model',
        endpointId,
        skillIds: [],
      })
      expect(created.statusCode).toBe(201)
    }

    const mock = mockChatSequence([toolCallResponse('list_agents'), contentResponse('ok')])
    const res = await inject('POST', `/api/agents/${agent.id}/runs`, { input: 'list them' })
    expect(res.statusCode).toBe(200)
    const run = res.json() as AgentRun
    expect(run.status).toBe('succeeded')

    const toolMsg = lastRequest(mock).messages?.find((m) => m.role === 'tool')
    expect(toolMsg?.content.endsWith('…[truncated]')).toBe(true)
    expect(toolMsg?.content).toHaveLength(4000)
    expect(run.toolCalls?.[0]?.resultChars).toBe(4000)
  })
})

describe('DELETE /api/agents/:id/runs', () => {
  it('clears history and returns 204', async () => {
    mockChat('a')
    const { agent } = await makeRunner()
    await inject('POST', `/api/agents/${agent.id}/runs`, { input: 'hi' })
    expect((await inject('GET', `/api/agents/${agent.id}/runs`)).json()).toHaveLength(1)

    const res = await inject('DELETE', `/api/agents/${agent.id}/runs`)
    expect(res.statusCode).toBe(204)
    expect((await inject('GET', `/api/agents/${agent.id}/runs`)).json()).toEqual([])
    expect(store.runs.some((r) => r.agentId === agent.id)).toBe(false)
  })

  it('404s for an unknown agent', async () => {
    expect((await inject('DELETE', '/api/agents/nope/runs')).statusCode).toBe(404)
  })
})

describe('JSON parser regression', () => {
  it('bodyless DELETE with a JSON content-type does not 400', async () => {
    const ep = await inject('POST', '/api/endpoints', {
      kind: 'openai-compatible',
      name: 'Del endpoint',
      baseUrl: 'http://127.0.0.1:9',
      defaultModel: 'm',
      contextWindow: 4096,
    })
    const id = (ep.json() as Endpoint).id
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/endpoints/${id}`,
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, reassignedAgents: [] })
  })
})

describe('DELETE /api/endpoints/:id reassignment', () => {
  it("reassigns attached agents to the primary agent's endpoint", async () => {
    const lead = await inject('POST', '/api/agents', {
      name: 'Team Lead',
      description: '',
      instructions: '',
      modelId: 'llama-3-8b',
      endpointId: 'ep_local_llama',
      skillIds: [],
    })
    expect((lead.json() as Agent).isPrimary).toBe(true)
    const { endpoint, agent } = await makeRunner()

    const res = await inject('DELETE', `/api/endpoints/${endpoint.id}`)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, reassignedAgents: [agent.id] })

    const got = await inject('GET', `/api/agents/${agent.id}`)
    expect((got.json() as Agent).endpointId).toBe('ep_local_llama')
    expect((await inject('GET', `/api/endpoints/${endpoint.id}/models`)).statusCode).toBe(404)
  })

  it("409s when deleting the Team Lead's own endpoint", async () => {
    await inject('POST', '/api/agents', {
      name: 'Team Lead',
      description: '',
      instructions: '',
      modelId: 'llama-3-8b',
      endpointId: 'ep_local_llama',
      skillIds: [],
    })
    const res = await inject('DELETE', '/api/endpoints/ep_local_llama')
    expect(res.statusCode).toBe(409)
    expect((res.json() as { message: string }).message).toContain('Move the Team Lead')
    const listed = await inject('GET', '/api/endpoints')
    expect((listed.json() as Endpoint[]).some((e) => e.id === 'ep_local_llama')).toBe(true)
  })

  it('404s for an unknown endpoint', async () => {
    expect((await inject('DELETE', '/api/endpoints/nope')).statusCode).toBe(404)
  })
})

describe('primary (Team Lead) invariant', () => {
  it('honors isPrimary on create when no primary exists', async () => {
    expect((await inject('GET', '/api/agents')).json()).toEqual([])
    const res = await inject('POST', '/api/agents', {
      name: 'New Lead',
      description: '',
      instructions: '',
      modelId: 'llama-3-8b',
      endpointId: 'ep_local_llama',
      isPrimary: true,
      skillIds: [],
    })
    expect(res.statusCode).toBe(201)
    expect((res.json() as Agent).isPrimary).toBe(true)
  })

  it('409s on a second primary', async () => {
    const first = await inject('POST', '/api/agents', {
      name: 'New Lead',
      description: '',
      instructions: '',
      modelId: 'llama-3-8b',
      endpointId: 'ep_local_llama',
      isPrimary: true,
      skillIds: [],
    })
    expect(first.statusCode).toBe(201)
    const res = await inject('POST', '/api/agents', {
      name: 'Wannabe Lead',
      description: '',
      instructions: '',
      modelId: 'llama-3-8b',
      endpointId: 'ep_local_llama',
      isPrimary: true,
      skillIds: [],
    })
    expect(res.statusCode).toBe(409)
  })

  it('409s when deleting the primary agent', async () => {
    const lead = await inject('POST', '/api/agents', {
      name: 'Team Lead',
      description: '',
      instructions: '',
      modelId: 'llama-3-8b',
      endpointId: 'ep_local_llama',
      skillIds: [],
    })
    const leadId = (lead.json() as Agent).id
    const res = await inject('DELETE', `/api/agents/${leadId}`)
    expect(res.statusCode).toBe(409)
    expect((res.json() as { message: string }).message).toContain('Team Lead')
    expect((await inject('GET', `/api/agents/${leadId}`)).statusCode).toBe(200)
  })

  it('transfers primary on update', async () => {
    const lead = await inject('POST', '/api/agents', {
      name: 'Team Lead',
      description: '',
      instructions: '',
      modelId: 'llama-3-8b',
      endpointId: 'ep_local_llama',
      skillIds: [],
    })
    const leadId = (lead.json() as Agent).id
    const { agent } = await makeRunner()
    const res = await inject('PUT', `/api/agents/${agent.id}`, {
      name: agent.name,
      description: '',
      instructions: '',
      modelId: agent.modelId,
      endpointId: agent.endpointId,
      isPrimary: true,
      skillIds: [],
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as Agent).isPrimary).toBe(true)
    const oldLead = await inject('GET', `/api/agents/${leadId}`)
    expect((oldLead.json() as Agent).isPrimary).toBe(false)
  })
})

describe('fresh install', () => {
  it('seeds zero agents and zero runs but keeps the catalogs', async () => {
    const agents = await inject('GET', '/api/agents')
    expect(agents.statusCode).toBe(200)
    expect(agents.json()).toEqual([])
    expect((await inject('GET', '/api/endpoints')).json()).toHaveLength(2)
    expect(((await inject('GET', '/api/skills')).json() as { skills: unknown[] }).skills.length).toBeGreaterThan(0)
  })

  it('seeds the placeholder default endpoint first (OpenAI-compatible)', async () => {
    const first = ((await inject('GET', '/api/endpoints')).json() as Endpoint[])[0] as Endpoint
    expect(first).toMatchObject({ kind: 'openai-compatible', baseUrl: DEFAULT_ENDPOINT_BASE_URL })
    expect(store.endpointModels[first.id]).toContain(first.defaultModel)
  })

  it('has no seeded model catalog; model choice is per endpoint', async () => {
    expect((await inject('GET', '/api/models')).statusCode).toBe(404)
    expect(store).not.toHaveProperty('models')
    expect(Object.keys(store.endpointModels).length).toBeGreaterThan(0)
  })
})

describe('skill seeds', () => {
  it('preserves the six vendored skills alongside the thirteen authored skills', async () => {
    const listed = (await inject('GET', '/api/skills')).json() as { skills: Skill[] }
    expect(listed.skills).toHaveLength(19)
    const skills = await Promise.all(listed.skills.map(async (s) =>
      (await inject('GET', `/api/skills/${encodeURIComponent(s.id)}`)).json() as Skill))
    const vendored = skills.filter((s) => s.source === 'seb1n/awesome-ai-agent-skills')
    const vendoredTools: Record<string, string[]> = {
      'code-review': ['diff_text', 'process_lines', 'extract_entities'],
      debugging: ['process_lines', 'extract_entities', 'diff_text', 'read_run_log'],
      'deep-research': ['extract_entities'],
      'multi-agent-orchestration': ['list_agents', 'get_agent', 'workspace_overview', 'read_run_log', 'get_skill'],
      summarization: ['text_stats'],
      'technical-writing': ['text_stats', 'diff_text'],
    }
    expect(vendored.map((s) => s.id)).toEqual([
      'core/code-review',
      'core/debugging',
      'core/deep-research',
      'core/multi-agent-orchestration',
      'core/summarization',
      'core/technical-writing',
    ])
    for (const s of vendored) {
      expect(s.content.length).toBeGreaterThan(100)
      expect(s.content).not.toMatch(/^---/)
      expect(s.source).toBe('seb1n/awesome-ai-agent-skills')
      // Bodies stay vendored; each declares its tools in frontmatter only.
      expect(s.tools.map((t) => t.name)).toEqual(vendoredTools[s.name])
    }
  })
})

describe('skills CRUD', () => {
  it('round-trips create/get/list/update/delete', async () => {
    const create = await inject('POST', '/api/skills', {
      name: 'Frobnicate',
      description: 'Frobs widgets.',
      tag: 'Core',
      content: 'Frob the widget carefully.',
      tools: [{ name: 'frob', description: 'Frobs one widget' }],
    })
    expect(create.statusCode).toBe(201)
    const skill = create.json() as Skill
    expect(skill.id).toBeTruthy()
    expect(skill.content).toBe('Frob the widget carefully.')
    expect(skill.tools).toEqual([{ name: 'frob', description: 'Frobs one widget', parameters: {} }])

    const got = await inject('GET', `/api/skills/${skill.id}`)
    expect(got.statusCode).toBe(200)
    expect((got.json() as Skill).name).toBe('Frobnicate')

    const list = await inject('GET', '/api/skills')
    expect((list.json() as { skills: Skill[] }).skills.some((s) => s.id === skill.id)).toBe(true)

    const patch = await inject('PATCH', `/api/skills/${skill.id}`, { tag: 'Advanced', content: 'v2 content' })
    expect(patch.statusCode).toBe(200)
    const patched = patch.json() as Skill
    expect(patched.tag).toBe('Advanced')
    expect(patched.content).toBe('v2 content')
    expect(patched.name).toBe('Frobnicate')

    expect((await inject('DELETE', `/api/skills/${skill.id}`)).statusCode).toBe(204)
    expect((await inject('GET', `/api/skills/${skill.id}`)).statusCode).toBe(404)
  })

  it('400s when content is missing', async () => {
    const res = await inject('POST', '/api/skills', { name: 'No content', description: 'd' })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { message: string }).message).toContain('content')
  })

  it('400s when a tool lacks name or description', async () => {
    const res = await inject('POST', '/api/skills', {
      name: 'Bad tools',
      content: 'c',
      tools: [{ name: 'only-name' }],
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('POST /api/skills/import', () => {
  it('parses frontmatter into name/description and strips it from content', async () => {
    const res = await inject('POST', '/api/skills/import', {
      markdown: '---\nname: my-skill\ndescription: Does a thing.\nlicense: MIT\nmetadata:\n  author: someone\n---\n\n# Body\n\nStep one.\n',
    })
    expect(res.statusCode).toBe(201)
    const skill = res.json() as Skill
    expect(skill.id).toBe('my-skill')
    expect(skill.name).toBe('my-skill')
    expect(skill.description).toBe('Does a thing.')
    expect(skill.content).toBe('# Body\n\nStep one.')
    expect(skill.tag).toBe('')
  })

  it('keeps the tag an exported SKILL.md carries', async () => {
    const res = await inject('POST', '/api/skills/import', {
      markdown: '---\nname: tagged-skill\ndescription: Has a tag.\ntag: Data\n---\n\nBody.\n',
    })
    expect(res.statusCode).toBe(201)
    expect((res.json() as Skill).tag).toBe('Data')
  })

  it('422s when frontmatter is missing', async () => {
    const res = await inject('POST', '/api/skills/import', { markdown: '# Just a body\n\nNo header.' })
    expect(res.statusCode).toBe(422)
  })

  it('422s when frontmatter lacks a description', async () => {
    const res = await inject('POST', '/api/skills/import', { markdown: '---\nname: x\n---\n\nBody.' })
    expect(res.statusCode).toBe(422)
  })
})

describe('DELETE /api/skills/:id detaches from agents', () => {
  it('strips the skill id from every agent skillIds', async () => {
    const created = await inject('POST', '/api/skills', { name: 'Temp', content: 'temp content' })
    const skillId = (created.json() as Skill).id

    const lead = await inject('POST', '/api/agents', {
      name: 'Team Lead',
      description: '',
      instructions: '',
      modelId: 'llama-3-8b',
      endpointId: 'ep_local_llama',
      skillIds: [skillId, 'core/debugging'],
    })
    const leadId = (lead.json() as Agent).id

    const res = await inject('DELETE', `/api/skills/${skillId}`)
    expect(res.statusCode).toBe(204)

    const got = await inject('GET', `/api/agents/${leadId}`)
    expect((got.json() as Agent).skillIds).toEqual(['core/debugging'])
    expect(store.agents.find((a) => a.id === leadId)?.skillIds).toEqual(['core/debugging'])
  })
})

describe('agent role', () => {
  const base = {
    description: '',
    instructions: '',
    modelId: 'llama-3-8b',
    endpointId: 'ep_local_llama',
    skillIds: [],
  }

  it('persists role on create', async () => {
    const res = await inject('POST', '/api/agents', { ...base, name: 'Reviewer', role: 'Code Reviewer' })
    expect(res.statusCode).toBe(201)
    expect((res.json() as Agent).role).toBe('Code Reviewer')
  })

  it('updates role on PUT', async () => {
    const created = await inject('POST', '/api/agents', { ...base, name: 'Reviewer', role: 'Code Reviewer' })
    const agent = created.json() as Agent
    const res = await inject('PUT', `/api/agents/${agent.id}`, { ...base, name: agent.name, role: 'Researcher' })
    expect(res.statusCode).toBe(200)
    expect((res.json() as Agent).role).toBe('Researcher')
  })

  it('defaults role to "" when omitted', async () => {
    const res = await inject('POST', '/api/agents', { ...base, name: 'No Role' })
    expect(res.statusCode).toBe(201)
    expect((res.json() as Agent).role).toBe('')
  })
})

describe('agent temperature', () => {
  const base = {
    description: '',
    instructions: '',
    modelId: 'llama-3-8b',
    endpointId: 'ep_local_llama',
    role: '',
    skillIds: [],
  }

  it('persists temperature on create and leaves it unset when omitted', async () => {
    const warm = await inject('POST', '/api/agents', { ...base, name: 'Warm', temperature: 0.7 })
    expect(warm.statusCode).toBe(201)
    expect((warm.json() as Agent).temperature).toBe(0.7)
    const plain = await inject('POST', '/api/agents', { ...base, name: 'Plain' })
    expect((plain.json() as Agent).temperature).toBeUndefined()
  })

  it('updates temperature on PUT and keeps it when the PUT omits it', async () => {
    const agent = (await inject('POST', '/api/agents', { ...base, name: 'T', temperature: 0.2 })).json() as Agent
    const changed = await inject('PUT', `/api/agents/${agent.id}`, { ...base, name: 'T', temperature: 1.5 })
    expect((changed.json() as Agent).temperature).toBe(1.5)
    const kept = await inject('PUT', `/api/agents/${agent.id}`, { ...base, name: 'T renamed' })
    expect((kept.json() as Agent).temperature).toBe(1.5)
  })

  it('rejects a temperature outside 0-2 or not a number', async () => {
    for (const temperature of [-0.1, 2.5, 'hot', true]) {
      const res = await inject('POST', '/api/agents', { ...base, name: 'Bad', temperature })
      expect(res.statusCode).toBe(400)
    }
  })

  it('sends the agent temperature upstream, and nothing when unset', async () => {
    const mock = mockChat('ok')
    const { agent } = await makeRunner()
    await inject('POST', `/api/agents/${agent.id}/runs`, { input: 'hi' })
    expect(lastRequest(mock)).not.toHaveProperty('temperature')

    const put = await inject('PUT', `/api/agents/${agent.id}`, {
      name: agent.name,
      description: '',
      instructions: agent.instructions,
      modelId: agent.modelId,
      endpointId: agent.endpointId,
      role: '',
      skillIds: agent.skillIds,
      temperature: 0.3,
    })
    expect(put.statusCode).toBe(200)
    await inject('POST', `/api/agents/${agent.id}/runs`, { input: 'again' })
    expect(lastRequest(mock).temperature).toBe(0.3)
  })
})

describe('CORS', () => {
  const origin = 'http://localhost:5173'

  it('allows PUT in the preflight response', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/agents/some-id',
      headers: { origin, 'access-control-request-method': 'PUT' },
    })
    expect(res.statusCode).toBeLessThan(300)
    expect(res.headers['access-control-allow-methods']).toContain('PUT')
  })

  it('sends allow-origin on a PUT request', async () => {
    const created = await inject('POST', '/api/agents', {
      name: 'CORS Agent',
      description: '',
      instructions: '',
      modelId: 'llama-3-8b',
      endpointId: 'ep_local_llama',
      skillIds: [],
    })
    const agent = created.json() as Agent
    const res = await app.inject({
      method: 'PUT',
      url: `/api/agents/${agent.id}`,
      headers: { origin, 'content-type': 'application/json' },
      payload: {
        name: 'CORS Agent v2',
        description: '',
        instructions: '',
        modelId: 'llama-3-8b',
        endpointId: 'ep_local_llama',
        skillIds: [],
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['access-control-allow-origin']).toBe(origin)
  })
})

describe('DD-7 store migration', () => {
  it('promotes the oldest agent, backfills endpointId, and persists once', () => {
    const legacyDir = mkdtempSync(join(tmpdir(), 'agentcontrol-legacy-'))
    const legacyPath = join(legacyDir, 'store.json')
    const mkAgent = (id: string, createdAt: string): Record<string, unknown> => ({
      id,
      name: id,
      description: '',
      instructions: '',
      modelId: 'llama-3-8b',
      endpointId: null,
      skillIds: [],
      status: 'idle',
      createdAt,
      lastRunAt: null,
      runCount: 0,
    })
    writeFileSync(
      legacyPath,
      JSON.stringify({
        agents: [mkAgent('agt_new', '2026-02-01T00:00:00.000Z'), mkAgent('agt_old', '2025-01-01T00:00:00.000Z')],
        runs: [],
        endpoints: [
          {
            id: 'ep_only',
            kind: 'openai-compatible',
            name: 'Only',
            baseUrl: 'http://127.0.0.1:9',
            defaultModel: 'llama-3-8b',
            contextWindow: 4096,
            apiKeySet: false,
            status: 'unknown',
            lastCheckedAt: null,
            createdAt: '2025-01-01T00:00:00.000Z',
          },
        ],
      }),
      'utf8',
    )

    const legacyStore = createStore(legacyPath)
    const old = legacyStore.agents.find((a) => a.id === 'agt_old') as Agent
    const fresh = legacyStore.agents.find((a) => a.id === 'agt_new') as Agent
    expect(old.isPrimary).toBe(true)
    expect(fresh.isPrimary).toBe(false)
    expect(old.endpointId).toBe('ep_only')
    expect(fresh.endpointId).toBe('ep_only')

    // Persisted once, so a reload sees the migrated shape.
    const reloaded = JSON.parse(readFileSync(legacyPath, 'utf8')) as { agents: Agent[] }
    expect(reloaded.agents.find((a) => a.id === 'agt_old')?.isPrimary).toBe(true)
    expect(reloaded.agents.find((a) => a.id === 'agt_new')?.endpointId).toBe('ep_only')

    rmSync(legacyDir, { recursive: true, force: true })
  })
})

describe('seed skill merge', () => {
  it('appends seed skills missing from an existing store and keeps saved ones', () => {
    const oldDir = mkdtempSync(join(tmpdir(), 'agentcontrol-oldskills-'))
    const oldPath = join(oldDir, 'store.json')
    writeFileSync(
      oldPath,
      JSON.stringify({
        agents: [],
        runs: [],
        projects: [],
        models: [],
        endpoints: [],
        endpointModels: {},
        settings: { autoRun: true, notify: true, telemetry: false },
        skills: [{ id: 'web-research', name: 'Web Research', description: 'old placeholder', tag: 'Core' }],
      }),
      'utf8',
    )

    const merged = createStore(oldPath)
    expect(merged.skills.some((s) => s.id === 'web-research')).toBe(true)
    expect(merged.skills.some((s) => s.id === 'core/summarization')).toBe(true)
    expect(merged.skills.some((s) => s.id === 'core/multi-agent-orchestration')).toBe(true)

    // The merge is persisted, so a reload sees the upgraded catalog too.
    const reloaded = JSON.parse(readFileSync(oldPath, 'utf8')) as { skills: { id: string }[] }
    expect(reloaded.skills.some((s) => s.id === 'core/deep-research')).toBe(true)
    expect(reloaded.skills.some((s) => s.id === 'web-research')).toBe(true)

    rmSync(oldDir, { recursive: true, force: true })
  })
})

describe('legacy skills', () => {
  it('backfills content and tools on skills that predate them, and persists it', async () => {
    const oldDir = mkdtempSync(join(tmpdir(), 'agentcontrol-legacyskills-'))
    const oldPath = join(oldDir, 'store.json')
    writeFileSync(
      oldPath,
      JSON.stringify({
        agents: [],
        runs: [],
        projects: [],
        endpoints: [],
        endpointModels: {},
        settings: { autoRun: true, notify: true, telemetry: false },
        skills: [{ id: 'web-research', name: 'Web Research', description: 'old placeholder', tag: 'Core' }],
      }),
      'utf8',
    )

    const loaded = createStore(oldPath)
    expect(loaded.skills.find((s) => s.id === 'web-research')).toMatchObject({ content: '', tools: [] })
    const rewritten = JSON.parse(readFileSync(oldPath, 'utf8')) as { skills: Skill[] }
    expect(rewritten.skills.find((s) => s.id === 'web-research')).toMatchObject({ content: '', tools: [] })

    // And the API serves it in the shape the FE expects.
    const legacyApp = buildApp(loaded)
    const res = await legacyApp.inject({ method: 'GET', url: '/api/skills' })
    for (const summary of (res.json() as { skills: Skill[] }).skills) {
      expect(summary).not.toHaveProperty('content')
      const skill = (await legacyApp.inject({ method: 'GET', url: `/api/skills/${encodeURIComponent(summary.id)}` })).json() as Skill
      expect(typeof skill.content).toBe('string')
      expect(Array.isArray(skill.tools)).toBe(true)
    }
    await legacyApp.close()
    rmSync(oldDir, { recursive: true, force: true })
  })
})

describe('default endpoint placeholder', () => {
  const oldSeedEndpoint = {
    id: 'ep_local_llama',
    kind: 'openai-compatible',
    name: 'Local llama.cpp',
    baseUrl: 'http://127.0.0.1:8080',
    defaultModel: 'llama-3-8b',
    contextWindow: 8192,
    apiKeySet: false,
    status: 'unknown',
    lastCheckedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  }
  const legacyStore = (endpoint: Record<string, unknown>) =>
    JSON.stringify({
      agents: [
        {
          id: 'agt_lead',
          name: 'Lead',
          role: 'Team Lead',
          description: '',
          instructions: '',
          modelId: 'llama-3-8b',
          endpointId: 'ep_local_llama',
          isPrimary: true,
          skillIds: [],
          status: 'idle',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      runs: [],
      projects: [],
      skills: [],
      endpoints: [endpoint],
      endpointModels: { ep_local_llama: ['llama-3-8b'] },
      settings: { autoRun: true, notify: true, telemetry: false },
    })

  it('repoints the untouched old seed endpoint and keeps its agents on it', () => {
    const oldDir = mkdtempSync(join(tmpdir(), 'agentcontrol-oldseed-'))
    const oldPath = join(oldDir, 'store.json')
    writeFileSync(oldPath, legacyStore(oldSeedEndpoint), 'utf8')

    const loaded = createStore(oldPath)
    const ep = loaded.endpoints.find((e) => e.id === 'ep_local_llama')
    expect(ep).toMatchObject({ baseUrl: DEFAULT_ENDPOINT_BASE_URL, name: 'Test endpoint (placeholder)' })
    expect(loaded.agents[0]?.endpointId).toBe('ep_local_llama')

    const rewritten = JSON.parse(readFileSync(oldPath, 'utf8')) as { endpoints: Endpoint[] }
    expect(rewritten.endpoints[0]?.baseUrl).toBe(DEFAULT_ENDPOINT_BASE_URL)

    rmSync(oldDir, { recursive: true, force: true })
  })

  it('leaves an old seed endpoint the user edited alone', () => {
    const oldDir = mkdtempSync(join(tmpdir(), 'agentcontrol-editedseed-'))
    const oldPath = join(oldDir, 'store.json')
    writeFileSync(oldPath, legacyStore({ ...oldSeedEndpoint, baseUrl: 'http://127.0.0.1:9090' }), 'utf8')

    const loaded = createStore(oldPath)
    expect(loaded.endpoints.find((e) => e.id === 'ep_local_llama')).toMatchObject({
      baseUrl: 'http://127.0.0.1:9090',
      name: 'Local llama.cpp',
    })

    rmSync(oldDir, { recursive: true, force: true })
  })

  it('keeps store.example.json in sync with the seeded endpoints', () => {
    const example = JSON.parse(
      readFileSync(new URL('../data/store.example.json', import.meta.url), 'utf8'),
    ) as { endpoints: Endpoint[]; endpointModels: Record<string, string[]> }
    const shape = (eps: Endpoint[]) =>
      eps.map(({ id, kind, name, baseUrl, defaultModel, contextWindow }) => ({ id, kind, name, baseUrl, defaultModel, contextWindow }))
    expect(shape(example.endpoints)).toEqual(shape(seedEndpoints))
    expect(example.endpointModels).toEqual(seedEndpointModels)
  })
})

describe('retired model catalog', () => {
  it('loads a store that still has `models` and rewrites it without them', () => {
    const oldDir = mkdtempSync(join(tmpdir(), 'agentcontrol-oldmodels-'))
    const oldPath = join(oldDir, 'store.json')
    const endpointModels = { ep_x: ['m-1', 'm-2'] }
    writeFileSync(
      oldPath,
      JSON.stringify({
        agents: [],
        runs: [],
        projects: [],
        skills: [],
        models: [{ id: 'gpt-5.2', name: 'GPT-5.2', provider: 'OpenAI', tier: 'balanced', contextWindow: 400_000 }],
        endpoints: [],
        endpointModels,
        settings: { autoRun: true, notify: true, telemetry: false },
      }),
      'utf8',
    )

    const loaded = createStore(oldPath)
    expect(loaded).not.toHaveProperty('models')
    expect(loaded.endpointModels).toEqual(endpointModels)

    const rewritten = JSON.parse(readFileSync(oldPath, 'utf8')) as Record<string, unknown>
    expect(rewritten).not.toHaveProperty('models')
    expect(rewritten.endpointModels).toEqual(endpointModels)

    rmSync(oldDir, { recursive: true, force: true })
  })
})

describe('persistence failure', () => {
  it('returns 500 when a successful run cannot be persisted', async () => {
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'not a directory')
    const badApp = buildApp(createStore(join(blocker, 'store.json')))
    try {
      const ep = await badApp.inject({
        method: 'POST',
        url: '/api/endpoints',
        payload: { kind: 'openai-compatible', name: 'e', baseUrl: 'http://127.0.0.1:9', defaultModel: 'm', contextWindow: 8192 },
        headers: { 'content-type': 'application/json' },
      })
      const epId = (ep.json() as Endpoint).id
      const ag = await badApp.inject({
        method: 'POST',
        url: '/api/agents',
        payload: { name: 'a', description: '', instructions: '', modelId: 'm', endpointId: epId, skillIds: [] },
        headers: { 'content-type': 'application/json' },
      })
      const agentId = (ag.json() as Agent).id

      mockChat('hello')
      const res = await badApp.inject({
        method: 'POST',
        url: `/api/agents/${agentId}/runs`,
        payload: { input: 'hi' },
        headers: { 'content-type': 'application/json' },
      })
      expect(res.statusCode).toBe(500)
      expect((res.json() as { message: string }).message).toContain('could not be persisted')
    } finally {
      await badApp.close()
    }
  })
})

describe('per-endpoint timeout', () => {
  it('honors timeoutMs with a slow (never-resolving) upstream', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: { signal?: AbortSignal }) =>
          new Promise<never>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              const err = new Error('aborted')
              err.name = 'AbortError'
              reject(err)
            })
          }),
      ),
    )

    const ep = await inject('POST', '/api/endpoints', {
      kind: 'openai-compatible',
      name: 'Slow endpoint',
      baseUrl: 'http://127.0.0.1:9',
      defaultModel: 'm',
      contextWindow: 8192,
      timeoutMs: 50,
    })
    const endpoint = ep.json() as Endpoint
    expect(endpoint.timeoutMs).toBe(50)

    const ag = await inject('POST', '/api/agents', {
      name: 'Slow agent',
      description: '',
      instructions: '',
      modelId: 'm',
      endpointId: endpoint.id,
      skillIds: [],
    })
    const agentId = (ag.json() as Agent).id

    const started = Date.now()
    const res = await inject('POST', `/api/agents/${agentId}/runs`, { input: 'hi' })
    expect(res.statusCode).toBe(200)
    const run = res.json() as AgentRun
    expect(run.status).toBe('failed')
    expect(run.error).toContain('timed out after 50ms')
    expect(Date.now() - started).toBeLessThan(2000)
  })
})

describe('AGENTCONTROL_AUTH_TOKEN', () => {
  it('gates /api/* but leaves /health open', async () => {
    process.env.AGENTCONTROL_AUTH_TOKEN = 'tok-123'
    const gated = buildApp(createStore(join(dir, 'store.json')))
    try {
      expect((await gated.inject({ method: 'GET', url: '/api/agents' })).statusCode).toBe(401)
      expect(
        (await gated.inject({ method: 'GET', url: '/api/agents', headers: { authorization: 'Bearer tok-123' } })).statusCode,
      ).toBe(200)
      expect((await gated.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200)
    } finally {
      await gated.close()
      delete process.env.AGENTCONTROL_AUTH_TOKEN
    }
  })
  it('an encoded /api path is gated too (the router decodes it; BE-P2-13 review B1)', async () => {
    process.env.AGENTCONTROL_AUTH_TOKEN = 'tok-123'
    const gated = buildApp(createStore(join(dir, 'store.json')))
    try {
      // Without the fix, /%61pi/agents skipped the check and was routed to /api/agents (200).
      for (const url of ['/%61pi/agents', '/%41PI/agents', '/%2561pi/agents', '/%2561pi', '/api', '//api/agents', '/./api/agents', '/x/../api/agents', '/api/agents?x=1']) {
        expect([url, (await gated.inject({ method: 'GET', url })).statusCode]).toEqual([url, 401])
      }
      expect((await gated.inject({ method: 'GET', url: '/%61pi/agents', headers: { authorization: 'Bearer tok-123' } })).statusCode).toBe(200)
      expect((await gated.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200)
    } finally {
      await gated.close()
      delete process.env.AGENTCONTROL_AUTH_TOKEN
    }
  })
})

describe('tool plumbing', () => {
  /** One assistant turn carrying several tool calls. */
  function multiCallResponse(calls: { name: string; args?: string }[]) {
    return {
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: '',
            tool_calls: calls.map((c, i) => ({
              id: `call_${i + 1}`,
              type: 'function',
              function: { name: c.name, arguments: c.args ?? '{}' },
            })),
          },
        },
      ],
    }
  }
  const toolMessages = (mock: ReturnType<typeof mockChat>) =>
    (lastRequest(mock).messages ?? []).filter((m) => m.role === 'tool')

  it('refuses a registry tool this agent was not offered', async () => {
    const mock = mockChatSequence([toolCallResponse('list_agents'), contentResponse('ok')])
    const { agent } = await makeToolRunner(['list_skills'])
    const run = (await inject('POST', `/api/agents/${agent.id}/runs`, { input: 'go' })).json() as AgentRun
    expect(toolMessages(mock)[0]?.content).toContain('Tool "list_agents" is not enabled for this agent. Available: list_skills')
    expect(run.toolCalls?.[0]?.ok).toBe(false)
  })

  it('executes nothing when the model calls tools no skill offered', async () => {
    const mock = mockChatSequence([toolCallResponse('list_agents'), contentResponse('ok')])
    const { agent } = await makeRunner()
    store.skills.find((s) => s.id === 'core/summarization')!.tools = [] // the attached seed, tools cleared
    await inject('POST', `/api/agents/${agent.id}/runs`, { input: 'go' })
    expect(toolMessages(mock)[0]?.content).toContain('Available: activate_skill')
  })

  it('answers every call but executes at most 8 per turn', async () => {
    // read_run_log on a fresh agent returns "[]": tiny results, no budget pressure.
    const calls = Array.from({ length: 9 }, () => ({ name: 'read_run_log' }))
    const mock = mockChatSequence([multiCallResponse(calls), contentResponse('ok')])
    const { agent } = await makeToolRunner(['read_run_log'])
    const run = (await inject('POST', `/api/agents/${agent.id}/runs`, { input: 'go' })).json() as AgentRun
    const msgs = toolMessages(mock)
    expect(msgs).toHaveLength(9)
    expect(msgs[8]?.content).toContain('Too many tool calls')
    expect(run.toolCalls?.map((c) => c.ok)).toEqual([...Array(8).fill(true), false])
  })

  it('refuses oversized arguments and clips them in the audit', async () => {
    const huge = JSON.stringify({ pad: 'x'.repeat(70_000) })
    const outcome = await executeToolCall(
      { id: 'c1', name: 'list_skills', arguments: huge },
      {
        store, agentId: 'a', runId: 'r', input: '', allowed: new Set(['list_skills']),
        now: () => new Date(), timeZone: 'UTC', writes: { count: 0 },
      },
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.content).toContain('Tool arguments are too large')

    // In a run, 70k chars of arguments also overflow the window: the run is
    // saved as failed (not a 413) and the audit keeps only 1,000 chars.
    mockChatSequence([toolCallResponse('list_skills', huge), contentResponse('ok')])
    const { agent } = await makeToolRunner(['list_skills'])
    const res = await inject('POST', `/api/agents/${agent.id}/runs`, { input: 'go' })
    expect(res.statusCode).toBe(200)
    const run = res.json() as AgentRun
    expect(run.toolCalls?.[0]?.ok).toBe(false)
    expect(run.toolCalls?.[0]?.arguments.endsWith('…[truncated]')).toBe(true)
    expect(run.toolCalls?.[0]?.arguments.length).toBeLessThanOrEqual(1012)
  })

  it('redacts stored keys and key-shaped strings from tool output', async () => {
    const secret = 'sk-or-v1-0123456789abcdef0123456789abcdef'
    const keyed = await inject('POST', '/api/endpoints', {
      kind: 'openrouter',
      name: 'Keyed',
      baseUrl: 'https://openrouter.ai/api/v1',
      defaultModel: 'm',
      contextWindow: 8192,
      apiKey: 'plain-vault-secret-value',
    })
    expect(keyed.statusCode).toBe(201)
    const { agent, endpointId } = await makeToolRunner(['list_agents'])
    for (const name of [`Leak ${secret}`, 'Vault plain-vault-secret-value', 'Gh ghp_abcdefghijklmnopqrstuvwxyz0123']) {
      const created = await inject('POST', '/api/agents', {
        name, description: '', instructions: '', modelId: 'test-model', endpointId, skillIds: [],
      })
      expect(created.statusCode).toBe(201)
    }
    const mock = mockChatSequence([toolCallResponse('list_agents'), contentResponse('ok')])
    await inject('POST', `/api/agents/${agent.id}/runs`, { input: 'who is here?' })
    const content = toolMessages(mock)[0]?.content ?? ''
    expect(content).not.toContain(secret)
    expect(content).not.toContain('plain-vault-secret-value')
    expect(content).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123')
    expect(content.split('[redacted]').length - 1).toBe(3)
  })

  it('serializes a handler that returns undefined as "null" instead of crashing', async () => {
    const registry = builtinTools as Map<string, ToolEntry>
    registry.set('tmp_undefined', {
      name: 'tmp_undefined', category: 'workspace', effect: 'read', description: 'test. Example: {}',
      parameters: { type: 'object', properties: {} }, handler: () => undefined,
    })
    try {
      const outcome = await executeToolCall(
        { id: 'c1', name: 'tmp_undefined', arguments: '{}' },
        {
          store, agentId: 'a', runId: 'r', input: '', allowed: new Set(['tmp_undefined']),
          now: () => new Date(), timeZone: 'UTC', writes: { count: 0 },
        },
      )
      expect(outcome).toEqual({ ok: true, content: 'null' })
    } finally {
      registry.delete('tmp_undefined')
    }
  })

  it('saves a failed run instead of 413 when tool traffic overflows the window', async () => {
    const ep = await inject('POST', '/api/endpoints', {
      kind: 'openai-compatible', name: 'Tiny', baseUrl: 'http://127.0.0.1:9', defaultModel: 'm', contextWindow: 4400 + FILE_TOOL_TOKENS,
    })
    const sk = await inject('POST', '/api/skills', {
      name: 'Tiny tools', content: 'Use tools.', tools: [{ name: 'list_skills', description: 'x' }],
    })
    const agent = (await inject('POST', '/api/agents', {
      name: 'Tiny agent', description: '', instructions: '', modelId: 'm',
      endpointId: (ep.json() as Endpoint).id, skillIds: [(sk.json() as Skill).id],
    })).json() as Agent
    store.agents.find((a) => a.id === agent.id)!.memoryLearn = false
    // The tools-off final call drops the schemas, so the pad covers the file tools' share too.
    const padded = JSON.stringify({ pad: 'x'.repeat(1200 + FILE_TOOL_TOKENS * 4) })
    const mock = mockChatSequence([toolCallResponse('list_skills', padded), contentResponse('never sent')])
    const res = await inject('POST', `/api/agents/${agent.id}/runs`, { input: 'go' })
    expect(res.statusCode).toBe(200)
    const run = res.json() as AgentRun
    expect(run.status).toBe('failed')
    expect(run.error).toContain('Context exhausted by tool results')
    expect(mock).toHaveBeenCalledTimes(1)
    const saved = (await inject('GET', `/api/agents/${agent.id}/runs`)).json() as AgentRun[]
    expect(saved[0]?.id).toBe(run.id)
  })
})

describe('tools and notes routes', () => {
  it('runs the new tools with canonical schemas and saves a memory through an agent run', async () => {
    const mock = mockChatSequence([
      toolCallResponse('calculate', '{"expression":"2 + 2"}', 'math'),
      toolCallResponse('remember', '{"text":"2 + 2 is 4.","category":"work"}', 'mem'),
      contentResponse('Remembered the verified answer.'),
    ])
    const { agent } = await makeToolRunner(['calculate'])
    const response = await inject('POST', `/api/agents/${agent.id}/runs`, { input: 'Calculate and remember 2 + 2.' })
    const run = response.json() as AgentRun
    expect(response.statusCode).toBe(200)
    expect(run.status).toBe('succeeded')
    expect(run.toolCalls?.map((t) => [t.name, t.ok])).toEqual([['calculate', true], ['remember', true]])
    expect(store.memories[0]).toMatchObject({ text: '2 + 2 is 4.', category: 'work', scope: { kind: 'agent', agentId: agent.id }, source: { kind: 'chat', runId: run.id, agentId: agent.id } })
    const sent = JSON.parse(mock.mock.calls[0]?.[1]?.body ?? '{}')
    expect(sent.tools[0].function).toEqual(toolDeclaration('calculate'))
    expect((await inject('GET', `/api/agents/${agent.id}/memory`)).json().items[0]).toMatchObject({ text: '2 + 2 is 4.' })
    expect(createStore(join(dir, 'store.json')).memories[0]?.text).toBe('2 + 2 is 4.')
  })

  it('serves the registry with categories and effects', async () => {
    const tools = (await inject('GET', '/api/tools')).json() as { name: string; category: string; effect: string }[]
    expect(tools.slice(0, 3).map((t) => t.name)).toEqual(['list_agents', 'list_skills', 'read_run_log'])
    expect(tools.every((t) => t.category && t.effect)).toBe(true)
  })

  it('gates the new routes behind the bearer token', async () => {
    process.env.AGENTCONTROL_AUTH_TOKEN = 'tok-123'
    const gated = buildApp(createStore(join(dir, 'store.json')))
    try {
      for (const url of ['/api/tools', '/api/agents/x/memory', '/api/notes']) {
        expect((await gated.inject({ method: 'GET', url })).statusCode).toBe(401)
      }
      expect((await gated.inject({ method: 'DELETE', url: '/api/agents/x/memory/y' })).statusCode).toBe(401)
    } finally {
      await gated.close()
      delete process.env.AGENTCONTROL_AUTH_TOKEN
    }
  })

  it('imports SKILL.md tools: registry names kept, others reported but not stored', async () => {
    const md = '---\nname: Tooled\ndescription: d\ntools: list_skills, Read, list_skills\n---\nBody.'
    const res = await inject('POST', '/api/skills/import', { markdown: md })
    expect(res.statusCode).toBe(201)
    const body = res.json() as Skill & { ignoredTools?: string[] }
    expect(body.tools.map((t) => t.name)).toEqual(['list_skills'])
    expect(body.tools[0]).toEqual(toolDeclaration('list_skills'))
    expect(body.ignoredTools).toEqual(['Read'])
    const stored = ((await inject('GET', '/api/skills')).json() as { skills: Skill[] }).skills.find((s) => s.id === body.id)
    expect(stored).not.toHaveProperty('ignoredTools')
  })

  it('bounds tool declarations on skill create', async () => {
    const tooMany = Array.from({ length: 17 }, (_, i) => ({ name: `t${i}`, description: 'd' }))
    expect((await inject('POST', '/api/skills', { name: 'Many', content: 'c', tools: tooMany })).statusCode).toBe(400)
    const badName = [{ name: 'bad name', description: 'd' }]
    expect((await inject('POST', '/api/skills', { name: 'Bad', content: 'c', tools: badName })).statusCode).toBe(400)
  })
})

describe('store meta migrations', () => {
  const legacy = (extra: Record<string, unknown>) =>
    JSON.stringify({
      agents: [], runs: [], projects: [], endpoints: [], endpointModels: {},
      settings: { autoRun: true, notify: true, telemetry: false }, ...extra,
    })

  it('appends missing seeds once on an old store and records them', () => {
    const d = mkdtempSync(join(tmpdir(), 'agentcontrol-meta-'))
    const path = join(d, 'store.json')
    writeFileSync(path, legacy({ skills: [] }), 'utf8')
    const loaded = createStore(path)
    expect(loaded.skills.map((s) => s.id)).toEqual(seedSkills.map((s) => s.id))
    expect(loaded.meta.seededSkillIds).toEqual(seedSkills.map((s) => s.id))
    expect(loaded.meta.migrations).toContain('seed-skill-tools-v1')
    rmSync(d, { recursive: true, force: true })
  })

  it('does not resurrect a seed skill the user deleted', () => {
    const d = mkdtempSync(join(tmpdir(), 'agentcontrol-meta-'))
    const path = join(d, 'store.json')
    const kept = seedSkills.filter((s) => s.id !== 'core/debugging')
    writeFileSync(
      path,
      legacy({ skills: kept, meta: { migrations: ['seed-skill-tools-v1'], seededSkillIds: seedSkills.map((s) => s.id) } }),
      'utf8',
    )
    expect(createStore(path).skills.some((s) => s.id === 'core/debugging')).toBe(false)
    rmSync(d, { recursive: true, force: true })
  })

  it('drops malformed notes on load and migrates the good ones into memory', () => {
    const d = mkdtempSync(join(tmpdir(), 'agentcontrol-meta-'))
    const path = join(d, 'store.json')
    writeFileSync(path, legacy({ skills: [], notes: [{ id: 'n1', title: 't', body: 'b' }, { title: 'no id' }, 'junk'] }), 'utf8')
    const loaded = createStore(path)
    expect(loaded.notes).toEqual([])
    expect(loaded.memories.map((m) => m.text)).toEqual(['t: b'])
    rmSync(d, { recursive: true, force: true })
  })

  it('never serves meta from any route', async () => {
    for (const url of ['/api/skills', '/api/settings', '/api/agents', '/api/tools', '/api/notes']) {
      expect(JSON.stringify((await inject('GET', url)).json())).not.toContain('seededSkillIds')
    }
  })
})

describe('seed data integrity', () => {
  it('pins the vendored seed bodies (the tools migration compares content)', () => {
    const pinned: Record<string, string> = {
      'core/code-review': '306c451504e224af7b2b02839e71c5c72ec9b7eb1734980e29a7b73c5db88af0',
      'core/debugging': 'e4163cedaecee9abf765750fe8813fea8569d969819eab30abd1e2a5800552c2',
      'core/deep-research': 'c1b37bd73105e2860955e19082f52555f6e72d8d2f338b0c7708e062e5080e67',
      'core/multi-agent-orchestration': '519e7934e125feb8a3a8d2c56996a9c8e274207567a8115fc034387e312263a5',
      'core/summarization': 'd0489707af6cd52a188e8b15dbec05c326894915a7641157d701a7e954a0485a',
      'core/technical-writing': '385f4d1d0e3619a3b58df43393efc83c28c5c0502f121bbdebeb854327610229',
    }
    const actual = Object.fromEntries(
      vendoredSeedSkills.map((s) => [s.id, createHash('sha256').update(s.content).digest('hex')]),
    )
    expect(actual).toEqual(pinned)
  })

  it('ships store.example.json without skills, so a copy gets the real seeds', () => {
    const examplePath = new URL('../data/store.example.json', import.meta.url)
    const example = JSON.parse(readFileSync(examplePath, 'utf8')) as Record<string, unknown>
    expect(example).not.toHaveProperty('skills')
    const d = mkdtempSync(join(tmpdir(), 'agentcontrol-example-'))
    const path = join(d, 'store.json')
    writeFileSync(path, JSON.stringify(example), 'utf8')
    const loaded = createStore(path)
    expect(loaded.skills.map((s) => s.id)).toEqual(seedSkills.map((s) => s.id))
    for (const s of loaded.skills) expect(typeof s.content === 'string' && s.content.length > 0).toBe(true)
    rmSync(d, { recursive: true, force: true })
  })
})

describe('endpoint proxyUrl field', () => {
  it('stores, keeps, validates and clears proxyUrl', async () => {
    const base = { kind: 'openai-compatible', name: 'Proxied', baseUrl: 'http://100.79.242.24:8791', defaultModel: 'm', contextWindow: 8192 }
    for (const proxyUrl of ['ftp://x:1', 'socks4://x:1', 'socks://x:1', 'not a url']) {
      const bad = await inject('POST', '/api/endpoints', { ...base, proxyUrl })
      expect(bad.statusCode, proxyUrl).toBe(400)
    }
    for (const proxyUrl of ['socks5://localhost:1055', 'socks5h://localhost:1055', 'https://proxy.example:443']) {
      const ok = await inject('POST', '/api/endpoints', { ...base, proxyUrl })
      expect(ok.statusCode, proxyUrl).toBe(201)
      expect((ok.json() as Endpoint).proxyUrl).toBe(proxyUrl)
    }
    const res = await inject('POST', '/api/endpoints', { ...base, proxyUrl: 'http://localhost:1055/' })
    expect(res.statusCode).toBe(201)
    const ep = res.json() as Endpoint
    expect(ep.proxyUrl).toBe('http://localhost:1055')
    const kept = await inject('PATCH', `/api/endpoints/${ep.id}`, { name: 'Renamed' })
    expect((kept.json() as Endpoint).proxyUrl).toBe('http://localhost:1055')
    const cleared = await inject('PATCH', `/api/endpoints/${ep.id}`, { proxyUrl: '' })
    expect((cleared.json() as Endpoint).proxyUrl).toBeUndefined()
  })

  it('rejects a proxy with no host', async () => {
    const base = { kind: 'openai-compatible', name: 'Proxied', baseUrl: 'http://100.79.242.24:8791', defaultModel: 'm', contextWindow: 8192 }
    for (const proxyUrl of ['socks5h://', 'socks5://', 'socks5h:', 'http://']) {
      const bad = await inject('POST', '/api/endpoints', { ...base, proxyUrl })
      expect(bad.statusCode, proxyUrl).toBe(400)
    }
  })

  it('masks the proxy password and keeps the stored one when the mask comes back', async () => {
    const base = { kind: 'openai-compatible', name: 'Proxied', baseUrl: 'http://100.79.242.24:8791', defaultModel: 'm', contextWindow: 8192 }
    const res = await inject('POST', '/api/endpoints', { ...base, proxyUrl: 'socks5h://cole:s3cret@localhost:1055' })
    expect(res.statusCode).toBe(201)
    const ep = res.json() as Endpoint
    expect(ep.proxyUrl).toBe('socks5h://cole:***@localhost:1055')
    const listed = ((await inject('GET', '/api/endpoints')).json() as Endpoint[]).find((e) => e.id === ep.id)!
    expect(listed.proxyUrl).toBe('socks5h://cole:***@localhost:1055')
    expect(JSON.stringify((await inject('GET', '/api/endpoints')).json())).not.toContain('s3cret')
    const stored = () => store.endpoints.find((e) => e.id === ep.id)!.proxyUrl
    expect(stored()).toBe('socks5h://cole:s3cret@localhost:1055')

    // Sending the mask back (e.g. a form re-save) keeps the stored password.
    const resent = await inject('PATCH', `/api/endpoints/${ep.id}`, { name: 'Again', proxyUrl: listed.proxyUrl })
    expect(resent.statusCode).toBe(200)
    expect((resent.json() as Endpoint).proxyUrl).toBe('socks5h://cole:***@localhost:1055')
    expect(stored()).toBe('socks5h://cole:s3cret@localhost:1055')
    // The mask with any other scheme, host, port or user is refused, so the
    // saved password never goes to a proxy it wasn't saved for.
    for (const proxyUrl of [
      'socks5h://cole:***@127.0.0.1:1055', 'socks5h://cole:***@localhost:1056',
      'socks5://cole:***@localhost:1055', 'http://cole:***@localhost:1055', 'socks5h://other:***@localhost:1055',
    ]) {
      const moved = await inject('PATCH', `/api/endpoints/${ep.id}`, { proxyUrl })
      expect(moved.statusCode, proxyUrl).toBe(400)
      expect(moved.json()).toMatchObject({ message: 'Re-enter the proxy password for the new host' })
      expect(stored()).toBe('socks5h://cole:s3cret@localhost:1055')
    }
    // A new host with a real password is fine.
    await inject('PATCH', `/api/endpoints/${ep.id}`, { proxyUrl: 'socks5h://cole:n3w@127.0.0.1:1055' })
    expect(stored()).toBe('socks5h://cole:n3w@127.0.0.1:1055')
    // No stored proxy to take the password from: the mask is refused.
    const fresh = await inject('POST', '/api/endpoints', { ...base, name: 'Fresh' })
    const masked = await inject('PATCH', `/api/endpoints/${(fresh.json() as Endpoint).id}`, { proxyUrl: 'socks5h://cole:***@localhost:1055' })
    expect(masked.statusCode).toBe(400)
  })
})

describe('chat-first Part 1: agent profile fields', () => {
  async function agentBody(endpointId: string, extra: Record<string, unknown> = {}) {
    return { name: 'Profiled', description: '', instructions: 'Be brief.', modelId: 'test-model', endpointId, skillIds: [], ...extra }
  }

  it('creates and keeps rules, color, pinned, hidden and an emoji avatar', async () => {
    const { endpoint } = await makeRunner()
    const res = await inject('POST', '/api/agents', await agentBody(endpoint.id, {
      rules: ['  Answer in English.  ', '', 'Never guess numbers.'],
      color: '#AABBCC',
      pinned: true,
      hidden: false,
      avatar: { kind: 'emoji', value: '🦊' },
    }))
    expect(res.statusCode).toBe(201)
    const agent = res.json() as Agent
    expect(agent.rules).toEqual(['Answer in English.', 'Never guess numbers.'])
    expect(agent.color).toBe('#aabbcc')
    expect(agent.pinned).toBe(true)
    expect(agent.hidden).toBe(false)
    expect(agent.avatar).toEqual({ kind: 'emoji', value: '🦊' })

    // An update that omits them keeps them; null clears color and avatar.
    const kept = await inject('PUT', `/api/agents/${agent.id}`, await agentBody(endpoint.id))
    expect((kept.json() as Agent).rules).toEqual(agent.rules)
    expect((kept.json() as Agent).avatar).toEqual(agent.avatar)
    const cleared = await inject('PUT', `/api/agents/${agent.id}`, await agentBody(endpoint.id, { color: null, avatar: null }))
    const next = cleared.json() as Agent
    expect(next.color).toBeUndefined()
    expect(next.avatar).toBeUndefined()
    expect(next.rules).toEqual(agent.rules)

    // Persisted across a reload.
    const reloaded = createStore(join(dir, 'store.json'))
    expect(reloaded.agents.find((a) => a.id === agent.id)?.rules).toEqual(agent.rules)
  })

  it('rejects bad profile fields with 400', async () => {
    const { endpoint } = await makeRunner()
    for (const extra of [
      { rules: 'one rule' },
      { rules: Array.from({ length: 21 }, (_, i) => `r${i}`) },
      { rules: ['x'.repeat(501)] },
      { color: 'red' },
      { pinned: 'yes' },
      { avatar: { kind: 'image', file: '../store.json' } },
      { avatar: { kind: 'emoji', value: '' } },
    ]) {
      const res = await inject('POST', '/api/agents', await agentBody(endpoint.id, extra))
      expect(res.statusCode, JSON.stringify(extra)).toBe(400)
    }
  })

  it('sends rules as their own section and leaves rule-less prompts byte-identical', async () => {
    const mock = mockChat('ok')
    const { agent, endpoint } = await makeRunner()
    await inject('POST', `/api/agents/${agent.id}/runs`, { input: 'hi' })
    const before = lastRequest(mock).messages?.[0]?.content ?? ''
    expect(before).not.toContain('## Rules')

    await inject('PUT', `/api/agents/${agent.id}`, {
      name: 'Runner', description: '', instructions: 'Be brief.', modelId: 'test-model',
      endpointId: endpoint.id, skillIds: ['core/summarization'], rules: ['Answer in English.'],
    })
    await inject('POST', `/api/agents/${agent.id}/runs`, { input: 'hi' })
    const after = lastRequest(mock).messages?.[0]?.content ?? ''
    expect(after.startsWith('Be brief.\n\n## Rules\nAlways follow these rules:\n- Answer in English.')).toBe(true)
    expect(after.replace('\n\n## Rules\nAlways follow these rules:\n- Answer in English.', '')).toBe(before)
  })

  it('counts rules in the prompt budget', async () => {
    const { endpoint } = await makeRunner()
    const base = await inject('POST', '/api/prompt-budget', { endpointId: endpoint.id, skillIds: [], instructions: 'Hi.' })
    expect(base.statusCode).toBe(200)
    const withRules = await inject('POST', '/api/prompt-budget', {
      endpointId: endpoint.id, skillIds: [], instructions: 'Hi.', rules: ['x'.repeat(400)],
    })
    expect(withRules.json().estimatedTokens).toBeGreaterThan(base.json().estimatedTokens)
    expect(base.json().rulesTokens).toBe(0)
    expect(withRules.json().rulesTokens).toBeGreaterThan(0)
  })

  it('uploads, serves, replaces and deletes an image avatar under data/avatars', async () => {
    const { agent } = await makeRunner()
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    const up = await app.inject({ method: 'PUT', url: `/api/agents/${agent.id}/avatar`, payload: png, headers: { 'content-type': 'image/png' } })
    expect(up.statusCode).toBe(200)
    const withImage = up.json() as Agent
    expect(withImage.avatar).toMatchObject({ kind: 'image', file: `${agent.id}.png` })
    expect(existsSync(join(dir, 'avatars', `${agent.id}.png`))).toBe(true)

    const got = await app.inject({ method: 'GET', url: `/api/agents/${agent.id}/avatar` })
    expect(got.statusCode).toBe(200)
    expect(got.headers['content-type']).toBe('image/png')
    expect(got.rawPayload.equals(png)).toBe(true)

    const jpg = await app.inject({ method: 'PUT', url: `/api/agents/${agent.id}/avatar`, payload: Buffer.from([0xff, 0xd8, 1]), headers: { 'content-type': 'image/jpeg' } })
    expect((jpg.json() as Agent).avatar).toMatchObject({ file: `${agent.id}.jpg` })
    expect(existsSync(join(dir, 'avatars', `${agent.id}.png`))).toBe(false)

    const del = await inject('DELETE', `/api/agents/${agent.id}/avatar`)
    expect(del.statusCode).toBe(200)
    expect((del.json() as Agent).avatar).toBeUndefined()
    expect(existsSync(join(dir, 'avatars', `${agent.id}.jpg`))).toBe(false)
    expect((await app.inject({ method: 'GET', url: `/api/agents/${agent.id}/avatar` })).statusCode).toBe(404)
  })

  it('rejects other types, oversized images and unknown agents', async () => {
    const { agent } = await makeRunner()
    const svg = await app.inject({ method: 'PUT', url: `/api/agents/${agent.id}/avatar`, payload: '<svg/>', headers: { 'content-type': 'image/svg+xml' } })
    expect(svg.statusCode).toBe(415)
    const big = await app.inject({ method: 'PUT', url: `/api/agents/${agent.id}/avatar`, payload: Buffer.alloc(1024 * 1024 + 1), headers: { 'content-type': 'image/png' } })
    expect(big.statusCode).toBe(413)
    const missing = await app.inject({ method: 'PUT', url: '/api/agents/agt_nope/avatar', payload: Buffer.from([1]), headers: { 'content-type': 'image/png' } })
    expect(missing.statusCode).toBe(404)
  })

  it('removes the avatar file when the agent is deleted', async () => {
    const { endpoint } = await makeRunner()
    const agent = (await inject('POST', '/api/agents', await agentBody(endpoint.id))).json() as Agent
    expect(agent.isPrimary).toBe(false)
    await app.inject({ method: 'PUT', url: `/api/agents/${agent.id}/avatar`, payload: Buffer.from([1, 2]), headers: { 'content-type': 'image/webp' } })
    expect(existsSync(join(dir, 'avatars', `${agent.id}.webp`))).toBe(true)
    const res = await inject('DELETE', `/api/agents/${agent.id}`)
    expect(res.statusCode).toBe(204)
    expect(existsSync(join(dir, 'avatars', `${agent.id}.webp`))).toBe(false)
  })
})

describe('chat-first Part 2: conversations', () => {
  async function dmFor(agentId: string) {
    const list = (await inject('GET', '/api/conversations')).json() as ConversationSummary[]
    const dm = list.find((c) => c.kind === 'dm' && c.agentId === agentId)
    expect(dm).toBeDefined()
    return dm as ConversationSummary
  }

  it('lists a DM for every agent, newest first', async () => {
    const res = await inject('GET', '/api/conversations')
    expect(res.statusCode).toBe(200)
    const list = res.json() as ConversationSummary[]
    for (const agent of store.agents) expect(list.some((c) => c.kind === 'dm' && c.agentId === agent.id)).toBe(true)
    const times = list.map((c) => c.updatedAt)
    expect(times).toEqual([...times].sort().reverse())
    // Listing twice does not create duplicates.
    const again = (await inject('GET', '/api/conversations')).json() as ConversationSummary[]
    expect(again.map((c) => c.id).sort()).toEqual(list.map((c) => c.id).sort())
  })

  it('records 1:1 runs as messages, counts unread, and marks read', async () => {
    const { agent } = await makeRunner()
    mockChat('hello back')
    expect((await inject('POST', `/api/agents/${agent.id}/runs`, { input: 'hi' })).statusCode).toBe(200)

    const dm = await dmFor(agent.id)
    expect(dm.unreadCount).toBe(1)
    expect(dm.lastMessage).toMatchObject({ role: 'assistant', content: 'hello back' })

    const page = await inject('GET', `/api/conversations/${dm.id}/messages`)
    expect(page.statusCode).toBe(200)
    const body = page.json() as { conversation: Conversation; messages: ChatMessage[] }
    expect(body.conversation.id).toBe(dm.id)
    expect(body.messages.map((m) => [m.role, m.content])).toEqual([['user', 'hi'], ['assistant', 'hello back']])
    expect(body.messages[0]?.runId).toBe(body.messages[1]?.runId)

    const read = await inject('POST', `/api/conversations/${dm.id}/read`)
    expect(read.statusCode).toBe(200)
    expect(read.json()).toMatchObject({ id: dm.id, unreadCount: 0 })
    expect((read.json() as ConversationSummary).lastReadAt).not.toBeNull()
    expect((await dmFor(agent.id)).unreadCount).toBe(0)

    // Persisted across a reload.
    const reloaded = createStore(join(dir, 'store.json'))
    expect(reloaded.chatMessages.filter((m) => m.conversationId === dm.id)).toHaveLength(2)
    expect(reloaded.conversations.find((c) => c.id === dm.id)?.lastReadAt).toBe((read.json() as ConversationSummary).lastReadAt)
  })

  it('pages with before and limit, and validates them', async () => {
    const { agent } = await makeRunner()
    mockChat('ok')
    for (const input of ['one', 'two', 'three']) await inject('POST', `/api/agents/${agent.id}/runs`, { input })
    const dm = await dmFor(agent.id)
    const all = ((await inject('GET', `/api/conversations/${dm.id}/messages`)).json() as { messages: ChatMessage[] }).messages
    expect(all).toHaveLength(6)
    const last2 = ((await inject('GET', `/api/conversations/${dm.id}/messages?limit=2`)).json() as { messages: ChatMessage[] }).messages
    expect(last2).toEqual(all.slice(-2))
    const cutoff = all[2]?.createdAt as string
    const older = ((await inject('GET', `/api/conversations/${dm.id}/messages?before=${encodeURIComponent(cutoff)}`)).json() as { messages: ChatMessage[] }).messages
    expect(older.every((m) => m.createdAt < cutoff)).toBe(true)
    expect((await inject('GET', `/api/conversations/${dm.id}/messages?limit=0`)).statusCode).toBe(400)
    expect((await inject('GET', `/api/conversations/${dm.id}/messages?before=nope`)).statusCode).toBe(400)
  })

  it('404s unknown conversations', async () => {
    expect((await inject('GET', '/api/conversations/nope/messages')).statusCode).toBe(404)
    expect((await inject('POST', '/api/conversations/nope/read')).statusCode).toBe(404)
  })

  it('keeps project runs out of DMs', async () => {
    const { agent } = await makeRunner()
    const { executeRun } = await import('./runs.js')
    mockChat('project reply')
    await executeRun(store, store.agents.find((a) => a.id === agent.id) as Agent, 'task input', { projectId: 'proj-x' })
    expect(store.chatMessages.some((m) => m.content === 'task input')).toBe(false)
    const dm = await dmFor(agent.id)
    const msgs = ((await inject('GET', `/api/conversations/${dm.id}/messages`)).json() as { messages: ChatMessage[] }).messages
    expect(msgs.some((m) => m.content === 'task input')).toBe(false)
  })

  it('clearing an agent chat empties its DM; deleting the agent drops it', async () => {
    const { endpoint } = await makeRunner()
    const created = await inject('POST', '/api/agents', {
      name: 'Second', description: '', instructions: 'Be brief.', modelId: 'test-model', endpointId: endpoint.id, skillIds: [],
    })
    expect(created.statusCode).toBe(201)
    const agent = created.json() as Agent
    mockChat('x')
    await inject('POST', `/api/agents/${agent.id}/runs`, { input: 'hi' })
    const dm = await dmFor(agent.id)
    expect((await inject('DELETE', `/api/agents/${agent.id}/runs`)).statusCode).toBe(204)
    expect(((await inject('GET', `/api/conversations/${dm.id}/messages`)).json() as { messages: ChatMessage[] }).messages).toEqual([])
    expect((await inject('DELETE', `/api/agents/${agent.id}`)).statusCode).toBe(204)
    expect((await inject('GET', `/api/conversations/${dm.id}/messages`)).statusCode).toBe(404)
  })

  it('migrates legacy 1:1 runs once, as read history, and is idempotent', async () => {
    const { agent } = await makeRunner()
    const legacyDir = mkdtempSync(join(tmpdir(), 'ac-conv-'))
    try {
      const path = join(legacyDir, 'store.json')
      writeFileSync(path, readFileSync(join(dir, 'store.json'), 'utf8'))
      const agentId = agent.id
      const run = (id: string, at: string, extra: Partial<AgentRun> = {}): AgentRun => ({
        id, agentId, startedAt: at, status: 'succeeded', durationMs: 1000, steps: 1, input: `in ${id}`, output: `out ${id}`, error: null, ...extra,
      })
      // Simulate a pre-Part-2 store.json: no conversations, no marker.
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> & { meta: { migrations: string[] } }
      raw.runs = [
        run('r2', '2026-01-02T00:00:00.000Z'),
        run('r1', '2026-01-01T00:00:00.000Z'),
        run('rp', '2026-01-03T00:00:00.000Z', { projectId: 'p1' }),
      ]
      delete raw.conversations
      delete raw.chatMessages
      raw.meta.migrations = raw.meta.migrations.filter((m) => m !== 'conversations-from-runs-v1')
      writeFileSync(path, JSON.stringify(raw))

      const first = createStore(path)
      const dm = first.conversations.find((c) => c.kind === 'dm' && c.agentId === agentId) as Conversation
      const msgs = first.chatMessages.filter((m) => m.conversationId === dm.id)
      expect(msgs.map((m) => m.content)).toEqual(['in r1', 'out r1', 'in r2', 'out r2'])
      expect(dm.lastReadAt).toBe(dm.updatedAt)
      expect(dm.updatedAt).toBe('2026-01-02T00:00:01.000Z')
      expect(first.meta.migrations).toContain('conversations-from-runs-v1')

      // Reloading never duplicates.
      const second = createStore(path)
      expect(second.chatMessages).toHaveLength(first.chatMessages.length)
      expect(second.conversations).toHaveLength(first.conversations.length)

      // Even with the marker lost, runId dedupe keeps it idempotent.
      const again = JSON.parse(readFileSync(path, 'utf8')) as { meta: { migrations: string[] } }
      again.meta.migrations = again.meta.migrations.filter((m) => m !== 'conversations-from-runs-v1')
      writeFileSync(path, JSON.stringify(again))
      const third = createStore(path)
      expect(third.chatMessages).toHaveLength(first.chatMessages.length)
    } finally {
      rmSync(legacyDir, { recursive: true, force: true })
    }
  })

  it('sends through the DM route and returns the turn', async () => {
    const { agent } = await makeRunner()
    const dm = await dmFor(agent.id)
    mockChat('pong')
    const res = await inject('POST', `/api/conversations/${dm.id}/messages`, { text: '  ping  ' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { conversation: ConversationSummary; messages: ChatMessage[]; run: { status: string } }
    expect(body.messages.map((m) => [m.role, m.content])).toEqual([['user', 'ping'], ['assistant', 'pong']])
    expect(body.conversation).toMatchObject({ id: dm.id, unreadCount: 1 })
    expect(body.run.status).toBe('succeeded')
    expect((await inject('POST', `/api/conversations/${dm.id}/messages`, { text: ' ' })).statusCode).toBe(400)
    expect((await inject('POST', '/api/conversations/nope/messages', { text: 'x' })).statusCode).toBe(404)
    const page = (await inject('GET', `/api/conversations/${dm.id}/messages?limit=1`)).json() as { hasMore: boolean }
    expect(page.hasMore).toBe(true)
    const full = (await inject('GET', `/api/conversations/${dm.id}/messages`)).json() as { hasMore: boolean }
    expect(full.hasMore).toBe(false)
  })

  it('accepts `content` on the DM send, keeps `text` as an alias, and prefers `content`', async () => {
    const { agent } = await makeRunner()
    const dm = await dmFor(agent.id)
    mockChat('one')
    const a = (await inject('POST', `/api/conversations/${dm.id}/messages`, { content: ' hello ' })).json() as { messages: ChatMessage[] }
    expect(a.messages[0]).toMatchObject({ role: 'user', content: 'hello' })
    mockChat('two')
    const b = (await inject('POST', `/api/conversations/${dm.id}/messages`, { content: 'wins', text: 'loses' })).json() as { messages: ChatMessage[] }
    expect(b.messages[0]).toMatchObject({ role: 'user', content: 'wins' })
    mockChat('three')
    const c = (await inject('POST', `/api/conversations/${dm.id}/messages`, { text: 'alias' })).json() as { messages: ChatMessage[] }
    expect(c.messages[0]).toMatchObject({ role: 'user', content: 'alias' })
    const empty = await inject('POST', `/api/conversations/${dm.id}/messages`, { content: '  ', text: 'ignored' })
    expect(empty.statusCode).toBe(400)
    expect((empty.json() as { message: string }).message).toContain('content')
  })

  it('runs first-run profile setup and edits', async () => {
    const fresh = (await inject('GET', '/api/profile')).json() as { name: string; onboardedAt: string | null }
    expect(fresh).toEqual({ name: '', onboardedAt: null })
    expect((await inject('PUT', '/api/profile', { name: '  ' })).statusCode).toBe(400)
    expect((await inject('PUT', '/api/profile', { name: 'x'.repeat(81) })).statusCode).toBe(400)
    expect((await inject('PUT', '/api/profile', { name: 'C', avatar: { kind: 'image' } })).statusCode).toBe(400)
    expect(((await inject('GET', '/api/profile')).json() as { onboardedAt: unknown }).onboardedAt).toBeNull()

    const saved = await inject('PUT', '/api/profile', { name: ' Charles ', avatar: { kind: 'emoji', value: '🦊' } })
    expect(saved.statusCode).toBe(200)
    const p1 = saved.json() as { name: string; avatar: unknown; onboardedAt: string }
    expect(p1).toMatchObject({ name: 'Charles', avatar: { kind: 'emoji', value: '🦊' } })
    expect(typeof p1.onboardedAt).toBe('string')

    // Later edits keep onboardedAt and (when omitted) the avatar.
    const edited = (await inject('PUT', '/api/profile', { name: 'Chuck' })).json() as typeof p1
    expect(edited).toMatchObject({ name: 'Chuck', avatar: p1.avatar, onboardedAt: p1.onboardedAt })
    expect(createStore(join(dir, 'store.json')).profile.name).toBe('Chuck')

    // Image upload, fetch, delete.
    const png = Buffer.from('89504e470d0a1a0a', 'hex')
    const up = await app.inject({ method: 'PUT', url: '/api/profile/avatar', payload: png, headers: { 'content-type': 'image/png' } })
    expect(up.statusCode).toBe(200)
    expect((up.json() as { avatar: { kind: string } }).avatar.kind).toBe('image')
    const got = await inject('GET', '/api/profile/avatar')
    expect(got.statusCode).toBe(200)
    expect(got.headers['content-type']).toBe('image/png')
    expect((await app.inject({ method: 'PUT', url: '/api/profile/avatar', payload: 'x', headers: { 'content-type': 'text/plain' } })).statusCode).toBe(415)
    const del = await inject('DELETE', '/api/profile/avatar')
    expect((del.json() as { avatar?: unknown }).avatar).toBeUndefined()
    expect((await inject('GET', '/api/profile/avatar')).statusCode).toBe(404)
  })
})

describe('empty and length-cut replies', () => {
  function stubReply(message: Record<string, unknown>, finish_reason: string) {
    const mock = vi.fn(async (_url: string, _init?: { body?: string }) => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason }] }),
    }))
    vi.stubGlobal('fetch', mock)
    return mock
  }

  it('fails a run whose reply budget went to reasoning, with a clear error', async () => {
    const { agent } = await makeRunner()
    stubReply({ content: '', reasoning_content: 'thinking…' }, 'length')
    const run = (await inject('POST', `/api/agents/${agent.id}/runs`, { input: 'hi' })).json() as AgentRun
    expect(run.status).toBe('failed')
    expect(run.output).toBe('')
    expect(run.error).toMatch(/whole reply budget thinking/)
  })

  it('fails an empty stop reply too', async () => {
    const { agent } = await makeRunner()
    stubReply({ content: '   ' }, 'stop')
    const run = (await inject('POST', `/api/agents/${agent.id}/runs`, { input: 'hi' })).json() as AgentRun
    expect(run.status).toBe('failed')
    expect(run.error).toMatch(/empty reply/)
  })

  it('keeps a length-cut reply that has text', async () => {
    const { agent } = await makeRunner()
    stubReply({ content: 'partial answer' }, 'length')
    const run = (await inject('POST', `/api/agents/${agent.id}/runs`, { input: 'hi' })).json() as AgentRun
    expect(run.status).toBe('succeeded')
    expect(run.output).toBe('partial answer')
  })

  it('stores disableThinking and sends chat_template_kwargs only when on', async () => {
    const { endpoint, agent } = await makeRunner()
    expect((await inject('PATCH', `/api/endpoints/${endpoint.id}`, { disableThinking: 'yes' })).statusCode).toBe(400)
    const on = await inject('PATCH', `/api/endpoints/${endpoint.id}`, { disableThinking: true })
    expect((on.json() as Endpoint).disableThinking).toBe(true)
    let mock = stubReply({ content: 'ok' }, 'stop')
    await inject('POST', `/api/agents/${agent.id}/runs`, { input: 'hi' })
    expect(JSON.parse(mock.mock.calls.at(-1)?.[1]?.body ?? '{}').chat_template_kwargs).toEqual({ enable_thinking: false })

    // Omitted keeps it; false clears it.
    expect(((await inject('PATCH', `/api/endpoints/${endpoint.id}`, { name: 'Renamed' })).json() as Endpoint).disableThinking).toBe(true)
    const off = await inject('PATCH', `/api/endpoints/${endpoint.id}`, { disableThinking: false })
    expect((off.json() as Endpoint).disableThinking).toBeUndefined()
    mock = stubReply({ content: 'ok' }, 'stop')
    await inject('POST', `/api/agents/${agent.id}/runs`, { input: 'hi' })
    expect(JSON.parse(mock.mock.calls.at(-1)?.[1]?.body ?? '{}').chat_template_kwargs).toBeUndefined()
  })
})

describe('chat error flag', () => {
  it('flags failed-run replies, keeps it across reloads, and backfills old ones', async () => {
    const { agent } = await makeRunner()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, text: async () => 'down', json: async () => ({}) })))
    const list = (await inject('GET', '/api/conversations')).json() as ConversationSummary[]
    const dm = list.find((c) => c.kind === 'dm' && c.agentId === agent.id) as ConversationSummary
    const sent = (await inject('POST', `/api/conversations/${dm.id}/messages`, { text: 'hi' })).json() as { messages: ChatMessage[] }
    const reply = sent.messages.find((m) => m.role === 'assistant')
    expect(reply).toMatchObject({ error: true })
    expect(reply?.content).toMatch(/500/)
    expect(sent.messages.find((m) => m.role === 'user')?.error).toBeUndefined()

    mockChat('fine')
    const ok = (await inject('POST', `/api/conversations/${dm.id}/messages`, { text: 'again' })).json() as { messages: ChatMessage[] }
    expect(ok.messages.some((m) => m.error)).toBe(false)

    // Reload keeps the flag; a stored message missing it is backfilled from its failed run.
    const path = join(dir, 'store.json')
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { chatMessages: ChatMessage[] }
    for (const m of raw.chatMessages) delete m.error
    writeFileSync(path, JSON.stringify(raw))
    const reloaded = createStore(path)
    const flagged = reloaded.chatMessages.filter((m) => m.error === true)
    expect(flagged.map((m) => m.id)).toEqual([reply?.id])
  })
})

describe('endpoint maxOutputTokens', () => {
  it('validates, keeps, clears, and drives max_tokens and the budget preview', async () => {
    const { endpoint, agent } = await makeRunner()
    for (const bad of [0, -1, 1.5, 8192, 9000, '100']) {
      expect((await inject('PATCH', `/api/endpoints/${endpoint.id}`, { maxOutputTokens: bad })).statusCode).toBe(400)
    }
    const set = await inject('PATCH', `/api/endpoints/${endpoint.id}`, { maxOutputTokens: 1000 })
    expect((set.json() as Endpoint).maxOutputTokens).toBe(1000)
    expect(((await inject('PATCH', `/api/endpoints/${endpoint.id}`, { name: 'Kept' })).json() as Endpoint).maxOutputTokens).toBe(1000)
    // Shrinking the window below the budget is rejected.
    expect((await inject('PATCH', `/api/endpoints/${endpoint.id}`, { contextWindow: 1000 })).statusCode).toBe(400)

    const mock = mockChat('ok')
    await inject('POST', `/api/agents/${agent.id}/runs`, { input: 'hi' })
    expect(lastRequest(mock).max_tokens).toBe(1000)

    const budget = await inject('POST', '/api/prompt-budget', { endpointId: endpoint.id, skillIds: [] })
    expect((budget.json() as { responseReserve: number }).responseReserve).toBe(1000)

    const cleared = await inject('PATCH', `/api/endpoints/${endpoint.id}`, { maxOutputTokens: null })
    expect((cleared.json() as Endpoint).maxOutputTokens).toBeUndefined()
    const after = await inject('POST', '/api/prompt-budget', { endpointId: endpoint.id, skillIds: [] })
    expect((after.json() as { responseReserve: number }).responseReserve).toBe(4096)
  })

  it('accepts it on create', async () => {
    const res = await inject('POST', '/api/endpoints', {
      kind: 'openai-compatible', name: 'E', baseUrl: 'http://127.0.0.1:9', defaultModel: 'm', contextWindow: 8192, maxOutputTokens: 2048,
    })
    expect(res.statusCode).toBe(201)
    expect((res.json() as Endpoint).maxOutputTokens).toBe(2048)
    expect((await inject('POST', '/api/endpoints', {
      kind: 'openai-compatible', name: 'E', baseUrl: 'http://127.0.0.1:9', defaultModel: 'm', contextWindow: 8192, maxOutputTokens: 8192,
    })).statusCode).toBe(400)
  })
})
