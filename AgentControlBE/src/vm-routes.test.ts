import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from './app.js'
import { createBotEnvService } from './bot-env.js'
import { botMounts, rollbackLog, storeSaveVm } from './bot-env-routes.js'
import { vmToolHost } from './tools/vm.js'
import { fakeEngine } from './bot-env.fake.js'
import { ensureDm } from './conversations.js'
import { botRoot } from './files.js'
import { createStore } from './store.js'
import { fakeRunner, type FakeRunner } from './run-service.fake.js'
import type { EgressService } from './egress-service.js'
import type { Agent, ChatMessage, HostContact, ScriptRun, VmHostInfo, VmInfo, VmToolsInfo } from './shared/types.js'
import { UNDO_RUN_ACTIVE_TEXT } from './undo.js'
import { applyVmSettingsPatch, PER_BOT_OVER_GLOBAL } from './vm-settings-routes.js'
import { defaultAgentVm, defaultVmSettings } from './vm-defaults.js'
import type { VmHostService } from './vm-host.js'
import type { RuntimeProbe } from './runtime-probe.js'

/** BE-P2-17: /api/vm/settings, tool rebuild/rollback and the undo routes (fake engine and runner). */

let dir = ''
let store: ReturnType<typeof createStore>
let app: ReturnType<typeof buildApp>
let runner: FakeRunner
let engine: ReturnType<typeof fakeEngine>
let refreshes = 0
const probe: RuntimeProbe = {
  current: () => null,
  refresh: async () => (refreshes++, null as never),
  ensureFresh: async () => null as never,
  restore: async () => null,
  startTimer: () => () => {},
}
const host = {
  engine: 'podman', version: '5.4.0', provider: 'native', os: 'linux', machine: null,
  storage: { driver: 'overlay', backend: 'local', volumeState: 'ok' }, concurrency: 2, setupSteps: [],
} as VmHostInfo

/** BE-P2-22: while set, the fake engine's `build` (and BE-P2-21's proxy `run`) waits for it (a build in progress). */
let buildGate: Promise<void> | null = null
/** BE-P2-21: a fake egress proxy (online builds): health, grants and the host log. */
let egressOk = true
let hostLog: HostContact[] = []
const fakeEgress = {
  available: async () => (egressOk ? { ok: true } : { ok: false, message: 'down' }),
  grant: async (slug: string) => ({
    id: 'g1', slug, network: `ac-net-${slug}`, proxyAddress: '10.0.0.2:3128',
    env: [{ name: 'HTTP_PROXY', value: 'http://g1:s3cr3t-cred@10.0.0.2:3128' }], secrets: ['s3cr3t-cred'],
  }),
  revoke: async () => hostLog,
  hosts: async () => hostLog,
  networkFor: (slug: string) => `ac-net-${slug}`,
  removeNetwork: async () => {},
  shutdown: async () => {},
  connectCheck: async () => ({ status: 'pass' as const }),
} as unknown as EgressService
async function build(opts: { failBuild?: boolean } = {}): Promise<void> {
  engine = fakeEngine(opts)
  runner = fakeRunner()
  const vmHost: VmHostService = { hostInfo: async () => host, ensureMachine: async () => host, grow: async () => host }
  const botEnv = createBotEnvService({
    exec: async (cmd, args, o) => {
      const verb = args[0]
      if (verb === 'build' || verb === 'run') {
        // BE-P2-21: live output first (progress), then wait for the gate or a Stop (code 130, like the real runner).
        o?.onOutput?.('stdout', verb === 'build' ? 'STEP 1/2: FROM base\n' : 'Step 1 of 3: apt-get update\nHTTP_PROXY=http://g1:s3cr3t-cred@x\n')
        if (buildGate) {
          const signal = o?.signal
          await Promise.race([buildGate, new Promise<void>((r) => signal?.addEventListener('abort', () => r(), { once: true }))])
          if (signal?.aborted) return { code: 130, stdout: '', stderr: 'stopped' }
        }
        if (verb === 'run') {
          if (opts.failBuild) return { code: 100, stdout: '', stderr: 'E: Unable to locate package nope' }
          o?.onOutput?.('stdout', 'Step 2 of 3: apt-get install\n')
          return { code: 0, stdout: 'Step 1 of 3: apt-get update\nStep 2 of 3: apt-get install\n', stderr: '' }
        }
      }
      if (verb === 'build') {
        // The real runner streams stderr too.
        const r = await engine.exec(cmd, args, o)
        if (r.stderr) o?.onOutput?.('stderr', `${r.stderr}\n`)
        return r
      }
      if (verb === 'image' && args[1] === 'inspect' && args[2] === '--format') {
        // The proxy build reads the base image's config.
        return engine.images.has(args[4]!) ? { code: 0, stdout: '{"User":"1000:1000","Entrypoint":null,"Cmd":["sleep","infinity"]}', stderr: '' } : { code: 125, stdout: '', stderr: 'image not known' }
      }
      if (verb === 'commit') {
        engine.images.set(args[args.length - 1]!, { id: `c-${args[args.length - 1]}`, labels: {} })
        return { code: 0, stdout: 'sha', stderr: '' }
      }
      return engine.exec(cmd, args, o)
    },
    engine: async () => ({ cli: 'podman', globalArgs: [] }),
    mounts: (a) => botMounts(store, a),
    saveVm: storeSaveVm(store),
    activeRuns: (id) => app.vmRunner.activeRuns(id),
    egress: fakeEgress,
  })
  app = buildApp(store, { vmHost, botEnv, runtimeProbe: probe, vmRunner: runner, vmFreeBytes: () => null, egress: fakeEgress })
  await app.ready()
}
/** BE-P2-21: POST rebuild → 202 {run}; resolves with the run once it ends. */
async function rebuildEnded(id: string): Promise<ScriptRun> {
  const res = await inject('POST', `/api/agents/${id}/vm/tools/rebuild`)
  expect(res.statusCode).toBe(202)
  return app.vmRuns.wait((res.json() as { run: ScriptRun }).run.id)
}

