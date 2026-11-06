/*
 * FE-P2-6: in-memory stand-in for the VMs routes, for tests and for mockup screenshots.
 * Same paths and bodies as createVmApi. The page never calls this unless VITE_VMS_FAKE=1
 * (see vms-client.ts). Tests: tests/vms-page.test.mjs.
 */
import {
  VM_MACHINE_DEFAULTS,
  type BackupInfo, type BrowserAddonInfo, type VmHostInfo, type VmProbeResult, type VmSettingsView,
} from './types.ts'

export type VmsScene = 'default' | 'empty' | 'runs' | 'windows' | 'linux' | 'progress' | 'failed'

type AgentName = { id: string; name: string }

export type FakeVmsState = {
  scene: VmsScene
  settings: VmSettingsView
  host: VmHostInfo
  probe: VmProbeResult
  browser: BrowserAddonInfo
  backups: BackupInfo[]
  agents: AgentName[]
  runsActive: boolean
}

const MB = 1024 * 1024

function at(now: Date, dayOffset: number, hour: number, minute: number): string {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, hour, minute, 0, 0).toISOString()
}

const AGENTS: AgentName[] = [
  { id: 'primary', name: 'Primary' },
  { id: 'summarizer', name: 'Summarizer' },
  { id: 'analyst', name: 'Analyst' },
]

function hostFor(scene: VmsScene): VmHostInfo {
  const machine = scene === 'linux'
    ? null
    : {
        name: 'agentcontrol' as const,
        state: 'running' as const,
        memoryMb: VM_MACHINE_DEFAULTS.memoryMb,
        cpus: VM_MACHINE_DEFAULTS.cpus,
        diskGb: 60,
        diskUsedGb: 23,
        growOffer: { toGb: 90 },
      }
  const win = scene === 'windows'
  return {
    engine: 'podman',
    version: '5.4.0',
    provider: win ? 'wsl' : scene === 'linux' ? 'native' : 'libkrun',
    os: win ? 'win32' : scene === 'linux' ? 'linux' : 'darwin',
    machine,
    storage: { driver: 'overlay', backend: win ? 'wsl' : 'local', volumeState: 'ok' },
    concurrency: scene === 'linux' ? 2 : 1,
    setupSteps: [],
  }
}

function probeFor(now: Date, detailed: boolean): VmProbeResult {
  return {
    runsc: { installed: true, ...(detailed ? {} : { version: '0.1' }) },
    checks: detailed ? [{ id: 'chromium', status: 'pass' }] : [],
    compatible: true,
    uidMapping: detailed ? 'idmap' : null,
    snapshotDriver: 'overlay',
    checkedAt: at(now, 0, 9, 11),
    versions: { engine: '5.4.0', runsc: detailed ? null : '0.1', image: null },
  }
}

function backupsFor(scene: VmsScene, now: Date): BackupInfo[] {
  if (scene === 'empty' || scene === 'linux') return []
  const ids = AGENTS.map((a) => a.id)
  const rows: BackupInfo[] = [
    { id: 'bk-today', createdAt: at(now, 0, 3, 0), trigger: 'nightly', agentIds: ids, bytes: 842 * MB, path: 'data/backups/today', status: 'complete' },
    { id: 'bk-yest', createdAt: at(now, -1, 3, 0), trigger: 'nightly', agentIds: ids, bytes: 791 * MB, path: 'data/backups/yest', status: 'complete' },
    { id: 'bk-reset', createdAt: at(now, -2, 16, 12), trigger: 'pre_reset', agentIds: ['primary'], bytes: 210 * MB, path: 'data/backups/reset', status: 'complete' },
  ]
  if (scene === 'progress') {
    rows.unshift({ id: 'bk-now', createdAt: at(now, 0, 16, 40), trigger: 'manual', agentIds: ids, bytes: 120 * MB, path: 'data/backups/now', status: 'in_progress' })
  }
  if (scene === 'failed') {
    rows.unshift({ id: 'bk-fail', createdAt: at(now, 0, 15, 2), trigger: 'manual', agentIds: ['analyst'], bytes: 40 * MB, path: 'data/backups/fail', status: 'failed', error: 'The disk filled up before the archive was finished.' })
  }
  return rows
}

export function createFakeVmsState(scene: VmsScene = 'default', now: Date = new Date()): FakeVmsState {
  return {
    scene,
    settings: {
      gvisor: scene === 'progress' ? 'force_on' : 'auto',
      backups: { enabled: true, time: '03:00', keep: 7 },
      snapshotBudget: { perBotMb: 2048, globalMb: 15360, freeFloorMb: 5120 },
    },
    host: hostFor(scene),
    probe: probeFor(now, scene === 'progress'),
    browser: { state: 'ready', totalBytes: 1343 * 1000 ** 2, usedBy: [] },
    backups: backupsFor(scene, now),
    agents: AGENTS,
    runsActive: scene === 'runs',
  }
}

type Reply = { status: number; body: unknown }

function err(status: number, reason: string, message: string): Reply {
  return { status, body: { statusCode: status, error: 'Request Error', reason, message } }
}

