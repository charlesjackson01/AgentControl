import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from './app.js'
import { createStore, type WorkspaceStore } from './store.js'
import type { Agent, AgentRun, Endpoint } from './shared/types.js'

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
  const mock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ index: 0, message: { role: 'assistant', content } }] }),
  }))
  vi.stubGlobal('fetch', mock)
  return mock
}

async function makeRunner() {
  const ep = await inject('POST', '/api/endpoints', {
    kind: 'openai-compatible',
    name: 'Test endpoint',
    baseUrl: 'http://127.0.0.1:9',
    defaultModel: 'test-model',
    contextWindow: 4096,
  })
  expect(ep.statusCode).toBe(201)
  const endpoint = ep.json() as Endpoint

  const ag = await inject('POST', '/api/agents', {
    name: 'Runner',
    description: '',
    instructions: 'Be brief.',
    modelId: 'test-model',
    endpointId: endpoint.id,
    skillIds: ['summarize'],
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
    const create = await inject('POST', '/api/agents', {
      name: 'Crud Agent',
      description: 'd',
      instructions: 'i',
      modelId: 'gpt-5.2',
      endpointId: null,
      skillIds: ['summarize'],
    })
    expect(create.statusCode).toBe(201)
    const agent = create.json() as Agent
    expect(agent.id).toBeTruthy()
    expect(agent.status).toBe('idle')
    expect(agent).not.toHaveProperty('recentRuns')

    const got = await inject('GET', `/api/agents/${agent.id}`)
    expect(got.statusCode).toBe(200)
    expect((got.json() as Agent).name).toBe('Crud Agent')
    expect(got.json()).not.toHaveProperty('recentRuns')

    const upd = await inject('PUT', `/api/agents/${agent.id}`, {
      name: 'Crud Agent v2',
      description: 'd2',
      instructions: 'i2',
      modelId: 'claude-haiku-4-5',
      endpointId: null,
      skillIds: ['summarize', 'webhook'],
    })
    expect(upd.statusCode).toBe(200)
    expect((upd.json() as Agent).name).toBe('Crud Agent v2')

    const list = await inject('GET', '/api/agents')
    expect(list.statusCode).toBe(200)
    expect((list.json() as Agent[]).some((a) => a.id === agent.id)).toBe(true)

    expect((await inject('DELETE', `/api/agents/${agent.id}`)).statusCode).toBe(204)
    expect((await inject('GET', `/api/agents/${agent.id}`)).statusCode).toBe(404)
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

describe('JSON parser regression', () => {
  it('bodyless DELETE with a JSON content-type returns 204', async () => {
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
    expect(res.statusCode).toBe(204)
  })
})