beforeEach(async () => {
  vi.stubEnv('AGENTCONTROL_SECRET', 'be17-test-secret')
  vi.stubEnv('AGENTCONTROL_AUTH_TOKEN', '')
  dir = mkdtempSync(join(tmpdir(), 'agentcontrol-be17-'))
  store = createStore(join(dir, 'store.json'))
  refreshes = 0
  buildGate = null
  egressOk = true
  hostLog = []
  await build()
})
afterEach(async () => {
  for (let i = 0; i < 100 && app.vmRuns.activeCount(); i++) {
    for (const p of [...runner.pending]) p.end()
    await new Promise((r) => setTimeout(r, 2))
  }
  await app.vmRuns.idle()
  await app.close()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

const inject = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) => app.inject({ method, url, payload: payload as object | undefined })
async function makeAgent(name = 'Analyst'): Promise<Agent> {
  const res = await inject('POST', '/api/agents', { name, endpointId: 'ep_local_llama', modelId: 'llama-3-8b' })
  expect(res.statusCode).toBe(201)
  const a = res.json() as Agent
  mkdirSync(join(botRoot(store, store.agents.find((x) => x.id === a.id)!), 'workspace'), { recursive: true })
  return a
}
const stored = (id: string) => store.agents.find((a) => a.id === id)!
const startFor = (a: Agent) => app.vmRuns.start({ agentId: a.id, conversationId: ensureDm(store, a.id).id, context: { kind: 'dm' }, argv: ['python', 'go.py'] })
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 500 && !cond(); i++) await new Promise((r) => setTimeout(r, 2))
  expect(cond()).toBe(true)
}

