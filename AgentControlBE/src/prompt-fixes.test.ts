import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from './app.js'
import type { Agent, AgentRun, Endpoint, Skill } from './shared/types.js'
import { createStore, type WorkspaceStore } from './store.js'
import { builtinTools, executeToolCall, toolDeclaration, type ToolContext } from './tools.js'
import { RESULT_MAX_CHARS } from './tools/limits.js'

/**
 * Review follow-ups for the prompt planner: a prompt that fits is never
 * summarized, summaries never make it bigger, paged reads fit the room the run
 * has left (never cut mid-JSON), and a planner-offered get_skill reads only
 * the agent's own skills.
 */

let dir = ''
let app: FastifyInstance
let store: WorkspaceStore

const LEAD_INSTRUCTIONS =
  'You are the Team Lead. Coordinate the other agents, review their work, and keep projects moving.'
const LEAD_SKILL_IDS = ['core/deep-research', 'core/summarization', 'core/multi-agent-orchestration']

async function inject(method: 'GET' | 'POST', url: string, payload?: unknown) {
  return app.inject({ method, url, payload: payload as object | undefined, headers: { 'content-type': 'application/json' } })
}

type ChatRequest = { messages?: { role: string; content: string; tool_call_id?: string }[] }

function mockChatSequence(responses: unknown[]) {
  const mock = vi.fn(async (_url: string, _init?: { body?: string }) => ({
    ok: true,
    status: 200,
    json: async () => responses.shift() ?? { choices: [{ index: 0, message: { role: 'assistant', content: 'done' } }] },
  }))
  vi.stubGlobal('fetch', mock)
  return mock
}

const lastRequest = (mock: ReturnType<typeof mockChatSequence>): ChatRequest =>
  JSON.parse(mock.mock.calls.at(-1)?.[1]?.body ?? '{}') as ChatRequest

