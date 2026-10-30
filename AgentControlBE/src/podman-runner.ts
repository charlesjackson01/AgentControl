/**
 * BE-P2-8: the VM runner (Podman and Docker; the EngineRef decides). Runs a script with
 * `exec` in the bot's container (started lazily), streams its output with a 200 MB cap and
 * 64 KB tails, enforces the timeout, and stops idle containers after 10 minutes.
 *
 * Limits (4 GB, no swap, 256 pids) are set on the container by BotEnvService; this runner reads
 * memory.events / pids.events before and after to tell OOM and the process limit apart.
 * When the runtime can't enforce limits (or the probe hasn't confirmed it yet), runs are
 * blocked with reason 'limits_unenforced' (Team lead, 2026-10-27). AC_ALLOW_UNLIMITED_RUNS=1
 * is a test-only override: off by default, never set by any config or script, never exposed.
 * BE-P2-5: likewise, when no uid mapping passed the probe's bind_mount check (the bot couldn't use
 * its folders safely), runs are blocked with reason 'mounts_unusable' (Team lead, 2026-10-28); the
 * same test-only override lifts it. The limits block is checked first.
 * BE-P2-7: when gVisor is required (force_on) but unavailable (probe failed, runsc missing, or no
 * probe result yet), runs fail with reason 'gvisor_unavailable' and the force_on message, before
 * anything else and before any container is created or started; never a quiet fallback to crun.
 * The override doesn't lift it. The check runs again when a queued run's turn comes.
 * BE-P2-10: after those, a bot over its 10 GB personal limit (folder + tools volumes + layer) is
 * blocked with reason 'personal_quota' and the exact §5 message (the override doesn't lift it).
 * After a run's snapshot is finished, eviction runs (too_large, then the budgets) and the run's
 * undo state comes back in `undo`.
 */
import path from 'node:path'
import type { Agent, ScriptRunUndo } from './shared/types.js'
import { VM_LIMITS } from './shared/types.js'
import { execCommandRunner, type CommandRunner } from './command-runner.js'
import { checkCwd, envWith, execArgv, redactAll, type BotEnvService, type EngineRef } from './bot-env.js'
import { capHostContacts, CREDENTIAL_GRACE_MS, EgressUnavailableError, PROXY_UNAVAILABLE, PROXY_UNAVAILABLE_REASON, type EgressGrant, type EgressService } from './egress-service.js'
import { botContainerName } from './vm-images.js'
import type { ResolvedRuntime } from './runtime-probe.js'
import type { Runner, RunScriptRequest, RunScriptResult } from './runner.js'
import { spawnStreamRunner, type StreamExit, type StreamHandle, type StreamRunner } from './stream-runner.js'
import { newRunId, RUN_ID_RE, type SnapshotHandle, type SnapshotService } from './snapshot.js'
import { PERSONAL_QUOTA_REASON } from './personal-usage.js'

/** BE-P2-9: the run was refused because its undo snapshot couldn't be taken. */
export const SNAPSHOT_FAILED_REASON = 'snapshot_failed'

export const OUTPUT_CAP_BYTES = VM_LIMITS.outputMb * 1024 * 1024
export const TAIL_BYTES = 64 * 1024
export const IDLE_STOP_MS = 10 * 60 * 1000
export const IDLE_SWEEP_MS = 60 * 1000
export const NETWORK_UNAVAILABLE = 'Internet access isn\'t available yet.'
export const LIMITS_UNENFORCED_REASON = 'limits_unenforced'
export const LIMITS_UNENFORCED_MESSAGE = "This computer can't limit bot scripts safely, so scripts can't run here."
export const MOUNTS_UNUSABLE_REASON = 'mounts_unusable'
export { PERSONAL_QUOTA_REASON }
export const GVISOR_UNAVAILABLE_REASON = 'gvisor_unavailable'
export const MOUNTS_UNUSABLE_MESSAGE = "This computer can't give bot scripts safe access to their files, so scripts can't run here."
/** Test-only override for the limits and mounts blocks. Never set by default, never exposed in the API/UI. */
export const ALLOW_UNLIMITED_RUNS_ENV = 'AC_ALLOW_UNLIMITED_RUNS'
/** What podman/crun/sh print when no new process can be started in the container. */
const PIDS_FULL_RE = /resource temporarily unavailable|cannot fork|can't fork|EAGAIN/i
export const EVENTS_RETRY_DELAYS_MS = [500, 1000, 2000]

