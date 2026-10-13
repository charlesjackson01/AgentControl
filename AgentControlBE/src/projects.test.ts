import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from './app.js'
import { buildPlannerRequest, parsePlanJson, whenProjectIdle } from './projects.js'
import type { Agent, Endpoint, Project, ProjectMessage, TeamPlanResponse } from './shared/types.js'
import { createStore, type WorkspaceStore } from './store.js'

/**
 * Project team plans and task runs through fastify.inject() with a stubbed
 * fetch (no sockets, no network). The stub answers Primary's planning call
 * with a scripted plan and every other call (a task run) by agent.
 */

let dir = ''
let app: FastifyInstance
let store: WorkspaceStore

async function inject(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    payload: payload as object | undefined,
    headers: { 'content-type': 'application/json' },
  })
}

type ChatRequest = {
  model?: string
  messages?: { role: string; content: string }[]
  max_tokens?: number
  temperature?: number
  tools?: unknown
}
type Reply = string | Error | { status: number }

const PLANNER_MARK = 'the team lead of this project in AgentControl'
const isPlanner = (req: ChatRequest): boolean => (req.messages?.[0]?.content ?? '').includes(PLANNER_MARK)
const systemOf = (req: ChatRequest): string => (req.messages?.[0]?.role === 'system' ? (req.messages[0]?.content ?? '') : '')
const lastUser = (req: ChatRequest): string => req.messages?.[req.messages.length - 1]?.content ?? ''

/** Stub fetch: `handler` answers each chat call; returns every request seen. */
function mockUpstream(handler: (req: ChatRequest) => Reply | Promise<Reply>): ChatRequest[] {
  const requests: ChatRequest[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: { body?: string }) => {
      const req = JSON.parse(init?.body ?? '{}') as ChatRequest
      requests.push(req)
      const out = await handler(req)
      if (out instanceof Error) throw out
      if (typeof out !== 'string') {
        return { ok: false, status: out.status, text: async () => 'upstream exploded', json: async () => ({}) }
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ index: 0, message: { role: 'assistant', content: out } }] }),
      }
    }),
  )
  return requests
}

/** Planner answers with `plan`; task runs answer "<system>: done" unless `task` says otherwise. */
function mockTeam(plan: unknown, task: (req: ChatRequest) => Reply | Promise<Reply> = (req) => `${systemOf(req)}: done`) {
  return mockUpstream((req) => (isPlanner(req) ? (typeof plan === 'string' ? plan : JSON.stringify(plan)) : task(req)))
}

function gate() {
  let open = (): void => {}
  const wait = new Promise<void>((resolve) => {
    open = resolve
  })
  return { wait, open }
}

async function makeAgent(name: string, extra: Record<string, unknown> = {}): Promise<Agent> {
  const res = await inject('POST', '/api/agents', {
    name,
    description: `${name} does things.`,
    // Each agent's system prompt names it, so the stub can tell runs apart.
    instructions: `I am ${name}.`,
    modelId: 'llama-3-8b',
    endpointId: 'ep_local_llama',
    skillIds: [],
    ...extra,
  })
  expect(res.statusCode).toBe(201)
  return res.json() as Agent
}

/** The Team Lead: a distinct model and temperature so created specialists can be checked. */
const makeLead = (extra: Record<string, unknown> = {}) =>
  makeAgent('Lead', { isPrimary: true, modelId: 'llama-3-70b', temperature: 0.4, ...extra })

async function makeProject(name: string, teamAgentIds: string[] = [], desc = ''): Promise<Project> {
  const res = await inject('POST', '/api/projects', { name, desc, teamAgentIds })
  expect(res.statusCode).toBe(201)
  return res.json() as Project
}

async function say(projectId: string, text: string, author = 'user'): Promise<ProjectMessage> {
  const res = await inject('POST', `/api/projects/${projectId}/messages`, { author, text })
  expect(res.statusCode).toBe(201)
  return res.json() as ProjectMessage
}

async function askPlan(projectId: string, text: string) {
  const prompt = await say(projectId, text)
  const res = await inject('POST', `/api/projects/${projectId}/team-plan`, { messageId: prompt.id })
  return { prompt, res }
}

async function thread(projectId: string): Promise<ProjectMessage[]> {
  const res = await inject('GET', `/api/projects/${projectId}/messages`)
  expect(res.statusCode).toBe(200)
  return res.json() as ProjectMessage[]
}

beforeEach(() => {
  process.env.AGENTCONTROL_SECRET = 'test-secret'
  dir = mkdtempSync(join(tmpdir(), 'agentcontrol-projects-'))
  store = createStore(join(dir, 'store.json'))
  app = buildApp(store)
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await app.close()
  rmSync(dir, { recursive: true, force: true })
  delete process.env.AGENTCONTROL_SECRET
})

describe('parsePlanJson', () => {
  it('reads a fenced json block first, then the outermost object, ignoring prose and <think>', () => {
    expect(parsePlanJson('Sure!\n```json\n{"reply":"a","tasks":[]}\n```\nAnything else?')).toEqual({ reply: 'a', tasks: [] })
    expect(parsePlanJson('```\n{"reply":"plain fence"}\n```')).toEqual({ reply: 'plain fence' })
    expect(parsePlanJson('{"reply":"bare"}')).toEqual({ reply: 'bare' })
    expect(parsePlanJson('Here is the plan: {"reply":"x","add":[{"agentId":"a"}]} Hope it helps.')).toEqual({
      reply: 'x',
      add: [{ agentId: 'a' }],
    })
    expect(parsePlanJson('<think>maybe {"reply":"no"} or not</think>{"reply":"yes"}')).toEqual({ reply: 'yes' })
    // A broken fence falls back to the outermost object, skipping stray braces.
    expect(parsePlanJson('```json\n{broken\n```\n{"reply":"after"}')).toEqual({ reply: 'after' })
    expect(parsePlanJson('Use {name} slots. {"reply":"slots"}')).toEqual({ reply: 'slots' })
    // A plan wrapped in a list is still found.
    expect(parsePlanJson('[{"reply":"in a list"}]')).toEqual({ reply: 'in a list' })
  })

  it('returns null for anything that is not one JSON object', () => {
    expect(parsePlanJson('I cannot help with that.')).toBeNull()
    expect(parsePlanJson('{"reply": "unterminated')).toBeNull()
    expect(parsePlanJson('["reply", "add"]')).toBeNull()
    expect(parsePlanJson('{"reply" "missing colon"}')).toBeNull()
    expect(parsePlanJson('')).toBeNull()
  })
})

