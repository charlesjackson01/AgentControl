/**
 * BE-P2-19: the §13 security boundaries (PHASE2_PLAN §13, M3 plan §6.4) and the tests that cover
 * each one. security-coverage.test.ts checks every reference against the test files (the file
 * exists, the title is in it, the tag matches the file kind), so a renamed or removed test fails
 * the plain suite instead of leaving a row silently uncovered.
 *
 * Tags:
 * - `unit`: plain vitest with fakes (the engine guard fails any podman/docker call).
 * - `@vm`: a real engine; runs with AC_VM_TESTS=1 (Linux, root3 here), one file at a time.
 * - `@win` / `@mac`: real Windows (WSL2) / macOS hosts; AC_WIN_TESTS=1 / AC_MAC_TESTS=1 on that OS.
 *   Skipped everywhere else (M3 decision 1: nightly once a hosted runner exists, not merge gates).
 */

export type SecurityTag = 'unit' | '@vm' | '@win' | '@mac'
export interface SecurityTestRef {
  tag: SecurityTag
  /** Under src/. */
  file: string
  /** A substring of the `it(...)` / `describe(...)` title in that file. */
  title: string
}
export interface SecurityRow {
  id: string
  /** The §13 boundary. */
  boundary: string
  /** What §13's test column asks for. */
  checks: string
  tests: SecurityTestRef[]
  /** Parts that can't be automated on this machine (shown in docs/vm.md and the report). */
  manual?: string[]
}

/** True on a run that may use the real engine (`@vm`). */
export const VM_TESTS = process.env.AC_VM_TESTS === '1'
/** True only on a Windows host that opted in (`@win`). */
export const WIN_TESTS = process.env.AC_WIN_TESTS === '1' && process.platform === 'win32'
/** True only on a macOS host that opted in (`@mac`). */
export const MAC_TESTS = process.env.AC_MAC_TESTS === '1' && process.platform === 'darwin'

const vm = (file: string, title: string): SecurityTestRef => ({ tag: '@vm', file, title })
const unit = (file: string, title: string): SecurityTestRef => ({ tag: 'unit', file, title })
const sec = (title: string): SecurityTestRef => vm('security.vm.test.ts', title)
const win = (title: string): SecurityTestRef => ({ tag: '@win', file: 'security.win.test.ts', title })
const mac = (title: string): SecurityTestRef => ({ tag: '@mac', file: 'security.mac.test.ts', title })

