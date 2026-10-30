/**
 * BE-P2-12: RunService (plan §3.1, §5, §7.4; contract "RunService").
 *
 * - One global FIFO queue across bots. `concurrency()` runs at once (1 on Mac/Windows, the Linux
 *   formula from VmHostInfo.concurrency), never two of the same bot (the runner serializes per bot).
 * - Lifecycle: queued → running → succeeded | failed | timed_out | stopped (and later 'undone').
 *   Every status change is written to data/runs/<slug>/<runId>.json, the run card (ChatMessage kind
 *   'run') is updated, and `run.updated` is published. Output streams to <runId>.stdout.log /
 *   .stderr.log and as coalesced `run.output` events.
 * - Floors: before queueing, the runner's blocks (gVisor, limits, mounts), the 10 GB personal
 *   limit and the 3 GB machine free-space floor answer 409 with a `reason`; at the run's turn they
 *   are checked again and a blocked run ends 'failed' with `reason`.
 * - Restart recovery: records left queued or running become 'failed'; a snapshot left pending by a
 *   crash is finished first so the run keeps its files list and undo.
 */
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { join, posix } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { fail, failWithReason } from './http.js'
import { NETWORK_UNAVAILABLE } from './podman-runner.js'
import type { RunScriptRequest, RunScriptResult } from './runner.js'
import { runMessageContent } from './run-messages.js'
import type { RunLogs } from './snapshot-budget.js'
import type { UndoApplyResult, UndoPartialRun } from './undo.js'
import type {
  Agent,
  ChatMessage,
  ChatRunSummary,
  Conversation,
  FileChange,
  LiveEvent,
  ScriptRun,
  ScriptRunKind,
  ScriptRunStatus,
  ScriptRunSummary,
  ScriptRunUndo,
} from './shared/types.js'
import { SCRIPT_RUN_ACTIVE } from './shared/types.js'

/** Plan §5: new runs are blocked below 3 GB free on the machine (GiB, like the snapshot budget's 5 GB floor). */
export const RUN_FREE_FLOOR_BYTES = 3 * 1024 ** 3
export const LOW_DISK_REASON = 'low_disk'
export const LOW_DISK_TEXT = "This computer is almost out of disk space (less than 3 GB free), so scripts can't run until some space is freed."
/** The model gets the last 8 KB of each stream (plan §3.1 step 8). */
export const MODEL_TAIL_BYTES = 8 * 1024
/** The record keeps the last 64 KB of each stream (same as the runner's TAIL_BYTES). */
export const RECORD_TAIL_BYTES = 64 * 1024
export const OUTPUT_FLUSH_MS = 200
/** At most this much of one stream per run.output event; older text in the same window is skipped (the full log has it). */
export const OUTPUT_EVENT_BYTES = 16 * 1024
export const RESTART_RUNNING_TEXT = 'AgentControl stopped while this run was in progress, so it was ended.'
export const RESTART_QUEUED_TEXT = 'AgentControl restarted before this run started, so it was not run.'
export const STOPPED_QUEUED_TEXT = 'The run was stopped before it started.'
export const LOG_EVICTED_TEXT = "This run's full output is no longer kept (older runs' logs are removed to save space)."
/** Logs of runs without a snapshot: kept for the bot's last 20 runs or 7 days (as snapshots, plan §7.4 step 1). */
export const LOG_KEEP_RUNS = 20
export const LOG_KEEP_MS = 7 * 24 * 3600 * 1000
/** Reasons a run is refused before it is queued (409) or failed at its turn. */
export const RUN_BLOCK_REASONS = ['gvisor_unavailable', 'limits_unenforced', 'mounts_unusable', 'personal_quota', 'snapshot_failed', LOW_DISK_REASON] as const

/** ScriptRun (its `reason?` is BE-P2-12, additive). */
export type ScriptRunWithReason = ScriptRun

export interface StartRunInput {
  agentId: string
  conversationId: string
  context: { kind: 'dm' } | { kind: 'group'; groupId: string }
  argv: string[]
  cwd?: string
  why?: string
  skillId?: string
  agentRunId?: string
  network?: 'off' | 'on'
  browser?: boolean
  timeoutSec?: number
  kind?: Exclude<ScriptRunKind, 'undo'>
}

export interface RunRunner {
  run(req: RunScriptRequest): Promise<RunScriptResult>
  /** The checks `run` makes before queueing (null: it would run). */
  check(req: RunScriptRequest): RunScriptResult | null
  stopRuns(agentId: string): number | Promise<number> | void
}