/** Reads the cgroup event counters inside the container (fixed script, no user input). */
export const CGROUP_EVENTS_ARGV = ['sh', '-c', 'for f in memory.events pids.events; do echo "== $f"; cat /sys/fs/cgroup/$f 2>/dev/null; done']

export interface CgroupEvents {
  oomKill: number | null
  pidsMax: number | null
}
export function parseCgroupEvents(out: string): CgroupEvents {
  const res: CgroupEvents = { oomKill: null, pidsMax: null }
  let file = ''
  for (const line of out.split('\n')) {
    const m = /^== (\S+)/.exec(line)
    if (m) {
      file = m[1] ?? ''
      continue
    }
    const [k, v] = line.trim().split(/\s+/)
    if (v === undefined || !/^\d+$/.test(v)) continue
    if (file === 'memory.events' && k === 'oom_kill') res.oomKill = Number(v)
    if (file === 'pids.events' && k === 'max') res.pidsMax = Number(v)
  }
  return res
}

/** Keeps the last `max` bytes of a stream. */
class Tail {
  private parts: Buffer[] = []
  private size = 0
  constructor(private readonly max: number) {}
  push(b: Buffer) {
    this.parts.push(b)
    this.size += b.length
    while (this.size - (this.parts[0]?.length ?? 0) >= this.max && this.parts.length > 1) this.size -= this.parts.shift()!.length
  }
  toString(): string {
    const all = Buffer.concat(this.parts)
    const cut = all.length > this.max ? all.subarray(all.length - this.max) : all
    // A cut can land inside a UTF-8 character; drop the broken lead.
    return cut.toString('utf8').replace(/^\uFFFD+/, '')
  }
}

export interface ContainerRunnerDeps {
  botEnv: BotEnvService
  engine: () => Promise<EngineRef | null>
  getAgent: (agentId: string) => Agent | undefined
  /** Effective runtime for the bot (resolveRuntime). */
  runtime: (agent: Agent) => ResolvedRuntime
  stream?: StreamRunner
  exec?: CommandRunner
  outputCapBytes?: number
  idleStopMs?: number
  now?: () => Date
  log?: (msg: string) => void
  /**
   * BE-P2-5: whether a uid mapping passed the probe's bind_mount check for the bot's runtime
   * (false also before the probe has a result). Default: true.
   */
  mountsUsable?: (agent: Agent) => boolean
  /** Environment to read the test-only AC_ALLOW_UNLIMITED_RUNS override from (default process.env, read per run). */
  env?: NodeJS.ProcessEnv
  /** For tests: the wait between event-counter retries. */
  sleep?: (ms: number) => Promise<void>
  /** BE-P2-9: undo snapshots around every run (absent: no snapshots, filesChanged stays []). */
  snapshots?: SnapshotService
  /**
   * BE-P2-10: the bot's personal data against its 10 GB limit, checked before each run; a
   * `blocked` message refuses the run (reason 'personal_quota'). Absent: not checked.
   */
  personal?: (agent: Agent) => Promise<{ blocked: string | null }>
  /** BE-P2-10: eviction right after the run's snapshot (too_large, then the budgets); returns the run's undo state. */
  afterSnapshot?: (slug: string, runId: string) => ScriptRunUndo | null
  /**
   * BE-P2-13: the egress proxy. A run with `network: 'on'` and `internetGranted` gets a credential
   * for this run only, its container moves to the bot's internal ac-egress-<slug> network (never
   * host/default), and the host log comes back in `hostsContacted`. Absent: network 'on' is refused.
   */
  egress?: Pick<EgressService, 'grant' | 'revoke'>
}

