import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp, defaultSkillIds } from './app.js'
import { botRoot } from './files.js'
import { draftBot, DRAFT_MAX_TOKENS, DRAFT_TIMEOUT_MS, extractJson, SANDBOX_LIMITS } from './sandbox.js'
import { createStore } from './store.js'
import type { Agent } from './shared/types.js'

/** BE-8: sandbox stub, PATCH internetPolicy, creation defaults and the /new draft. */

let dir = ''
let store: ReturnType<typeof createStore>
let app: ReturnType<typeof buildApp>

beforeEach(() => {
  vi.stubEnv('AGENTCONTROL_SECRET', 'sandbox-test-secret')
  vi.stubEnv('AGENTCONTROL_AUTH_TOKEN', '')
  dir = mkdtempSync(join(tmpdir(), 'agentcontrol-sandbox-'))
  store = createStore(join(dir, 'store.json'))
  app = buildApp(store)
})

afterEach(async () => {
  await app.close()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

const inject = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as object | undefined })

async function makeAgent(name: string): Promise<Agent> {
  const res = await inject('POST', '/api/agents', { name, endpointId: 'ep_local_llama', modelId: 'llama-3-8b' })
  expect(res.statusCode).toBe(201)
  return res.json() as Agent
}

async function makePrimary(): Promise<Agent> {
  const res = await inject('POST', '/api/agents', { name: 'Primary', endpointId: 'ep_local_llama', modelId: 'llama-3-8b', isPrimary: true })
  expect(res.statusCode).toBe(201)
  return res.json() as Agent
}

