import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from './app.js'
import { RESPONSE_RESERVE, skillCatalog } from './prompt.js'
import type { Agent, AgentRun, Endpoint, PromptBudget, Skill } from './shared/types.js'
import { createStore, type WorkspaceStore } from './store.js'
import { toolDeclaration } from './tools.js'
import { SKILL_PAGE_CHARS } from './tools/skills.js'

/**
 * Skills on small context windows, end to end through fastify.inject() with a
 * stubbed fetch (no sockets, no network): the fresh-install Team Lead used to
 * 413 on the seeded 8192-token endpoint before any upstream call.
 */

let dir = ''
let app: FastifyInstance
let store: WorkspaceStore

// Exactly what onboarding (AgentControlFE AgentForm bootstrap) creates.
const LEAD_INSTRUCTIONS =
  'You are the Team Lead. Coordinate the other agents, review their work, and keep projects moving.'
const LEAD_SKILL_IDS = ['core/deep-research', 'core/summarization', 'core/multi-agent-orchestration']

async function inject(method: 'GET' | 'POST', url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    payload: payload as object | undefined,
    headers: { 'content-type': 'application/json' },
  })
}

type ChatRequest = {
  messages?: { role: string; content: string; tool_call_id?: string }[]
  max_tokens?: number
  tools?: { type: string; function: { name: string; description: string; parameters: object } }[]
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

function requestAt(mock: ReturnType<typeof mockChatSequence>, index: number): ChatRequest {
  return JSON.parse(mock.mock.calls[index]?.[1]?.body ?? '{}') as ChatRequest
}

function toolCallResponse(name: string, args: string, id = 'call_1') {
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

async function createTeamLead(endpointId = 'ep_local_llama'): Promise<Agent> {
  const res = await inject('POST', '/api/agents', {
    name: 'Team Lead',
    role: 'Team Lead',
    description: '',
    instructions: LEAD_INSTRUCTIONS,
    modelId: 'llama-3-8b',
    endpointId,
    temperature: 0.7,
    skillIds: LEAD_SKILL_IDS,
    isPrimary: true,
  })
  expect(res.statusCode).toBe(201)
  return res.json() as Agent
}

async function createEndpoint(contextWindow: number): Promise<string> {
  const res = await inject('POST', '/api/endpoints', {
    kind: 'openai-compatible',
    name: `Window ${contextWindow}`,
    baseUrl: 'http://127.0.0.1:9',
    defaultModel: 'llama-3-8b',
    contextWindow,
  })
  expect(res.statusCode).toBe(201)
  return (res.json() as Endpoint).id
}

const leadSkills = (): Skill[] => LEAD_SKILL_IDS.map((id) => store.skills.find((s) => s.id === id) as Skill)

/** BE-7: what every run sends: instructions, then the catalog of the attached skills. */
const catalogSystem = (skills: Skill[]): string => `${LEAD_INSTRUCTIONS}\n\n${skillCatalog(skills)}`

/** Tools the attached skills declare, deduped in order, then activate_skill. */
const offeredTools = (skills: Skill[]): string[] => [
  ...new Set([...skills.flatMap((s) => s.tools.map((t) => t.name)).filter((name) => toolDeclaration(name)), 'activate_skill']),
]

beforeEach(() => {
  process.env.AGENTCONTROL_SECRET = 'test-secret'
  dir = mkdtempSync(join(tmpdir(), 'agentcontrol-prompt-test-'))
  store = createStore(join(dir, 'store.json'))
  app = buildApp(store)
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await app.close()
  rmSync(dir, { recursive: true, force: true })
  delete process.env.AGENTCONTROL_SECRET
})

describe('fresh-install Team Lead on the seeded 8192-token endpoint', () => {
  it('runs with the skill catalog only: no bodies, activate_skill offered, snapshot marks catalog', async () => {
    const mock = mockChatSequence([contentResponse('Hello, I am the Team Lead.')])
    const agent = await createTeamLead()
    const res = await inject('POST', `/api/agents/${agent.id}/runs`, { input: 'hi' })
    expect(res.statusCode).toBe(200)
    const run = res.json() as AgentRun
    expect(run.status).toBe('succeeded')

    const req = requestAt(mock, 0)
    const system = req.messages?.[0]?.content ?? ''
    expect(system).toBe(run.systemPrompt)
    expect(system).toBe(catalogSystem(leadSkills()))
    for (const s of leadSkills()) expect(system).not.toContain(s.content.slice(0, 200))
    expect(run.skillSnapshot).toEqual(
      leadSkills().map((s) => ({ id: s.id, name: s.name, contentChars: s.content.length, mode: 'catalog' })),
    )
    expect((req.tools ?? []).map((t) => t.function.name)).toEqual(offeredTools(leadSkills()))
    expect(req.tools?.find((t) => t.function.name === 'activate_skill')?.function).toEqual(toolDeclaration('activate_skill'))
    expect(req.max_tokens).toBe(RESPONSE_RESERVE)
  })

  it('answers activate_skill with the first page and records the skill in the run and the DM activity', async () => {
    const agent = await createTeamLead()
    const target = store.skills.find((s) => s.id === 'core/deep-research') as Skill
    const mock = mockChatSequence([
      toolCallResponse('activate_skill', JSON.stringify({ id: target.id })),
      toolCallResponse('activate_skill', JSON.stringify({ id: target.id })),
      contentResponse('Read the procedure; here is the plan.'),
    ])
    const res = await inject('POST', `/api/agents/${agent.id}/runs`, { input: 'Research our options.' })
    const run = res.json() as AgentRun
    expect(run.status).toBe('succeeded')
    expect(mock).toHaveBeenCalledTimes(3)
    expect(run.toolCalls?.map((c) => [c.name, c.ok])).toEqual([['activate_skill', true], ['activate_skill', true]])
    const toolMsg = requestAt(mock, 1).messages?.find((m) => m.role === 'tool')
    const content = toolMsg?.content ?? ''
    const cut = content.indexOf('\n---\n')
    const head = content.slice(0, cut)
    const body = content.slice(cut + 5)
    // On the 8192 window the page shrinks to the room left, and says exactly where to continue.
    expect(head).toMatch(new RegExp(`^Skill ${target.id} \\(${target.name}\\)\\. chars 1-(\\d+) of ${target.content.length}\\. Next: activate_skill`))
    const end = Number(/chars 1-(\d+)/.exec(head ?? '')?.[1])
    expect(end).toBeLessThanOrEqual(SKILL_PAGE_CHARS)
    expect(head).toContain(JSON.stringify({ id: target.id, offset: end }))
    expect(body).toBe(target.content.slice(0, end))
    expect(toolMsg?.content.endsWith('…[truncated]')).toBe(false)
    // Activated twice, recorded once.
    expect(run.activatedSkills).toEqual([{ id: target.id, name: target.name, source: 'core' }])
    const dm = store.conversations.find((c) => c.kind === 'dm' && c.agentId === agent.id)
    const reply = store.chatMessages.find((m) => m.conversationId === dm?.id && m.runId === run.id && m.role === 'assistant')
    expect(reply?.activity).toEqual({ skills: [{ id: target.id, name: target.name, source: 'core' }], steps: [], filesChanged: [] })
  })

  it('a reply that loaded no skill has no activity', async () => {
    mockChatSequence([contentResponse('ok')])
    const agent = await createTeamLead()
    const run = (await inject('POST', `/api/agents/${agent.id}/runs`, { input: 'hi' })).json() as AgentRun
    expect(run.activatedSkills).toBeUndefined()
    expect(store.chatMessages.find((m) => m.runId === run.id && m.role === 'assistant')).not.toHaveProperty('activity')
  })

  it('413s with the estimate, the reply reserve and the window when even summaries do not fit', async () => {
    const mock = mockChatSequence([contentResponse('never sent')])
    const endpointId = await createEndpoint(2000)
    const agent = await createTeamLead(endpointId)
    const res = await inject('POST', `/api/agents/${agent.id}/runs`, { input: 'hi' })
    expect(res.statusCode).toBe(413)
    const { message } = res.json() as { message: string }
    expect(message).toMatch(
      /^Prompt too large for this endpoint's context window: about \d+ tokens of prompt plus 4096 reserved for the reply exceed the 2000-token window\. /,
    )
    expect(message).toContain('Detach skills')
    expect(message).toContain("raise the endpoint's context window in Settings")
    expect(mock).not.toHaveBeenCalled()
    expect(store.runs).toEqual([])
  })

})

describe('POST /api/prompt-budget', () => {
  it('returns the mode, catalog size and tools a run on that endpoint would use', async () => {
    const res = await inject('POST', '/api/prompt-budget', {
      endpointId: 'ep_local_llama',
      skillIds: LEAD_SKILL_IDS,
      instructions: LEAD_INSTRUCTIONS,
    })
    expect(res.statusCode).toBe(200)
    const budget = res.json() as PromptBudget
    expect(Object.keys(budget).sort()).toEqual(
      ['catalogTokens', 'contextWindow', 'estimatedTokens', 'mode', 'responseReserve', 'rulesTokens', 'summarizedSkillIds', 'toolNames'],
    )
    expect(budget).toMatchObject({ contextWindow: 8192, responseReserve: RESPONSE_RESERVE, mode: 'catalog', summarizedSkillIds: [] })
    expect(budget.catalogTokens).toBe(Math.ceil(skillCatalog(leadSkills()).length / 4))

    // The run makes the same choice.
    const mock = mockChatSequence([contentResponse('ok')])
    const agent = await createTeamLead()
    const run = (await inject('POST', `/api/agents/${agent.id}/runs`, { input: 'hi' })).json() as AgentRun
    expect(requestAt(mock, 0).tools?.map((t) => t.function.name)).toEqual(budget.toolNames)
    // The budget estimate is the run's system prompt + tool schemas (input '').
    const schemas = JSON.stringify(budget.toolNames.map((name) => toolDeclaration(name))).length
    expect(budget.estimatedTokens).toBe(Math.ceil(((run.systemPrompt ?? '').length + schemas) / 4))
  })

  it('reports too-large when the catalog is over 25% of the window', async () => {
    const many = Array.from({ length: 30 }, (_, i) => `bulk-${i}`)
    for (const id of many) {
      store.skills.push({ id, name: id, description: 'd'.repeat(300), tag: '', content: 'x', tools: [], sourceId: 'custom', hasScripts: false, files: [], defaultOn: false })
    }
    const budget = (await inject('POST', '/api/prompt-budget', { endpointId: 'ep_local_llama', skillIds: many })).json() as PromptBudget
    expect(budget.catalogTokens).toBeGreaterThan(8192 * 0.25)
    expect(budget.mode).toBe('too-large')
  })

  it('ignores unknown skill ids and trims the instructions, as saving and running do', async () => {
    const plain = (await inject('POST', '/api/prompt-budget', {
      endpointId: 'ep_local_llama', skillIds: LEAD_SKILL_IDS, instructions: LEAD_INSTRUCTIONS,
    })).json() as PromptBudget
    const noisy = await inject('POST', '/api/prompt-budget', {
      endpointId: 'ep_local_llama',
      skillIds: ['gone', ...LEAD_SKILL_IDS, 'also-gone'],
      instructions: `  ${LEAD_INSTRUCTIONS}\n`,
    })
    expect(noisy.statusCode).toBe(200)
    expect(noisy.json()).toEqual(plain)

    const none = (await inject('POST', '/api/prompt-budget', { endpointId: 'ep_local_llama', skillIds: [] })).json()
    expect(none).toEqual({
      contextWindow: 8192,
      responseReserve: RESPONSE_RESERVE,
      rulesTokens: 0,
      estimatedTokens: 0,
      catalogTokens: 0,
      mode: 'catalog',
      summarizedSkillIds: [],
      toolNames: [],
    })
  })

  it('400s for an unknown endpoint or a malformed body', async () => {
    const unknown = await inject('POST', '/api/prompt-budget', { endpointId: 'ep_nope', skillIds: [] })
    expect(unknown.statusCode).toBe(400)
    expect((unknown.json() as { message: string }).message).toContain('No endpoint with id "ep_nope"')

    const bad: unknown[] = [
      undefined,
      [],
      'ep_local_llama',
      { skillIds: [] },
      { endpointId: 42, skillIds: [] },
      { endpointId: 'ep_local_llama', skillIds: 'core/summarization' },
      { endpointId: 'ep_local_llama', skillIds: ['core/summarization', 7] },
      { endpointId: 'ep_local_llama', skillIds: [], instructions: 5 },
      { endpointId: 'ep_local_llama', skillIds: Array.from({ length: 501 }, () => 'core/summarization') },
    ]
    for (const payload of bad) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/prompt-budget',
        headers: { 'content-type': 'application/json' },
        payload: payload === undefined ? '' : JSON.stringify(payload),
      })
      expect(res.statusCode, JSON.stringify(payload)?.slice(0, 80)).toBe(400)
    }
  })

  it('is gated by the bearer token like the other /api routes', async () => {
    process.env.AGENTCONTROL_AUTH_TOKEN = 'tok-123'
    const gated = buildApp(createStore(join(dir, 'store.json')))
    try {
      const payload = JSON.stringify({ endpointId: 'ep_local_llama', skillIds: [] })
      const headers = { 'content-type': 'application/json' }
      expect((await gated.inject({ method: 'POST', url: '/api/prompt-budget', headers, payload })).statusCode).toBe(401)
      const authed = await gated.inject({
        method: 'POST',
        url: '/api/prompt-budget',
        headers: { ...headers, authorization: 'Bearer tok-123' },
        payload,
      })
      expect(authed.statusCode).toBe(200)
    } finally {
      await gated.close()
      delete process.env.AGENTCONTROL_AUTH_TOKEN
    }
  })
})
