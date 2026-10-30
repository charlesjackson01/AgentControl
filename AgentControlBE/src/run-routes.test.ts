import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from './app.js'
import { createBotEnvService } from './bot-env.js'
import { botMounts, storeSaveVm } from './bot-env-routes.js'
import { fakeEngine } from './bot-env.fake.js'
import { ensureDm } from './conversations.js'
import { createStore } from './store.js'
import { fakeRunner, until, type FakeRunner } from './run-service.fake.js'
import type { Agent, VmHostInfo, VmInfo } from './shared/types.js'
import type { VmHostService } from './vm-host.js'
import type { RuntimeProbe } from './runtime-probe.js'

/** BE-P2-12: run routes, VmInfo.runs and GET /api/events through buildApp with a fake runner. */

const GB = 1024 ** 3
let dir = ''
// Every temp dir this file made. A late run-record write can recreate one
// after afterEach removed it, so afterAll removes them all again.
const madeDirs = new Set<string>()
let store: ReturnType<typeof createStore>
let app: ReturnType<typeof buildApp>
let runner: FakeRunner
let host: VmHostInfo
let free: number | null
const probe: RuntimeProbe = {
  current: () => null,
  refresh: async () => null as never,
  ensureFresh: async () => null as never,
  restore: async () => null,
  startTimer: () => () => {},
}

function build(): ReturnType<typeof buildApp> {
  const engine = fakeEngine()
  const vmHost: VmHostService = { hostInfo: async () => host, ensureMachine: async () => host, grow: async () => host }
  const botEnv = createBotEnvService({
    exec: engine.exec,
    engine: async () => ({ cli: 'podman', globalArgs: [] }),
    mounts: (a) => botMounts(store, a),
    saveVm: storeSaveVm(store),
    activeRuns: (id) => app.vmRunner.activeRuns(id),
  })
  return buildApp(store, { vmHost, botEnv, runtimeProbe: probe, vmRunner: runner, vmFreeBytes: () => free, liveTimers: { heartbeatMs: 50, outputFlushMs: 10 } })
}

beforeEach(async () => {
  vi.stubEnv('AGENTCONTROL_SECRET', 'be12-test-secret')
  vi.stubEnv('AGENTCONTROL_AUTH_TOKEN', '')
  dir = mkdtempSync(join(tmpdir(), 'agentcontrol-be12r-'))
  madeDirs.add(dir)
  store = createStore(join(dir, 'store.json'))
  runner = fakeRunner()
  host = {
    engine: 'podman', version: '5.4.0', provider: 'applehv', os: 'darwin', machine: null,
    storage: { driver: 'overlay', backend: 'local', volumeState: 'ok' }, concurrency: 1, setupSteps: [],
  } as VmHostInfo
  free = 50 * GB
  app = build()
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
  rmSync(dir, { recursive: true, force: true })
})
afterAll(async () => {
  await new Promise((r) => setTimeout(r, 20))
  for (const d of madeDirs) rmSync(d, { recursive: true, force: true })
})

async function makeAgent(name: string): Promise<Agent> {
  const res = await app.inject({ method: 'POST', url: '/api/agents', payload: { name, endpointId: 'ep_local_llama', modelId: 'llama-3-8b' } })
  expect(res.statusCode).toBe(201)
  return res.json() as Agent
}
const dmOf = (a: Agent) => ensureDm(store, a.id).id
const startFor = (a: Agent, argv = ['python', 'scripts/go.py']) => app.vmRuns.start({ agentId: a.id, conversationId: dmOf(a), context: { kind: 'dm' }, argv })