describe('GET/PATCH /api/vm/settings', () => {
  it('GET: the defaults when nothing is stored; never volumeId or machine', async () => {
    const res = await inject('GET', '/api/vm/settings')
    expect(res.statusCode).toBe(200)
    const d = defaultVmSettings()
    expect(res.json()).toEqual({ gvisor: d.gvisor, backups: d.backups, snapshotBudget: d.snapshotBudget })
    store.settings = { ...store.settings, vm: { ...d, volumeId: 'vol_x', machine: { diskGb: 80 } } }
    expect(Object.keys((await inject('GET', '/api/vm/settings')).json()).sort()).toEqual(['backups', 'gvisor', 'snapshotBudget'])
  })

  it('PATCH is partial, persists, re-probes on a gvisor change and enforces a budget change', async () => {
    const enforce = vi.spyOn(app.vmSnapshotBudget, 'enforce')
    let res = await inject('PATCH', '/api/vm/settings', { gvisor: 'force_off' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ gvisor: 'force_off', snapshotBudget: defaultVmSettings().snapshotBudget })
    expect(refreshes).toBe(1)
    expect(enforce).not.toHaveBeenCalled()
    res = await inject('PATCH', '/api/vm/settings', { gvisor: 'force_off', backups: { keep: 3, time: '23:15' }, snapshotBudget: { perBotMb: 512 } })
    expect(res.statusCode).toBe(200)
    expect(refreshes).toBe(1) // unchanged mode: no probe
    expect(enforce).toHaveBeenCalledTimes(1)
    expect(res.json()).toMatchObject({ backups: { enabled: defaultVmSettings().backups.enabled, keep: 3, time: '23:15' }, snapshotBudget: { perBotMb: 512 } })
    // The same budget again: nothing to enforce.
    await inject('PATCH', '/api/vm/settings', { snapshotBudget: { perBotMb: 512 } })
    expect(enforce).toHaveBeenCalledTimes(1)
    const reloaded = createStore(join(dir, 'store.json')).settings.vm!
    expect(reloaded).toMatchObject({ gvisor: 'force_off', backups: { keep: 3, time: '23:15' }, snapshotBudget: { perBotMb: 512 } })
    // The Phase 1 settings route still serves only its own fields.
    expect((await inject('GET', '/api/settings')).json()).not.toHaveProperty('vm')
  })

  it('PATCH 400s save nothing', async () => {
    const before = structuredClone(store.settings.vm)
    const bad = async (body: unknown, msg: RegExp | string) => {
      const res = await inject('PATCH', '/api/vm/settings', body)
      expect(res.statusCode).toBe(400)
      expect(res.json().message).toMatch(msg)
    }
    await bad([], /JSON object/)
    await bad({ volumeId: 'x' }, /"volumeId" can't be changed here/)
    await bad({ machine: { diskGb: 9 } }, /"machine" can't be changed here/)
    await bad({ gvisor: 'on' }, /"gvisor" must be/)
    await bad({ backups: true }, /"backups" must be an object/)
    await bad({ backups: { enabled: 'yes' } }, /backups.enabled/)
    await bad({ backups: { time: '24:00' } }, /backups.time/)
    await bad({ backups: { time: '3:00' } }, /backups.time/)
    await bad({ backups: { keep: 0 } }, /from 1 to 30/)
    await bad({ backups: { keep: 2.5 } }, /backups.keep/)
    await bad({ backups: { when: 'x' } }, /"backups.when" can't be changed here/)
    await bad({ snapshotBudget: { perBotMb: 255 } }, /from 256 to 20480/)
    await bad({ snapshotBudget: { globalMb: 204801 } }, /snapshotBudget.globalMb/)
    await bad({ snapshotBudget: { freeFloorMb: 1024 } }, /from 3072 to 51200/)
    await bad({ snapshotBudget: { perBotMb: '512' } }, /whole number/)
    await bad({ snapshotBudget: { extra: 1 } }, /"snapshotBudget.extra"/)
    await bad({ snapshotBudget: { perBotMb: 4096, globalMb: 2048 } }, PER_BOT_OVER_GLOBAL)
    // All-or-nothing: a good key next to a bad one is not saved.
    await bad({ gvisor: 'force_on', backups: { keep: 99 } }, /backups.keep/)
    expect(store.settings.vm).toEqual(before)
    expect(refreshes).toBe(0)
  })

  it('applyVmSettingsPatch does not change its input', () => {
    const cur = defaultVmSettings()
    const copy = structuredClone(cur)
    applyVmSettingsPatch(cur, { backups: { keep: 2 }, snapshotBudget: { perBotMb: 300 } })
    expect(cur).toEqual(copy)
  })
})

describe('POST /api/agents/:id/vm/tools/rebuild and /rollback', () => {
  it('rebuild → 202 {run}: a live tool_build record with its card in the DM, listed and with its log; rollback → generation 0', async () => {
    const a = await makeAgent()
    const res = await inject('POST', `/api/agents/${a.id}/vm/tools/rebuild`)
    expect(res.statusCode).toBe(202)
    const accepted = (res.json() as { run: ScriptRun }).run
    expect(accepted).toMatchObject({
      agentId: a.id, kind: 'tool_build', argv: ['rebuild'], why: "Rebuild the bot's tools", network: 'off', permissions: [],
      build: { generation: 1, fromGeneration: 0, packages: [], added: [], startedBy: 'user', via: 'rebuild', base: 'base' },
    })
    expect(['queued', 'running']).toContain(accepted.status)
    expect(accepted.conversationId).toBe(ensureDm(store, a.id).id)
    const run = await app.vmRuns.wait(accepted.id)
    expect(run).toMatchObject({ status: 'succeeded', exitCode: 0, build: { generation: 1, fromGeneration: 0 } })
    expect(run.build!.progress).toBeUndefined()
    expect(run.reason).toBeUndefined()
    expect(stored(a.id).vm.image.generation).toBe(1)
    expect(engine.images.has(`localhost/ac-bot-${stored(a.id).slug}:1`)).toBe(true)
    const card = store.chatMessages.find((m) => m.scriptRunId === run.id)!
    expect(card.content).toBe("Built Analyst's tools (version 1)")
    expect(card.scriptRun).toMatchObject({ name: 'Rebuild tools', status: 'succeeded', internet: 'off', network: 'off', build: { generation: 1 } })
    expect(card.scriptRun!.scriptName).toBeUndefined()
    expect((await inject('GET', `/api/runs/${run.id}`)).json()).toMatchObject({ id: run.id, kind: 'tool_build', build: { generation: 1 } })
    const list = (await inject('GET', `/api/agents/${a.id}/script-runs`)).json() as { runs: ScriptRun[] }
    expect(list.runs.find((r) => r.id === run.id)).toMatchObject({ kind: 'tool_build', internet: 'off', build: { generation: 1 } })
    const out = await inject('GET', `/api/runs/${run.id}/output?stream=stdout`)
    expect(out.statusCode).toBe(200)
    expect(out.body).toContain('STEP 1/2')
    expect(Buffer.byteLength(out.body)).toBe(run.outputBytes)

    // Rollback stays synchronous (200, no card).
    const back = await inject('POST', `/api/agents/${a.id}/vm/tools/rollback`)
    expect(back.statusCode).toBe(200)
    expect(back.json()).toMatchObject({ kind: 'tool_build', status: 'succeeded', argv: ['rollback'] })
    expect(back.json().stdoutTail).toBe(rollbackLog(stored(a.id).vm))
    expect(stored(a.id).vm.image.generation).toBe(0)
    expect(back.json().stdoutTail).toMatch(/shared base image \(generation 0\)\. System packages: none\./)
    expect(store.chatMessages.some((m) => m.scriptRunId === back.json().id)).toBe(false)
  })

  it('the bot\'s DM is the conversation when it has one', async () => {
    const a = await makeAgent()
    const dm = ensureDm(store, a.id).id
    expect((await inject('POST', `/api/agents/${a.id}/vm/tools/rebuild`)).json().run.conversationId).toBe(dm)
  })

  it('409s are not recorded: no_previous_generation, internet_never, proxy_unavailable; run_active while a run is going; 404', async () => {
    const a = await makeAgent()
    let res = await inject('POST', `/api/agents/${a.id}/vm/tools/rollback`)
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ reason: 'no_previous_generation' })
    stored(a.id).vm.packages = ['jq']
    stored(a.id).internetPolicy = 'never'
    res = await inject('POST', `/api/agents/${a.id}/vm/tools/rebuild`)
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ statusCode: 409, reason: 'internet_never', message: 'Set internet to Ask or Always to install packages.' })
    stored(a.id).internetPolicy = 'ask'
    egressOk = false
    res = await inject('POST', `/api/agents/${a.id}/vm/tools/rebuild`)
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ reason: 'proxy_unavailable', message: expect.stringMatching(/internet proxy/) })
    egressOk = true
    stored(a.id).vm.packages = []
    expect(app.vmRuns.list(a.id, {}).runs).toEqual([])
    expect(store.chatMessages.some((m) => m.kind === 'run')).toBe(false)

    const r = await startFor(a)
    await until(() => runner.pending.length === 1)
    res = await inject('POST', `/api/agents/${a.id}/vm/tools/rebuild`)
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ reason: 'run_active', message: "Wait for the bot's run to finish first." })
    runner.pending[0]!.end()
    await app.vmRuns.wait(r.id)
    expect((await rebuildEnded(a.id)).status).toBe('succeeded')
    expect((await inject('POST', '/api/agents/nope/vm/tools/rebuild')).statusCode).toBe(404)
  })

  it('a failed build → 202, then the record ends failed build_failed (the current tools kept)', async () => {
    await app.close()
    await build({ failBuild: true })
    const a = await makeAgent()
    const run = await rebuildEnded(a.id)
    expect(run).toMatchObject({
      kind: 'tool_build', status: 'failed', reason: 'build_failed',
      error: 'The build failed, so Analyst keeps its current tools (version 0). Nothing else changed.',
    })
    expect(app.vmRuns.list(a.id, {}).runs).toHaveLength(1)
    expect((await inject('GET', `/api/runs/${run.id}/output?stream=stderr`)).body).toMatch(/Unable to locate package nope/)
    expect(stored(a.id).vm.image.generation).toBe(0)
    const card = store.chatMessages.find((m) => m.scriptRunId === run.id)!
    expect(card.content).toBe('Tool build (failed)')
    expect(card.scriptRun).toMatchObject({ status: 'failed', reason: 'build_failed', error: run.error })
  })
})

