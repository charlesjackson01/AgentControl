import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from './app.js'
import { BUILD_TIMEOUT_MS, createBotEnvService } from './bot-env.js'
import { botMounts, storeSaveVm } from './bot-env-routes.js'
import { fakeEngine } from './bot-env.fake.js'
import type { CommandRunner } from './command-runner.js'
import { ensureDm } from './conversations.js'
import { CREDENTIAL_GRACE_MS, createEgressService, type EgressService } from './egress-service.js'
import { fakePodman } from './egress-service.fake.js'
import { botRoot } from './files.js'
import { RESTART_RUNNING_TEXT } from './run-service.js'
import { fakeRunner, type FakeRunner } from './run-service.fake.js'
import type { RuntimeProbe } from './runtime-probe.js'
import type { Agent, ScriptRun, VmHostInfo } from './shared/types.js'
import { createStore } from './store.js'
import type { VmHostService } from './vm-host.js'

/**
 * M2 follow-up (Team lead, on 861318e): a Rebuild's `allow_once`/`rebuild` grant is one build's
 * egress credential and nothing more. Real BotEnvService + EgressService + in-process egress proxy
 * (fake Podman); a real CONNECT through the proxy with the credential the build got on stdin.
 * - It is revoked when the build ends: succeeded, failed, stopped, timed_out; after a restart the
 *   new BE process revokes what the old one left (revokeAll on first contact), and the TTL bounds it anyway.
 * - It can't be reused: the next build gets a new credential, the old one gets 407; a run after
 *   the Rebuild gets no internet from it (no internetGranted, internetPolicy unchanged).
 * - The TTL (BUILD_TIMEOUT_MS + 60 s) counts from the grant, on the proxy's clock.
 */

const PUBLIC = '93.184.215.14'
let dir = ''
let store: ReturnType<typeof createStore>
let app: ReturnType<typeof buildApp>
let runner: FakeRunner
let engine: ReturnType<typeof fakeEngine>
let fake: ReturnType<typeof fakePodman>
let egress: EgressService
let clock = 0
let logs: string[] = []
let upstream: net.Server
let upstreamPort = 0
let proxyPort = 0
/** How the fake engine ends the proxy build's `run` once the gate opens. */
let ending: 'ok' | 'fail' | 'timeout' = 'ok'
let gate: { promise: Promise<void>; open: () => void } | null = null
/** The proxy URL each build got on stdin (id:secret inside). */
let urls: string[] = []
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
} as VmHostInfo

function newGate() {
  let open = () => {}
  const promise = new Promise<void>((r) => (open = r))
  gate = { promise, open }
  return gate
}

const makeEgress = () =>
  createEgressService({
    exec: fake.exec,
    engine: async () => ({ cli: 'podman', globalArgs: [] }),
    image: () => 'localhost/agentcontrol/botvm:test',
    stateDir: () => join(dir, 'egressd'),
    config: () => ({ hostAddresses: ['192.0.2.10'] }),
    log: (m) => logs.push(m),
  })

async function makeApp(s: ReturnType<typeof createStore>, eg: EgressService): Promise<ReturnType<typeof buildApp>> {
  const vmHost: VmHostService = { hostInfo: async () => host, ensureMachine: async () => host, grow: async () => host }
  let self: ReturnType<typeof buildApp> | null = null
  const exec: CommandRunner = async (cmd, args, o) => {
    const [verb] = args
    if (verb === 'run' && args.includes('-i')) {
      urls.push((o?.input ?? '').trim())
      o?.onOutput?.('stdout', 'Step 1 of 3: apt-get update\n')
      if (gate) {
        const signal = o?.signal
        await Promise.race([gate.promise, new Promise<void>((r) => signal?.addEventListener('abort', () => r(), { once: true }))])
        if (signal?.aborted) return { code: 130, stdout: '', stderr: 'stopped' }
      }
      if (ending === 'fail') return { code: 100, stdout: '', stderr: 'E: Unable to locate package nope' }
      if (ending === 'timeout') return { code: 124, stdout: '', stderr: 'timed out' }
      return { code: 0, stdout: 'Step 2 of 3: apt-get install\n', stderr: '' }
    }
    if (verb === 'image' && args[1] === 'inspect' && args[2] === '--format') {
      return engine.images.has(args[4]!) ? { code: 0, stdout: '{"User":"1000:1000","Entrypoint":null,"Cmd":["sleep","infinity"]}', stderr: '' } : { code: 125, stdout: '', stderr: 'image not known' }
    }
    if (verb === 'commit') {
      engine.images.set(args[args.length - 1]!, { id: `c-${args[args.length - 1]}`, labels: {} })
      return { code: 0, stdout: 'sha', stderr: '' }
    }
    return engine.exec(cmd, args, o)
  }
  const botEnv = createBotEnvService({
    exec,
    engine: async () => ({ cli: 'podman', globalArgs: [] }),
    mounts: (a) => botMounts(s, a),
    saveVm: storeSaveVm(s),
    activeRuns: (id) => self!.vmRunner.activeRuns(id),
    egress: eg,
  })
  self = buildApp(s, { vmHost, botEnv, runtimeProbe: probe, vmRunner: runner, vmFreeBytes: () => null, egress: eg })
  await self.ready()
  return self
}

