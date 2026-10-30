import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CommandResult, CommandRunner } from './command-runner.js'
import { capHostContacts, CONNECT_CHECK_SCRIPT, createEgressService, EGRESS_DAEMON_NAME, EgressUnavailableError, egressNetworkName, hostInterfaceAddresses, localAddressesFromProc, modelServersOf, PROBE_SLUG, PROXY_UNAVAILABLE, proxyEnv, testAllowFromEnv } from './egress-service.js'
import { createEgressProxy, handleCtl, type CtlRequest, type EgressProxy } from './egressd.js'
import type { HostContact } from './shared/types.js'
import { createEgressRules } from './egress-rules.js'

/** BE-P2-13: the BE side of the proxy against a fake Podman whose `exec … ctl` talks to a real in-process proxy. */

const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' })
const fail = (stderr: string, code = 125): CommandResult => ({ code, stdout: '', stderr })

function fakePodman() {
  const calls: string[][] = []
  const inputs: string[] = []
  const networks = new Map<string, string[]>()
  let daemon: { running: boolean; hash: string; nets: Record<string, string>; args: string[] } | null = null
  let proxy: EgressProxy = createEgressProxy()
  let nextIp = 2
  const state = { ctlDown: false, runFails: false, probeOut: '{"noAuth":"407","blocked":"403","direct":"error:ENETUNREACH"}' }
  const exec: CommandRunner = async (cmd, args, opts) => {
    const a = [...args]
    calls.push(a)
    if (opts?.input !== undefined) inputs.push(opts.input)
    const flag = (n: string) => a[a.indexOf(n) + 1]
    const [verb, sub] = a
    if (verb === 'container' && sub === 'inspect') {
      if (!daemon) return fail('Error: no such container ac-egressd')
      return ok(`${daemon.running}|${daemon.hash}|${JSON.stringify(Object.fromEntries(Object.entries(daemon.nets).map(([k, v]) => [k, { IPAddress: v }])))}\n`)
    }
    if (verb === 'network' && sub === 'exists') return networks.has(a[2]!) ? ok() : fail('', 1)
    if (verb === 'network' && sub === 'create') {
      networks.set(a[a.length - 1]!, a)
      return ok()
    }
    if (verb === 'network' && sub === 'connect') {
      daemon!.nets[a[2]!] = `10.89.${nextIp++}.2`
      return ok()
    }
    if (verb === 'network' && sub === 'disconnect') {
      if (daemon) delete daemon.nets[a[3]!]
      return ok()
    }
    if (verb === 'network' && sub === 'rm') return networks.delete(a[2]!) ? ok() : fail('Error: unable to find network')
    if (verb === 'rm') {
      daemon = null
      proxy = createEgressProxy()
      return ok()
    }
    if (verb === 'start') {
      daemon!.running = true
      return ok()
    }
    if (verb === 'run' && a.includes('--detach')) {
      if (state.runFails) return fail('Error: image not known')
      const hash = a.find((x) => x.startsWith('io.agentcontrol.egressd.hash='))!.split('=')[1]!
      daemon = { running: true, hash, nets: { [flag('--network')!]: '10.89.0.2' }, args: a }
      return ok('id\n')
    }
    if (verb === 'run' && a.includes('--rm')) return ok(`${state.probeOut}\n`)
    if (verb === 'exec') {
      if (state.ctlDown || !daemon?.running) return fail('Error: can only exec into running containers')
      try {
        const out = handleCtl(proxy, JSON.parse(opts!.input!) as CtlRequest) as { ok?: boolean }
        return ok(`${JSON.stringify({ ok: true, ...out })}\n`)
      } catch (err) {
        return { code: 1, stdout: `${JSON.stringify({ ok: false, error: (err as Error).message })}\n`, stderr: '' }
      }
    }
    return fail(`fake: unexpected ${a.join(' ')}`)
  }
  return { exec, calls, inputs, networks, state, get daemon() { return daemon }, get proxy() { return proxy }, stop() { if (daemon) daemon.running = false } }
}

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
    const runs = () => fake.calls.filter((c) => c[0] === 'run').length
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
    expect(g.secrets).toContain(url)
    expect(g.secrets.every((s) => url.includes(s))).toBe(true)
    // The secret goes over stdin, never argv.
    const secret = g.secrets[0]!
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
  it('revoke is best effort: [] and a log line when the proxy is gone', async () => {
    const svc = make()
    const g = await svc.grant('bob', 'run')
    fake.state.ctlDown = true
    expect(await svc.revoke(g.id)).toEqual([])
    expect(await svc.hosts(g.id)).toEqual([])
    expect(logs.some((l) => l.includes('revoking'))).toBe(true)
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
    const run = fake.calls.find((c) => c[0] === 'run' && c.includes('--rm'))!
    expect(run[run.indexOf('--network') + 1]).toBe(egressNetworkName(PROBE_SLUG))
    expect(run).toEqual(expect.arrayContaining(['--read-only', '--cap-drop', 'ALL']))
    expect(fake.inputs.some((i) => i.includes('"op":"revoke"'))).toBe(true)
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
    expect(fake.calls.find((c) => c.includes('--rm'))!.slice(0, 3)).toEqual(['--runtime', 'runsc', 'run'])
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
      { host: '127.0.0.1', port: 3001 },
    ])
    expect(modelServersOf([], { HOST: '0.0.0.0' })).toEqual([])
  })
  it('testAllowFromEnv is empty unless set', () => {
    expect(testAllowFromEnv({})).toEqual([])
    expect(testAllowFromEnv({ AC_EGRESS_TEST_ALLOW: '10.89.0.0/24, 10.89.1.5/32' })).toEqual(['10.89.0.0/24', '10.89.1.5/32'])
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
  it('hostInterfaceAddresses merges them in, and the rules treat them as this computer', () => {
    const all = hostInterfaceAddresses((f) => (f.endsWith('fib_trie') ? fib : v6))
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