describe('POST /api/projects/:id/team-plan', () => {
  it('builds the planning request from the project, rosters, chat and prompt', async () => {
    const lead = await makeLead({ instructions: `Lead well. ${'L'.repeat(3_000)}` })
    const ana = await makeAgent('Ana', { role: 'Writer', skillIds: ['summarization'] })
    const ben = await makeAgent('Ben', { role: 'Reviewer' })
    const p = await makeProject('Blog', [ana.id], 'Our engineering blog.')
    for (let i = 0; i < 14; i++) await say(p.id, `note ${i}`, i % 2 === 0 ? 'user' : ana.id)
    const requests = mockTeam({ reply: 'Nothing to do.' })

    const { res } = await askPlan(p.id, 'Write a launch post')
    expect(res.statusCode).toBe(201)
    const req = requests.find(isPlanner)
    expect(req).toBeDefined()
    expect(req?.model).toBe('llama-3-70b')
    expect(req?.temperature).toBe(0.2)
    expect(req?.tools).toBeUndefined()
    expect(typeof req?.max_tokens).toBe('number')

    const system = systemOf(req ?? {})
    expect(system).toContain(`You are Lead, the team lead of this project in AgentControl. Your agent id is ${lead.id}.`)
    expect(system).toContain('Lead well.')
    expect(system).toContain(`${'L'.repeat(1_400)}`)
    expect(system).not.toContain('L'.repeat(1_500))
    expect(system).toContain('"tasks":[{"agent":"...","task":"..."}]')

    const user = lastUser(req ?? {})
    expect(user).toContain('Project: Blog\nDescription: Our engineering blog.')
    expect(user).toContain(`- id: ${ana.id} | name: Ana | role: Writer | skills: summarization`)
    expect(user).toContain(`- id: ${ben.id} | name: Ben | role: Reviewer`)
    // Primary is never offered as a library agent to add.
    expect(user).not.toContain(`- id: ${lead.id}`)
    expect(user).toContain('- summarization')
    // The last 12 earlier messages, oldest first, labelled by author name.
    expect(user).not.toContain('note 1\n')
    expect(user).toContain('- User: note 2\n')
    expect(user).toContain('- Ana: note 13')
    expect(user.indexOf('note 2')).toBeLessThan(user.indexOf('note 13'))
    expect(user.endsWith("The user's prompt:\nWrite a launch post")).toBe(true)
  })

  it('trims the chat first to fit the window and 413s when the prompt alone cannot fit', async () => {
    const lead = await makeLead()
    const ana = await makeAgent('Ana', { role: 'Writer' })
    const p = await makeProject('Trim', [ana.id])
    for (let i = 0; i < 12; i++) await say(p.id, `${i}`.padEnd(1_000, 'x'))
    const prompt = await say(p.id, 'Go')
    const project = store.projects.find((x) => x.id === p.id) as Project
    const leadAgent = store.agents.find((a) => a.id === lead.id) as Agent
    const message = store.projectMessages.find((m) => m.id === prompt.id) as ProjectMessage
    const chatLines = (content: string) => content.split('\n').filter((l) => l.startsWith('- User: ')).length
    const tokens = (r: ReturnType<typeof buildPlannerRequest>) =>
      Math.ceil(r.messages.reduce((n, m) => n + m.content.length, 0) / 4)

    const full = buildPlannerRequest(store, project, leadAgent, message, 1_000_000)
    expect(chatLines(full.messages[1]?.content ?? '')).toBe(12)
    // Leaves about 150 tokens too few: a few chat lines go, the rosters stay.
    const window = Math.floor(1.5 * (tokens(full) - 150))
    const fitted = buildPlannerRequest(store, project, leadAgent, message, window)
    const user = fitted.messages[1]?.content ?? ''
    expect(chatLines(user)).toBeGreaterThan(0)
    expect(chatLines(user)).toBeLessThan(12)
    expect(user).toContain(`- id: ${ana.id} | name: Ana`)
    expect(user).toContain('- summarization')
    expect(tokens(fitted) + Math.min(2048, Math.floor(window / 3))).toBeLessThanOrEqual(window)
    expect(fitted.maxTokens).toBe(Math.min(4096, window - tokens(fitted)))

    // A Primary on a tiny window cannot fit a long prompt: 413, nothing sent.
    const ep = await inject('POST', '/api/endpoints', {
      kind: 'openai-compatible',
      name: 'Tiny',
      baseUrl: 'http://127.0.0.1:9',
      defaultModel: 'tiny',
      contextWindow: 1_200,
    })
    const tiny = ep.json() as Endpoint
    expect((await inject('PUT', `/api/agents/${lead.id}`, { ...lead, endpointId: tiny.id, modelId: 'tiny' })).statusCode).toBe(200)
    const requests = mockTeam({ reply: 'never' })
    const before = store.projectMessages.length
    const { res } = await askPlan(p.id, 'y'.repeat(5_000))
    expect(res.statusCode).toBe(413)
    expect(res.json().message).toContain("Prompt too large for Lead's context window")
    expect(requests).toHaveLength(0)
    expect(store.projectMessages).toHaveLength(before + 1) // only the user message
  })

  it('validates strictly: drops bad entries with warnings and ignores injected fields', async () => {
    const lead = await makeLead()
    const ana = await makeAgent('Ana', { role: 'Writer' })
    const ben = await makeAgent('Ben', { role: 'Reviewer' })
    const p = await makeProject('Strict', [ana.id])
    mockTeam(
      'Plan below.\n```json\n' +
        JSON.stringify({
          reply: 'Here is the plan.',
          projectId: 'proj_evil',
          planStatus: 'applied',
          add: [{ agentId: 'agt_ghost', reason: '?' }, { agentId: lead.id }, { agentId: ana.id }, 'ben', { agentId: ben.id, extra: 1 }],
          create: [
            { name: 'ana', role: 'x', instructions: 'y' },
            {
              name: 'Researcher',
              role: 'Research',
              instructions: 'Find facts.',
              skillIds: ['deep-research', 'Summarization', 'made-up', 'deep-research'],
              reason: 'Nobody researches.',
              id: 'agt_evil',
              projectId: 'proj_evil',
              endpointId: 'ep_openrouter',
              modelId: 'evil-model',
              isPrimary: true,
            },
            { name: '', instructions: 'z' },
            { name: 'N'.repeat(61), instructions: 'z' },
            { name: 'Ghost Writer', role: 'Writer' },
          ],
          tasks: [
            { agent: 'Nobody', task: 'Do it' },
            { agent: 'researcher', task: 'Research the topic', priority: 'high' },
            { agent: 'Ghost Writer', task: 'Write' },
            { agent: lead.id, task: 'Coordinate' },
            { agent: 'BEN', task: 'Review' },
            { agent: ana.id, task: '' },
          ],
        }) +
        '\n```',
    )

    const { prompt, res } = await askPlan(p.id, 'Research and write')
    expect(res.statusCode).toBe(201)
    const body = res.json() as TeamPlanResponse
    expect(body.messages).toHaveLength(1)
    const msg = body.messages[0] as ProjectMessage
    expect(msg).toMatchObject({ projectId: p.id, author: lead.id, kind: 'team-plan', replyTo: prompt.id, planStatus: 'pending', text: 'Here is the plan.' })
    const plan = msg.plan!
    expect(Object.keys(plan).sort()).toEqual(['add', 'create', 'reply', 'tasks', 'warnings'])
    expect(plan.add).toEqual([{ agentId: ben.id, reason: '' }])
    expect(plan.create).toEqual([
      {
        name: 'Researcher',
        role: 'Research',
        instructions: 'Find facts.',
        skillIds: ['deep-research', 'summarization'],
        reason: 'Nobody researches.',
      },
    ])
    expect(plan.tasks).toEqual([
      { agent: 'Researcher', task: 'Research the topic' },
      { agent: lead.id, task: 'Coordinate' },
      { agent: ben.id, task: 'Review' },
    ])
    const warnings = plan.warnings.join('\n')
    for (const pattern of [
      /"agt_ghost": there is no such agent/,
      /Skipped adding Lead: they already lead the team/,
      /Skipped adding Ana: already on the team/,
      /Skipped creating "ana": an agent with that name already exists/,
      /Dropped unknown skill "made-up" from "Researcher"/,
      /new specialist with no name/,
      /60 characters or fewer/,
      /Skipped creating "Ghost Writer": it had no instructions/,
      /"Nobody" is not on the team, in this plan, or the team lead/,
      /"Ghost Writer" is not on the team/,
      /task with no text/,
    ]) {
      expect(warnings).toMatch(pattern)
    }

    // Applying never lets the model's fields through: fresh id, Primary's endpoint/model.
    const applied = await inject('POST', `/api/projects/${p.id}/plans/${msg.id}/apply`, { tasks: [] })
    expect(applied.statusCode).toBe(200)
    const researcher = store.agents.find((a) => a.name === 'Researcher') as Agent
    expect(researcher.id).not.toBe('agt_evil')
    expect(researcher).toMatchObject({
      projectId: p.id,
      endpointId: 'ep_local_llama',
      modelId: 'llama-3-70b',
      temperature: 0.4,
      isPrimary: false,
      skillIds: ['deep-research', 'summarization'],
    })
    expect(store.agents.filter((a) => a.isPrimary).map((a) => a.id)).toEqual([lead.id])
  })

  it('keeps the first 10 adds, 5 creations and 10 tasks', async () => {
    const lead = await makeLead()
    const pool: Agent[] = []
    for (let i = 0; i < 12; i++) pool.push(await makeAgent(`Pool ${i}`))
    const p = await makeProject('Crowded')
    mockTeam({
      reply: 'Lots.',
      add: pool.map((a) => ({ agentId: a.id, reason: 'more' })),
      create: Array.from({ length: 7 }, (_, i) => ({ name: `New ${i}`, role: 'r', instructions: 'i', reason: 'x' })),
      tasks: Array.from({ length: 12 }, (_, i) => ({ agent: lead.id, task: `Task ${i}` })),
    })
    const { res } = await askPlan(p.id, 'Everything')
    expect(res.statusCode).toBe(201)
    const plan = (res.json() as TeamPlanResponse).messages[0]?.plan
    expect(plan?.add.map((a) => a.agentId)).toEqual(pool.slice(0, 10).map((a) => a.id))
    expect(plan?.create.map((c) => c.name)).toEqual(['New 0', 'New 1', 'New 2', 'New 3', 'New 4'])
    expect(plan?.tasks).toHaveLength(10)
    expect(plan?.warnings).toEqual([
      'Kept the first 10 agents to add; dropped 2 more.',
      'Kept the first 5 new specialists; dropped 2 more.',
      'Kept the first 10 tasks; dropped 2 more.',
    ])
  })

  it('502s on an invalid answer or an upstream failure and writes nothing', async () => {
    await makeLead()
    const p = await makeProject('Broken')
    const prompt = await say(p.id, 'Plan please')
    const snapshot = () => JSON.stringify([store.projectMessages, store.agents, store.projects])
    const before = snapshot()

    for (const answer of ['I would rather not.', '{"reply": "cut off', '{"unrelated": true}', '["reply"]']) {
      mockTeam(answer)
      const res = await inject('POST', `/api/projects/${p.id}/team-plan`, { messageId: prompt.id })
      expect(res.statusCode).toBe(502)
      expect(res.json().message).toMatch(/answer was not a valid team plan.*Nothing was changed/)
      expect(snapshot()).toBe(before)
    }

    mockUpstream(() => ({ status: 500 }))
    const failed = await inject('POST', `/api/projects/${p.id}/team-plan`, { messageId: prompt.id })
    expect(failed.statusCode).toBe(502)
    expect(failed.json().message).toMatch(/Lead could not answer: Upstream responded 500.*Nothing was changed/)
    expect(snapshot()).toBe(before)
  })

  it('404s, 400s and 409s on bad requests', async () => {
    const p = await makeProject('Rules')
    const prompt = await say(p.id, 'Hello')
    mockTeam({ reply: 'Hi.' })
    // No agents at all: there is no Primary yet.
    const noLead = await inject('POST', `/api/projects/${p.id}/team-plan`, { messageId: prompt.id })
    expect(noLead.statusCode).toBe(409)
    expect(noLead.json().message).toContain('Create the Team Lead first')

    const lead = await makeLead()
    expect((await inject('POST', '/api/projects/proj_nope/team-plan', { messageId: prompt.id })).statusCode).toBe(404)
    expect((await inject('POST', `/api/projects/${p.id}/team-plan`, {})).statusCode).toBe(400)
    expect((await inject('POST', `/api/projects/${p.id}/team-plan`, { messageId: 'msg_nope' })).statusCode).toBe(400)
    const fromAgent = await say(p.id, 'I am an agent', lead.id)
    expect((await inject('POST', `/api/projects/${p.id}/team-plan`, { messageId: fromAgent.id })).statusCode).toBe(400)
    const other = await makeProject('Other')
    expect((await inject('POST', `/api/projects/${other.id}/team-plan`, { messageId: prompt.id })).statusCode).toBe(400)

    // A reply-only plan applies at once; asking again for the same message is a 409.
    const first = await inject('POST', `/api/projects/${p.id}/team-plan`, { messageId: prompt.id })
    expect(first.statusCode).toBe(201)
    const body = first.json() as TeamPlanResponse
    expect(body.project.id).toBe(p.id)
    expect(body.messages.map((m) => [m.kind, m.planStatus, m.text])).toEqual([['team-plan', 'applied', 'Hi.']])
    const again = await inject('POST', `/api/projects/${p.id}/team-plan`, { messageId: prompt.id })
    expect(again.statusCode).toBe(409)
  })

  it('409s a second request while Primary is still answering the same message', async () => {
    await makeLead()
    const p = await makeProject('Busy')
    const prompt = await say(p.id, 'Plan')
    const hold = gate()
    const started = gate()
    mockUpstream(async () => {
      started.open()
      await hold.wait
      return '{"reply":"done"}'
    })
    const firstCall = inject('POST', `/api/projects/${p.id}/team-plan`, { messageId: prompt.id })
    await started.wait
    const second = await inject('POST', `/api/projects/${p.id}/team-plan`, { messageId: prompt.id })
    expect(second.statusCode).toBe(409)
    expect(second.json().message).toContain('already answering')
    hold.open()
    expect((await firstCall).statusCode).toBe(201)
  })
})

