/**
 * BE-P2-18: backups before Reset VM, before a machine grow and a base image upgrade, and the
 * nightly timer in the app (fake engine, fake host, fake clock, temp data copy; no Podman).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from './app.js'
import { createBotEnvService } from './bot-env.js'
import { botMounts, storeSaveVm } from './bot-env-routes.js'
import { fakeEngine } from './bot-env.fake.js'
import type { CommandRunner } from './command-runner.js'
import type { RuntimeProbe } from './runtime-probe.js'
import type { Agent, AgentVm, BackupInfo, VmHostInfo } from './shared/types.js'
import { createStore, type WorkspaceStore } from './store.js'
import { defaultAgentVm } from './vm-defaults.js'
import { createVmHostService, type VmHostService } from './vm-host.js'

const GIB = 1024 ** 3

describe('grow: the pre-upgrade backup runs after the checks, before the machine changes', () => {
  function macCli(order: string[]): CommandRunner {
    return async (cmd, args) => {
      const a = args.join(' ')
      if (cmd !== 'podman') return { code: 127, stdout: '', stderr: 'not found' }
      if (a === '--version') return { code: 0, stdout: 'podman version 5.4.0', stderr: '' }
      if (a === 'machine info --format json') return { code: 0, stdout: JSON.stringify({ Host: { VMType: 'applehv' } }), stderr: '' }
      if (a === 'machine inspect agentcontrol') return { code: 0, stdout: JSON.stringify([{ Name: 'agentcontrol', State: 'running', Resources: { DiskSize: 60, Memory: 6144, CPUs: 4 } }]), stderr: '' }
      if (a.startsWith('machine ssh agentcontrol df')) return { code: 0, stdout: `Used\n${50 * GIB}\n`, stderr: '' }
      if (/^machine (stop|set|start)/.test(a)) {
        order.push(a.split(' ')[1]!)
        return { code: 0, stdout: '', stderr: '' }
      }
      return { code: 1, stdout: '', stderr: `unexpected ${a}` }
    }
  }

  it('Mac: backup → stop → set → start; refused grows never back up', async () => {
    const order: string[] = []
    let runs = 0
    const svc = createVmHostService({
      exec: macCli(order),
      platform: 'darwin',
      freeBytes: async () => 500 * GIB,
      hostDiskPath: () => '/Users/cole',
      activeRuns: () => runs,
      beforeGrow: async () => {
        order.push('backup')
      },
    })
    runs = 1
    await expect(svc.grow(90)).rejects.toMatchObject({ statusCode: 409, reason: 'runs_active' })
    await expect(svc.grow(30)).rejects.toMatchObject({ statusCode: 400 })
    expect(order).toEqual([])
    runs = 0
    await svc.grow(90)
    expect(order).toEqual(['backup', 'stop', 'set', 'start'])
  })

  it('a backup hook that throws stops the grow before the machine changes', async () => {
    const order: string[] = []
    const svc = createVmHostService({
      exec: macCli(order),
      platform: 'darwin',
      freeBytes: async () => 500 * GIB,
      hostDiskPath: () => '/Users/cole',
      beforeGrow: async () => {
        throw new Error('disk full')
      },
    })
    await expect(svc.grow(90)).rejects.toThrow('disk full')
    expect(order).toEqual([])
  })
})

describe('base image upgrade: backup first (best effort)', () => {
  const agent = (vm: Partial<AgentVm> = {}): Agent => ({ id: 'ag_1', slug: 'analyst', name: 'Analyst', internetPolicy: 'ask', vm: { ...defaultAgentVm(), ...vm } }) as unknown as Agent
  function service(e: ReturnType<typeof fakeEngine>, version: () => string, hook: (a: Agent) => Promise<void>, logs: string[]) {
    return createBotEnvService({
      exec: e.exec,
      engine: async () => ({ cli: 'podman', globalArgs: [] }),
      baseVersion: version,
      mounts: () => [],
      saveVm: () => true,
      buildNetwork: () => 'default',
      beforeBaseUpgrade: hook,
      log: (m) => logs.push(m),
    })
  }

  it('calls the hook once when the base changed, not for a first build or an unchanged base', async () => {
    const e = fakeEngine()
    let version = '1.0.0'
    const calls: string[] = []
    const logs: string[] = []
    const svc = service(e, () => version, async (a) => void calls.push(a.slug), logs)
    const a = agent()
    await svc.start(a)
    await svc.rebuild(a)
    await svc.ensure(a, { start: true })
    expect(calls).toEqual([])
    version = '1.1.0'
    await svc.ensure(a, { start: true })
    expect(calls).toEqual(['analyst'])
    expect(a.vm.image.generation).toBe(2)
    await svc.ensure(a, { start: true })
    expect(calls).toEqual(['analyst'])
  })

  it('a failed backup is logged and the upgrade goes ahead', async () => {
    const e = fakeEngine()
    let version = '1.0.0'
    const logs: string[] = []
    const svc = service(e, () => version, async () => {
      throw new Error('no space')
    }, logs)
    const a = agent()
    await svc.rebuild(a)
    version = '1.1.0'
    await svc.ensure(a, { start: true })
    expect(a.vm.image.generation).toBe(2)
    expect(logs.join('\n')).toMatch(/the backup before the base upgrade failed, upgrading anyway: no space/)
  })
})

describe('app: Reset VM and the nightly timer', () => {
  const host: VmHostInfo = {
    engine: 'podman', version: '5.4.0', provider: 'native', os: 'linux', machine: null,
    storage: { driver: 'overlay', backend: 'local', volumeState: 'ok' }, concurrency: 2, setupSteps: [],
  }
  const probe: RuntimeProbe = {
    current: () => null,
    refresh: async () => { throw new Error('not used') },
    ensureFresh: async () => { throw new Error('not used') },
    restore: async () => null,
    startTimer: () => () => {},
  }
  let dir = ''
  let app: FastifyInstance | null = null
  let store: WorkspaceStore
  let free: number | null = null
  let clock = new Date(2026, 10, 6, 2, 59, 0)
  let engine = fakeEngine()

  function boot(nightlyMs: number | false = false): void {
    store = createStore(join(dir, 'store.json'))
    const vmHost: VmHostService = { hostInfo: async () => host, ensureMachine: async () => host, grow: async () => host }
    engine = fakeEngine()
    const botEnv = createBotEnvService({ exec: engine.exec, engine: async () => ({ cli: 'podman', globalArgs: [] }), mounts: (a) => botMounts(store, a), saveVm: storeSaveVm(store), activeRuns: () => 0 })
    app = buildApp(store, { vmHost, botEnv, runtimeProbe: probe, backups: { freeBytes: () => free, now: () => new Date(clock), nightlyMs } })
  }
  const inject = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app!.inject({ method, url, payload: payload as object | undefined, headers: { 'content-type': 'application/json' } })
  async function makeBot(name: string): Promise<Agent> {
    const res = await inject('POST', '/api/agents', { name, endpointId: 'ep_local_llama', modelId: 'llama-3-8b' })
    const bot = res.json() as Agent
    writeFileSync(join(dir, 'bots', bot.slug, 'workspace', 'a.txt'), `${name} data`)
    return bot
  }

  beforeEach(() => {
    vi.stubEnv('AGENTCONTROL_SECRET', 'be18-test-secret')
    vi.stubEnv('AGENTCONTROL_AUTH_TOKEN', '')
    dir = mkdtempSync(join(tmpdir(), 'agentcontrol-be18h-'))
    free = null
    clock = new Date(2026, 10, 6, 2, 59, 0)
  })
  afterEach(async () => {
    if (app) await app.close()
    app = null
    vi.unstubAllEnvs()
    rmSync(dir, { recursive: true, force: true })
  })

  it('Reset VM backs the bot up first (pre_reset), even with nightly backups off', async () => {
    boot()
    const a = await makeBot('Analyst')
    await makeBot('Writer')
    expect(store.settings.vm?.backups.enabled).toBe(process.platform === 'win32')
    const res = await inject('POST', `/api/agents/${a.id}/vm/reset`, { confirm: true })
    expect(res.statusCode).toBe(200)
    const list = (await inject('GET', '/api/vm/backups')).json() as BackupInfo[]
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ trigger: 'pre_reset', status: 'complete', agentIds: [a.id] })
    expect(existsSync(join(list[0]!.path, `${a.slug}.tar.zst`))).toBe(true)
  })

  it('no reset when the backup can\'t be made (507 low disk): the bot keeps its tools', async () => {
    boot()
    const a = await makeBot('Analyst')
    store.agents = store.agents.map((x) => (x.id === a.id ? { ...x, vm: { ...x.vm, packages: ['jq'] } } : x))
    store.save()
    free = 1
    const res = await inject('POST', `/api/agents/${a.id}/vm/reset`, { confirm: true })
    expect(res.statusCode).toBe(507)
    expect(res.json().message).toMatch(/Not enough free disk space for a backup/)
    expect(store.agents.find((x) => x.id === a.id)!.vm.packages).toEqual(['jq'])
    expect(engine.calls.some((c) => c[0] === 'volume' && c[1] === 'rm')).toBe(false)
  })

  it('the nightly timer backs up every bot at backups.time when enabled', async () => {
    boot(10)
    await makeBot('Analyst')
    store.settings = { ...store.settings, vm: { ...store.settings.vm!, backups: { enabled: true, time: '03:00', keep: 7 } } }
    store.save()
    await new Promise((r) => setTimeout(r, 40))
    expect((await inject('GET', '/api/vm/backups')).json()).toEqual([])
    clock = new Date(2026, 10, 6, 3, 0, 5)
    await vi.waitFor(async () => {
      const list = (await inject('GET', '/api/vm/backups')).json() as BackupInfo[]
      expect(list.map((b) => [b.trigger, b.status])).toEqual([['nightly', 'complete']])
    })
    const record = JSON.parse(readFileSync(join(dir, 'backups', ((await inject('GET', '/api/vm/backups')).json() as BackupInfo[])[0]!.id, 'backup.json'), 'utf8'))
    expect(record.info.trigger).toBe('nightly')
  })
})
