import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from './app.js'
import { createBotEnvService } from './bot-env.js'
import { botMountAllowList, botMounts, BROWSER_NOT_YET, EGRESS_NOT_AVAILABLE, storeSaveVm } from './bot-env-routes.js'
import { fakeEngine } from './bot-env.fake.js'
import { checkBotMounts, KEEP_ID_NOTE } from './isolation.js'
import { botRoot } from './files.js'
import { createStore } from './store.js'
import type { Agent, VmHostInfo } from './shared/types.js'
import type { VmHostService } from './vm-host.js'
import type { RuntimeProbe, RuntimeProbeResult } from './runtime-probe.js'

/** BE-P2-4: /api/agents/:id/vm routes with a fake engine. */

const hostInfo = (engine: 'podman' | null = 'podman'): VmHostInfo => ({
  engine, version: engine ? '5.4.0' : null, provider: 'native', os: 'linux', machine: null,
  storage: { driver: 'overlay', backend: 'local', volumeState: 'ok' }, concurrency: 2,
  setupSteps: engine ? [] : [{ id: 'install', text: 'Install Podman', done: false }],
})

let dir = ''
let store: ReturnType<typeof createStore>
let app: ReturnType<typeof buildApp>
let engine: ReturnType<typeof fakeEngine>
let host: VmHostInfo
let runs = 0
let probeResult: RuntimeProbeResult | null = null
const fakeProbe: RuntimeProbe = { current: () => probeResult, refresh: async () => probeResult!, ensureFresh: async () => probeResult! }

