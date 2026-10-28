/**
 * BE-P2-8: runtime and limits probe (the runtime/cgroup part of RuntimeProbe; BE-P2-7 adds the
 * idmap, snapshot-mount, egress and Chromium checks and the cache triggers).
 *
 * For the standard runtime (crun/runc) and for gVisor (runsc), a throwaway container is run with
 * our hardening flags, `--network none` and LOW limits (64 MB, 32 processes). Inside, it reads
 * memory.max/pids.max, then really tries to exceed both: a 192 MB allocation must be OOM-killed
 * and 64 forks must hit the process limit. Limits count as enforced only when both fail.
 *
 * gVisor rootless often starts only with `--runtime-flag=ignore-cgroups --runtime-flag=network=none`;
 * that variant can't enforce limits, so it is reported Incompatible and crun stays in use.
 * `network=host` is never used.
 *
 * BE-P2-5: the `bind_mount` check. For each runtime that started, a second throwaway container
 * (same hardening flags, no limits) gets a host temp folder bind-mounted read-write at
 * /bot/workspace and another read-only at /bot/shared, with each uid mapping candidate in turn
 * (isolation.ts: idmap, then keep-id; Docker: the engine default). As uid 1000 it appends to a
 * file the server created, creates, renames and deletes a file, makes a folder and leaves one file
 * there, and writes to the read-only mount (must be EROFS). Back on the host, the files it left
 * must be owned by the server's uid/gid. The first candidate that passes is the uid mapping.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { execCommandRunner, type CommandResult, type CommandRunner } from './command-runner.js'
import type { EngineRef } from './bot-env.js'
import { BOT_GID, BOT_PATHS, BOT_UID, sharedImageRef } from './vm-images.js'
import { bindMountOptions, UID_MAPPINGS, usernsArgs, type UidMapping } from './isolation.js'
import { failWithReason } from './http.js'
import { PERMISSION_CSRF_HEADER } from './shared/types.js'
import type {
  ContainerRuntime,
  GlobalRuntimeMode,
  ProbeCheck,
  RuntimeMode,
  RuntimeStatus,
  VmInfo,
  VmProbeResult,
} from './shared/types.js'

/** Low limits used by the probe (the real ones are VM_LIMITS). */
export const PROBE_LIMITS = { memoryMb: 64, pids: 32, allocMb: 192, forks: 64 } as const
export const PROBE_TIMEOUT_MS = 45_000
export const PROBE_LABEL = 'io.agentcontrol.probe'
export const LIMITS_NOT_ENFORCED = "limits can't be enforced"
/** runsc variants, tried in order until one starts. Flags are podman global options (not stored in the container). */
export const RUNSC_FLAG_VARIANTS: readonly (readonly string[])[] = [
  [],
  ['--runtime-flag=network=none'],
  ['--runtime-flag=ignore-cgroups', '--runtime-flag=network=none'],
]
export const PROBE_MAX_AGE_MS = 24 * 60 * 60 * 1000

const PROBE_SCRIPT = `
import json, os, subprocess, sys
def rd(p):
    try:
        with open(p) as f:
            return f.read().strip()
    except OSError:
        return None
out = {"uid": os.getuid(), "memoryMax": rd("/sys/fs/cgroup/memory.max"), "pidsMax": rd("/sys/fs/cgroup/pids.max")}
try:
    with open("/proc/net/dev") as f:
        out["netifs"] = [l.split(":")[0].strip() for l in f.readlines()[2:] if ":" in l]
except OSError:
    out["netifs"] = []
out["python"] = sys.version.split()[0]
try:
    out["node"] = subprocess.run(["node", "--version"], capture_output=True, text=True, timeout=10).stdout.strip() or None
except Exception:
    out["node"] = None
try:
    r = subprocess.run([sys.executable, "-c", "b = b'x' * (${PROBE_LIMITS.allocMb} << 20); print(len(b))"], capture_output=True, text=True, timeout=20)
    out["allocExit"] = r.returncode
except Exception as e:
    out["allocExit"] = "error: %s" % e
FORK = """
import os, sys, time
pids = []
try:
    for i in range(${PROBE_LIMITS.forks}):
        p = os.fork()
        if p == 0:
            time.sleep(1)
            os._exit(0)
        pids.append(p)
except OSError:
    pass
print(len(pids))
sys.stdout.flush()
for p in pids:
    os.waitpid(p, 0)
"""
try:
    r = subprocess.run([sys.executable, "-c", FORK], capture_output=True, text=True, timeout=20)
    out["forked"] = int((r.stdout.strip() or "-1").splitlines()[0])
except Exception as e:
    out["forked"] = -1
print("AC_PROBE " + json.dumps(out))
`