export interface RunServiceDeps {
  runner: RunRunner
  getAgent(agentId: string): Agent | undefined
  conversations(): Conversation[]
  messages(): ChatMessage[]
  /** Persist the store (messages and conversations). */
  save(): void
  /** data/runs (one folder per bot slug). */
  root(): string
  /** Runs at once on this machine (VmHostInfo.concurrency). */
  concurrency(): number | Promise<number>
  /** Free bytes where bot files and snapshots live; null = unknown (the run is allowed). */
  freeBytes(): number | null | Promise<number | null>
  /** The 10 GB personal limit check (BE-P2-10). */
  personal?(agent: Agent): Promise<{ blocked: string | null }>
  publish?(event: LiveEvent): void
  /** A run ended or changed (VmInfo.runs, vm.updated). */
  onRunsChanged?(agentId: string): void
  /** The current undo state from the snapshot record (evictions happen outside RunService). */
  undoState?(slug: string, runId: string): ScriptRunUndo | null
  undoApply?(agent: Agent, runId: string, opts: { force?: boolean }): Promise<UndoApplyResult>
  /** A crash-left snapshot for the bot, finished (null: none). Called on recover(). */
  recoverSnapshot?(agent: Agent): Promise<{ runId: string; filesChanged: FileChange[]; snapshot: ScriptRun['snapshot']; undo: ScriptRunUndo } | null>
  newRunId(): string
  skillName?(skillId: string): string | undefined
  now?(): Date
  log?(msg: string): void
  flushMs?: number
}

export interface RunListPage {
  runs: ScriptRunSummary[]
  hasMore: boolean
}

export interface RunService extends RunLogs {
  /** Validate, then create the queued run and its card. 404/400/409 via fail(). */
  start(input: StartRunInput): Promise<ScriptRunWithReason>
  /** Resolves with the ended run. */
  wait(runId: string): Promise<ScriptRunWithReason>
  get(runId: string): ScriptRunWithReason | null
  list(agentId: string, opts?: { before?: string; limit?: number }): RunListPage
  /** The full log of one stream; null when the run is unknown; throws 410 when evicted. */
  outputPath(runId: string, stream: 'stdout' | 'stderr'): string
  stop(runId: string): Promise<ScriptRunWithReason>
  /** Stop every queued and running run of the bot (VM stop/reset); returns how many. */
  stopAgent(agentId: string): Promise<number>
  /** Runs RunService still holds for the bot that the runner doesn't know yet (queued). */
  waiting(agentId: string): number
  /** All queued or running runs RunService holds (any bot). */
  activeCount(): number
  undo(runId: string, opts?: { force?: boolean }): Promise<{ run: ScriptRunWithReason; undoRun: ScriptRunWithReason }>
  /** The 8 KB-per-stream view the model gets. */
  modelResult(run: ScriptRun): ModelRunResult
  recover(): Promise<number>
  /** Wait for in-flight work (tests, shutdown). */
  idle(): Promise<void>
  agentOf(runId: string): string | undefined
}

export interface ModelRunResult {
  status: ScriptRunStatus
  exitCode?: number
  error?: string
  reason?: string
  stdout: string
  stderr: string
  outputTruncated: boolean
  filesChanged: FileChange[]
  runtime: ScriptRun['runtime']
  durationMs?: number
}

/** The last `max` bytes of `s` as UTF-8, never starting inside a character. */
export function tailUtf8(s: string, max: number): string {
  const buf = Buffer.from(s, 'utf8')
  if (buf.length <= max) return s
  let start = buf.length - max
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start++
  return buf.subarray(start).toString('utf8').replace(/^\uFFFD+/, '')
}

export function blockedFromResult(r: RunScriptResult): { reason: string; message: string } | null {
  if (r.reason && (RUN_BLOCK_REASONS as readonly string[]).includes(r.reason)) return { reason: r.reason, message: r.error ?? 'This run is blocked.' }
  return null
}

export function scriptNameOf(argv: string[]): string | undefined {
  const a = argv[1] && !argv[1].startsWith('-') ? argv[1] : argv[0]
  if (!a) return undefined
  return posix.basename(a.replace(/\\/g, '/')) || undefined
}

function filesSplit(files: FileChange[]): { added: number; modified: number; deleted: number } {
  const out = { added: 0, modified: 0, deleted: 0 }
  for (const f of files) out[f.change]++
  return out
}

