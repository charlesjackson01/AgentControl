import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from './app.js'
import { planPrompt, RESPONSE_RESERVE, summaryBlock } from './prompt.js'
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

describe('planPrompt keeps prompts that fit', () => {
  it('sends a small skill in full when the prompt fits the hard limit, even without headroom', () => {
    // Review repro: long instructions + one small skill. Master accepted this run.
    const skill: Skill = { id: 'house-style', name: 'house-style', description: 'd'.repeat(250), tag: '', content: 'c'.repeat(599), tools: [], sourceId: 'custom', hasScripts: false, files: [], defaultOn: false }
    const instructions = 'i'.repeat(4076 * 4 - 700)
    const plan = planPrompt({ instructions, skills: [skill], input: '', contextWindow: 8192 })
    expect(plan.estimatedTokens + RESPONSE_RESERVE).toBeLessThanOrEqual(8192)
    expect(plan.mode).toBe('full')
    expect(plan.summarizedSkillIds).toEqual([])
    expect(plan.toolDeclarations).toEqual([])
  })

  it('never sends a summary plan that is not smaller than the full one', () => {
    // The summary saves less than the get_skill schema costs.
    const skill: Skill = { id: 'tiny', name: 'tiny', description: 'd'.repeat(250), tag: '', content: 'c'.repeat(500), tools: [], sourceId: 'custom', hasScripts: false, files: [], defaultOn: false }
    expect(summaryBlock(skill).length).toBeLessThan(`## tiny\n${skill.content}`.length)
    const instructions = 'i'.repeat(20_000)
    const plan = planPrompt({ instructions, skills: [skill], input: '', contextWindow: 8192 })
    expect(plan.mode).toBe('too-large')
    expect(plan.summarizedSkillIds).toEqual([])
    expect(plan.system).toBe(`${instructions}\n\nSkills:\n\n## tiny\n${skill.content}`)
    expect(plan.toolDeclarations).toEqual([])
  })

  it('keeps a single seed skill with its tools in full on the seeded 8192 endpoint', () => {
    const debugging = store.skills.find((s) => s.id === 'core/debugging') as Skill
    const plan = planPrompt({ instructions: 'You help debug failing services. Be concrete.', skills: [debugging], input: 'Why does it crash?', contextWindow: 8192 })
    expect(plan.mode).toBe('full')
    expect(plan.system).toContain(debugging.content)
  })
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

describe('a planner-offered get_skill reads only the agent\'s own skills', () => {
  it('refuses a skill the agent does not have, and reads its own', async () => {
    const endpointId = await createEndpoint(6000)
    addSkill('big-one', 9000)
    addSkill('big-two', 8000)
    const agent = await createAgent({ skillIds: ['big-one', 'big-two'] }, endpointId)
    const mock = mockChatSequence([
      toolCalls(['get_skill', { skill: 'core/code-review' }], ['get_skill', { skill: 'big-two' }]),
      answer('ok'),
    ])
    const res = await inject('POST', `/api/agents/${agent.id}/runs`, { input: 'go' })
    const run = res.json() as AgentRun
    expect(run.status).toBe('succeeded')
    expect(run.skillSnapshot?.some((s) => s.mode === 'summary')).toBe(true)
    const [other, own] = expectNoCutJson(lastRequest(mock))
    expect(run.toolCalls?.map((c) => c.ok)).toEqual([false, true])
    expect(other?.content).toContain('No skill "core/code-review"')
    expect(other?.content).not.toContain('Code Review')
    expect(JSON.parse(own?.content ?? '{}')).toMatchObject({ id: 'big-two' })
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