export const SECURITY_ROWS: SecurityRow[] = [
  {
    id: 'bot_bot',
    boundary: 'Bot ↔ bot (same machine)',
    checks: "bot A can't list or read bot B's workspace, tools volume, snapshots, env or processes; uid inside A ≠ uid inside B on the host side (where idmap is on)",
    tests: [
      vm('isolation.vm.test.ts', "3 bots at once: none sees another's workspace, tools volume, env, processes or network"),
      vm('isolation.vm.test.ts', 'distinct host uids per bot (idmap only)'),
      vm('isolation.vm.test.ts', "mounting another bot's folder throws before the engine is called"),
      vm('egress.vm.test.ts', "a credential is bound to its bot's network"),
      sec("bot ↔ bot: another bot's snapshots aren't mounted or findable"),
      unit('isolation.test.ts', 'symlink escapes are refused'),
      mac('bot ↔ bot: two bots in the agentcontrol machine'),
      win('bot ↔ bot: two bots in the agentcontrol machine'),
    ],
  },
  {
    id: 'host_files',
    boundary: 'Script → host files',
    checks: 'escape attempts fail; a crafted manifest path is rejected',
    tests: [
      vm('isolation.vm.test.ts', 'read-only mounts and the root fs give EROFS; nothing reaches the host'),
      vm('podman-runner.vm.test.ts', 'read-only mounts and root fs give EROFS; workspace writes reach the host'),
      sec('script → host files: a symlink a script makes is not followed by the BE'),
      unit('files.test.ts', 'every traversal and symlink attack returns 400 or 403 on every route'),
      unit('files.test.ts', 'refuses any symlink segment, even one pointing inside the root'),
      unit('file-tools.test.ts', 'refuses to read or write through a symlink'),
      unit('undo.test.ts', 'a crafted record (path traversal, odd zone, odd blob name) is refused and nothing is touched'),
      unit('backup-archive.test.ts', 'refuses unsafe names and anything but files and folders'),
    ],
  },
  {
    id: 'memory_profile',
    boundary: 'Script → memory/profile',
    checks: '`/bot` has no memory or BOT.md; `/bot/skills` and `/bot/shared` are EROFS',
    tests: [
      vm('podman-runner.vm.test.ts', '/bot has no memory and no BOT.md anywhere'),
      vm('isolation.vm.test.ts', 'read-only mounts and the root fs give EROFS'),
      sec('script → memory/profile with the product mounts: no memory or profile; inputs read-only'),
      unit('security.test.ts', 'memory/profile: the product mounts never include memory, BOT.md, another bot or snapshots'),
    ],
  },
  {
    id: 'network',
    boundary: 'Script → network',
    checks: 'with policy `always`: 192.168.x, 10.x, 100.64.x, `fd7a:115c:a1e0::/48`, the host, the model server and the metadata IP all fail; direct sockets fail',
    tests: [
      vm('egress.vm.test.ts', 'a granted run reaches the local server through the proxy (HTTP and CONNECT); everything else is blocked and logged'),
      vm('egress.vm.test.ts', 'BE-P2-19 network under always: home network, Tailscale, this computer, the model server and metadata all 403; direct sockets fail'),
      vm('egress.vm.test.ts', 'firewall: with the proxy'),
      vm('egress.vm.test.ts', "user-only: an Always-policy run can't reach the BE"),
      vm('egress.vm.test.ts', 'the next offline run moves the container back to network none'),
      unit('egress-rules.test.ts', 'model server: a local address on its port is model_server'),
      mac('network: LAN and Tailscale addresses of this Mac'),
      win('network: LAN and Tailscale addresses of this PC'),
    ],
  },
  {
    id: 'resources',
    boundary: 'Resources',
    checks: 'OOM, fork bomb, runaway output and a full disk each produce a clear status',
    tests: [
      vm('podman-runner.vm.test.ts', 'limits: a 5 GB allocation is OOM-killed with a clear status'),
      vm('podman-runner.vm.test.ts', 'limits: a fork bomb stops at the 256-process limit with a clear status'),
      vm('podman-runner.vm.test.ts', '300 MB of output is cut at 200 MB and the run stopped'),
      vm('podman-runner.vm.test.ts', 'timeout stops the run (and the container)'),
      sec('resources: a full /tmp gives ENOSPC and the run fails with a clear status'),
      unit('run-service.test.ts', 'under 3 GB free refuses the run (409 low_disk), and nothing is recorded'),
      unit('run-service.test.ts', 'space dropping under 3 GB while queued fails the run at its turn (reason low_disk)'),
      vm('snapshot-budget.vm.test.ts', 'over the personal limit, the run is blocked with personal_quota'),
    ],
  },
  {
    id: 'privilege',
    boundary: 'Privilege',
    checks: '`mount`, raw sockets and `capsh` fail',
    tests: [
      vm('bot-env.vm.test.ts', 'container: uid 1000, read-only root, no network'),
      sec('privilege: mount, raw sockets, setuid and capability raising all fail; no capabilities'),
    ],
  },
  {
    id: 'engine_storage',
    boundary: 'Engine and storage helper',
    checks: 'not reachable from a bot (`/run/podman`, the helper name)',
    tests: [
      sec('engine and storage helper: no engine socket, no engine variables, no ac-storaged name'),
      win('ac-storaged: no network, not reachable from a bot'),
    ],
  },
  {
    id: 'secrets',
    boundary: 'Secrets',
    checks: '`env` shows no `GITHUB_TOKEN`, `TS_AUTHKEY` or LLM keys',
    tests: [
      vm('bot-env.vm.test.ts', 'env injected (PATH_APPEND, no host env)'),
      sec("secrets: the server's tokens and LLM keys reach neither the container nor the runner's log"),
      vm('egress.vm.test.ts', 'B4: curl -v through the proxy prints the credential in every form'),
      unit('bot-env.test.ts', 'env: always NAME=VALUE, PATH_APPEND extends the image PATH, reserved names dropped'),
      unit('bot-env-routes.test.ts', 'PATCH 400s: reserved names'),
    ],
  },
  {
    id: 'permissions',
    boundary: 'Permissions',
    checks: 'a model-issued call is rejected; a replay returns 409',
    tests: [
      unit('permission-routes.test.ts', 'POST: 403 confirm_required without the header, 400 bad_decision, 200, then 409 already_resolved with the request'),
      unit('permission-routes.test.ts', "user-only: the bot side (a VM network address or the proxy's Via) gets 403 user_only"),
      unit('permission-gate.test.ts', 'answer: 404 not_found, 400 bad_decision'),
      vm('permission-gate.vm.test.ts', "user-only: the bot side can't answer a card"),
      unit('security.test.ts', 'permissions: no model tool answers, approves or changes a permission'),
    ],
  },
  {
    id: 'windows_volume',
    boundary: 'Windows data volume',
    checks: 'a removed or mismatched volume gives `files_missing`, with runs and writes blocked',
    tests: [
      unit('files-missing.test.ts', 'missing marker only (workspace still there): VM tab and file routes both files_missing'),
      unit('files-missing.test.ts', 'marker from another setup: both sides show the mismatch message'),
      unit('files-missing.test.ts', 'whole bot folder gone (marker fine): files_missing on both sides'),
      win('Windows volume: the live helper sees the volume marker'),
    ],
  },
]

/**
 * Checks that aren't automated here, by row. Each one is listed in docs/vm.md (the coverage test
 * checks that), so nothing is skipped silently.
 */
export const SECURITY_GAPS: { row: string; gap: string }[] = [
  { row: 'bot_bot', gap: 'Distinct host uids need idmapped mounts; on keep-id hosts (rootless here) that test skips and all bots share the user\'s uid on the host.' },
  { row: 'resources', gap: 'OOM and fork-bomb limits need cgroup limits; on rootless cgroupfs hosts (this dev box) those tests skip with the probe\'s reason and runs need AC_ALLOW_UNLIMITED_RUNS=1.' },
  { row: 'resources', gap: 'A real full machine disk is not filled; the 3 GB floor is tested with a fake free-space reading and the full-disk check fills only the 512 MB /tmp.' },
  { row: 'network', gap: 'gvproxy on Mac and Windows: the @mac/@win network tests have never run (no Mac or Windows test machine).' },
  { row: 'engine_storage', gap: 'ac-storaged runs only on Windows: the @win test has never run.' },
  { row: 'windows_volume', gap: 'A real wsl --unregister followed by files_missing and restore needs a throwaway Windows machine; manual only.' },
  { row: 'privilege', gap: 'gVisor (runsc) runs of the suite depend on the host: with AC_VM_GVISOR=force_on on a host where runsc passes the probe.' },
]
