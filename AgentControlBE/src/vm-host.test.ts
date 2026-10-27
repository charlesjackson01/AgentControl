/**
 * BE-P2-2: engine detection, the `agentcontrol` machine and the grow flow, all
 * against a fake podman/docker/wsl CLI (no real engine is ever called).
 * `@mac` grow 60→90 on real hardware stays a nightly test (plan §12).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from './app.js'
import type { CommandResult, CommandRunner } from './command-runner.js'
import { RUN_BLOCK_FREE_MB, VM_MACHINE_DEFAULTS, type VmHostInfo } from './shared/types.js'
import { createStore } from './store.js'
import { FOREIGN_DEFAULT_MACHINE, MACHINE_NAME, WSL_DISTRO, createVmHostService, hostConcurrency, nextGrowGb, type VmHostDeps } from './vm-host.js'

const GIB = 1024 ** 3
const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' })
const notFound = (cmd: string): CommandResult => ({ code: 127, stdout: '', stderr: `${cmd}: not found` })
const err = (stderr: string, code = 125): CommandResult => ({ code, stdout: '', stderr })

interface FakeMachine {
  state: 'running' | 'stopped' | 'starting' | 'missing'
  diskGb: number
  usedGb: number
  memoryMb?: number
  cpus?: number
}

/** A fake CLI: podman and/or docker present, one `agentcontrol` machine, and a foreign default machine. */
function fakeCli(opts: { podman?: string | null; docker?: string | null; rootless?: boolean; vmType?: string; machine?: FakeMachine; failSet?: boolean; wslSparse?: boolean }) {
  const calls: string[][] = []
  const m = opts.machine
  const exec: CommandRunner = async (cmd, args) => {
    const a = [...args]
    calls.push([cmd, ...a])
    const line = a.join(' ')
    if (cmd === 'podman') {
      if (!opts.podman) return notFound('podman')
      if (line === '--version') return ok(`podman version ${opts.podman}\n`)
      if (line === 'info --format json') return ok(JSON.stringify({ host: { security: { rootless: opts.rootless ?? true } }, store: { graphDriverName: 'overlay' }, version: { Version: opts.podman } }))
      if (line === 'machine info --format json') return ok(JSON.stringify({ Host: { VMType: opts.vmType ?? 'libkrun', NumberOfMachines: 2, DefaultMachine: FOREIGN_DEFAULT_MACHINE } }))
      if (line === `machine inspect ${MACHINE_NAME}`) {
        if (!m || m.state === 'missing') return err(`Error: ${MACHINE_NAME}: VM does not exist`)
        return ok(JSON.stringify([{ Name: MACHINE_NAME, State: m.state, Resources: { CPUs: m.cpus ?? 4, Memory: m.memoryMb ?? 6144, DiskSize: m.diskGb } }]))
      }
      if (line === `machine ssh ${MACHINE_NAME} df -B1 --output=used /var`) {
        if (!m || m.state !== 'running') return err('machine not running')
        return ok(`        Used\n${Math.round(m.usedGb * GIB)}\n`)
      }
      if (/^machine init .* agentcontrol$/.test(line) && m) {
        m.state = 'stopped'
        const ds = a.indexOf('--disk-size')
        if (ds >= 0) m.diskGb = Number(a[ds + 1])
        return ok()
      }
      if (line === `machine start ${MACHINE_NAME}` && m) {
        m.state = 'running'
        return ok()
      }
      if (line === `machine stop ${MACHINE_NAME}` && m) {
        m.state = 'stopped'
        return ok()
      }
      if (/^machine set --disk-size \d+ agentcontrol$/.test(line) && m) {
        if (opts.failSet) return err('Error: disk resize failed')
        if (m.state !== 'stopped') return err('Error: machine must be stopped')
        m.diskGb = Number(a[3])
        return ok()
      }
      return err(`unexpected podman ${line}`, 2)
    }
    if (cmd === 'docker') {
      if (!opts.docker) return notFound('docker')
      if (line === '--version') return ok(`Docker version ${opts.docker}, build abc123\n`)
      if (line === 'info --format {{json .SecurityOptions}}') return ok(JSON.stringify(['name=seccomp,profile=builtin', ...(opts.rootless ? ['name=rootless'] : []), 'name=cgroupns']))
      return err(`unexpected docker ${line}`, 2)
    }
    if (cmd === 'wsl') return opts.wslSparse === false ? err('unknown option --set-sparse', 1) : ok()
    return notFound(cmd)
  }
  return { exec, calls }
}