/** CONNECT through the in-process proxy with a build's credential (or none): the status code. */
function connect(url: string | null): Promise<number> {
  const auth = url ? (() => { const u = new URL(url); return `Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')}` })() : null
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: '127.0.0.1', port: proxyPort })
    let buf = ''
    s.on('error', reject)
    s.on('connect', () => s.write(`CONNECT deb.example.org:443 HTTP/1.1\r\nHost: deb.example.org:443\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ''}\r\n`))
    s.on('data', (c) => {
      buf += c.toString('latin1')
      if (buf.includes('\r\n\r\n')) {
        s.destroy()
        resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(buf)?.[1]))
      }
    })
  })
}
const idOf = (url: string) => new URL(url).username
const live = () => fake.proxy.health().credentials
const grants = () => fake.inputs.filter((i) => i.includes('"op":"grant"')).map((i) => (JSON.parse(i) as { credential: { id: string; kind: string; ttlMs: number } }).credential)

const inject = (method: 'GET' | 'POST', url: string, payload?: unknown) => app.inject({ method, url, payload: payload as object | undefined })
const stored = (id: string) => store.agents.find((a) => a.id === id)!
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 1000 && !cond(); i++) await new Promise((r) => setTimeout(r, 2))
  expect(cond()).toBe(true)
}
async function makeAgent(): Promise<Agent> {
  const res = await inject('POST', '/api/agents', { name: 'Analyst', endpointId: 'ep_local_llama', modelId: 'llama-3-8b' })
  expect(res.statusCode).toBe(201)
  const a = res.json() as Agent
  mkdirSync(join(botRoot(store, stored(a.id)), 'workspace'), { recursive: true })
  stored(a.id).vm.packages = ['jq']
  return a
}
/** POST rebuild (online: the bot has packages) → the run, once its build has its credential. */
async function startRebuild(a: Agent): Promise<{ run: ScriptRun; url: string }> {
  const n = urls.length
  const res = await inject('POST', `/api/agents/${a.id}/vm/tools/rebuild`)
  expect(res.statusCode).toBe(202)
  const run = (res.json() as { run: ScriptRun }).run
  expect(run).toMatchObject({ network: 'on', permissions: [{ type: 'internet', decision: 'allow_once', source: 'rebuild' }] })
  await until(() => urls.length > n)
  return { run, url: urls[urls.length - 1]! }
}
async function listen(): Promise<void> {
  const s = fake.proxy.server
  if (!s.listening) await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  proxyPort = (s.address() as net.AddressInfo).port
}