export function summaryOf(run: ScriptRun): ScriptRunSummary {
  return {
    id: run.id,
    agentId: run.agentId,
    conversationId: run.conversationId,
    kind: run.kind,
    argv: run.argv,
    ...(run.why !== undefined ? { why: run.why } : {}),
    status: run.status,
    ...(run.exitCode !== undefined ? { exitCode: run.exitCode } : {}),
    queuedAt: run.queuedAt,
    ...(run.startedAt ? { startedAt: run.startedAt } : {}),
    ...(run.endedAt ? { endedAt: run.endedAt } : {}),
    ...(run.durationMs !== undefined ? { durationMs: run.durationMs } : {}),
    runtime: run.runtime,
    undo: run.undo,
    ...(run.undoOfRunId ? { undoOfRunId: run.undoOfRunId } : {}),
    filesChangedCount: run.filesChanged.length,
    ...(run.groupId ? { groupId: run.groupId } : {}),
    files: filesSplit(run.filesChanged),
    network: run.network,
  }
}

const isActive = (s: ScriptRunStatus) => SCRIPT_RUN_ACTIVE.includes(s)

interface Live {
  run: ScriptRunWithReason
  slug: string
  controller: AbortController
  /** Pending run.output text per stream (coalesced). */
  out: { stdout: string; stderr: string; dec: { stdout: StringDecoder; stderr: StringDecoder } }
  timer?: ReturnType<typeof setTimeout>
  fds: { stdout?: number; stderr?: number }
  done: Promise<ScriptRunWithReason>
  resolve: (r: ScriptRunWithReason) => void
}

