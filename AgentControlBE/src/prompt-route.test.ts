import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from './app.js'
import { RESPONSE_RESERVE, SKILL_HEADROOM, summaryBlock } from './prompt.js'
import type { Agent, AgentRun, Endpoint, PromptBudget, Skill } from './shared/types.js'
import { createStore, type WorkspaceStore } from './store.js'
import { toolDeclaration } from './tools.js'

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

/** The pre-planPrompt system prompt: instructions + every skill in full. */
const fullSystem = (skills: Skill[]): string =>
  [LEAD_INSTRUCTIONS, `Skills:\n\n${skills.map((s) => `## ${s.name}\n${s.content}`).join('\n\n')}`].join('\n\n')

/** Tools the attached skills declare, deduped in order (what a full-mode run offers). */
const declaredTools = (skills: Skill[]): string[] => [
  ...new Set(skills.flatMap((s) => s.tools.map((t) => t.name)).filter((name) => toolDeclaration(name))),
]

/** What a summary-mode run offers: the declared tools, then get_skill unless one declares it. */
const summaryTools = (skills: Skill[]): string[] => {
  const declared = declaredTools(skills)
  return declared.includes('get_skill') ? declared : [...declared, 'get_skill']
}

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
  it('runs instead of 413ing: summaries in the prompt, get_skill offered, snapshot marks them', async () => {
    expect(store.endpoints.find((e) => e.id === 'ep_local_llama')?.contextWindow).toBe(8192)
    // Premise: the old all-full prompt plus the reply reserve overflowed 8192 tokens.
    expect(Math.ceil(fullSystem(leadSkills()).length / 4) + RESPONSE_RESERVE).toBeGreaterThan(8192)

    const mock = mockChatSequence([contentResponse('Hello, I am the Team Lead.')])
    const agent = await createTeamLead()
    const res = await inject('POST', `/api/agents/${agent.id}/runs`, { input: 'hi' })
    expect(res.statusCode).toBe(200)
    const run = res.json() as AgentRun
    expect(run.status).toBe('succeeded')
    expect(run.output).toBe('Hello, I am the Team Lead.')
    expect(mock).toHaveBeenCalledTimes(1)

    const req = requestAt(mock, 0)
    const system = req.messages?.[0]?.content ?? ''
    expect(req.messages?.[0]?.role).toBe('system')
    expect(system).toBe(run.systemPrompt)
    expect(system.startsWith(`${LEAD_INSTRUCTIONS}\n\nSkills:\n\n`)).toBe(true)

    const summarized = (run.skillSnapshot ?? []).filter((s) => s.mode === 'summary').map((s) => s.id)
    const largest = [...leadSkills()].sort((a, b) => b.content.length - a.content.length)[0] as Skill
    expect(summarized).toContain(largest.id)
    for (const s of leadSkills()) {
      if (summarized.includes(s.id)) {
        expect(system).toContain(summaryBlock(s))
        expect(system).not.toContain(s.content)
      } else {
        expect(system).toContain(`## ${s.name}\n${s.content}`)
      }
    }
    expect(run.skillSnapshot).toEqual(
      leadSkills().map((s) => ({
        id: s.id,
        name: s.name,
        contentChars: s.content.length,
        mode: summarized.includes(s.id) ? 'summary' : 'full',
      })),
    )

    // get_skill joins the skills' own tools (last), with the registry schema.
    const offered = (req.tools ?? []).map((t) => t.function.name)
    expect(offered).toEqual(summaryTools(leadSkills()))
    expect(req.tools?.find((t) => t.function.name === 'get_skill')?.function).toEqual(toolDeclaration('get_skill'))

    // The estimate left room for the reply and the headroom.
    const schemas = JSON.stringify(offered.map((name) => toolDeclaration(name))).length
    const estimated = Math.ceil((system.length + 'hi'.length + schemas) / 4)
    expect(estimated + RESPONSE_RESERVE + SKILL_HEADROOM).toBeLessThanOrEqual(8192)
    expect(req.max_tokens).toBe(RESPONSE_RESERVE)
  })

  it('answers a get_skill call with the first page of the summarized skill', async () => {
    const agent = await createTeamLead()
    // Which skills a run summarizes: ask the budget route (same planner).
    const budget = (await inject('POST', '/api/prompt-budget', {
      endpointId: 'ep_local_llama',
      skillIds: LEAD_SKILL_IDS,
      instructions: LEAD_INSTRUCTIONS,
    })).json() as PromptBudget
    const target = store.skills.find((s) => s.id === budget.summarizedSkillIds[0]) as Skill
    expect(target).toBeDefined()

    const mock = mockChatSequence([
      toolCallResponse('get_skill', JSON.stringify({ skill: target.id })),
      contentResponse('Read the procedure; here is the plan.'),
    ])
    const res = await inject('POST', `/api/agents/${agent.id}/runs`, { input: 'Research our options.' })
    expect(res.statusCode).toBe(200)
    const run = res.json() as AgentRun
    expect(run.status).toBe('succeeded')
    expect(run.output).toBe('Read the procedure; here is the plan.')
    expect(mock).toHaveBeenCalledTimes(2)
    expect(run.toolCalls).toEqual([
      { name: 'get_skill', arguments: JSON.stringify({ skill: target.id }), resultChars: expect.any(Number), ok: true },
    ])

    const second = requestAt(mock, 1)
    const toolMsg = second.messages?.find((m) => m.role === 'tool')
    expect(toolMsg?.tool_call_id).toBe('call_1')
    const page = JSON.parse(toolMsg?.content ?? '{}') as {
      id: string
      totalChars: number
      offset: number
      content: string
      nextOffset: number | null
    }
    expect(page.id).toBe(target.id)
    expect(page.offset).toBe(0)
    expect(page.totalChars).toBe(target.content.length)
    expect(page.content.length).toBeGreaterThan(1000)
    expect(target.content.startsWith(page.content)).toBe(true)
    expect(page.nextOffset).toBe(page.content.length < target.content.length ? page.content.length : null)
    // The tool-enabled follow-up call still offers get_skill.
    expect(second.tools?.map((t) => t.function.name)).toContain('get_skill')
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

  it('runs in summary mode when the hard limit fits and only the headroom is short', async () => {
    const budgetOn = async (endpointId: string) =>
      (await inject('POST', '/api/prompt-budget', {
        endpointId, skillIds: LEAD_SKILL_IDS, instructions: LEAD_INSTRUCTIONS,
      })).json() as PromptBudget
    // A window between the all-summarized prompt + reserve and + reserve + headroom.
    const probe = await budgetOn(await createEndpoint(2000))
    expect(probe.mode).toBe('too-large')
    const window = probe.estimatedTokens + RESPONSE_RESERVE + 10
    const endpointId = await createEndpoint(window)
    expect((await budgetOn(endpointId)).mode).toBe('summary')

    const mock = mockChatSequence([contentResponse('tight but fine')])
    const agent = await createTeamLead(endpointId)
    const res = await inject('POST', `/api/agents/${agent.id}/runs`, { input: 'hi' })
    expect(res.statusCode).toBe(200)
    const run = res.json() as AgentRun
    expect(run.status).toBe('succeeded')
    expect(run.skillSnapshot?.map((s) => s.mode)).toEqual(['summary', 'summary', 'summary'])
    expect(requestAt(mock, 0).tools?.map((t) => t.function.name)).toContain('get_skill')
  })
})

describe('agents whose skills fit', () => {
  it('runs unchanged: every skill in full, no get_skill', async () => {
    const endpointId = await createEndpoint(32_768)
    const agent = await createTeamLead(endpointId)
    const mock = mockChatSequence([contentResponse('ok')])
    const res = await inject('POST', `/api/agents/${agent.id}/runs`, { input: 'hi' })
    expect(res.statusCode).toBe(200)
    const run = res.json() as AgentRun

    const req = requestAt(mock, 0)
    expect(req.messages?.[0]?.content).toBe(fullSystem(leadSkills()))
    expect(run.systemPrompt).toBe(fullSystem(leadSkills()))
    expect(req.tools?.map((t) => t.function.name)).toEqual(declaredTools(leadSkills()))
    if (!declaredTools(leadSkills()).includes('get_skill')) {
      expect(req.tools?.map((t) => t.function.name)).not.toContain('get_skill')
    }
    expect(run.skillSnapshot?.every((s) => s.mode === 'full')).toBe(true)
  })
})

describe('POST /api/prompt-budget', () => {
  it('returns the mode, summaries and tools a run on that endpoint would use', async () => {
    const res = await inject('POST', '/api/prompt-budget', {
      endpointId: 'ep_local_llama',
      skillIds: LEAD_SKILL_IDS,
      instructions: LEAD_INSTRUCTIONS,
    })
    expect(res.statusCode).toBe(200)
    const budget = res.json() as PromptBudget
    expect(Object.keys(budget).sort()).toEqual(
      ['contextWindow', 'estimatedTokens', 'mode', 'responseReserve', 'rulesTokens', 'summarizedSkillIds', 'toolNames'],
    )
    expect(budget).toMatchObject({ contextWindow: 8192, responseReserve: RESPONSE_RESERVE, mode: 'summary' })
    expect(budget.estimatedTokens + RESPONSE_RESERVE + SKILL_HEADROOM).toBeLessThanOrEqual(8192)

    // The run makes the same choice.
    const mock = mockChatSequence([contentResponse('ok')])
    const agent = await createTeamLead()
    const run = (await inject('POST', `/api/agents/${agent.id}/runs`, { input: 'hi' })).json() as AgentRun
    expect(run.skillSnapshot?.filter((s) => s.mode === 'summary').map((s) => s.id)).toEqual(budget.summarizedSkillIds)
    expect(requestAt(mock, 0).tools?.map((t) => t.function.name)).toEqual(budget.toolNames)
    // The budget estimate is the run's system prompt + tool schemas (input '').
    const schemas = JSON.stringify(budget.toolNames.map((name) => toolDeclaration(name))).length
    expect(budget.estimatedTokens).toBe(Math.ceil(((run.systemPrompt ?? '').length + schemas) / 4))
  })

  it('reports full mode with no summaries on a large window', async () => {
    const endpointId = await createEndpoint(32_768)
    const budget = (await inject('POST', '/api/prompt-budget', {
      endpointId, skillIds: LEAD_SKILL_IDS, instructions: LEAD_INSTRUCTIONS,
    })).json() as PromptBudget
    expect(budget.mode).toBe('full')
    expect(budget.summarizedSkillIds).toEqual([])
    expect(budget.toolNames).toEqual(declaredTools(leadSkills()))
    const schemas = JSON.stringify(budget.toolNames.map((name) => toolDeclaration(name))).length
    expect(budget.estimatedTokens).toBe(Math.ceil((fullSystem(leadSkills()).length + schemas) / 4))
  })

  it('reports too-large with every skill summarized on a tiny window', async () => {
    const endpointId = await createEndpoint(2000)
    const budget = (await inject('POST', '/api/prompt-budget', {
      endpointId, skillIds: LEAD_SKILL_IDS, instructions: LEAD_INSTRUCTIONS,
    })).json() as PromptBudget
    expect(budget).toMatchObject({ contextWindow: 2000, mode: 'too-large', summarizedSkillIds: LEAD_SKILL_IDS })
    expect(budget.toolNames).toEqual(summaryTools(leadSkills()))
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
      mode: 'full',
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
