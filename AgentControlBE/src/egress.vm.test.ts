/**
 * BE-P2-13 @vm: the egress proxy (ac-egressd) against real containers. Opt-in: AC_VM_TESTS=1, same
 * engine variables as the other @vm files (AC_VM_ENGINE, PODMAN_ARGS); Podman only. Needs
 * localhost/agentcontrol/botvm:<BOTVM_VERSION> in that store.
 *
 * Local test servers only: a web/apt-mirror container on the test's own outbound network
 * (10.89.251.10, allowed with the test-only allow list), and this app's own server. Nothing here
 * reaches the internet. Everything created (daemon, networks, containers, images, volumes) uses
 * test names and is removed at the end.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import { buildApp } from './app.js'
import { createBotEnvService, type BotEnvService, type EngineRef } from './bot-env.js'
import { execCommandRunner } from './command-runner.js'
import { createEgressService, egressNetworkName, hostInterfaceAddresses, PROBE_SLUG, type EgressGrant, type EgressService } from './egress-service.js'
import { ALLOW_UNLIMITED_RUNS_ENV, createContainerRunner, type ContainerRunner } from './podman-runner.js'
import { PROBE_LABEL, type ResolvedRuntime } from './runtime-probe.js'
import type { RunScriptRequest } from './runner.js'
import { builtinTools } from './tools.js'
import type { ToolContext } from './tools/types.js'
import { createStore } from './store.js'
import { defaultAgentVm } from './vm-defaults.js'
import type { Agent } from './shared/types.js'
import { sharedImageRef } from './vm-images.js'

const enginePrefix = (process.env.AC_VM_ENGINE ?? 'podman').split(/\s+/).filter(Boolean)
const podmanArgs = (process.env.PODMAN_ARGS ?? '').split(/\s+/).filter(Boolean)
const command = enginePrefix[0] ?? 'podman'
const cli: 'podman' | 'docker' = enginePrefix[enginePrefix.length - 1] === 'docker' ? 'docker' : 'podman'
const ENGINE: EngineRef = { cli, ...(command !== cli ? { command } : {}), globalArgs: [...enginePrefix.slice(1), ...podmanArgs] }

const pmr = (args: string[], input?: string) => {
  try {
    return { code: 0, out: execFileSync(command, [...ENGINE.globalArgs, ...args], { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024, timeout: 120_000 }).trim() }
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

const T = 'be13t'
const DAEMON = `ac-egressd-${T}`
const OUT = `ac-egress-${T}-out`
const SUBNET = '10.89.251.0/24'
const WEB_IP = '10.89.251.10'
const WEB = `${T}-web`
const SLUG_A = 'be13vm-a'
const SLUG_B = 'be13vm-b'
const TEST_BASE_VERSION = 'be13test'
const TEST_BASE = sharedImageRef('botvm', TEST_BASE_VERSION)
const BOT_NETS = [SLUG_A, SLUG_B, PROBE_SLUG].map(egressNetworkName)

function cleanup(): void {
  for (const c of [DAEMON, WEB, `ac-bot-${SLUG_A}`, `ac-bot-${SLUG_B}`]) pm('rm', '--force', '--ignore', c)
  for (const label of ['io.agentcontrol.egress=build', 'io.agentcontrol.egress=probe', `${PROBE_LABEL}=1`, `io.agentcontrol.be13=1`]) {
    for (const id of (pm('ps', '-a', '--filter', `label=${label}`, '--format', '{{.ID}}') ?? '').split('\n').filter(Boolean)) pm('rm', '--force', id)
  }
  for (const n of [...BOT_NETS, OUT]) pm('network', 'rm', '--force', n)
  for (const slug of [SLUG_A, SLUG_B]) {
    pm('volume', 'rm', '--force', `ac-tools-${slug}`, `ac-opt-${slug}`)
    for (const ref of (pm('image', 'ls', '--format', '{{.Repository}}:{{.Tag}}', '--filter', `reference=localhost/ac-bot-${slug}`) ?? '').split('\n').filter(Boolean)) pm('rmi', '--force', ref)
  }
  pm('rmi', '--force', TEST_BASE)
}

/** Web + apt mirror: plain HTTP on 80 and 443 (443 is reached by CONNECT), files from /srv. */
const WEB_JS = `
const http = require('http'), fs = require('fs'), path = require('path')
const h = (q, s) => {
  const u = decodeURIComponent(q.url.split('?')[0])
  const p = path.join('/srv', u)
  // A relay to the BE (an app-level forwarder on the outbound side): shows what the BE does with a
  // request that came through the proxy anyway.
  if (u.startsWith('/relay/')) {
    const [h, port] = process.env.BE.split(':')
    const up = http.request({ host: h, port: Number(port), path: u.slice(6), method: q.method, headers: q.headers }, (r) => { s.writeHead(r.statusCode, r.headers); r.pipe(s) })
    up.on('error', (e) => { s.statusCode = 599; s.end('relay ' + e.code) })
    return q.pipe(up)
  }
  if (u.startsWith('/hello')) return s.end('hello be13 ' + u + ' via=' + (q.headers.via || '') + ' pauth=' + (q.headers['proxy-authorization'] ? 'yes' : 'no'))
  if (p.startsWith('/srv/') && fs.existsSync(p) && fs.statSync(p).isFile()) return s.end(fs.readFileSync(p))
  s.statusCode = 404; s.end('not found')
}
for (const port of [80, 443]) http.createServer(h).listen(port, '0.0.0.0')
`