function mockChat(content: string | Error) {
  const mock = vi.fn(async () => {
    if (content instanceof Error) throw content
    return { ok: true, status: 200, json: async () => ({ choices: [{ index: 0, message: { role: 'assistant', content } }] }) }
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

describe('GET/PATCH /api/agents/:id/sandbox', () => {
  it('returns the Phase 1 stub with policy, fixed limits, folder usage and no runs', async () => {
    const bot = await makeAgent('Sandboxed')
    const root = botRoot(store, store.agents.find((a) => a.id === bot.id)!)
    mkdirSync(join(root, 'workspace'), { recursive: true })
    writeFileSync(join(root, 'workspace', 'a.txt'), 'x'.repeat(1234))
    const res = await inject('GET', `/api/agents/${bot.id}/sandbox`)
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toMatchObject({
      internetPolicy: 'ask',
      vm: { status: 'not-available', phase: 2, message: 'Bot VM arrives in Phase 2' },
      limits: SANDBOX_LIMITS,
      runs: [],
    })
    expect(body.limits).toEqual({ cpus: 2, memoryMb: 1024, timeoutSec: 60, pids: 256, outputMb: 200, diskQuotaMb: 500 })
    expect(body.usage.bytes).toBeGreaterThanOrEqual(1234)
    expect(JSON.stringify(body)).not.toContain(dir)
  })

  it('404s for an unknown bot', async () => {
    expect((await inject('GET', '/api/agents/nope/sandbox')).statusCode).toBe(404)
    expect((await inject('PATCH', '/api/agents/nope/sandbox', { internetPolicy: 'never' })).statusCode).toBe(404)
  })

  it('PATCH saves internetPolicy and returns the same shape; the agent reflects it', async () => {
    const bot = await makeAgent('Policy')
    const res = await inject('PATCH', `/api/agents/${bot.id}/sandbox`, { internetPolicy: 'never' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ internetPolicy: 'never', vm: { status: 'not-available' }, runs: [] })
    const agent = (await inject('GET', `/api/agents/${bot.id}`)).json() as Agent
    expect(agent.internetPolicy).toBe('never')
    expect(createStore(join(dir, 'store.json')).agents.find((a) => a.id === bot.id)?.internetPolicy).toBe('never')
  })

  it('PATCH rejects bad policies, other keys and non-objects without changing anything', async () => {
    const bot = await makeAgent('Strict')
    for (const payload of [{ internetPolicy: 'sometimes' }, { internetPolicy: 1 }, { limits: { cpus: 8 } }, [1]]) {
      const res = await inject('PATCH', `/api/agents/${bot.id}/sandbox`, payload)
      expect(res.statusCode).toBe(400)
      expect(res.json()).toMatchObject({ statusCode: 400, error: 'Request Error' })
    }
    expect(store.agents.find((a) => a.id === bot.id)?.internetPolicy).toBe('ask')
  })

  it('POST /api/agents honors internetPolicy and memoryLearn from the /new card', async () => {
    const res = await inject('POST', '/api/agents', { name: 'Offline', endpointId: 'ep_local_llama', modelId: 'llama-3-8b', internetPolicy: 'never', memoryLearn: false })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ internetPolicy: 'never', memoryLearn: false })
    expect((await makeAgent('Defaulted'))).toMatchObject({ internetPolicy: 'ask', memoryLearn: true })
    const bad = await inject('POST', '/api/agents', { name: 'Bad', endpointId: 'ep_local_llama', modelId: 'llama-3-8b', internetPolicy: 'x' })
    expect(bad.statusCode).toBe(400)
  })

  it('PATCH /api/agents/:id also takes internetPolicy and validates it', async () => {
    const bot = await makeAgent('ViaAgent')
    expect((await inject('PATCH', `/api/agents/${bot.id}`, { internetPolicy: 'always' })).statusCode).toBe(200)
    expect((await inject('GET', `/api/agents/${bot.id}/sandbox`)).json().internetPolicy).toBe('always')
    expect((await inject('PATCH', `/api/agents/${bot.id}`, { internetPolicy: 'maybe' })).statusCode).toBe(400)
  })
})

describe('GET /api/agents/defaults', () => {
  it('counts default-on skills by source and uses Primary endpoint and model', async () => {
    await makePrimary()
    const res = await inject('GET', '/api/agents/defaults')
    expect(res.statusCode).toBe(200)
    const body = res.json() as { skills: { sourceId: string; count: number }[]; internetPolicy: string; endpointId: string; modelId: string }
    const ids = defaultSkillIds(store.skills)
    expect(body.skills.reduce((n, s) => n + s.count, 0)).toBe(ids.length)
    for (const s of body.skills) {
      expect(s.count).toBe(ids.filter((id) => store.skills.find((k) => k.id === id)?.sourceId === s.sourceId).length)
    }
    const primary = store.agents.find((a) => a.isPrimary)!
    expect(body).toMatchObject({ internetPolicy: 'ask', endpointId: primary.endpointId, modelId: primary.modelId })
  })

  it('without a Primary, uses the first endpoint and its default model', async () => {
    const body = (await inject('GET', '/api/agents/defaults')).json()
    expect(body).toMatchObject({ endpointId: store.endpoints[0]!.id, modelId: store.endpoints[0]!.defaultModel })
  })

  it('is not mistaken for an agent id', async () => {
    const res = await inject('GET', '/api/agents/defaults')
    expect(res.json()).not.toHaveProperty('name')
  })
})

describe('POST /api/agents/draft', () => {
  const good = { name: 'Trip Planner', role: 'Travel helper', description: 'Plans trips.', avatarEmoji: '✈️', rules: ['Ask dates first.'] }

  it('returns a validated draft from Primary and creates nothing', async () => {
    await makePrimary()
    const mock = mockChat('```json\n' + JSON.stringify(good) + '\n```')
    const before = store.agents.length
    const res = await inject('POST', '/api/agents/draft', { prompt: 'A bot that plans trips' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(good)
    expect(store.agents.length).toBe(before)
    expect(mock).toHaveBeenCalledTimes(1)
    const sent = JSON.parse((mock.mock.calls[0] as unknown as [string, { body: string }])[1].body)
    expect(sent.model).toBe(store.agents.find((a) => a.isPrimary)!.modelId)
    expect(sent.messages.at(-1)).toMatchObject({ role: 'user', content: 'A bot that plans trips' })
  })

  it('falls back with a warning when there is no Primary, without calling upstream', async () => {
    const mock = mockChat(JSON.stringify(good))
    const res = await inject('POST', '/api/agents/draft', { prompt: 'anything' })
    expect(res.json()).toMatchObject({ name: '', rules: [] })
    expect(res.json().warning).toBeTruthy()
    expect(mock).not.toHaveBeenCalled()
  })

  it('falls back to a blank draft with a warning on invalid output', async () => {
    await makePrimary()
    for (const reply of ['not json at all', JSON.stringify({ ...good, name: '' }), JSON.stringify({ ...good, rules: 'x' })]) {
      mockChat(reply)
      const res = await inject('POST', '/api/agents/draft', { prompt: 'anything' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ name: '', role: '', description: '', avatarEmoji: '', rules: [] })
      expect(typeof res.json().warning).toBe('string')
    }
  })

  it('falls back with a warning when the upstream call fails', async () => {
    await makePrimary()
    mockChat(new Error('connect ECONNREFUSED'))
    const res = await inject('POST', '/api/agents/draft', { prompt: 'anything' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ name: '', rules: [] })
    expect(res.json().warning).toBeTruthy()
  })

  it('asks for 2,500 tokens and uses the endpoint timeout, defaulting to 30s', async () => {
    await makePrimary()
    const mock = mockChat(JSON.stringify(good))
    await inject('POST', '/api/agents/draft', { prompt: 'x' })
    const sent = JSON.parse((mock.mock.calls[0] as unknown as [string, { body: string }])[1].body)
    expect(sent.max_tokens).toBe(DRAFT_MAX_TOKENS)
    expect(DRAFT_MAX_TOKENS).toBe(2_500)
    expect(DRAFT_TIMEOUT_MS).toBe(30_000)
  })

  it('logs why it fell back: thrown errors, a cut-off reply and schema failures', async () => {
    await makePrimary()
    const logs: string[] = []
    mockChat(new Error('connect ECONNREFUSED'))
    await draftBot(store, 'x', (m) => logs.push(m))
    expect(logs.at(-1)).toContain('ECONNREFUSED')

    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ index: 0, finish_reason: 'length', message: { role: 'assistant', content: '{"name": "Tri' } }] }) })))
    await draftBot(store, 'x', (m) => logs.push(m))
    expect(logs.at(-1)).toContain('max_tokens 2500')
    expect(logs.at(-1)).toContain('finish_reason length')

    mockChat(JSON.stringify({ ...good, name: '' }))
    await draftBot(store, 'x', (m) => logs.push(m))
    expect(logs.at(-1)).toContain('"name"')
    expect(logs.join('\n')).not.toContain('sandbox-test-secret')
  })

  it('a cancelled draft aborts the upstream call and logs it', async () => {
    await makePrimary()
    let seen: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn((_u: string, init: { signal?: AbortSignal }) => {
      seen = init.signal
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
      })
    }))
    const cancel = new AbortController()
    const logs: string[] = []
    const pending = draftBot(store, 'x', (m) => logs.push(m), cancel.signal)
    await new Promise((r) => setTimeout(r, 10))
    cancel.abort()
    const out = await pending
    expect(seen?.aborted).toBe(true)
    expect(out).toMatchObject({ name: '', warning: 'The draft was cancelled.' })
    expect(logs.at(-1)).toContain('cancelled by the client')
  })

  it('the route aborts upstream when the client disconnects', async () => {
    await makePrimary()
    let aborted = false
    vi.stubGlobal('fetch', vi.fn((_u: string, init: { signal?: AbortSignal }) => new Promise((_r, reject) => {
      init.signal?.addEventListener('abort', () => { aborted = true; reject(Object.assign(new Error('aborted'), { name: 'AbortError' })) })
    })))
    await app.listen({ port: 0, host: '127.0.0.1' })
    const port = (app.server.address() as { port: number }).port
    const ac = new AbortController()
    const { request } = await import('undici')
    const call = request(`http://127.0.0.1:${port}/api/agents/draft`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'x' }), signal: ac.signal,
    }).catch(() => null)
    await new Promise((r) => setTimeout(r, 100))
    ac.abort()
    await call
    for (let i = 0; i < 50 && !aborted; i++) await new Promise((r) => setTimeout(r, 20))
    expect(aborted).toBe(true)
  })

  it('400s on a missing, blank or too-long prompt', async () => {
    for (const payload of [{}, { prompt: '   ' }, { prompt: 3 }, { prompt: 'x'.repeat(2001) }]) {
      expect((await inject('POST', '/api/agents/draft', payload)).statusCode).toBe(400)
    }
  })

  it('extractJson finds bare, fenced and embedded objects', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 })
    expect(extractJson('Sure!\n```json\n{"a":2}\n```')).toEqual({ a: 2 })
    expect(extractJson('Here: {"a":3} done')).toEqual({ a: 3 })
    expect(extractJson('nope')).toBeUndefined()
  })
})