describe('applying and cancelling plans', () => {
  it('applies a tasks-only plan at once and runs its tasks', async () => {
    const lead = await makeLead()
    const ana = await makeAgent('Ana', { role: 'Writer' })
    const ben = await makeAgent('Ben', { role: 'Reviewer' })
    const p = await makeProject('Launch', [ana.id, ben.id], 'Product launch.')
    const requests = mockTeam({
      reply: 'Ana drafts, Ben reviews.',
      tasks: [
        { agent: ana.id, task: 'Draft the announcement' },
        { agent: 'ben', task: 'Review the announcement' },
      ],
    })

    const started = Date.now()
    const { prompt, res } = await askPlan(p.id, 'Announce v2')
    expect(res.statusCode).toBe(201)
    const body = res.json() as TeamPlanResponse
    const [plan, t1, t2] = body.messages
    expect(plan).toMatchObject({ kind: 'team-plan', planStatus: 'applied', replyTo: prompt.id })
    expect(t1).toMatchObject({ kind: 'task-assignment', author: lead.id, assigneeId: ana.id, taskStatus: 'queued', planId: plan?.id, text: 'Draft the announcement' })
    expect(t2).toMatchObject({ assigneeId: ben.id, taskStatus: 'queued', text: 'Review the announcement' })
    // No team change, so no team-update.
    expect(body.messages.some((m) => m.kind === 'team-update')).toBe(false)

    await whenProjectIdle(store, p.id)
    expect(Date.now() - started).toBeLessThan(1_000)
    const msgs = await thread(p.id)
    expect(msgs.map((m) => m.kind)).toEqual(['message', 'team-plan', 'task-assignment', 'task-assignment', 'task-result', 'task-result'])
    expect(msgs.filter((m) => m.kind === 'task-assignment').map((m) => m.taskStatus)).toEqual(['done', 'done'])
    const results = msgs.filter((m) => m.kind === 'task-result')
    expect(results.map((m) => [m.author, m.text, m.taskId, m.planId, m.taskStatus])).toEqual([
      [ana.id, 'I am Ana.: done', t1?.id, plan?.id, 'done'],
      [ben.id, 'I am Ben.: done', t2?.id, plan?.id, 'done'],
    ])
    const run = store.runs.find((r) => r.id === results[0]?.runId)
    expect(run).toMatchObject({ agentId: ana.id, projectId: p.id, status: 'succeeded' })

    // The task input: project, the user's prompt, the assignment, teammates.
    const taskInput = lastUser(requests.find((r) => systemOf(r) === 'I am Ana.') ?? {})
    expect(taskInput).toContain('Project: Launch\nProduct launch.')
    expect(taskInput).toContain('The user asked:\nAnnounce v2')
    expect(taskInput).toContain('Lead assigned you this task:\nDraft the announcement')
    expect(taskInput).toContain('Your teammates:\n- Ben (Reviewer)')
    expect(taskInput).not.toContain('- Ana (Writer)')
    expect(taskInput.endsWith('Reply with your result for the team.')).toBe(true)
  })

  it('applies a partial selection: creates tagged specialists, updates the team, drops orphaned tasks', async () => {
    const lead = await makeLead()
    const ana = await makeAgent('Ana', { role: 'Writer' })
    const ben = await makeAgent('Ben', { role: 'Reviewer' })
    const p = await makeProject('Partial', [ana.id])
    mockTeam({
      reply: 'Ana writes; I suggest Ben and two specialists.',
      add: [{ agentId: ben.id, reason: 'Ben reviews.' }],
      create: [
        { name: 'Copy Editor', role: 'Editor', instructions: 'You edit copy.', skillIds: ['technical-writing'], reason: 'No editor.' },
        { name: 'SEO Expert', role: 'SEO', instructions: 'You pick keywords.', skillIds: [], reason: 'No SEO.' },
      ],
      tasks: [
        { agent: ana.id, task: 'Draft the post' },
        { agent: 'copy editor', task: 'Edit the draft' },
        { agent: 'SEO Expert', task: 'Pick keywords' },
        { agent: ben.id, task: 'Review the post' },
      ],
    })
    const { res } = await askPlan(p.id, 'Write the blog post')
    expect(res.statusCode).toBe(201)
    const planMsg = (res.json() as TeamPlanResponse).messages[0] as ProjectMessage
    expect(planMsg.planStatus).toBe('pending')
    // Pending: nothing created, no team change, no tasks yet.
    expect(store.agents.some((a) => a.name === 'Copy Editor')).toBe(false)
    expect(store.projectMessages.some((m) => m.kind === 'task-assignment')).toBe(false)

    const applied = await inject('POST', `/api/projects/${p.id}/plans/${planMsg.id}/apply`, { add: [], create: [0], tasks: [0, 1, 2, 3] })
    expect(applied.statusCode).toBe(200)
    const body = applied.json() as TeamPlanResponse
    const editor = store.agents.find((a) => a.name === 'Copy Editor') as Agent
    expect(editor).toMatchObject({
      projectId: p.id,
      endpointId: 'ep_local_llama',
      modelId: 'llama-3-70b',
      temperature: 0.4,
      isPrimary: false,
      role: 'Editor',
      instructions: 'You edit copy.',
      skillIds: ['technical-writing'],
    })
    expect(store.agents.some((a) => a.name === 'SEO Expert')).toBe(false)
    expect(body.project.teamAgentIds).toEqual([ana.id, editor.id])
    expect(store.projects.find((x) => x.id === p.id)?.teamAgentIds).toEqual([ana.id, editor.id])

    const [plan, update, ...assignments] = body.messages
    expect(plan).toMatchObject({ id: planMsg.id, planStatus: 'applied' })
    expect(plan?.updatedAt).toBeTruthy()
    expect(update).toMatchObject({ kind: 'team-update', author: lead.id, planId: planMsg.id })
    expect(update?.text).toBe('Created Copy Editor (Editor) for this project. Skipped 2 tasks whose agent is not on the team. Assigned 2 tasks.')
    expect(assignments.map((m) => [m.kind, m.assigneeId, m.text, m.taskStatus, m.author, m.planId])).toEqual([
      ['task-assignment', ana.id, 'Draft the post', 'queued', lead.id, planMsg.id],
      ['task-assignment', editor.id, 'Edit the draft', 'queued', lead.id, planMsg.id],
    ])

    await whenProjectIdle(store, p.id)
    expect(editor).toMatchObject({ runCount: 1, status: 'idle' })
    const msgs = await thread(p.id)
    expect(msgs.map((m) => m.kind)).toEqual([
      'message',
      'team-plan',
      'team-update',
      'task-assignment',
      'task-assignment',
      'task-result',
      'task-result',
    ])
    expect(msgs.filter((m) => m.kind === 'task-result').map((m) => [m.author, m.text])).toEqual([
      [ana.id, 'I am Ana.: done'],
      [editor.id, 'You edit copy.\n\nSkills:\n\n## technical-writing\n' + store.skills.find((s) => s.id === 'technical-writing')?.content + ': done'],
    ])

    // Apply twice: 409.
    const twice = await inject('POST', `/api/projects/${p.id}/plans/${planMsg.id}/apply`, {})
    expect(twice.statusCode).toBe(409)
  })

  it('accepts everything when the body omits the lists, and records the joins', async () => {
    const lead = await makeLead()
    const ben = await makeAgent('Ben', { role: 'Reviewer' })
    const p = await makeProject('Empty Team')
    mockTeam({
      reply: 'No team yet: Ben joins and I create a Writer.',
      add: [{ agentId: ben.id, reason: 'Reviews.' }],
      create: [{ name: 'Writer', role: 'Writer', instructions: 'You write.', reason: 'Needed.' }],
      tasks: [
        { agent: 'Writer', task: 'Write it' },
        { agent: 'Ben', task: 'Review it' },
        { agent: lead.id, task: 'Wrap up' },
      ],
    })
    const { res } = await askPlan(p.id, 'Make a newsletter')
    const planMsg = (res.json() as TeamPlanResponse).messages[0] as ProjectMessage
    const applied = await inject('POST', `/api/projects/${p.id}/plans/${planMsg.id}/apply`)
    expect(applied.statusCode).toBe(200)
    const body = applied.json() as TeamPlanResponse
    const writer = store.agents.find((a) => a.name === 'Writer') as Agent
    expect(body.project.teamAgentIds).toEqual([ben.id, writer.id])
    expect(body.messages[1]?.text).toBe('Added Ben to the team. Created Writer (Writer) for this project. Assigned 3 tasks.')
    expect(body.messages.slice(2).map((m) => m.assigneeId)).toEqual([writer.id, ben.id, lead.id])
    await whenProjectIdle(store, p.id)
    const results = (await thread(p.id)).filter((m) => m.kind === 'task-result')
    expect(results.map((m) => m.author)).toEqual([writer.id, ben.id, lead.id])
    // The lead running its own task is told so.
    const leadRun = store.runs.find((r) => r.agentId === lead.id)
    expect(leadRun?.input).toContain('As the team lead, you took this task:\nWrap up')
  })

  it('cancels a pending plan; cancel and apply then 409, and the message can be asked again', async () => {
    await makeLead()
    const ben = await makeAgent('Ben')
    const p = await makeProject('Cancel')
    mockTeam({ reply: 'Add Ben?', add: [{ agentId: ben.id, reason: 'r' }] })
    const { prompt, res } = await askPlan(p.id, 'Help')
    const planMsg = (res.json() as TeamPlanResponse).messages[0] as ProjectMessage

    const cancelled = await inject('POST', `/api/projects/${p.id}/plans/${planMsg.id}/cancel`)
    expect(cancelled.statusCode).toBe(200)
    const body = cancelled.json() as TeamPlanResponse
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0]).toMatchObject({ id: planMsg.id, planStatus: 'cancelled' })
    expect(body.messages[0]?.updatedAt).toBeTruthy()
    expect(body.project.teamAgentIds).toEqual([])

    expect((await inject('POST', `/api/projects/${p.id}/plans/${planMsg.id}/cancel`)).statusCode).toBe(409)
    expect((await inject('POST', `/api/projects/${p.id}/plans/${planMsg.id}/apply`, {})).statusCode).toBe(409)
    expect((await inject('POST', `/api/projects/${p.id}/plans/msg_nope/cancel`)).statusCode).toBe(404)
    expect((await inject('POST', `/api/projects/${p.id}/plans/${prompt.id}/apply`, {})).statusCode).toBe(404)
    expect((await inject('POST', `/api/projects/proj_nope/plans/${planMsg.id}/apply`, {})).statusCode).toBe(404)

    const again = await inject('POST', `/api/projects/${p.id}/team-plan`, { messageId: prompt.id })
    expect(again.statusCode).toBe(201)
  })

  it('400s on a bad selection and 409s when a created name was taken meanwhile', async () => {
    await makeLead()
    const ben = await makeAgent('Ben')
    const p = await makeProject('Selection')
    mockTeam({
      reply: 'Plan.',
      add: [{ agentId: ben.id, reason: 'r' }],
      create: [{ name: 'Analyst', role: 'Data', instructions: 'Analyze.', reason: 'r' }],
      tasks: [{ agent: 'Analyst', task: 'Analyze' }],
    })
    const { res } = await askPlan(p.id, 'Analyze sales')
    const planMsg = (res.json() as TeamPlanResponse).messages[0] as ProjectMessage
    const apply = (body: unknown) => inject('POST', `/api/projects/${p.id}/plans/${planMsg.id}/apply`, body)
    expect((await apply({ create: [1] })).statusCode).toBe(400)
    expect((await apply({ tasks: ['0'] })).statusCode).toBe(400)
    expect((await apply({ add: ['agt_other'] })).statusCode).toBe(400)
    expect((await apply({ add: 'all' })).statusCode).toBe(400)

    await makeAgent('analyst')
    const taken = await apply({})
    expect(taken.statusCode).toBe(409)
    expect(taken.json().message).toContain('An agent named "Analyst" exists now')
    // Nothing was written; unticking it applies the rest.
    expect(store.projectMessages.find((m) => m.id === planMsg.id)?.planStatus).toBe('pending')
    const rest = await apply({ create: [] })
    expect(rest.statusCode).toBe(200)
    expect((rest.json() as TeamPlanResponse).project.teamAgentIds).toEqual([ben.id])
    await whenProjectIdle(store, p.id)
  })
})

