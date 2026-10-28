import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CommandRunner } from './command-runner.js'
import { err, fakeEngine, ok } from './bot-env.fake.js'
import {
  BOT_ENV_LABELS,
  BOTVM_PATH,
  checkCwd,
  checkNetwork,
  createArgv,
  createArgvBody,
  createBotEnvService,
  envArgs,
  envListProblem,
  execArgv,
  layerContainerfile,
  type BotEnvDeps,
  type EngineRef,
} from './bot-env.js'
import { defaultAgentVm } from './vm-defaults.js'
import type { Agent, AgentVm } from './shared/types.js'
import { baseImageFor } from './vm-images.js'

/** BE-P2-4: argv builders and BotEnvService against a fake engine. */

function agent(vm: Partial<AgentVm> = {}): Agent {
  return { id: 'ag_1', slug: 'analyst', name: 'Analyst', internetPolicy: 'ask', vm: { ...defaultAgentVm(), ...vm } } as unknown as Agent
}

let version = '1.0.0'
let saved: AgentVm[] = []
let runs = 0
let buildNet: 'none' | 'default' = 'default'
function service(engine: ReturnType<typeof fakeEngine>, over: Partial<BotEnvDeps> = {}) {
  const ref: EngineRef = { cli: 'podman', globalArgs: [] }
  return createBotEnvService({
    exec: engine.exec,
    engine: async () => ref,
    baseVersion: () => version,
    mounts: () => [{ source: '/data/bots/analyst/workspace', target: '/bot/workspace', readonly: false }, { source: '/data/bots/analyst/shared', target: '/bot/shared', readonly: true }],
    saveVm: (_id, vm) => { saved.push(vm); return true },
    activeRuns: () => runs,
    buildNetwork: () => buildNet,
    now: () => new Date('2026-10-27T12:00:00Z'),
    ...over,
  })
}

beforeEach(() => {
  version = '1.0.0'
  saved = []
  runs = 0
  buildNet = 'default'
})

