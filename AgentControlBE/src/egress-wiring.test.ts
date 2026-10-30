import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from './app.js'
import type { BotEnvService } from './bot-env.js'
import type { CommandRunner } from './command-runner.js'
import { credentialForms, EgressUnavailableError, type EgressGrant, type EgressService } from './egress-service.js'
import { EGRESS_VIA } from './egressd.js'
import { createContainerRunner, NETWORK_UNAVAILABLE } from './podman-runner.js'
import type { ResolvedRuntime } from './runtime-probe.js'
import type { RunScriptRequest } from './runner.js'
import type { HostContact } from './shared/types.js'
import { createStore } from './store.js'
import type { StreamRunner } from './stream-runner.js'
import { createUserOnlyCheck, USER_ONLY_MESSAGE, userOnlyExtraCidrs } from './user-only.js'
import { defaultAgentVm } from './vm-defaults.js'
import { VM_LIMITS } from './shared/types.js'
import { BUILD_TIMEOUT_MS } from './bot-env.js'
import type { Agent } from './shared/types.js'

/** BE-P2-13: the runner's online path and the user-only wall, without an engine. */

const agent = { id: 'ag1', slug: 'analyst', name: 'Analyst', vm: defaultAgentVm() } as unknown as Agent
const crun: ResolvedRuntime = { effective: 'crun', status: 'incompatible_fallback', mode: 'inherit', globalMode: 'auto', limitsEnforced: true }
const SECRET = 'f'.repeat(48)
const URL_ = `http://ac1:${SECRET}@10.89.3.2:3128`
const BASIC = Buffer.from(`ac1:${SECRET}`).toString('base64')
const grantOf = (): EgressGrant => ({ id: 'ac1', slug: 'analyst', network: 'ac-egress-analyst', proxyAddress: '10.89.3.2', env: [{ name: 'HTTPS_PROXY', value: URL_ }], secret: SECRET, secrets: credentialForms('ac1', SECRET, URL_) })

function setup(o: { egress?: Partial<EgressService> | null; out?: string; ensureThrows?: boolean } = {}) {
  const streamed: string[][] = []
  const envs: (NodeJS.ProcessEnv | undefined)[] = []
  const chunks: string[] = []
  const stream: StreamRunner = (cmd, args, opts) => {
    streamed.push([cmd, ...args])
    envs.push(opts.env)
    let resolve!: (v: { code: number }) => void
    const done = new Promise<{ code: number }>((r) => (resolve = r))
    setImmediate(() => {
      if (o.out) opts.onStdout(Buffer.from(o.out))
      setImmediate(() => resolve({ code: 0 }))
    })
    return { done, kill: () => resolve({ code: 137 }) }
  }
  const exec: CommandRunner = async () => ({ code: 0, stdout: '', stderr: '' })
  const botEnv = {
    ensure: vi.fn(async () => {
      if (o.ensureThrows) throw new Error(`couldn't attach (${URL_})`)
      return agent.vm
    }),
    stop: vi.fn(async () => {}),
    exec: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
  } as unknown as BotEnvService & { ensure: ReturnType<typeof vi.fn> }
  const hosts: HostContact[] = [{ host: 'pypi.org', count: 2, blocked: false }, { host: '192.168.1.1', count: 1, blocked: true, reason: 'home_network' }]
  const egress = o.egress === null ? undefined : { grant: vi.fn(async () => grantOf()), revoke: vi.fn(async () => hosts), ...o.egress }
  const runner = createContainerRunner({
    botEnv, engine: async () => ({ cli: 'podman', globalArgs: [] }), getAgent: (id) => (id === agent.id ? agent : undefined),
    runtime: () => crun, stream, exec, env: {}, sleep: async () => {}, ...(egress ? { egress: egress as EgressService } : {}),
  })
  return { runner, streamed, envs, botEnv, egress: egress as unknown as { grant: ReturnType<typeof vi.fn>; revoke: ReturnType<typeof vi.fn> }, chunks }
}
const req = (over: Partial<RunScriptRequest> = {}): RunScriptRequest => ({ agentId: 'ag1', context: { kind: 'dm' }, argv: ['python3', 'main.py'], cwd: 'workspace', timeoutSec: 60, network: 'off', ...over })

