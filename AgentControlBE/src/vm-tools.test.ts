import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from './app.js'
import { createBotEnvService } from './bot-env.js'
import { botMounts, storeSaveVm } from './bot-env-routes.js'
import { fakeEngine } from './bot-env.fake.js'
import { ensureDm } from './conversations.js'
import { groupIdle } from './groups.js'
import { NETWORK_UNAVAILABLE } from './podman-runner.js'
import { fakeRunner, until, type FakeRunner } from './run-service.fake.js'
import type { RuntimeProbe } from './runtime-probe.js'
import type { Agent, AgentRun, ConversationSummary, ScriptRun, VmHostInfo } from './shared/types.js'
import { createStore } from './store.js'
import { builtinTools, executeToolCall } from './tools.js'
import type { ToolContext } from './tools/types.js'
import { BROWSER_NOT_ON, resolveCwd, RUN_SCRIPT_RESULT_MAX_CHARS, VM_INSTALL_STILL_BUILDING, VM_INSTALL_TOOL_TIMEOUT_MS, vmToolNames, type VmToolHost } from './tools/vm.js'
import { BUILD_TIMEOUT_MS } from './bot-env.js'
import { BROWSER_LAUNCH_NOTE } from './vm-images.js'

/** BE-P2-16: run_script and vm_install in the agent loop (fake LLM, fake runner, the app's RunService). */

let dir = ''
let store: ReturnType<typeof createStore>
let app: ReturnType<typeof buildApp>
let runner: FakeRunner
const probe: RuntimeProbe = {
  current: () => null,
  refresh: async () => null as never,
  ensureFresh: async () => null as never,
  restore: async () => null,
  startTimer: () => () => {},
}
const host = {
  engine: 'podman', version: '5.4.0', provider: 'native', os: 'linux', machine: null,
  storage: { driver: 'overlay', backend: 'local', volumeState: 'ok' }, concurrency: 2, setupSteps: [],
} as unknown as VmHostInfo

const reply = (content: string) => ({ ok: true, status: 200, json: async () => ({ choices: [{ index: 0, message: { role: 'assistant', content } }] }), text: async () => '' })
const toolCall = (name: string, args: unknown, id = 'c1') => ({
  ok: true, status: 200, text: async () => '',
  json: async () => ({ choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }),
})
interface Sent { tools?: { function: { name: string } }[]; messages: { role: string; content: string; tool_call_id?: string }[] }
/** Upstream mock: answers from `responses` (by bot name when keyed) and records each request body. */
function llm(responses: unknown[] | Record<string, unknown[]>) {
  const sent: Sent[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: { body?: string }) => {
    const body = JSON.parse(init.body ?? '{}') as Sent
    sent.push(body)
    if (Array.isArray(responses)) return responses.shift() ?? reply('done')
    const last = [...body.messages].reverse().find((m) => m.role === 'user')?.content ?? ''
    const name = /You are (.+?), in the group chat/.exec(last)?.[1] ?? '?'
    return responses[name]?.shift() ?? reply(`${name} done`)
  }))
  return sent
}
const toolNamesOf = (s: Sent) => (s.tools ?? []).map((t) => t.function.name)
/** The tool results the model saw by its last request (each request repeats the earlier ones). */
const toolResults = (sent: Sent[]) => (sent.at(-1)?.messages ?? []).filter((m) => m.role === 'tool').map((m) => m.content)

