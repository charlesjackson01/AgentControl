/**
 * BE-P2-16 @vm: run_script in the agent loop (fake LLM) over the app's RunService and the real
 * container runner. Opt-in: AC_VM_TESTS=1, same engine variables as run-service.vm.test.ts
 * (AC_VM_ENGINE, PODMAN_ARGS). Needs localhost/agentcontrol/botvm:<BOTVM_VERSION> in that engine's
 * store. Runs use --network none; the bots' containers and volumes are removed afterwards.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildApp } from './app.js'
import { botMountAllowList, botMounts, storeSaveVm } from './bot-env-routes.js'
import { createBotEnvService, type EngineRef } from './bot-env.js'
import { execCommandRunner } from './command-runner.js'
import { botRoot } from './files.js'
import { groupRoot } from './group-files.js'
import { groupIdle } from './groups.js'
import { ALLOW_UNLIMITED_RUNS_ENV, createContainerRunner, type ContainerRunner } from './podman-runner.js'
import { MODEL_TAIL_BYTES } from './run-service.js'
import { createRuntimeProbe, PROBE_LABEL, resolveRuntime, type ResolvedRuntime, type RuntimeProbe, type RuntimeProbeResult } from './runtime-probe.js'
import type { Agent, AgentRun, ConversationSummary, VmHostInfo } from './shared/types.js'
import { createStore } from './store.js'
import { PROXY_UNAVAILABLE, type EgressService } from './egress-service.js'
import { sharedImageRef } from './vm-images.js'

const enginePrefix = (process.env.AC_VM_ENGINE ?? 'podman').split(/\s+/).filter(Boolean)
const podmanArgs = (process.env.PODMAN_ARGS ?? '').split(/\s+/).filter(Boolean)
const command = enginePrefix[0] ?? 'podman'
const cli: 'podman' | 'docker' = enginePrefix[enginePrefix.length - 1] === 'docker' ? 'docker' : 'podman'
const ENGINE: EngineRef = { cli, ...(command !== cli ? { command } : {}), globalArgs: [...enginePrefix.slice(1), ...podmanArgs] }

const pm = (...args: string[]): string | null => {
  try {
    return execFileSync(command, [...ENGINE.globalArgs, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 }).trim()
  } catch {
    return null
  }
}
const engineReady = process.env.AC_VM_TESTS === '1' && pm('image', 'inspect', '--format', '{{.Id}}', sharedImageRef('botvm')) !== null

// Bot names only these tests use. The first bot is the primary, whose slug is "primary".
const NAMES = { lead: 'Be16vmlead', worker: 'Be16vmworker', other: 'Be16vmother' }
const SLUGS = ['primary', ...Object.values(NAMES).slice(1).map((n) => n.toLowerCase())]
function cleanup(): void {
  for (const slug of SLUGS) {
    pm('rm', '--force', `ac-bot-${slug}`)
    pm('volume', 'rm', '--force', `ac-tools-${slug}`, `ac-opt-${slug}`)
  }
  for (const id of (pm('ps', '-a', '--filter', `label=${PROBE_LABEL}=1`, '--format', '{{.ID}}') ?? '').split('\n').filter(Boolean)) pm('rm', '--force', id)
}

const reply = (content: string) => ({ ok: true, status: 200, json: async () => ({ choices: [{ index: 0, message: { role: 'assistant', content } }] }), text: async () => '' })
const toolCall = (name: string, args: unknown, id = 'c1') => ({
  ok: true, status: 200, text: async () => '',
  json: async () => ({ choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }),
})
interface Sent { messages: { role: string; content: string }[] }
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
const toolResults = (sent: Sent[]) => (sent.at(-1)?.messages ?? []).filter((m) => m.role === 'tool').map((m) => m.content)

const noProxy = {
  available: async () => ({ ok: false, message: 'no proxy in this test' }),
  networkFor: (slug: string) => `ac-none-${slug}`,
  grant: async () => { throw new Error('no proxy in this test') },
  revoke: async () => [],
  hosts: async () => [],
  removeNetwork: async () => {},
  shutdown: async () => {},
  connectCheck: async () => ({ status: 'fail' as const, message: 'no proxy in this test' }),
  userOnlyCidrs: () => [],
  refreshSubnets: async () => {},
} as unknown as EgressService

describe.skipIf(!engineReady)('@vm BE-P2-16 run_script', () => {
  let dir = ''
  let store: ReturnType<typeof createStore>
  let app: ReturnType<typeof buildApp>
  let probe: RuntimeProbeResult
  let runner: ContainerRunner
  const bots: Record<keyof typeof NAMES, Agent> = {} as never
  let group: ConversationSummary & { slug: string }
  let otherGroup: ConversationSummary & { slug: string }
  const savedOverride = process.env[ALLOW_UNLIMITED_RUNS_ENV]

  const rt = (agent: Agent): ResolvedRuntime => resolveRuntime('auto', agent.vm.gvisor, probe, agent.name)
  const dm = async (a: Agent, input: string) => {
    const res = await app.inject({ method: 'POST', url: `/api/agents/${a.id}/runs`, payload: { input } })
    expect(res.statusCode).toBeLessThan(300)
    return res.json() as AgentRun
  }
  const makeGroup = async (name: string, members: string[]) => {
    const res = await app.inject({ method: 'POST', url: '/api/groups', payload: { name, memberAgentIds: members } })
    expect(res.statusCode).toBe(201)
    const g = res.json() as ConversationSummary & { slug: string }
    mkdirSync(join(groupRoot(store, g.slug), 'shared'), { recursive: true })
    return g
  }

  beforeAll(async () => {
    cleanup()
    vi.stubEnv('AGENTCONTROL_SECRET', 'be16-vm-test-secret')
    vi.stubEnv('AGENTCONTROL_AUTH_TOKEN', '')
    dir = mkdtempSync(join(tmpdir(), 'ac-be16-vm-'))
    store = createStore(join(dir, 'store.json'))
    const probeBind = join(dir, 'probe')
    mkdirSync(probeBind, { recursive: true })
    const realProbe = createRuntimeProbe({ exec: execCommandRunner, engine: async () => ENGINE, bindDir: () => probeBind, tryRunsc: process.env.AC_VM_RUNSC !== '0' })
    probe = await realProbe.refresh()
    const runtimeProbe: RuntimeProbe = { ...realProbe, current: () => probe, refresh: async () => probe, ensureFresh: async () => probe }
    if (!rt({ name: 'x', vm: { gvisor: 'inherit' } } as Agent).limitsEnforced) process.env[ALLOW_UNLIMITED_RUNS_ENV] = '1'
    const mapping = (agent: Agent) => (cli === 'docker' ? null : ((rt(agent).effective === 'runsc' ? probe.uidMapping : probe.standard?.uidMapping) ?? 'keep-id'))
    const botEnv = createBotEnvService({
      exec: execCommandRunner,
      engine: async () => ENGINE,
      // The app's own mounts and allow list (group folders only for groups the bot is in).
      mounts: (agent) => botMounts(store, agent),
      allowedMounts: (agent) => botMountAllowList(store, agent),
      uidMapping: mapping,
      saveVm: storeSaveVm(store),
      runtime: (agent) => (rt(agent).effective === 'runsc' ? 'runsc' : null),
      runtimeFlags: (agent) => (rt(agent).effective === 'runsc' ? (rt(agent).flags ?? []) : []),
      enforceLimits: () => probe.standard?.limitsAccepted ?? true,
      activeRuns: (id) => runner.activeRuns(id),
    })
    runner = createContainerRunner({ botEnv, engine: async () => ENGINE, getAgent: (id) => store.agents.find((a) => a.id === id), runtime: rt })
    const host = {
      engine: cli, version: 'test', provider: 'native', os: 'linux', machine: null,
      storage: { driver: null, backend: 'local', volumeState: 'ok' }, concurrency: 2, setupSteps: [],
    } as unknown as VmHostInfo
    app = buildApp(store, {
      vmHost: { hostInfo: async () => host, ensureMachine: async () => host, grow: async () => host },
      botEnv, runtimeProbe, vmRunner: runner, vmFreeBytes: () => null,
      // BE-P2-14: no proxy in this suite (egress.vm.test.ts / permission-gate.vm.test.ts cover it).
      egress: noProxy,
    })
    await app.ready()
    for (const [k, name] of Object.entries(NAMES) as [keyof typeof NAMES, string][]) {
      const res = await app.inject({ method: 'POST', url: '/api/agents', payload: { name, endpointId: 'ep_local_llama', modelId: 'llama-3-8b' } })
      expect(res.statusCode).toBe(201)
      bots[k] = res.json() as Agent
      expect(SLUGS).toContain(bots[k].slug)
      for (const sub of ['workspace', 'shared']) mkdirSync(join(botRoot(store, bots[k]), sub), { recursive: true })
    }
    // The lead (primary) is in every group; the worker is in `group` only.
    group = await makeGroup('Be16 pier crew', [bots.worker.id])
    otherGroup = await makeGroup('Be16 secret crew', [bots.other.id])
  }, 300_000)

  afterAll(async () => {
    await app?.vmRuns.idle().catch(() => {})
    await app?.close()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    if (savedOverride === undefined) delete process.env[ALLOW_UNLIMITED_RUNS_ENV]
    else process.env[ALLOW_UNLIMITED_RUNS_ENV] = savedOverride
    cleanup()
    if (dir) pm('unshare', 'rm', '-rf', dir)
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  }, 120_000)

  it('a DM run: the model runs a real script, gets 8 KB tails, and the file lands in the workspace', async () => {
    const sent = llm([
      toolCall('run_script', { argv: ['python3', '-c', "open('out.txt','w').write('made in vm')\nfor i in range(3000): print('line', i)"], why: 'Make the file' }),
      reply('Wrote out.txt.'),
    ])
    const run = await dm(bots.worker, 'make out.txt')
    expect(run.output).toBe('Wrote out.txt.')
    expect(run.toolCalls?.[0]).toMatchObject({ name: 'run_script', ok: true })
    const result = JSON.parse(toolResults(sent)[0]!) as { status: string; stdout: string; outputNote?: string; runId: string; filesChanged: { path: string }[] }
    expect(result.status).toBe('succeeded')
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(MODEL_TAIL_BYTES)
    expect(result.stdout.trimEnd().endsWith('line 2999')).toBe(true)
    expect(result.outputNote).toContain('last 8 KB')
    expect(readFileSync(join(botRoot(store, bots.worker), 'workspace', 'out.txt'), 'utf8')).toBe('made in vm')
    expect(app.vmRuns.get(result.runId)).toMatchObject({ status: 'succeeded', agentRunId: run.id, why: 'Make the file' })
    expect(store.chatMessages.find((m) => m.scriptRunId === result.runId)?.scriptRun?.status).toBe('succeeded')
  }, 300_000)

  it('a group run writes into the group folder (its default cwd)', async () => {
    llm({
      Be16vmlead: [reply('@Be16vmworker')],
      Be16vmworker: [toolCall('run_script', { script: 'echo pier > notes.txt && pwd' }), reply('Saved notes.txt.')],
    })
    await app.inject({ method: 'POST', url: `/api/conversations/${group.id}/messages`, payload: { content: 'save a note' } })
    const t0 = Date.now()
    while (!store.chatMessages.some((m) => m.conversationId === group.id && m.content === 'Saved notes.txt.') && Date.now() - t0 < 240_000) {
      await new Promise((r) => setTimeout(r, 100))
    }
    await groupIdle(group.id)
    expect(readFileSync(join(groupRoot(store, group.slug), 'shared', 'notes.txt'), 'utf8')).toBe('pier\n')
    const card = store.chatMessages.find((m) => m.conversationId === group.id && m.scriptRun)
    expect(card?.scriptRun?.status).toBe('succeeded')
  }, 300_000)

  it("a group the bot isn't in is refused without a run, and isn't mounted in its VM", async () => {
    const sent = llm([
      toolCall('run_script', { argv: ['ls'], cwd: `groups/${otherGroup.slug}` }),
      toolCall('run_script', { argv: ['ls', '/bot/groups'] }, 'c2'),
      reply('ok'),
    ])
    const before = store.chatMessages.filter((m) => m.scriptRun).length
    const run = await dm(bots.worker, 'look around')
    expect(run.toolCalls?.map((c) => c.ok)).toEqual([false, true])
    expect(toolResults(sent)[0]).toMatch(/isn't in|not in|member/i)
    const ls = JSON.parse(toolResults(sent)[1]!) as { status: string; stdout: string }
    expect(ls.status).toBe('succeeded')
    const listed = ls.stdout.split('\n').filter(Boolean)
    expect(listed).toContain(group.slug)
    expect(listed).not.toContain(otherGroup.slug)
    // One card (the ls), none for the refused call.
    expect(store.chatMessages.filter((m) => m.scriptRun).length).toBe(before + 1)
  }, 300_000)

  it('BE-P2-14: network "on" with no proxy for this app → the model is told 409 proxy_unavailable', async () => {
    const sent = llm([toolCall('run_script', { argv: ['true'], network: 'on' }), reply('no internet')])
    await dm(bots.worker, 'fetch it')
    expect(toolResults(sent)[0]).toContain(PROXY_UNAVAILABLE)
  }, 300_000)
})