const BIND_SCRIPT = `
import errno, json, os
W = "${BOT_PATHS.workspace}"
R = "${BOT_PATHS.inputs}"
out = {"uid": os.getuid()}
def err(e):
    return "%s %s" % (errno.errorcode.get(e.errno, e.errno), e.strerror)
def step(name, fn):
    try:
        fn()
        out[name] = "ok"
    except OSError as e:
        out[name] = err(e)
def append():
    with open(W + "/host.txt", "a") as f:
        f.write("bot\\n")
def create():
    with open(W + "/a.txt", "w") as f:
        f.write("x")
def keep():
    with open(W + "/d/kept.txt", "w") as f:
        f.write("k")
step("modify", append)
step("create", create)
step("mkdir", lambda: os.mkdir(W + "/d"))
step("rename", lambda: os.rename(W + "/a.txt", W + "/d/b.txt"))
step("delete", lambda: os.remove(W + "/d/b.txt"))
step("keep", keep)
try:
    with open(R + "/in.txt") as f:
        out["readRo"] = f.read().strip()
except OSError as e:
    out["readRo"] = err(e)
try:
    with open(R + "/x.txt", "w") as f:
        f.write("x")
    out["writeRo"] = "writable"
except OSError as e:
    out["writeRo"] = "EROFS" if e.errno == errno.EROFS else err(e)
print("AC_BIND " + json.dumps(out))
`
const BIND_STEPS = ['modify', 'create', 'mkdir', 'rename', 'delete', 'keep'] as const
const BIND_RO_TEXT = 'read only'

/** The bind_mount probe container's argv (after the engine's global args and runtime flags). */
export function bindProbeArgv(o: { name: string; image: string; runtime: ContainerRuntime | null; uidMapping: UidMapping | null; rw: string; ro: string }): string[] {
  return [
    'run', '--rm',
    '--name', o.name,
    '--label', `${PROBE_LABEL}=1`,
    '--network', 'none',
    '--user', `${BOT_UID}:${BOT_GID}`,
    '--read-only',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    ...(o.runtime ? ['--runtime', o.runtime] : []),
    ...usernsArgs(o.uidMapping),
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=16m,mode=1777',
    '--mount', `type=bind,source=${o.rw},destination=${BOT_PATHS.workspace}${bindMountOptions(o.uidMapping)}`,
    '--mount', `type=bind,source=${o.ro},destination=${BOT_PATHS.inputs},readonly${bindMountOptions(o.uidMapping)}`,
    o.image,
    'python3', '-c', BIND_SCRIPT,
  ]
}

/** Parse the AC_BIND line. */
export function parseBindOutput(stdout: string): Record<string, string | number> | null {
  const line = stdout.split('\n').find((l) => l.startsWith('AC_BIND '))
  if (!line) return null
  try {
    const v = JSON.parse(line.slice('AC_BIND '.length)) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, string | number>) : null
  } catch {
    return null
  }
}

/**
 * Judge one bind-mount attempt: the container's report plus what the host sees afterwards.
 * `host` is null where ownership can't be checked (no uid on this OS).
 */
