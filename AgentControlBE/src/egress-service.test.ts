import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { capHostContacts, CONNECT_CHECK_SCRIPT, createEgressService, EGRESS_DAEMON_NAME, EgressUnavailableError, egressNetworkName, hostInterfaceAddresses, localAddressesFromProc, modelServersOf, PROBE_SLUG, PROXY_UNAVAILABLE, proxyEnv, testAllowFromEnv, resetTestAllowWarning, defaultGatewaysFromProc, BUILD_TTL_MS, PROBE_TTL_MS } from './egress-service.js'
import { fail, fakePodman } from './egress-service.fake.js'
import type { HostContact } from './shared/types.js'
import { createEgressRules } from './egress-rules.js'
import { BUILD_TIMEOUT_MS } from './bot-env.js'

/** BE-P2-13: the BE side of the proxy against a fake Podman whose `exec … ctl` talks to a real in-process proxy. */

let dir: string
let fake: ReturnType<typeof fakePodman>
let logs: string[]
const make = (over: Partial<Parameters<typeof createEgressService>[0]> = {}) =>
  createEgressService({
    exec: fake.exec,
    engine: async () => ({ cli: 'podman', globalArgs: [] }),
    image: () => 'localhost/agentcontrol/botvm:test',
    stateDir: () => dir,
    config: () => ({ hostAddresses: ['192.0.2.10'], modelServers: [{ host: '127.0.0.1', port: 3001 }] }),
    log: (m) => logs.push(m),
    ...over,
  })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'be13-svc-'))
  fake = fakePodman()
  logs = []
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('daemon', () => {
  it('starts ac-egressd hardened, on the outbound network only, with its code mounted read-only', async () => {
    const svc = make()
    expect(await svc.available()).toEqual({ ok: true })
    const out = fake.networks.get('ac-egress-out')!
    expect(out).toContain('--ipv6=false')
    expect(out).not.toContain('--internal')
    const run = fake.daemon!.args
    for (const f of ['--read-only', '--cap-drop', 'ALL', 'no-new-privileges', '1000:1000', '--memory', '--pids-limit']) expect(run).toContain(f)
    expect(run[run.indexOf('--network') + 1]).toBe('ac-egress-out')
    expect(run.join(' ')).not.toMatch(/--network[= ]host|--privileged|podman\.sock|docker\.sock/)
    const mount = run[run.indexOf('--mount') + 1]!
    expect(mount).toMatch(/,target=\/opt\/egressd,readonly$/)
    const appDir = /source=([^,]+)/.exec(mount)![1]!
    expect(readdirSync(appDir).sort()).toEqual(['egress-rules.js', 'egressd.js', 'package.json'])
    expect(readFileSync(join(appDir, 'egressd.js'), 'utf8')).not.toMatch(/:\s*EgressCredential\b/)
    expect(run.slice(-4)).toEqual(['localhost/agentcontrol/botvm:test', 'node', '/opt/egressd/egressd.js', 'serve'])
  })
  it('reuses a running daemon, starts a stopped one, and recreates one with other code', async () => {
    const svc = make()
    await svc.available()
    const runs = () => fake.calls.filter((c) => c[0] === 'run' && c.includes('--detach')).length
    await svc.available()
    expect(runs()).toBe(1)
    fake.stop()
    await svc.available()
    expect(fake.calls.some((c) => c[0] === 'start')).toBe(true)
    await make({ addHosts: ['apt.be13.test:10.89.0.9'] }).available()
    expect(fake.calls.some((c) => c[0] === 'rm' && c.includes(EGRESS_DAEMON_NAME))).toBe(true)
    expect(runs()).toBe(2)
    expect(fake.daemon!.args).toContain('apt.be13.test:10.89.0.9')
  })
  it('a daemon that won\'t start is proxy_unavailable (409), with the detail logged only', async () => {
    fake.state.runFails = true
    const svc = make()
    const r = await svc.available()
    expect(r.ok).toBe(false)
    const e = await svc.grant('bob', 'run').catch((x: unknown) => x)
    expect(e).toBeInstanceOf(EgressUnavailableError)
    expect(e).toMatchObject({ reason: 'proxy_unavailable', statusCode: 409, message: PROXY_UNAVAILABLE })
    expect((e as EgressUnavailableError).detail).toMatch(/image not known/)
  })
  it('Docker or no engine: unavailable (the proxy is Podman only)', async () => {
    expect((await make({ engine: async () => ({ cli: 'docker', globalArgs: [] }) }).available()).ok).toBe(false)
    expect((await make({ engine: async () => null }).available()).ok).toBe(false)
  })
})