function pathOf(url: string): string {
  const q = url.indexOf('?')
  return q === -1 ? url : url.slice(0, q)
}

/**
 * One fake call. Mutates `state` for writes. null when the path isn't one this layer stands in for.
 * `backupListFails` models the backups card's own error (the rest of the page still loads).
 */
export function fakeVmsDispatch(state: FakeVmsState, method: string, url: string, body: unknown, opts: { backupListFails?: boolean } = {}): Reply | null {
  const path = pathOf(url)
  const m = method.toUpperCase()
  if (path === '/api/vm/settings' && m === 'GET') return { status: 200, body: state.settings }
  if (path === '/api/vm/settings' && m === 'PATCH') {
    const patch = (body ?? {}) as { gvisor?: FakeVmsState['settings']['gvisor']; backups?: Partial<FakeVmsState['settings']['backups']>; snapshotBudget?: Partial<FakeVmsState['settings']['snapshotBudget']> }
    state.settings = {
      gvisor: patch.gvisor ?? state.settings.gvisor,
      backups: { ...state.settings.backups, ...patch.backups },
      snapshotBudget: { ...state.settings.snapshotBudget, ...patch.snapshotBudget },
    }
    return { status: 200, body: state.settings }
  }
  if (path === '/api/vm/host' && m === 'GET') return { status: 200, body: state.host }
  if (path === '/api/vm/machine/grow' && m === 'POST') {
    if (state.runsActive) return err(409, 'runs_active', 'Scripts are running. Wait for them to finish, then grow the disk.')
    const toGb = (body as { toGb?: unknown } | null)?.toGb
    if (typeof toGb !== 'number' || !state.host.machine) return err(400, 'bad_request', 'Bots run directly on this computer, so there is no machine disk to grow.')
    state.host = { ...state.host, machine: { ...state.host.machine, diskGb: toGb, growOffer: undefined } }
    return { status: 200, body: state.host }
  }
  if (path === '/api/vm/probe' && m === 'GET') return { status: 200, body: state.probe }
  if (path === '/api/vm/probe' && m === 'POST') {
    state.probe = { ...state.probe, checkedAt: new Date().toISOString() }
    return { status: 200, body: state.probe }
  }
  if (path === '/api/vm/browser' && m === 'GET') return { status: 200, body: state.browser }
  if (path === '/api/vm/browser' && m === 'DELETE') {
    if (state.browser.usedBy.length) return err(409, 'browser_in_use', `Turn off the browser for every bot first (used by ${state.browser.usedBy.join(', ')}).`)
    state.browser = { ...state.browser, state: 'absent', usedBy: [] }
    return { status: 200, body: state.browser }
  }
  if (path === '/api/vm/backups' && m === 'GET') {
    if (opts.backupListFails) return err(500, 'backup_list', "Couldn't load backups.")
    return { status: 200, body: state.backups }
  }
  if (path === '/api/vm/backups' && m === 'POST') {
    if (state.backups.some((b) => b.status === 'in_progress')) return err(409, 'backup_in_progress', 'A backup is already running.')
    const ids = (body as { agentIds?: string[] } | null)?.agentIds
    const row: BackupInfo = {
      id: `bk-${state.backups.length + 1}`,
      createdAt: new Date().toISOString(),
      trigger: 'manual',
      agentIds: ids && ids.length ? ids : state.agents.map((a) => a.id),
      bytes: 0,
      path: 'data/backups/manual',
      status: 'in_progress',
    }
    state.backups = [row, ...state.backups]
    return { status: 202, body: row }
  }
  const restore = /^\/api\/vm\/backups\/([^/]+)\/restore$/.exec(path)
  if (restore && m === 'POST') {
    const id = decodeURIComponent(restore[1])
    const found = state.backups.find((b) => b.id === id)
    if (!found) return err(404, 'not_found', 'That backup is gone.')
    if ((body as { confirm?: unknown } | null)?.confirm !== true) return err(400, 'confirm_required', 'Restoring a backup needs confirm: true.')
    if (state.runsActive) return err(409, 'runs_active', 'Scripts are running. Wait for them to finish, then restore.')
    return { status: 200, body: found }
  }
  if (path === '/api/agents' && m === 'GET') return { status: 200, body: state.agents.map((a) => ({ id: a.id, name: a.name })) }
  const runs = /^\/api\/agents\/([^/]+)\/script-runs$/.exec(path)
  if (runs && m === 'GET') {
    if (!state.runsActive) return { status: 200, body: { runs: [], hasMore: false } }
    return { status: 200, body: { runs: [{ id: 'run-1', agentId: decodeURIComponent(runs[1]), status: 'running' }], hasMore: false } }
  }
  return null
}

let store = createFakeVmsState('default')

/** Test hook: replace the process-wide fallback store. */
export function resetFakeVms(scene: VmsScene = 'default', now?: Date): void {
  store = createFakeVmsState(scene, now)
}

/** The store the VITE_VMS_FAKE=1 path reads. */
export function currentFakeVms(): FakeVmsState {
  return store
}