/** Every call names only our machine; nothing reaches podman-machine-default or a bare machine verb. */
function expectOnlyOurMachine(calls: string[][]) {
  for (const c of calls) {
    expect(c.join(' ')).not.toContain(FOREIGN_DEFAULT_MACHINE)
    if (c[0] === 'podman' && c[1] === 'machine' && c[2] !== 'info') {
      expect(c[2] === 'ssh' ? c[3] : c.at(-1), c.join(' ')).toBe(MACHINE_NAME)
    }
    // No non-machine podman command on Mac/Windows may go to the default connection.
    if (c[0] === 'podman' && c[1] !== 'machine' && c[1] !== '--version') expect(c).toContain('--connection')
  }
}

function service(platform: NodeJS.Platform, cli: ReturnType<typeof fakeCli>, extra: Partial<VmHostDeps> = {}) {
  let budget: number | undefined
  const svc = createVmHostService({
    exec: cli.exec,
    platform,
    totalMemBytes: () => 16 * GIB,
    freeBytes: async () => 500 * GIB,
    hostDiskPath: () => '/fake/home',
    getDiskBudgetGb: () => budget,
    setDiskBudgetGb: (gb) => {
      budget = gb
    },
    cacheMs: 0,
    ...extra,
  })
  return { svc, budget: () => budget }
}

describe('helpers', () => {
  it('grow ladder: 60→90→120→180→270…', () => {
    expect([60, 90, 120, 180, 270].map(nextGrowGb)).toEqual([90, 120, 180, 270, 420])
    expect(nextGrowGb(2000)).toBe(2048)
  })
  it('concurrency: 1 on Mac/Windows; Linux min(4, floor((RAM−4)/4)), at least 1', () => {
    expect(hostConcurrency('darwin', 64 * GIB)).toBe(1)
    expect(hostConcurrency('win32', 64 * GIB)).toBe(1)
    expect(hostConcurrency('linux', 8 * GIB)).toBe(1)
    expect(hostConcurrency('linux', 6 * GIB)).toBe(1)
    expect(hostConcurrency('linux', 16 * GIB)).toBe(3)
    expect(hostConcurrency('linux', 20 * GIB)).toBe(4)
    expect(hostConcurrency('linux', 128 * GIB)).toBe(4)
  })
})

describe('Linux native', () => {
  it('rootless podman: native, no machine, no setup steps, RAM-based concurrency', async () => {
    const cli = fakeCli({ podman: '5.4.0', rootless: true })
    const info = await service('linux', cli).svc.hostInfo()
    expect(info).toEqual<VmHostInfo>({
      engine: 'podman',
      version: '5.4.0',
      provider: 'native',
      os: 'linux',
      machine: null,
      storage: { driver: null, backend: 'local', volumeState: 'ok' },
      concurrency: 3,
      setupSteps: [],
    })
    expect(cli.calls.map((c) => c.join(' '))).toEqual(['podman --version', 'podman info --format json'])
  })

  it('rootful podman asks for rootless', async () => {
    const info = await service('linux', fakeCli({ podman: '4.9.3', rootless: false })).svc.hostInfo()
    expect(info.setupSteps.map((s) => [s.id, s.done])).toEqual([
      ['install-podman', true],
      ['rootless', false],
    ])
  })

  it('docker fallback when podman is missing (rootful daemon flagged)', async () => {
    const cli = fakeCli({ podman: null, docker: '27.3.1', rootless: false })
    const info = await service('linux', cli).svc.hostInfo()
    expect([info.engine, info.version, info.provider, info.machine]).toEqual(['docker', '27.3.1', 'native', null])
    expect(info.setupSteps.find((s) => s.id === 'rootless')?.done).toBe(false)
    const rootless = await service('linux', fakeCli({ podman: null, docker: '27.3.1', rootless: true })).svc.hostInfo()
    expect(rootless.setupSteps).toEqual([])
  })

  it('missing podman → install step with help link; grow is refused (no machine)', async () => {
    const cli = fakeCli({ podman: null, docker: null })
    const { svc } = service('linux', cli)
    const info = await svc.hostInfo()
    expect([info.engine, info.version, info.machine]).toEqual([null, null, null])
    expect(info.setupSteps).toEqual([{ id: 'install-podman', text: expect.stringMatching(/Install Podman/), done: false, helpUrl: 'https://podman.io/docs/installation' }])
    await expect(svc.grow(90)).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/no machine disk/) })
  })

  it('machine verbs are never called on Linux', async () => {
    const cli = fakeCli({ podman: '5.4.0', machine: { state: 'running', diskGb: 60, usedGb: 10 } })
    const { svc } = service('linux', cli)
    await svc.hostInfo()
    await svc.ensureMachine()
    expect(cli.calls.some((c) => c[1] === 'machine')).toBe(false)
  })
})

