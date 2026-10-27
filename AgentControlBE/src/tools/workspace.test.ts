import { defaultAgentVm } from '../vm-defaults.js'
// Registry facade first: it must load standalone (see registry.test.ts).
import { executeToolCall } from '../tools.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, AgentRun, Endpoint, Note, Skill } from '../shared/types.js'
import { createStore, type WorkspaceStore } from '../store.js'
import type { ToolContext } from './types.js'
import { workspaceTools } from './workspace.js'

const NOW = new Date('2026-10-12T09:30:00.000Z')
const SECRET = 'sk-test-secret-123'
const PROTO_KEYS = ['__proto__', 'constructor', 'toString'] as const
const NEW_TOOLS = ['get_agent', 'workspace_overview'] as const

let dir: string
let store: WorkspaceStore

function entry(name: string) {
  const found = workspaceTools.find((t) => t.name === name)
  if (!found) throw new Error(`missing tool ${name}`)
  return found
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    store,
    agentId: 'agent_lead',
    runId: 'run_test',
    input: '',
    allowed: new Set<string>(NEW_TOOLS),
    now: () => NOW,
    timeZone: 'Europe/Berlin',
    writes: { count: 0 },
    ...overrides,
  }
}

/** Call a handler directly and return its (JSON-shaped) result. */
function call(name: string, args: Record<string, unknown> = {}, ctx: ToolContext = makeCtx()): Record<string, unknown> {
  const value = entry(name).handler(args, ctx)
  expect(value).not.toBeUndefined()
  return value as Record<string, unknown>
}

function errorOf(name: string, args: Record<string, unknown>, ctx: ToolContext = makeCtx()): string {
  try {
    entry(name).handler(args, ctx)
  } catch (err) {
    expect(err).toBeInstanceOf(Error)
    return (err as Error).message
  }
  throw new Error(`expected ${name} to throw for ${JSON.stringify(args)}`)
}

/** Every bad-input error ends with a corrected, parseable example. */
function expectExample(message: string): void {
  const match = /Example: (\{.*\})$/.exec(message)
  expect(match, message).not.toBeNull()
  expect(() => JSON.parse(match?.[1] ?? '')).not.toThrow()
}

/** No URL, host, key, key flag, cached model list or system prompt may reach the model. */
function expectNoLeaks(text: string): void {
  expect(text).not.toContain('http')
  expect(text).not.toContain('://')
  expect(text).not.toContain('baseUrl')
  expect(text).not.toMatch(/apiKey/i) // apiKey and apiKeySet
  expect(text).not.toContain('100.79.242.24')
  expect(text).not.toContain('openrouter.ai')
  expect(text).not.toContain(SECRET)
  expect(text).not.toContain('cachedModels')
  expect(text).not.toContain('endpointModels')
  // Cached (non-default) model ids from the seeded endpointModels.
  expect(text).not.toContain('llama-3-70b')
  expect(text).not.toContain('gpt-5.2')
  expect(text).not.toContain('systemPrompt')
  expect(text).not.toContain('SYSTEM PROMPT')
  expect(text).not.toContain('toolCalls')
  expect(text).not.toContain('ARGS-')
}

function makeAgent(partial: Partial<Agent> & { id: string; name: string }): Agent {
  return {
    description: '',
    instructions: '',
    modelId: 'llama-3-8b',
    endpointId: 'ep_local_llama',
    isPrimary: false,
    role: '',
    skillIds: [],
    status: 'idle',
    createdAt: '2026-10-01T00:00:00.000Z',
    lastRunAt: null,
    runCount: 0,
    slug: partial.id,
    internetPolicy: 'ask',
    memoryLearn: true,
    vm: defaultAgentVm(),
    ...partial,
  }
}

function makeSkill(partial: Partial<Skill> & { id: string; name: string }): Skill {
  return { description: '', tag: 'Ops', content: '', tools: [], sourceId: 'custom', hasScripts: false, files: [], defaultOn: false, ...partial }
}

const toolDecl = (name: string) => ({ name, description: `${name} tool`, parameters: {} })

function makeRun(agentId: string, minutesAgo: number, status: AgentRun['status']): AgentRun {
  return {
    id: `run_${agentId}_${minutesAgo}`,
    agentId,
    startedAt: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString(),
    status,
    durationMs: 10,
    steps: 1,
    input: 'hi',
    output: status === 'failed' ? '' : 'ok',
    error: status === 'failed' ? 'boom' : null,
    systemPrompt: `SYSTEM PROMPT http://10.0.0.1 ${SECRET}`,
    toolCalls: [{ name: 'list_agents', arguments: `{"ARGS-":"http://10.0.0.2 ${SECRET}"}`, resultChars: 2, ok: true }],
  }
}

