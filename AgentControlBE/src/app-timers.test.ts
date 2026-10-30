import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from './app.js'
import { createBotEnvService, type BotEnvService } from './bot-env.js'
import { botMounts, storeSaveVm } from './bot-env-routes.js'
import { fakeEngine } from './bot-env.fake.js'
import { BUDGET_SWEEP_MS } from './snapshot-budget.js'
import { PERSONAL_MEASURE_MS } from './personal-usage.js'
import { createStore } from './store.js'
import type { VmHostInfo } from './shared/types.js'
import type { VmHostService } from './vm-host.js'
import type { RuntimeProbe } from './runtime-probe.js'

/** BE-P2-10 follow-up: the eviction sweep and the tools refresh always start with the server. */

const host: VmHostInfo = {
  engine: 'podman', version: '5.4.0', provider: 'native', os: 'linux', machine: null,
  storage: { driver: 'overlay', backend: 'local', volumeState: 'ok' }, concurrency: 2, setupSteps: [],
}
const probe: RuntimeProbe = {
  current: () => null,
  refresh: async () => { throw new Error('no probe in this test') },
  ensureFresh: async () => { throw new Error('no probe in this test') },
  restore: async () => null,
  startTimer: () => () => {},
}

let dir = ''
let store: ReturnType<typeof createStore>
let botEnv: BotEnvService
beforeEach(() => {
  vi.stubEnv('AGENTCONTROL_SECRET', 'be10-timers-secret')
  vi.stubEnv('AGENTCONTROL_AUTH_TOKEN', '')
  dir = mkdtempSync(join(tmpdir(), 'agentcontrol-be10-timers-'))
  store = createStore(join(dir, 'store.json'))
  botEnv = createBotEnvService({
    exec: fakeEngine().exec,
    engine: async () => ({ cli: 'podman', globalArgs: [] }),
    mounts: (a) => botMounts(store, a),
    saveVm: storeSaveVm(store),
    activeRuns: () => 0,
  })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

const vmHost: VmHostService = { hostInfo: async () => host, ensureMachine: async () => host, grow: async () => host }
const build = (vmTimers?: { budgetSweepMs?: number; personalMeasureMs?: number }) =>
  buildApp(store, { vmHost, botEnv, runtimeProbe: probe, ...(vmTimers ? { vmTimers } : {}) })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('BE-P2-10: the eviction sweep and the tools refresh', () => {
  it('start on ready without probeOnStart, and stop on close', async () => {
    const app = build({ budgetSweepMs: 10, personalMeasureMs: 10 })
    const enforce = vi.spyOn(app.vmSnapshotBudget, 'enforce')
    const measure = vi.spyOn(botEnv as Required<BotEnvService>, 'measure')
    const res = await app.inject({ method: 'POST', url: '/api/agents', payload: { name: 'Analyst', endpointId: 'ep_local_llama', modelId: 'llama-3-8b' } })
    expect(res.statusCode).toBe(201)
    await sleep(120)
    expect(enforce.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(measure).toHaveBeenCalled()
    expect(measure.mock.calls[0]![0].name).toBe('Analyst')
    await app.close()
    const [e, m] = [enforce.mock.calls.length, measure.mock.calls.length]
    await sleep(80)
    expect(enforce.mock.calls.length).toBe(e)
    expect(measure.mock.calls.length).toBe(m)
  })

  it('default: both every 10 minutes; a second ready/close cycle doesn\'t double them', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const app = build()
    const enforce = vi.spyOn(app.vmSnapshotBudget, 'enforce')
    await app.ready()
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(2)
    vi.advanceTimersByTime(BUDGET_SWEEP_MS - 1)
    expect(enforce).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(enforce).toHaveBeenCalledTimes(1)
    expect(PERSONAL_MEASURE_MS).toBe(10 * 60 * 1000)
    await app.close()
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(3 * BUDGET_SWEEP_MS)
    expect(enforce).toHaveBeenCalledTimes(1)
  })

  it('a failing sweep is logged, not thrown, and the timer keeps going', async () => {
    const app = build({ budgetSweepMs: 10, personalMeasureMs: 60_000 })
    const enforce = vi.spyOn(app.vmSnapshotBudget, 'enforce').mockImplementation(() => { throw new Error('disk gone') })
    await app.ready()
    await sleep(60)
    expect(enforce.mock.calls.length).toBeGreaterThanOrEqual(2)
    await app.close()
  })
})