describe.each([
  ['darwin', 'libkrun', 'local'],
  ['win32', 'wsl', 'wsl'],
] as const)('%s machine', (platform, vmType, backend) => {
  it('running machine: provider from podman, machine sizes, usage, no steps, concurrency 1', async () => {
    const cli = fakeCli({ podman: '5.4.0', vmType, machine: { state: 'running', diskGb: 60, usedGb: 21.34 } })
    const info = await service(platform, cli).svc.hostInfo()
    expect(info).toEqual<VmHostInfo>({
      engine: 'podman',
      version: '5.4.0',
      provider: vmType,
      os: platform,
      machine: { name: 'agentcontrol', state: 'running', memoryMb: 6144, cpus: 4, diskGb: 60, diskUsedGb: 21.3 },
      storage: { driver: null, backend, volumeState: 'ok' },
      concurrency: 1,
      setupSteps: [],
    })
    expectOnlyOurMachine(cli.calls)
    // No `podman info` on Mac/Windows: it would go to the default connection.
    expect(cli.calls.some((c) => c[0] === 'podman' && c[1] === 'info')).toBe(false)
  })

  it('missing machine → create and start steps; ensureMachine creates it with 6 GB / 4 vCPU (60 GB on Mac) and starts it', async () => {
    const machine: FakeMachine = { state: 'missing', diskGb: 0, usedGb: 3 }
    const cli = fakeCli({ podman: '5.4.0', vmType, machine })
    const { svc } = service(platform, cli)
    const before = await svc.hostInfo()
    expect(before.machine).toMatchObject({ name: 'agentcontrol', state: 'missing', memoryMb: 6144, cpus: 4, diskGb: 60, diskUsedGb: 0 })
    expect(before.setupSteps.map((s) => [s.id, s.done])).toEqual([
      ['install-podman', true],
      ['create-machine', false],
      ['start-machine', false],
    ])
    const after = await svc.ensureMachine()
    expect(after.machine?.state).toBe('running')
    expect(after.setupSteps).toEqual([])
    const init = cli.calls.find((c) => c[2] === 'init')!
    const { cpus, memoryMb, initialDiskGb } = VM_MACHINE_DEFAULTS
    expect(init).toEqual(['podman', 'machine', 'init', '--cpus', String(cpus), '--memory', String(memoryMb), ...(platform === 'darwin' ? ['--disk-size', String(initialDiskGb)] : []), 'agentcontrol'])
    const sparse = cli.calls.filter((c) => c[0] === 'wsl')
    expect(sparse).toEqual(platform === 'win32' ? [['wsl', '--manage', WSL_DISTRO, '--set-sparse', 'true']] : [])
    expectOnlyOurMachine(cli.calls)
  })

  it('stopped machine → start step; ensureMachine only starts it', async () => {
    const cli = fakeCli({ podman: '5.4.0', vmType, machine: { state: 'stopped', diskGb: 60, usedGb: 5 } })
    const { svc } = service(platform, cli)
    const info = await svc.hostInfo()
    expect(info.machine).toMatchObject({ state: 'stopped', diskUsedGb: 0 })
    expect(info.setupSteps.find((s) => s.id === 'start-machine')?.done).toBe(false)
    await svc.ensureMachine()
    expect(cli.calls.filter((c) => c[1] === 'machine' && !['info', 'inspect', 'ssh'].includes(c[2]!)).map((c) => c[2])).toEqual(['start'])
    expectOnlyOurMachine(cli.calls)
  })

  it('missing podman → install step, no machine calls', async () => {
    const cli = fakeCli({ podman: null, docker: null })
    const info = await service(platform, cli).svc.hostInfo()
    expect(info.engine).toBeNull()
    expect(info.machine).toBeNull()
    expect(info.setupSteps).toEqual([{ id: 'install-podman', text: expect.stringMatching(/Install Podman for (Mac|Windows)/), done: false, helpUrl: 'https://podman.io/docs/installation' }])
    expect(cli.calls.map((c) => c.join(' '))).toEqual(['podman --version', 'docker --version'])
  })

  it('grow offer at 80 % (48 of 60 GB), not below', async () => {
    const machine: FakeMachine = { state: 'running', diskGb: 60, usedGb: 47.9 }
    const cli = fakeCli({ podman: '5.4.0', vmType, machine })
    const { svc } = service(platform, cli)
    expect((await svc.hostInfo()).machine?.growOffer).toBeUndefined()
    machine.usedGb = 48
    expect((await svc.hostInfo()).machine?.growOffer).toEqual({ toGb: 90 })
  })

  it('grow is refused with active runs (409), low host disk (400) and bad sizes (400)', async () => {
    const machine: FakeMachine = { state: 'running', diskGb: 60, usedGb: 50 }
    const cli = fakeCli({ podman: '5.4.0', vmType, machine })
    let runs = 1
    let free = 500 * GIB
    const { svc } = service(platform, cli, { activeRuns: () => runs, freeBytes: async () => free })
    await expect(svc.grow(90)).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/Scripts are running/) })
    runs = 0
    // 30 GB more + the 3 GB run floor.
    free = 30 * GIB + RUN_BLOCK_FREE_MB * 1024 * 1024 - 1
    await expect(svc.grow(90)).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/Not enough free space on (this Mac|the Windows drive).*33 GB free/) })
    for (const bad of [60, 45, 90.5, '90', null, undefined, 4096]) {
      await expect(svc.grow(bad)).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/never shrink/) })
    }
    const unknownFree = service(platform, cli, { freeBytes: async () => null }).svc
    await expect(unknownFree.grow(90)).rejects.toMatchObject({ statusCode: 400 })
    expect(cli.calls.some((c) => ['stop', 'set'].includes(c[2]!))).toBe(false)
    expect(machine.diskGb).toBe(60)
  })
})