describe('runner: network on', () => {
  it('without the user\'s grant (or without a proxy) it is refused before anything starts', async () => {
    const s = setup()
    expect((await s.runner.run(req({ network: 'on' }))).error).toBe(NETWORK_UNAVAILABLE)
    const s2 = setup({ egress: null })
    expect((await s2.runner.run(req({ network: 'on', internetGranted: true }))).error).toBe(NETWORK_UNAVAILABLE)
    expect(s.egress.grant).not.toHaveBeenCalled()
    expect(s.streamed).toEqual([])
  })
  it('granted: credential for this run, egress network, host log blocked first, revoked after', async () => {
    const s = setup()
    const onOutput = vi.fn()
    const r = await s.runner.run(req({ network: 'on', internetGranted: true, onOutput }))
    expect(r.outcome).toBe('succeeded')
    // Review B3: the credential lives for the run's limit (60 s here) plus a minute.
    expect(s.egress.grant).toHaveBeenCalledWith('analyst', 'run', { ttlMs: 120_000 })
    expect(s.botEnv.ensure).toHaveBeenCalledWith(agent, { start: true, forRun: true, network: 'egress' })
    // Review S2: the proxy URL is passed by name; its value is only in the engine's env.
    expect(s.streamed[0]!.join(' ')).not.toContain(SECRET)
    expect(s.streamed[0]!.join(' ')).toContain('--env HTTPS_PROXY ')
    expect(s.envs[0]?.HTTPS_PROXY).toBe(URL_)
    // Review B3: and the container is moved back to no network once the run is over.
    expect(s.botEnv.ensure).toHaveBeenLastCalledWith(agent, { forRun: true, network: 'none' })
    expect(s.egress.revoke).toHaveBeenCalledTimes(1)
    expect(r.hostsContacted?.map((h) => h.host)).toEqual(['192.168.1.1', 'pypi.org'])
    expect(r.hostsContactedTotal).toBeUndefined()
  })
  it('the credential never reaches stdout, the live log or an error', async () => {
    const s = setup({ out: `env: ${URL_}\n` })
    const live: string[] = []
    const r = await s.runner.run(req({ network: 'on', internetGranted: true, onOutput: (_w, b) => live.push(b.toString()) }))
    expect(r.stdout).not.toContain(SECRET)
    expect(live.join('')).not.toContain(SECRET)
    expect(JSON.stringify(r)).not.toContain(SECRET)
    const bad = await setup({ ensureThrows: true }).runner.run(req({ network: 'on', internetGranted: true }))
    expect(bad.error).toMatch(/couldn't start/)
    expect(JSON.stringify(bad)).not.toContain(SECRET)
  })
  it('review B4: a script that prints the Proxy-Authorization header (curl -v) shows *** instead, live and in the result', async () => {
    const out = `* Connected to 10.89.3.2 port 3128\n> CONNECT pypi.org:443 HTTP/1.1\n> Proxy-Authorization: Basic ${BASIC}\n> User-Agent: curl/8\nproxy=ac1:${SECRET}@10.89.3.2:3128 enc=${encodeURIComponent(SECRET)}\n`
    const s = setup({ out })
    const live: string[] = []
    const r = await s.runner.run(req({ network: 'on', internetGranted: true, onOutput: (_w, b) => live.push(b.toString()) }))
    for (const text of [r.stdout, live.join(''), JSON.stringify(r)]) {
      expect(text).not.toContain(SECRET)
      expect(text).not.toContain(BASIC)
    }
    expect(live.join('')).toContain('> Proxy-Authorization: Basic ***')
    expect(r.stdout).toContain('proxy=***')
  })
  it('review B3: the VM goes back to no network even when the run fails to start', async () => {
    const s = setup({ ensureThrows: true })
    await s.runner.run(req({ network: 'on', internetGranted: true }))
    expect(s.botEnv.ensure).toHaveBeenLastCalledWith(agent, { forRun: true, network: 'none' })
  })
  it('revoked when the run throws; proxy down is proxy_unavailable', async () => {
    const s = setup({ ensureThrows: true })
    await s.runner.run(req({ network: 'on', internetGranted: true }))
    expect(s.egress.revoke).toHaveBeenCalled()
    const down = setup({ egress: { grant: vi.fn(async () => { throw new EgressUnavailableError('ctl gone') }) } })
    const r = await down.runner.run(req({ network: 'on', internetGranted: true }))
    expect(r).toMatchObject({ outcome: 'failed', reason: 'proxy_unavailable' })
    expect(r.error).not.toMatch(/ctl gone/)
    expect(down.streamed).toEqual([])
  })
  it('an offline run moves the container back to none', async () => {
    const s = setup()
    await s.runner.run(req())
    expect(s.botEnv.ensure).toHaveBeenCalledWith(agent, { start: true, forRun: true, network: 'none' })
  })
})

describe('user-only', () => {
  const c = createUserOnlyCheck(['10.89.3.0/24', '192.168.127.0/24'])
  it('addresses in the given (AgentControl-created) subnets and the proxy\'s Via are refused', () => {
    for (const ip of ['10.89.3.2', '::ffff:10.89.3.9', '192.168.127.1']) expect(c.check(ip, {})).not.toBeNull()
    expect(c.check('127.0.0.1', { via: `1.1 something, ${EGRESS_VIA}` })).toMatch(/proxy/)
    expect(c.check('127.0.0.1', { via: [EGRESS_VIA.toUpperCase()] })).not.toBeNull()
  })
  it('the user\'s own addresses pass, including a LAN that merely looks like a Podman pool (item 7)', () => {
    for (const ip of ['127.0.0.1', '::1', '192.168.1.20', '10.88.0.5', '10.89.4.2', '10.0.2.2', undefined]) expect(c.check(ip, {})).toBeNull()
    expect(c.check('127.0.0.1', { via: '1.1 corp-proxy' })).toBeNull()
  })
  it('extra CIDRs are added; the list is read on every check; a bad entry is reported once', () => {
    expect(createUserOnlyCheck(['172.30.0.0/16']).check('172.30.1.1', {})).not.toBeNull()
    let list = ['10.89.5.0/24']
    const bad: string[] = []
    const d = createUserOnlyCheck(() => list, (x) => bad.push(x))
    expect(d.check('10.89.6.2', {})).toBeNull()
    list = ['10.89.5.0/24', '10.89.6.0/24', 'nope']
    expect(d.check('10.89.6.2', {})).not.toBeNull()
    d.check('10.89.6.3', {})
    list = ['nope', '10.89.6.0/24']
    d.check('10.89.6.3', {})
    expect(bad).toEqual(['nope'])
  })
  it('userOnlyExtraCidrs reads AC_USER_ONLY_EXTRA_CIDRS', () => {
    expect(userOnlyExtraCidrs({})).toEqual([])
    expect(userOnlyExtraCidrs({ AC_USER_ONLY_EXTRA_CIDRS: ' 172.30.0.0/16, ,10.5.0.0/24' })).toEqual(['172.30.0.0/16', '10.5.0.0/24'])
  })
})

describe('user-only hook (app)', () => {
  let dir: string
  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(dir, { recursive: true, force: true })
  })
  const fakeEgress = (cidrs: string[]) => ({ userOnlyCidrs: () => cidrs, refreshSubnets: async () => {} }) as unknown as EgressService
  it('403 user_only on every route from the bot side; the user is unaffected', async () => {
    dir = mkdtempSync(join(tmpdir(), 'be13-app-'))
    const app = buildApp(createStore(join(dir, 'store.json')), { egress: fakeEgress(['10.89.3.0/24', '10.88.0.0/16']) })
    try {
      for (const r of [
        { url: '/api/agents', remoteAddress: '10.89.3.2' },
        { url: '/api/permissions', remoteAddress: '10.88.0.7' },
        { url: '/api/agents', remoteAddress: '127.0.0.1', headers: { via: EGRESS_VIA } },
      ]) {
        const res = await app.inject({ method: 'GET', ...r })
        expect(res.statusCode).toBe(403)
        expect(res.json()).toEqual({ statusCode: 403, error: 'Forbidden', message: USER_ONLY_MESSAGE, reason: 'user_only' })
      }
      const post = await app.inject({ method: 'POST', url: '/api/agents', remoteAddress: '10.89.3.2', payload: { name: 'x' } })
      expect(post.statusCode).toBe(403)
      expect((await app.inject({ method: 'GET', url: '/api/agents', remoteAddress: '127.0.0.1' })).statusCode).toBe(200)
    } finally {
      await app.close()
    }
  })
  it('review B1: encoded paths, /health, static and unknown paths are refused too (any path, any encoding)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'be13-app-'))
    const app = buildApp(createStore(join(dir, 'store.json')), { egress: fakeEgress(['10.89.3.0/24']) })
    try {
      // The router decodes %61 to "a": this is GET /api/agents for the user.
      expect((await app.inject({ method: 'GET', url: '/%61pi/agents', remoteAddress: '127.0.0.1' })).statusCode).toBe(200)
      for (const url of ['/%61pi/agents', '/%2561pi/agents', '/%2561pi', '/api', '//api/agents', '/./api/agents', '/health', '/index.html', '/assets/app.js', '/nope']) {
        for (const r of [{ remoteAddress: '10.89.3.2' }, { remoteAddress: '127.0.0.1', headers: { via: EGRESS_VIA } }]) {
          const res = await app.inject({ method: 'GET', url, ...r })
          expect([url, res.statusCode]).toEqual([url, 403])
          expect(res.json()).toMatchObject({ reason: 'user_only' })
        }
      }
      expect((await app.inject({ method: 'GET', url: '/health', remoteAddress: '10.89.4.2' })).statusCode).toBe(200)
    } finally {
      await app.close()
    }
  })
  it('item 7: AC_USER_ONLY_EXTRA_CIDRS adds ranges; a bad entry is ignored', async () => {
    vi.stubEnv('AC_USER_ONLY_EXTRA_CIDRS', '172.30.0.0/16,bad')
    dir = mkdtempSync(join(tmpdir(), 'be13-app-'))
    const app = buildApp(createStore(join(dir, 'store.json')), { egress: fakeEgress([]) })
    try {
      expect((await app.inject({ method: 'GET', url: '/health', remoteAddress: '172.30.9.9' })).statusCode).toBe(403)
      expect((await app.inject({ method: 'GET', url: '/health', remoteAddress: '172.31.9.9' })).statusCode).toBe(200)
    } finally {
      await app.close()
    }
  })
})

