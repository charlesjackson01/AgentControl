/*
 * FE-P2-8: the in-memory world the Playwright fake runner serves.
 * No podman, no disks. Shapes follow the FE types the chat, VM tab and Settings › VMs already read.
 * `scene` (cookie ac-e2e-scene) only changes the host OS: mac, linux, or windows (`storage.backend === 'wsl'`).
 */

export const FROZEN_NOW = '2026-11-06T15:00:00.000Z'
const AGENT = 'analyst'
const CONV = 'dm-analyst'

const GB = 1024 ** 3

function run(partial) {
  return {
    id: partial.id,
    agentId: AGENT,
    conversationId: CONV,
    messageId: partial.messageId,
    context: 'dm',
    kind: 'script',
    argv: partial.argv,
    cwd: 'workspace',
    why: partial.why,
    network: partial.network ?? 'off',
    browser: Boolean(partial.browser),
    runtime: partial.runtime ?? 'crun',
    permissions: partial.permissions ?? [],
    status: partial.status,
    exitCode: partial.exitCode,
    queuedAt: partial.queuedAt,
    startedAt: partial.startedAt,
    endedAt: partial.endedAt,
    durationMs: partial.durationMs,
    peakMemoryMb: partial.peakMemoryMb,
    stdoutTail: partial.stdoutTail ?? '',
    stderrTail: partial.stderrTail ?? '',
    outputBytes: partial.outputBytes ?? 0,
    filesChanged: partial.filesChanged ?? [],
    snapshot: partial.snapshot ?? null,
    undo: partial.undo,
    waitingFor: partial.waitingFor,
  }
}

function summaryOf(row, name, files) {
  return {
    status: row.status,
    kind: 'script',
    name,
    scriptName: name,
    files,
    undo: { ...row.undo },
    exitCode: row.exitCode,
    durationMs: row.durationMs,
    network: row.network,
    browser: row.browser,
    waitingFor: row.waitingFor,
  }
}

function historyOf(row, name, files) {
  const changed = (files.added ?? 0) + (files.modified ?? 0) + (files.deleted ?? 0)
  return {
    id: row.id,
    agentId: row.agentId,
    conversationId: row.conversationId,
    kind: row.kind,
    argv: row.argv,
    why: row.why,
    status: row.status,
    exitCode: row.exitCode,
    queuedAt: row.queuedAt,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    durationMs: row.durationMs,
    runtime: row.runtime,
    undo: { ...row.undo },
    network: row.network,
    filesChangedCount: changed,
    files,
  }
}

const evicted = run({
  id: 'run-evicted',
  messageId: 'm-evicted',
  argv: ['python3', 'clean_sales.py'],
  why: 'Drop the blank rows.',
  network: 'off',
  status: 'succeeded',
  exitCode: 0,
  queuedAt: '2026-10-19T14:10:00.000Z',
  startedAt: '2026-10-19T14:10:02.000Z',
  endedAt: '2026-10-19T14:10:06.000Z',
  durationMs: 4200,
  peakMemoryMb: 90,
  stdoutTail: 'cleaned 12 rows\n',
  outputBytes: 18,
  filesChanged: [{ path: 'workspace/sales.csv', change: 'modified', bytes: 4096 }],
  snapshot: null,
  // Evicted to stay inside the bot's undo budget (plan §7.4 budget_bot).
  undo: { state: 'unavailable', reason: 'budget_bot', at: '2026-10-20T03:00:00.000Z' },
})

const undoable = run({
  id: 'run-ok',
  messageId: 'm-ok',
  argv: ['python3', 'chart_week.py'],
  why: 'Chart this week.',
  network: 'on',
  status: 'succeeded',
  exitCode: 0,
  queuedAt: '2026-10-20T16:20:00.000Z',
  startedAt: '2026-10-20T16:20:01.000Z',
  endedAt: '2026-10-20T16:20:05.000Z',
  durationMs: 3800,
  peakMemoryMb: 120,
  stdoutTail: 'wrote week.csv\n',
  outputBytes: 16,
  filesChanged: [{ path: 'workspace/week.csv', change: 'added', bytes: 1200 }],
  snapshot: { id: 'snap-ok', driver: 'overlay', retainedBytes: 1200 },
  undo: { state: 'available' },
  permissions: [{ type: 'internet', decision: 'allow_once', requestId: 'p-old', source: 'card' }],
})

const waitingNet = run({
  id: 'run-net',
  messageId: 'm-net',
  argv: ['python3', 'fetch_rates.py'],
  why: 'Fetch the latest EUR rates.',
  network: 'on',
  status: 'waiting_permission',
  waitingFor: 'permission',
  queuedAt: '2026-11-06T14:50:00.000Z',
  stdoutTail: '',
  snapshot: null,
  undo: { state: 'unavailable' },
  permissions: [{ type: 'internet', decision: 'pending', requestId: 'p-net', source: 'card' }],
  runtime: null,
})