describe('grow', () => {
  it('Mac: stop → set --disk-size 90 → start on agentcontrol only; the budget records 90', async () => {
    const machine: FakeMachine = { state: 'running', diskGb: 60, usedGb: 50 }
    const cli = fakeCli({ podman: '5.4.0', vmType: 'applehv', machine })
    const { svc, budget } = service('darwin', cli)
    const info = await svc.grow(90)
    const verbs = cli.calls.filter((c) => c[1] === 'machine' && ['stop', 'set', 'start'].includes(c[2]!)).map((c) => c.slice(2).join(' '))
    expect(verbs).toEqual(['stop agentcontrol', 'set --disk-size 90 agentcontrol', 'start agentcontrol'])
    expect(info.machine).toMatchObject({ state: 'running', diskGb: 90, diskUsedGb: 50 })
    expect(info.machine?.growOffer).toBeUndefined()
    expect(budget()).toBe(90)
    expectOnlyOurMachine(cli.calls)
  })

  it('Mac: a stopped machine is resized and left stopped', async () => {
    const cli = fakeCli({ podman: '5.4.0', machine: { state: 'stopped', diskGb: 90, usedGb: 0 } })
    await service('darwin', cli).svc.grow(120)
    expect(cli.calls.filter((c) => c[1] === 'machine' && ['stop', 'set', 'start'].includes(c[2]!)).map((c) => c[2])).toEqual(['set'])
  })

  it('Mac: a failed resize restarts the machine, reports 502 and keeps the budget', async () => {
    const machine: FakeMachine = { state: 'running', diskGb: 60, usedGb: 50 }
    const cli = fakeCli({ podman: '5.4.0', machine, failSet: true })
    const { svc, budget } = service('darwin', cli)
    await expect(svc.grow(90)).rejects.toMatchObject({ statusCode: 502, message: expect.stringMatching(/disk resize failed/) })
    expect(machine.state).toBe('running')
    expect(budget()).toBeUndefined()
  })

  it('Windows: raises the managed budget only (dynamic VHDX), no stop/set/start', async () => {
    const machine: FakeMachine = { state: 'running', diskGb: 0, usedGb: 49 }
    const cli = fakeCli({ podman: '5.4.0', vmType: 'wsl', machine })
    const { svc, budget } = service('win32', cli)
    expect((await svc.hostInfo()).machine).toMatchObject({ diskGb: 60, growOffer: { toGb: 90 } })
    const info = await svc.grow(90)
    expect(cli.calls.some((c) => c[1] === 'machine' && ['stop', 'set', 'start'].includes(c[2]!))).toBe(false)
    expect(budget()).toBe(90)
    expect(info.machine).toMatchObject({ diskGb: 90, diskUsedGb: 49 })
    expect(info.machine?.growOffer).toBeUndefined()
  })
})