export function judgeBind(
  out: Record<string, string | number> | null,
  host: { owner: { uid: number; gid: number } | null; kept: { uid: number; gid: number } | null; dir: { uid: number; gid: number } | null; modified: boolean; leftovers: string[] },
): { ok: boolean; message: string } {
  if (!out) return { ok: false, message: 'the test container didn\'t start' }
  const bad = BIND_STEPS.filter((s) => out[s] !== 'ok').map((s) => `${s}: ${String(out[s] ?? 'not run')}`)
  if (out.uid !== BOT_UID) bad.push(`runs as uid ${String(out.uid)}, expected ${BOT_UID}`)
  if (out.readRo !== BIND_RO_TEXT) bad.push(`reading the read-only mount: ${String(out.readRo ?? 'not run')}`)
  if (out.writeRo !== 'EROFS') bad.push(`writing to the read-only mount gave ${String(out.writeRo ?? 'nothing')}, expected EROFS`)
  if (!bad.length) {
    if (!host.modified) bad.push('the change to the server\'s file didn\'t reach the host')
    if (host.leftovers.length) bad.push(`renamed or deleted files are still on the host: ${host.leftovers.join(', ')}`)
    if (host.owner) {
      for (const [what, st] of [['the new file', host.kept], ['the new folder', host.dir]] as const) {
        if (!st) bad.push(`${what} is missing on the host`)
        else if (st.uid !== host.owner.uid || st.gid !== host.owner.gid) bad.push(`${what} is owned by ${st.uid}:${st.gid} on the host, expected the server user ${host.owner.uid}:${host.owner.gid}`)
      }
    }
  }
  return bad.length
    ? { ok: false, message: bad.join('; ') }
    : { ok: true, message: `uid 1000 can modify, create, rename and delete in a writable mount${host.owner ? ', the files stay owned by the server user' : ''}, and a read-only mount gives EROFS` }
}

/** What the probe container reported. */
export interface ProbeFacts {
  uid?: number
  memoryMax: string | null
  pidsMax: string | null
  netifs: string[]
  python?: string | null
  node?: string | null
  /** Exit of the over-limit allocation: non-zero (e.g. -9) when OOM-killed. */
  allocExit: number | string
  /** Forks that succeeded out of PROBE_LIMITS.forks. */
  forked: number
}

/** One runtime's probe outcome. */
export interface RuntimeProbeRun {
  runtime: ContainerRuntime
  /** Runtime flags it needed to start (runsc only). */
  flags: string[]
  /** BE-P2-5: the uid mapping whose bind_mount check passed (null: none did, or Docker). */
  uidMapping?: UidMapping | null
  started: boolean
  /** The engine refused the memory/pids flags; the container ran without them. */
  limitsRejected?: boolean
  limitsEnforced: boolean
  facts?: ProbeFacts
  checks: ProbeCheck[]
  durationMs: number
}

/** VmProbeResult + the BE-P2-8 / BE-P2-5 additions (additive; see docs/phase2-contract.md). */
export interface RuntimeProbeResult extends VmProbeResult {
  standard: NonNullable<VmProbeResult['standard']> | null
  runscFlags: string[]
}

export interface RuntimeProbeDeps {
  exec?: CommandRunner
  engine: () => Promise<EngineRef | null>
  /** The image the probe container runs (default the shared botvm). */
  image?: () => string
  /** Probe runsc at all (false: report not installed without trying). Default true. */
  tryRunsc?: boolean
  /**
   * BE-P2-5: a host folder the engine can bind-mount, under which the bind_mount check makes its
   * temp folders (removed afterwards); null = skip that check (e.g. Windows WSL storage).
   * Default: the OS temp dir when the engine is local, else null.
   */
  bindDir?: () => string | null
  now?: () => Date
  log?: (msg: string) => void
}

export interface RuntimeProbe {
  /** Last result, or null before the first probe. */
  current(): RuntimeProbeResult | null
  /** Run the probe now (single flight). */
  refresh(): Promise<RuntimeProbeResult>
  /** Probe when nothing is cached, it's older than a day, or engine/runsc/image versions changed. */
  ensureFresh(): Promise<RuntimeProbeResult>
}

const lastLine = (r: CommandResult) => (r.stderr || r.stdout).trim().split('\n').filter(Boolean).pop()?.slice(0, 300) ?? `exit code ${r.code}`
const numeric = (v: string | null | undefined) => (v && /^\d+$/.test(v) ? Number(v) : null)