const waitingBrowser = run({
  id: 'run-browser',
  messageId: 'm-browser',
  argv: ['python3', 'snap_dashboard.py'],
  why: 'Save a picture of the sales dashboard.',
  network: 'on',
  browser: true,
  status: 'waiting_permission',
  waitingFor: 'permission',
  queuedAt: '2026-11-06T14:52:00.000Z',
  stdoutTail: '',
  snapshot: null,
  undo: { state: 'unavailable' },
  permissions: [{ type: 'browser', decision: 'pending', requestId: 'p-browser', source: 'card' }],
  runtime: null,
})

const permission = (partial) => ({
  id: partial.id,
  runId: partial.runId,
  agentId: AGENT,
  conversationId: CONV,
  messageId: partial.messageId,
  type: partial.type,
  hosts: partial.hosts,
  why: partial.why,
  status: 'pending',
  createdAt: '2026-11-06T14:55:00.000Z',
  expiresAt: '2026-11-06T15:10:00.000Z',
  runKind: 'script',
  scriptName: partial.scriptName,
  internetNext: partial.internetNext,
})

export function createWorld() {
  const runs = {
    'run-evicted': evicted,
    'run-ok': undoable,
    'run-net': waitingNet,
    'run-browser': waitingBrowser,
  }
  const permissions = {
    'p-net': permission({
      id: 'p-net',
      runId: 'run-net',
      messageId: 'm-p-net',
      type: 'internet',
      hosts: ['api.frankfurter.app'],
      why: 'Fetch the latest EUR rates.',
      scriptName: 'fetch_rates.py',
    }),
    'p-browser': permission({
      id: 'p-browser',
      runId: 'run-browser',
      messageId: 'm-p-browser',
      type: 'browser',
      why: 'Save a picture of the sales dashboard.',
      scriptName: 'snap_dashboard.py',
      internetNext: true,
    }),
  }
  return { runs, permissions }
}

const FILES = {
  'clean_sales.py': { added: 0, modified: 1, deleted: 0 },
  'chart_week.py': { added: 1, modified: 0, deleted: 0 },
  'fetch_rates.py': { added: 0, modified: 0, deleted: 0 },
  'snap_dashboard.py': { added: 0, modified: 0, deleted: 0 },
}

export function scriptName(row) {
  return row.argv[1] || row.argv[0] || 'script'
}

export function chatSummary(row) {
  const name = scriptName(row)
  return summaryOf(row, name, FILES[name] ?? { added: 0, modified: 0, deleted: 0 })
}

export function historyRow(row) {
  const name = scriptName(row)
  return historyOf(row, name, FILES[name] ?? { added: 0, modified: 0, deleted: 0 })
}

function message(id, partial) {
  return {
    id,
    conversationId: CONV,
    role: partial.role,
    content: partial.content ?? '',
    createdAt: partial.createdAt,
    kind: partial.kind,
    scriptRunId: partial.scriptRunId,
    scriptRun: partial.scriptRun,
    permissionRequestId: partial.permissionRequestId,
    authorAgentId: partial.authorAgentId,
  }
}

export function messagesFor(runs) {
  const byId = (id) => chatSummary(runs[id])
  return [
    message('m-user', { role: 'user', content: 'Can you clean the sales file, chart the week, and snapshot the dashboard?', createdAt: '2026-10-19T14:00:00.000Z' }),
    message('m-evicted', { role: 'assistant', kind: 'run', scriptRunId: 'run-evicted', scriptRun: byId('run-evicted'), authorAgentId: AGENT, createdAt: '2026-10-19T14:10:06.000Z' }),
    message('m-ok', { role: 'assistant', kind: 'run', scriptRunId: 'run-ok', scriptRun: byId('run-ok'), authorAgentId: AGENT, createdAt: '2026-10-20T16:20:05.000Z' }),
    message('m-net', { role: 'assistant', kind: 'run', scriptRunId: 'run-net', scriptRun: byId('run-net'), authorAgentId: AGENT, createdAt: '2026-11-06T14:50:00.000Z' }),
    message('m-p-net', { role: 'assistant', kind: 'permission', permissionRequestId: 'p-net', authorAgentId: AGENT, createdAt: '2026-11-06T14:50:01.000Z' }),
    message('m-browser', { role: 'assistant', kind: 'run', scriptRunId: 'run-browser', scriptRun: byId('run-browser'), authorAgentId: AGENT, createdAt: '2026-11-06T14:52:00.000Z' }),
    message('m-p-browser', { role: 'assistant', kind: 'permission', permissionRequestId: 'p-browser', authorAgentId: AGENT, createdAt: '2026-11-06T14:52:01.000Z' }),
  ]
}

export const agent = {
  id: AGENT,
  name: 'Analyst',
  role: 'Research',
  description: 'Looks things up and charts them.',
  instructions: 'Be brief.',
  modelId: 'local',
  endpointId: 'ep1',
  skillIds: [],
  status: 'idle',
  createdAt: '2026-10-01T00:00:00.000Z',
  lastRunAt: '2026-11-06T14:52:00.000Z',
  runCount: 4,
  isPrimary: true,
  slug: 'analyst',
  internetPolicy: 'ask',
  memoryLearn: true,
  color: '#3b6cff',
  avatar: { kind: 'emoji', value: '📊' },
  vm: {
    permissions: { browser: false },
    gvisor: 'inherit',
    env: [],
    packages: [],
    image: { generation: 2, base: 'base' },
    egress: { allow: [] },
  },
}