beforeEach(() => {
  vi.stubEnv('AGENTCONTROL_SECRET', 'be4-test-secret')
  vi.stubEnv('AGENTCONTROL_AUTH_TOKEN', '')
  dir = mkdtempSync(join(tmpdir(), 'agentcontrol-be4-'))
  store = createStore(join(dir, 'store.json'))
  engine = fakeEngine()
  host = hostInfo()
  runs = 0
  probeResult = null
  const vmHost: VmHostService = { hostInfo: async () => host, ensureMachine: async () => host, grow: async () => host }
  const botEnv = createBotEnvService({
    exec: engine.exec,
    engine: async () => (host.engine ? { cli: 'podman', globalArgs: [] } : null),
    mounts: (a) => botMounts(store, a),
    saveVm: storeSaveVm(store),
    activeRuns: () => runs,
  })
  app = buildApp(store, { vmHost, botEnv, runtimeProbe: fakeProbe })
})
afterEach(async () => {
  await app.close()
  vi.unstubAllEnvs()
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

describe('GET/PATCH /api/agents/:id/vm', () => {
  it('GET: not_setup before start, then running; fixed limits, env, image, packages', async () => {
    const a = await makeAgent()
    const res = await inject('GET', `/api/agents/${a.id}/vm`)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      agentId: a.id, state: 'not_setup', host: { engine: 'podman', provider: 'native' },
      runtime: { effective: null, mode: 'inherit', globalMode: 'auto' }, internetPolicy: 'ask',
      permissions: { browser: false, browserState: 'absent' }, limits: { memoryMb: 4096, cpus: 2 },
      env: [], packages: [], image: { generation: 0, base: 'base' }, runs: [], runsHasMore: false,
      storage: { backend: 'local', driver: 'overlay' },
    })
    expect((await inject('GET', '/api/agents/nope/vm')).statusCode).toBe(404)
  })

  it('GET without an engine: not_setup with the next setup step', async () => {
    const a = await makeAgent()
    host = hostInfo(null)
    expect((await inject('GET', `/api/agents/${a.id}/vm`)).json()).toMatchObject({ state: 'not_setup', stateMessage: 'Install Podman', host: { engine: null } })
    const start = await inject('POST', `/api/agents/${a.id}/vm/start`)
    expect(start.statusCode).toBe(409)
    expect(start.json()).toMatchObject({ statusCode: 409, reason: 'engine_missing', message: expect.stringMatching(/Podman/) })
  })

  it('PATCH env, gvisor, internetPolicy and browser:false persist', async () => {
    const a = await makeAgent()
    const env = [{ name: 'API_BASE', value: 'https://example.test' }, { name: 'PATH_APPEND', value: '/bot/workspace/bin' }]
    const res = await inject('PATCH', `/api/agents/${a.id}/vm`, { env, gvisor: 'force_off', internetPolicy: 'never', permissions: { browser: false } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ env, internetPolicy: 'never', runtime: { mode: 'force_off', status: 'forced_off' } })
    const reloaded = createStore(join(dir, 'store.json')).agents.find((x) => x.id === a.id)!
    expect(reloaded.vm.env).toEqual(env)
    expect(reloaded.vm.gvisor).toBe('force_off')
    expect(reloaded.internetPolicy).toBe('never')
  })

  it('PATCH 400s: reserved names, browser:true (M1), egress, limits, unknown keys, bad values', async () => {
    const a = await makeAgent()
    const bad = async (body: unknown, msg: RegExp | string) => {
      const res = await inject('PATCH', `/api/agents/${a.id}/vm`, body)
      expect(res.statusCode).toBe(400)
      expect(res.json()).toMatchObject({ statusCode: 400 })
      expect(res.json()).not.toHaveProperty('reason')
      expect(res.json().message).toMatch(msg)
    }
    await bad({ env: [{ name: 'HTTP_PROXY', value: 'http://x' }] }, /"HTTP_PROXY" is reserved/)
    await bad({ env: [{ name: 'PATH', value: '/x' }] }, /PATH_APPEND/)
    await bad({ env: [{ name: 'AC_FOO', value: 'x' }] }, /AC_/)
    await bad({ permissions: { browser: true } }, BROWSER_NOT_YET)
    await bad({ egress: { allow: [] } }, EGRESS_NOT_AVAILABLE)
    await bad({ limits: { memoryMb: 8192 } }, /Limits are fixed/)
    await bad({ packages: ['jq'] }, /can't be changed here/)
    await bad({ gvisor: 'maybe' }, /gvisor/)
    await bad({ internetPolicy: 'sometimes' }, /internetPolicy/)
    await bad({ permissions: { camera: true } }, /permissions.camera/)
    await bad([], /JSON object/)
    expect(stored(a.id).vm.env).toEqual([])
  })
})

describe('start / stop / reset / tools', () => {
  it('start creates and runs the container; stop stops it', async () => {
    const a = await makeAgent()
    const res = await inject('POST', `/api/agents/${a.id}/vm/start`)
    expect(res.statusCode).toBe(200)
    expect(res.json().state).toBe('running')
    const c = engine.containers.get(`ac-bot-${stored(a.id).slug}`)!
    expect(c.argv.join(' ')).toContain(`source=${join(botRoot(store, stored(a.id)), 'workspace')},destination=/bot/workspace`)
    expect(c.argv.join(' ')).toContain('destination=/bot/shared,readonly')
    const stop = await inject('POST', `/api/agents/${a.id}/vm/stop`)
    expect(stop.json().state).toBe('stopped')
  })

  it('files_missing → 409 with reason', async () => {
    const a = await makeAgent()
    rmSync(botRoot(store, stored(a.id)), { recursive: true, force: true })
    expect((await inject('GET', `/api/agents/${a.id}/vm`)).json().state).toBe('files_missing')
    const res = await inject('POST', `/api/agents/${a.id}/vm/start`)
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ reason: 'files_missing' })
  })

  it('reset: needs confirm, 409 while a run is active, then wipes tools and keeps env', async () => {
    const a = await makeAgent()
    await inject('PATCH', `/api/agents/${a.id}/vm`, { env: [{ name: 'KEEP', value: '1' }] })
    await inject('POST', `/api/agents/${a.id}/vm/start`)
    expect((await inject('POST', `/api/agents/${a.id}/vm/reset`, {})).statusCode).toBe(400)
    expect((await inject('POST', `/api/agents/${a.id}/vm/reset`, { confirm: 'yes' })).statusCode).toBe(400)
    runs = 1
    const busy = await inject('POST', `/api/agents/${a.id}/vm/reset`, { confirm: true })
    expect(busy.statusCode).toBe(409)
    expect(busy.json()).toMatchObject({ reason: 'run_active' })
    runs = 0
    const res = await inject('POST', `/api/agents/${a.id}/vm/reset`, { confirm: true })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ state: 'stopped', env: [{ name: 'KEEP', value: '1' }], packages: [], image: { generation: 0 } })
    const slug = stored(a.id).slug
    expect(engine.calls.filter((x) => x[0] === 'volume' && x[1] === 'rm').map((x) => x[x.length - 1])).toEqual([`ac-tools-${slug}`, `ac-opt-${slug}`])
  })

  it('GET /vm/tools reports packages, image and canRollback', async () => {
    const a = await makeAgent()
    let res = await inject('GET', `/api/agents/${a.id}/vm/tools`)
    expect(res.json()).toEqual({ agentId: a.id, packages: [], image: { generation: 0, base: 'base' }, canRollback: false })
    store.agents = store.agents.map((x) => (x.id === a.id ? { ...x, vm: { ...x.vm, packages: ['jq'], image: { generation: 2, previous: 1, base: 'base' } } } : x))
    res = await inject('GET', `/api/agents/${a.id}/vm/tools`)
    expect(res.json()).toMatchObject({ packages: ['jq'], canRollback: true })
  })

  it('group members get the group shared folder mounted rw', async () => {
    const lead = await inject('POST', '/api/agents', { name: 'Primary', endpointId: 'ep_local_llama', modelId: 'llama-3-8b', isPrimary: true })
    const a = await makeAgent('Member')
    expect(lead.statusCode).toBe(201)
    const b = await makeAgent('Other')
    const g = await inject('POST', '/api/groups', { name: 'Team', memberAgentIds: [a.id, b.id] })
    expect(g.statusCode).toBe(201)
    const slug = (g.json() as { slug: string }).slug
    const mounts = botMounts(store, stored(a.id))
    expect(mounts).toContainEqual(expect.objectContaining({ target: `/bot/groups/${slug}`, readonly: false }))
    const lone = await makeAgent('Lone')
    expect(botMounts(store, stored(lone.id)).some((m) => m.target.startsWith('/bot/groups/'))).toBe(false)
  })
})

