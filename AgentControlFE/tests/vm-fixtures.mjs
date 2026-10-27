// FE-P2-5: VmInfo / VmHostInfo / run-summary fixtures shaped like the c-settings-vm-tab-v2 mockups (Analyst on a Mac).
const GB = 1024 ** 3
export const NOW = new Date(2026, 9, 20, 17, 40)
const at = (h, m, dayOffset = 0) => new Date(2026, 9, 20 + dayOffset, h, m).toISOString()

export const runRow = (id, extra = {}) => ({
  id,
  agentId: 'analyst',
  conversationId: 'dm-analyst',
  kind: 'script',
  argv: ['python3', `${id}.py`],
  status: 'succeeded',
  exitCode: 0,
  queuedAt: at(17, 30),
  startedAt: at(17, 30),
  endedAt: at(17, 33),
  durationMs: 4200,
  runtime: 'runsc',
  undo: { state: 'available' },
  filesChangedCount: 3,
  ...extra,
})

export const mockRuns = () => [
  runRow('clean', { argv: ['python3', 'clean.py'], filesChangedCount: 3, endedAt: at(17, 33) }),
  runRow('chart', { argv: ['python3', 'chart.py'], filesChangedCount: 1, groupId: 'g-q3', endedAt: at(16, 58), durationMs: 2100 }),
  runRow('fetch', { argv: ['python3', 'fetch_rates.py'], status: 'failed', exitCode: 1, filesChangedCount: 0, undo: { state: 'none' }, endedAt: at(16, 40), durationMs: 900 }),
  runRow('rename', { argv: ['bash', 'rename.sh'], status: 'undone', filesChangedCount: 6, undo: { state: 'done', at: at(15, 10) }, endedAt: at(15, 2) }),
  runRow('big', { argv: ['python3', 'export_all.py'], filesChangedCount: 41, undo: { state: 'unavailable', reason: 'budget_bot' }, endedAt: at(10, 4, -1) }),
  runRow('old', { argv: ['node', 'scrape.js'], filesChangedCount: 2, undo: { state: 'unavailable', reason: 'expired' }, endedAt: at(9, 15, -6) }),
]

export const vmInfo = (extra = {}) => ({
  agentId: 'analyst',
  state: 'running',
  host: { engine: 'podman', provider: 'libkrun', machine: 'agentcontrol' },
  runtime: { effective: 'runsc', status: 'active', checkedAt: at(17, 2), mode: 'inherit', globalMode: 'auto' },
  internetPolicy: 'ask',
  permissions: { browser: false, browserState: 'absent' },
  limits: { memoryMb: 4096, personalDiskMb: 10240, cpus: 2, timeoutSec: 600, pids: 256, outputMb: 200 },
  usage: {
    memoryMb: 1229,
    personalBytes: 1.9 * GB,
    personalQuotaBytes: 10 * GB,
    breakdown: { workspace: 0.3 * GB, inputs: 0.05 * GB, memory: 0.05 * GB, tools: 1.1 * GB, opt: 0.2 * GB, imageLayer: 0.2 * GB },
    snapshots: { bytes: 0.6 * GB, budgetBytes: 2 * GB, runsWithUndo: 14 },
  },
  env: [
    { name: 'TZ', value: 'Europe/London' },
    { name: 'MPLBACKEND', value: 'Agg' },
    { name: 'PATH_APPEND', value: '/opt/analyst/bin' },
  ],
  packages: ['poppler-utils'],
  tools: { pip: ['matplotlib==3.10.1', 'pandas==2.2.3'], npm: ['csv-parse'], optBin: [], updatedAt: at(17, 33) },
  image: { generation: 3, previous: 2, builtAt: at(17, 33), base: 'base' },
  idleStopAt: new Date(NOW.getTime() + 12 * 60_000).toISOString(),
  storage: { backend: 'local', driver: 'overlay', location: '~/Library/Application Support/AgentControl/bots/analyst' },
  runs: mockRuns(),
  ...extra,
})

export const macHost = (extra = {}) => ({
  engine: 'podman',
  version: '5.4.0',
  provider: 'libkrun',
  os: 'darwin',
  machine: { name: 'agentcontrol', state: 'running', memoryMb: 6144, cpus: 4, diskGb: 60, diskUsedGb: 21 },
  storage: { driver: 'overlay', backend: 'local', volumeState: 'ok' },
  concurrency: 1,
  setupSteps: [],
  ...extra,
})

export const winVm = (extra = {}) =>
  vmInfo({
    host: { engine: 'podman', provider: 'wsl', machine: 'agentcontrol' },
    storage: {
      backend: 'wsl',
      driver: 'reflink',
      location: '/var/lib/agentcontrol/bots/analyst',
      lastBackupAt: at(3, 0),
      explorerPath: '\\\\wsl$\\agentcontrol\\var\\lib\\agentcontrol\\bots\\analyst',
    },
    ...extra,
  })

export const winHost = (extra = {}) => macHost({ provider: 'wsl', os: 'win32', storage: { driver: 'reflink', backend: 'wsl', volumeState: 'ok' }, ...extra })

export const probeResult = (extra = {}) => ({
  runsc: { installed: true, version: 'release-20260105.0' },
  checks: [],
  compatible: true,
  uidMapping: 'idmap',
  snapshotDriver: 'overlay',
  checkedAt: at(17, 2),
  versions: { engine: '5.4.0', runsc: 'release-20260105.0', image: 'sha256:abc' },
  ...extra,
})