describe('routes', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentcontrol-vm-host-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('GET /api/vm/host and POST /api/vm/machine/grow (budget persisted in settings.vm.machine, not in the settings view)', async () => {
    const store = createStore(join(dir, 'store.json'))
    const machine: FakeMachine = { state: 'running', diskGb: 0, usedGb: 49 }
    const cli = fakeCli({ podman: '5.4.0', vmType: 'wsl', machine })
    let runs = 0
    const vmHost = createVmHostService({
      exec: cli.exec,
      platform: 'win32',
      freeBytes: async () => 200 * GIB,
      activeRuns: () => runs,
      getDiskBudgetGb: () => store.settings.vm?.machine?.diskGb,
      setDiskBudgetGb: (diskGb) => {
        store.settings.vm!.machine = { diskGb }
        store.save()
      },
      cacheMs: 0,
    })
    const app = buildApp(store, { vmHost })
    const host = await app.inject({ method: 'GET', url: '/api/vm/host' })
    expect(host.statusCode).toBe(200)
    expect(host.json()).toMatchObject({ engine: 'podman', os: 'win32', provider: 'wsl', machine: { name: 'agentcontrol', diskGb: 60, growOffer: { toGb: 90 } }, storage: { backend: 'wsl' } })

    runs = 1
    const busy = await app.inject({ method: 'POST', url: '/api/vm/machine/grow', payload: { toGb: 90 } })
    expect(busy.statusCode).toBe(409)
    expect(busy.json().message).toMatch(/Scripts are running/)
    runs = 0
    const bad = await app.inject({ method: 'POST', url: '/api/vm/machine/grow', payload: {} })
    expect(bad.statusCode).toBe(400)
    const grown = await app.inject({ method: 'POST', url: '/api/vm/machine/grow', payload: { toGb: 90 } })
    expect(grown.statusCode).toBe(200)
    expect(grown.json().machine).toMatchObject({ diskGb: 90 })
    expect(createStore(join(dir, 'store.json')).settings.vm?.machine).toEqual({ diskGb: 90 })
    const view = await app.inject({ method: 'GET', url: '/api/vm/settings' })
    if (view.statusCode === 200) expect(view.json()).not.toHaveProperty('machine')
    expectOnlyOurMachine(cli.calls)
    await app.close()
  })

  it('low host disk → 400 through the route', async () => {
    const store = createStore(join(dir, 'store.json'))
    const cli = fakeCli({ podman: '5.4.0', machine: { state: 'running', diskGb: 60, usedGb: 49 } })
    const vmHost = createVmHostService({ exec: cli.exec, platform: 'darwin', freeBytes: async () => 10 * GIB, cacheMs: 0 })
    const app = buildApp(store, { vmHost })
    const res = await app.inject({ method: 'POST', url: '/api/vm/machine/grow', payload: { toGb: 90 } })
    expect(res.statusCode).toBe(400)
    expect(res.json().message).toMatch(/Not enough free space on this Mac/)
    await app.close()
  })
})