describe('online tool build (run + commit through the proxy)', () => {
  it('credential on stdin only, internal network, base USER/ENTRYPOINT/CMD restored, labels set, revoked, container removed', async () => {
    const { createBotEnvService } = await import('./bot-env.js')
    const calls: { args: string[]; input?: string }[] = []
    const exec: CommandRunner = async (_cmd, args, opts) => {
      calls.push({ args: [...args], ...(opts?.input !== undefined ? { input: opts.input } : {}) })
      if (args[0] === 'image' && args[1] === 'inspect' && args.includes('{{json .Config}}')) return { code: 0, stdout: JSON.stringify({ User: '1000:1000', Entrypoint: ['/usr/bin/tini', '--'], Cmd: ['sleep', 'infinity'] }), stderr: '' }
      if (args[0] === 'run') return { code: 0, stdout: `Get:1 http://apt.example/ ./ Packages\nproxy is ${URL_}\n`, stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }
    const hosts: HostContact[] = [{ host: 'apt.example', count: 3, blocked: false }]
    const egress = { grant: vi.fn(async () => ({ ...grantOf(), env: [{ name: 'HTTP_PROXY', value: URL_ }] })), revoke: vi.fn(async () => hosts) }
    const svc = createBotEnvService({ exec, engine: async () => ({ cli: 'podman', globalArgs: [] }), mounts: () => [], saveVm: () => true, buildNetwork: () => 'egress', egress: egress as unknown as EgressService })
    const a = { ...agent, internetPolicy: 'ask' } as Agent
    const r = await svc.vmInstall(a, ['be13-hello'])
    expect(r.generation).toBe(1)
    expect(r.hostsContacted).toEqual(hosts)
    expect(r.log).not.toContain(SECRET)
    expect(calls.some((c) => c.args.join(' ').includes(SECRET))).toBe(false)
    const run = calls.find((c) => c.args[0] === 'run')!
    expect(run.input).toBe(`${URL_}\n`)
    expect(run.args[run.args.indexOf('--network') + 1]).toBe('ac-egress-analyst')
    expect(run.args).not.toContain('host')
    expect(run.args.slice(-2)).toEqual(['sh', 'be13-hello'])
    const commit = calls.find((c) => c.args[0] === 'commit')!.args
    expect(commit).toEqual(expect.arrayContaining(['USER 1000:1000', 'ENTRYPOINT ["/usr/bin/tini","--"]', 'CMD ["sleep","infinity"]', 'LABEL io.agentcontrol.packages="be13-hello"', 'LABEL io.agentcontrol.generation="1"']))
    expect(commit.at(-1)).toMatch(/analyst:1$/)
    expect(egress.revoke).toHaveBeenCalledTimes(1)
    expect(calls.filter((c) => c.args[0] === 'rm' && c.args.includes('ac-build-analyst-1')).length).toBe(2)
    // Review B3: a build credential lives for the build's limit plus a minute.
    expect(egress.grant).toHaveBeenCalledWith('analyst', 'build', { ttlMs: BUILD_TIMEOUT_MS + 60_000 })
    // Review S4: root with only apt's capabilities, and the bots' limits.
    const flags = run.args.join(' ')
    expect(flags).toContain('--cap-drop ALL --cap-add CHOWN,DAC_OVERRIDE,FOWNER,FSETID,SETUID,SETGID,SYS_CHROOT,KILL')
    expect(flags).toContain(`--memory ${VM_LIMITS.memoryMb}m --memory-swap ${VM_LIMITS.memoryMb}m --cpus ${VM_LIMITS.cpus} --pids-limit ${VM_LIMITS.pids}`)
  })
  it('item 2: a missing base image is M1\'s image_missing, word for word', async () => {
    const { createBotEnvService } = await import('./bot-env.js')
    const exec: CommandRunner = async (_cmd, args) => (args[0] === 'image' && args[1] === 'inspect' ? { code: 125, stdout: '', stderr: 'Error: image not known' } : { code: 0, stdout: '', stderr: '' })
    const egress = { grant: vi.fn(), revoke: vi.fn() }
    const svc = createBotEnvService({ exec, engine: async () => ({ cli: 'podman', globalArgs: [] }), mounts: () => [], saveVm: () => true, buildNetwork: () => 'egress', egress: egress as unknown as EgressService })
    const err = await svc.vmInstall({ ...agent, internetPolicy: 'ask' } as Agent, ['be13-hello']).catch((e: unknown) => e as Error & { statusCode: number; reason: string })
    expect(err).toMatchObject({ statusCode: 409, reason: 'image_missing' })
    expect((err as Error).message).toMatch(/^The bot image localhost\/agentcontrol\/botvm[^ ]* isn't built yet\. Finish the setup steps in Settings › VMs first\.$/)
    expect(egress.grant).not.toHaveBeenCalled()
  })
})