beforeEach(async () => {
  vi.stubEnv('AGENTCONTROL_SECRET', 'be16-test-secret')
  vi.stubEnv('AGENTCONTROL_AUTH_TOKEN', '')
  dir = mkdtempSync(join(tmpdir(), 'agentcontrol-be16-'))
  store = createStore(join(dir, 'store.json'))
  runner = fakeRunner()
  // The real runner refuses network "on" with NETWORK_UNAVAILABLE (RunService then records the refusal).
  runner.check = (req) => runner.refuse ?? (req.network === 'on' ? { status: 'unavailable', error: NETWORK_UNAVAILABLE, durationMs: 0, stdout: '', stderr: '' } as never : null)
  const engine = fakeEngine()
  const botEnv = createBotEnvService({
    exec: engine.exec,
    engine: async () => ({ cli: 'podman', globalArgs: [] }),
    mounts: (a) => botMounts(store, a),
    saveVm: storeSaveVm(store),
    activeRuns: (id) => app.vmRunner.activeRuns(id),
  })
  app = buildApp(store, {
    vmHost: { hostInfo: async () => host, ensureMachine: async () => host, grow: async () => host },
    botEnv, runtimeProbe: probe, vmRunner: runner, vmFreeBytes: () => null, liveTimers: { heartbeatMs: 50, outputFlushMs: 10 },
  })
  await app.ready()
})
afterEach(async () => {
  for (let i = 0; i < 100 && app.vmRuns.activeCount(); i++) {
    for (const p of [...runner.pending]) p.end()
    await new Promise((r) => setTimeout(r, 2))
  }
  await app.vmRuns.idle()
  await app.close()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

async function makeBot(name: string): Promise<Agent> {
  const res = await app.inject({ method: 'POST', url: '/api/agents', payload: { name, endpointId: 'ep_local_llama', modelId: 'llama-3-8b' } })
  expect(res.statusCode).toBe(201)
  return res.json() as Agent
}
async function makeGroup(name: string, members: string[]) {
  const res = await app.inject({ method: 'POST', url: '/api/groups', payload: { name, memberAgentIds: members } })
  expect(res.statusCode).toBe(201)
  const g = res.json() as ConversationSummary & { slug: string }
  mkdirSync(join(dir, 'groups', g.slug, 'shared'), { recursive: true })
  return g
}
const runDm = (a: Agent, input: string) => app.inject({ method: 'POST', url: `/api/agents/${a.id}/runs`, payload: { input } })
const scriptRuns = () => store.chatMessages.filter((m) => m.scriptRun).map((m) => m.scriptRun!)

describe('BE-P2-16 run_script (fake LLM end to end)', () => {
  it('a DM run: the model calls run_script, the run card is posted, the model gets the 8 KB-tail result', async () => {
    const a = await makeBot('Analyst')
    const sent = llm([toolCall('run_script', { argv: ['python3', 'report.py'], why: 'Build the report' }), reply('The report says hello.')])
    const pending = runDm(a, 'Run my report.')
    await until(() => runner.pending.length === 1)
    const req = runner.pending[0]!.req
    expect(req).toMatchObject({ agentId: a.id, context: { kind: 'dm' }, argv: ['python3', 'report.py'], cwd: 'workspace', network: 'off' })
    runner.pending[0]!.out('stdout', 'x'.repeat(20_000) + 'hello\n')
    runner.pending[0]!.end({ exitCode: 0, filesChanged: [{ path: 'workspace/out.md', change: 'added' }] as never })
    const run = (await pending).json() as AgentRun
    expect(run.status).toBe('succeeded')
    expect(run.output).toBe('The report says hello.')
    // Offered: the first request declares both VM tools.
    expect(toolNamesOf(sent[0]!)).toEqual(expect.arrayContaining(['run_script', 'vm_install']))
    const result = JSON.parse(toolResults(sent)[0]!) as Record<string, unknown> & { stdout: string }
    expect(result).toMatchObject({ status: 'succeeded', exitCode: 0, outputNote: expect.stringContaining('last 8 KB'), filesChanged: [{ path: 'workspace/out.md', change: 'added' }] })
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(8 * 1024)
    expect(result.stdout.endsWith('hello\n')).toBe(true)
    // The run card is in the DM, tied to this agent run; the step is on the reply.
    const record = app.vmRuns.get(result.runId as string)!
    expect(record).toMatchObject({ status: 'succeeded', agentRunId: run.id, why: 'Build the report' })
    const card = store.chatMessages.find((m) => m.scriptRunId === record.id)!
    expect(card.conversationId).toBe(ensureDm(store, a.id).id)
    expect(card.scriptRun?.status).toBe('succeeded')
    expect(run.activity?.steps).toEqual([{ tool: 'run_script', summary: 'Ran report.py', ok: true }])
    // Script file changes stay on the run card, not the reply's filesChanged.
    expect(run.filesChanged).toEqual([])
  })

  it('a failed script is ok:false with its full result, and the step reads "Couldn\'t run …"', async () => {
    const a = await makeBot('Analyst')
    const sent = llm([toolCall('run_script', { script: 'python3 broken.py' }), reply('It failed.')])
    const pending = runDm(a, 'go')
    await until(() => runner.pending.length === 1)
    expect(runner.pending[0]!.req.argv).toEqual(['bash', '-c', 'python3 broken.py'])
    runner.pending[0]!.out('stderr', 'Traceback: boom\n')
    runner.pending[0]!.end({ status: 'error', outcome: 'failed', exitCode: 1 } as never)
    const run = (await pending).json() as AgentRun
    expect(run.toolCalls?.[0]).toMatchObject({ name: 'run_script', ok: false })
    expect(JSON.parse(toolResults(sent)[0]!)).toMatchObject({ status: 'failed', exitCode: 1, stderr: 'Traceback: boom\n' })
    expect(run.activity?.steps).toEqual([{ tool: 'run_script', summary: "Couldn't run a script", ok: false }])
  })

  it('a group run defaults to the group folder (and group:shared maps to it)', async () => {
    const lead = await makeBot('Lead')
    const worker = await makeBot('Worker')
    const g = await makeGroup('Pier crew', [worker.id])
    llm({
      Lead: [reply('@Worker')],
      Worker: [
        toolCall('run_script', { script: 'echo pier > notes.txt' }),
        toolCall('run_script', { argv: ['ls'], cwd: 'group:shared/sub' }, 'c2'),
        reply('Saved notes.txt in the group folder.'),
      ],
    })
    expect(lead.isPrimary).toBe(true)
    await app.inject({ method: 'POST', url: `/api/conversations/${g.id}/messages`, payload: { content: 'save a note' } })
    await until(() => runner.pending.length === 1)
    expect(runner.pending[0]!.req).toMatchObject({ agentId: worker.id, context: { kind: 'group', groupId: g.id }, cwd: `groups/${g.slug}` })
    runner.pending[0]!.end()
    await until(() => runner.pending.length === 1 && runner.requests.length === 2)
    expect(runner.pending[0]!.req.cwd).toBe(`groups/${g.slug}/sub`)
    runner.pending[0]!.end()
    await groupIdle(g.id)
    const cards = store.chatMessages.filter((m) => m.scriptRun && m.conversationId === g.id)
    expect(cards).toHaveLength(2)
    expect(store.chatMessages.some((m) => m.conversationId === g.id && m.content === 'Saved notes.txt in the group folder.')).toBe(true)
  })

  it("a group the bot isn't in is refused without a run, and isn't mounted", async () => {
    // The first bot is the primary, which leads (and is in) every group: use two others.
    await makeBot('Lead')
    const a = await makeBot('Analyst')
    const other = await makeBot('Other')
    const g = await makeGroup('Secret crew', [other.id])
    expect(store.conversations.find((c) => c.id === g.id)).toMatchObject({ kind: 'group' })
    expect((store.conversations.find((c) => c.id === g.id) as { memberAgentIds: string[] }).memberAgentIds).not.toContain(a.id)
    const sent = llm([toolCall('run_script', { argv: ['ls'], cwd: `groups/${g.slug}` }), reply('no')])
    const run = (await runDm(a, 'look')).json() as AgentRun
    expect(run.toolCalls?.[0]).toMatchObject({ name: 'run_script', ok: false })
    expect(toolResults(sent)[0]).toContain("this bot isn't in that group")
    expect(runner.requests).toHaveLength(0)
    expect(scriptRuns()).toHaveLength(0)
    expect(botMounts(store, a).map((m) => m.target)).not.toContain(`/bot/groups/${g.slug}`)
    expect(botMounts(store, other).map((m) => m.target)).toContain(`/bot/groups/${g.slug}`)
  })

  it('refuses the browser (M1) and bad folders before starting anything', async () => {
    const a = await makeBot('Analyst')
    const sent = llm([
      toolCall('run_script', { argv: ['python3', 'scrape.py'], browser: true }),
      toolCall('run_script', { argv: ['ls'], cwd: '../etc' }, 'c2'),
      toolCall('run_script', { argv: ['ls'], cwd: 'shared' }, 'c3'),
      reply('ok'),
    ])
    await runDm(a, 'scrape')
    const out = toolResults(sent)
    expect(out[0]).toContain(BROWSER_NOT_ON)
    expect(out[1]).toContain('"cwd" must be a folder inside workspace or groups/<group>')
    expect(out[2]).toContain('"cwd" must be "workspace" or "groups/<group>"')
    expect(runner.requests).toHaveLength(0)
  })

  it('network "on" reaches RunService, which records the refusal on the card', async () => {
    const a = await makeBot('Analyst')
    const sent = llm([toolCall('run_script', { argv: ['curl', 'https://example.com'], network: 'on' }), reply('no internet')])
    const run = (await runDm(a, 'fetch it')).json() as AgentRun
    expect(run.status).toBe('succeeded')
    expect(runner.requests).toHaveLength(0)
    const result = JSON.parse(toolResults(sent)[0]!) as { status: string; error?: string }
    expect(result.status).not.toBe('succeeded')
    expect(result.error).toBe(NETWORK_UNAVAILABLE)
    expect(run.toolCalls?.[0]?.ok).toBe(false)
  })

  it('stopping the reply stops its script', async () => {
    const a = await makeBot('Analyst')
    llm([toolCall('run_script', { argv: ['sleep', '600'] }), reply('never')])
    const conv = ensureDm(store, a.id)
    const { executeRun } = await import('./runs.js')
    const ctl = new AbortController()
    const done = executeRun(store, store.agents.find((x) => x.id === a.id)!, 'wait', { signal: ctl.signal, conversationId: conv.id })
    await until(() => runner.pending.length === 1)
    ctl.abort()
    const { run } = await done
    expect(run.status).toBe('failed')
    expect(scriptRuns()[0]?.status).toBe('stopped')
  })

  it('is not offered while the runner would refuse the bot (and the budget preview agrees)', async () => {
    const a = await makeBot('Analyst')
    const preview = async () =>
      ((await app.inject({ method: 'POST', url: '/api/prompt-budget', payload: { endpointId: 'ep_local_llama', agentId: a.id } })).json() as { toolNames: string[] }).toolNames
    expect(await preview()).toEqual(expect.arrayContaining(['run_script', 'vm_install']))
    runner.refuse = { status: 'unavailable', error: 'Scripts are turned off for this bot.', durationMs: 0, stdout: '', stderr: '' } as never
    expect(vmToolNames(store, a.id)).toEqual([])
    expect(await preview()).not.toContain('run_script')
    const sent = llm([reply('hi')])
    await runDm(a, 'hi')
    expect(toolNamesOf(sent[0]!)).not.toContain('run_script')
  })
})

describe('vm_install timeout (M2 contract fec4670, landed in BE-P2-13)', () => {
  it('is at least 30 min: the 10 min permission wait plus the 20 min build, with the build ending first', () => {
    expect(BUILD_TIMEOUT_MS).toBe(20 * 60_000)
    expect(VM_INSTALL_TOOL_TIMEOUT_MS).toBeGreaterThanOrEqual(30 * 60_000)
    expect(VM_INSTALL_TOOL_TIMEOUT_MS).toBeGreaterThan(10 * 60_000 + BUILD_TIMEOUT_MS)
    const tool = builtinTools.get('vm_install')
    expect(tool?.timeoutMs).toBe(VM_INSTALL_TOOL_TIMEOUT_MS)
  })
})

describe('BE-P2-16 vm_install', () => {
  it('M1 has no build network: the model gets the 409 text and the step fails', async () => {
    const a = await makeBot('Analyst')
    const lock = vi.spyOn(app.vmRuns, 'withToolBuild')
    const sent = llm([toolCall('vm_install', { apt: ['ffmpeg'], why: 'audio' }), reply('cannot')])
    const run = (await runDm(a, 'install ffmpeg')).json() as AgentRun
    expect(toolResults(sent)[0]).toContain("isn't available yet")
    expect(run.activity?.steps).toEqual([{ tool: 'vm_install', summary: "Couldn't install ffmpeg", ok: false }])
    // BE-P2-22: under the bot's build lock (released after, even on a refusal).
    expect(lock).toHaveBeenCalledWith(a.id, expect.any(Function))
    expect(app.vmRuns.buildActive(a.id)).toBe(false)
  })
})

describe('BE-P2-16 tool module', () => {
  const base = (over: Partial<ToolContext> = {}): ToolContext =>
    ({ store, agentId: 'ag_x', runId: 'run_x', input: '', allowed: new Set(['run_script', 'vm_install']), now: () => new Date(), timeZone: 'UTC', writes: { count: 0 }, conversationId: 'dm_x', ...over }) as ToolContext
  function fakeHost(run: Partial<ScriptRun>, over: Partial<VmToolHost> = {}): VmToolHost & { started: unknown[]; stopped: string[] } {
    const r = { id: 'sr_1', status: 'running', ...run } as ScriptRun
    const h: VmToolHost & { started: unknown[]; stopped: string[] } = {
      started: [] as unknown[],
      stopped: [] as string[],
      start: async (input) => (h.started.push(input), r),
      wait: () => new Promise<ScriptRun>(() => {}),
      stop: async (id) => (h.stopped.push(id), r),
      modelResult: (x: ScriptRun) => ({ status: x.status, stdout: (x as unknown as { out?: string }).out ?? '', stderr: '', outputTruncated: false, filesChanged: [], runtime: 'runsc' as const }),
      vmInstall: async () => ({ generation: 1, log: 'ok' }),
      offered: () => true,
      dmConversation: () => 'dm_x',
      browserOn: () => false,
      ...over,
    }
    return h
  }
  const call = (ctx: ToolContext, name: string, args: unknown) => executeToolCall({ id: 'c', name, arguments: JSON.stringify(args) }, ctx)

  it("run_script's browser parameter carries BROWSER_LAUNCH_NOTE word for word", () => {
    const p = builtinTools.get('run_script')!.parameters as { properties: { browser: { description: string } } }
    expect(p.properties.browser.description).toContain(BROWSER_LAUNCH_NOTE)
    expect(builtinTools.get('run_script')!.timeoutMs).toBeGreaterThan(14 * 60_000)
  })

  it('answers "still running" after the wait, without stopping the run', async () => {
    const h = fakeHost({ status: 'running' })
    const out = await call(base({ vm: h, vmWaitMs: 5 }), 'run_script', { argv: ['sleep', '9'] })
    expect(out.ok).toBe(true)
    expect(JSON.parse(out.content)).toMatchObject({ runId: 'sr_1', status: 'running', note: expect.stringContaining('still going') })
    expect(h.stopped).toEqual([])
  })

  it('keeps the JSON within the result limit by cutting the tails from the front', async () => {
    const out8k = 'a'.repeat(8000) + 'TAIL'
    const h = fakeHost({ status: 'succeeded', out: out8k } as never, { wait: async () => ({ id: 'sr_1', status: 'succeeded', out: out8k }) as never })
    const res = await call(base({ vm: h, resultMaxChars: 3000 }), 'run_script', { argv: ['x'] })
    expect(res.content.length).toBeLessThanOrEqual(3000)
    expect(JSON.parse(res.content)).toMatchObject({ outputClipped: true })
    expect((JSON.parse(res.content) as { stdout: string }).stdout.endsWith('TAIL')).toBe(true)
    expect(RUN_SCRIPT_RESULT_MAX_CHARS).toBeGreaterThan(2 * 8192)
  })

  it('resolves folders: /bot/ prefix, trailing slash, group:shared outside a group', () => {
    const ctx = base()
    expect(resolveCwd(undefined, ctx)).toBe('workspace')
    expect(resolveCwd('/bot/workspace/data/', ctx)).toBe('workspace/data')
    expect(() => resolveCwd('group:shared', ctx)).toThrow('only available in a group chat')
    expect(() => resolveCwd('workspace/../x', ctx)).toThrow('must be a folder inside')
    expect(resolveCwd('', base({ group: { id: 'g1', slug: 'crew' } }))).toBe('groups/crew')
  })

  it('vm_install passes the packages and returns the generation', async () => {
    const seen: string[][] = []
    const h = fakeHost({}, { vmInstall: async (_id, p) => (seen.push(p), { generation: 3, log: 'Setting up jq' }) })
    const out = await call(base({ vm: h }), 'vm_install', { apt: ['jq'] })
    expect(out.ok).toBe(true)
    expect(JSON.parse(out.content)).toMatchObject({ installed: ['jq'], generation: 3, logTail: 'Setting up jq' })
    expect(seen).toEqual([['jq']])
    expect((await call(base({ vm: h }), 'vm_install', {})).content).toContain('"apt" is required')
  })

  it('BE-P2-21: vm_install with a recorded build waits for it: succeeded → the generation; failed → a tool error; still going → a note', async () => {
    const queued = { id: 'tb_1', kind: 'tool_build', status: 'queued', queuedReason: 'slot', build: { generation: 4 } } as unknown as ScriptRun
    const where: unknown[] = []
    let ended: ScriptRun = { ...queued, status: 'succeeded', stdoutTail: 'Step 2 of 3: apt-get install\n' }
    const h = fakeHost({}, {
      vmInstall: async (_id, _p, w) => (where.push(w), { run: queued }),
      wait: async () => ended,
    })
    let out = await call(base({ vm: h }), 'vm_install', { apt: ['jq'] })
    expect(out.ok).toBe(true)
    expect(JSON.parse(out.content)).toMatchObject({ installed: ['jq'], generation: 4, logTail: expect.stringContaining('apt-get install') })
    // The call's chat and agent run are the card's place.
    expect(where).toEqual([{ conversationId: 'dm_x', context: { kind: 'dm' }, agentRunId: 'run_x' }])
    await call(base({ vm: h, group: { id: 'g1', slug: 'crew' } } as Partial<ToolContext>), 'vm_install', { apt: ['jq'] })
    expect(where[1]).toMatchObject({ conversationId: 'g1', context: { kind: 'group', groupId: 'g1' } })

    ended = { ...queued, status: 'failed', reason: 'build_failed', error: 'The build failed, so Analyst keeps its current tools (version 3). Nothing else changed.' } as ScriptRun
    out = await call(base({ vm: h }), 'vm_install', { apt: ['jq'] })
    expect(out.ok).toBe(false)
    expect(out.content).toContain('keeps its current tools (version 3)')

    const slow = fakeHost({}, { vmInstall: async () => ({ run: queued }) })
    out = await call(base({ vm: slow, vmWaitMs: 5 }), 'vm_install', { apt: ['jq'] })
    expect(out.ok).toBe(true)
    expect(JSON.parse(out.content)).toMatchObject({ installed: [], runId: 'tb_1', status: 'queued', note: VM_INSTALL_STILL_BUILDING })
    expect(slow.stopped).toEqual([])

    // The user stops the reply: its build is stopped too (one Stop route).
    const ac = new AbortController()
    const stopping = fakeHost({}, { vmInstall: async () => ({ run: queued }) })
    stopping.stop = async (id) => (stopping.stopped.push(id), { ...queued, status: 'stopped' } as ScriptRun)
    let calls = 0
    stopping.wait = async () => (calls++ === 0 ? new Promise<ScriptRun>(() => {}) : ({ ...queued, status: 'stopped', error: 'Stopped. Analyst keeps its current tools (version 3).' } as ScriptRun))
    const p = call(base({ vm: stopping, signal: ac.signal } as Partial<ToolContext>), 'vm_install', { apt: ['jq'] })
    await new Promise((r) => setTimeout(r, 5))
    ac.abort()
    const stopped = await p
    expect(stopping.stopped).toEqual(['tb_1'])
    expect(stopped.content).toContain('keeps its current tools')
  })
})