describe('run routes', () => {
  it('Mac config: 2 runs → the 2nd is queued with 1 ahead (record, card and VmInfo)', async () => {
    const a = await makeAgent('Analyst')
    const b = await makeAgent('Writer')
    const r1 = await startFor(a)
    const r2 = await startFor(b)
    await until(() => runner.pending.length === 1)
    const got = await app.inject({ method: 'GET', url: `/api/runs/${r2.id}` })
    expect(got.json()).toMatchObject({ status: 'queued', queuePosition: 1 })
    const msgs = await app.inject({ method: 'GET', url: `/api/conversations/${dmOf(b)}/messages` })
    expect(JSON.stringify(msgs.json())).toContain('"queuePosition":1')
    const vm = (await app.inject({ method: 'GET', url: `/api/agents/${b.id}/vm` })).json() as VmInfo
    expect(vm.runs![0]).toMatchObject({ id: r2.id, status: 'queued' })
    // The queued run counts as active for the bot (e.g. VM grow/reset checks).
    expect(app.vmRuns.waiting(b.id)).toBe(1)
    runner.pending[0]!.end()
    await app.vmRuns.wait(r1.id)
    await until(() => runner.pending[0]?.req.runId === r2.id)
  })

  it('under 3 GB free blocks a run (409 low_disk)', async () => {
    const a = await makeAgent('Analyst')
    free = 2.5 * GB
    await expect(startFor(a)).rejects.toMatchObject({ statusCode: 409, reason: 'low_disk' })
    expect((await app.inject({ method: 'GET', url: `/api/agents/${a.id}/script-runs` })).json()).toEqual({ runs: [], hasMore: false })
  })

  it('lists, pages, reads output, stops; Phase 1 /runs is unchanged', async () => {
    const a = await makeAgent('Analyst')
    const ids: string[] = []
    for (let i = 0; i < 3; i++) {
      const r = await startFor(a)
      await until(() => runner.pending.length === 1)
      runner.pending[0]!.out('stdout', `out ${i}\n`)
      runner.pending[0]!.end()
      await app.vmRuns.wait(r.id)
      ids.push(r.id)
    }
    const p1 = await app.inject({ method: 'GET', url: `/api/agents/${a.id}/script-runs?limit=2` })
    expect(p1.statusCode).toBe(200)
    expect(p1.json().hasMore).toBe(true)
    expect(p1.json().runs.map((r: { id: string }) => r.id)).toEqual([ids[2], ids[1]])
    const p2 = await app.inject({ method: 'GET', url: `/api/agents/${a.id}/script-runs?limit=2&before=${ids[1]}` })
    expect(p2.json()).toMatchObject({ hasMore: false, runs: [{ id: ids[0] }] })
    expect((await app.inject({ method: 'GET', url: `/api/agents/${a.id}/script-runs?before=nope` })).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: `/api/agents/${a.id}/script-runs?limit=x` })).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: '/api/agents/nope/script-runs' })).statusCode).toBe(404)
    const out = await app.inject({ method: 'GET', url: `/api/runs/${ids[0]}/output?stream=stdout` })
    expect(out.statusCode).toBe(200)
    expect(out.headers['content-type']).toMatch(/text\/plain/)
    expect(out.body).toBe('out 0\n')
    expect((await app.inject({ method: 'GET', url: `/api/runs/${ids[0]}/output?stream=x` })).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: '/api/runs/nope' })).statusCode).toBe(404)
    app.vmRuns.remove(a.slug, ids[0]!)
    const gone = await app.inject({ method: 'GET', url: `/api/runs/${ids[0]}/output` })
    expect(gone.statusCode).toBe(410)
    expect(gone.json()).toMatchObject({ reason: 'log_evicted' })
    const ended = await app.inject({ method: 'POST', url: `/api/runs/${ids[0]}/stop` })
    expect(ended.statusCode).toBe(409)
    expect(ended.json()).toMatchObject({ reason: 'not_active' })
    const live = await startFor(a)
    await until(() => runner.pending.length === 1)
    const stopped = await app.inject({ method: 'POST', url: `/api/runs/${live.id}/stop` })
    expect(stopped.json()).toMatchObject({ status: 'stopped' })
    const p1runs = await app.inject({ method: 'GET', url: `/api/agents/${a.id}/runs` })
    expect(p1runs.statusCode).toBe(200)
    expect(Array.isArray(p1runs.json())).toBe(true)
  })

  it('VM stop ends the bot\'s queued runs too', async () => {
    const a = await makeAgent('Analyst')
    const b = await makeAgent('Writer')
    await startFor(a)
    const q = await startFor(b)
    await until(() => runner.pending.length === 1)
    await app.inject({ method: 'POST', url: `/api/agents/${b.id}/vm/stop` })
    await until(() => app.vmRuns.get(q.id)!.status === 'stopped')
  })
})

