/**
 * BE-P2-2: container engine detection and the dedicated `agentcontrol` Podman
 * machine (plan §2.4), behind an injectable CommandRunner.
 *
 * - Linux runs Podman natively (rootless): no machine, concurrency from host RAM.
 * - Mac/Windows use AgentControl's own machine `agentcontrol` (6 GB, 4 vCPU,
 *   60 GB initial disk). Only `podman machine <verb> agentcontrol` is ever
 *   called: never a bare machine verb, never `podman-machine-default`, and
 *   never a non-machine podman command without `--connection agentcontrol`.
 * - At 80 % disk use the host info carries a grow offer (90, 120, 180 … GB).
 *   Mac grows with stop → `machine set --disk-size` → start; Windows (dynamic
 *   VHDX) raises the managed budget in settings.vm.machine.
 */
import { statfs } from 'node:fs/promises'
import { homedir, totalmem } from 'node:os'
import { execCommandRunner, type CommandRunner } from './command-runner.js'
import { fail, failWithReason } from './http.js'
import { RUN_BLOCK_FREE_MB, VM_MACHINE_DEFAULTS, type SnapshotDriver, type StorageBackendKind, type VmHostInfo } from './shared/types.js'

export type HostOs = VmHostInfo['os']
export type MachineInfo = NonNullable<VmHostInfo['machine']>
export type MachineState = MachineInfo['state']
type SetupStep = VmHostInfo['setupSteps'][number]

export const MACHINE_NAME = VM_MACHINE_DEFAULTS.name
/** Podman's own default machine: never inspected, started, stopped or changed. */
export const FOREIGN_DEFAULT_MACHINE = 'podman-machine-default'
/** The WSL distro behind the `agentcontrol` machine on Windows. */
export const WSL_DISTRO = `podman-${MACHINE_NAME}`
/** Offer to grow at this share of the disk in use. */
export const GROW_OFFER_AT = 0.8
/** Largest disk AgentControl will grow to. */
export const MAX_MACHINE_DISK_GB = 2048
const GIB = 1024 ** 3
const RUN_FLOOR_BYTES = RUN_BLOCK_FREE_MB * 1024 * 1024
const MACHINE_TIMEOUT_MS = 5 * 60_000

export const SETUP_HELP = {
  podman: 'https://podman.io/docs/installation',
  rootless: 'https://github.com/containers/podman/blob/main/docs/tutorials/rootless_tutorial.md',
  wsl: 'https://learn.microsoft.com/windows/wsl/install',
} as const

export interface EngineInfo {
  engine: 'podman' | 'docker' | null
  version: string | null
  /** Linux only (null elsewhere or unknown): the engine runs without root. */
  rootless: boolean | null
  /** Podman's storage driver on Linux (e.g. overlay), when known. */
  graphDriver: string | null
}

/** Next size the grow offer proposes: 90, 120, then ×1.5 rounded up to 30 GB (180, 270 …). */
export function nextGrowGb(currentGb: number): number {
  if (currentGb < 90) return 90
  if (currentGb < 120) return 120
  return Math.min(MAX_MACHINE_DISK_GB, Math.ceil((currentGb * 1.5) / 30) * 30)
}

/** Concurrent runs: 1 in the shared machine; Linux min(4, floor((RAM − 4 GB) / 4 GB)), at least 1. */
export function hostConcurrency(os: HostOs, totalMemBytes: number): number {
  if (os !== 'linux') return 1
  return Math.max(1, Math.min(4, Math.floor((totalMemBytes - 4 * GIB) / (4 * GIB))))
}