describe('BE-P2-5: mount allow-list and isolation note', () => {
  it('botMountAllowList: own folders and member groups only; botMounts passes its own guard', async () => {
    await inject('POST', '/api/agents', { name: 'Primary', endpointId: 'ep_local_llama', modelId: 'llama-3-8b', isPrimary: true })
    const a = await makeAgent('Member')
    const b = await makeAgent('Other')
    const lone = await makeAgent('Lone')
    const slug = ((await inject('POST', '/api/groups', { name: 'Team', memberAgentIds: [a.id, b.id] })).json() as { slug: string }).slug
    const allowA = botMountAllowList(store, stored(a.id))
    expect(Object.keys(allowA.groups)).toEqual([slug])
    expect(allowA.workspace).toBe(join(botRoot(store, stored(a.id)), 'workspace'))
    expect(allowA.botRoot).toBe(botRoot(store, stored(a.id)))
    expect(allowA.groupsRoot).toBeDefined()
    expect(botMountAllowList(store, stored(lone.id)).groups).toEqual({})
    const mountsA = botMounts(store, stored(a.id))
    expect(checkBotMounts(mountsA, allowA)).toEqual(mountsA)
    // A's mounts with B's allow-list (= B's container mounting A's paths) are refused.
    expect(() => checkBotMounts(mountsA, botMountAllowList(store, stored(b.id)))).toThrow(/isn't this bot's folder/)
    expect(() => checkBotMounts(botMounts(store, stored(a.id)), botMountAllowList(store, stored(lone.id)))).toThrow()
  })

  it('VmInfo.isolationNote: keep-id note on Podman until the probe picks idmap; bind failure appended; none on Docker', async () => {
    const a = await makeAgent()
    const note = async () => (await inject('GET', `/api/agents/${a.id}/vm`)).json().isolationNote as string | undefined
    expect(await note()).toBe(KEEP_ID_NOTE)
    const base = { runsc: { installed: false }, checks: [], compatible: false, snapshotDriver: null, checkedAt: '2026-10-28T15:00:00.000Z', versions: { engine: '5.4.2', runsc: null, image: 'abc' }, runscFlags: [] }
    probeResult = { ...base, uidMapping: null, standard: { runtime: 'crun', version: '1.21', limitsEnforced: true, limitsAccepted: true, uidMapping: 'idmap', checks: [{ id: 'bind_mount', status: 'pass' }] } } as RuntimeProbeResult
    expect(await note()).toBeUndefined()
    probeResult = { ...base, uidMapping: null, standard: { runtime: 'crun', version: '1.21', limitsEnforced: true, limitsAccepted: true, uidMapping: null, checks: [{ id: 'bind_mount', status: 'fail', message: "The bot can't use its folders: x" }] } } as RuntimeProbeResult
    expect(await note()).toBe(`${KEEP_ID_NOTE} The bot can't use its folders: x`)
    host = { ...hostInfo(), engine: 'docker' as never }
    expect(await note()).toBeUndefined()
  })
})