describe('GET /api/events', () => {
  async function connect(url: string, headers: Record<string, string> = {}) {
    const res = await fetch(url, { headers })
    const reader = res.body!.getReader()
    const dec = new TextDecoder()
    let text = ''
    return {
      res,
      async until(re: RegExp, ms = 2000) {
        const t0 = Date.now()
        while (!re.test(text)) {
          if (Date.now() - t0 > ms) throw new Error(`no ${re} in: ${text}`)
          const r = await Promise.race([reader.read(), new Promise<null>((ok) => setTimeout(() => ok(null), ms))])
          if (r && !r.done) text += dec.decode(r.value)
        }
        return text
      },
      text: () => text,
      close: () => reader.cancel().catch(() => {}),
    }
  }

  it('streams run.updated and run.output, filters, pings, replays and resets', async () => {
    const base = await app.listen({ port: 0, host: '127.0.0.1' })
    const a = await makeAgent('Analyst')
    const b = await makeAgent('Writer')
    const s = await connect(`${base}/api/events?agentId=${a.id}`)
    expect(s.res.headers.get('content-type')).toMatch(/text\/event-stream/)
    await s.until(/retry: 3000/)
    const r = await startFor(a)
    await until(() => runner.pending.length === 1)
    runner.pending[0]!.out('stdout', 'live!\n')
    await s.until(/event: run\.output\ndata: .*live!/)
    runner.pending[0]!.end()
    await s.until(/"status":"succeeded"/)
    await s.until(/: ping/)
    const rb = await startFor(b)
    await until(() => runner.pending.length === 1)
    runner.pending[0]!.end()
    await app.vmRuns.wait(rb.id)
    expect(s.text()).not.toContain(rb.id)
    expect(s.text()).toContain(r.id)
    s.close()
    // Replay after Last-Event-ID; ids in the future → reset.
    const ids = [...s.text().matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]))
    const replay = await connect(`${base}/api/events?conversationId=${dmOf(b)}`, { 'Last-Event-ID': String(ids[0]) })
    await replay.until(new RegExp(rb.id))
    replay.close()
    const reset = await connect(`${base}/api/events?lastEventId=999999`)
    const resetText = await reset.until(/id: \d+\nevent: reset\ndata: \{\}/)
    reset.close()
    // The reset's id is the latest event id; reconnecting with it gets no second reset, then new events.
    const resetId = Number(/id: (\d+)\nevent: reset/.exec(resetText)![1])
    expect(resetId).toBe(app.liveEvents.lastId())
    const again = await connect(`${base}/api/events`, { 'Last-Event-ID': String(resetId) })
    await again.until(/retry: 3000/)
    app.liveEvents.publish({ type: 'vm.updated', agentId: a.id, vm: {} as never })
    await again.until(new RegExp(`id: ${resetId + 1}\nevent: vm\\.updated`))
    expect(again.text()).not.toContain('event: reset')
    again.close()
  })

  it('with AGENTCONTROL_AUTH_TOKEN: 401 without the Authorization header, 200 streaming with it', async () => {
    vi.stubEnv('AGENTCONTROL_AUTH_TOKEN', 'be12-events-token')
    const gated = build()
    try {
      const base = await gated.listen({ port: 0, host: '127.0.0.1' })
      const no = await fetch(`${base}/api/events`)
      expect(no.status).toBe(401)
      const bad = await fetch(`${base}/api/events`, { headers: { authorization: 'Bearer nope' } })
      expect(bad.status).toBe(401)
      // A token in the URL isn't accepted (EventSource can't send headers; the FE uses fetch streaming).
      expect((await fetch(`${base}/api/events?token=be12-events-token`)).status).toBe(401)
      const s = await connect(`${base}/api/events`, { authorization: 'Bearer be12-events-token' })
      expect(s.res.status).toBe(200)
      expect(s.res.headers.get('content-type')).toMatch(/text\/event-stream/)
      await s.until(/retry: 3000/)
      gated.liveEvents.publish({ type: 'vm.updated', agentId: 'a-x', vm: {} as never })
      await s.until(/event: vm\.updated/)
      await s.until(/: ping/)
      s.close()
    } finally {
      await gated.close()
    }
  })
})