describe('project task runner', () => {
  it('runs one task at a time per project, while projects run side by side', async () => {
    await makeLead()
    const ana = await makeAgent('Ana')
    const ben = await makeAgent('Ben')
    const p1 = await makeProject('Alpha', [ana.id, ben.id])
    const p2 = await makeProject('Beta', [ana.id, ben.id])
    const inFlight = new Map<string, number>()
    const maxInFlight = new Map<string, number>()
    let total = 0
    let maxTotal = 0
    const bothStarted = gate()
    const order: string[] = []
    mockTeam(
      {
        reply: 'Three tasks.',
        tasks: [
          { agent: ana.id, task: 'one' },
          { agent: ben.id, task: 'two' },
          { agent: ana.id, task: 'three' },
        ],
      },
      async (req) => {
        const project = /^Project: (\w+)/.exec(lastUser(req))?.[1] ?? '?'
        const task = /assigned you this task:\n(\w+)/.exec(lastUser(req))?.[1] ?? '?'
        order.push(`${project}:${task}`)
        inFlight.set(project, (inFlight.get(project) ?? 0) + 1)
        maxInFlight.set(project, Math.max(maxInFlight.get(project) ?? 0, inFlight.get(project) ?? 0))
        total += 1
        maxTotal = Math.max(maxTotal, total)
        if (total === 2) bothStarted.open()
        // The first task of each project waits for the other project's (bounded).
        await Promise.race([bothStarted.wait, new Promise((r) => setTimeout(r, 300))])
        await new Promise((r) => setTimeout(r, 5))
        inFlight.set(project, (inFlight.get(project) ?? 1) - 1)
        total -= 1
        return `${task} done`
      },
    )

    const started = Date.now()
    expect((await askPlan(p1.id, 'go')).res.statusCode).toBe(201)
    expect((await askPlan(p2.id, 'go')).res.statusCode).toBe(201)
    await Promise.all([whenProjectIdle(store, p1.id), whenProjectIdle(store, p2.id)])
    expect(Date.now() - started).toBeLessThan(1_000)

    expect(maxInFlight.get('Alpha')).toBe(1)
    expect(maxInFlight.get('Beta')).toBe(1)
    expect(maxTotal).toBe(2)
    expect(order.filter((o) => o.startsWith('Alpha'))).toEqual(['Alpha:one', 'Alpha:two', 'Alpha:three'])
    expect(order.filter((o) => o.startsWith('Beta'))).toEqual(['Beta:one', 'Beta:two', 'Beta:three'])
    for (const p of [p1, p2]) {
      const results = (await thread(p.id)).filter((m) => m.kind === 'task-result')
      expect(results.map((m) => m.text)).toEqual(['one done', 'two done', 'three done'])
    }
  })

  it('records failures (upstream error, deleted agent) and retries a failed task', async () => {
    await makeLead()
    const ana = await makeAgent('Ana')
    const ben = await makeAgent('Ben')
    const cat = await makeAgent('Cat')
    const p = await makeProject('Faulty', [ana.id, ben.id, cat.id])
    let anaBroken = true
    const benStarted = gate()
    const benHold = gate()
    mockTeam(
      {
        reply: 'Go.',
        tasks: [
          { agent: ana.id, task: 'explode' },
          { agent: ben.id, task: 'fine' },
          { agent: cat.id, task: 'vanish' },
        ],
      },
      async (req) => {
        const who = systemOf(req)
        if (who === 'I am Ana.' && anaBroken) return { status: 500 }
        if (who === 'I am Ben.') {
          benStarted.open()
          await benHold.wait
        }
        return `${who} ok`
      },
    )
    const { res } = await askPlan(p.id, 'Do the three things')
    const [, taskA, taskB, taskC] = (res.json() as TeamPlanResponse).messages

    // Cat is deleted while Ben's task is still running.
    await benStarted.wait
    expect((await inject('DELETE', `/api/agents/${cat.id}`)).statusCode).toBe(204)
    benHold.open()
    await whenProjectIdle(store, p.id)

    // Cat left the team with the library, so the team stays editable.
    expect(store.projects.find((x) => x.id === p.id)?.teamAgentIds).toEqual([ana.id, ben.id])
    expect((await inject('PATCH', `/api/projects/${p.id}`, { teamAgentIds: [ana.id, ben.id] })).statusCode).toBe(200)

    let msgs = await thread(p.id)
    const status = (id?: string) => msgs.find((m) => m.id === id)?.taskStatus
    const resultFor = (id?: string) => msgs.filter((m) => m.kind === 'task-result' && m.taskId === id)
    expect([status(taskA?.id), status(taskB?.id), status(taskC?.id)]).toEqual(['failed', 'done', 'failed'])
    expect(resultFor(taskA?.id)[0]?.text).toMatch(/^Could not finish: Upstream responded 500/)
    // Each result records the outcome of its own attempt.
    expect([resultFor(taskA?.id)[0]?.taskStatus, resultFor(taskB?.id)[0]?.taskStatus, resultFor(taskC?.id)[0]?.taskStatus])
      .toEqual(['failed', 'done', 'failed'])
    const failedRun = store.runs.find((r) => r.id === resultFor(taskA?.id)[0]?.runId)
    expect(failedRun).toMatchObject({ status: 'failed', projectId: p.id })
    expect(resultFor(taskB?.id)[0]?.text).toBe('I am Ben. ok')
    expect(resultFor(taskC?.id)[0]).toMatchObject({
      author: cat.id,
      text: 'Could not finish: the assigned agent is no longer in the library.',
    })
    expect(resultFor(taskC?.id)[0]?.runId).toBeUndefined()

    // Retry: only failed tasks, with an assignee still in the library.
    expect((await inject('POST', `/api/projects/${p.id}/tasks/${taskB?.id}/retry`)).statusCode).toBe(409)
    expect((await inject('POST', `/api/projects/${p.id}/tasks/${taskC?.id}/retry`)).statusCode).toBe(409)
    expect((await inject('POST', `/api/projects/${p.id}/tasks/msg_nope/retry`)).statusCode).toBe(404)
    expect((await inject('POST', `/api/projects/proj_nope/tasks/${taskA?.id}/retry`)).statusCode).toBe(404)

    anaBroken = false
    const retried = await inject('POST', `/api/projects/${p.id}/tasks/${taskA?.id}/retry`)
    expect(retried.statusCode).toBe(200)
    const body = retried.json() as TeamPlanResponse
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0]).toMatchObject({ id: taskA?.id, taskStatus: 'queued' })
    await whenProjectIdle(store, p.id)
    msgs = await thread(p.id)
    expect(status(taskA?.id)).toBe('done')
    expect(resultFor(taskA?.id).map((m) => m.text)).toEqual([expect.stringMatching(/^Could not finish/), 'I am Ana. ok'])
  })

  it('stops a deleted project\'s queue cleanly and keeps its specialists untagged in the library', async () => {
    await makeLead()
    const ana = await makeAgent('Ana')
    const p = await makeProject('Doomed', [ana.id])
    const anaStarted = gate()
    const anaHold = gate()
    const seen: string[] = []
    mockTeam(
      {
        reply: 'Plan.',
        create: [{ name: 'Helper', role: 'Help', instructions: 'I am Helper.', reason: 'r' }],
        tasks: [
          { agent: ana.id, task: 'first' },
          { agent: 'Helper', task: 'second' },
        ],
      },
      async (req) => {
        seen.push(systemOf(req))
        if (systemOf(req) === 'I am Ana.') {
          anaStarted.open()
          await anaHold.wait
        }
        return 'ok'
      },
    )
    const { res } = await askPlan(p.id, 'Work')
    const planMsg = (res.json() as TeamPlanResponse).messages[0] as ProjectMessage
    expect((await inject('POST', `/api/projects/${p.id}/plans/${planMsg.id}/apply`, {})).statusCode).toBe(200)
    const helper = store.agents.find((a) => a.name === 'Helper') as Agent
    expect(helper.projectId).toBe(p.id)

    // Agent PUT keeps the project tag, and a client can never set one.
    const put = await inject('PUT', `/api/agents/${helper.id}`, { ...helper, instructions: 'I am Helper.', projectId: 'proj_other' })
    expect(put.statusCode).toBe(200)
    expect((put.json() as Agent).projectId).toBe(p.id)
    const sneaky = await makeAgent('Sneaky', { projectId: p.id })
    expect(sneaky.projectId).toBeUndefined()

    await anaStarted.wait
    expect((await inject('DELETE', `/api/projects/${p.id}`)).statusCode).toBe(204)
    anaHold.open()
    await whenProjectIdle(store, p.id)

    // Ana's run finished and was recorded; nothing was posted and Helper never ran.
    expect(seen.filter((s) => s !== '' && !s.includes(PLANNER_MARK))).toEqual(['I am Ana.'])
    expect(store.projectMessages.some((m) => m.projectId === p.id)).toBe(false)
    expect(store.runs.find((r) => r.agentId === ana.id)?.projectId).toBe(p.id)
    const got = await inject('GET', `/api/agents/${helper.id}`)
    expect(got.statusCode).toBe(200)
    expect((got.json() as Agent).projectId).toBeUndefined()
    const reloaded = createStore(join(dir, 'store.json'))
    expect(reloaded.agents.find((a) => a.id === helper.id)).toBeDefined()
    expect(reloaded.agents.find((a) => a.id === helper.id)?.projectId).toBeUndefined()
  })

  it('fails tasks a previous process left queued or running, so they can be retried', async () => {
    const lead = await makeLead()
    const ana = await makeAgent('Ana')
    const p = await makeProject('Restart', [ana.id])
    const prompt = await say(p.id, 'Before the crash')
    const base = { projectId: p.id, author: lead.id, kind: 'task-assignment' as const, assigneeId: ana.id, planId: 'msg_plan' }
    store.projectMessages = [
      ...store.projectMessages,
      { ...base, id: 'msg_queued', text: 'queued one', createdAt: '2026-01-01T00:00:01.000Z', taskStatus: 'queued' },
      { ...base, id: 'msg_running', text: 'running one', createdAt: '2026-01-01T00:00:02.000Z', taskStatus: 'running' },
      { ...base, id: 'msg_done', text: 'done one', createdAt: '2026-01-01T00:00:03.000Z', taskStatus: 'done' },
    ]
    expect(store.save()).toBe(true)

    const reloaded = createStore(join(dir, 'store.json'))
    const restarted = buildApp(reloaded)
    try {
      const byId = (id: string) => reloaded.projectMessages.find((m) => m.id === id)
      expect([byId('msg_queued')?.taskStatus, byId('msg_running')?.taskStatus, byId('msg_done')?.taskStatus]).toEqual([
        'failed',
        'failed',
        'done',
      ])
      const results = reloaded.projectMessages.filter((m) => m.kind === 'task-result')
      expect(results.map((m) => [m.taskId, m.author, m.planId])).toEqual([
        ['msg_queued', ana.id, 'msg_plan'],
        ['msg_running', ana.id, 'msg_plan'],
      ])
      for (const r of results) {
        expect(r.text).toContain('interrupted by a restart')
        expect(r.taskStatus).toBe('failed')
      }
      // Persisted, and the user message is untouched.
      const again = createStore(join(dir, 'store.json'))
      expect(again.projectMessages.find((m) => m.id === 'msg_running')?.taskStatus).toBe('failed')
      expect(again.projectMessages.find((m) => m.id === prompt.id)?.kind).toBe('message')

      mockTeam({ reply: 'unused' })
      const retried = await restarted.inject({
        method: 'POST',
        url: `/api/projects/${p.id}/tasks/msg_running/retry`,
        headers: { 'content-type': 'application/json' },
      })
      expect(retried.statusCode).toBe(200)
      await whenProjectIdle(reloaded, p.id)
      expect(reloaded.projectMessages.find((m) => m.id === 'msg_running')?.taskStatus).toBe('done')
    } finally {
      await restarted.close()
    }
  })

  it('rolls back plan, apply, retry and project delete when the store cannot save', async () => {
    const lead = await makeLead()
    const ana = await makeAgent('Ana')
    const p = await makeProject('Fragile', [ana.id])
    mockTeam({
      reply: 'Create a Tester.',
      create: [{ name: 'Tester', role: 'QA', instructions: 'You test.', reason: 'r' }],
      tasks: [{ agent: 'Tester', task: 'Test it' }],
    })
    const save = store.save
    const snapshot = () => JSON.stringify([store.projectMessages, store.agents, store.projects])
    try {
      const prompt = await say(p.id, 'Test the app')
      const before = snapshot()
      store.save = () => false
      const planned = await inject('POST', `/api/projects/${p.id}/team-plan`, { messageId: prompt.id })
      expect(planned.statusCode).toBe(500)
      expect(snapshot()).toBe(before)

      store.save = save
      const ok = await inject('POST', `/api/projects/${p.id}/team-plan`, { messageId: prompt.id })
      const planMsg = (ok.json() as TeamPlanResponse).messages[0] as ProjectMessage
      const pending = snapshot()
      store.save = () => false
      const applied = await inject('POST', `/api/projects/${p.id}/plans/${planMsg.id}/apply`, {})
      expect(applied.statusCode).toBe(500)
      expect(snapshot()).toBe(pending)
      expect((await inject('POST', `/api/projects/${p.id}/plans/${planMsg.id}/cancel`)).statusCode).toBe(500)
      expect(snapshot()).toBe(pending)

      store.save = save
      expect((await inject('POST', `/api/projects/${p.id}/plans/${planMsg.id}/apply`, {})).statusCode).toBe(200)
      await whenProjectIdle(store, p.id)
      const tester = store.agents.find((a) => a.name === 'Tester') as Agent
      const task = store.projectMessages.find((m) => m.kind === 'task-assignment') as ProjectMessage
      store.projectMessages = store.projectMessages.map((m) => (m.id === task.id ? { ...m, taskStatus: 'failed' } : m))
      const failed = snapshot()
      store.save = () => false
      expect((await inject('POST', `/api/projects/${p.id}/tasks/${task.id}/retry`)).statusCode).toBe(500)
      expect(snapshot()).toBe(failed)
      expect((await inject('DELETE', `/api/projects/${p.id}`)).statusCode).toBe(500)
      expect(snapshot()).toBe(failed)
      expect(tester.projectId).toBe(p.id)
      expect(lead.isPrimary).toBe(true)
    } finally {
      store.save = save
    }
  })

  it('keeps plan and task fields across a store reload', async () => {
    const lead = await makeLead()
    const ben = await makeAgent('Ben')
    const p = await makeProject('Durable')
    mockTeam({ reply: 'Add Ben.', add: [{ agentId: ben.id, reason: 'Reviews.' }], tasks: [{ agent: lead.id, task: 'Plan it' }] })
    const { prompt, res } = await askPlan(p.id, 'Persist me')
    const planMsg = (res.json() as TeamPlanResponse).messages[0] as ProjectMessage
    const reloaded = createStore(join(dir, 'store.json'))
    expect(reloaded.projectMessages.find((m) => m.id === planMsg.id)).toEqual(planMsg)
    expect(planMsg).toMatchObject({ replyTo: prompt.id, planStatus: 'pending' })

    expect((await inject('POST', `/api/projects/${p.id}/plans/${planMsg.id}/apply`, {})).statusCode).toBe(200)
    await whenProjectIdle(store, p.id)
    const after = createStore(join(dir, 'store.json'))
    const persisted = after.projectMessages.filter((m) => m.projectId === p.id)
    expect(persisted).toEqual(store.projectMessages.filter((m) => m.projectId === p.id))
    expect(persisted.find((m) => m.kind === 'task-result')).toMatchObject({ author: lead.id, planId: planMsg.id })
  })
})