export interface ContainerRunner extends Runner {
  /**
   * BE-P2-12: the checks `run` makes before queueing (bot, network, argv, cwd, then the gVisor,
   * limits and mounts blocks), without running anything. Null: `run` would queue it.
   */
  check(req: RunScriptRequest): RunScriptResult | null
  /** Runs queued or running for the bot (BotEnvService.activeRuns). */
  activeRuns(agentId: string): number
  /**
   * BE-P2-11: run `fn` in the bot's run slot (after the runs queued before it, and before any
   * queued after it), counted by `activeRuns` while it waits and runs. Used by undo.
   */
  exclusive<T>(agentId: string, fn: () => Promise<T>): Promise<T>
  /**
   * BE-P2-12: `fn(agentId)` whenever the bot's `activeRuns` count changes (a run or exclusive
   * job joins or leaves its slot). RunService uses it to start a bot's queued run only once the
   * bot's slot is free. Returns a function that removes the listener.
   */
  onSlotChange(fn: (agentId: string) => void): () => void
  /** Stop the bot's running and queued runs (VM stop / reset). */
  stopRuns(agentId: string): void
  /** When the bot's container stops if nothing else runs (VmInfo.idleStopAt). */
  idleStopAt(agentId: string): string | undefined
  /** Stop containers idle for 10 minutes. */
  idleSweep(): Promise<void>
  /** Start the 60 s idle sweep; returns a function that stops it. */
  startIdleTimer(): () => void
}

interface Active {
  stop: (reason: 'stopped') => void
}