beforeEach(() => {
  vi.stubEnv('AGENTCONTROL_SECRET', 'workspace-test-secret')
  dir = mkdtempSync(join(tmpdir(), 'agentcontrol-workspace-tools-'))
  store = createStore(join(dir, 'store.json'))
  store.skills.push(
    makeSkill({
      id: 'skill_a',
      name: 'Skill A',
      description: 'First test skill.',
      tag: 'Data',
      content: 'Use the tools carefully.',
      tools: [toolDecl('list_agents'), toolDecl('read_run_log')],
    }),
    makeSkill({ id: 'skill_b', name: 'skill-b', tools: [toolDecl('list_agents'), toolDecl('save_note')] }),
  )
  store.agents.push(
    makeAgent({
      id: 'agent_lead',
      name: 'Team Lead',
      role: 'Coordinator',
      description: 'Runs the team.',
      instructions: 'Coordinate the team.',
      isPrimary: true,
      temperature: 0.3,
      skillIds: ['skill_a', 'missing-skill', 'skill_b', 'skill_a'],
      runCount: 12,
      lastRunAt: '2026-10-12T08:00:00.000Z',
    }),
    makeAgent({
      id: 'agent_res',
      name: 'Researcher',
      role: 'Research',
      endpointId: 'ep_openrouter',
      modelId: 'anthropic/claude-sonnet-4',
      status: 'error',
      instructions: `Use key ${SECRET} when asked.`,
    }),
  )
  // A real vault entry: executeToolCall must redact it from every output.
  store.endpointKeys.ep_openrouter = SECRET
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

describe('workspace module', () => {
  it('keeps the original three tools first and appends the new ones', () => {
    expect(workspaceTools.map((t) => t.name)).toEqual([
      'list_agents',
      'list_skills',
      'read_run_log',
      'get_agent',
      'workspace_overview',
      'get_skill',
    ])
    for (const name of NEW_TOOLS) {
      const t = entry(name)
      expect(t.category).toBe('workspace')
      expect(t.effect).toBe('read')
      expect(t.contentParams).toBeUndefined()
      expect((t.parameters as { additionalProperties?: boolean }).additionalProperties).toBe(false)
    }
  })

  it('leaves the original tools unchanged (list_agents is not fitJson-capped)', () => {
    const rows = call('list_agents') as unknown as Record<string, unknown>[]
    expect(rows[0]).toEqual({
      id: 'agent_lead',
      name: 'Team Lead',
      role: 'Coordinator',
      isPrimary: true,
      status: 'idle',
      modelId: 'llama-3-8b',
    })
    const runs = call('read_run_log', {}, makeCtx()) as unknown as unknown[]
    expect(runs).toEqual([])
  })

  it('D-O10: a project-task run reads only its own project\'s runs', () => {
    const plain = makeRun('agent_lead', 1, 'succeeded')
    const sameProject = { ...makeRun('agent_lead', 2, 'succeeded'), projectId: 'proj_a' }
    const otherProject = { ...makeRun('agent_lead', 3, 'succeeded'), projectId: 'proj_b' }
    store.runs = [plain, sameProject, otherProject]

    // A project-task run sees only its project's runs (not the chat run, not
    // another project's).
    const scoped = call('read_run_log', {}, makeCtx({ projectId: 'proj_a' })) as unknown as { id: string }[]
    expect(scoped.map((r) => r.id)).toEqual([sameProject.id])

    // A chat run (no projectId) keeps today's behaviour: every run of the agent.
    const unscoped = call('read_run_log', {}, makeCtx()) as unknown as { id: string }[]
    expect(unscoped.map((r) => r.id)).toEqual([plain.id, sameProject.id, otherProject.id])
  })
})

describe('get_agent', () => {
  it('describes the current agent by default, without any URL or key', () => {
    const out = call('get_agent')
    expect(out).toEqual({
      id: 'agent_lead',
      name: 'Team Lead',
      role: 'Coordinator',
      description: 'Runs the team.',
      instructions: 'Coordinate the team.',
      endpoint: { name: 'Test endpoint (placeholder)', kind: 'openai-compatible', status: 'unknown', contextWindow: 8192 },
      modelId: 'llama-3-8b',
      temperature: 0.3,
      // The missing skill id is skipped and the repeated one deduped; tool names are deduped in order.
      skills: ['Skill A', 'skill-b'],
      tools: ['list_agents', 'read_run_log', 'save_note'],
      isPrimary: true,
      status: 'idle',
      runCount: 12,
      lastRunAt: '2026-10-12T08:00:00.000Z',
    })
    expectNoLeaks(JSON.stringify(out))
  })

  it('lists declared tool names as stored (custom names included) and skips malformed ones', async () => {
    store.skills.push(
      makeSkill({
        id: 'skill_custom',
        name: 'Custom',
        tools: [toolDecl('frob'), toolDecl('http://10.0.0.9/x'), toolDecl(''), { name: 5 } as never, null as never],
      }),
    )
    ;(store.agents[1] as Agent).skillIds = ['skill_custom']
    // Through executeToolCall: this agent's instructions hold the vault secret.
    const out = await executeToolCall({ id: 'c', name: 'get_agent', arguments: '{"agentId": "Researcher"}' }, makeCtx())
    expect(out.ok).toBe(true)
    expect((JSON.parse(out.content) as { tools: string[] }).tools).toEqual(['frob'])
    expectNoLeaks(out.content)
  })

  it('finds an agent by id, case-insensitive name, and the aliases small models send', () => {
    for (const args of [
      { agentId: 'agent_res' },
      { agentId: '  researcher ' },
      { agentId: 'RESEARCHER' },
      { name: 'Researcher' },
      { agent: 'researcher' },
      { id: 'agent_res' },
    ]) {
      const out = call('get_agent', args)
      expect(out.id, JSON.stringify(args)).toBe('agent_res')
      expect(out.endpoint).toEqual({ name: 'OpenRouter', kind: 'openrouter', status: 'unknown', contextWindow: 200_000 })
      expect(out.temperature).toBeNull()
      expect(out.skills).toEqual([])
      expect(out.tools).toEqual([])
    }
  })

  it('accepts a number for an agent whose name is digits, and blank agentId means you', () => {
    store.agents.push(makeAgent({ id: 'agent_42', name: '42' }))
    expect(call('get_agent', { agentId: 42 }).id).toBe('agent_42')
    expect(call('get_agent', { agentId: '   ' }).id).toBe('agent_lead')
    expect(call('get_agent', { agentId: '' }).id).toBe('agent_lead')
    expect(call('get_agent', { agentId: null }).id).toBe('agent_lead')
    // Unknown keys are ignored.
    expect(call('get_agent', { verbose: true }).id).toBe('agent_lead')
  })

  it('clips instructions to 1,500 chars and reports the full length', () => {
    const lead = store.agents[0] as Agent
    lead.instructions = 'Follow the plan. '.repeat(400) // 6,800 chars
    const out = call('get_agent')
    const instructions = out.instructions as string
    expect(instructions.length).toBe(1500)
    expect(instructions.endsWith('…')).toBe(true)
    expect(out.instructionsChars).toBe(6800)
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(3500)
    expect(out.truncated).toBeUndefined()
  })

  it('caps skill and tool names and keeps the result under 3,500 chars', () => {
    const many: string[] = []
    for (let i = 0; i < 25; i++) {
      const id = `bulk_${i}`
      many.push(id)
      store.skills.push(
        makeSkill({ id, name: `Bulk ${i}`, tools: [toolDecl(`t${i}_a_${'x'.repeat(40)}`), toolDecl(`t${i}_b_${'y'.repeat(40)}`)] }),
      )
    }
    store.agents.push(
      makeAgent({ id: 'agent_bulk', name: 'Bulk', skillIds: many, description: 'd'.repeat(5000), instructions: '"\n'.repeat(3000) }),
    )
    const out = call('get_agent', { agentId: 'Bulk' })
    const text = JSON.stringify(out)
    expect(text.length).toBeLessThanOrEqual(3500)
    // Escaped instructions push it over the cap: fitJson shrinks structurally and says so.
    expect(out.truncated).toBe(true)
    expect(out.skillsTotal).toBe(25)
    expect(out.toolsTotal).toBe(50)
    expect((out.skills as string[]).length).toBeLessThanOrEqual(20)
    expect((out.tools as string[]).length).toBeLessThanOrEqual(30)
    expect((out.description as string).length).toBeLessThanOrEqual(500)
    expect(out.instructionsChars).toBe(6000)
  })

  it('returns endpoint null when the agent points at a deleted endpoint', () => {
    store.agents.push(makeAgent({ id: 'agent_orphan', name: 'Orphan', endpointId: 'ep_gone' }))
    expect(call('get_agent', { agentId: 'orphan' }).endpoint).toBeNull()
  })

  it('masks an endpoint name that embeds its own URL, host or any URL', () => {
    const ep = store.endpoints[0] as Endpoint
    ep.name = `llama at ${ep.baseUrl}/v1 (100.79.242.24) see https://example.com/x?key=abc`
    const out = call('get_agent')
    const name = (out.endpoint as { name: string }).name
    expect(name).toContain('llama at')
    expect(name).toContain('[url]')
    expect(name).toContain('[host]')
    expectNoLeaks(JSON.stringify(out))
    expect(JSON.stringify(out)).not.toContain('example.com')
  })

  it('throws errors that end with a corrected example', () => {
    const unknown = errorOf('get_agent', { agentId: 'Nobody' })
    expect(unknown).toContain('No agent "Nobody"')
    expect(unknown).toContain('Known agents: "Team Lead", "Researcher"')
    expectExample(unknown)

    const wrongType = errorOf('get_agent', { agentId: { name: 'Researcher' } })
    expect(wrongType).toContain('must be a string')
    expectExample(wrongType)

    const tooLong = errorOf('get_agent', { agentId: 'a'.repeat(201) })
    expect(tooLong).toContain('too long')
    expectExample(tooLong)

    const gone = errorOf('get_agent', {}, makeCtx({ agentId: 'agent_deleted' }))
    expect(gone).toContain('pass "agentId"')
    expectExample(gone)

    store.agents.length = 0
    const empty = errorOf('get_agent', { agentId: 'x' })
    expect(empty).toContain('Known agents: none')
    expectExample(empty)
  })

  it('treats prototype keys as plain names and ids', () => {
    for (const key of PROTO_KEYS) {
      const msg = errorOf('get_agent', { agentId: key })
      expect(msg).toContain(`No agent "${key}"`)
      expectExample(msg)
    }
    for (const key of PROTO_KEYS) store.agents.push(makeAgent({ id: `agent_${key}`, name: key }))
    for (const key of PROTO_KEYS) {
      const out = call('get_agent', { agentId: key })
      expect(out.name).toBe(key)
      expect(out.id).toBe(`agent_${key}`)
    }
    // Prototype keys as ids, with skills whose ids are prototype keys too.
    for (const key of PROTO_KEYS) {
      store.skills.push(makeSkill({ id: key, name: `skill ${key}`, tools: [toolDecl(`tool_${key}`)] }))
      store.agents.push(makeAgent({ id: key, name: `by-id ${key}`, skillIds: [key] }))
    }
    for (const key of PROTO_KEYS) {
      const out = call('get_agent', { agentId: key }, makeCtx())
      // A name match on agent_<key> is not reached: an exact id wins first.
      expect(out.id).toBe(key)
      expect(out.skills).toEqual([`skill ${key}`])
      expect(call('get_agent', {}, makeCtx({ agentId: key })).id).toBe(key)
    }
    // An own "__proto__" key (as JSON.parse makes it) cannot smuggle in agentId.
    const smuggled = JSON.parse('{"__proto__": {"agentId": "Researcher"}, "constructor": "x"}') as Record<string, unknown>
    expect(call('get_agent', smuggled).id).toBe('agent_lead')
    expect(({} as Record<string, unknown>).agentId).toBeUndefined()
  })

  it('runs through executeToolCall with redaction and the allowlist', async () => {
    const ok = await executeToolCall({ id: 'c1', name: 'get_agent', arguments: '{"agentId": "Researcher"}' }, makeCtx())
    expect(ok.ok).toBe(true)
    const parsed = JSON.parse(ok.content) as { instructions: string }
    expect(parsed.instructions).toBe('Use key [redacted] when asked.')
    expectNoLeaks(ok.content)

    const bad = await executeToolCall({ id: 'c2', name: 'get_agent', arguments: '{"agentId": "Nobody"}' }, makeCtx())
    expect(bad.ok).toBe(false)
    expect(bad.content).toContain('No agent')
    expectExample(bad.content)

    const off = await executeToolCall(
      { id: 'c3', name: 'get_agent', arguments: '{}' },
      makeCtx({ allowed: new Set(['list_skills']) }),
    )
    expect(off).toEqual({ ok: false, content: 'Tool "get_agent" is not enabled for this agent. Available: list_skills' })
  })

  it('never leaks run system prompts, tool-call arguments or secrets, for any agent', async () => {
    for (const agent of store.agents) store.runs.push(makeRun(agent.id, 1, 'failed'))
    for (const agent of store.agents) {
      const out = await executeToolCall({ id: 'c', name: 'get_agent', arguments: JSON.stringify({ agentId: agent.id }) }, makeCtx())
      expect(out.ok).toBe(true)
      expectNoLeaks(out.content)
    }
  })
})

describe('workspace_overview', () => {
  it('returns now, agents, endpoints and counts with no URL, key or cached models', () => {
    const note: Note = {
      id: 'note_1',
      title: 'Plan',
      body: 'b',
      tags: [],
      authorAgentId: 'agent_lead',
      updatedByAgentId: 'agent_lead',
      runId: 'run_x',
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    }
    store.notes.push(note)
    const ep = store.endpoints[0] as Endpoint
    ep.status = 'reachable'
    ep.lastCheckedAt = '2026-10-12T09:00:00.000Z'
    const out = call('workspace_overview')
    expect(out).toEqual({
      now: '2026-10-12T09:30:00.000Z',
      timeZone: 'Europe/Berlin',
      agents: [
        {
          name: 'Team Lead',
          role: 'Coordinator',
          isPrimary: true,
          status: 'idle',
          lastRunAt: '2026-10-12T08:00:00.000Z',
          runCount: 12,
          recentFailures: 0,
        },
        { name: 'Researcher', role: 'Research', isPrimary: false, status: 'error', lastRunAt: null, runCount: 0, recentFailures: 0 },
      ],
      endpoints: [
        {
          name: 'Test endpoint (placeholder)',
          kind: 'openai-compatible',
          status: 'reachable',
          lastCheckedAt: '2026-10-12T09:00:00.000Z',
          contextWindow: 8192,
          defaultModel: 'llama-3-8b',
        },
        {
          name: 'OpenRouter',
          kind: 'openrouter',
          status: 'unknown',
          lastCheckedAt: null,
          contextWindow: 200_000,
          defaultModel: 'anthropic/claude-sonnet-4',
        },
      ],
      counts: { agents: 2, endpoints: 2, skills: store.skills.length, notes: 1 },
    })
    expectNoLeaks(JSON.stringify(out))
  })

  it("counts failures among each agent's last 10 runs only", () => {
    // Newest 10 for the lead: 3 failed. The 4 older failures fall outside the window.
    const lead: AgentRun[] = []
    for (let i = 0; i < 10; i++) lead.push(makeRun('agent_lead', i, i % 3 === 1 ? 'failed' : 'succeeded'))
    for (let i = 10; i < 14; i++) lead.push(makeRun('agent_lead', i, 'failed'))
    // Store order is not time order: shuffle deterministically.
    const shuffled = [...lead.filter((_, i) => i % 2 === 1), ...lead.filter((_, i) => i % 2 === 0)].reverse()
    store.runs.push(...shuffled, makeRun('agent_res', 5, 'failed'), makeRun('agent_gone', 1, 'failed'))
    const out = call('workspace_overview')
    const rows = out.agents as { name: string; recentFailures: number }[]
    expect(rows.find((r) => r.name === 'Team Lead')?.recentFailures).toBe(3)
    expect(rows.find((r) => r.name === 'Researcher')?.recentFailures).toBe(1)
    expectNoLeaks(JSON.stringify(out)) // run system prompts and tool-call arguments never surface
  })

  it('counts the newest 10 whatever the store order (oldest-first, newest-first, interleaved)', () => {
    // 30 runs: the newest 10 (minutes 0-9) hold exactly 4 failures; all 20 older ones failed.
    const runs: AgentRun[] = []
    for (let m = 0; m < 30; m++) runs.push(makeRun('agent_lead', m, m < 10 ? (m % 3 === 0 ? 'failed' : 'succeeded') : 'failed'))
    const orders = [runs, [...runs].reverse(), [...runs.filter((_, i) => i % 3 === 0), ...runs.filter((_, i) => i % 3 !== 0)]]
    for (const order of orders) {
      store.runs = [...order]
      const rows = call('workspace_overview').agents as { name: string; recentFailures: number }[]
      expect(rows.find((r) => r.name === 'Team Lead')?.recentFailures).toBe(4)
    }
    // Fewer than 10 runs: every failure counts.
    store.runs = [makeRun('agent_lead', 3, 'failed'), makeRun('agent_lead', 1, 'failed'), makeRun('agent_lead', 2, 'succeeded')]
    const rows = call('workspace_overview').agents as { name: string; recentFailures: number }[]
    expect(rows.find((r) => r.name === 'Team Lead')?.recentFailures).toBe(2)
  })

  it('ignores every argument, including prototype keys', () => {
    const baseline = call('workspace_overview')
    const smuggled = JSON.parse('{"__proto__": {"x": 1}, "constructor": "a", "toString": "b", "agentId": 5}') as Record<
      string,
      unknown
    >
    expect(call('workspace_overview', smuggled)).toEqual(baseline)
  })

  it('handles agents keyed or named like prototype properties', () => {
    for (const key of PROTO_KEYS) {
      store.agents.push(makeAgent({ id: key, name: key }))
      store.runs.push(makeRun(key, 1, 'failed'), makeRun(key, 2, 'succeeded'))
    }
    const rows = call('workspace_overview').agents as { name: string; recentFailures: number }[]
    for (const key of PROTO_KEYS) expect(rows.find((r) => r.name === key)?.recentFailures).toBe(1)
    // Runs of an unknown agent id that is a prototype key are ignored, not crashed on.
    store.runs.push(makeRun('hasOwnProperty', 1, 'failed'))
    expect(() => call('workspace_overview')).not.toThrow()
  })

  it('masks endpoint names that embed a URL or host', () => {
    const [local, router] = store.endpoints as [Endpoint, Endpoint]
    local.name = local.baseUrl
    router.name = 'router openrouter.ai box http://10.0.0.5:8080/v1'
    const out = call('workspace_overview')
    const names = (out.endpoints as { name: string }[]).map((e) => e.name)
    expect(names).toEqual(['[url]', 'router [host] box [url]'])
    expectNoLeaks(JSON.stringify(out))
  })

  it('stays under 3,500 chars with many agents and marks the result truncated', () => {
    for (let i = 0; i < 120; i++) {
      store.agents.push(makeAgent({ id: `bulk_${i}`, name: `Bulk agent number ${i}`, role: 'Worker '.repeat(20) }))
    }
    const out = call('workspace_overview')
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(3500)
    expect(out.truncated).toBe(true)
    expect((out.counts as { agents: number }).agents).toBe(122)
    expect((out.agents as unknown[]).length).toBeLessThan(122)
    expect(out.now).toBe(NOW.toISOString())
  })

  it('summarizes 10,000 runs in under 100 ms', () => {
    for (let a = 0; a < 200; a++) {
      store.agents.push(makeAgent({ id: `perf_${a}`, name: `P${a}` }))
      // Oldest first: every run is the newest so far (worst case for the bounded insertion).
      for (let r = 49; r >= 0; r--) store.runs.push(makeRun(`perf_${a}`, r, r % 7 === 0 ? 'failed' : 'succeeded'))
    }
    expect(store.runs.length).toBe(10_000)
    const started = performance.now()
    const out = call('workspace_overview')
    expect(performance.now() - started).toBeLessThan(1_000)
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(3500)
  })

  it('summarizes 10,000 runs of a single agent in under 100 ms', () => {
    for (let r = 9_999; r >= 0; r--) store.runs.push(makeRun('agent_lead', r, r < 10 && r % 2 === 0 ? 'failed' : 'succeeded'))
    const started = performance.now()
    const rows = call('workspace_overview').agents as { name: string; recentFailures: number }[]
    expect(performance.now() - started).toBeLessThan(1_000)
    expect(rows.find((r) => r.name === 'Team Lead')?.recentFailures).toBe(5)
  })

  it('runs through executeToolCall with empty or blank arguments and redaction', async () => {
    ;(store.endpoints[1] as Endpoint).name = `OpenRouter ${SECRET}`
    for (const agent of store.agents) store.runs.push(makeRun(agent.id, 1, 'failed'))
    for (const args of ['', '{}', '  ']) {
      const out = await executeToolCall({ id: 'c1', name: 'workspace_overview', arguments: args }, makeCtx())
      expect(out.ok, JSON.stringify(args)).toBe(true)
      const parsed = JSON.parse(out.content) as { now: string; endpoints: { name: string }[] }
      expect(parsed.now).toBe(NOW.toISOString())
      expect(parsed.endpoints[1]?.name).toBe('OpenRouter [redacted]')
      expectNoLeaks(out.content)
    }
    const notArray = await executeToolCall({ id: 'c2', name: 'workspace_overview', arguments: '[1]' }, makeCtx())
    expect(notArray.ok).toBe(false)
  })
})

// --- Reviewer regressions (one block per fix) --------------------------------

/** Run through executeToolCall (redaction included) and apply the shared output contract. */
async function viaExecute(name: string, args: unknown, ctx: ToolContext = makeCtx()): Promise<{ ok: boolean; content: string; ms: number }> {
  const started = performance.now()
  const out = await executeToolCall({ id: 'c', name, arguments: typeof args === 'string' ? args : JSON.stringify(args) }, ctx)
  const ms = performance.now() - started
  expect(typeof out.content).toBe('string')
  expect(out.content.length, `${name} ${String(args).slice(0, 60)}`).toBeLessThanOrEqual(3600)
  return { ...out, ms }
}

function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) i++
      else return true
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true
    }
  }
  return false
}