function toolCalls(...calls: [name: string, args: object][]) {
  return {
    choices: [{
      index: 0,
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        content: '',
        tool_calls: calls.map(([name, args], i) => ({ id: `call_${i}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })),
      },
    }],
  }
}

const answer = (content: string) => ({ choices: [{ index: 0, message: { role: 'assistant', content } }] })

async function createAgent(body: Partial<Agent> & { skillIds: string[] }, endpointId = 'ep_local_llama'): Promise<Agent> {
  const res = await inject('POST', '/api/agents', {
    name: body.name ?? 'Agent', role: '', description: '', instructions: body.instructions ?? '',
    modelId: 'llama-3-8b', endpointId, temperature: 0.2, skillIds: body.skillIds, isPrimary: body.isPrimary ?? false,
  })
  expect(res.statusCode).toBe(201)
  return res.json() as Agent
}

async function createEndpoint(contextWindow: number): Promise<string> {
  const res = await inject('POST', '/api/endpoints', {
    kind: 'openai-compatible', name: `Window ${contextWindow}`, baseUrl: 'http://127.0.0.1:9', defaultModel: 'llama-3-8b', contextWindow,
  })
  expect(res.statusCode).toBe(201)
  return (res.json() as Endpoint).id
}

function addSkill(id: string, contentChars: number, extra: Partial<Skill> = {}): Skill {
  const skill: Skill = { id, name: id, description: `The ${id} procedure.`, tag: '', content: `# ${id}\n${'Step. '.repeat(contentChars)}`.slice(0, contentChars), tools: [], sourceId: 'custom', hasScripts: false, files: [], defaultOn: false, ...extra }
  store.skills.push(skill)
  return skill
}

/** Every tool message the model saw in its last request: valid JSON, or a short plain error. */
function expectNoCutJson(req: ChatRequest) {
  const tools = (req.messages ?? []).filter((m) => m.role === 'tool')
  expect(tools.length).toBeGreaterThan(0)
  for (const m of tools) {
    expect(m.content.endsWith('…[truncated]'), m.content.slice(-80)).toBe(false)
    if (m.content.startsWith('{')) expect(() => JSON.parse(m.content)).not.toThrow()
  }
  return tools
}

beforeEach(() => {
  process.env.AGENTCONTROL_SECRET = 'test-secret'
  dir = mkdtempSync(join(tmpdir(), 'agentcontrol-prompt-fixes-'))
  store = createStore(join(dir, 'store.json'))
  app = buildApp(store)
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await app.close()
  rmSync(dir, { recursive: true, force: true })
  delete process.env.AGENTCONTROL_SECRET
})

describe('paged reads fit the room the run has left', () => {
  const ctxFor = (resultMaxChars?: number): ToolContext => ({
    store, agentId: 'nobody', runId: 'r', input: '', allowed: new Set(builtinTools.keys()),
    now: () => new Date('2026-10-12T00:00:00Z'), timeZone: 'UTC', writes: { count: 0 },
    ...(resultMaxChars !== undefined ? { resultMaxChars } : {}),
  })
  const call = (name: string, args: object, ctx: ToolContext) => executeToolCall({ id: 'c', name, arguments: JSON.stringify(args) }, ctx)

  it('get_skill shrinks its page to resultMaxChars and still chains nextOffset exactly', async () => {
    const skill = store.skills.find((s) => s.id === 'core/deep-research') as Skill
    let offset: number | null = 0
    let text = ''
    for (let i = 0; offset !== null && i < 50; i++) {
      const out = await call('get_skill', { skill: skill.id, offset }, ctxFor(1200))
      expect(out.ok).toBe(true)
      expect(out.content.length).toBeLessThanOrEqual(1200)
      const page = JSON.parse(out.content) as { content: string; offset: number; nextOffset: number | null }
      expect(page.offset).toBe(offset)
      text += page.content
      offset = page.nextOffset
    }
    expect(text).toBe(skill.content)
  })

  it('read_note shrinks its page the same way', async () => {
    store.notes.push({ id: 'n1', title: 'Long', body: 'x'.repeat(9000), tags: [], authorAgentId: 'a', createdAt: '', updatedAt: '' } as never)
    const out = await call('read_note', { note: 'Long' }, ctxFor(900))
    expect(out.ok).toBe(true)
    expect(out.content.length).toBeLessThanOrEqual(900)
    expect((JSON.parse(out.content) as { nextOffset: number }).nextOffset).toBeGreaterThan(0)
  })

  it('says the run is out of room instead of returning a sliver', async () => {
    const out = await call('get_skill', { skill: 'core/deep-research' }, ctxFor(400))
    expect(out.ok).toBe(false)
    expect(out.content).toContain('Not enough room left')
    // Unset means the normal cap.
    const full = await call('get_skill', { skill: 'core/deep-research' }, ctxFor())
    expect(full.ok).toBe(true)
    expect(full.content.length).toBeLessThanOrEqual(RESULT_MAX_CHARS)
  })

  it('a fresh Team Lead reads two summarized skills and pages on without any JSON cut mid-way', async () => {
    const agent = await createAgent({ name: 'Team Lead', instructions: LEAD_INSTRUCTIONS, skillIds: LEAD_SKILL_IDS, isPrimary: true })
    const mock = mockChatSequence([
      toolCalls(['get_skill', { skill: 'core/deep-research' }]),
      toolCalls(['get_skill', { skill: 'core/summarization' }]),
      toolCalls(['get_skill', { skill: 'core/deep-research', offset: 2000 }]),
      answer('Plan ready.'),
    ])
    const res = await inject('POST', `/api/agents/${agent.id}/runs`, { input: 'Plan the research.' })
    expect(res.statusCode).toBe(200)
    const run = res.json() as AgentRun
    expect(run.status).toBe('succeeded')
    const tools = expectNoCutJson(lastRequest(mock))
    expect(tools).toHaveLength(3)
    // Reads that fit come back as valid pages; once the room is gone the tool says so (ok: false).
    for (const [i, audit] of (run.toolCalls ?? []).entries()) {
      const content = tools[i]?.content ?? ''
      expect(audit.ok).toBe(content.startsWith('{'))
    }
    expect(run.toolCalls?.[0]?.ok).toBe(true)
  })
})

describe('activate_skill reads only the agent\'s own skills', () => {
  it('refuses a skill the agent does not have, reads its own, and records only that one', async () => {
    const endpointId = await createEndpoint(6000)
    addSkill('big-one', 9000)
    addSkill('big-two', 8000)
    const agent = await createAgent({ skillIds: ['big-one', 'big-two'] }, endpointId)
    const mock = mockChatSequence([
      toolCalls(['activate_skill', { id: 'core/code-review' }], ['activate_skill', { id: 'big-two' }]),
      answer('ok'),
    ])
    const res = await inject('POST', `/api/agents/${agent.id}/runs`, { input: 'go' })
    const run = res.json() as AgentRun
    expect(run.status).toBe('succeeded')
    expect(run.skillSnapshot?.every((s) => s.mode === 'catalog')).toBe(true)
    const [other, own] = expectNoCutJson(lastRequest(mock))
    expect(run.toolCalls?.map((c) => c.ok)).toEqual([false, true])
    expect(other?.content).toContain('No skill "core/code-review"')
    expect(own?.content).toMatch(/^Skill big-two \(big-two\)\. chars 1-\d+ of 8000\. Next: activate_skill \{"id":"big-two","offset":\d+\}/)
    expect(run.activatedSkills).toEqual([{ id: 'big-two', name: 'big-two', source: 'custom' }])
  })

  it('stays unscoped when an attached skill declares get_skill itself', async () => {
    const endpointId = await createEndpoint(6000)
    const decl = toolDeclaration('get_skill')
    if (!decl) throw new Error('get_skill missing')
    addSkill('big-one', 9000, { tools: [decl] })
    addSkill('big-two', 8000)
    const agent = await createAgent({ skillIds: ['big-one', 'big-two'] }, endpointId)
    const mock = mockChatSequence([toolCalls(['get_skill', { skill: 'core/code-review' }]), answer('ok')])
    const run = (await inject('POST', `/api/agents/${agent.id}/runs`, { input: 'go' })).json() as AgentRun
    expect(run.toolCalls?.[0]?.ok).toBe(true)
    expect(JSON.parse(expectNoCutJson(lastRequest(mock))[0]?.content ?? '{}')).toMatchObject({ id: 'core/code-review' })
  })
})

describe('stored skillSnapshot modes across BE-7', () => {
  it('reloads runs recorded as full, summary or catalog unchanged, with activatedSkills', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentcontrol-old-runs-'))
    try {
      const path = join(dir, 'store.json')
      const first = createStore(path)
      const base = { agentId: 'agt_old', startedAt: '2026-10-01T00:00:00.000Z', status: 'succeeded' as const, durationMs: 1, steps: 1, input: 'i', output: 'o', error: null }
      first.runs.push(
        { ...base, id: 'run_old_full', skillSnapshot: [{ id: 'core/code-review', name: 'Code Review', contentChars: 900, mode: 'full' }] },
        { ...base, id: 'run_old_summary', skillSnapshot: [{ id: 'core/code-review', name: 'Code Review', contentChars: 900, mode: 'summary' }] },
        { ...base, id: 'run_old_nomode', skillSnapshot: [{ id: 'core/code-review', name: 'Code Review', contentChars: 900 }] },
        { ...base, id: 'run_new', skillSnapshot: [{ id: 'core/code-review', name: 'Code Review', contentChars: 900, mode: 'catalog' }], activatedSkills: [{ id: 'core/code-review', name: 'Code Review', source: 'core' }] },
      )
      expect(first.save()).toBe(true)
      const runs = new Map(createStore(path).runs.map((r) => [r.id, r]))
      expect(runs.get('run_old_full')?.skillSnapshot?.[0]?.mode).toBe('full')
      expect(runs.get('run_old_summary')?.skillSnapshot?.[0]?.mode).toBe('summary')
      expect(runs.get('run_old_nomode')?.skillSnapshot?.[0]).not.toHaveProperty('mode')
      expect(runs.get('run_new')?.skillSnapshot?.[0]?.mode).toBe('catalog')
      expect(runs.get('run_new')?.activatedSkills).toEqual([{ id: 'core/code-review', name: 'Code Review', source: 'core' }])
      expect(runs.get('run_old_full')).not.toHaveProperty('activatedSkills')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