/** Parse the AC_PROBE line. */
export function parseProbeOutput(stdout: string): ProbeFacts | null {
  const line = stdout.split('\n').find((l) => l.startsWith('AC_PROBE '))
  if (!line) return null
  try {
    const v = JSON.parse(line.slice('AC_PROBE '.length)) as Record<string, unknown>
    return {
      uid: typeof v.uid === 'number' ? v.uid : undefined,
      memoryMax: typeof v.memoryMax === 'string' ? v.memoryMax : null,
      pidsMax: typeof v.pidsMax === 'string' ? v.pidsMax : null,
      netifs: Array.isArray(v.netifs) ? v.netifs.filter((x): x is string => typeof x === 'string') : [],
      python: typeof v.python === 'string' ? v.python : null,
      node: typeof v.node === 'string' ? v.node : null,
      allocExit: typeof v.allocExit === 'number' || typeof v.allocExit === 'string' ? v.allocExit : 'missing',
      forked: typeof v.forked === 'number' ? v.forked : -1,
    }
  } catch {
    return null
  }
}

/** Are the limits really enforced, and the plain-language detail either way. */
export function judgeLimits(f: ProbeFacts): { enforced: boolean; message: string } {
  const memKilled = f.allocExit !== 0 && typeof f.allocExit === 'number'
  const forkLimited = f.forked >= 0 && f.forked < PROBE_LIMITS.forks
  const memMax = numeric(f.memoryMax)
  const pidsMax = numeric(f.pidsMax)
  const read = `memory.max reads ${f.memoryMax === null ? 'nothing (no file)' : `"${f.memoryMax}"`}, pids.max reads ${f.pidsMax === null ? 'nothing (no file)' : `"${f.pidsMax}"`}`
  if (memKilled && forkLimited) {
    return { enforced: true, message: `${read}; a ${PROBE_LIMITS.allocMb} MB allocation was stopped and ${f.forked} of ${PROBE_LIMITS.forks} processes started under a ${PROBE_LIMITS.pids}-process limit` }
  }
  const parts = [read]
  if (!memKilled) parts.push(`a ${PROBE_LIMITS.allocMb} MB allocation under a ${PROBE_LIMITS.memoryMb} MB limit succeeded`)
  if (!forkLimited) parts.push(f.forked < 0 ? 'the process-limit test didn\'t run' : `${f.forked} of ${PROBE_LIMITS.forks} processes started under a ${PROBE_LIMITS.pids}-process limit`)
  if (memMax !== null && memMax > PROBE_LIMITS.memoryMb * 1024 * 1024) parts.push('memory.max is above the requested limit')
  if (pidsMax !== null && pidsMax > PROBE_LIMITS.pids) parts.push('pids.max is above the requested limit')
  return { enforced: false, message: `${LIMITS_NOT_ENFORCED} (${parts.join('; ')})` }
}

/** The probe container's argv (after the engine's global args and runtime flags). */
export function probeRunArgv(o: { name: string; image: string; runtime: ContainerRuntime | null; limits: boolean }): string[] {
  return [
    'run', '--rm',
    '--name', o.name,
    '--label', `${PROBE_LABEL}=1`,
    '--network', 'none',
    '--user', `${BOT_UID}:${BOT_GID}`,
    '--read-only',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    ...(o.limits ? ['--memory', `${PROBE_LIMITS.memoryMb}m`, '--memory-swap', `${PROBE_LIMITS.memoryMb}m`, '--pids-limit', String(PROBE_LIMITS.pids)] : []),
    ...(o.runtime ? ['--runtime', o.runtime] : []),
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=16m,mode=1777',
    o.image,
    'python3', '-c', PROBE_SCRIPT,
  ]
}

const skipped = (id: ProbeCheck['id'], message: string): ProbeCheck => ({ id, status: 'skipped', message })
const LATER_CHECKS: ProbeCheck[] = [
  skipped('snapshot_mount', 'Checked with the snapshot driver (BE-P2-9).'),
  skipped('chromium', 'Checked when a bot turns the browser on (BE-P2-15).'),
]