describe('grant / revoke', () => {
  it('creates the bot\'s internal network, attaches the proxy, and mints a network-bound credential', async () => {
    const svc = make()
    const g = await svc.grant('bob', 'run')
    expect(g.network).toBe(egressNetworkName('bob'))
    expect(fake.networks.get('ac-egress-bob')).toEqual(expect.arrayContaining(['--internal', '--disable-dns', '--ipv6=false']))
    expect(g.proxyAddress).toMatch(/^10\.89\.\d+\.2$/)
    const url = g.env.find((e) => e.name === 'HTTPS_PROXY')!.value
    expect(url).toMatch(new RegExp(`^http://ac[0-9a-f]+:[0-9a-f]{48}@${g.proxyAddress.replace(/\./g, '\\.')}:3128$`))
    // Review B4: every form of the credential is redacted, longest first.
    const secret = g.secret
    expect(secret).toMatch(/^[0-9a-f]{48}$/)
    expect([...g.secrets].sort()).toEqual([url, url.slice('http://'.length), Buffer.from(`${g.id}:${secret}`).toString('base64'), secret].sort())
    expect(g.secrets.map((x) => x.length)).toEqual([...g.secrets.map((x) => x.length)].sort((a, b) => b - a))
    // The secret goes over stdin, never argv.
    expect(fake.calls.flat().some((x) => x.includes(secret))).toBe(false)
    expect(fake.inputs.some((i) => i.includes(secret))).toBe(true)
    expect(logs.join('\n')).not.toContain(secret)
    // The config was pushed.
    expect(fake.inputs.some((i) => i.includes('"op":"config"') && i.includes('192.0.2.10'))).toBe(true)
    expect(await svc.revoke(g.id)).toEqual([])
  })
  it('a second bot gets its own network and proxy address; the same bot reuses its network', async () => {
    const svc = make()
    const a = await svc.grant('a', 'run')
    const b = await svc.grant('b', 'run')
    const a2 = await svc.grant('a', 'build')
    expect(a.proxyAddress).not.toBe(b.proxyAddress)
    expect(a2.proxyAddress).toBe(a.proxyAddress)
    expect(a2.id).not.toBe(a.id)
    expect(fake.calls.filter((c) => c[0] === 'network' && c[1] === 'create' && c.includes('ac-egress-a')).length).toBe(1)
  })
  it('a failed revoke is tried twice, then the proxy is removed so the credential dies with it', async () => {
    const svc = make()
    const g = await svc.grant('bob', 'run', { ttlMs: 600_000 })
    fake.state.ctlDown = true
    expect(await svc.revoke(g.id)).toEqual([])
    expect(logs.filter((l) => l.includes(`revoking ${g.id} failed`))).toHaveLength(2)
    expect(fake.calls.at(-1)).toEqual(['rm', '--force', '--time', '2', EGRESS_DAEMON_NAME])
    expect(fake.daemon).toBeNull()
    expect(logs.at(-1)).toBe(`egress: removed ${EGRESS_DAEMON_NAME} so ${g.id} can't be used`)
    expect(await svc.hosts(g.id)).toEqual([])
  })
  it('a revoke that works on the second try keeps the proxy', async () => {
    const svc = make()
    const g = await svc.grant('bob', 'run', { ttlMs: 600_000 })
    let n = 0
    const real = fake.exec
    const flaky: typeof real = async (c, a, o) => (a[0] === 'exec' && o?.input?.includes('"revoke"') && n++ === 0 ? fail('Error: blip') : real(c, a, o))
    const svc2 = make({ exec: flaky })
    expect(await svc2.revoke(g.id)).toEqual([])
    expect(fake.daemon).not.toBeNull()
    expect(fake.proxy.health().credentials).toBe(0)
    void svc
  })
  it('review B3: each credential carries its lifetime (run from the caller, build and probe defaults)', async () => {
    const svc = make()
    const ttl = () => (JSON.parse(fake.inputs.filter((i) => i.includes('"grant"')).at(-1)!) as { credential: { ttlMs: number } }).credential.ttlMs
    await svc.grant('bob', 'run', { ttlMs: 123_456 })
    expect(ttl()).toBe(123_456)
    await svc.grant('bob', 'build')
    expect(ttl()).toBe(BUILD_TTL_MS)
    expect(BUILD_TTL_MS).toBe(BUILD_TIMEOUT_MS + 60_000)
    await svc.grant(PROBE_SLUG, 'probe')
    expect(ttl()).toBe(PROBE_TTL_MS)
    expect(PROBE_TTL_MS).toBe(90_000)
  })
  it('review B3: the first contact of a BE process revokes credentials left by an earlier one (once)', async () => {
    const old = make()
    const g = await old.grant('bob', 'run', { ttlMs: 600_000 })
    expect(fake.proxy.health().credentials).toBe(1)
    const fresh = make()
    await fresh.available()
    expect(fake.proxy.health().credentials).toBe(0)
    expect(logs).toContain('egress: revoked 1 credential(s) left from before this start')
    await fresh.grant('bob', 'run', { ttlMs: 600_000 })
    await fresh.available()
    expect(fake.proxy.health().credentials).toBe(1)
    expect(fake.inputs.filter((i) => i.includes('"revokeAll"'))).toHaveLength(2)
    void g
  })
  it('review S1: settings are re-sent when the proxy restarted (health hash), and when they change', async () => {
    let hostAddresses = ['192.0.2.10']
    const svc = make({ config: () => ({ hostAddresses }) })
    await svc.available()
    const pushes = () => fake.inputs.filter((i) => i.includes('"op":"config"')).length
    expect(pushes()).toBe(1)
    await svc.available()
    expect(pushes()).toBe(1)
    fake.stop()
    await svc.available()
    expect(fake.proxy.health().configured).toBe(true)
    expect(pushes()).toBe(2)
    hostAddresses = ['192.0.2.11']
    await svc.available()
    expect(pushes()).toBe(3)
    expect(logs).toContain('egress: sending the proxy its new settings')
  })
  it('removeNetwork disconnects the proxy then removes the network; a missing one is fine', async () => {
    const svc = make()
    await svc.grant('bob', 'run')
    await svc.removeNetwork('bob')
    expect(fake.networks.has('ac-egress-bob')).toBe(false)
    await svc.removeNetwork('bob')
    expect(logs.filter((l) => l.includes('remove ac-egress-bob'))).toEqual([])
  })
  it('refuses odd network names', async () => {
    await expect(make().grant('Bad Name', 'run')).rejects.toBeInstanceOf(EgressUnavailableError)
  })
})

