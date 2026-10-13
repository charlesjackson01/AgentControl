import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from './app.js'
import { runAgent } from './runs.js'
import type { Agent, AgentRun } from './shared/types.js'
import { createStore, type WorkspaceStore } from './store.js'

/**
 * runAgent history scoping (hermetic: stubbed fetch, temp store). Project
 * task runs see only earlier runs of the same project; the agent's own chat
 * never sees project runs.
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
