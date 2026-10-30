// FE-P2-9: M2 run cards from mockups 01–08 (fake data, contract fec4670). Shared by the tests and the shots.
import { run, summary } from './live-fixtures.mjs'

export const T0 = Date.parse('2026-10-30T14:40:00.000Z')
export const at = (ms) => new Date(T0 + ms).toISOString()
const fetchArgv = ['python3', 'fetch_rates.py', '--from', '2026-10-01', '--to', '2026-10-30']
const snapArgv = ['python3', 'snap_dashboard.py', 'https://dash.example.com/sales']
const build3 = { generation: 3, fromGeneration: 2, packages: ['jq', 'matplotlib', 'pandas'], added: ['matplotlib', 'pandas'], startedBy: 'bot', via: 'vm_install', base: 'base', progress: { step: 4, steps: 6, label: 'pip install' } }
const BUILD_LOG = 'Step 4/6: pip install matplotlib==3.9.2 pandas==2.2.3\nDownloading matplotlib-3.9.2-cp312-manylinux_2_17_x86_64.whl (8.3 MB)\nDownloading pandas-2.2.3-cp312-manylinux_2_17_x86_64.whl (12.7 MB)'

/** Each card: { key, mockup, run, summary, output?, gap? } */
export const M2_CARDS = [
  {
    key: '01-waiting-internet', mockup: '01',
    run: run('w1', { argv: fetchArgv, network: 'on', status: 'waiting_permission', waitingFor: 'permission', permissions: [{ type: 'internet', decision: 'pending', requestId: 'p1', source: 'card' }] }),
    summary: summary({ status: 'waiting_permission', name: 'fetch_rates.py', waitingFor: 'permission', network: 'on' }),
  },
  {
    key: '03-waiting-browser-ask', mockup: '03',
    run: run('w2', { argv: snapArgv, network: 'on', browser: true, status: 'waiting_permission', waitingFor: 'permission', permissions: [{ type: 'browser', decision: 'pending', requestId: 'p2', source: 'card' }] }),
    summary: summary({ status: 'waiting_permission', name: 'snap_dashboard.py', waitingFor: 'permission', network: 'on', browser: true }),
  },
  {
    key: '04-waiting-for-browser', mockup: '04', gap: 'waitingBrowserMeta',
    run: run('w3', { argv: snapArgv, network: 'on', browser: true, status: 'waiting_permission', waitingFor: 'browser', permissions: [{ type: 'browser', decision: 'enable', requestId: 'p2', source: 'card' }] }),
    summary: summary({ status: 'waiting_permission', name: 'snap_dashboard.py', waitingFor: 'browser', network: 'on', browser: true }),
  },
  {
    key: '05-browser-on-internet-asked', mockup: '05',
    run: run('w4', { argv: snapArgv, network: 'on', browser: true, status: 'waiting_permission', waitingFor: 'permission', permissions: [{ type: 'browser', decision: 'enable', requestId: 'p2', source: 'card' }, { type: 'internet', decision: 'pending', requestId: 'p3', source: 'card' }] }),
    summary: summary({ status: 'waiting_permission', name: 'snap_dashboard.py', waitingFor: 'permission', network: 'on', browser: true }),
  },
  {
    key: '02-denied', mockup: '02',
    run: run('d1', { argv: fetchArgv, network: 'on', status: 'denied', reason: 'permission_denied', error: "You denied internet access, so this run didn't start. No files changed.", undo: { state: 'unavailable', reason: 'expired' }, permissions: [{ type: 'internet', decision: 'deny', requestId: 'p1', source: 'card' }] }),
    summary: summary({ status: 'denied', name: 'fetch_rates.py', reason: 'permission_denied' }),
  },
  {
    key: '06-network-run', mockup: '06',
    run: run('n1', {
      argv: fetchArgv, network: 'on', status: 'succeeded', exitCode: 0, startedAt: at(0), durationMs: 3800, peakMemoryMb: 61,
      snapshot: { id: 'run-0051', driver: 'reflink', retainedBytes: 1200 },
      permissions: [{ type: 'internet', decision: 'always', source: 'policy' }],
      filesChanged: [{ path: 'data/eurusd-2026-10.csv', change: 'added', bytes: 1229 }],
      hostsContacted: [
        { host: '192.168.1.20', port: 8080, ip: '192.168.1.20', count: 1, blocked: true, reason: 'home_network' },
        { host: 'api.frankfurter.app', ip: '104.21.3.4', count: 2, blocked: false },
        { host: 'pypi.org', ip: '151.101.0.223', count: 1, blocked: false },
      ],
    }),
    summary: summary({ status: 'succeeded', name: 'fetch_rates.py', internet: 'always', exitCode: 0, files: { added: 1, modified: 0, deleted: 0 } }),
  },
  {
    key: '06-browser-run', mockup: '06',
    run: run('b1', {
      argv: snapArgv, network: 'on', browser: true, status: 'succeeded', exitCode: 0, startedAt: at(0), durationMs: 11600, peakMemoryMb: 688,
      permissions: [{ type: 'browser', decision: 'enable', requestId: 'p2', source: 'card' }, { type: 'internet', decision: 'allow_once', requestId: 'p3', source: 'card' }],
      filesChanged: [{ path: 'screenshots/sales-2026-10-30.png', change: 'added', bytes: 219_136 }],
      hostsContacted: [
        { host: 'metrics.internal.lan', count: 2, blocked: true, reason: 'private_name' },
        { host: 'dash.example.com', ip: '93.184.216.34', count: 14, blocked: false },
        { host: 'fonts.gstatic.com', ip: '142.250.1.1', count: 3, blocked: false },
      ],
    }),
    summary: summary({ status: 'succeeded', name: 'snap_dashboard.py', internet: 'once', browser: true, exitCode: 0, files: { added: 1, modified: 0, deleted: 0 } }),
  },
  {
    key: '07-tool-build-running', mockup: '07',
    run: run('tb1', { kind: 'tool_build', argv: [], network: 'on', status: 'running', startedAt: at(-72_000), build: build3, permissions: [{ type: 'internet', decision: 'allow_once', requestId: 'p9', source: 'card' }],
      hostsContacted: [{ host: 'pypi.org', count: 4, blocked: false, ip: '151.101.0.223' }, { host: 'files.pythonhosted.org', count: 9, blocked: false, ip: '151.101.64.223' }] }),
    summary: summary({ status: 'running', kind: 'tool_build', name: 'Rebuild tools', internet: 'once', startedAt: at(-72_000), build: build3 }),
    output: { stdout: BUILD_LOG, stderr: '' },
  },
  {
    key: '07-queued-after-build', mockup: '07',
    run: run('q1', { argv: ['python3', 'chart_revenue.py', 'data/sales.csv'], status: 'queued', queuePosition: 1 }),
    summary: summary({ status: 'queued', name: 'chart_revenue.py', queuePosition: 1, queuedReason: 'tool_build', afterBuild: { runId: 'tb1', generation: 3 } }),
  },
  {
    key: '08-internet-never', mockup: '08',
    run: run('e1', { argv: fetchArgv, network: 'on', status: 'denied', reason: 'internet_never', error: "Internet is set to Never for Primary, so this run didn't start. Change it in Settings › VM." }),
    summary: summary({ status: 'denied', name: 'fetch_rates.py', reason: 'internet_never' }),
  },
  {
    key: '08-host-blocked', mockup: '08',
    run: run('e2', { argv: ['python3', 'sync_nas.py'], network: 'on', status: 'failed', exitCode: 1, durationMs: 900, reason: 'host_blocked',
      error: 'The script tried to reach your Tailscale network. Home network and Tailscale are always blocked in Phase 2.',
      permissions: [{ type: 'internet', decision: 'always', source: 'policy' }],
      stderrTail: 'requests.exceptions.ProxyError: 403 Blocked: nas.tail1234.ts.net is on your Tailscale network\n',
      filesChanged: [{ path: 'workspace/sync.log', change: 'added', bytes: 120 }],
      hostsContacted: [{ host: 'nas.tail1234.ts.net', count: 1, blocked: true, reason: 'tailscale' }] }),
    summary: summary({ status: 'failed', name: 'sync_nas.py', internet: 'always', reason: 'host_blocked', exitCode: 1 }),
  },
  {
    key: '08-network-off', mockup: '08',
    run: run('e3', { argv: ['python3', 'scrape.py'], status: 'failed', exitCode: 1, durationMs: 400, reason: 'network_off',
      error: 'This run was started with the internet off, so connecting failed. Primary can run it again with the internet on.',
      stderrTail: 'urllib.error.URLError: <urlopen error [Errno -3] network is off>\n' }),
    summary: summary({ status: 'failed', name: 'scrape.py', reason: 'network_off', exitCode: 1 }),
  },
  {
    key: '08-build-failed', mockup: '08',
    run: run('e4', { kind: 'tool_build', argv: [], network: 'on', status: 'failed', exitCode: 100, durationMs: 41_000, reason: 'build_failed',
      error: 'The build failed, so Primary keeps its current tools (version 2). Nothing else changed.',
      build: { ...build3, added: ['libfoo-dev'], packages: ['jq', 'libfoo-dev'], progress: undefined }, stderrTail: 'E: Unable to locate package libfoo-dev\n' }),
    summary: summary({ status: 'failed', kind: 'tool_build', name: 'Rebuild tools', reason: 'build_failed' }),
  },
  {
    key: '08-proxy-unavailable', mockup: '08',
    run: run('e5', { argv: fetchArgv, network: 'on', status: 'failed', reason: 'proxy_unavailable',
      error: "AgentControl's internet proxy isn't running, so this run couldn't get the internet. Try again; if it keeps failing, re-check in Settings › VM." }),
    summary: summary({ status: 'failed', name: 'fetch_rates.py', reason: 'proxy_unavailable' }),
  },
  // GAPs (no mockup).
  {
    key: 'GAP-hosts-more', gap: 'hostsMore',
    run: run('g1', { argv: ['python3', 'crawl.py'], network: 'on', status: 'succeeded', exitCode: 0, durationMs: 52_000, peakMemoryMb: 140,
      permissions: [{ type: 'internet', decision: 'always', source: 'policy' }],
      hostsContacted: [
        { host: '10.0.0.5', ip: '10.0.0.5', count: 1, blocked: true, reason: 'home_network' },
        ...Array.from({ length: 19 }, (_, i) => ({ host: `site${i + 1}.example.com`, ip: `93.184.216.${i + 1}`, count: i + 1, blocked: false })),
      ],
      hostsContactedTotal: 31 }),
    summary: summary({ status: 'succeeded', name: 'crawl.py', internet: 'always' }),
  },
  {
    key: 'GAP-host-reasons', gap: 'hostReasons',
    run: run('g2', { argv: ['python3', 'probe.py'], network: 'on', status: 'failed', exitCode: 1, durationMs: 2100, reason: 'host_blocked',
      permissions: [{ type: 'internet', decision: 'allow_once', requestId: 'p5', source: 'card' }],
      stderrTail: 'ProxyError: 403 Blocked: 127.0.0.1 is this computer\n',
      hostsContacted: [
        { host: '127.0.0.1', port: 11434, ip: '127.0.0.1', count: 1, blocked: true, reason: 'this_computer' },
        { host: 'models.lan', port: 8000, count: 1, blocked: true, reason: 'model_server' },
        { host: '169.254.169.254', port: 80, ip: '169.254.169.254', count: 2, blocked: true, reason: 'metadata' },
        { host: 'example.com', port: 22, ip: '93.184.216.34', count: 1, blocked: true, reason: 'port' },
        { host: '240.0.0.1', ip: '240.0.0.1', count: 1, blocked: true, reason: 'reserved' },
      ] }),
    summary: summary({ status: 'failed', name: 'probe.py', reason: 'host_blocked', internet: 'once' }),
  },
  {
    key: 'GAP-build-stopped', gap: 'buildEnded',
    run: run('g3', { kind: 'tool_build', argv: [], network: 'on', status: 'stopped', durationMs: 65_000, reason: 'build_stopped', build: { ...build3, progress: undefined }, stderrTail: '' }),
    summary: summary({ status: 'stopped', kind: 'tool_build', name: 'Rebuild tools', reason: 'build_stopped' }),
  },
  {
    key: 'GAP-build-timed-out', gap: 'buildEnded',
    run: run('g4', { kind: 'tool_build', argv: [], network: 'on', status: 'timed_out', durationMs: 1_200_000, reason: 'build_failed', build: { ...build3, progress: undefined }, stderrTail: 'Building wheel for pandas (pyproject.toml) ... \n' }),
    summary: summary({ status: 'timed_out', kind: 'tool_build', name: 'Rebuild tools', reason: 'build_failed' }),
  },
  {
    key: 'GAP-build-succeeded', gap: 'buildEnded',
    run: run('g5', { kind: 'tool_build', argv: [], network: 'on', status: 'succeeded', exitCode: 0, durationMs: 96_000, build: { ...build3, progress: undefined },
      permissions: [{ type: 'internet', decision: 'allow_once', requestId: 'p9', source: 'card' }],
      hostsContacted: [{ host: 'pypi.org', count: 4, blocked: false, ip: '151.101.0.223' }, { host: 'files.pythonhosted.org', count: 9, blocked: false, ip: '151.101.64.223' }] }),
    summary: summary({ status: 'succeeded', kind: 'tool_build', name: 'Rebuild tools', internet: 'once' }),
  },
  {
    key: 'GAP-permission-timeout', gap: 'deniedOther',
    run: run('g6', { argv: fetchArgv, network: 'on', status: 'denied', reason: 'permission_timeout', permissions: [{ type: 'internet', decision: 'timeout', requestId: 'p1', source: 'card' }] }),
    summary: summary({ status: 'denied', name: 'fetch_rates.py', reason: 'permission_timeout' }),
  },
  {
    key: 'GAP-browser-denied', gap: 'deniedOther',
    run: run('g7', { argv: snapArgv, network: 'on', browser: true, status: 'denied', reason: 'permission_denied', permissions: [{ type: 'browser', decision: 'deny', requestId: 'p2', source: 'card' }] }),
    summary: summary({ status: 'denied', name: 'snap_dashboard.py', reason: 'permission_denied' }),
  },
  {
    key: 'GAP-browser-unavailable', gap: 'deniedOther',
    run: run('g8', { argv: snapArgv, network: 'on', browser: true, status: 'failed', reason: 'browser_unavailable' }),
    summary: summary({ status: 'failed', name: 'snap_dashboard.py', reason: 'browser_unavailable' }),
  },
]
export const cardByKey = (k) => M2_CARDS.find((c) => c.key === k)
