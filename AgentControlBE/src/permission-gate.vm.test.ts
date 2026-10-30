/**
 * BE-P2-14 @vm: the permission gate against the real proxy (ac-egressd) and real containers.
 * Opt-in: AC_VM_TESTS=1, same engine variables as the other @vm files (AC_VM_ENGINE, PODMAN_ARGS);
 * Podman only. Needs localhost/agentcontrol/botvm:<BOTVM_VERSION> in that store; the firewall
 * helper (egressd-nft) is built if missing and removed again only if this file built it.
 *
 * Local test servers only: a web container on this test's own outbound network (11.89.241.10, a
 * public-looking subnet that exists only inside this test's Podman network, as in egress.vm.test.ts)
 * and this app's own server. Nothing here reaches the internet. Everything created (daemon,
 * networks, containers, volumes) uses test names and is removed at the end.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from './app.js'
import { createBotEnvService, type EngineRef } from './bot-env.js'
import { execCommandRunner } from './command-runner.js'
import { createEgressService, egressNetworkName, hostInterfaceAddresses, PROBE_SLUG, type EgressService } from './egress-service.js'
import { firewallImageRef } from './egress-firewall.js'
import { createPermissionGate, INTERNET_DENIED_TEXT, PERMISSION_TIMEOUT_TEXT, type PermissionGate } from './permission-gate.js'
import { ALLOW_UNLIMITED_RUNS_ENV, createContainerRunner, type ContainerRunner } from './podman-runner.js'
import { createRunService, type RunService } from './run-service.js'
import { PROBE_LABEL, type ResolvedRuntime } from './runtime-probe.js'
import { PERMISSION_CSRF_HEADER, type Agent, type ChatMessage, type Conversation, type ScriptRun } from './shared/types.js'
import { createStore } from './store.js'
import { defaultAgentVm } from './vm-defaults.js'
import { newRunId } from './snapshot.js'
import { sharedImageRef, vmDir } from './vm-images.js'

const enginePrefix = (process.env.AC_VM_ENGINE ?? 'podman').split(/\s+/).filter(Boolean)
const podmanArgs = (process.env.PODMAN_ARGS ?? '').split(/\s+/).filter(Boolean)
const command = enginePrefix[0] ?? 'podman'
const cli: 'podman' | 'docker' = enginePrefix[enginePrefix.length - 1] === 'docker' ? 'docker' : 'podman'
const ENGINE: EngineRef = { cli, ...(command !== cli ? { command } : {}), globalArgs: [...enginePrefix.slice(1), ...podmanArgs] }
const pmr = (args: string[]) => {
  try {
    return { code: 0, out: execFileSync(command, [...ENGINE.globalArgs, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024, timeout: 120_000 }).trim() }
  } catch (e) {
    const x = e as { status?: number; stdout?: string; stderr?: string }
    return { code: x.status ?? 1, out: `${x.stdout ?? ''}${x.stderr ?? ''}`.trim() }
  }
}
const pm = (...args: string[]): string | null => {
  const r = pmr(args)
  return r.code === 0 ? r.out : null
}
const engineReady = process.env.AC_VM_TESTS === '1' && cli === 'podman' && pm('image', 'inspect', '--format', '{{.Id}}', sharedImageRef('botvm')) !== null

const T = 'be14t'
const DAEMON = `ac-egressd-${T}`
const OUT = `ac-egress-${T}-out`
// 11.89.241.0/24 looks like a public range, but it exists only inside this test's own Podman
// network (the outbound network the proxy uses here): deliberate, approved by the Team lead, so the
// proxy's public-address rules apply to the test web server. Nothing leaves this computer for it.
const SUBNET = '11.89.241.0/24'
const WEB_IP = '11.89.241.10'
const WEB = `${T}-web`
const SLUG = 'be14vm-a'
const NFT_IMAGE = firewallImageRef()
let builtNft = false

function cleanup(): void {
  for (const c of [DAEMON, WEB, `ac-bot-${SLUG}`]) pm('rm', '--force', '--ignore', c)
  for (const label of ['io.agentcontrol.egress=probe', 'io.agentcontrol.egress=firewall', `${PROBE_LABEL}=1`, 'io.agentcontrol.be14=1']) {
    for (const id of (pm('ps', '-a', '--filter', `label=${label}`, '--format', '{{.ID}}') ?? '').split('\n').filter(Boolean)) pm('rm', '--force', id)
  }
  for (const n of [egressNetworkName(SLUG), egressNetworkName(PROBE_SLUG), OUT]) pm('network', 'rm', '--force', n)
  pm('volume', 'rm', '--force', `ac-tools-${SLUG}`, `ac-opt-${SLUG}`)
}

/** Plain HTTP on 80; /relay/* forwards to the BE (shows what the BE does with a request from the egress side). */
const WEB_JS = `
const http = require('http')
http.createServer((q, s) => {
  if (q.url.startsWith('/relay/')) {
    const [h, port] = process.env.BE.split(':')
    const up = http.request({ host: h, port: Number(port), path: q.url.slice(6), method: q.method, headers: q.headers }, (r) => { s.writeHead(r.statusCode, r.headers); r.pipe(s) })
    up.on('error', (e) => { s.statusCode = 599; s.end('relay ' + e.code) })
    return q.pipe(up)
  }
  s.end('hello be14 ' + q.url)
}).listen(80, '0.0.0.0')
`