export function createRuntimeProbe(deps: RuntimeProbeDeps): RuntimeProbe {
  const run = deps.exec ?? execCommandRunner
  const image = deps.image ?? (() => sharedImageRef('botvm'))
  const now = deps.now ?? (() => new Date())
  const log = deps.log ?? (() => {})
  let last: RuntimeProbeResult | null = null
  let lastKey: string | null = null
  let inflight: Promise<RuntimeProbeResult> | null = null

  const cmd = (e: EngineRef) => e.command ?? e.cli
  async function call(e: EngineRef, args: string[], timeoutMs = 30_000): Promise<CommandResult> {
    return run(cmd(e), [...e.globalArgs, ...args], { timeoutMs })
  }

  async function probeOne(e: EngineRef, runtime: ContainerRuntime | null, flags: readonly string[]): Promise<{ r: CommandResult; limits: boolean }> {
    const attempt = async (limits: boolean) => {
      const name = `ac-probe-${runtime ?? 'default'}-${randomBytes(4).toString('hex')}`
      const globals = e.cli === 'docker' ? [] : [...flags]
      const r = await call(e, [...globals, ...probeRunArgv({ name, image: image(), runtime, limits })], PROBE_TIMEOUT_MS)
      // --rm normally removes it; after a timeout or a failed start make sure it's gone.
      if (r.code !== 0) await call(e, ['rm', '--force', name]).catch(() => undefined)
      return r
    }
    const r = await attempt(true)
    // Some engines refuse the limit flags outright (rootless cgroup v1): retry without, mark rejected.
    if (r.code !== 0 && !parseProbeOutput(r.stdout) && /cgroup|memory limit|pids limit|resource limits/i.test(r.stderr) && !/subtree_control|ignore-cgroups/i.test(r.stderr)) {
      const r2 = await attempt(false)
      return { r: r2, limits: false }
    }
    return { r, limits: true }
  }

  /** One bind attempt with one mapping; the host folders are always removed. */
  async function bindOnce(e: EngineRef, base: string, runtime: ContainerRuntime | null, flags: readonly string[], m: UidMapping | null): Promise<{ ok: boolean; message: string }> {
    mkdirSync(base, { recursive: true })
    const dir = mkdtempSync(path.join(base, '.ac-bind-probe-'))
    try {
      const rw = path.join(dir, 'rw')
      const ro = path.join(dir, 'ro')
      mkdirSync(rw)
      mkdirSync(ro)
      writeFileSync(path.join(rw, 'host.txt'), 'server\n')
      writeFileSync(path.join(ro, 'in.txt'), `${BIND_RO_TEXT}\n`)
      const name = `ac-probe-bind-${randomBytes(4).toString('hex')}`
      const globals = e.cli === 'docker' ? [] : [...flags]
      const r = await call(e, [...globals, ...bindProbeArgv({ name, image: image(), runtime, uidMapping: m, rw, ro })], PROBE_TIMEOUT_MS)
      if (r.code !== 0) await call(e, ['rm', '--force', name]).catch(() => undefined)
      const out = parseBindOutput(r.stdout)
      const st = (p: string) => {
        try {
          const s = statSync(p)
          return { uid: s.uid, gid: s.gid }
        } catch {
          return null
        }
      }
      const uid = process.getuid?.()
      const gid = process.getgid?.()
      let modified = false
      try {
        modified = readFileSync(path.join(rw, 'host.txt'), 'utf8').includes('bot')
      } catch {
        modified = false
      }
      const j = judgeBind(out, {
        owner: uid !== undefined && gid !== undefined ? { uid, gid } : null,
        kept: st(path.join(rw, 'd', 'kept.txt')),
        dir: st(path.join(rw, 'd')),
        modified,
        leftovers: ['a.txt', 'd/b.txt'].filter((f) => existsSync(path.join(rw, f))).concat(existsSync(path.join(ro, 'x.txt')) ? ['ro/x.txt'] : []),
      })
      return out ? j : { ok: false, message: `the test container didn't start: ${lastLine(r)}` }
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch (err) {
        log(`runtime-probe: couldn't remove ${dir}: ${(err as Error).message}`)
      }
    }
  }

  /** The bind_mount check for one runtime: candidates in order, first pass wins. */
  async function bindCheck(e: EngineRef, runtime: ContainerRuntime | null, flags: readonly string[]): Promise<{ check: ProbeCheck; uidMapping: UidMapping | null }> {
    const base = deps.bindDir ? deps.bindDir() : e.globalArgs.includes('--connection') ? null : tmpdir()
    if (!base) return { check: skipped('bind_mount', 'Not checked: the bots\' files aren\'t on a folder the engine can mount from here yet.'), uidMapping: null }
    const t0 = Date.now()
    const candidates: (UidMapping | null)[] = e.cli === 'docker' ? [null] : [...UID_MAPPINGS]
    const failed: string[] = []
    for (const m of candidates) {
      let res: { ok: boolean; message: string }
      try {
        res = await bindOnce(e, base, runtime, flags, m)
      } catch (err) {
        res = { ok: false, message: (err as Error).message }
      }
      const label = m ?? 'default mapping'
      if (res.ok) {
        const note = failed.length ? ` (${failed.join('; ')})` : ''
        return { check: { id: 'bind_mount', status: 'pass', message: `${label}: ${res.message}${note}`, durationMs: Date.now() - t0 }, uidMapping: m }
      }
      failed.push(`${label} failed: ${res.message}`)
    }
    return { check: { id: 'bind_mount', status: 'fail', message: `The bot can't use its folders: ${failed.join('; ')}`, durationMs: Date.now() - t0 }, uidMapping: null }
  }

  /** Insert the bind_mount check after exec (only for a runtime that started). */
  async function withBind(e: EngineRef, runtime: ContainerRuntime | null, flags: readonly string[], c: { checks: ProbeCheck[]; started: boolean }): Promise<{ checks: ProbeCheck[]; uidMapping: UidMapping | null }> {
    if (!c.started) return { checks: c.checks, uidMapping: null }
    const b = await bindCheck(e, runtime, flags)
    log(`runtime-probe: ${runtime ?? 'default runtime'}: bind mounts ${b.check.status}${b.uidMapping ? ` with ${b.uidMapping}` : ''}${b.check.status === 'pass' ? '' : `: ${b.check.message ?? ''}`}`)
    const i = c.checks.findIndex((x) => x.id === 'exec')
    const checks = [...c.checks]
    checks.splice(i < 0 ? checks.length : i + 1, 0, b.check)
    return { checks, uidMapping: b.uidMapping }
  }

  function checksFor(r: CommandResult, facts: ProbeFacts | null, limitsAccepted: boolean, t0: number): { checks: ProbeCheck[]; started: boolean; limitsEnforced: boolean } {
    const durationMs = Date.now() - t0
    if (!facts) {
      return { started: false, limitsEnforced: false, checks: [{ id: 'start', status: 'fail', message: `The test container didn't start: ${lastLine(r)}`, durationMs }] }
    }
    const checks: ProbeCheck[] = [{ id: 'start', status: 'pass', durationMs }]
    const otherIfs = facts.netifs.filter((n) => n !== 'lo')
    checks.push(otherIfs.length ? { id: 'network', status: 'fail', message: `The container has network interfaces besides loopback: ${otherIfs.join(', ')}.` } : { id: 'network', status: 'pass' })
    const judged = judgeLimits(facts)
    const limitsEnforced = limitsAccepted && judged.enforced
    checks.push({
      id: 'cgroup_limits',
      status: limitsEnforced ? 'pass' : 'fail',
      message: limitsAccepted ? judged.message : `${LIMITS_NOT_ENFORCED} (the engine refused the memory and process limits)`,
    })
    const execOk = Boolean(facts.python) && Boolean(facts.node) && facts.uid === BOT_UID
    checks.push(execOk ? { id: 'exec', status: 'pass', message: `python ${facts.python}, node ${facts.node}` } : { id: 'exec', status: 'fail', message: facts.uid !== BOT_UID ? `Runs as uid ${facts.uid}, expected ${BOT_UID}.` : `python3 or node is missing (python ${facts.python ?? 'missing'}, node ${facts.node ?? 'missing'}).` })
    return { checks: [...checks, ...LATER_CHECKS], started: true, limitsEnforced }
  }

  async function engineFacts(e: EngineRef): Promise<{ engineVersion: string | null; std: ContainerRuntime | null; stdVersion: string | null; imageId: string | null }> {
    const docker = e.cli === 'docker'
    const ver = await call(e, ['version', '--format', docker ? '{{.Server.Version}}' : '{{.Client.Version}}'])
    const info = await call(e, ['info', '--format', docker ? '{{.DefaultRuntime}}' : '{{.Host.OCIRuntime.Name}}|{{.Host.OCIRuntime.Version}}'])
    const img = await call(e, ['image', 'inspect', '--format', '{{.Id}}', image()])
    const [name, version] = info.code === 0 ? info.stdout.trim().split('|') : []
    const std = name === 'crun' || name === 'runc' ? name : null
    return {
      engineVersion: ver.code === 0 ? ver.stdout.trim() || null : null,
      std,
      stdVersion: version?.split('\n')[0]?.trim() || null,
      imageId: img.code === 0 ? img.stdout.trim().replace(/^sha256:/, '').slice(0, 12) || null : null,
    }
  }

  async function runscVersion(e: EngineRef): Promise<string | null> {
    // Linux: runsc sits on the host. Mac/Windows: inside the machine (BE-P2-7 asks via `machine ssh`).
    if (e.globalArgs.includes('--connection')) return null
    const r = await run('runsc', ['--version'], { timeoutMs: 10_000 })
    if (r.code !== 0) return null
    return r.stdout.split('\n')[0]?.replace(/^runsc version\s*/, '').trim() || null
  }

  async function probe(): Promise<RuntimeProbeResult> {
    const e = await deps.engine()
    const checkedAt = now().toISOString()
    if (!e) {
      return { runsc: { installed: false }, checks: null, compatible: false, uidMapping: null, snapshotDriver: null, checkedAt, versions: { engine: null, runsc: null, image: null }, standard: null, runscFlags: [] }
    }
    const facts = await engineFacts(e)
    const versions = { engine: facts.engineVersion, runsc: await runscVersion(e), image: facts.imageId }

    // Standard runtime: the engine's default.
    let t0 = Date.now()
    const std = await probeOne(e, null, [])
    const stdChecks = checksFor(std.r, parseProbeOutput(std.r.stdout), std.limits, t0)
    const stdBind = await withBind(e, null, [], stdChecks)
    const standard = { runtime: facts.std, version: facts.stdVersion, limitsEnforced: stdChecks.limitsEnforced, limitsAccepted: std.limits, checks: stdBind.checks, uidMapping: stdBind.uidMapping }
    log(`runtime-probe: ${facts.std ?? 'default runtime'}: limits ${stdChecks.limitsEnforced ? 'enforced' : 'NOT enforced'}`)

    // gVisor.
    let runscInstalled = versions.runsc !== null
    let runscChecks: ProbeCheck[] | null = null
    let runscFlags: string[] = []
    let runscMapping: UidMapping | null = null
    if (deps.tryRunsc !== false && (runscInstalled || e.globalArgs.includes('--connection'))) {
      for (const flags of RUNSC_FLAG_VARIANTS) {
        t0 = Date.now()
        const res = await probeOne(e, 'runsc', flags)
        if (/runtime.*runsc.*(not found|no such|unknown)|executable file not found|unknown runtime/i.test(res.r.stderr)) {
          runscInstalled = false
          break
        }
        runscInstalled = true
        const c = checksFor(res.r, parseProbeOutput(res.r.stdout), res.limits, t0)
        runscChecks = c.checks
        runscFlags = [...flags]
        if (c.started) {
          const b = await withBind(e, 'runsc', flags, c)
          runscChecks = b.checks
          runscMapping = b.uidMapping
          break
        }
      }
    }
    if (!runscInstalled) {
      runscChecks = null
      runscFlags = []
      runscMapping = null
    }
    const compatible = Boolean(runscChecks?.every((c) => c.status !== 'fail'))
    log(`runtime-probe: runsc ${!runscInstalled ? 'not installed' : compatible ? 'compatible' : `incompatible: ${runscChecks?.find((c) => c.status === 'fail')?.message ?? ''}`}`)
    return {
      runsc: { installed: runscInstalled, ...(versions.runsc ? { version: versions.runsc } : {}) },
      checks: runscChecks,
      compatible,
      uidMapping: runscMapping,
      snapshotDriver: null,
      checkedAt,
      versions,
      standard,
      runscFlags,
    }
  }

  async function keyNow(): Promise<string> {
    const e = await deps.engine()
    if (!e) return 'no-engine'
    const f = await engineFacts(e)
    return JSON.stringify([e.cli, e.globalArgs, f.engineVersion, f.std, await runscVersion(e), f.imageId])
  }

  async function refresh(): Promise<RuntimeProbeResult> {
    if (inflight) return inflight
    inflight = (async () => {
      try {
        const key = await keyNow()
        last = await probe()
        lastKey = key
        return last
      } finally {
        inflight = null
      }
    })()
    return inflight
  }

  return {
    current: () => last,
    refresh,
    async ensureFresh() {
      if (inflight) return inflight
      if (!last || !last.checkedAt || now().getTime() - Date.parse(last.checkedAt) > PROBE_MAX_AGE_MS) return refresh()
      if ((await keyNow()) !== lastKey) return refresh()
      return last
    },
  }
}

