import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from './app.js'
import type { BotEnvService } from './bot-env.js'
import type { CommandRunner } from './command-runner.js'
import { EgressUnavailableError, type EgressGrant, type EgressService } from './egress-service.js'
import { EGRESS_VIA } from './egressd.js'
import { createContainerRunner, NETWORK_UNAVAILABLE } from './podman-runner.js'
import type { ResolvedRuntime } from './runtime-probe.js'
import type { RunScriptRequest } from './runner.js'
import type { HostContact } from './shared/types.js'
import { createStore } from './store.js'
import type { StreamRunner } from './stream-runner.js'
import { createUserOnlyCheck, USER_ONLY_MESSAGE } from './user-only.js'
import { defaultAgentVm } from './vm-defaults.js'
import type { Agent } from './shared/types.js'

/** BE-P2-13: the runner's online path and the user-only wall, without an engine. */

const agent = { id: 'ag1', slug: 'analyst', name: 'Analyst', vm: defaultAgentVm() } as unknown as Agent
const crun: ResolvedRuntime = { effective: 'crun', status: 'incompatible_fallback', mode: 'inherit', globalMode: 'auto', limitsEnforced: true }
const SECRET = 'f'.repeat(48)
const URL_ = `http://ac1:${SECRET}@10.89.3.2:3128`
const grantOf = (): EgressGrant => ({ id: 'g1', network: 'ac-egress-analyst', proxyAddress: '10.89.3.2', env: [{ name: 'HTTPS_PROXY', value: URL_ }], secrets: [URL_, SECRET] } as EgressGrant)

function setup(o: { egress?: Partial<EgressService> | null; out?: string; ensureThrows?: boolean } = {}) {
  const streamed: string[][] = []
  const chunks: string[] = []
  const stream: StreamRunner = (cmd, args, opts) => {
    streamed.push([cmd, ...args])
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
  return { runner, streamed, botEnv, egress: egress as unknown as { grant: ReturnType<typeof vi.fn>; revoke: ReturnType<typeof vi.fn> }, chunks }
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
    expect(s.egress.grant).toHaveBeenCalledWith('analyst', 'run')
    expect(s.botEnv.ensure).toHaveBeenCalledWith(agent, { start: true, forRun: true, network: 'egress' })
    expect(s.streamed[0]!.join(' ')).toContain(`HTTPS_PROXY=${URL_}`)
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
  const c = createUserOnlyCheck()
  it('container addresses, the machine gateway subnet and the proxy\'s Via are refused', () => {
    for (const ip of ['10.88.0.5', '10.89.3.2', '::ffff:10.89.0.2', '192.168.127.1', '10.0.2.2']) expect(c.check(ip, {})).not.toBeNull()
    expect(c.check('127.0.0.1', { via: `1.1 something, ${EGRESS_VIA}` })).toMatch(/proxy/)
    expect(c.check('127.0.0.1', { via: [EGRESS_VIA.toUpperCase()] })).not.toBeNull()
  })
  it('the user\'s own addresses pass', () => {
    for (const ip of ['127.0.0.1', '::1', '192.168.1.20', undefined]) expect(c.check(ip, {})).toBeNull()
    expect(c.check('127.0.0.1', { via: '1.1 corp-proxy' })).toBeNull()
  })
  it('extra CIDRs are added', () => {
    expect(createUserOnlyCheck(['172.30.0.0/16']).check('172.30.1.1', {})).not.toBeNull()
  })
})

describe('user-only hook (app)', () => {
  let dir: string
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  it('403 user_only on every /api route from the bot side; the user is unaffected', async () => {
    dir = mkdtempSync(join(tmpdir(), 'be13-app-'))
    const app = buildApp(createStore(join(dir, 'store.json')))
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
  })
})