/** A one-file .deb plus a flat repo (Packages, Release) for `deb [trusted=yes] http://apt.be13.test/ ./`. */
function makeMirror(root: string): void {
  const pkg = join(root, 'pkg')
  mkdirSync(join(pkg, 'DEBIAN'), { recursive: true })
  mkdirSync(join(pkg, 'usr', 'local', 'bin'), { recursive: true })
  writeFileSync(join(pkg, 'DEBIAN', 'control'), 'Package: be13-hello\nVersion: 1.0\nArchitecture: all\nMaintainer: AgentControl tests <tests@invalid>\nDescription: BE-P2-13 test package\n')
  writeFileSync(join(pkg, 'usr', 'local', 'bin', 'be13-hello'), '#!/bin/sh\necho be13-hello installed through the proxy\n')
  chmodSync(join(pkg, 'usr', 'local', 'bin', 'be13-hello'), 0o755)
  const srv = join(root, 'srv')
  mkdirSync(srv)
  execFileSync('dpkg-deb', ['--root-owner-group', '--build', pkg, join(srv, 'be13-hello_1.0_all.deb')], { stdio: 'ignore' })
  const deb = readFileSync(join(srv, 'be13-hello_1.0_all.deb'))
  const h = (b: Buffer | string, a: string) => createHash(a).update(b).digest('hex')
  const packages =
    `${readFileSync(join(pkg, 'DEBIAN', 'control'), 'utf8').trim()}\nFilename: ./be13-hello_1.0_all.deb\nSize: ${deb.length}\nMD5sum: ${h(deb, 'md5')}\nSHA256: ${h(deb, 'sha256')}\n\n`
  writeFileSync(join(srv, 'Packages'), packages)
  writeFileSync(join(srv, 'Release'), `Origin: be13\nLabel: be13\nSuite: ./\nDate: ${new Date().toUTCString()}\nSHA256:\n ${h(packages, 'sha256')} ${Buffer.byteLength(packages)} Packages\n`)
  for (const f of ['Packages', 'Release', 'be13-hello_1.0_all.deb']) chmodSync(join(srv, f), 0o644)
  chmodSync(srv, 0o755)
  chmodSync(root, 0o755)
}