describe('RunService.toolBuild', () => {
  it('one build at a time per bot; a 4xx from the build leaves no record', async () => {
    const a = await makeAgent()
    let finish!: () => void
    const first = app.vmRuns.toolBuild(a.id, 'rebuild', () => new Promise((r) => { finish = () => r({ generation: 3, log: 'ok\n' }) }))
    // BE-P2-22: build_active (was run_active in BE-P2-17).
    await expect(app.vmRuns.toolBuild(a.id, 'rollback', async () => ({ generation: 2, log: '' }))).rejects.toMatchObject({ statusCode: 409, reason: 'build_active', message: "Wait for the bot's tools to finish building first." })
    finish()
    expect(await first).toMatchObject({ status: 'succeeded', stdoutTail: 'ok\n', outputBytes: 3, outputTruncated: false })
    const e = Object.assign(new Error('nope'), { statusCode: 409, reason: 'no_previous_generation' })
    await expect(app.vmRuns.toolBuild(a.id, 'rollback', async () => { throw e })).rejects.toBe(e)
    expect(app.vmRuns.list(a.id, {}).runs).toHaveLength(1)
    await expect(app.vmRuns.toolBuild('ag_nope', 'rebuild', async () => ({ generation: 1, log: '' }))).rejects.toMatchObject({ statusCode: 404 })
  })
})