/** VmInfo.runtime plus the BE-P2-8 additions (additive). */
export type ResolvedRuntime = VmInfo['runtime'] & {
  /** Runtime flags to pass with the engine's global args (runsc variants). */
  flags?: string[]
}

export function effectiveMode(globalMode: GlobalRuntimeMode, botMode: RuntimeMode): GlobalRuntimeMode {
  return botMode === 'inherit' ? globalMode : botMode
}

/** Plan §4 resolution table, for one bot. `botName` goes into the force_on message. */
export function resolveRuntime(globalMode: GlobalRuntimeMode, botMode: RuntimeMode, probe: RuntimeProbeResult | null, botName: string): ResolvedRuntime {
  const mode = effectiveMode(globalMode, botMode)
  const base = { mode: botMode, globalMode, ...(probe?.checkedAt ? { checkedAt: probe.checkedAt } : {}) }
  const std = probe?.standard ?? null
  const stdRuntime: ContainerRuntime | null = std ? (std.runtime ?? 'crun') : null
  const stdLimits = std
    ? { limitsEnforced: std.limitsEnforced, ...(std.limitsEnforced ? {} : { limitsReason: std.checks.find((c) => c.id === 'cgroup_limits')?.message ?? LIMITS_NOT_ENFORCED }) }
    : {}
  const failing = probe?.checks?.find((c) => c.status === 'fail')
  const runscReason = !probe?.runsc.installed ? 'it isn\'t installed' : failing ? shortReason(failing) : undefined
  let status: RuntimeStatus
  let effective: ContainerRuntime | null
  let reason: string | undefined
  if (mode === 'force_off') {
    status = 'forced_off'
    effective = stdRuntime
  } else if (!probe) {
    status = mode === 'force_on' ? 'required_unavailable' : 'not_installed'
    effective = null
    reason = 'The runtime check hasn\'t run yet.'
  } else if (probe.runsc.installed && probe.compatible) {
    return { ...base, effective: 'runsc', status: 'active', limitsEnforced: true, ...(probe.runscFlags.length ? { flags: probe.runscFlags } : {}) }
  } else if (mode === 'force_on') {
    status = 'required_unavailable'
    effective = null
    reason = `gVisor is required for ${botName} but isn't available (${runscReason}). Turn off Force on or fix gVisor.`
  } else {
    status = probe.runsc.installed ? 'incompatible_fallback' : 'not_installed'
    effective = stdRuntime
    reason = probe.runsc.installed ? runscReason : undefined
  }
  return { ...base, effective, status, ...(reason ? { reason } : {}), ...(effective ? stdLimits : {}) }
}

function shortReason(c: ProbeCheck): string {
  const m = c.message ?? `${c.id} check failed`
  return m.startsWith(LIMITS_NOT_ENFORCED) ? LIMITS_NOT_ENFORCED : m
}

/** GET/POST /api/vm/probe. */
export function registerProbeRoutes(app: FastifyInstance, probe: RuntimeProbe): void {
  app.get('/api/vm/probe', async (): Promise<RuntimeProbeResult> =>
    probe.current() ?? { runsc: { installed: false }, checks: null, compatible: false, uidMapping: null, snapshotDriver: null, checkedAt: null, versions: { engine: null, runsc: null, image: null }, standard: null, runscFlags: [] },
  )
  // Mutating: needs the confirm header (PERMISSION_CSRF_HEADER), 403 reason 'confirm_required' without it.
  app.post('/api/vm/probe', async (request) => {
    if (request.headers[PERMISSION_CSRF_HEADER] !== '1') failWithReason(403, 'confirm_required', `Re-checking the VM runtime needs the ${PERMISSION_CSRF_HEADER}: 1 header.`)
    return probe.refresh()
  })
}