describe.skipIf(!engineReady)('@vm BE-P2-13 egress proxy', () => {
  let dir = ''
  let egress: EgressService
  let botEnv: BotEnvService
  let runner: ContainerRunner
  let be: ReturnType<typeof buildApp>
  let bePort = 0
  const BE_HOST = '172.17.0.1'
  const minted: EgressGrant[] = []
  const savedOverride = process.env[ALLOW_UNLIMITED_RUNS_ENV]
  const rt: ResolvedRuntime = { effective: 'crun', status: 'incompatible_fallback', mode: 'inherit', globalMode: 'auto', limitsEnforced: false, limitsReason: 'test' }
  const agentOf = (slug: string, policy: string) => ({ id: `ag_${slug}`, slug, name: slug, internetPolicy: policy, vm: defaultAgentVm() }) as unknown as Agent
  const A = agentOf(SLUG_A, 'always')
  const agents = new Map([[A.id, A]])
  const run = (agent: Agent, script: string, over: Partial<RunScriptRequest> = {}) =>
    runner.run({ agentId: agent.id, context: { kind: 'dm' }, argv: ['sh', '-c', script], cwd: 'workspace', timeoutSec: 120, network: 'on', internetGranted: true, ...over })
  /** A bare client container on a bot's network (hardened like a bot), for credential misuse rows. */
  const client = (slug: string, script: string, env: Record<string, string> = {}) =>
    pmr(['run', '--rm', '--network', egressNetworkName(slug), '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '1000:1000', '--label', 'io.agentcontrol.be13=1',
      ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), sharedImageRef('botvm'), 'sh', '-c', script])

  beforeAll(async () => {
    cleanup()
    dir = mkdtempSync(join(tmpdir(), 'ac-be13-vm-'))
    makeMirror(join(dir, 'mirror'))
    for (const sub of ['workspace', 'shared', 'state']) mkdirSync(join(dir, sub), { recursive: true })
    // This app's own server, on the docker0 address the proxy can reach (pasta maps it to the host).
    process.env.AGENTCONTROL_SECRET = 'be13-test-secret'
    be = buildApp(createStore(join(dir, 'state', 'store.json')))
    await be.listen({ host: BE_HOST, port: 0 })
    bePort = (be.server.address() as AddressInfo).port

    if (pm('network', 'create', '--ipv6=false', '--subnet', SUBNET, OUT) === null) throw new Error('could not create the test outbound network')
    const web = pmr(['run', '--detach', '--name', WEB, '--network', OUT, '--ip', WEB_IP, '--user', '0:0', '--label', 'io.agentcontrol.be13=1', '--read-only',
      '-e', `BE=${BE_HOST}:${bePort}`, '--volume', `${join(dir, 'mirror', 'srv')}:/srv:ro`, '--entrypoint', 'node', sharedImageRef('botvm'), '-e', WEB_JS])
    if (web.code !== 0) throw new Error(`web: ${web.out}`)
    // Test base image: botvm with the local mirror as its only apt source (no network needed to build).
    const bdir = join(dir, 'base')
    mkdirSync(bdir)
    writeFileSync(join(bdir, 'Containerfile'), `FROM ${sharedImageRef('botvm')}\nUSER root\nRUN rm -f /etc/apt/sources.list /etc/apt/sources.list.d/* && echo 'deb [trusted=yes] http://apt.be13.test/ ./' > /etc/apt/sources.list.d/be13.list\nUSER 1000:1000\n`)
    const b = pmr(['build', '--pull=never', '--network', 'none', '--tag', TEST_BASE, bdir])
    if (b.code !== 0) throw new Error(`base: ${b.out}`)

    const svc = createEgressService({
      exec: execCommandRunner,
      engine: async () => ENGINE,
      stateDir: () => join(dir, 'state'),
      names: { daemon: DAEMON, outNetwork: OUT },
      addHosts: [`web.be13.test:${WEB_IP}`, `apt.be13.test:${WEB_IP}`, `be.be13.test:${BE_HOST}`],
      config: () => ({ hostAddresses: hostInterfaceAddresses(), modelServers: [], testAllow: [`${WEB_IP}/32`] }),
      log: (m) => console.log(`[be13 egress] ${m}`),
    })
    // Record every credential minted, to prove none is left in images, records or logs.
    egress = { ...svc, grant: async (slug, kind) => { const g = await svc.grant(slug, kind); minted.push(g); return g } }
    process.env[ALLOW_UNLIMITED_RUNS_ENV] = '1'
    botEnv = createBotEnvService({
      exec: execCommandRunner,
      engine: async () => ENGINE,
      baseVersion: () => TEST_BASE_VERSION,
      mounts: () => [{ source: join(dir, 'workspace'), target: '/bot/workspace', readonly: false }],
      uidMapping: () => 'keep-id',
      allowedMounts: (a) => ({ slug: a.slug, workspace: join(dir, 'workspace'), inputs: join(dir, 'shared'), groups: {}, botRoot: dir }),
      saveVm: (id, vm) => { const a = agents.get(id); if (a) a.vm = vm; return true },
      enforceLimits: () => false,
      activeRuns: () => 0,
      buildNetwork: () => 'egress',
      egress,
      log: (m) => console.log(`[be13 botEnv] ${m}`),
    })
    runner = createContainerRunner({ botEnv, engine: async () => ENGINE, getAgent: (id) => agents.get(id), runtime: () => rt, egress, idleStopMs: 60_000, log: (m) => console.log(`[be13 runner] ${m}`) })
  }, 300_000)

  afterAll(async () => {
    if (savedOverride === undefined) delete process.env[ALLOW_UNLIMITED_RUNS_ENV]
    else process.env[ALLOW_UNLIMITED_RUNS_ENV] = savedOverride
    delete process.env.AGENTCONTROL_SECRET
    await be?.close()
    await egress?.shutdown().catch(() => {})
    cleanup()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }, 180_000)

  it('daemon: hardened, never host networking, only on the outbound network until a bot needs it', async () => {
    expect(await egress.available()).toEqual({ ok: true })
    const ins = JSON.parse(pm('container', 'inspect', DAEMON)!)[0]
    expect(Object.keys(ins.NetworkSettings.Networks)).toEqual([OUT])
    expect(ins.HostConfig.NetworkMode).not.toBe('host')
    expect(ins.HostConfig.ReadonlyRootfs).toBe(true)
    expect(ins.HostConfig.CapDrop.length).toBeGreaterThan(0)
    expect(ins.Config.User).toBe('1000:1000')
  })

  it('a granted run reaches the local server through the proxy (HTTP and CONNECT); everything else is blocked and logged', async () => {
    const r = await run(A, [
      'echo "http=$(curl -sS -m 10 http://web.be13.test/hello/plain)"',
      'echo "tunnel=$(curl -sS -m 10 -p http://web.be13.test:443/hello/tunnel)"',
      'echo "lan=$(curl -s -m 10 -o /dev/null -w %{http_code} http://192.168.1.1/)"',
      'echo "meta=$(curl -s -m 10 -o /dev/null -w %{http_code} http://169.254.169.254/latest/meta-data/)"',
      'echo "port=$(curl -s -m 10 -o /dev/null -w %{http_code} http://web.be13.test:8080/)"',
      'echo "lanname=$(curl -s -m 10 -o /dev/null -w %{http_code} http://printer.lan/)"',
      'echo "direct=$(curl -s -m 5 --noproxy "*" -o /dev/null -w %{http_code} http://10.89.251.10/hello || echo fail)"',
      'echo "dns=$(getent hosts web.be13.test || echo none)"',
      'echo "proxyenv=${HTTPS_PROXY:+set}"',
    ].join('; '))
    console.log(`[be13 run] ${JSON.stringify({ ...r, stdout: r.stdout })}`)
    expect(r.outcome).toBe('succeeded')
    const line = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(r.stdout)?.[1]
    expect(line('http')).toMatch(/^hello be13 \/hello\/plain via=1\.1 ac-egressd pauth=no$/)
    expect(line('tunnel')).toMatch(/^hello be13 \/hello\/tunnel via= pauth=no$/)
    for (const k of ['lan', 'meta', 'port', 'lanname']) expect(line(k)).toBe('403')
    expect(line('direct')).toMatch(/^(000|000fail|fail)$/)
    expect(line('dns')).toBe('none')
    expect(line('proxyenv')).toBe('set')
    const hosts = r.hostsContacted ?? []
    expect(hosts.findIndex((h) => !h.blocked)).toBeGreaterThan(hosts.findLastIndex((h) => h.blocked))
    expect([...new Set(hosts.filter((h) => !h.blocked).map((h) => h.host))]).toEqual(['web.be13.test'])
    expect(hosts.filter((h) => h.blocked).map((h) => [h.host, h.reason])).toEqual(expect.arrayContaining([
      ['192.168.1.1', 'home_network'], ['169.254.169.254', 'metadata'], ['web.be13.test', 'port'], ['printer.lan', 'private_name'],
    ]))
    expect(hosts.find((h) => h.host === 'printer.lan')).not.toHaveProperty('ip')
    expect(r.hostsContactedTotal).toBeUndefined()
    // The container sits on the bot's internal network, never host/default.
    const nets = Object.keys(JSON.parse(pm('container', 'inspect', `ac-bot-${SLUG_A}`)!)[0].NetworkSettings.Networks)
    expect(nets).toEqual([egressNetworkName(SLUG_A)])
    // The run's credential is never in its record, and no longer works.
    const g = minted.at(-1)!
    expect(JSON.stringify(r)).not.toContain(g.secrets.at(-1)!)
    const after = client(SLUG_A, 'curl -s -m 10 -o /dev/null -w %{http_code} http://web.be13.test/hello', { http_proxy: g.env.find((e) => e.name === 'HTTP_PROXY')!.value })
    expect(after.out).toBe('407')
  }, 300_000)

  it('the next offline run moves the container back to network none', async () => {
    const r = await run(A, 'curl -s -m 5 http://web.be13.test/ || echo offline', { network: 'off', internetGranted: false })
    expect(r.stdout).toContain('offline')
    expect(JSON.parse(pm('container', 'inspect', `ac-bot-${SLUG_A}`)!)[0].HostConfig.NetworkMode).toBe('none')
  }, 180_000)

  it('a credential is bound to its bot\'s network: bot A\'s credential on bot B\'s network gets 407', async () => {
    const ga = await egress.grant(SLUG_A, 'run')
    await egress.grant(SLUG_B, 'run')
    const url = ga.env.find((e) => e.name === 'HTTP_PROXY')!.value
    const own = client(SLUG_A, 'curl -s -m 10 http://web.be13.test/hello/own', { http_proxy: url })
    expect(own.out).toMatch(/^hello be13 \/hello\/own/)
    const bProxy = url.replace(ga.proxyAddress, minted.at(-1)!.proxyAddress)
    expect(client(SLUG_B, 'curl -s -m 10 -o /dev/null -w %{http_code} http://web.be13.test/hello', { http_proxy: bProxy }).out).toBe('407')
    expect(client(SLUG_B, 'curl -s -m 10 -o /dev/null -w %{http_code} http://web.be13.test/hello', { http_proxy: url }).out).toMatch(/^000$/)
    expect(client(SLUG_B, 'curl -s -m 10 -o /dev/null -w %{http_code} http://web.be13.test/hello', {}).out).toBe('000')
    await egress.revoke(ga.id)
    await egress.revoke(minted.at(-1)!.id)
  }, 180_000)

  it('user-only: an Always-policy run can\'t reach the BE (the proxy refuses this computer); a request relayed from the egress side gets 403 user_only', async () => {
    const urls = [`http://${BE_HOST}:${bePort}/api/permissions`, `http://be.be13.test:${bePort}/api/agents`, `http://${BE_HOST}/api/permissions`, 'http://web.be13.test/relay/api/permissions']
    const script = urls.map((u, i) => `echo "r${i}=$(curl -s -m 10 -D /tmp/h -o /tmp/b -w %{http_code} ${u}) $(grep -i x-agentcontrol-blocked /tmp/h | tr -d '\\r') $(cat /tmp/b)"`).join('; ')
    const r = await run(A, script)
    console.log(`[be13 user-only] ${r.stdout}`)
    const line = (i: number) => new RegExp(`^r${i}=(.*)$`, 'm').exec(r.stdout)?.[1] ?? ''
    // The proxy itself refuses: the BE's address (this computer) or its port; the BE never sees these.
    for (const i of [0, 1, 2]) {
      expect(line(i)).toMatch(/^403 x-agentcontrol-blocked/i)
      expect(line(i)).not.toContain('user_only')
    }
    expect(line(2)).toContain(`Blocked: ${BE_HOST} is this computer`)
    // A forged request that still reached the BE from the egress side (through an allowed relay)
    // carries the proxy's Via and is refused by the BE.
    expect(line(3)).toMatch(/^403 +\{.*"reason":"user_only"/)
    expect(r.hostsContacted?.filter((h) => h.blocked).map((h) => h.host)).toEqual(expect.arrayContaining([BE_HOST, 'be.be13.test']))
    // And straight from a container address (no proxy): 403 too (in-process, the address pasta hides).
    const direct = await be.inject({ method: 'GET', url: '/api/permissions', remoteAddress: minted.at(-1)!.proxyAddress })
    expect(direct.json()).toMatchObject({ statusCode: 403, reason: 'user_only' })
  }, 180_000)

  it('the probe\'s CONNECT check passes on this engine (407 / 403 / no direct route)', async () => {
    const res = await egress.connectCheck()
    console.log(`[be13 connectCheck] ${JSON.stringify(res)}`)
    expect(res.status).toBe('pass')
  }, 180_000)

  it('vm_install through the proxy from the local mirror only: new generation, package works, no credential in the image', async () => {
    const before = A.vm.image.generation
    const tool = builtinTools.get('vm_install')!
    const ctx = {
      agentId: A.id,
      vm: { vmInstall: (_id: string, pk: string[]) => botEnv.vmInstall(A, pk), dmConversation: () => 'c_dm' },
    } as unknown as ToolContext
    const n = minted.length
    const out = (await tool.handler({ apt: ['be13-hello'], why: 'BE-P2-13 test' }, ctx)) as { installed: string[]; generation: number; note: string; logTail?: string }
    console.log(`[be13 vm_install] ${JSON.stringify(out).slice(0, 2000)}`)
    expect(out.generation).toBe(before + 1)
    expect(A.vm.image.generation).toBe(before + 1)
    expect(A.vm.packages).toEqual(['be13-hello'])
    const g = minted[n]!
    expect(g.secrets.length).toBeGreaterThan(0)
    const ref = `localhost/ac-bot-${SLUG_A}:${before + 1}`
    expect(pm('run', '--rm', '--network', 'none', ref, 'be13-hello')).toBe('be13-hello installed through the proxy')
    const inspect = pm('image', 'inspect', ref)!
    const history = pm('history', '--no-trunc', '--format', '{{.CreatedBy}}', ref)!
    for (const s of g.secrets) {
      expect(inspect).not.toContain(s)
      expect(history).not.toContain(s)
      expect(JSON.stringify(out)).not.toContain(s)
    }
    const cfg = JSON.parse(inspect)[0].Config
    expect(cfg.User).toBe('1000:1000')
    expect(cfg.Cmd).toEqual(['sleep', 'infinity'])
    expect(cfg.Entrypoint).toEqual(['/usr/bin/tini', '--'])
    expect(cfg.Labels['io.agentcontrol.packages']).toBe('be13-hello')
    expect(cfg.Labels['io.agentcontrol.from']).toBe(TEST_BASE)
    expect(cfg.Env.join(' ')).not.toMatch(/proxy/i)
    // The build credential is dead, and the build container is gone.
    expect(client(SLUG_A, 'curl -s -m 10 -o /dev/null -w %{http_code} http://web.be13.test/', { http_proxy: g.env.find((e) => e.name === 'HTTP_PROXY')!.value }).out).toBe('407')
    expect(pm('ps', '-a', '--filter', 'label=io.agentcontrol.egress=build', '--format', '{{.ID}}')).toBe('')
  }, 1_200_000)

  it('shutdown removes the daemon, then the bot networks can go', async () => {
    for (const s of [SLUG_A, SLUG_B]) {
      pm('rm', '--force', '--ignore', `ac-bot-${s}`)
      await egress.removeNetwork(s)
    }
    await egress.removeNetwork(PROBE_SLUG)
    pm('rm', '--force', WEB)
    await egress.shutdown()
    expect(pm('container', 'exists', DAEMON)).toBeNull()
    for (const n of [...BOT_NETS, OUT]) expect(pm('network', 'exists', n)).toBeNull()
  }, 180_000)
})