export function createRunService(deps: RunServiceDeps): RunService {
  const now = deps.now ?? (() => new Date())
  const log = deps.log ?? (() => {})
  const flushMs = deps.flushMs ?? OUTPUT_FLUSH_MS
  /** Every known run (tails dropped once ended; the full record is on disk). */
  const index = new Map<string, { run: ScriptRunWithReason; slug: string }>()
  const live = new Map<string, Live>()
  const queue: string[] = []
  const running = new Set<string>()
  const inflight = new Set<Promise<unknown>>()
  let loaded = false

  const dirOf = (slug: string) => join(deps.root(), slug)
  const fileOf = (slug: string, runId: string, ext: string) => join(dirOf(slug), `${runId}.${ext}`)
  const track = <T>(p: Promise<T>): Promise<T> => {
    inflight.add(p)
    void p.finally(() => inflight.delete(p)).catch(() => {})
    return p
  }

  function write(slug: string, run: ScriptRun): void {
    try {
      mkdirSync(dirOf(slug), { recursive: true })
      const tmp = fileOf(slug, run.id, `json.${process.pid}.tmp`)
      writeFileSync(tmp, JSON.stringify(run))
      renameSync(tmp, fileOf(slug, run.id, 'json'))
    } catch (err) {
      log(`runs: couldn't save run ${run.id}: ${(err as Error).message}`)
    }
  }

  function readRecord(slug: string, runId: string): ScriptRunWithReason | null {
    try {
      return JSON.parse(readFileSync(fileOf(slug, runId, 'json'), 'utf8')) as ScriptRunWithReason
    } catch {
      return null
    }
  }

  function slim(run: ScriptRunWithReason): ScriptRunWithReason {
    return { ...run, stdoutTail: '', stderrTail: '' }
  }

  function load(): void {
    if (loaded) return
    loaded = true
    let slugs: string[] = []
    try {
      slugs = readdirSync(deps.root(), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    } catch {
      return
    }
    for (const slug of slugs) {
      let files: string[] = []
      try {
        files = readdirSync(dirOf(slug)).filter((f) => f.endsWith('.json'))
      } catch {
        continue
      }
      for (const f of files) {
        const run = readRecord(slug, f.slice(0, -'.json'.length))
        if (run && typeof run.id === 'string' && typeof run.agentId === 'string') index.set(run.id, { run: slim(run), slug })
      }
    }
  }

  /** The bot's runs, newest first. */
  function runsOf(agentId: string): ScriptRunWithReason[] {
    load()
    const out: ScriptRunWithReason[] = []
    for (const { run } of index.values()) if (run.agentId === agentId) out.push(live.get(run.id)?.run ?? run)
    return out.sort((a, b) => (a.queuedAt === b.queuedAt ? (a.id < b.id ? 1 : -1) : a.queuedAt < b.queuedAt ? 1 : -1))
  }

  function chatSummary(run: ScriptRun): ChatRunSummary {
    const scriptName = run.kind === 'undo' ? undefined : scriptNameOf(run.argv)
    const skill = run.skillId ? deps.skillName?.(run.skillId) : undefined
    const s: ChatRunSummary = {
      status: run.status,
      kind: run.kind,
      name: skill || scriptName || (run.kind === 'undo' ? 'undo' : 'script'),
      files: filesSplit(run.filesChanged),
      undo: run.undo,
    }
    if (scriptName) s.scriptName = scriptName
    if (run.status === 'queued' && run.queuePosition !== undefined) s.queuePosition = run.queuePosition
    if (run.exitCode !== undefined) s.exitCode = run.exitCode
    if (run.durationMs !== undefined) s.durationMs = run.durationMs
    if (run.runtime !== undefined) s.runtime = run.runtime
    if (run.kind === 'undo' && run.undoOfRunId) {
      const of = index.get(run.undoOfRunId)?.run
      const name = of ? scriptNameOf(of.argv) || (of.skillId ? deps.skillName?.(of.skillId) : undefined) : undefined
      if (name) {
        s.undoOfName = name
        s.name = (of?.skillId ? deps.skillName?.(of.skillId) : undefined) || name
      }
    }
    return s
  }

  /** Create or update the run's card. `persist`: save the store (status changes only). */
  function syncCard(run: ScriptRun, persist: boolean): ChatRunSummary {
    const summary = chatSummary(run)
    const msgs = deps.messages()
    let msg = run.messageId ? msgs.find((m) => m.id === run.messageId) : undefined
    if (!msg) {
      const conv = deps.conversations().find((c) => c.id === run.conversationId)
      if (conv) {
        msg = {
          id: `msg-${crypto.randomUUID()}`,
          conversationId: run.conversationId,
          role: 'assistant',
          content: '',
          createdAt: run.queuedAt,
          kind: 'run',
          scriptRunId: run.id,
          authorAgentId: run.agentId,
        }
        msgs.push(msg)
        conv.updatedAt = run.queuedAt
        run.messageId = msg.id
        persist = true
      }
    }
    if (msg) {
      msg.scriptRun = summary
      msg.content = runMessageContent(summary)
    }
    if (persist) deps.save()
    return summary
  }

  function emit(run: ScriptRunWithReason, persist: boolean): void {
    const summary = syncCard(run, persist)
    // A copy: the live record keeps changing, and the bus keeps events for replay.
    deps.publish?.({ type: 'run.updated', conversationId: run.conversationId, run: { ...run }, ...(run.messageId ? { messageId: run.messageId } : {}), summary })
  }

  /** Save + card + event on a status change. */
  function changed(entry: { run: ScriptRunWithReason; slug: string }): void {
    write(entry.slug, entry.run)
    emit(entry.run, true)
    index.set(entry.run.id, { run: isActive(entry.run.status) ? entry.run : slim(entry.run), slug: entry.slug })
  }

  function flush(l: Live): void {
    if (l.timer) clearTimeout(l.timer)
    l.timer = undefined
    for (const stream of ['stdout', 'stderr'] as const) {
      const text = l.out[stream]
      if (!text) continue
      l.out[stream] = ''
      deps.publish?.({ type: 'run.output', conversationId: l.run.conversationId, runId: l.run.id, stream, chunk: text })
    }
  }

  function onOutput(l: Live, stream: 'stdout' | 'stderr', chunk: Buffer | string): void {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    const fd = l.fds[stream]
    if (fd !== undefined) {
      try {
        writeSync(fd, buf)
      } catch (err) {
        log(`runs: log write failed for ${l.run.id}: ${(err as Error).message}`)
        l.fds[stream] = undefined
      }
    }
    l.run.outputBytes += buf.length
    const text = l.out.dec[stream].write(buf)
    const key = stream === 'stdout' ? 'stdoutTail' : 'stderrTail'
    l.run[key] = tailUtf8(l.run[key] + text, RECORD_TAIL_BYTES)
    if (!deps.publish) return
    l.out[stream] = tailUtf8(l.out[stream] + text, OUTPUT_EVENT_BYTES)
    if (!l.timer) {
      l.timer = setTimeout(() => flush(l), flushMs)
      l.timer.unref?.()
    }
  }

  function closeLogs(l: Live): void {
    for (const s of ['stdout', 'stderr'] as const) {
      const fd = l.fds[s]
      l.fds[s] = undefined
      if (fd !== undefined) {
        try {
          closeSync(fd)
        } catch {
          // ignore
        }
      }
    }
  }

  /** Runs ahead of each queued one: those running now plus the queued before it (plan: "Queued · 1 ahead"). */
  function updatePositions(): void {
    let ahead = running.size
    for (const id of queue) {
      const l = live.get(id)
      if (!l) continue
      if (l.run.queuePosition !== ahead) {
        l.run.queuePosition = ahead
        emit(l.run, false)
      }
      ahead++
    }
  }

  function finish(l: Live, patch: Partial<ScriptRunWithReason>): void {
    flush(l)
    closeLogs(l)
    const run = l.run
    Object.assign(run, patch)
    delete run.queuePosition
    run.endedAt = run.endedAt ?? now().toISOString()
    if (run.durationMs === undefined && run.startedAt) run.durationMs = Math.max(0, Date.parse(run.endedAt) - Date.parse(run.startedAt))
    changed({ run, slug: l.slug })
    live.delete(run.id)
    running.delete(run.id)
    const qi = queue.indexOf(run.id)
    if (qi >= 0) queue.splice(qi, 1)
    l.resolve(run)
    pruneLogs(run.agentId, l.slug)
    deps.onRunsChanged?.(run.agentId)
    refreshUndo(run.agentId, run.id)
    void pump()
  }

  /** Runs whose undo state changed through eviction since they ended: update the record, card and event. */
  function refreshUndo(agentId: string, except?: string): void {
    if (!deps.undoState) return
    for (const r of runsOf(agentId)) {
      if (r.id === except || isActive(r.status) || !r.snapshot || r.undo.state !== 'available') continue
      const e = index.get(r.id)
      if (!e) continue
      const u = deps.undoState(e.slug, r.id)
      if (!u || u.state === 'available') continue
      const full = readRecord(e.slug, r.id)
      if (!full) continue
      full.undo = u
      changed({ run: full, slug: e.slug })
    }
  }

  function overlayUndo(run: ScriptRunWithReason, slug: string): ScriptRunWithReason {
    if (!deps.undoState || !run.snapshot || isActive(run.status)) return run
    const u = deps.undoState(slug, run.id)
    return u ? { ...run, undo: u } : run
  }

  /** Logs of runs without a snapshot past the bot's last 20 runs and 7 days (snapshot runs' logs go with their snapshot). */
  function pruneLogs(agentId: string, slug: string): void {
    const cutoff = now().getTime() - LOG_KEEP_MS
    runsOf(agentId).forEach((r, i) => {
      if (i < LOG_KEEP_RUNS || isActive(r.status) || r.snapshot) return
      const at = Date.parse(r.endedAt ?? r.queuedAt)
      if (Number.isFinite(at) && at < cutoff) removeLogs(slug, r.id)
    })
  }

  function removeLogs(slug: string, runId: string): void {
    for (const s of ['stdout', 'stderr']) rmSync(fileOf(slug, runId, `${s}.log`), { force: true })
  }

  async function freeFloorBlock(): Promise<{ reason: string; message: string } | null> {
    const free = await Promise.resolve(deps.freeBytes()).catch(() => null)
    if (free === null || free === undefined || !Number.isFinite(free)) return null
    return free < RUN_FREE_FLOOR_BYTES ? { reason: LOW_DISK_REASON, message: LOW_DISK_TEXT } : null
  }

  async function launch(l: Live): Promise<void> {
    const run = l.run
    running.add(run.id)
    try {
      const agent = deps.getAgent(run.agentId)
      if (!agent) return finish(l, { status: 'failed', error: 'Bot not found.' })
      const floor = await freeFloorBlock()
      if (l.controller.signal.aborted) return finish(l, { status: 'stopped', error: STOPPED_QUEUED_TEXT })
      if (floor) return finish(l, { status: 'failed', error: floor.message, reason: floor.reason })
      const fds: Live['fds'] = {}
      try {
        mkdirSync(dirOf(l.slug), { recursive: true })
        fds.stdout = openSync(fileOf(l.slug, run.id, 'stdout.log'), 'a')
        fds.stderr = openSync(fileOf(l.slug, run.id, 'stderr.log'), 'a')
      } catch (err) {
        log(`runs: couldn't open logs for ${run.id}: ${(err as Error).message}`)
      }
      l.fds = fds
      run.status = 'running'
      run.startedAt = now().toISOString()
      delete run.queuePosition
      changed({ run, slug: l.slug })
      const req = requestOf(run, l)
      const res = await deps.runner.run(req).catch((err: Error): RunScriptResult => ({
        status: 'error', durationMs: 0, stdout: '', stderr: '', filesChanged: [], outcome: 'failed', error: `The run couldn't start: ${err.message}`,
      }))
      finish(l, resultPatch(run, res))
    } catch (err) {
      finish(l, { status: 'failed', error: `The run failed: ${(err as Error).message}` })
    }
  }

  const timeouts = new Map<string, number | undefined>()
  function requestOf(run: ScriptRun, l: Live): RunScriptRequest {
    return {
      agentId: run.agentId,
      context: run.context === 'group' && run.groupId ? { kind: 'group', groupId: run.groupId } : { kind: 'dm' },
      ...(run.skillId ? { skillId: run.skillId } : {}),
      argv: run.argv,
      cwd: run.cwd,
      timeoutSec: timeouts.get(run.id) ?? 600,
      network: run.network,
      runId: run.id,
      onOutput: (stream, chunk) => onOutput(l, stream, chunk),
      signal: l.controller.signal,
    }
  }

  function resultPatch(run: ScriptRun, res: RunScriptResult): Partial<ScriptRunWithReason> {
    const status: ScriptRunStatus = res.outcome ?? (res.status === 'ok' ? 'succeeded' : 'failed')
    const patch: Partial<ScriptRunWithReason> = {
      status,
      durationMs: res.durationMs,
      filesChanged: res.filesChanged ?? [],
      snapshot: res.snapshot ?? null,
      undo: res.undo ?? (res.snapshot ? { state: 'available' } : { state: 'unavailable' }),
      runtime: res.runtime ?? run.runtime ?? null,
      // The streamed tails are exact; the result's are the fallback (a runner that didn't stream).
      stdoutTail: run.stdoutTail || tailUtf8(res.stdout ?? '', RECORD_TAIL_BYTES),
      stderrTail: run.stderrTail || tailUtf8(res.stderr ?? '', RECORD_TAIL_BYTES),
      outputBytes: Math.max(run.outputBytes, res.outputBytes ?? 0),
    }
    if (res.exitCode !== undefined && res.exitCode !== null) patch.exitCode = res.exitCode
    if (res.error) patch.error = res.error
    if (res.outputTruncated) patch.outputTruncated = true
    const block = blockedFromResult(res)
    if (block) patch.reason = block.reason
    timeouts.delete(run.id)
    return patch
  }

  let pumping = false
  let again = false
  async function pump(): Promise<void> {
    if (pumping) {
      again = true
      return
    }
    pumping = true
    try {
      do {
        again = false
        const limit = Math.max(1, Math.floor(Number(await Promise.resolve(deps.concurrency()).catch(() => 1)) || 1))
        const busy = new Set([...running].map((id) => live.get(id)?.run.agentId))
        for (const id of [...queue]) {
          if (running.size >= limit) break
          const l = live.get(id)
          if (!l) continue
          if (busy.has(l.run.agentId)) continue
          busy.add(l.run.agentId)
          queue.splice(queue.indexOf(id), 1)
          running.add(id)
          void track(launch(l))
        }
        updatePositions()
      } while (again)
    } finally {
      pumping = false
    }
  }

  function newLive(run: ScriptRunWithReason, slug: string): Live {
    let resolve!: (r: ScriptRunWithReason) => void
    const done = new Promise<ScriptRunWithReason>((r) => (resolve = r))
    return {
      run,
      slug,
      out: { stdout: '', stderr: '', dec: { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') } },
      fds: {},
      controller: new AbortController(),
      done,
      resolve,
    }
  }

  function baseRun(input: StartRunInput, agent: Agent, id: string): ScriptRunWithReason {
    return {
      id,
      agentId: agent.id,
      conversationId: input.conversationId,
      ...(input.agentRunId ? { agentRunId: input.agentRunId } : {}),
      context: input.context.kind,
      ...(input.context.kind === 'group' ? { groupId: input.context.groupId } : {}),
      ...(input.skillId ? { skillId: input.skillId } : {}),
      kind: input.kind ?? 'script',
      argv: [...input.argv],
      cwd: input.cwd || 'workspace',
      ...(input.why ? { why: input.why } : {}),
      network: input.network === 'on' ? 'on' : 'off',
      browser: input.browser === true,
      runtime: null,
      permissions: [],
      status: 'queued',
      queuedAt: now().toISOString(),
      stdoutTail: '',
      stderrTail: '',
      outputBytes: 0,
      filesChanged: [],
      snapshot: null,
      undo: { state: 'unavailable' },
    }
  }

  function createLogs(slug: string, runId: string): void {
    try {
      mkdirSync(dirOf(slug), { recursive: true })
      for (const s of ['stdout', 'stderr']) writeFileSync(fileOf(slug, runId, `${s}.log`), '', { flag: 'a' })
    } catch (err) {
      log(`runs: couldn't create logs for ${runId}: ${(err as Error).message}`)
    }
  }

  const service: RunService = {
    async start(input) {
      load()
      const agent = deps.getAgent(input.agentId)
      if (!agent) fail(404, 'Bot not found.')
      const conv = deps.conversations().find((c) => c.id === input.conversationId)
      if (!conv) fail(404, 'Conversation not found.')
      if (input.context.kind === 'dm' ? conv.kind !== 'dm' || conv.agentId !== agent.id : conv.kind !== 'group' || conv.id !== input.context.groupId || !conv.memberAgentIds.includes(agent.id)) {
        fail(400, "This run's chat doesn't match its bot.")
      }
      const id = deps.newRunId()
      const probe: RunScriptRequest = {
        agentId: agent.id,
        context: input.context,
        argv: input.argv,
        cwd: input.cwd || 'workspace',
        timeoutSec: input.timeoutSec ?? 600,
        network: input.network === 'on' ? 'on' : 'off',
        runId: id,
      }
      const refused = deps.runner.check(probe)
      if (refused) {
        const block = blockedFromResult(refused)
        if (block) failWithReason(409, block.reason, block.message)
        if (refused.error !== NETWORK_UNAVAILABLE) fail(refused.error === 'Bot not found.' ? 404 : 400, refused.error ?? 'This run is not valid.')
      }
      if (!refused && deps.personal) {
        const q = await deps.personal(agent).catch(() => ({ blocked: null }))
        if (q.blocked) failWithReason(409, 'personal_quota', q.blocked)
      }
      if (!refused) {
        const floor = await freeFloorBlock()
        if (floor) failWithReason(409, floor.reason, floor.message)
      }
      const run = baseRun(input, agent, id)
      timeouts.set(id, input.timeoutSec)
      const l = newLive(run, agent.slug)
      createLogs(agent.slug, id)
      if (refused) {
        // network 'on' (M1): a failed record with the plain message; the model is told.
        live.set(id, l)
        finish(l, { status: 'failed', error: refused.error })
        return run
      }
      live.set(id, l)
      queue.push(id)
      run.queuePosition = running.size + queue.length - 1
      changed({ run, slug: agent.slug })
      log(`runs: ${agent.slug}: queued ${id} (${scriptNameOf(run.argv) ?? 'script'})`)
      await pump()
      return run
    },
    async wait(runId) {
      const l = live.get(runId)
      if (l) return l.done
      const r = service.get(runId)
      if (!r) fail(404, 'Run not found.')
      return r
    },
    get(runId) {
      load()
      const l = live.get(runId)
      if (l) return l.run
      const e = index.get(runId)
      if (!e) return null
      const full = readRecord(e.slug, runId) ?? e.run
      return overlayUndo(full, e.slug)
    },
    list(agentId, opts = {}) {
      const limit = Math.min(50, Math.max(1, Math.floor(opts.limit ?? 50) || 50))
      let all = runsOf(agentId)
      if (opts.before) {
        const i = all.findIndex((r) => r.id === opts.before)
        if (i < 0) fail(400, 'Unknown run in "before".')
        all = all.slice(i + 1)
      }
      const page = all.slice(0, limit).map((r) => {
        const slug = index.get(r.id)?.slug
        return summaryOf(slug ? overlayUndo(r, slug) : r)
      })
      return { runs: page, hasMore: all.length > limit }
    },
    outputPath(runId, stream) {
      load()
      const e = index.get(runId)
      if (!e) fail(404, 'Run not found.')
      const p = fileOf(e.slug, runId, `${stream}.log`)
      if (!existsSync(p)) failWithReason(410, 'log_evicted', LOG_EVICTED_TEXT)
      return p
    },
    async stop(runId) {
      const l = live.get(runId)
      if (!l) {
        if (!service.get(runId)) fail(404, 'Run not found.')
        failWithReason(409, 'not_active', "This run isn't queued or running.")
      }
      if (queue.includes(runId)) {
        finish(l, { status: 'stopped', error: STOPPED_QUEUED_TEXT })
        return l.run
      }
      l.controller.abort()
      const t = new Promise<null>((r) => setTimeout(() => r(null), 15_000).unref?.())
      return (await Promise.race([l.done, t])) ?? l.run
    },
    async stopAgent(agentId) {
      let n = 0
      for (const l of [...live.values()]) {
        if (l.run.agentId !== agentId) continue
        n++
        if (queue.includes(l.run.id)) finish(l, { status: 'stopped', error: STOPPED_QUEUED_TEXT })
        else l.controller.abort()
      }
      await Promise.resolve(deps.runner.stopRuns(agentId))
      return n
    },
    waiting(agentId) {
      let n = 0
      for (const id of queue) if (live.get(id)?.run.agentId === agentId) n++
      // A launched run between our queue and the runner's (floor check) counts too.
      for (const id of running) if (live.get(id)?.run.agentId === agentId && live.get(id)?.run.status === 'queued') n++
      return n
    },
    activeCount: () => live.size,
    async undo(runId, opts = {}) {
      const target = service.get(runId)
      if (!target) fail(404, 'Run not found.')
      const agent = deps.getAgent(target.agentId)
      if (!agent || !deps.undoApply) fail(404, 'Bot not found.')
      const e = index.get(runId)!
      const startedAt = now().toISOString()
      const record = (id: string, part: { snapshot: ScriptRun['snapshot']; filesChanged: FileChange[]; undo: ScriptRunUndo }, status: ScriptRunStatus, error?: string) => {
        const run: ScriptRunWithReason = {
          ...baseRun({ agentId: agent.id, conversationId: target.conversationId, context: target.context === 'group' && target.groupId ? { kind: 'group', groupId: target.groupId } : { kind: 'dm' }, argv: [] , cwd: target.cwd }, agent, id),
          kind: 'undo',
          undoOfRunId: runId,
          status,
          queuedAt: startedAt,
          startedAt,
          endedAt: now().toISOString(),
          snapshot: part.snapshot,
          filesChanged: part.filesChanged,
          undo: part.undo,
          ...(error ? { error } : {}),
        }
        run.durationMs = Math.max(0, Date.parse(run.endedAt!) - Date.parse(startedAt))
        changed({ run, slug: e.slug })
        return run
      }
      let res: UndoApplyResult
      try {
        res = await deps.undoApply(agent, runId, opts)
      } catch (err) {
        const partial = (err as { undoRun?: UndoPartialRun }).undoRun
        if (partial) record(partial.undoRunId, partial, 'failed', (err as Error).message)
        throw err
      }
      const undoRun = record(res.undoRunId, { snapshot: res.snapshot, filesChanged: res.filesChanged, undo: res.undoRunUndo }, 'succeeded')
      const full = readRecord(e.slug, runId) ?? target
      full.undo = res.undo
      full.status = 'undone'
      changed({ run: full, slug: e.slug })
      // Undoing an undo brings the first run's changes back: refresh it from its snapshot record.
      if (full.kind === 'undo' && full.undoOfRunId) {
        const orig = index.get(full.undoOfRunId)
        const u = orig && deps.undoState?.(orig.slug, full.undoOfRunId)
        const rec = orig && readRecord(orig.slug, full.undoOfRunId)
        if (orig && rec && u) {
          rec.undo = u
          changed({ run: rec, slug: orig.slug })
        }
      }
      deps.onRunsChanged?.(agent.id)
      refreshUndo(agent.id)
      return { run: full, undoRun }
    },
    modelResult(run) {
      return {
        status: run.status,
        ...(run.exitCode !== undefined ? { exitCode: run.exitCode } : {}),
        ...(run.error ? { error: run.error } : {}),
        ...(run.reason ? { reason: run.reason } : {}),
        stdout: tailUtf8(run.stdoutTail, MODEL_TAIL_BYTES),
        stderr: tailUtf8(run.stderrTail, MODEL_TAIL_BYTES),
        outputTruncated: run.outputTruncated === true,
        filesChanged: run.filesChanged,
        runtime: run.runtime,
        ...(run.durationMs !== undefined ? { durationMs: run.durationMs } : {}),
      }
    },
    async recover() {
      load()
      let n = 0
      const stale = [...index.values()].filter((e) => isActive(e.run.status))
      const recovered = new Map<string, Awaited<ReturnType<NonNullable<RunServiceDeps['recoverSnapshot']>>>>()
      if (deps.recoverSnapshot) {
        for (const agentId of new Set(stale.map((e) => e.run.agentId))) {
          const agent = deps.getAgent(agentId)
          if (!agent) continue
          try {
            const o = await deps.recoverSnapshot(agent)
            if (o) recovered.set(o.runId, o)
          } catch (err) {
            log(`runs: ${agent.slug}: snapshot recovery failed: ${(err as Error).message}`)
          }
        }
      }
      for (const e of stale) {
        const full = readRecord(e.slug, e.run.id) ?? e.run
        const wasRunning = full.status !== 'queued'
        full.status = 'failed'
        full.error = wasRunning ? RESTART_RUNNING_TEXT : RESTART_QUEUED_TEXT
        delete full.queuePosition
        full.endedAt = now().toISOString()
        if (full.startedAt) full.durationMs = Math.max(0, Date.parse(full.endedAt) - Date.parse(full.startedAt))
        const o = recovered.get(full.id)
        if (o) {
          full.filesChanged = o.filesChanged
          full.snapshot = o.snapshot
          full.undo = o.undo
        }
        changed({ run: full, slug: e.slug })
        n++
      }
      if (n) log(`runs: ${n} run(s) left by a restart were marked failed`)
      return n
    },
    async idle() {
      while (inflight.size) await Promise.allSettled([...inflight])
    },
    agentOf(runId) {
      load()
      return live.get(runId)?.run.agentId ?? index.get(runId)?.run.agentId
    },
    bytes(slug, runId) {
      let n = 0
      for (const s of ['stdout', 'stderr']) {
        try {
          n += statSync(fileOf(slug, runId, `${s}.log`)).size
        } catch {
          // none
        }
      }
      return n
    },
    remove(slug, runId) {
      removeLogs(slug, runId)
    },
  }
  return service
}