beforeEach(async () => {
  vi.stubEnv('AGENTCONTROL_SECRET', 'm2-followups-test-secret')
  vi.stubEnv('AGENTCONTROL_AUTH_TOKEN', '')
  dir = mkdtempSync(join(tmpdir(), 'agentcontrol-m2fu-'))
  store = createStore(join(dir, 'store.json'))
  clock = 5_000_000
  logs = []
  urls = []
  ending = 'ok'
  gate = null
  upstream = net.createServer((s) => s.on('data', (d) => s.write(d)))
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r))
  upstreamPort = (upstream.address() as net.AddressInfo).port
  // The proxy is on 127.0.0.1 "on the bot's network" so the test can CONNECT to it as the build would.
  fake = fakePodman({
    botIp: '127.0.0.1',
    proxy: () => ({ now: () => clock, resolve: async () => [PUBLIC], connect: () => net.connect({ host: '127.0.0.1', port: upstreamPort }) }),
  })
  engine = fakeEngine()
  runner = fakeRunner()
  egress = makeEgress()
  app = await makeApp(store, egress)
  expect(await egress.available()).toEqual({ ok: true })
  await listen()
})
afterEach(async () => {
  gate?.open()
  for (let i = 0; i < 100 && app.vmRuns.activeCount(); i++) {
    for (const p of [...runner.pending]) p.end()
    await new Promise((r) => setTimeout(r, 2))
  }
  await app.vmRuns.idle()
  await app.close()
  if (fake.proxy.server.listening) await fake.proxy.close()
  await new Promise<void>((r) => upstream.close(() => r()))
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

describe('M2: a Rebuild\'s allow_once grant is one build\'s credential', () => {
  it('succeeded: live only while the build runs, revoked at the end (407), TTL BUILD_TIMEOUT_MS + 60 s', async () => {
    const a = await makeAgent()
    newGate()
    const { run, url } = await startRebuild(a)
    expect(live()).toBe(1)
    expect(await connect(url)).toBe(200)
    expect(await connect(null)).toBe(407)
    expect(grants()).toEqual([expect.objectContaining({ id: idOf(url), kind: 'build', ttlMs: BUILD_TIMEOUT_MS + CREDENTIAL_GRACE_MS })])
    gate!.open()
    expect(await app.vmRuns.wait(run.id)).toMatchObject({ status: 'succeeded' })
    expect(live()).toBe(0)
    expect(await connect(url)).toBe(407)
  })

  it.each([
    ['failed', 'fail'],
    ['timed_out', 'timeout'],
  ] as const)('%s: the credential is revoked when the build ends', async (status, how) => {
    const a = await makeAgent()
    ending = how
    newGate()
    const { run, url } = await startRebuild(a)
    expect(await connect(url)).toBe(200)
    gate!.open()
    expect(await app.vmRuns.wait(run.id)).toMatchObject({ status })
    expect(live()).toBe(0)
    expect(await connect(url)).toBe(407)
    expect(stored(a.id).vm.image.generation).toBe(0)
  })

  it('stopped (Stop during the build): the credential is revoked', async () => {
    const a = await makeAgent()
    newGate()
    const { run, url } = await startRebuild(a)
    expect(await connect(url)).toBe(200)
    const stop = await inject('POST', `/api/runs/${run.id}/stop`)
    expect(stop.statusCode).toBe(200)
    expect(stop.json()).toMatchObject({ status: 'stopped', reason: 'build_stopped' })
    await until(() => live() === 0)
    expect(await connect(url)).toBe(407)
  })

  it('can\'t be reused: the next Rebuild gets a new credential; a run after it gets no internet from it', async () => {
    const a = await makeAgent()
    const policy = stored(a.id).internetPolicy
    const first = await startRebuild(a)
    await app.vmRuns.wait(first.run.id)
    newGate()
    const second = await startRebuild(a)
    expect(idOf(second.url)).not.toBe(idOf(first.url))
    expect(live()).toBe(1)
    expect(await connect(first.url)).toBe(407)
    expect(await connect(second.url)).toBe(200)
    gate!.open()
    await app.vmRuns.wait(second.run.id)
    expect(live()).toBe(0)
    // A run after the Rebuilds: the allow_once was for those builds only.
    const r = await app.vmRuns.start({ agentId: a.id, conversationId: ensureDm(store, a.id).id, context: { kind: 'dm' }, argv: ['python', 'go.py'] })
    await until(() => runner.pending.length === 1)
    expect(runner.pending[0]!.req.internetGranted).toBeUndefined()
    expect(stored(a.id).internetPolicy).toBe(policy)
    expect(grants().map((g) => g.kind)).toEqual(['build', 'build'])
    for (const u of [first.url, second.url]) expect(await connect(u)).toBe(407)
    runner.pending[0]!.end()
    await app.vmRuns.wait(r.id)
  })

  it('the TTL counts from the grant (proxy clock): refused at grant + TTL even before the sweep, then swept', async () => {
    const a = await makeAgent()
    // Time passes before the build (BE up for an hour): the TTL is not counted from then.
    clock += 60 * 60_000
    newGate()
    const t0 = clock
    const { url } = await startRebuild(a)
    const ttl = BUILD_TIMEOUT_MS + CREDENTIAL_GRACE_MS
    clock = t0 + ttl - 1
    expect(await connect(url)).toBe(200)
    clock = t0 + ttl
    expect(await connect(url)).toBe(407)
    expect(fake.proxy.sweep()).toBe(1)
    expect(live()).toBe(0)
  })

  it('restart: the build left running is failed, and the new BE process revokes its credential on first contact', async () => {
    const a = await makeAgent()
    newGate()
    const { run, url } = await startRebuild(a)
    expect(await connect(url)).toBe(200)
    // Let the record reach the disk, then start a "new BE process" on the same data and proxy.
    await new Promise((r) => setTimeout(r, 1100))
    const store2 = createStore(join(dir, 'store.json'))
    const egress2 = makeEgress()
    const old = app
    const oldRunner = runner
    runner = fakeRunner()
    const app2 = await makeApp(store2, egress2)
    try {
      expect(app2.vmRuns.get(run.id)).toMatchObject({ status: 'failed', error: RESTART_RUNNING_TEXT })
      expect(await egress2.available()).toEqual({ ok: true })
      expect(logs).toContain('egress: revoked 1 credential(s) left from before this start')
      expect(live()).toBe(0)
      expect(await connect(url)).toBe(407)
    } finally {
      await app2.vmRuns.idle()
      await app2.close()
      runner = oldRunner
      app = old
    }
  })
})