describe('connectCheck (the probe\'s CONNECT half)', () => {
  it('passes on 407 / 403 / no direct route, on the probe\'s own network, and revokes its credential', async () => {
    const svc = make()
    const r = await svc.connectCheck()
    expect(r.status).toBe('pass')
    const run = fake.calls.find((c) => c[0] === 'run' && c.includes('--rm') && !c.includes('nft'))!
    expect(run[run.indexOf('--network') + 1]).toBe(egressNetworkName(PROBE_SLUG))
    expect(run).toEqual(expect.arrayContaining(['--read-only', '--cap-drop', 'ALL']))
    expect(fake.inputs.some((i) => i.includes('"op":"revoke"'))).toBe(true)
    // Review S2: the probe's credential goes in on stdin (-i), never argv or --env.
    expect(run).toContain('-i')
    expect(run.join(' ')).not.toMatch(/P_AUTH|ac[0-9a-f]{18}:/)
    const grantIn = JSON.parse(fake.inputs.find((i) => i.includes('"op":"grant"'))!) as { credential: { id: string; secret: string } }
    expect(fake.inputs).toContain(`${grantIn.credential.id}:${grantIn.credential.secret}\n`)
    expect(CONNECT_CHECK_SCRIPT).toContain('process.stdin')
    expect(CONNECT_CHECK_SCRIPT).not.toContain('P_AUTH')
  })
  it('fails with a reason on a direct route or a wrong status', async () => {
    fake.state.probeOut = '{"noAuth":"200","blocked":"403","direct":"connected"}'
    const r = await make().connectCheck()
    expect(r.status).toBe('fail')
    expect(r.message).toMatch(/expected 407.*direct connection/)
  })
  it('fails when the proxy can\'t start', async () => {
    fake.state.runFails = true
    expect(await make().connectCheck()).toMatchObject({ status: 'fail', message: expect.stringMatching(/isn't available/) })
  })
  it('passes runtime flags before run (gVisor)', async () => {
    await make().connectCheck({ runtimeFlags: ['--runtime', 'runsc'] })
    expect(fake.calls.find((c) => c.includes('--rm') && !c.includes('nft'))!.slice(0, 3)).toEqual(['--runtime', 'runsc', 'run'])
  })
})

describe('firewall (nftables layer under the proxy)', () => {
  const fwRuns = () => fake.calls.filter((c) => c[0] === 'run' && c.includes('nft') && c.includes('-f'))
  it('loads the table into the proxy\'s namespace with a NET_ADMIN-only helper, before the settings go out', async () => {
    const order: string[] = []
    const svc = make({ exec: async (c, a, o) => {
      if (a.includes('nft')) order.push('firewall')
      if (o?.input?.includes('"op":"config"')) order.push('config')
      return fake.exec(c, a, o)
    } })
    await svc.available()
    expect(order).toEqual(['firewall', 'config'])
    expect(fwRuns()).toHaveLength(1)
    const r = fwRuns()[0]!
    expect(r[r.indexOf('--network') + 1]).toBe(`container:${EGRESS_DAEMON_NAME}`)
    expect(r.join(' ')).toContain('--cap-drop ALL --cap-add NET_ADMIN')
    expect(r).toEqual(expect.arrayContaining(['--rm', '-i', '--pull=never', '--read-only', 'no-new-privileges', '--entrypoint', 'nft', 'localhost/agentcontrol/egressd-nft:1.0.0', '-f', '-']))
    expect(r.join(' ')).not.toMatch(/--privileged|--network[= ]host|NET_RAW|SYS_ADMIN/)
    // The proxy itself keeps no capabilities.
    const d = fake.daemon!.args
    expect(d[d.indexOf('--cap-drop') + 1]).toBe('ALL')
    expect(d).not.toContain('--cap-add')
    const ruleset = [...fake.state.tables.values()][0]!
    // This computer's address, local model server, DNS through the outbound gateway only.
    expect(ruleset).toContain('192.0.2.10')
    expect(ruleset).toMatch(/set dns4 \{[^}]*elements = \{ [^}]*10\.89\.0\.1/)
    expect(logs).toContain('egress: loaded the proxy\'s firewall rules')
  })
  it('loads it again after a restart (new StartedAt) or when the ranges change, not otherwise', async () => {
    let hostAddresses = ['192.0.2.10']
    const svc = make({ config: () => ({ hostAddresses }) })
    await svc.available()
    await svc.available()
    expect(fwRuns()).toHaveLength(1)
    fake.stop()
    await svc.available()
    expect(fwRuns()).toHaveLength(2)
    expect(fake.state.tables.get(fake.daemon!.startedAt)).toBeDefined()
    hostAddresses = ['192.0.2.11']
    await svc.available()
    expect(fwRuns()).toHaveLength(3)
    expect(fake.state.tables.get(fake.daemon!.startedAt)).toContain('192.0.2.11')
    expect(logs).toContain('egress: updated the proxy\'s firewall rules')
  })
  it('the test allow list never reaches the firewall table', async () => {
    await make({ config: () => ({ hostAddresses: [], testAllow: ['10.89.251.10/32'] }) }).available()
    expect([...fake.state.tables.values()][0]).not.toContain('10.89.251.10')
    expect([...fake.state.tables.values()][0]).toContain('10.0.0.0/8')
  })
  it('no table, no internet: a load failure is 409 proxy_unavailable and the settings are not sent', async () => {
    fake.state.fwFails = true
    const svc = make()
    const e = await svc.grant('bob', 'run').catch((x: unknown) => x)
    expect(e).toBeInstanceOf(EgressUnavailableError)
    expect(e).toMatchObject({ reason: 'proxy_unavailable', statusCode: 409 })
    expect((e as EgressUnavailableError).detail).toBe('couldn\'t load the proxy\'s firewall rules: Error: Could not process rule: Operation not permitted')
    expect(fake.inputs.some((i) => i.includes('"op":"config"'))).toBe(false)
    expect(fake.proxy.health().configured).toBe(false)
    // Fixed: the next try loads it.
    fake.state.fwFails = false
    expect((await svc.grant('bob', 'run')).id).toMatch(/^ac/)
  })
  it('a missing helper image says how to build it', async () => {
    fake.state.fwImage = false
    const r = await make().available()
    expect(r).toEqual({ ok: false, message: 'the proxy\'s firewall helper image localhost/agentcontrol/egressd-nft:1.0.0 isn\'t built yet (vm/build-images.sh --only egressd-nft)' })
  })
  it('the probe checks the table is there and says so; it fails when it is gone', async () => {
    const svc = make()
    const r = await svc.connectCheck()
    expect(r).toEqual({ status: 'pass', message: 'Internet goes only through the proxy (407 without a credential, 403 for this computer, no direct route), and the proxy\'s firewall rules are loaded.' })
    expect(fake.calls.some((c) => c.includes('nft') && c.slice(-4).join(' ') === 'list table inet ac_egressd')).toBe(true)
    fake.state.tables.clear()
    const gone = await svc.connectCheck()
    expect(gone.status).toBe('fail')
    expect(gone.message).toMatch(/the firewall rules aren't loaded \(Error: No such file or directory/)
  })
  it('review B2: the probe says when the test allow list is active', async () => {
    const r = await make({ config: () => ({ hostAddresses: [], testAllow: ['10.89.251.10/32'] }) }).connectCheck()
    expect(r.status).toBe('pass')
    expect(r.message).toMatch(/ Test allow list active \(AC_EGRESS_TEST_ALLOW: 10\.89\.251\.10\/32\)\.$/)
  })
})

describe('helpers', () => {
  it('proxyEnv sets both cases, pip and npm, and clears NO_PROXY', () => {
    const env = Object.fromEntries(proxyEnv('http://u:p@10.89.1.2:3128').map((e) => [e.name, e.value]))
    for (const n of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'PIP_PROXY', 'npm_config_proxy', 'npm_config_https_proxy']) expect(env[n]).toBe('http://u:p@10.89.1.2:3128')
    expect(env.NO_PROXY).toBe('')
    expect(env.no_proxy).toBe('')
  })
  it('capHostContacts: blocked first in first-seen order, at most 200, total only when cut', () => {
    const row = (host: string, blocked: boolean): HostContact => ({ host, count: 1, blocked, ...(blocked ? { reason: 'home_network' as const } : {}) })
    expect(capHostContacts([row('a', false), row('b', true), row('c', false), row('d', true)])).toEqual({ hosts: [row('b', true), row('d', true), row('a', false), row('c', false)] })
    const many = [...Array.from({ length: 250 }, (_, i) => row(`ok${i}`, false)), row('late-blocked', true)]
    const cut = capHostContacts(many)
    expect(cut.hosts).toHaveLength(200)
    expect(cut.hosts[0]!.host).toBe('late-blocked')
    expect(cut.total).toBe(251)
  })
  it('modelServersOf: openai-compatible endpoints plus the BE\'s HOST:PORT', () => {
    const eps = [
      { kind: 'openai-compatible', baseUrl: 'http://192.168.1.50:11434/v1' },
      { kind: 'openai-compatible', baseUrl: 'https://llm.example.com/v1' },
      { kind: 'openai-compatible', baseUrl: 'http://[fd00::5]:8000' },
      { kind: 'xai', baseUrl: 'https://api.x.ai/v1' },
      { kind: 'openai-compatible', baseUrl: 'not a url' },
    ]
    expect(modelServersOf(eps, { PORT: '3001' })).toEqual([
      { host: '192.168.1.50', port: 11434 },
      { host: 'llm.example.com', port: 443 },
      { host: 'fd00::5', port: 8000 },
      { host: '127.0.0.1', port: 3001, always: true },
    ])
    expect(modelServersOf([], { HOST: '0.0.0.0' })).toEqual([])
  })
  it('testAllowFromEnv is empty unless set', () => {
    expect(testAllowFromEnv({ NODE_ENV: 'test' })).toEqual([])
    expect(testAllowFromEnv({ NODE_ENV: 'test', AC_EGRESS_TEST_ALLOW: '10.89.0.0/24, 10.89.1.5/32' })).toEqual(['10.89.0.0/24', '10.89.1.5/32'])
    expect(testAllowFromEnv({ AC_VM_TESTS: '1', AC_EGRESS_TEST_ALLOW: '10.89.0.0/24' })).toEqual(['10.89.0.0/24'])
  })
  it('review B2: ignored outside test runs, with one warning', () => {
    resetTestAllowWarning()
    const warned: string[] = []
    for (const env of [{ AC_EGRESS_TEST_ALLOW: '10.89.0.0/24' }, { NODE_ENV: 'production', AC_EGRESS_TEST_ALLOW: '10.89.0.0/24' }, { AC_VM_TESTS: '0', AC_EGRESS_TEST_ALLOW: '10.89.0.0/24' }]) {
      expect(testAllowFromEnv(env, (m) => warned.push(m))).toEqual([])
    }
    expect(warned).toHaveLength(1)
    expect(warned[0]).toMatch(/AC_EGRESS_TEST_ALLOW is set but ignored: it only works in test runs/)
    resetTestAllowWarning()
  })
  it('review B2: entries wider than /24 or /120 are dropped, with a warning', () => {
    resetTestAllowWarning()
    const warned: string[] = []
    expect(testAllowFromEnv({ NODE_ENV: 'test', AC_EGRESS_TEST_ALLOW: '10.0.0.0/8,10.89.0.0/24,fd00::/64,fd00::/120,nonsense' }, (m) => warned.push(m))).toEqual(['10.89.0.0/24', 'fd00::/120'])
    expect(warned[0]).toMatch(/ignored 10\.0\.0\.0\/8, fd00::\/64, nonsense/)
    resetTestAllowWarning()
  })
  it('the app dir lands under stateDir', async () => {
    await make().available()
    expect(existsSync(join(dir, 'egressd'))).toBe(true)
  })
})

describe('BE-P2-13: local addresses from /proc (interfaces that are down still count)', () => {
  const fib = `Main:
  +-- 0.0.0.0/0 3 0 5
     |-- 0.0.0.0
        /0 universe UNICAST
     +-- 127.0.0.0/8 2 0 2
        |-- 127.0.0.1
           /32 host LOCAL
     |-- 172.17.0.1
        /32 host LOCAL
     |-- 172.17.255.255
        /32 link BROADCAST
`
  const v6 = `00000000000000000000000000000001 01 80 10 80       lo
fe80000000000000802b38fffe3dbcd0 02 40 20 80   enp0s3
`
  it('reads LOCAL IPv4 entries and every IPv6 address', () => {
    expect(localAddressesFromProc(fib, v6)).toEqual(['127.0.0.1', '172.17.0.1', '0:0:0:0:0:0:0:1', 'fe80:0:0:0:802b:38ff:fe3d:bcd0'])
    expect(localAddressesFromProc(null, null)).toEqual([])
  })
  const route = `Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT
enp0s3\t00000000\t0101A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0
enp0s3\t0001A8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0
`
  const v6route = `00000000000000000000000000000000 00 00000000000000000000000000000000 00 fe800000000000000000000000000001 00000400 00000001 00000000 00000003 enp0s3
fe800000000000000000000000000000 40 00000000000000000000000000000000 00 00000000000000000000000000000000 00000100 00000001 00000000 00000001 enp0s3
`
  it('review S5: reads the default gateways (IPv4 little-endian, IPv6)', () => {
    expect(defaultGatewaysFromProc(route, v6route)).toEqual(['192.168.1.1', 'fe80:0:0:0:0:0:0:1'])
    expect(defaultGatewaysFromProc(null, null)).toEqual([])
  })
  it('hostInterfaceAddresses merges them in, and the rules treat them as this computer', () => {
    const all = hostInterfaceAddresses((f) => (f.endsWith('fib_trie') ? fib : f.endsWith('if_inet6') ? v6 : f.endsWith('ipv6_route') ? v6route : route))
    expect(all).toContain('192.168.1.1')
    expect(createEgressRules({ hostAddresses: all }).checkAddress('192.168.1.1', 80)).toMatchObject({ ok: false, reason: 'this_computer' })
    expect(all).toContain('172.17.0.1')
    expect(createEgressRules({ hostAddresses: all }).checkAddress('172.17.0.1', 80)).toMatchObject({ ok: false, reason: 'this_computer' })
  })
})

describe('BE-P2-13: the probe script', () => {
  it('is valid JavaScript as passed to node -e (escapes survive)', () => {
    expect(() => new Function(CONNECT_CHECK_SCRIPT)).not.toThrow()
    expect(CONNECT_CHECK_SCRIPT).toContain(String.raw`/^HTTP\/1\.[01] (\d{3})/`)
    expect(CONNECT_CHECK_SCRIPT).toContain(String.raw`HTTP/1.1\r\nHost`)
  })
})

describe('review item 7: user-only CIDRs from the networks AgentControl uses', () => {
  it('the subnets of its own networks; gvproxy only on the Podman machine; slirp only when slirp is in use', async () => {
    const svc = make()
    expect(svc.userOnlyCidrs()).toEqual([])
    await svc.grant('analyst', 'run')
    expect(fake.calls.some((c) => c[0] === 'network' && c[1] === 'ls' && c.includes('label=io.agentcontrol.egress'))).toBe(true)
    expect(svc.userOnlyCidrs()).toEqual(['10.89.100.0/24', '10.89.101.0/24'])
    expect(svc.userOnlyCidrs()).not.toContain('192.168.127.0/24')
    expect(svc.userOnlyCidrs()).not.toContain('10.0.2.0/24')

    const mac = make({ engine: async () => ({ cli: 'podman', globalArgs: ['--connection', 'agentcontrol'] }) })
    await mac.refreshSubnets()
    expect(mac.userOnlyCidrs()).toContain('192.168.127.0/24')

    fake.state.rootlessNet = 'slirp4netns'
    const slirpOff = make()
    await slirpOff.refreshSubnets()
    expect(slirpOff.userOnlyCidrs()).not.toContain('10.0.2.0/24')
    const slirpOn = make({ defaultNetworkInUse: () => true })
    await slirpOn.refreshSubnets()
    expect(slirpOn.userOnlyCidrs()).toContain('10.0.2.0/24')
    fake.state.rootlessNet = 'pasta'
    const pasta = make({ defaultNetworkInUse: () => true })
    await pasta.refreshSubnets()
    expect(pasta.userOnlyCidrs()).not.toContain('10.0.2.0/24')
  })
  it('an engine error keeps the last list and logs the cause', async () => {
    const svc = make()
    await svc.grant('analyst', 'run')
    const before = svc.userOnlyCidrs()
    fake.state.lsFails = true
    await svc.refreshSubnets()
    expect(svc.userOnlyCidrs()).toEqual(before)
    expect(logs.join('\n')).toMatch(/user_only: couldn't read the subnets of AgentControl's networks.*engine gone/)
  })
})