export function createContainerRunner(deps: ContainerRunnerDeps): ContainerRunner {
  const stream = deps.stream ?? spawnStreamRunner
  const exec = deps.exec ?? execCommandRunner
  const cap = deps.outputCapBytes ?? OUTPUT_CAP_BYTES
  const idleMs = deps.idleStopMs ?? IDLE_STOP_MS
  const now = deps.now ?? (() => new Date())
  const log = deps.log ?? (() => {})
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const queues = new Map<string, Promise<unknown>>()
  const counts = new Map<string, number>()
  const active = new Map<string, Active>()
  /** Bumped by stopRuns: queued runs from an older epoch don't start. */
  const epochs = new Map<string, number>()
  const lastActivity = new Map<string, number>()
  const slotListeners = new Set<(agentId: string) => void>()
  function setCount(agentId: string, n: number): void {
    if (n > 0) counts.set(agentId, n)
    else counts.delete(agentId)
    for (const fn of [...slotListeners]) {
      try {
        fn(agentId)
      } catch (x) {
        log(`runner: slot listener failed: ${(x as Error).message}`)
      }
    }
  }

  const err = (t0: number, message: string, extra: Partial<RunScriptResult> = {}): RunScriptResult => ({
    status: 'error', outcome: 'failed', error: message, durationMs: Date.now() - t0, stdout: '', stderr: message, filesChanged: [], ...extra,
  })

  /** `pidsFull`: the read itself couldn't start a process (the container is at its process limit). */
  async function readEvents(agent: Agent): Promise<CgroupEvents & { pidsFull: boolean }> {
    try {
      const r = await deps.botEnv.exec(agent, CGROUP_EVENTS_ARGV, { timeoutMs: 15_000 })
      if (r.code !== 0) log(`runner: reading cgroup events for ${agent.slug} failed (${r.code}): ${r.stderr.trim().split('\n').pop() ?? ''}`)
      return { ...parseCgroupEvents(r.stdout), pidsFull: r.code !== 0 && PIDS_FULL_RE.test(`${r.stderr}\n${r.stdout}`) }
    } catch (x) {
      return { oomKill: null, pidsMax: null, pidsFull: PIDS_FULL_RE.test(String((x as Error)?.message ?? x)) }
    }
  }

  /**
   * After a run: leftover processes (e.g. a fork bomb's children) can keep the container at its
   * process limit, so the read can't even start. Retry a few times (only then), and treat a read that keeps
   * failing for lack of processes as hitting the limit.
   */
  async function readEventsAfter(agent: Agent): Promise<CgroupEvents & { pidsFull: boolean }> {
    let r = await readEvents(agent)
    let full = r.pidsFull
    for (let i = 0; i < EVENTS_RETRY_DELAYS_MS.length && r.pidsMax === null && r.pidsFull; i++) {
      await sleep(EVENTS_RETRY_DELAYS_MS[i]!)
      r = await readEvents(agent)
      full ||= r.pidsFull
    }
    return { ...r, pidsFull: full }
  }

  /** The run blocks, in order: gVisor required but unavailable, limits, mounts. Null: the run may start. */
  function blocked(agent: Agent, rt: ResolvedRuntime, t0: number): RunScriptResult | null {
    if (rt.status === 'required_unavailable') {
      return err(t0, rt.reason ?? 'gVisor is required but isn\'t available.', { reason: GVISOR_UNAVAILABLE_REASON, runtime: null })
    }
    const overridden = (deps.env ?? process.env)[ALLOW_UNLIMITED_RUNS_ENV] === '1'
    if (rt.limitsEnforced !== true && !overridden) {
      return err(t0, LIMITS_UNENFORCED_MESSAGE, { reason: LIMITS_UNENFORCED_REASON, runtime: rt.effective })
    }
    if (deps.mountsUsable && !deps.mountsUsable(agent) && !overridden) {
      return err(t0, MOUNTS_UNUSABLE_MESSAGE, { reason: MOUNTS_UNUSABLE_REASON, runtime: rt.effective })
    }
    return null
  }

  async function runOne(agent: Agent, req: RunScriptRequest, cwd: string, timeoutSec: number, t0: number): Promise<RunScriptResult> {
    // Resolved again at the run's turn: the probe or the mode may have changed while it was queued.
    const rt = deps.runtime(agent)
    const no = blocked(agent, rt, t0)
    if (no) return no
    if (deps.personal) {
      // BE-P2-10: over the 10 GB personal limit, new runs are blocked (plan §5).
      const q = await deps.personal(agent).catch((x: Error) => {
        log(`runner: ${agent.slug}: couldn't measure the bot's files and tools: ${x.message}`)
        return { blocked: null }
      })
      if (q.blocked) return err(t0, q.blocked, { reason: PERSONAL_QUOTA_REASON, runtime: rt.effective })
    }
    const e = await deps.engine()
    if (!e) return err(t0, 'Podman isn\'t installed yet. Finish the setup steps in Settings › VMs first.', { runtime: null })
    // BE-P2-9: the undo snapshot. With the overlay driver the container is stopped first, so
    // writes made outside a run are committed (into this run's snapshot) before it starts.
    const snaps = deps.snapshots
    let snap: SnapshotHandle | null = null
    if (snaps?.driver()) {
      try {
        if (snaps.needsStop(agent)) await deps.botEnv.stop(agent)
        snap = await snaps.begin(agent, req.runId && RUN_ID_RE.test(req.runId) ? req.runId : newRunId())
      } catch (x) {
        log(`runner: ${agent.slug}: taking the undo snapshot failed: ${(x as Error).message}`)
        return err(t0, `The run's undo snapshot couldn't be taken, so the run didn't start: ${(x as Error).message}`, { runtime: rt.effective, reason: SNAPSHOT_FAILED_REASON, snapshot: null })
      }
    }
    let result: RunScriptResult | undefined
    let thrown: unknown
    try {
      result = await execOne(agent, req, cwd, timeoutSec, t0, rt, e)
    } catch (x) {
      thrown = x
    }
    if (snaps && snap) {
      // Every outcome (succeeded, failed, timed out, stopped, crashed) commits and is undoable.
      let snapshot: RunScriptResult['snapshot'] = null
      let filesChanged: RunScriptResult['filesChanged'] = []
      let undo: ScriptRunUndo | null = null
      try {
        if (snaps.needsStop(agent)) await deps.botEnv.stop(agent)
        const o = await snaps.finish(snap)
        snapshot = o.snapshot
        filesChanged = o.filesChanged
      } catch (x) {
        // Left pending: the next run (or a restart) finishes it.
        log(`runner: ${agent.slug}: finishing the undo snapshot of run ${snap.runId} failed (it's retried before the next run): ${(x as Error).message}`)
      }
      if (snapshot && deps.afterSnapshot) {
        // BE-P2-10: still in the bot's run slot, so its copy blobs can be collected too.
        try {
          undo = deps.afterSnapshot(agent.slug, snap.runId)
        } catch (x) {
          log(`runner: ${agent.slug}: snapshot eviction after run ${snap.runId} failed: ${(x as Error).message}`)
        }
      }
      if (result) result = { ...result, filesChanged, snapshot, ...(undo ? { undo } : {}) }
    } else if (result && snaps) result = { ...result, snapshot: null }
    if (thrown !== undefined) throw thrown
    return result!
  }

  async function execOne(agent: Agent, req: RunScriptRequest, cwd: string, timeoutSec: number, t0: number, rt: ResolvedRuntime, e: EngineRef): Promise<RunScriptResult> {
    if (req.network !== 'on') return execInner(agent, req, cwd, timeoutSec, t0, rt, e, null)
    // BE-P2-13: internet through the proxy, with a credential for this run only.
    let grant: EgressGrant
    try {
      if (!deps.egress) throw new EgressUnavailableError('no proxy')
      // Review B3: the credential expires on its own a minute after the run's time limit (counted
      // from now, when the run gets its turn: a queued run's wait doesn't eat into it).
      grant = await deps.egress.grant(agent.slug, 'run', { ttlMs: timeoutSec * 1000 + CREDENTIAL_GRACE_MS })
    } catch (x) {
      log(`runner: ${agent.slug}: no proxy for the run: ${(x as EgressUnavailableError).detail ?? (x as Error).message}`)
      return err(t0, PROXY_UNAVAILABLE, { reason: PROXY_UNAVAILABLE_REASON, runtime: rt.effective })
    }
    let hosts: ReturnType<typeof capHostContacts> | null = null
    try {
      const result = await execInner(agent, req, cwd, timeoutSec, t0, rt, e, grant)
      hosts = capHostContacts(await deps.egress.revoke(grant.id))
      return { ...result, hostsContacted: hosts.hosts, ...(hosts.total !== undefined ? { hostsContactedTotal: hosts.total } : {}) }
    } finally {
      // Revoked on every path (also a throw): the credential never outlives the run.
      if (!hosts) await deps.egress.revoke(grant.id).catch(() => [])
      // Review B3: and the container leaves the egress network now (recreated on none, volumes
      // kept), so nothing it left running can reach the proxy until the next online run.
      await deps.botEnv
        .ensure(agent, { forRun: true, network: 'none' })
        .catch((x: unknown) => log(`runner: ${agent.slug}: moving the VM back to no network after the run failed: ${redactAll((x as Error).message, grant.secrets)}`))
    }
  }

  async function execInner(agent: Agent, req: RunScriptRequest, cwd: string, timeoutSec: number, t0: number, rt: ResolvedRuntime, e: EngineRef, grant: EgressGrant | null): Promise<RunScriptResult> {
    const secrets = grant?.secrets ?? []
    const scrub = (s: string) => (secrets.length ? redactAll(s, secrets) : s)
    try {
      // BE-P2-7: forRun, so a changed runtime (or image/config) recreates the container now (volumes kept).
      // BE-P2-13: an online run moves it to the bot's egress network; the next offline run moves it back to none.
      await deps.botEnv.ensure(agent, { start: true, forRun: true, network: grant ? 'egress' : 'none' })
    } catch (x) {
      return err(t0, `The bot's VM couldn't start: ${scrub((x as Error).message)}`, { runtime: rt.effective })
    }
    lastActivity.set(agent.id, now().getTime())
    const before = await readEvents(agent)
    const flags = e.cli === 'docker' ? [] : (rt.flags ?? [])
    const extraEnv = [...(req.extraEnv ?? []), ...(req.runId ? [{ name: 'AC_RUN_ID', value: req.runId }] : [])]
    // Review S2: the proxy settings (they hold the credential) go by name; values in the engine's env.
    const passEnv = grant?.env ?? []
    const args = [...e.globalArgs, ...flags, ...execArgv({ slug: agent.slug, argv: req.argv, env: agent.vm.env, extraEnv, passEnv: passEnv.map((v) => v.name), cwd })]

    const out = new Tail(TAIL_BYTES)
    const errTail = new Tail(TAIL_BYTES)
    let bytes = 0
    let truncated = false
    let ended: 'timeout' | 'stopped' | 'output' | null = null
    let stopping: Promise<unknown> | null = null

    const terminate = (why: 'timeout' | 'stopped' | 'output') => {
      if (ended) return
      ended = why
      // Killing the exec client leaves the process running inside; stopping the container ends it.
      stopping = exec(e.command ?? e.cli, [...e.globalArgs, ...flags, 'stop', '--time', '2', botContainerName(agent.slug)], { timeoutMs: 30_000 })
        .then((r) => { if (r.code !== 0) log(`runner: ${agent.slug}: stop after ${why} failed: ${(r.stderr || r.stdout).trim().slice(0, 200)}`) })
        .catch(() => undefined)
        .finally(() => handle?.kill())
    }
    const take = (which: 'stdout' | 'stderr', chunk: Buffer) => {
      if (truncated) return
      const room = cap - bytes
      const part = chunk.length > room ? chunk.subarray(0, room) : chunk
      bytes += part.length
      if (part.length) {
        ;(which === 'stdout' ? out : errTail).push(part)
        // BE-P2-13: the credential never reaches the log (a value split across two chunks isn't caught: gap).
        // Review B4: every form of it (secret, URL, Basic header value, …), not just the first.
        req.onOutput?.(which, secrets.some((x) => x && part.includes(x)) ? Buffer.from(scrub(part.toString('utf8'))) : part)
      }
      if (chunk.length > room) {
        truncated = true
        terminate('output')
      }
    }
    let handle: StreamHandle | null = null
    const h = stream(e.command ?? e.cli, args, { onStdout: (c) => take('stdout', c), onStderr: (c) => take('stderr', c), ...(passEnv.length ? { env: envWith(passEnv) } : {}) })
    handle = h
    if (ended) h.kill()
    active.set(agent.id, { stop: () => terminate('stopped') })
    const timer = setTimeout(() => terminate('timeout'), timeoutSec * 1000)
    const onAbort = () => terminate('stopped')
    if (req.signal?.aborted) onAbort()
    req.signal?.addEventListener('abort', onAbort, { once: true })
    let exit: StreamExit
    try {
      exit = await h.done
    } finally {
      clearTimeout(timer)
      req.signal?.removeEventListener('abort', onAbort)
      active.delete(agent.id)
    }
    if (stopping) await stopping
    lastActivity.set(agent.id, now().getTime())

    const after = ended ? { oomKill: null, pidsMax: null, pidsFull: false } : await readEventsAfter(agent)
    const oomKilled = before.oomKill !== null && after.oomKill !== null && after.oomKill > before.oomKill
    const pidsLimited =
      (before.pidsMax !== null && after.pidsMax !== null && after.pidsMax > before.pidsMax) ||
      (after.pidsMax === null && after.pidsFull && exit.code !== 0)
    if (pidsLimited) {
      // Clear leftover processes so the next run doesn't start at the limit; it restarts lazily.
      log(`runner: ${agent.slug} hit the process limit; stopping its container to clear leftover processes`)
      await deps.botEnv.stop(agent).catch((x: unknown) => log(`runner: stop after the process limit failed: ${(x as Error).message}`))
    }
    const base = {
      exitCode: exit.code,
      durationMs: Date.now() - t0,
      stdout: scrub(out.toString()),
      stderr: scrub(errTail.toString()),
      filesChanged: [],
      outputBytes: bytes,
      ...(truncated ? { outputTruncated: true } : {}),
      runtime: rt.effective,
      ...(oomKilled ? { oomKilled } : {}),
      ...(pidsLimited ? { pidsLimited } : {}),
    }
    if (exit.spawnError) return { ...base, exitCode: undefined, status: 'error', outcome: 'failed', error: `Couldn't run the engine: ${exit.spawnError}` }
    if (ended === 'stopped') return { ...base, exitCode: undefined, status: 'error', outcome: 'stopped', error: 'The run was stopped.' }
    if (ended === 'timeout') return { ...base, exitCode: undefined, status: 'error', outcome: 'timed_out', error: `The script ran past its ${timeoutSec} s time limit and was stopped.` }
    if (ended === 'output') return { ...base, exitCode: undefined, status: 'error', outcome: 'failed', error: `The script printed more than ${Math.round(cap / 1024 / 1024)} MB of output, so it was stopped. The output up to the limit was kept.` }
    if (exit.code === 0) return { ...base, status: 'ok', outcome: 'succeeded' }
    let error = `The script exited with code ${exit.code}.`
    if (oomKilled) error = `The script ran out of memory (the ${VM_LIMITS.memoryMb / 1024} GB limit) and was stopped.`
    else if (pidsLimited) error = `The script hit the ${VM_LIMITS.pids}-process limit (exit code ${exit.code}).`
    else if (exit.code === 137) error = 'The script was killed (exit code 137), most likely because it ran out of memory.'
    else if (exit.code === 127) error = `The script exited with code 127 (command not found: ${req.argv[0] ?? ''}).`
    return { ...base, status: 'error', outcome: 'failed', error }
  }

  /** The checks made before a run is queued: a refusal, or the bot and its container cwd. */
  function precheck(req: RunScriptRequest, t0: number): RunScriptResult | { agent: Agent; cwd: string } {
    const agent = deps.getAgent(req.agentId)
    if (!agent) return err(t0, 'Bot not found.')
    if (req.network === 'on' && (req.internetGranted !== true || !deps.egress)) return err(t0, NETWORK_UNAVAILABLE)
    if (!Array.isArray(req.argv) || !req.argv.length || req.argv.some((a) => typeof a !== 'string' || a.includes('\0'))) {
      return err(t0, 'Give the command to run as a list of arguments.')
    }
    let cwd: string
    try {
      if (path.posix.isAbsolute(req.cwd) || req.cwd.includes('\\')) throw new Error('absolute')
      cwd = checkCwd(path.posix.join('/bot', req.cwd || 'workspace'))
    } catch {
      return err(t0, `A run's folder must be workspace or groups/<group> (got ${JSON.stringify(String(req.cwd).slice(0, 80))}).`)
    }
    const no = blocked(agent, deps.runtime(agent), t0)
    if (no) return no
    return { agent, cwd }
  }

  function run(req: RunScriptRequest): Promise<RunScriptResult> {
    const t0 = Date.now()
    const pre = precheck(req, t0)
    if ('status' in pre) return Promise.resolve(pre)
    const { agent, cwd } = pre
    const timeoutSec = Math.min(Math.max(1, Math.floor(Number(req.timeoutSec) || VM_LIMITS.timeoutSec)), VM_LIMITS.timeoutSec)

    // One run at a time per bot; queued runs wait their turn.
    const epoch = epochs.get(agent.id) ?? 0
    setCount(agent.id, (counts.get(agent.id) ?? 0) + 1)
    lastActivity.set(agent.id, now().getTime())
    const prev = queues.get(agent.id) ?? Promise.resolve()
    const next = prev.catch(() => {}).then(async () => {
      if ((epochs.get(agent.id) ?? 0) !== epoch || req.signal?.aborted) {
        return { ...err(t0, 'The run was stopped.'), outcome: 'stopped' as const }
      }
      return runOne(agent, req, cwd, timeoutSec, t0)
    })
    queues.set(agent.id, next)
    return next.finally(() => {
      if (queues.get(agent.id) === next) queues.delete(agent.id)
      setCount(agent.id, (counts.get(agent.id) ?? 1) - 1)
    })
  }

  async function idleSweep(): Promise<void> {
    const t = now().getTime()
    for (const [agentId, last] of [...lastActivity]) {
      if (counts.get(agentId)) continue
      if (t - last < idleMs) continue
      lastActivity.delete(agentId)
      const agent = deps.getAgent(agentId)
      if (!agent) continue
      try {
        await deps.botEnv.stop(agent)
        log(`runner: ${agent.slug}: stopped after ${Math.round(idleMs / 60000)} min idle`)
      } catch (x) {
        log(`runner: ${agent.slug}: idle stop failed: ${(x as Error).message}`)
      }
    }
  }

  function exclusive<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
    setCount(agentId, (counts.get(agentId) ?? 0) + 1)
    lastActivity.set(agentId, now().getTime())
    const prev = queues.get(agentId) ?? Promise.resolve()
    const next = prev.catch(() => {}).then(fn)
    queues.set(agentId, next)
    return next.finally(() => {
      if (queues.get(agentId) === next) queues.delete(agentId)
      lastActivity.set(agentId, now().getTime())
      setCount(agentId, (counts.get(agentId) ?? 1) - 1)
    })
  }

  return {
    async available() {
      return (await deps.engine()) !== null
    },
    run,
    check(req) {
      const pre = precheck(req, Date.now())
      return 'status' in pre ? pre : null
    },
    exclusive,
    onSlotChange(fn) {
      slotListeners.add(fn)
      return () => slotListeners.delete(fn)
    },
    activeRuns: (agentId) => counts.get(agentId) ?? 0,
    stopRuns(agentId) {
      epochs.set(agentId, (epochs.get(agentId) ?? 0) + 1)
      active.get(agentId)?.stop('stopped')
    },
    idleStopAt(agentId) {
      const last = lastActivity.get(agentId)
      if (last === undefined || counts.get(agentId)) return undefined
      return new Date(last + idleMs).toISOString()
    },
    idleSweep,
    startIdleTimer() {
      const h = setInterval(() => void idleSweep(), IDLE_SWEEP_MS)
      h.unref?.()
      return () => clearInterval(h)
    },
  }
}
