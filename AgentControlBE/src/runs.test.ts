import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from './app.js'
import { executeRun, runAgent } from './runs.js'
import type { Agent, AgentRun } from './shared/types.js'
import { createStore, type WorkspaceStore } from './store.js'

/**
 * runAgent history scoping and retention (hermetic: stubbed fetch, temp
 * store). Project task runs see only earlier runs of the same project; the
 * agent's own chat never sees, lists, counts or clears project runs.
 */

let dir = ''
let app: FastifyInstance
let store: WorkspaceStore

type ChatRequest = { messages?: { role: string; content: string }[] }

/** Upstream that echoes the last user message as "out:<message>". */
function mockEcho(): ChatRequest[] {
  const requests: ChatRequest[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: { body?: string }) => {
      const req = JSON.parse(init?.body ?? '{}') as ChatRequest
      requests.push(req)
      const last = req.messages?.[req.messages.length - 1]?.content ?? ''
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ index: 0, message: { role: 'assistant', content: `out:${last}` } }] }),
      }
    }),
  )
  return requests
}

const contents = (req: ChatRequest | undefined): string[] => (req?.messages ?? []).map((m) => m.content)

async function makeAgent(name: string): Promise<Agent> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/agents',
    payload: { name, description: '', instructions: '', modelId: 'llama-3-8b', endpointId: 'ep_local_llama', skillIds: [] },
    headers: { 'content-type': 'application/json' },
  })
  expect(res.statusCode).toBe(201)
  const agent = store.agents.find((a) => a.id === (res.json() as Agent).id)
  if (!agent) throw new Error('agent not stored')
  return agent
}

beforeEach(() => {
  process.env.AGENTCONTROL_SECRET = 'test-secret'
  dir = mkdtempSync(join(tmpdir(), 'agentcontrol-runs-'))
  store = createStore(join(dir, 'store.json'))
  app = buildApp(store)
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await app.close()
  rmSync(dir, { recursive: true, force: true })
  delete process.env.AGENTCONTROL_SECRET
})

describe('runAgent history scoping', () => {
  it('keeps project runs and chat runs out of each other\'s history', async () => {
    const requests = mockEcho()
    const agent = await makeAgent('Scoped')

    // No instructions and no skills: no system message, so contents are the turns.
    await runAgent(store, agent, 'chat one')
    await runAgent(store, agent, 'task one', { projectId: 'proj_a' })
    expect(contents(requests[1])).toEqual(['task one'])

    await runAgent(store, agent, 'task two', { projectId: 'proj_a' })
    expect(contents(requests[2])).toEqual(['task one', 'out:task one', 'task two'])

    await runAgent(store, agent, 'other project', { projectId: 'proj_b' })
    expect(contents(requests[3])).toEqual(['other project'])

    // The agent's own chat (the route) sees only chat runs.
    const res = await app.inject({
      method: 'POST',
      url: `/api/agents/${agent.id}/runs`,
      payload: { input: 'chat two' },
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as AgentRun).projectId).toBeUndefined()
    expect(contents(requests[4])).toEqual(['chat one', 'out:chat one', 'chat two'])
  })

  it('records projectId on the run and keeps it across a store reload', async () => {
    mockEcho()
    const agent = await makeAgent('Recorder')
    const run = await runAgent(store, agent, 'a task', { projectId: 'proj_x' })
    expect(run).toMatchObject({ status: 'succeeded', output: 'out:a task', projectId: 'proj_x' })
    const chat = await runAgent(store, agent, 'a chat')
    expect('projectId' in chat).toBe(false)

    const reloaded = createStore(join(dir, 'store.json'))
    expect(reloaded.runs.find((r) => r.id === run.id)?.projectId).toBe('proj_x')
    expect(reloaded.runs.find((r) => r.id === chat.id)?.projectId).toBeUndefined()
    expect(agent.runCount).toBe(2)
  })

  it('throws the route errors: 400 without an endpoint, 413 when the input cannot fit', async () => {
    mockEcho()
    const agent = await makeAgent('Errors')
    await expect(runAgent(store, { ...agent, endpointId: 'ep_gone' }, 'hi')).rejects.toMatchObject({ statusCode: 400 })
    await expect(runAgent(store, agent, 'x'.repeat(40_000), { projectId: 'p' })).rejects.toMatchObject({ statusCode: 413 })
    expect(store.runs).toHaveLength(0)
  })
})