describe('BE-P2-8: runtime, limits and runs in VmInfo', () => {
  const probe = (over: Partial<RuntimeProbeResult> = {}): RuntimeProbeResult => ({
    runsc: { installed: true, version: '2024' },
    checks: [{ id: 'start', status: 'pass' }, { id: 'cgroup_limits', status: 'fail', message: "limits can't be enforced (memory.max reads \"max\")" }],
    compatible: false, uidMapping: null, snapshotDriver: null, checkedAt: '2026-10-27T18:00:00.000Z',
    versions: { engine: '5.4.2', runsc: '2024', image: 'abc' },
    standard: { runtime: 'crun', version: '1.21', limitsEnforced: false, limitsAccepted: true, checks: [{ id: 'cgroup_limits', status: 'fail', message: "limits can't be enforced (crun)" }] },
    runscFlags: ['--runtime-flag=ignore-cgroups', '--runtime-flag=network=none'],
    ...over,
  })

  it('before the probe: placeholder; after: resolved runtime with limitsEnforced and reason', async () => {
    const a = await makeAgent()
    expect((await inject('GET', `/api/agents/${a.id}/vm`)).json().runtime).toEqual({ effective: null, status: 'not_installed', mode: 'inherit', globalMode: 'auto', reason: "The runtime check hasn't run yet." })
    probeResult = probe()
    expect((await inject('GET', `/api/agents/${a.id}/vm`)).json().runtime).toEqual({
      effective: 'crun', status: 'incompatible_fallback', reason: "limits can't be enforced", checkedAt: '2026-10-27T18:00:00.000Z',
      mode: 'inherit', globalMode: 'auto', limitsEnforced: false, limitsReason: "limits can't be enforced (crun)",
    })
    await inject('PATCH', `/api/agents/${a.id}/vm`, { gvisor: 'force_on' })
    const forced = (await inject('GET', `/api/agents/${a.id}/vm`)).json().runtime
    expect(forced).toMatchObject({ effective: null, status: 'required_unavailable' })
    expect(forced.reason).toBe("gVisor is required for Analyst but isn't available (limits can't be enforced). Turn off Force on or fix gVisor.")
    expect(forced.flags).toBeUndefined()
  })

  it('GET /api/vm/probe returns the probe result; a compatible runsc is active with limits enforced', async () => {
    probeResult = probe({ compatible: true, checks: [{ id: 'start', status: 'pass' }], runscFlags: [] })
    expect((await inject('GET', '/api/vm/probe')).json().runsc.installed).toBe(true)
    const noHeader = await app.inject({ method: 'POST', url: '/api/vm/probe' })
    expect(noHeader.statusCode).toBe(403)
    expect(noHeader.json()).toMatchObject({ reason: 'confirm_required' })
    const ok = await app.inject({ method: 'POST', url: '/api/vm/probe', headers: { 'x-agentcontrol-confirm': '1' } })
    expect(ok.statusCode).toBe(200)
    const a = await makeAgent()
    expect((await inject('GET', `/api/agents/${a.id}/vm`)).json().runtime).toMatchObject({ effective: 'runsc', status: 'active', limitsEnforced: true })
  })

  it('stop and reset stop the bot\'s runs first', async () => {
    const a = await makeAgent()
    const spy = vi.spyOn(app.vmRunner, 'stopRuns')
    await inject('POST', `/api/agents/${a.id}/vm/start`)
    await inject('POST', `/api/agents/${a.id}/vm/stop`)
    await inject('POST', `/api/agents/${a.id}/vm/reset`, { confirm: true })
    expect(spy).toHaveBeenCalledTimes(2)
    expect(spy).toHaveBeenCalledWith(stored(a.id).id)
  })
})