describe('BE-P2-5 uid mapping and mount guard', () => {
  const mounts = [{ source: '/d/ws', target: '/bot/workspace', readonly: false }, { source: '/d/in', target: '/bot/shared', readonly: true }]
  it('keep-id: --userns keep-id, U on both volumes, plain binds', () => {
    const s = createArgvBody({ slug: 'analyst', image: 'img', mounts, uidMapping: 'keep-id' }).join(' ')
    expect(s).toContain('--userns keep-id:uid=1000,gid=1000')
    expect(s).toContain('--mount type=volume,source=ac-tools-analyst,destination=/home/bot,U=true')
    expect(s).toContain('--mount type=volume,source=ac-opt-analyst,destination=/opt/bot,U=true')
    expect(s).toContain('type=bind,source=/d/ws,destination=/bot/workspace --mount')
    expect(s).toContain('type=bind,source=/d/in,destination=/bot/shared,readonly')
    expect(s).not.toContain('idmap')
  })
  it('idmap: --userns auto, idmapped binds (never U on a bind)', () => {
    const s = createArgvBody({ slug: 'analyst', image: 'img', mounts, uidMapping: 'idmap' }).join(' ')
    expect(s).toContain('--userns auto')
    expect(s).toContain('destination=/bot/workspace,idmap')
    expect(s).toContain('destination=/bot/shared,readonly,idmap')
    expect(s).toContain('destination=/home/bot,U=true')
    expect(s).not.toMatch(/type=bind[^ ]*U=true/)
  })
  it('none (Docker): no --userns, no U', () => {
    const s = createArgvBody({ slug: 'analyst', image: 'img', mounts, uidMapping: null }).join(' ')
    expect(s).not.toMatch(/--userns|U=true|idmap/)
  })
  it('the mapping is part of the config hash (a change recreates the container)', () => {
    const h = (m: 'idmap' | 'keep-id' | null) => createArgv({ slug: 'analyst', image: 'img', mounts, uidMapping: m }).configHash
    expect(new Set([h('idmap'), h('keep-id'), h(null)]).size).toBe(3)
  })
  it('ensure passes the mapping; a mapping change recreates with volumes kept', async () => {
    const e = fakeEngine()
    let m: 'idmap' | 'keep-id' = 'keep-id'
    const svc = service(e, { uidMapping: () => m })
    const a = agent()
    await svc.ensure(a)
    expect(e.calls.find((c) => c[0] === 'create')?.join(' ')).toContain('--userns keep-id:uid=1000,gid=1000')
    m = 'idmap'
    await svc.ensure(a)
    const creates = e.calls.filter((c) => c[0] === 'create')
    expect(creates).toHaveLength(2)
    expect(creates[1]!.join(' ')).toContain('--userns auto')
    expect(e.calls.some((c) => c[0] === 'volume' && c[1] === 'rm')).toBe(false)
  })
  it('a mount outside the allow-list throws before the engine is called', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-be5-guard-'))
    try {
      for (const d of ['a/workspace', 'a/shared', 'b/workspace']) mkdirSync(join(root, d), { recursive: true })
      const e = fakeEngine()
      const svc = service(e, {
        mounts: () => [{ source: join(root, 'b/workspace'), target: '/bot/workspace', readonly: false }],
        allowedMounts: () => ({ slug: 'analyst', workspace: join(root, 'a/workspace'), inputs: join(root, 'a/shared'), groups: {}, botRoot: join(root, 'a') }),
      })
      await expect(svc.ensure(agent(), { start: true })).rejects.toMatchObject({ statusCode: 500, reason: 'mount_refused' })
      await expect(svc.start(agent())).rejects.toMatchObject({ reason: 'mount_refused' })
      expect(e.calls).toEqual([])
      // The bot's own folders go through.
      const ok2 = service(e, {
        mounts: () => [{ source: join(root, 'a/workspace'), target: '/bot/workspace', readonly: false }],
        allowedMounts: () => ({ slug: 'analyst', workspace: join(root, 'a/workspace'), inputs: join(root, 'a/shared'), groups: {}, botRoot: join(root, 'a') }),
      })
      await ok2.ensure(agent())
      expect(e.calls.some((c) => c[0] === 'create')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('argv builders', () => {
  const mounts = [{ source: '/d/ws', target: '/bot/workspace', readonly: false }, { source: '/d/in', target: '/bot/shared', readonly: true }]

  it('create: fixed limits, read-only, no caps, uid 1000, network none, tmpfs, volumes and binds', () => {
    const argv = createArgvBody({ slug: 'analyst', image: 'localhost/ac-bot-analyst:1', mounts })
    const s = argv.join(' ')
    for (const f of ['--name ac-bot-analyst', '--user 1000:1000', '--read-only', '--cap-drop ALL', '--security-opt no-new-privileges', '--network none',
      '--memory 4096m', '--memory-swap 4096m', '--cpus 2', '--pids-limit 256', '--tmpfs /tmp:rw,nosuid,nodev,size=512m,mode=1777',
      '--mount type=volume,source=ac-tools-analyst,destination=/home/bot', '--mount type=volume,source=ac-opt-analyst,destination=/opt/bot',
      '--mount type=bind,source=/d/ws,destination=/bot/workspace --mount', 'source=/d/in,destination=/bot/shared,readonly', '--workdir /bot/workspace']) {
      expect(s).toContain(f)
    }
    expect(argv[0]).toBe('create')
    expect(argv[argv.length - 1]).toBe('localhost/ac-bot-analyst:1')
    expect(s).not.toMatch(/--env|--privileged|--network host|=host/)
    const noLimits = createArgvBody({ slug: 'analyst', image: 'x', mounts, enforceLimits: false, runtime: 'runsc', uidMapping: 'idmap' }).join(' ')
    expect(noLimits).not.toContain('--memory')
    expect(noLimits).toContain('--runtime runsc --userns auto')
  })

  it('network host is never allowed; only none or the bot\'s own egress network', () => {
    expect(checkNetwork('analyst', 'none')).toBe('none')
    expect(checkNetwork('analyst', 'ac-egress-analyst')).toBe('ac-egress-analyst')
    for (const n of ['host', 'bridge', 'ac-egress-other', 'slirp4netns', 'pasta']) {
      expect(() => checkNetwork('analyst', n)).toThrow(/refusing container network/)
      expect(() => createArgvBody({ slug: 'analyst', image: 'x', mounts, network: n })).toThrow(/refusing/)
    }
  })

  it('config hash label changes with the config', () => {
    const a = createArgv({ slug: 'analyst', image: 'x', mounts })
    const b = createArgv({ slug: 'analyst', image: 'x', mounts: [mounts[0]!] })
    expect(a.configHash).toMatch(/^[0-9a-f]{16}$/)
    expect(a.argv).toContain(`${BOT_ENV_LABELS.config}=${a.configHash}`)
    expect(a.argv[a.argv.length - 1]).toBe('x')
    expect(b.configHash).not.toBe(a.configHash)
  })

  it('rejects unsafe mount paths', () => {
    expect(() => createArgvBody({ slug: 'analyst', image: 'x', mounts: [{ source: '/d/a,b', target: '/bot/workspace', readonly: false }] })).toThrow(/unsafe mount/)
    expect(() => createArgvBody({ slug: 'analyst', image: 'x', mounts: [{ source: '/d', target: '/etc', readonly: false }] })).toThrow(/under \/bot/)
    expect(() => createArgvBody({ slug: '../x', image: 'x', mounts })).toThrow(/invalid bot slug/)
  })

  it('env: always NAME=VALUE, PATH_APPEND extends the image PATH, reserved names dropped', () => {
    const args = envArgs([
      { name: 'FOO', value: 'a b=c' },
      { name: 'EMPTY', value: '' },
      { name: 'PATH_APPEND', value: '/bot/workspace/bin:relative:/opt/x' },
      { name: 'HTTP_PROXY', value: 'http://evil' },
      { name: 'AC_TOKEN', value: 'x' },
      { name: 'home', value: '/' },
    ], [{ name: 'AC_RUN_ID', value: 'r1' }])
    expect(args).toEqual(['--env', 'FOO=a b=c', '--env', 'EMPTY=', '--env', `PATH=${BOTVM_PATH}:/bot/workspace/bin:/opt/x`, '--env', 'AC_RUN_ID=r1'])
    for (let i = 0; i < args.length; i += 2) expect(args[i + 1]).toContain('=')
  })

  it('envListProblem enforces names, reserved names, size, duplicates and shape', () => {
    expect(envListProblem([])).toBeNull()
    expect(envListProblem([{ name: 'FOO', value: 'x' }, { name: 'PATH_APPEND', value: '/a' }])).toBeNull()
    expect(envListProblem([{ name: 'HTTP_PROXY', value: 'x' }])).toMatch(/reserved/)
    expect(envListProblem([{ name: 'PATH', value: 'x' }])).toMatch(/PATH_APPEND/)
    expect(envListProblem([{ name: 'AC_X', value: 'x' }])).toMatch(/AC_/)
    expect(envListProblem([{ name: '1X', value: 'x' }])).toMatch(/valid variable name/)
    expect(envListProblem([{ name: 'A', value: 'x'.repeat(4097) }])).toMatch(/too long/)
    expect(envListProblem([{ name: 'A', value: 'x' }, { name: 'A', value: 'y' }])).toMatch(/twice/)
    expect(envListProblem([{ name: 'A', value: 1 }])).toMatch(/text/)
    expect(envListProblem([{ name: 'A', value: 'x', secret: true }])).toMatch(/Unknown field/)
    expect(envListProblem(Array.from({ length: 51 }, (_, i) => ({ name: `V${i}`, value: '' })))).toMatch(/At most 50/)
    expect(envListProblem({})).toMatch(/list/)
  })

  it('exec argv and cwd guard', () => {
    expect(execArgv({ slug: 'analyst', argv: ['python3', '-c', 'print(1)'], env: [{ name: 'FOO', value: '1' }] }))
      .toEqual(['exec', '--user', '1000:1000', '--workdir', '/bot/workspace', '--env', 'FOO=1', 'ac-bot-analyst', 'python3', '-c', 'print(1)'])
    expect(checkCwd('/bot/groups/team/sub')).toBe('/bot/groups/team/sub')
    for (const bad of ['/etc', '/bot/workspace/../../etc', '/bot', '/bot/skills', 'workspace']) expect(() => checkCwd(bad)).toThrow(/run cwd/)
    expect(() => execArgv({ slug: 'analyst', argv: [], env: [] })).toThrow(/empty/)
  })

  it('layer Containerfile carries from + packages labels', () => {
    const f = layerContainerfile('analyst', 2, 'base', ['jq', 'ffmpeg', 'jq'], '1.0.0')
    expect(f).toContain('FROM localhost/agentcontrol/botvm:1.0.0')
    expect(f).toContain('apt-get install -y --no-install-recommends ffmpeg jq')
    expect(f).toContain(`${BOT_ENV_LABELS.from}="localhost/agentcontrol/botvm:1.0.0" ${BOT_ENV_LABELS.packages}="ffmpeg jq"`)
  })
})

describe('BotEnvService (fake engine)', () => {
  it('ensure creates volumes and the container on the shared base (generation 0), start runs it; idempotent', async () => {
    const e = fakeEngine()
    const svc = service(e)
    const a = agent()
    expect((await svc.status(a)).state).toBe('missing')
    await svc.start(a)
    expect(e.volumes).toEqual(new Set(['ac-tools-analyst', 'ac-opt-analyst']))
    const c = e.containers.get('ac-bot-analyst')!
    expect(c.running).toBe(true)
    expect(c.imageId).toBe(e.images.get(baseImageFor('base', '1.0.0'))!.id)
    expect(c.argv).toContain('none')
    const creates = e.calls.filter((x) => x[0] === 'create').length
    await svc.ensure(a, { start: true })
    expect(e.calls.filter((x) => x[0] === 'create').length).toBe(creates)
    expect(e.calls.filter((x) => x[0] === 'rm').length).toBe(0)
    await svc.stop(a)
    expect(c.running).toBe(false)
    expect(saved).toEqual([])
  })

  it('global args (e.g. --connection agentcontrol) go on every call', async () => {
    const e = fakeEngine({ globalArgs: ['--connection', 'agentcontrol'] })
    const svc = service(e, { engine: async () => ({ cli: 'podman', globalArgs: ['--connection', 'agentcontrol'] }) })
    await svc.start(agent())
    expect(e.calls.length).toBeGreaterThan(3)
  })

  it('BE-P2-8: runtime flags go as global args on start, stop and exec (not create)', async () => {
    const e = fakeEngine()
    const seen: string[][] = []
    const FLAGS = ['--runtime-flag=ignore-cgroups', '--runtime-flag=network=none']
    const exec: CommandRunner = async (cmd, args) => {
      seen.push([...args])
      return e.exec(cmd, args.filter((x) => !x.startsWith('--runtime-flag=')))
    }
    const svc = service(e, { exec, runtime: () => 'runsc', runtimeFlags: () => FLAGS })
    await svc.start(agent())
    await svc.exec(agent(), ['true'])
    await svc.stop(agent())
    const withFlags = seen.filter((a) => a[0] === FLAGS[0]).map((a) => a[2])
    expect(withFlags).toEqual(['start', 'exec', 'stop'])
    const create = seen.find((a) => a[0] === 'create')!
    expect(create.join(' ')).toContain('--runtime runsc')
    expect(create.join(' ')).not.toContain('--runtime-flag')
  })

  it('BE-P2-8: EngineRef.command runs another program (e.g. sudo -n podman) with the global args', async () => {
    const e = fakeEngine()
    const exec: CommandRunner = async (cmd, args) => {
      expect(cmd).toBe('sudo')
      expect(args.slice(0, 2)).toEqual(['-n', 'podman'])
      return e.exec('podman', args.slice(2))
    }
    const svc = service(e, { exec, engine: async () => ({ cli: 'podman', command: 'sudo', globalArgs: ['-n', 'podman'] }) })
    await svc.start(agent())
    expect(e.calls.some((x) => x[0] === 'start')).toBe(true)
  })

  it('engine missing → 409 engine_missing; missing base image → 409 image_missing', async () => {
    const e = fakeEngine()
    await expect(service(e, { engine: async () => null }).start(agent())).rejects.toMatchObject({ statusCode: 409, reason: 'engine_missing' })
    await expect(service(e, { exec: async () => err('podman: not found', 127) }).start(agent())).rejects.toMatchObject({ statusCode: 409, reason: 'engine_missing' })
    version = '9.9.9'
    await expect(service(e).start(agent())).rejects.toMatchObject({ statusCode: 409, reason: 'image_missing' })
  })

  it('rebuild → gen 1, 2; container recreated on the new image at the next ensure, volumes kept; old gens pruned', async () => {
    const e = fakeEngine()
    const svc = service(e)
    const a = agent()
    await svc.start(a)
    const r1 = await svc.rebuild(a)
    expect(r1.generation).toBe(1)
    expect(a.vm.image).toEqual({ generation: 1, previous: 0, builtAt: '2026-10-27T12:00:00.000Z', base: 'base' })
    await svc.ensure(a, { start: true })
    expect(e.containers.get('ac-bot-analyst')!.imageId).toBe(e.images.get('localhost/ac-bot-analyst:1')!.id)
    expect(e.calls.some((x) => x[0] === 'volume' && x[1] === 'rm')).toBe(false)
    await svc.rebuild(a)
    await svc.rebuild(a)
    expect(a.vm.image).toMatchObject({ generation: 3, previous: 2 })
    await svc.ensure(a, { start: true })
    expect([...e.images.keys()].filter((k) => k.startsWith('localhost/ac-bot-analyst:')).sort()).toEqual(['localhost/ac-bot-analyst:2', 'localhost/ac-bot-analyst:3'])
  })

  it('a running container with an active run is not recreated until idle', async () => {
    const e = fakeEngine()
    const svc = service(e)
    const a = agent()
    await svc.start(a)
    await svc.rebuild(a)
    runs = 1
    await svc.ensure(a, { start: true })
    expect(e.calls.some((x) => x[0] === 'rm')).toBe(false)
    runs = 0
    await svc.ensure(a, { start: true })
    expect(e.calls.filter((x) => x[0] === 'rm')).toHaveLength(1)
  })

  it('base upgrade rebuilds the layer on the new base (packages kept), volumes untouched', async () => {
    const e = fakeEngine()
    const svc = service(e)
    const a = agent()
    await svc.start(a)
    await svc.rebuild(a)
    await svc.ensure(a, { start: true })
    version = '1.1.0'
    await svc.ensure(a, { start: true })
    expect(a.vm.image.generation).toBe(2)
    const img = e.images.get('localhost/ac-bot-analyst:2')!
    expect(img.labels[BOT_ENV_LABELS.from]).toBe(baseImageFor('base', '1.1.0'))
    expect(e.containers.get('ac-bot-analyst')!.imageId).toBe(img.id)
    expect(e.calls.some((x) => x[0] === 'volume' && x[1] === 'rm')).toBe(false)
  })

  it('a rolled-back generation stays on its older base until the next build', async () => {
    const e = fakeEngine()
    const svc = service(e)
    const a = agent()
    await svc.rebuild(a)
    version = '1.1.0'
    await svc.ensure(a, { start: true })
    expect(a.vm.image).toMatchObject({ generation: 2, previous: 1 })
    await svc.rollback(a)
    await svc.ensure(a, { start: true })
    expect(a.vm.image.generation).toBe(1)
    expect(e.containers.get('ac-bot-analyst')!.imageId).toBe(e.images.get('localhost/ac-bot-analyst:1')!.id)
    await svc.rebuild(a)
    expect(e.images.get('localhost/ac-bot-analyst:2')!.labels[BOT_ENV_LABELS.from]).toBe(baseImageFor('base', '1.1.0'))
  })

  it('base upgrade with a failing rebuild keeps the old layer', async () => {
    const e = fakeEngine()
    const svc = service(e)
    const a = agent()
    await svc.rebuild(a)
    const failing = service(e, { exec: async (c, args, o) => (args[0] === 'build' ? err('no network', 1) : e.exec(c, args, o)) })
    version = '1.1.0'
    await failing.ensure(a, { start: true })
    expect(a.vm.image.generation).toBe(1)
    expect(e.containers.get('ac-bot-analyst')!.imageId).toBe(e.images.get('localhost/ac-bot-analyst:1')!.id)
  })

  it('a config change (new group mount) recreates the container', async () => {
    const e = fakeEngine()
    let extra = false
    const svc = service(e, { mounts: () => [{ source: '/w', target: '/bot/workspace', readonly: false }, ...(extra ? [{ source: '/g', target: '/bot/groups/team', readonly: false }] : [])] })
    const a = agent()
    await svc.start(a)
    extra = true
    await svc.start(a)
    expect(e.calls.filter((x) => x[0] === 'rm')).toHaveLength(1)
    expect(e.containers.get('ac-bot-analyst')!.argv.join(' ')).toContain('destination=/bot/groups/team')
  })

  it('vm_install: validates, builds gen+1 with the packages, no-op when present; M1 without build network → 409', async () => {
    const e = fakeEngine()
    const svc = service(e)
    const a = agent()
    await expect(svc.vmInstall(a, ['Bad Name'])).rejects.toMatchObject({ statusCode: 400 })
    await expect(svc.vmInstall(a, [])).rejects.toMatchObject({ statusCode: 400 })
    await expect(svc.vmInstall(a, ['jq; rm -rf /'])).rejects.toMatchObject({ statusCode: 400 })
    const r = await svc.vmInstall(a, ['jq', 'ffmpeg'])
    expect(r.generation).toBe(1)
    expect(a.vm.packages).toEqual(['ffmpeg', 'jq'])
    expect(e.images.get('localhost/ac-bot-analyst:1')!.labels[BOT_ENV_LABELS.packages]).toBe('ffmpeg jq')
    const build = e.calls.find((x) => x[0] === 'build')!
    expect(build).toContain('--pull=never')
    expect(build.join(' ')).not.toContain('--network host')
    expect((await svc.vmInstall(a, 'jq')).log).toBe('Already installed.')
    buildNet = 'none'
    await svc.rebuild(agent()) // no packages: builds fine offline
    expect(e.calls.filter((x) => x[0] === 'build').pop()).toEqual(expect.arrayContaining(['--network', 'none']))
    await expect(svc.vmInstall(a, ['curl'])).rejects.toMatchObject({ statusCode: 409, reason: 'internet_unavailable', message: expect.stringMatching(/isn't available yet/) })
    buildNet = 'default'
    await expect(svc.vmInstall({ ...a, internetPolicy: 'never' } as Agent, ['curl'])).rejects.toMatchObject({ reason: 'internet_never' })
  })

  it('a failed build leaves the generation and packages alone and reports the last line', async () => {
    const e = fakeEngine({ failBuild: true })
    const svc = service(e)
    const a = agent()
    await expect(svc.vmInstall(a, ['nope'])).rejects.toMatchObject({ statusCode: 502, reason: 'build_failed', message: expect.stringMatching(/Unable to locate package nope/) })
    expect(a.vm.packages).toEqual([])
    expect(a.vm.image.generation).toBe(0)
    expect(saved).toEqual([])
  })

  it('rollback restores the previous generation and its packages, removes the newer image; 409 with none', async () => {
    const e = fakeEngine()
    const svc = service(e)
    const a = agent()
    await expect(svc.rollback(a)).rejects.toMatchObject({ statusCode: 409, reason: 'no_previous_generation' })
    await svc.vmInstall(a, ['jq'])
    await svc.vmInstall(a, ['ffmpeg'])
    await svc.start(a)
    runs = 1
    await expect(svc.rollback(a)).rejects.toMatchObject({ statusCode: 409, reason: 'run_active' })
    runs = 0
    await svc.rollback(a)
    expect(a.vm.packages).toEqual(['jq'])
    expect(a.vm.image).toMatchObject({ generation: 1 })
    expect(a.vm.image.previous).toBeUndefined()
    expect(e.containers.get('ac-bot-analyst')!.imageId).toBe(e.images.get('localhost/ac-bot-analyst:1')!.id)
    expect(e.containers.get('ac-bot-analyst')!.running).toBe(true)
    expect(e.images.has('localhost/ac-bot-analyst:2')).toBe(false)
    await expect(svc.rollback(a)).rejects.toMatchObject({ reason: 'no_previous_generation' })
    // Rolling back to generation 0 means the plain base with no packages.
    const b = agent()
    await svc.vmInstall(b, ['jq'])
    await svc.rollback(b)
    expect(b.vm.packages).toEqual([])
    expect(b.vm.image.generation).toBe(0)
  })

  it('reset (M1): container, both volumes and every layer gone; env kept; fresh stopped container on the base', async () => {
    const e = fakeEngine()
    const svc = service(e)
    const a = agent({ env: [{ name: 'FOO', value: 'bar' }] })
    await svc.vmInstall(a, ['jq'])
    await svc.vmInstall(a, ['ffmpeg'])
    await svc.start(a)
    a.vm = { ...a.vm, tools: { pip: ['x==1'], npm: [], optBin: [], updatedAt: 'now' } }
    runs = 1
    await expect(svc.reset(a)).rejects.toMatchObject({ statusCode: 409, reason: 'run_active' })
    runs = 0
    const volsBefore = e.calls.filter((x) => x[0] === 'volume' && x[1] === 'rm').length
    await svc.reset(a)
    expect(e.calls.filter((x) => x[0] === 'volume' && x[1] === 'rm').length - volsBefore).toBe(2)
    expect([...e.images.keys()].some((k) => k.includes('ac-bot-analyst'))).toBe(false)
    expect(a.vm).toMatchObject({ packages: [], image: { generation: 0, base: 'base' }, env: [{ name: 'FOO', value: 'bar' }] })
    expect(a.vm.tools).toBeUndefined()
    const c = e.containers.get('ac-bot-analyst')!
    expect(c.running).toBe(false)
    expect(c.imageId).toBe(e.images.get(baseImageFor('base', '1.0.0'))!.id)
    expect(e.volumes.size).toBe(2) // recreated empty
  })

  it('refreshTools reads pip, npm and /opt/bot/bin through exec with the bot env', async () => {
    const e = fakeEngine()
    e.execHandler.fn = (argv) => {
      const cmd = argv.slice(argv.indexOf('ac-bot-analyst') + 1)
      expect(argv).toContain('FOO=1')
      if (cmd[0] === 'python3') return ok('requests==2.32.0\ncowsay==6.1\n')
      if (cmd[0] === 'npm') return ok(JSON.stringify({ dependencies: { 'left-pad': { version: '1.3.0' } } }))
      if (cmd[0] === 'ls') return ok('tool\n')
      return err('?', 1)
    }
    const svc = service(e)
    const a = agent({ env: [{ name: 'FOO', value: '1' }] })
    await svc.refreshTools(a)
    expect(a.vm.tools).toEqual({ pip: ['cowsay==6.1', 'requests==2.32.0'], npm: ['left-pad@1.3.0'], optBin: ['tool'], updatedAt: '2026-10-27T12:00:00.000Z' })
  })

  it('serializes engine work per bot', async () => {
    const e = fakeEngine()
    let inFlight = 0
    let maxInFlight = 0
    const slow: CommandRunner = async (c, args, o) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 1))
      try { return await e.exec(c, args, o) } finally { inFlight-- }
    }
    const svc = service(e, { exec: slow })
    const a = agent()
    await Promise.all([svc.start(a), svc.start(a), svc.stop(a), svc.start(a)])
    expect(maxInFlight).toBe(1)
    expect(e.calls.filter((x) => x[0] === 'create')).toHaveLength(1)
  })
})

describe('tmp dirs', () => {
  let dir = ''
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ac-be4-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  it('build leaves no temp Containerfile behind', async () => {
    mkdirSync(join(dir, 'x'))
    const e = fakeEngine()
    const files: string[] = []
    const svc = service(e, { exec: async (c, args, o) => { if (args[0] === 'build') files.push(args[args.indexOf('--file') + 1]!); return e.exec(c, args, o) } })
    await svc.rebuild(agent())
    expect(files).toHaveLength(1)
    expect(() => readFileSync(files[0]!)).toThrow()
  })
})
