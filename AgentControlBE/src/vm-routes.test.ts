import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from './app.js'
import { createBotEnvService } from './bot-env.js'
import { botMounts, rollbackLog, storeSaveVm } from './bot-env-routes.js'
import { fakeEngine } from './bot-env.fake.js'
import { ensureDm } from './conversations.js'
import { botRoot } from './files.js'
import { createStore } from './store.js'
import { fakeRunner, type FakeRunner } from './run-service.fake.js'
import type { Agent, ScriptRun, VmHostInfo } from './shared/types.js'
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

async function build(opts: { failBuild?: boolean } = {}): Promise<void> {
  engine = fakeEngine(opts)
  runner = fakeRunner()
  const vmHost: VmHostService = { hostInfo: async () => host, ensureMachine: async () => host, grow: async () => host }
  const botEnv = createBotEnvService({
    exec: engine.exec,
    engine: async () => ({ cli: 'podman', globalArgs: [] }),
    mounts: (a) => botMounts(store, a),
    saveVm: storeSaveVm(store),
    activeRuns: (id) => app.vmRunner.activeRuns(id),
  })
  app = buildApp(store, { vmHost, botEnv, runtimeProbe: probe, vmRunner: runner, vmFreeBytes: () => null })
  await app.ready()
}

beforeEach(async () => {
  vi.stubEnv('AGENTCONTROL_SECRET', 'be17-test-secret')
  vi.stubEnv('AGENTCONTROL_AUTH_TOKEN', '')
  dir = mkdtempSync(join(tmpdir(), 'agentcontrol-be17-'))
  store = createStore(join(dir, 'store.json'))
  refreshes = 0
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
  it('rebuild → a tool_build ScriptRun (no chat card), listed and with its log; rollback → generation 0', async () => {
    const a = await makeAgent()
    const res = await inject('POST', `/api/agents/${a.id}/vm/tools/rebuild`)
    expect(res.statusCode).toBe(200)
    const run = res.json() as ScriptRun
    expect(run).toMatchObject({ agentId: a.id, kind: 'tool_build', status: 'succeeded', exitCode: 0, argv: ['rebuild'], why: "Rebuild the bot's tools" })
    expect(run.conversationId).toBe('')
    expect(stored(a.id).vm.image.generation).toBe(1)
    expect(engine.images.has(`localhost/ac-bot-${stored(a.id).slug}:1`)).toBe(true)
    expect(store.chatMessages.some((m) => m.scriptRunId === run.id)).toBe(false)
    expect((await inject('GET', `/api/runs/${run.id}`)).json()).toMatchObject({ id: run.id, kind: 'tool_build' })
    const list = (await inject('GET', `/api/agents/${a.id}/script-runs`)).json() as { runs: ScriptRun[] }
    expect(list.runs.map((r) => r.id)).toContain(run.id)
    const out = await inject('GET', `/api/runs/${run.id}/output?stream=stdout`)
    expect(out.statusCode).toBe(200)
    expect(out.body).toContain('COMMIT')
    expect(Buffer.byteLength(out.body)).toBe(run.outputBytes)

    const back = await inject('POST', `/api/agents/${a.id}/vm/tools/rollback`)
    expect(back.statusCode).toBe(200)
    expect(back.json()).toMatchObject({ kind: 'tool_build', status: 'succeeded', argv: ['rollback'] })
    expect(back.json().stdoutTail).toBe(rollbackLog(stored(a.id).vm))
    expect(stored(a.id).vm.image.generation).toBe(0)
    expect(back.json().stdoutTail).toMatch(/shared base image \(generation 0\)\. System packages: none\./)
  })

  it('the bot\'s DM is the conversation when it has one', async () => {
    const a = await makeAgent()
    const dm = ensureDm(store, a.id).id
    expect((await inject('POST', `/api/agents/${a.id}/vm/tools/rebuild`)).json().conversationId).toBe(dm)
  })

  it('409s: no_previous_generation and internet_unavailable are not recorded; run_active while a run is going', async () => {
    const a = await makeAgent()
    let res = await inject('POST', `/api/agents/${a.id}/vm/tools/rollback`)
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ reason: 'no_previous_generation' })
    stored(a.id).vm.packages = ['jq']
    res = await inject('POST', `/api/agents/${a.id}/vm/tools/rebuild`)
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ reason: 'internet_unavailable', message: expect.stringMatching(/internet/) })
    stored(a.id).vm.packages = []
    expect(app.vmRuns.list(a.id, {}).runs).toEqual([])

    const r = await startFor(a)
    await until(() => runner.pending.length === 1)
    res = await inject('POST', `/api/agents/${a.id}/vm/tools/rebuild`)
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ reason: 'run_active', message: "Wait for the bot's run to finish first." })
    runner.pending[0]!.end()
    await app.vmRuns.wait(r.id)
    expect((await inject('POST', `/api/agents/${a.id}/vm/tools/rebuild`)).statusCode).toBe(200)
    expect((await inject('POST', '/api/agents/nope/vm/tools/rebuild')).statusCode).toBe(404)
  })

  it('a failed build → 502 build_failed, recorded as a failed tool_build run', async () => {
    await app.close()
    await build({ failBuild: true })
    const a = await makeAgent()
    const res = await inject('POST', `/api/agents/${a.id}/vm/tools/rebuild`)
    expect(res.statusCode).toBe(502)
    // 5xx bodies carry no reason (contract); the message has the build's last line.
    expect(res.json().message).toMatch(/Unable to locate package nope/)
    const runs = app.vmRuns.list(a.id, {}).runs
    expect(runs).toHaveLength(1)
    const full = (await inject('GET', `/api/runs/${runs[0]!.id}`)).json()
    expect(full).toMatchObject({ kind: 'tool_build', status: 'failed', reason: 'build_failed', error: expect.stringMatching(/Unable to locate/) })
    expect((await inject('GET', `/api/runs/${runs[0]!.id}/output?stream=stdout`)).body).toMatch(/Unable to locate package nope/)
    expect(stored(a.id).vm.image.generation).toBe(0)
  })
})

describe('RunService.toolBuild', () => {
  it('one build at a time per bot; a 4xx from the build leaves no record', async () => {
    const a = await makeAgent()
    let finish!: () => void
    const first = app.vmRuns.toolBuild(a.id, 'rebuild', () => new Promise((r) => { finish = () => r({ generation: 3, log: 'ok\n' }) }))
    await expect(app.vmRuns.toolBuild(a.id, 'rollback', async () => ({ generation: 2, log: '' }))).rejects.toMatchObject({ statusCode: 409, reason: 'run_active' })
    finish()
    expect(await first).toMatchObject({ status: 'succeeded', stdoutTail: 'ok\n', outputBytes: 3, outputTruncated: false })
    const e = Object.assign(new Error('nope'), { statusCode: 409, reason: 'no_previous_generation' })
    await expect(app.vmRuns.toolBuild(a.id, 'rollback', async () => { throw e })).rejects.toBe(e)
    expect(app.vmRuns.list(a.id, {}).runs).toHaveLength(1)
    await expect(app.vmRuns.toolBuild('ag_nope', 'rebuild', async () => ({ generation: 1, log: '' }))).rejects.toMatchObject({ statusCode: 404 })
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