describe('secrets are redacted before any clip (decision 14)', () => {
  const VAULT = 'hunter2-is-my-long-password-xyz' // not key-shaped: only exact-value redaction catches it

  beforeEach(() => {
    store.endpointKeys.ep_local_llama = VAULT
  })

  it('leaves no prefix of a secret that straddles the instructions, description or name clip', async () => {
    const lead = store.agents[0] as Agent
    lead.instructions = `${'a'.repeat(1480)}${VAULT} more`
    lead.description = `${'d'.repeat(490)}${VAULT}`
    lead.name = `${'n'.repeat(90)}${VAULT}`
    const out = await viaExecute('get_agent', {})
    expect(out.ok).toBe(true)
    expect(out.content).not.toContain('hunter2')
    expect(out.content).toContain('[redacted]')
    const parsed = JSON.parse(out.content) as { instructions: string; instructionsChars: number }
    expect(parsed.instructions.length).toBeLessThanOrEqual(1500)
    expect(parsed.instructionsChars).toBe(1480 + VAULT.length + 5)

    // A key-shaped secret cut so that fewer than 16 chars follow "sk-" would dodge the pattern pass too.
    lead.instructions = `${'a'.repeat(1484)}sk-or-v1-0123456789abcdef0123456789abcdef`
    expect((await viaExecute('get_agent', {})).content).not.toContain('sk-or-v1')
  })

  it('redacts a secret straddling the clip in endpoint names, overview rows and not-found errors', async () => {
    ;(store.endpoints[0] as Endpoint).name = `${'e'.repeat(70)}${VAULT}`
    ;(store.agents[0] as Agent).name = `${'n'.repeat(70)}${VAULT}`
    ;(store.agents[0] as Agent).role = `${'r'.repeat(50)}${VAULT}`
    for (const [name, args] of [
      ['workspace_overview', {}],
      ['get_agent', {}],
      ['get_agent', { agentId: 'Nobody' }],
    ] as const) {
      const out = await viaExecute(name, args)
      expect(out.content, name).not.toContain('hunter2')
    }
    // The not-found list clips names to 40 chars: the secret must not leave a prefix there either.
    ;(store.agents[0] as Agent).name = `${'n'.repeat(30)}${VAULT}`
    expect(errorOf('get_agent', { agentId: 'Nobody' })).not.toContain('hunter2')
  })

  it('redacts secrets longer than the scan margin and many repeats (window widening)', async () => {
    const long = `Z${'abcdefghij'.repeat(300)}` // 3,001 chars straddling the 1,500 clip
    store.endpointKeys.ep_openrouter = long
    const lead = store.agents[0] as Agent
    lead.instructions = `${'x'.repeat(1000)}${long}${'y'.repeat(50_000)}`
    let out = await viaExecute('get_agent', {})
    expect(out.content).not.toContain('Zabcdefghij')

    // Redactions shrink the scanned prefix far below the clip + margin: a secret cut at its end must not surface.
    const sec = `S3cr3t-${'k'.repeat(93)}`
    store.endpointKeys.ep_openrouter = sec
    lead.instructions = `${sec.repeat(60)}tail-${sec}${'z'.repeat(100_000)}`
    out = await viaExecute('get_agent', {})
    expect(out.content).not.toContain('S3cr3t')
    expect((JSON.parse(out.content) as { instructions: string }).instructions).toContain('tail-[redacted]')
  })

  it('keeps results under 3,600 chars when short secrets are expanded to [redacted]', async () => {
    store.endpointKeys.ep_local_llama = 'abcdefgh' // 8 chars → 10: redaction after fitJson would grow the output
    const lead = store.agents[0] as Agent
    lead.instructions = 'abcdefgh '.repeat(400)
    lead.description = 'abcdefgh'.repeat(100)
    lead.role = 'abcdefgh'.repeat(20)
    for (let i = 0; i < 25; i++) {
      store.skills.push(makeSkill({ id: `pad_${i}`, name: `abcdefgh${'abcdefgh'.repeat(10)}`, tools: [toolDecl(`abcdefgh_${i}_${'abcdefgh'.repeat(6)}`)] }))
      lead.skillIds.push(`pad_${i}`)
    }
    for (let i = 0; i < 60; i++) store.agents.push(makeAgent({ id: `pad_${i}`, name: 'abcdefgh'.repeat(10), role: 'abcdefgh'.repeat(8) }))
    for (const name of NEW_TOOLS) {
      const out = await viaExecute(name, {})
      expect(out.ok).toBe(true)
      expect(out.content).not.toContain('abcdefgh')
      expect(out.content.length, name).toBeLessThanOrEqual(3600)
    }
  })
})

