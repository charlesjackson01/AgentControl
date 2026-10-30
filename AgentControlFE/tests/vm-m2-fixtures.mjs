// FE-P2-10: M2 VM tab fixtures shaped like mockups m2-11…14 (browser add-on states, a tool build in progress).
import { NOW, runRow, vmInfo } from './vm-fixtures.mjs'

export { NOW }
const GB = 1024 ** 3
const at = (h, m, s = 0) => new Date(2026, 9, 20, h, m, s).toISOString()
const ago = (sec) => new Date(NOW.getTime() - sec * 1000).toISOString()

/** GET /api/vm/browser. */
export const addon = (extra = {}) => ({ state: 'absent', totalBytes: 1343 * 1000 ** 2, usedBy: [], ...extra })

const perms = (browser, browserState, progress) => ({ browser, browserState, ...(progress === undefined ? {} : { progress }) })

/** Each browser row state from mockup 12 (plus the GAP states). Returns { vm, addon }. */
export const browserStates = {
  off: () => ({ vm: vmInfo(), addon: addon() }),
  setting_up: () => ({ vm: vmInfo({ permissions: perms(true, 'absent'), browser: { state: 'setting_up', setup: { step: 'download', startedAt: ago(3), download: {}, rebuild: {} } } }), addon: addon() }),
  downloading: () => ({
    vm: vmInfo({ permissions: perms(true, 'downloading', 0.46), browser: { state: 'setting_up', setup: { step: 'download', startedAt: ago(90), download: { startedAt: ago(90), bytes: 620e6, totalBytes: 1343e6 }, rebuild: {} } } }),
    addon: addon({ state: 'downloading', progress: 0.46, bytes: 620e6, etaSec: 64 }),
  }),
  rebuilding: () => ({
    vm: vmInfo({
      permissions: perms(true, 'ready'),
      browser: { state: 'rebuilding', setup: { step: 'rebuild', startedAt: ago(300), download: { bytes: 1343e6 }, rebuild: { runId: 'build-br', startedAt: ago(38) } } },
      activeBuild: {
        runId: 'build-br', status: 'running', startedAt: ago(38), internet: 'off', hosts: [],
        build: { generation: 4, fromGeneration: 3, packages: ['poppler-utils'], added: [], startedBy: 'user', via: 'browser', base: 'browser', progress: { step: 7, steps: 10, label: 'image build' } },
      },
    }),
    addon: addon({ state: 'ready', usedBy: ['analyst'] }),
  }),
  waiting_idle: () => ({ vm: vmInfo({ permissions: perms(true, 'ready'), browser: { state: 'waiting_idle' } }), addon: addon({ state: 'ready', usedBy: ['analyst'] }) }),
  ready: () => ({
    vm: vmInfo({ permissions: perms(true, 'ready'), browser: { state: 'ready', chromium: { version: '131', checkedAt: at(9, 54) } }, image: { generation: 4, previous: 3, builtAt: at(9, 52), base: 'browser' } }),
    addon: addon({ state: 'ready', usedBy: ['analyst', 'primary'], readyAt: at(9, 50) }),
  }),
  download_failed: () => ({
    vm: vmInfo({ permissions: perms(true, 'error'), browser: { state: 'error', error: { reason: 'download_failed', message: "Couldn't download headless Chromium.", at: at(9, 53), bytes: 840e6, detail: 'the connection dropped at 840 MB' } } }),
    addon: addon({ state: 'error', error: "Couldn't download headless Chromium." }),
  }),
  check_failed: () => ({
    vm: vmInfo({ permissions: perms(true, 'ready'), browser: { state: 'error', error: { reason: 'chromium_check_failed', message: "Chromium didn't start.", at: at(9, 58), detail: 'libnss3.so missing' } } }),
    addon: addon({ state: 'ready', usedBy: ['analyst'] }),
  }),
  low_disk: () => ({
    vm: vmInfo({ permissions: perms(true, 'absent'), browser: { state: 'error', error: { reason: 'low_disk', message: 'The download needs about 1.3 GB, plus 3 GB kept free for runs, and this computer has 2.5 GB free.', at: at(9, 50), neededBytes: 1343e6 + 3 * GB, freeBytes: 2.59 * GB } } }),
    addon: addon(),
  }),
  build_failed: () => ({
    vm: vmInfo({ permissions: perms(true, 'ready'), browser: { state: 'error', error: { reason: 'build_failed', message: "Stopped. Analyst keeps its current tools (version 3).", at: at(9, 56) } } }),
    addon: addon({ state: 'ready', usedBy: [] }),
  }),
  turning_off: () => ({ vm: vmInfo({ permissions: perms(false, 'ready'), browser: { state: 'rebuilding' } }), addon: addon({ state: 'ready', usedBy: ['analyst'] }) }),
  off_remove: () => ({ vm: vmInfo(), addon: addon({ state: 'ready', usedBy: [] }) }),
}

/** Mockup 14: a vm_install build adding matplotlib and pandas (version 3 from 2), with a run queued behind it. */
export const buildingVm = (status = 'running', extra = {}) =>
  vmInfo({
    packages: ['jq'],
    tools: { pip: [], npm: [], optBin: [], updatedAt: at(9, 0) },
    image: { generation: 2, previous: 1, builtAt: at(9, 0), base: 'base' },
    activeBuild: {
      runId: 'build-3', status, ...(status === 'running' ? { startedAt: ago(72) } : {}), internet: 'once', hosts: ['pypi.org', 'files.pythonhosted.org'],
      build: { generation: 3, fromGeneration: 2, packages: ['jq', 'matplotlib', 'pandas'], added: ['matplotlib', 'pandas'], startedBy: 'bot', via: 'vm_install', base: 'base', ...(status === 'running' ? { progress: { step: 4, steps: 6, label: 'pip install' } } : {}) },
    },
    runs: buildRuns(status),
    ...extra,
  })

export const buildRuns = (status = 'running') => [
  runRow('chart_q', { argv: ['python3', 'chart_revenue.py'], status: 'queued', exitCode: null, startedAt: undefined, endedAt: undefined, durationMs: undefined, queuedAt: ago(30), undo: { state: 'none' }, filesChangedCount: 0, queuedReason: 'tool_build' }),
  runRow('build-3', {
    kind: 'tool_build', argv: ['vm_install', 'matplotlib', 'pandas'], status, exitCode: null, queuedAt: ago(80), startedAt: status === 'running' ? ago(72) : undefined, endedAt: undefined, durationMs: undefined,
    undo: { state: 'none' }, filesChangedCount: 0, network: 'on', internet: 'once', hosts: ['pypi.org', 'files.pythonhosted.org'],
    build: { generation: 3, fromGeneration: 2, packages: ['jq', 'matplotlib', 'pandas'], added: ['matplotlib', 'pandas'], startedBy: 'bot', via: 'vm_install', base: 'base' },
  }),
  runRow('fetch_ok', { argv: ['python3', 'fetch_rates.py'], filesChangedCount: 1, files: { added: 1, modified: 0, deleted: 0 }, durationMs: 3800, network: 'on', internet: 'once', endedAt: at(9, 41) }),
]