describe('BE-P2-22: runs wait for a tool build', () => {
  /** Hold the fake engine's next builds until release(). */
  function gate(): () => void {
    let release!: () => void
    buildGate = new Promise<void>((r) => (release = r))
    return () => {
      buildGate = null
      release()
    }
  }
  /** The bot's tool generation each run saw when the runner got it. */
  function generationsAtRun(): number[] {
    const seen: number[] = []
    const run = runner.run.bind(runner)
    runner.run = (req) => {
      seen.push(stored(req.agentId).vm.image.generation)
      return run(req)
    }
    return seen
  }
  const card = (runId: string) => store.chatMessages.find((m) => m.kind === 'run' && m.scriptRunId === runId)

  it('a run started during a rebuild is queued "after tool build", then starts on the new generation', async () => {
    const a = await makeAgent()
    const seen = generationsAtRun()
    const release = gate()
    const rebuild = inject('POST', `/api/agents/${a.id}/vm/tools/rebuild`)
    await until(() => app.vmRuns.buildActive(a.id))
    const r = await startFor(a)
    expect(r).toMatchObject({ status: 'queued', queuedReason: 'tool_build', queuePosition: 1 })
    expect(app.vmRuns.get(r.id)).toMatchObject({ status: 'queued', queuedReason: 'tool_build', queuePosition: 1 })
    expect(card(r.id)?.scriptRun).toMatchObject({ status: 'queued', queuedReason: 'tool_build', queuePosition: 1 })
    expect(app.vmRuns.list(a.id, {}).runs[0]).toMatchObject({ id: r.id, queuedReason: 'tool_build', queuePosition: 1 })
    // Another bot's run isn't held by it.
    const b = await makeAgent('Other')
    const rb = await startFor(b)
    await until(() => runner.pending.length === 1)
    expect(runner.pending[0]!.req.agentId).toBe(b.id)
    expect(app.vmRuns.get(rb.id)!.queuedReason).toBeUndefined()
    runner.pending[0]!.end()
    await app.vmRuns.wait(rb.id)
    await new Promise((res) => setTimeout(res, 20))
    expect(app.vmRuns.get(r.id)!.status).toBe('queued')
    expect(app.vmRuns.get(r.id)).toMatchObject({ queuedReason: 'tool_build', queuePosition: 1 })
    // BE-P2-21: the queued run's card names the build it waits for.
    const buildId = ((await rebuild).json() as { run: ScriptRun }).run.id
    expect(card(r.id)?.scriptRun?.afterBuild).toEqual({ runId: buildId, generation: 1 })
    release()
    const done = await app.vmRuns.wait(buildId)
    expect(done).toMatchObject({ kind: 'tool_build', status: 'succeeded' })
    await until(() => runner.pending.length === 1)
    expect(seen).toEqual([0, 1])
    const started = app.vmRuns.get(r.id)!
    expect(started.status).toBe('running')
    expect(started.queuedReason).toBeUndefined()
    expect(started.queuePosition).toBeUndefined()
    expect(card(r.id)?.scriptRun?.queuedReason).toBeUndefined()
    // The build's record came first.
    expect(Date.parse(done.endedAt!)).toBeLessThanOrEqual(Date.parse(started.startedAt!))
    runner.pending[0]!.end()
    expect((await app.vmRuns.wait(r.id)).status).toBe('succeeded')
  })

  it('a failed build: the waiting run starts on the previous generation', async () => {
    await app.close()
    await build({ failBuild: true })
    const a = await makeAgent()
    const seen = generationsAtRun()
    const release = gate()
    const rebuild = inject('POST', `/api/agents/${a.id}/vm/tools/rebuild`)
    await until(() => app.vmRuns.buildActive(a.id))
    const r = await startFor(a)
    expect(r.queuedReason).toBe('tool_build')
    release()
    expect((await app.vmRuns.wait((await rebuild).json().run.id)).status).toBe('failed')
    await until(() => runner.pending.length === 1)
    expect(seen).toEqual([0])
    expect(stored(a.id).vm.image.generation).toBe(0)
    expect(app.vmRuns.buildActive(a.id)).toBe(false)
    runner.pending[0]!.end()
    expect((await app.vmRuns.wait(r.id)).status).toBe('succeeded')
  })

  it('rollback, rebuild and reset during a build → 409 build_active (nothing recorded, queued runs kept); run_active after', async () => {
    const a = await makeAgent()
    expect((await rebuildEnded(a.id)).status).toBe('succeeded')
    const release = gate()
    const rebuild = inject('POST', `/api/agents/${a.id}/vm/tools/rebuild`)
    await until(() => app.vmRuns.buildActive(a.id))
    const r = await startFor(a)
    // BE-P2-21: VM Stop too.
    for (const [url, body] of [['vm/tools/rollback', undefined], ['vm/tools/rebuild', undefined], ['vm/reset', { confirm: true }], ['vm/stop', undefined]] as const) {
      const res = await inject('POST', `/api/agents/${a.id}/${url}`, body)
      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ reason: 'build_active', message: "Wait for the bot's tools to finish building first." })
    }
    expect(app.vmRuns.get(r.id)!.status).toBe('queued')
    expect(app.vmRuns.list(a.id, {}).runs.filter((x) => x.kind === 'tool_build')).toHaveLength(2)
    release()
    expect((await app.vmRuns.wait((await rebuild).json().run.id)).status).toBe('succeeded')
    expect(stored(a.id).vm.image.generation).toBe(2)
    await until(() => runner.pending.length === 1)
    // Runs still refuse them with run_active.
    for (const [url, body] of [['vm/tools/rollback', undefined], ['vm/tools/rebuild', undefined]] as const) {
      const res = await inject('POST', `/api/agents/${a.id}/${url}`, body)
      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ reason: 'run_active' })
    }
    runner.pending[0]!.end()
    await app.vmRuns.wait(r.id)
    expect((await inject('POST', `/api/agents/${a.id}/vm/tools/rollback`)).statusCode).toBe(200)
  })

  it('stop of a run waiting for a build; VM stop ends it too', async () => {
    const a = await makeAgent()
    const release = gate()
    const rebuild = inject('POST', `/api/agents/${a.id}/vm/tools/rebuild`)
    await until(() => app.vmRuns.buildActive(a.id))
    const r1 = await startFor(a)
    const r2 = await startFor(a)
    expect(app.vmRuns.get(r2.id)).toMatchObject({ queuedReason: 'tool_build', queuePosition: 2 })
    expect((await inject('POST', `/api/runs/${r1.id}/stop`)).statusCode).toBe(200)
    const stopped = await app.vmRuns.wait(r1.id)
    expect(stopped.status).toBe('stopped')
    expect(stopped.queuedReason).toBeUndefined()
    await until(() => app.vmRuns.get(r2.id)!.queuePosition === 1)
    release()
    expect((await app.vmRuns.wait((await rebuild).json().run.id)).status).toBe('succeeded')
    await until(() => runner.pending.length === 1)
    expect(runner.pending[0]!.req.runId).toBe(r2.id)
    runner.pending[0]!.end()
    await app.vmRuns.wait(r2.id)
  })
})