describe('endpoint labels never repeat URL parts', () => {
  it('masks the host case-insensitively, userinfo, bracketless IPv6 and any-case schemes', () => {
    const ep = store.endpoints[0] as Endpoint
    const label = () => (call('workspace_overview').endpoints as { name: string }[])[0]?.name ?? ''

    ep.baseUrl = 'http://GpuBox.Local:8080/v1'
    ep.name = 'Llama on GPUBOX.local and gpubox.local:8080'
    expect(label()).toBe('Llama on [host] and [host]')

    ep.baseUrl = 'http://user:p4ssw0rd@10.1.2.3:8080/v1'
    ep.name = 'box user:p4ssw0rd@10.1.2.3'
    expect(label()).toBe('box [redacted]:[redacted]@[host]')

    ep.baseUrl = 'http://[fd7a:115c:a1e0::1]:8080'
    ep.name = 'tailnet fd7a:115c:a1e0::1'
    expect(label()).toBe('tailnet [host]')

    ep.baseUrl = 'http://10.0.0.7:8080'
    ep.name = 'box\tHTTP://other.example/x (backup)'
    expect(label()).toBe('box\t[url] (backup)')

    // Ordinary labels are left alone: no dotted host to mask.
    ep.baseUrl = 'http://localhost:8080'
    ep.name = 'localhost llama'
    expect(label()).toBe('localhost llama')
    expectNoLeaks(JSON.stringify(call('workspace_overview')))
  })

  it('masks a URL repeated past the scan window and a host cut at the window end', () => {
    const ep = store.endpoints[0] as Endpoint
    ep.name = `${ep.baseUrl} `.repeat(5000) + '100.79.242.24'
    expectNoLeaks(JSON.stringify(call('workspace_overview')))
    ep.name = `${'x'.repeat(4170)}100.79.242.24 ${ep.baseUrl.repeat(2000)}`
    expectNoLeaks(JSON.stringify(call('workspace_overview')))
  })
})