function hostOs(platform: NodeJS.Platform): HostOs {
  return platform === 'darwin' || platform === 'win32' ? platform : 'linux'
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const round1 = (n: number) => Math.round(n * 10) / 10

export interface VmHostDeps {
  exec?: CommandRunner
  platform?: NodeJS.Platform
  totalMemBytes?: () => number
  /** Free bytes on the filesystem holding `path`; null when it can't be read. */
  freeBytes?: (path: string) => Promise<number | null>
  /** Where the machine disk lives on the host (the user's home on Mac/Windows). */
  hostDiskPath?: () => string
  /** Script runs queued/running right now (BE-P2-8 wires the real count). */
  activeRuns?: () => number
  /** Managed disk budget (settings.vm.machine.diskGb). */
  getDiskBudgetGb?: () => number | undefined
  setDiskBudgetGb?: (gb: number) => void
  /** Storage facts owned by other tasks (probe: driver; StorageBackend: volume marker). */
  storage?: () => { driver: SnapshotDriver | null; volumeState: 'ok' | 'missing' | 'mismatch' }
  /** How long GET results are reused (ms). */
  cacheMs?: number
  now?: () => number
}

export interface VmHostService {
  /** GET /api/vm/host. `fresh` skips the short cache. */
  hostInfo(fresh?: boolean): Promise<VmHostInfo>
  /** Create (6 GB / 4 vCPU / 60 GB) and/or start the `agentcontrol` machine. No-op on Linux. */
  ensureMachine(): Promise<VmHostInfo>
  /** POST /api/vm/machine/grow. Throws 400, 409 (reason 'runs_active' while runs are in progress) or 502 via fail(). */
  grow(toGb: unknown): Promise<VmHostInfo>
}

export async function statfsFreeBytes(path: string): Promise<number | null> {
  try {
    const s = await statfs(path)
    return Number(s.bavail) * Number(s.bsize)
  } catch {
    return null
  }
}

export function createVmHostService(deps: VmHostDeps = {}): VmHostService {
  const exec = deps.exec ?? execCommandRunner
  const os = hostOs(deps.platform ?? process.platform)
  const totalMem = deps.totalMemBytes ?? totalmem
  const freeBytes = deps.freeBytes ?? statfsFreeBytes
  const hostDiskPath = deps.hostDiskPath ?? homedir
  const activeRuns = deps.activeRuns ?? (() => 0)
  const budget = deps.getDiskBudgetGb ?? (() => undefined)
  const setBudget = deps.setDiskBudgetGb ?? (() => {})
  const storage = deps.storage ?? (() => ({ driver: null, volumeState: 'ok' as const }))
  const cacheMs = deps.cacheMs ?? 5_000
  const now = deps.now ?? Date.now
  const backend: StorageBackendKind = os === 'win32' ? 'wsl' : 'local'
  let cache: { at: number; info: VmHostInfo } | null = null
  let busy = false

  const podmanMachine = (verb: string, args: readonly string[] = [], timeoutMs = 30_000) =>
    exec('podman', ['machine', verb, ...args, MACHINE_NAME], { timeoutMs })

  async function detectEngine(): Promise<EngineInfo> {
    const pv = await exec('podman', ['--version'])
    if (pv.code === 0) {
      const version = /(\d+\.\d+(?:\.\d+)?\S*)/.exec(pv.stdout)?.[1] ?? null
      let rootless: boolean | null = null
      let graphDriver: string | null = null
      if (os === 'linux') {
        const info = await exec('podman', ['info', '--format', 'json'])
        const j = info.code === 0 ? parseJson(info.stdout) : undefined
        if (isObj(j)) {
          const host = isObj(j.host) ? j.host : {}
          const sec = isObj(host.security) ? host.security : {}
          if (typeof sec.rootless === 'boolean') rootless = sec.rootless
          const store = isObj(j.store) ? j.store : {}
          if (typeof store.graphDriverName === 'string') graphDriver = store.graphDriverName
        }
      }
      return { engine: 'podman', version, rootless, graphDriver }
    }
    const dv = await exec('docker', ['--version'])
    if (dv.code === 0) {
      const version = /(\d+\.\d+(?:\.\d+)?)/.exec(dv.stdout)?.[1] ?? null
      let rootless: boolean | null = null
      if (os === 'linux') {
        const info = await exec('docker', ['info', '--format', '{{json .SecurityOptions}}'])
        const opts = info.code === 0 ? parseJson(info.stdout) : undefined
        if (Array.isArray(opts)) rootless = opts.some((o) => typeof o === 'string' && /(^|,)name=rootless(,|$)/.test(o))
      }
      return { engine: 'docker', version, rootless, graphDriver: null }
    }
    return { engine: null, version: null, rootless: null, graphDriver: null }
  }

  async function machineProvider(): Promise<string> {
    const fallback = os === 'win32' ? 'wsl' : 'libkrun'
    const r = await exec('podman', ['machine', 'info', '--format', 'json'])
    const j = r.code === 0 ? parseJson(r.stdout) : undefined
    const t = isObj(j) && isObj(j.Host) ? j.Host.VMType : undefined
    return typeof t === 'string' && t ? t.toLowerCase() : fallback
  }

  function managedDiskGb(reported: number | null): number {
    const b = budget() ?? VM_MACHINE_DEFAULTS.initialDiskGb
    // Mac: the real disk size wins (it can't shrink). Windows: the VHDX is dynamic; the budget is the size.
    return os === 'darwin' && reported !== null ? Math.max(reported, b) : b
  }

  async function diskUsedGb(): Promise<number | null> {
    const r = await exec('podman', ['machine', 'ssh', MACHINE_NAME, 'df', '-B1', '--output=used', '/var'])
    if (r.code !== 0) return null
    const used = Number(r.stdout.trim().split('\n').at(-1)?.trim())
    return Number.isFinite(used) ? round1(used / GIB) : null
  }

  async function inspectMachine(): Promise<MachineInfo> {
    const r = await podmanMachine('inspect')
    const j = r.code === 0 ? parseJson(r.stdout) : undefined
    const m = Array.isArray(j) ? j.find((x) => isObj(x) && x.Name === MACHINE_NAME) : undefined
    if (!isObj(m)) {
      const missing = r.code !== 0 && /does not exist|no such|not found/i.test(r.stderr)
      return {
        name: MACHINE_NAME,
        state: missing || r.code === 0 ? 'missing' : 'error',
        memoryMb: VM_MACHINE_DEFAULTS.memoryMb,
        cpus: VM_MACHINE_DEFAULTS.cpus,
        diskGb: managedDiskGb(null),
        diskUsedGb: 0,
      }
    }
    const res = isObj(m.Resources) ? m.Resources : {}
    const raw = typeof m.State === 'string' ? m.State.toLowerCase() : ''
    const state: MachineState = raw === 'running' || raw === 'stopped' || raw === 'starting' ? raw : raw === '' || raw === 'configured' ? 'stopped' : 'error'
    const diskGb = managedDiskGb(num(res.DiskSize))
    const used = state === 'running' ? await diskUsedGb() : null
    const info: MachineInfo = {
      name: MACHINE_NAME,
      state,
      memoryMb: num(res.Memory) ?? VM_MACHINE_DEFAULTS.memoryMb,
      cpus: num(res.CPUs) ?? VM_MACHINE_DEFAULTS.cpus,
      diskGb,
      diskUsedGb: used ?? 0,
    }
    if (used !== null && used >= diskGb * GROW_OFFER_AT && diskGb < MAX_MACHINE_DISK_GB) info.growOffer = { toGb: nextGrowGb(diskGb) }
    return info
  }

  function setupSteps(engine: EngineInfo, machine: MachineInfo | null): SetupStep[] {
    const steps: SetupStep[] = []
    const hasEngine = engine.engine !== null
    steps.push({
      id: 'install-podman',
      text: os === 'win32' ? 'Install Podman for Windows (it uses WSL 2).' : os === 'darwin' ? 'Install Podman for Mac.' : 'Install Podman from your distribution’s packages.',
      done: hasEngine,
      helpUrl: SETUP_HELP.podman,
    })
    if (os === 'linux') {
      if (hasEngine && engine.rootless === false) {
        steps.push({
          id: 'rootless',
          text: engine.engine === 'docker' ? 'Use rootless Podman (or rootless Docker): the engine runs as root now.' : 'Run AgentControl as a regular user so Podman runs rootless.',
          done: false,
          helpUrl: SETUP_HELP.rootless,
        })
      }
    } else if (engine.engine === 'podman') {
      steps.push({ id: 'create-machine', text: 'Create AgentControl’s machine “agentcontrol” (6 GB memory, 4 CPUs, 60 GB disk).', done: machine !== null && machine.state !== 'missing' })
      steps.push({ id: 'start-machine', text: 'Start the “agentcontrol” machine.', done: machine?.state === 'running' })
    }
    return steps.every((s) => s.done) ? [] : steps
  }

  async function compute(): Promise<VmHostInfo> {
    const engine = await detectEngine()
    let provider = 'native'
    let machine: MachineInfo | null = null
    if (os !== 'linux') {
      if (engine.engine === 'podman') {
        provider = await machineProvider()
        machine = await inspectMachine()
      } else {
        provider = engine.engine === 'docker' ? 'docker-desktop' : os === 'win32' ? 'wsl' : 'libkrun'
      }
    }
    const s = storage()
    return {
      engine: engine.engine,
      version: engine.version,
      provider,
      os,
      machine,
      storage: { driver: s.driver, backend, volumeState: s.volumeState },
      concurrency: hostConcurrency(os, totalMem()),
      setupSteps: setupSteps(engine, machine),
    }
  }

  async function hostInfo(fresh = false): Promise<VmHostInfo> {
    if (!fresh && cache && now() - cache.at < cacheMs) return structuredClone(cache.info)
    const info = await compute()
    cache = { at: now(), info }
    return structuredClone(info)
  }

  async function run(verb: string, args: readonly string[] = []): Promise<void> {
    const r = await podmanMachine(verb, args, MACHINE_TIMEOUT_MS)
    if (r.code !== 0) fail(502, `Podman couldn't ${verb} the “${MACHINE_NAME}” machine: ${r.stderr.trim().split('\n').at(-1)?.slice(0, 300) || `exit ${r.code}`}`)
  }

  async function ensureMachine(): Promise<VmHostInfo> {
    const info = await hostInfo(true)
    if (os === 'linux' || info.engine !== 'podman' || !info.machine) return info
    if (busy) fail(409, 'The machine is already being changed. Try again in a moment.')
    busy = true
    try {
      if (info.machine.state === 'missing') {
        const { cpus, memoryMb, initialDiskGb } = VM_MACHINE_DEFAULTS
        // WSL disks are dynamic VHDX (size is the managed budget), so --disk-size is Mac only.
        const sizeArgs = ['--cpus', String(cpus), '--memory', String(memoryMb), ...(os === 'darwin' ? ['--disk-size', String(Math.max(initialDiskGb, budget() ?? 0))] : [])]
        await run('init', sizeArgs)
        if (os === 'win32') {
          // Give space freed inside WSL back to Windows where WSL supports it; older WSL just says no.
          await exec('wsl', ['--manage', WSL_DISTRO, '--set-sparse', 'true'], { timeoutMs: 60_000 })
        }
        await run('start')
      } else if (info.machine.state === 'stopped' || info.machine.state === 'error') {
        await run('start')
      }
    } finally {
      busy = false
      cache = null
    }
    return hostInfo(true)
  }

  async function grow(toGbRaw: unknown): Promise<VmHostInfo> {
    const info = await hostInfo(true)
    const m = info.machine
    if (os === 'linux' || !m) fail(400, 'Bots run directly on this computer, so there is no machine disk to grow.')
    if (m.state === 'missing') fail(400, 'Set up the “agentcontrol” machine before growing its disk.')
    const toGb = toGbRaw
    if (typeof toGb !== 'number' || !Number.isInteger(toGb) || toGb <= m.diskGb || toGb > MAX_MACHINE_DISK_GB) {
      fail(400, `Choose a whole number of GB larger than the current ${m.diskGb} GB (up to ${MAX_MACHINE_DISK_GB} GB). Disks can grow but never shrink.`)
    }
    // The machine has to stop to grow, so any run in progress blocks it.
    if (activeRuns() > 0) failWithReason(409, 'runs_active', 'Scripts are running. Wait for them to finish, then grow the disk.')
    if (busy) fail(409, 'The machine is already being changed. Try again in a moment.')
    const free = await freeBytes(hostDiskPath())
    const needed = (toGb - m.diskGb) * GIB + RUN_FLOOR_BYTES
    if (free === null) fail(400, "Couldn't check this computer's free disk space, so the disk wasn't grown.")
    if (free < needed) {
      const drive = os === 'win32' ? 'the Windows drive' : 'this Mac'
      fail(400, `Not enough free space on ${drive}: growing to ${toGb} GB needs about ${Math.ceil(needed / GIB)} GB free and ${Math.floor(free / GIB)} GB is free.`)
    }
    busy = true
    try {
      if (os === 'darwin') {
        const wasRunning = m.state === 'running' || m.state === 'starting'
        if (wasRunning) await run('stop')
        let setErr: unknown = null
        try {
          await run('set', ['--disk-size', String(toGb)])
        } catch (e) {
          setErr = e
        }
        // Bring it back up when it was up, even after a failed set.
        if (wasRunning) await run('start')
        if (setErr) throw setErr
      }
      setBudget(toGb)
    } finally {
      busy = false
      cache = null
    }
    return hostInfo(true)
  }

  return { hostInfo, ensureMachine, grow }
}
