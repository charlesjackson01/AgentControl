import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from './app.js'
import { createStore, type WorkspaceStore } from './store.js'
import type { Agent, AgentRun, Endpoint, Skill } from './shared/types.js'

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
  messages?: { role: string; content: string }[]
  max_tokens?: number
}

/** Parse the body of the most recent mocked fetch call. */
function lastRequest(mock: ReturnType<typeof mockChat>): ChatRequest {
  const call = mock.mock.calls[mock.mock.calls.length - 1]
  return JSON.parse(call?.[1]?.body ?? '{}') as ChatRequest
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
    skillIds: ['summarization'],
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
      skillIds: ['summarization'],
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
      skillIds: ['summarization', 'debugging'],
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

  it('injects skill content into the system prompt and never sends tools', async () => {
    const mock = mockChat('ok')
    const { agent } = await makeRunner() // attached: the real "summarization" seed
    const res = await inject('POST', `/api/agents/${agent.id}/runs`, { input: 'hi' })
    expect(res.statusCode).toBe(200)

    const req = lastRequest(mock)
    const system = req.messages?.[0]?.content ?? ''
    expect(system).toContain('Be brief.')
    expect(system).toContain('## summarization')
    expect(system).toContain('condense long-form text')
    expect(req).not.toHaveProperty('tools')
  })
})

describe('run audit fields', () => {
  it('records systemPrompt and skillSnapshot for an injected skill', async () => {
    const mock = mockChat('ok')
    const { agent } = await makeRunner() // attached: the real "summarization" seed
    const res = await inject('POST', `/api/agents/${agent.id}/runs`, { input: 'hi' })
    expect(res.statusCode).toBe(200)

    const run = res.json() as AgentRun
    const skill = store.skills.find((s) => s.id === 'summarization') as Skill
    expect(run.systemPrompt).toContain('Be brief.')
    expect(run.systemPrompt).toContain('## summarization')
    expect(run.systemPrompt).toContain(skill.content.slice(0, 120))
    expect(run.skillSnapshot).toEqual([{ id: 'summarization', name: 'summarization', contentChars: skill.content.length }])

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
    expect(run.systemPrompt).toContain('## summarization')
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
    return (ag.json() as Agent).id
  }

  it('drops oldest history turns and keeps the newest', async () => {
    // 400-char turns => 200 tokens each. Window fits system+input+reserve plus
    // exactly two turns, so a five-turn history trims down to the two newest.
    const mock = mockChat('A'.repeat(400))
    const agentId = await makeBudgetRunner(4600)

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
    // ceil(1000 / 4) = 250 estimated of a 100-token window.
    expect((res.json() as { message: string }).message).toContain('estimated 250 of 100 tokens')
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
    expect(((await inject('GET', '/api/skills')).json() as unknown[]).length).toBeGreaterThan(0)
    expect(((await inject('GET', '/api/models')).json() as unknown[]).length).toBeGreaterThan(0)
  })
})

describe('skill seeds', () => {
  it('ships the six real SKILL.md skills with content and provenance', async () => {
    const skills = (await inject('GET', '/api/skills')).json() as Skill[]
    expect(skills.map((s) => s.id)).toEqual([
      'code-review',
      'debugging',
      'deep-research',
      'multi-agent-orchestration',
      'summarization',
      'technical-writing',
    ])
    for (const s of skills) {
      expect(s.content.length).toBeGreaterThan(100)
      expect(s.content).not.toMatch(/^---/)
      expect(s.source).toBe('seb1n/awesome-ai-agent-skills')
      expect(s.tools).toEqual([])
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
    expect((list.json() as Skill[]).some((s) => s.id === skill.id)).toBe(true)

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
      skillIds: [skillId, 'debugging'],
    })
    const leadId = (lead.json() as Agent).id

    const res = await inject('DELETE', `/api/skills/${skillId}`)
    expect(res.statusCode).toBe(204)

    const got = await inject('GET', `/api/agents/${leadId}`)
    expect((got.json() as Agent).skillIds).toEqual(['debugging'])
    expect(store.agents.find((a) => a.id === leadId)?.skillIds).toEqual(['debugging'])
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
    expect(merged.skills.some((s) => s.id === 'summarization')).toBe(true)
    expect(merged.skills.some((s) => s.id === 'multi-agent-orchestration')).toBe(true)

    // The merge is persisted, so a reload sees the upgraded catalog too.
    const reloaded = JSON.parse(readFileSync(oldPath, 'utf8')) as { skills: { id: string }[] }
    expect(reloaded.skills.some((s) => s.id === 'deep-research')).toBe(true)
    expect(reloaded.skills.some((s) => s.id === 'web-research')).toBe(true)

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
})