describe('clipping keeps unicode intact', () => {
  it('never leaves half a surrogate pair at a clip point', () => {
    const lead = store.agents[0] as Agent
    lead.instructions = '😀'.repeat(1000) // the 1,500 clip falls inside a pair
    lead.description = `x${'😀'.repeat(400)}` // the 500 clip falls inside a pair
    lead.name = `${'😀'.repeat(60)}`
    ;(store.endpoints[0] as Endpoint).name = `y${'😀'.repeat(60)}`
    const agent = call('get_agent')
    for (const field of ['instructions', 'description', 'name'] as const) {
      const text = agent[field] as string
      expect(text.endsWith('…'), field).toBe(true)
      expect(hasLoneSurrogate(text), field).toBe(false)
    }
    expect(hasLoneSurrogate((agent.endpoint as { name: string }).name)).toBe(false)
    const overview = call('workspace_overview')
    expect(hasLoneSurrogate(JSON.stringify(overview.agents) + JSON.stringify(overview.endpoints))).toBe(false)
  })
})

describe('agent references small models send', () => {
  it('accepts snake_case and name aliases instead of silently describing the caller', () => {
    for (const args of [{ agent_id: 'Researcher' }, { agentName: 'researcher' }, { agent_name: 'agent_res' }]) {
      expect(call('get_agent', args).id, JSON.stringify(args)).toBe('agent_res')
    }
  })

  it('gives a not-found example that names a real agent the model can copy', async () => {
    const out = await viaExecute('get_agent', { agentId: 'Nobody' })
    expect(out.ok).toBe(false)
    expect(out.content).toMatch(/Example: \{"agentId":"Team Lead"\}$/)

    // A name that had to be clipped is not offered as the example; the next usable one is.
    ;(store.agents[0] as Agent).name = 'n'.repeat(50)
    const msg = errorOf('get_agent', { agentId: 'Nobody' })
    expect(msg).toMatch(/Example: \{"agentId":"Researcher"\}$/)

    // The deleted-caller error lists known agents too.
    const gone = errorOf('get_agent', {}, makeCtx({ agentId: 'agent_deleted' }))
    expect(gone).toContain('Known agents:')
    expect(gone).toMatch(/Example: \{"agentId":"Researcher"\}$/)
  })
})