describe('run retention per scope', () => {
  const inject = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({ method, url, payload: payload as object | undefined, headers: { 'content-type': 'application/json' } })
  const listed = async (agentId: string): Promise<AgentRun[]> => {
    const res = await inject('GET', `/api/agents/${agentId}/runs`)
    expect(res.statusCode).toBe(200)
    return res.json() as AgentRun[]
  }

  it('keeps the newest 50 per agent and scope, so project work never trims or fills the chat', async () => {
    mockEcho()
    await makeAgent('Lead') // the first agent is the Team Lead
    const agent = await makeAgent('Busy')
    const chat: string[] = []
    for (let i = 0; i < 3; i++) {
      const res = await inject('POST', `/api/agents/${agent.id}/runs`, { input: `chat ${i}` })
      expect(res.statusCode).toBe(200)
      chat.push((res.json() as AgentRun).id)
    }
    const projectRuns: string[] = []
    for (let i = 0; i < 55; i++) projectRuns.push((await runAgent(store, agent, `task ${i}`, { projectId: 'proj_a' })).id)
    const other = await runAgent(store, agent, 'other task', { projectId: 'proj_b' })

    const mine = store.runs.filter((r) => r.agentId === agent.id)
    expect(mine.filter((r) => r.projectId === undefined).map((r) => r.id).sort()).toEqual([...chat].sort())
    expect(mine.filter((r) => r.projectId === 'proj_a').map((r) => r.id)).toEqual(projectRuns.slice(5).reverse())
    expect(mine.filter((r) => r.projectId === 'proj_b').map((r) => r.id)).toEqual([other.id])
    expect(agent.runCount).toBe(59)

    // GET lists the chat only, though 51 newer project runs exist.
    expect((await listed(agent.id)).map((r) => r.id)).toEqual([...chat].reverse())

    // The chat's own cap still holds, and leaves the project runs alone.
    for (let i = 3; i < 53; i++) {
      expect((await inject('POST', `/api/agents/${agent.id}/runs`, { input: `chat ${i}` })).statusCode).toBe(200)
    }
    const chatRuns = await listed(agent.id)
    expect(chatRuns).toHaveLength(50)
    expect(chatRuns.map((r) => r.input)).toEqual(Array.from({ length: 50 }, (_, i) => `chat ${52 - i}`))
    expect(store.runs.filter((r) => r.agentId === agent.id && r.projectId === undefined)).toHaveLength(50)
    expect(store.runs.filter((r) => r.agentId === agent.id && r.projectId === 'proj_a')).toHaveLength(50)
    expect(store.runs.filter((r) => r.agentId === agent.id && r.projectId === 'proj_b')).toHaveLength(1)
  })

  it('clears only the chat on DELETE /runs; deleting the agent removes every run', async () => {
    mockEcho()
    await makeAgent('Lead')
    const agent = await makeAgent('Worker')
    expect((await inject('POST', `/api/agents/${agent.id}/runs`, { input: 'chat' })).statusCode).toBe(200)
    const task = await runAgent(store, agent, 'task', { projectId: 'proj_a' })

    const cleared = await inject('DELETE', `/api/agents/${agent.id}/runs`)
    expect(cleared.statusCode).toBe(204)
    expect(await listed(agent.id)).toEqual([])
    expect(store.runs.filter((r) => r.agentId === agent.id).map((r) => r.id)).toEqual([task.id])
    expect(createStore(join(dir, 'store.json')).runs.filter((r) => r.agentId === agent.id).map((r) => r.id)).toEqual([task.id])

    expect((await inject('DELETE', `/api/agents/${agent.id}`)).statusCode).toBe(204)
    expect(store.runs.some((r) => r.agentId === agent.id)).toBe(false)
  })
})

describe('executeRun', () => {
  it('reports a failed save instead of throwing; runAgent (the route) keeps its 500', async () => {
    mockEcho()
    const agent = await makeAgent('Disk')
    const save = store.save
    store.save = () => false
    let runId = ''
    try {
      const outcome = await executeRun(store, agent, 'a task', { projectId: 'proj_a' })
      expect(outcome.persisted).toBe(false)
      expect(outcome.run).toMatchObject({ status: 'succeeded', output: 'out:a task', projectId: 'proj_a' })
      runId = outcome.run.id
      // The run stays in the store for the caller's next save.
      expect(store.runs[0]?.id).toBe(runId)
      await expect(runAgent(store, agent, 'a chat')).rejects.toMatchObject({ statusCode: 500 })
    } finally {
      store.save = save
    }
    expect(store.save()).toBe(true)
    expect(createStore(join(dir, 'store.json')).runs.some((r) => r.id === runId)).toBe(true)

    // A failed run with a failed save is reported, not thrown, by both.
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, text: async () => 'down', json: async () => ({}) })))
    store.save = () => false
    try {
      expect(await executeRun(store, agent, 'again', { projectId: 'proj_a' })).toMatchObject({
        persisted: false,
        run: { status: 'failed' },
      })
      expect((await runAgent(store, agent, 'again')).status).toBe('failed')
    } finally {
      store.save = save
    }
  })
})