export function conversation(runs) {
  const msgs = messagesFor(runs)
  const last = msgs[msgs.length - 1]
  return {
    id: CONV,
    kind: 'dm',
    agentId: AGENT,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: last.createdAt,
    lastReadAt: last.createdAt,
    lastMessage: last,
    unreadCount: 0,
    typingAgentId: null,
  }
}

const MACHINE = {
  name: 'agentcontrol',
  state: 'running',
  memoryMb: 6144,
  cpus: 4,
  diskGb: 60,
  diskUsedGb: 23,
  growOffer: { toGb: 90 },
}

/** mac (default), linux (native, no machine disk), windows (wsl). */
export function hostFor(scene) {
  if (scene === 'windows') {
    return {
      engine: 'podman',
      version: '5.4.0',
      provider: 'wsl',
      os: 'win32',
      machine: { ...MACHINE },
      storage: { driver: 'overlay', backend: 'wsl', volumeState: 'ok' },
      concurrency: 1,
      setupSteps: [],
    }
  }
  if (scene === 'linux') {
    return {
      engine: 'podman',
      version: '5.4.0',
      provider: 'native',
      os: 'linux',
      machine: null,
      storage: { driver: 'overlay', backend: 'local', volumeState: 'ok' },
      concurrency: 2,
      setupSteps: [],
    }
  }
  return {
    engine: 'podman',
    version: '5.4.0',
    provider: 'libkrun',
    os: 'darwin',
    machine: { ...MACHINE },
    storage: { driver: 'overlay', backend: 'local', volumeState: 'ok' },
    concurrency: 1,
    setupSteps: [],
  }
}

export function vmFor(scene, runs) {
  const win = scene === 'windows'
  const linux = scene === 'linux'
  const history = Object.values(runs)
    .filter((row) => row.agentId === AGENT && row.kind === 'script')
    .sort((a, b) => b.queuedAt.localeCompare(a.queuedAt))
    .map(historyRow)
  return {
    agentId: AGENT,
    state: 'running',
    host: {
      engine: 'podman',
      provider: win ? 'wsl' : linux ? 'native' : 'libkrun',
      ...(linux ? {} : { machine: 'agentcontrol' }),
    },
    runtime: {
      effective: 'crun',
      status: 'active',
      mode: 'inherit',
      globalMode: 'auto',
      limitsEnforced: true,
      checkedAt: '2026-11-06T09:11:00.000Z',
    },
    internetPolicy: 'ask',
    permissions: { browser: false, browserState: 'absent' },
    limits: { memoryMb: 4096, personalDiskMb: 10240, cpus: 2, timeoutSec: 600, pids: 256, outputMb: 200 },
    usage: {
      memoryMb: 80,
      personalBytes: 200 * 1024 * 1024,
      personalQuotaBytes: 10 * GB,
      breakdown: { workspace: 120 * 1024 * 1024, inputs: 0, memory: 20 * 1024 * 1024, tools: 40 * 1024 * 1024, opt: 0, imageLayer: 20 * 1024 * 1024 },
      snapshots: { bytes: 4096, budgetBytes: 2 * GB, runsWithUndo: 1 },
    },
    env: [],
    packages: ['jq'],
    image: { generation: 2, base: 'base' },
    storage: win
      ? {
          backend: 'wsl',
          driver: 'overlay',
          location: '/mnt/agentcontrol/bots/analyst',
          lastBackupAt: '2026-11-04T03:00:00.000Z',
          explorerPath: '\\\\wsl$\\agentcontrol\\bots\\analyst',
        }
      : { backend: 'local', driver: 'overlay', location: 'data/bots/analyst' },
    runs: history,
    runsHasMore: false,
  }
}

export const settings = {
  gvisor: 'auto',
  backups: { enabled: true, time: '03:00', keep: 7 },
  snapshotBudget: { perBotMb: 2048, globalMb: 15360, freeFloorMb: 5120 },
}

export const probe = {
  runsc: { installed: true, version: '20261101.0' },
  checks: [{ id: 'network', status: 'pass' }],
  compatible: true,
  uidMapping: 'idmap',
  snapshotDriver: 'overlay',
  checkedAt: '2026-11-06T09:11:00.000Z',
  versions: { engine: '5.4.0', runsc: '20261101.0', image: null },
}

export const browser = { state: 'ready', totalBytes: 1343 * 1000 ** 2, usedBy: [] }

const MB = 1024 * 1024
export const backups = [
  {
    id: 'bk-nightly',
    createdAt: '2026-11-04T03:00:00.000Z',
    trigger: 'nightly',
    agentIds: [AGENT],
    bytes: 842 * MB,
    path: 'data/backups/2026-11-04',
    status: 'complete',
    finishedAt: '2026-11-04T03:12:00.000Z',
  },
]

export const profile = { name: 'Ada', onboardedAt: '2026-10-01T00:00:00.000Z', avatar: { kind: 'emoji', value: '🙂' } }

export const CONV_ID = CONV
export const AGENT_ID = AGENT