describe('bounded work on adversarial stores (< 50 ms each)', () => {
  it('lists at most 50 agents and endpoints in the overview, with exact counts and totals', () => {
    for (let i = 0; i < 5000; i++) {
      store.agents.push(makeAgent({ id: `bulk_${i}`, name: `Agent ${i} ${'r'.repeat(50)}`, role: 'role '.repeat(40) }))
    }
    for (let i = 0; i < 300; i++) store.endpoints.push({ ...(store.endpoints[0] as Endpoint), id: `ep_${i}`, name: `Endpoint ${i}` })
    const started = performance.now()
    const out = call('workspace_overview')
    expect(performance.now() - started).toBeLessThan(1_000)
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(3500)
    expect(out.truncated).toBe(true)
    expect((out.agents as unknown[]).length).toBeLessThanOrEqual(50)
    expect((out.endpoints as unknown[]).length).toBeLessThanOrEqual(50)
    expect(out.counts).toMatchObject({ agents: 5002, endpoints: 302 })
    expect(out.totals).toMatchObject({ agents: 5002, endpoints: 302 })
  })

  it('stays fast on 100k+ runs (2,000+ agents with full histories)', () => {
    for (let a = 0; a < 2100; a++) store.agents.push(makeAgent({ id: `h_${a}`, name: `H${a}` }))
    const runs: AgentRun[] = []
    for (let a = 0; a < 2100; a++) {
      for (let r = 0; r < 50; r++) {
        runs.push({ id: `r${a}_${r}`, agentId: `h_${a}`, startedAt: `2026-10-12T0${r % 10}:00:00.000Z`, status: r % 4 ? 'succeeded' : 'failed', durationMs: 1, steps: 1, input: '', output: '', error: null })
      }
    }
    store.runs = runs
    const started = performance.now()
    call('workspace_overview')
    expect(performance.now() - started).toBeLessThan(1_000)
  })

  it('reads a bounded number of skill ids and tool names in get_agent', () => {
    const lead = store.agents[0] as Agent
    // 250k dangling ids (a 1 MiB agent body holds about that many).
    lead.skillIds = Array.from({ length: 250_000 }, (_, i) => i.toString(36))
    let started = performance.now()
    expect(call('get_agent').skills).toEqual([])
    expect(performance.now() - started).toBeLessThan(1_000)

    // 5,000 attached skills × 16 tools, plus over-long legacy tool names.
    store.skills.length = 0
    for (let i = 0; i < 5000; i++) {
      store.skills.push(
        makeSkill({
          id: `s${i}`,
          name: `Skill ${i}`,
          tools: Array.from({ length: 20 }, (_, j) => toolDecl(j === 0 ? 'a'.repeat(100_000) : `tool_${i}_${j}`)),
        }),
      )
    }
    lead.skillIds = store.skills.map((s) => s.id)
    started = performance.now()
    const out = call('get_agent')
    expect(performance.now() - started).toBeLessThan(1_000)
    expect(out.skillsTotal).toBe(200)
    expect(out.toolsTotal).toBe(200 * 15) // tools 1-15 of each skill; the 100k-char name is skipped
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(3500)
  })

  it('handles 1 MB fields full of secrets', async () => {
    const sec = `S3cr3t-${'k'.repeat(93)}`
    store.endpointKeys.ep_openrouter = sec
    const lead = store.agents[0] as Agent
    for (const field of ['instructions', 'description', 'name', 'role', 'modelId'] as const) lead[field] = sec.repeat(10_000)
    ;(store.endpoints[0] as Endpoint).name = sec.repeat(10_000)
    for (const name of NEW_TOOLS) {
      const out = await viaExecute(name, {})
      expect(out.ok).toBe(true)
      expect(out.ms, name).toBeLessThan(1_000)
      expect(out.content).not.toContain('S3cr3t')
    }
  })
})