describe.skipIf(!engineReady)('@vm BE-P2-14 permission gate', () => {
  let dir = ''
  let egress: EgressService
  let runner: ContainerRunner
  let gate: PermissionGate
  let svc: RunService
  let be: ReturnType<typeof buildApp>
  let bePort = 0
  const BE_HOST = '172.17.0.1'
  const savedOverride = process.env[ALLOW_UNLIMITED_RUNS_ENV]
  const rt: ResolvedRuntime = { effective: 'crun', status: 'incompatible_fallback', mode: 'inherit', globalMode: 'auto', limitsEnforced: false, limitsReason: 'test' }
  const agent = { id: 'ag_be14vm', slug: SLUG, name: 'BE14 VM test', internetPolicy: 'ask', vm: defaultAgentVm() } as unknown as Agent
  const conv = { id: 'dm-be14', kind: 'dm', agentId: agent.id, createdAt: '', updatedAt: '', lastReadAt: null } as unknown as Conversation
  const messages: ChatMessage[] = []
  const ws = () => join(dir, 'workspace')
  const CURL = 'echo "web=$(curl -sS -m 10 http://web.be14.test/hello/x 2>/dev/null || echo offline)"'
  const start = (network: 'on' | 'off' = 'on', script = CURL) =>
    svc.start({ agentId: agent.id, conversationId: conv.id, context: { kind: 'dm' }, argv: ['sh', '-c', script], network, why: 'fetch the test page', hosts: ['web.be14.test'], timeoutSec: 120 })
  const waiting = async (runId: string) => {
    for (let i = 0; i < 200 && !gate.list({ agentId: agent.id }).requests.some((r) => r.runId === runId); i++) await new Promise((r) => setTimeout(r, 25))
    const req = gate.list({ agentId: agent.id }).requests.find((r) => r.runId === runId)
    if (!req) throw new Error(`no pending request for ${runId}`)
    return req
  }
  const web = (r: ScriptRun) => /^web=(.*)$/m.exec(svc.modelResult(r).stdout)?.[1]

  beforeAll(async () => {
    cleanup()
    dir = mkdtempSync(join(tmpdir(), 'ac-be14-vm-'))
    for (const sub of ['workspace', 'shared', 'state', 'runs']) mkdirSync(join(dir, sub), { recursive: true })
    process.env.AGENTCONTROL_SECRET = 'be14-test-secret'
    bePort = await new Promise<number>((resolve) => {
      const s = createServer().listen(0, BE_HOST, () => {
        const p = (s.address() as AddressInfo).port
        s.close(() => resolve(p))
      })
    })
    if (pm('network', 'create', '--ipv6=false', '--subnet', SUBNET, OUT) === null) throw new Error('could not create the test outbound network')
    const w = pmr(['run', '--detach', '--name', WEB, '--network', OUT, '--ip', WEB_IP, '--user', '0:0', '--label', 'io.agentcontrol.be14=1', '--read-only',
      '-e', `BE=${BE_HOST}:${bePort}`, '--entrypoint', 'node', sharedImageRef('botvm'), '-e', WEB_JS])
    if (w.code !== 0) throw new Error(`web: ${w.out}`)
    if (pm('image', 'exists', NFT_IMAGE) === null) {
      execFileSync('bash', [join(vmDir(), 'build-images.sh'), '--engine', 'podman', '--only', 'egressd-nft'], { stdio: 'inherit', timeout: 600_000 })
      builtNft = true
    }
    egress = createEgressService({
      exec: execCommandRunner,
      engine: async () => ENGINE,
      stateDir: () => join(dir, 'state'),
      names: { daemon: DAEMON, outNetwork: OUT },
      addHosts: [`web.be14.test:${WEB_IP}`],
      config: () => ({ hostAddresses: hostInterfaceAddresses(), modelServers: [], testAllow: [] }),
      log: (m) => console.log(`[be14 egress] ${m}`),
    })
    process.env[ALLOW_UNLIMITED_RUNS_ENV] = '1'
    be = buildApp(createStore(join(dir, 'state', 'store.json')), { egress })
    await be.listen({ host: BE_HOST, port: bePort })
    const botEnv = createBotEnvService({
      exec: execCommandRunner,
      engine: async () => ENGINE,
      mounts: () => [{ source: ws(), target: '/bot/workspace', readonly: false }],
      uidMapping: () => 'keep-id',
      allowedMounts: () => ({ slug: SLUG, workspace: ws(), inputs: join(dir, 'shared'), groups: {}, botRoot: dir }),
      saveVm: () => true,
      enforceLimits: () => false,
      activeRuns: () => 0,
      buildNetwork: () => 'egress',
      egress,
      log: (m) => console.log(`[be14 botEnv] ${m}`),
    })
    runner = createContainerRunner({ botEnv, engine: async () => ENGINE, getAgent: () => agent, runtime: () => rt, egress, idleStopMs: 60_000, log: (m) => console.log(`[be14 runner] ${m}`) })
    gate = createPermissionGate({
      dataDir: () => join(dir, 'state'),
      getAgent: (id) => (id === agent.id ? agent : undefined),
      conversations: () => [conv],
      messages: () => messages,
      save: () => {},
      setAlways: () => { throw new Error('not in this test') },
      proxyAvailable: async () => (await egress.available()).ok,
      timeoutMs: 4000,
      log: (m) => console.log(`[be14 gate] ${m}`),
    })
    svc = createRunService({
      gate,
      runner,
      getAgent: (id) => (id === agent.id ? agent : undefined),
      conversations: () => [conv],
      messages: () => messages,
      save: () => {},
      root: () => join(dir, 'runs'),
      concurrency: () => 1,
      freeBytes: () => null,
      newRunId,
      log: (m) => console.log(`[be14 runs] ${m}`),
    })
  }, 300_000)

  afterAll(async () => {
    if (savedOverride === undefined) delete process.env[ALLOW_UNLIMITED_RUNS_ENV]
    else process.env[ALLOW_UNLIMITED_RUNS_ENV] = savedOverride
    delete process.env.AGENTCONTROL_SECRET
    gate?.close()
    await be?.close()
    await egress?.shutdown().catch(() => {})
    cleanup()
    if (builtNft) pm('rmi', NFT_IMAGE)
    if (dir) pm('unshare', 'rm', '-rf', dir)
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  }, 180_000)

  it('allow once: the waiting run reaches the local test server through the proxy; the next run asks again and, offline, can\'t', async () => {
    const run = await start()
    expect(run.status).toBe('waiting_permission')
    const req = await waiting(run.id)
    expect(req).toMatchObject({ type: 'internet', hosts: ['web.be14.test'], status: 'pending' })
    expect((await gate.answer(req.id, 'allow_once')).status).toBe('allowed_once')
    const done = await svc.wait(run.id)
    console.log(`[be14 allow] ${JSON.stringify({ status: done.status, stdout: svc.modelResult(done).stdout })}`)
    expect(done.status).toBe('succeeded')
    expect(web(done)).toBe('hello be14 /hello/x')
    expect(done.hostsContacted?.some((h) => h.host === 'web.be14.test' && !h.blocked)).toBe(true)
    // Once only: the next run with network on waits for a new card.
    const next = await start()
    expect(next.status).toBe('waiting_permission')
    const req2 = await waiting(next.id)
    expect(req2.id).not.toBe(req.id)
    await svc.stop(next.id)
    // And an offline run (network none) can't reach the server.
    const off = await svc.wait((await start('off')).id)
    expect(off.status).toBe('succeeded')
    expect(web(off)).toBe('offline')
    expect(JSON.parse(pm('container', 'inspect', `ac-bot-${SLUG}`)!)[0].HostConfig.NetworkMode).toBe('none')
  }, 300_000)

  it('deny: the run ends denied without starting; nothing reached the server', async () => {
    const run = await start()
    const req = await waiting(run.id)
    expect((await gate.answer(req.id, 'deny')).status).toBe('denied')
    const done = await svc.wait(run.id)
    expect(done).toMatchObject({ status: 'denied', reason: 'permission_denied', error: INTERNET_DENIED_TEXT })
    expect(done.startedAt ?? null).toBeNull()
    expect(done.hostsContacted ?? []).toEqual([])
  }, 300_000)

  it('timeout: no answer within the lifetime ends the run offline (timeout), never started', async () => {
    const run = await start()
    const req = await waiting(run.id)
    const done = await svc.wait(run.id)
    expect(done).toMatchObject({ status: 'denied', error: PERMISSION_TIMEOUT_TEXT })
    expect(done.startedAt ?? null).toBeNull()
    expect(gate.get(req.id)).toMatchObject({ status: 'timeout' })
  }, 300_000)

  it('user-only: the bot side can\'t answer a card (a relayed POST /api/permissions/:id gets 403 user_only; the card stays pending)', async () => {
    const run = { id: 'run_be14_relay', agentId: 'ag_x', conversationId: 'conv_x', kind: 'script', argv: ['sh'], network: 'on', permissions: [], queuedAt: new Date().toISOString() } as unknown as ScriptRun
    const { requestId } = be.vmPermissions.raise(run, 'internet')
    const post = `curl -s -m 10 -o /tmp/b -w %{http_code} -X POST -H 'content-type: application/json' -H '${PERMISSION_CSRF_HEADER}: 1' --data '{"decision":"always"}' http://web.be14.test/relay/api/permissions/${requestId}`
    // Granted (allow once) so the run has the proxy; the BE itself is refused by the proxy, only the relay reaches it.
    const r = await start('on', `echo "relay=$(${post}) $(cat /tmp/b)"; echo "direct=$(curl -s -m 10 -o /dev/null -w %{http_code} -X POST http://${BE_HOST}:${bePort}/api/permissions/${requestId})"`)
    await gate.answer((await waiting(r.id)).id, 'allow_once')
    const done = await svc.wait(r.id)
    const out = svc.modelResult(done).stdout
    console.log(`[be14 user-only] ${out}`)
    expect(/^relay=(.*)$/m.exec(out)?.[1]).toMatch(/^403 +\{.*"reason":"user_only"/)
    expect(/^direct=(.*)$/m.exec(out)?.[1]).toBe('403')
    expect(be.vmPermissions.get(requestId)!.status).toBe('pending')
  }, 300_000)
})