describe('BE-P2-21: live tool builds (one Stop route)', () => {
  function gate(): () => void {
    let release!: () => void
    buildGate = new Promise<void>((r) => (release = r))
    return () => {
      buildGate = null
      release()
    }
  }
  const card = (runId: string): ChatMessage | undefined => store.chatMessages.find((m) => m.kind === 'run' && m.scriptRunId === runId)
  const vmInfo = async (id: string) => (await inject('GET', `/api/agents/${id}/vm`)).json() as VmInfo
  const toolsInfo = async (id: string) => (await inject('GET', `/api/agents/${id}/vm/tools`)).json() as VmToolsInfo
  type Published = Parameters<typeof app.liveEvents.publish>[0]

  it('Stop during a rebuild (the VM tab\'s activeBuild.runId): stopped, tools kept, vm.updated clears activeBuild; 2nd Stop → 409 not_active', async () => {
    const a = await makeAgent()
    const seen: Published[] = []
    const publish = app.liveEvents.publish.bind(app.liveEvents)
    vi.spyOn(app.liveEvents, 'publish').mockImplementation((e) => (seen.push(e), publish(e)))
    const release = gate()
    const res = await inject('POST', `/api/agents/${a.id}/vm/tools/rebuild`)
    expect(res.statusCode).toBe(202)
    const id = (res.json() as { run: ScriptRun }).run.id
    await until(() => app.vmRuns.get(id)?.build?.progress?.step === 1)
    expect(app.vmRuns.get(id)).toMatchObject({ status: 'running', build: { progress: { step: 1, steps: 2 } } })
    const vm = await vmInfo(a.id)
    expect(vm.activeBuild).toMatchObject({ runId: id, status: 'running', internet: 'off', hosts: [], build: { generation: 1, fromGeneration: 0, via: 'rebuild' } })
    expect((await toolsInfo(a.id)).activeBuild?.runId).toBe(id)
    await until(() => seen.some((e) => e.type === 'vm.updated' && e.agentId === a.id && e.vm.activeBuild?.runId === id))
    // VM Stop and Reset are refused during the build.
    for (const [url, body] of [['vm/stop', undefined], ['vm/reset', { confirm: true }]] as const) {
      const r = await inject('POST', `/api/agents/${a.id}/${url}`, body)
      expect(r.statusCode).toBe(409)
      expect(r.json()).toMatchObject({ statusCode: 409, reason: 'build_active', message: "Wait for the bot's tools to finish building first." })
    }
    const mark = seen.length
    const stop = await inject('POST', `/api/runs/${vm.activeBuild!.runId}/stop`)
    expect(stop.statusCode).toBe(200)
    expect(stop.json()).toMatchObject({ id, status: 'stopped', reason: 'build_stopped', error: 'Stopped. Analyst keeps its current tools (version 0).' })
    expect(stored(a.id).vm.image.generation).toBe(0)
    expect(engine.images.has(`localhost/ac-bot-${stored(a.id).slug}:1`)).toBe(false)
    expect(card(id)!.content).toBe('Tool build (stopped)')
    expect(card(id)!.scriptRun).toMatchObject({ status: 'stopped', reason: 'build_stopped' })
    expect(seen.slice(mark).some((e) => e.type === 'run.updated' && e.run.id === id && e.run.status === 'stopped')).toBe(true)
    await until(() => seen.slice(mark).some((e) => e.type === 'vm.updated' && e.agentId === a.id && !e.vm.activeBuild))
    expect((await vmInfo(a.id)).activeBuild).toBeUndefined()
    expect((await toolsInfo(a.id)).activeBuild).toBeUndefined()
    const again = await inject('POST', `/api/runs/${id}/stop`)
    expect(again.statusCode).toBe(409)
    expect(again.json()).toMatchObject({ reason: 'not_active' })
    release()
    // VM Stop works again.
    expect((await inject('POST', `/api/agents/${a.id}/vm/stop`)).statusCode).toBe(200)
  })

  it('vm_install under Always: a recorded online build queued behind the bot\'s run (slot), then built through the proxy', async () => {
    const a = await makeAgent()
    stored(a.id).internetPolicy = 'always'
    hostLog = [{ host: 'deb.debian.org', count: 3, blocked: false }]
    const dm = ensureDm(store, a.id).id
    const r1 = await startFor(a)
    await until(() => runner.pending.length === 1)
    const host = vmToolHost(store)!
    const res = await host.vmInstall(a.id, ['jq', 'jq'], { conversationId: dm, context: { kind: 'dm' }, agentRunId: 'ar_1' })
    expect('run' in res).toBe(true)
    const b = (res as { run: ScriptRun }).run
    expect(b).toMatchObject({
      kind: 'tool_build', status: 'queued', queuedReason: 'slot', queuePosition: 1, network: 'on', argv: ['vm_install', 'jq'], conversationId: dm,
      permissions: [{ type: 'internet', decision: 'always', source: 'policy' }],
      build: { via: 'vm_install', startedBy: 'bot', packages: ['jq'], added: ['jq'], generation: 1, fromGeneration: 0 },
    })
    expect((await vmInfo(a.id)).activeBuild).toMatchObject({ runId: b.id, status: 'queued', internet: 'always' })
    // A user Rebuild meanwhile: build_active (checked before run_active).
    const rb = await inject('POST', `/api/agents/${a.id}/vm/tools/rebuild`)
    expect(rb.statusCode).toBe(409)
    expect(rb.json()).toMatchObject({ reason: 'build_active' })
    // A second vm_install: build_active too.
    await expect(host.vmInstall(a.id, ['curl'], { conversationId: dm, context: { kind: 'dm' } })).rejects.toMatchObject({ statusCode: 409, reason: 'build_active' })
    runner.pending[0]!.end()
    await app.vmRuns.wait(r1.id)
    const done = await app.vmRuns.wait(b.id)
    expect(done).toMatchObject({ status: 'succeeded', exitCode: 0, build: { generation: 1 }, hostsContacted: [{ host: 'deb.debian.org', count: 3, blocked: false }] })
    expect(stored(a.id).vm).toMatchObject({ packages: ['jq'], image: { generation: 1 } })
    expect(card(b.id)!.content).toBe("Built Analyst's tools (version 1)")
    expect(card(b.id)!.scriptRun).toMatchObject({ internet: 'always', network: 'on', hostsContacted: [{ host: 'deb.debian.org' }] })
    const out = (await inject('GET', `/api/runs/${b.id}/output?stream=stdout`)).body
    expect(out).toContain('Step 1 of 3: apt-get update')
    expect(out).toContain('Step 3 of 3: save')
    // The proxy credential never reaches the log.
    expect(out).not.toContain('s3cr3t-cred')
    // Nothing new: no build.
    expect(await host.vmInstall(a.id, ['jq'], { conversationId: dm, context: { kind: 'dm' } })).toEqual({ generation: 1, log: 'Already installed.' })
    expect(app.vmRuns.list(a.id, {}).runs.filter((x) => x.kind === 'tool_build')).toHaveLength(1)
  })

  it('vm_install under Never: 409 internet_never and nothing recorded', async () => {
    const a = await makeAgent()
    stored(a.id).internetPolicy = 'never'
    const dm = ensureDm(store, a.id).id
    await expect(vmToolHost(store)!.vmInstall(a.id, ['jq'], { conversationId: dm, context: { kind: 'dm' } })).rejects.toMatchObject({ statusCode: 409, reason: 'internet_never' })
    expect(app.vmRuns.list(a.id, {}).runs).toEqual([])
  })

  it('an online Rebuild (packages) goes through the proxy under its own one-build grant', async () => {
    const a = await makeAgent()
    stored(a.id).vm.packages = ['jq']
    const res = await inject('POST', `/api/agents/${a.id}/vm/tools/rebuild`)
    expect(res.statusCode).toBe(202)
    expect(res.json().run).toMatchObject({ network: 'on', permissions: [{ type: 'internet', decision: 'allow_once', source: 'rebuild' }], build: { packages: ['jq'], added: [] } })
    const done = await app.vmRuns.wait(res.json().run.id)
    expect(done).toMatchObject({ status: 'succeeded', build: { generation: 1 } })
    expect(card(done.id)!.scriptRun!.internet).toBe('once')
    expect(engine.calls.some((c) => c[0] === 'build')).toBe(false)
  })
})