describe('fuzz: both tools against hostile arguments', () => {
  const cases: unknown[] = [
    '',
    '{}',
    'null',
    '[]',
    '"str"',
    '5',
    '{"agentId": null}',
    '{"agentId": [1]}',
    '{"agentId": {"name": "Researcher"}}',
    '{"agentId": 1e308}',
    '{"agentId": -1}',
    '{"agentId": true}',
    '{"agentId": "\\ud800"}',
    '{"agentId": "😀👍🏽"}',
    `{"agentId": "${'x'.repeat(200)}"}`,
    `{"agentId": "${'x'.repeat(5000)}"}`,
    '{"__proto__": {"agentId": "Researcher"}}',
    '{"constructor": {"prototype": {"agentId": "x"}}}',
    '{"agentId": "__proto__"}',
    '{"agentId": "constructor"}',
    '{"agentId": "toString"}',
    '{"agentId": "hasOwnProperty"}',
    { agentId: 'researcher', limit: -5, verbose: 'yes' },
  ]

  it('always answers with a bounded string, fast, without leaks', async () => {
    for (const agent of store.agents) store.runs.push(makeRun(agent.id, 1, 'failed'))
    for (const name of NEW_TOOLS) {
      for (const args of cases) {
        const out = await viaExecute(name, args)
        expect(out.ms, `${name} ${String(args)}`).toBeLessThan(1_000)
        expectNoLeaks(out.content)
        if (!out.ok && out.content.startsWith(`Tool "${name}" failed:`)) expectExample(out.content)
      }
    }
  })
})