describe('undo routes', () => {
  it('404 unknown run; 400 bad bodies; 410 when the run has no snapshot', async () => {
    const a = await makeAgent()
    expect((await inject('GET', '/api/runs/run_nope/undo/preview')).statusCode).toBe(404)
    expect((await inject('POST', '/api/runs/run_nope/undo', {})).statusCode).toBe(404)
    const r = await startFor(a)
    await until(() => runner.pending.length === 1)
    runner.pending[0]!.end()
    await app.vmRuns.wait(r.id)
    for (const [body, msg] of [[[], /JSON object/], [{ force: 'yes' }, /"force" must be true or false/], [{ hard: true }, /"hard" isn't an undo option/]] as const) {
      const res = await inject('POST', `/api/runs/${r.id}/undo`, body)
      expect(res.statusCode).toBe(400)
      expect(res.json().message).toMatch(msg)
    }
    const prev = await inject('GET', `/api/runs/${r.id}/undo/preview`)
    expect(prev.statusCode).toBe(410)
    expect(prev.json()).toMatchObject({ reason: 'expired' })
    const post = await inject('POST', `/api/runs/${r.id}/undo`)
    expect(post.statusCode).toBe(410)
    expect((await inject('POST', `/api/runs/${r.id}/undo`, { force: true })).statusCode).toBe(410)
  })

  it('409 run_active on preview and undo while the bot has a run', async () => {
    const a = await makeAgent()
    const r1 = await startFor(a)
    await until(() => runner.pending.length === 1)
    runner.pending[0]!.end()
    await app.vmRuns.wait(r1.id)
    const r2 = await startFor(a)
    await until(() => runner.pending.length === 1)
    for (const res of [await inject('GET', `/api/runs/${r1.id}/undo/preview`), await inject('POST', `/api/runs/${r1.id}/undo`, { force: true })]) {
      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ reason: 'run_active', message: UNDO_RUN_ACTIVE_TEXT })
    }
    runner.pending[0]!.end()
    await app.vmRuns.wait(r2.id)
  })

  it('a deleted bot\'s run → 404', async () => {
    const a = await makeAgent()
    const r = await startFor(a)
    await until(() => runner.pending.length === 1)
    runner.pending[0]!.end()
    await app.vmRuns.wait(r.id)
    store.agents = store.agents.filter((x) => x.id !== a.id)
    const res = await inject('GET', `/api/runs/${r.id}/undo/preview`)
    expect([404, 410]).toContain(res.statusCode)
  })
})

it('rollbackLog names the generation and packages', () => {
  const vm = defaultAgentVm()
  vm.image.generation = 2
  vm.packages = ['ffmpeg', 'jq']
  expect(rollbackLog(vm)).toBe('Went back to generation 2. System packages: ffmpeg, jq.\n')
})
