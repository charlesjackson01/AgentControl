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
import { capHostContacts } from './egress-service.js'
import { NETWORK_UNAVAILABLE } from './podman-runner.js'
import type { RunScriptRequest, RunScriptResult } from './runner.js'
import { runMessageContent, TOOL_BUILD_CARD_NAME } from './run-messages.js'
import type { RunLogs } from './snapshot-budget.js'
import type { UndoApplyResult, UndoPartialRun } from './undo.js'
import type {
  ActiveToolBuild,
  Agent,
  ChatMessage,
  ChatRunSummary,
  Conversation,
  FileChange,
  HostContact,
  InternetUse,
  LiveEvent,
  QueuedReason,
  ScriptRun,
  ScriptRunKind,
  ScriptRunPermission,
  ScriptRunStatus,
  ScriptRunSummary,
  ScriptRunUndo,
} from './shared/types.js'
import { CHAT_RUN_HOSTS_MAX, SCRIPT_RUN_ACTIVE, TOOL_BUILD_TIMEOUT_MS, type ToolBuildInfo } from './shared/types.js'

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
/** BE-P2-22: 409 while the bot's tools are building (rebuild/rollback/reset). */
export const BUILD_ACTIVE_REASON = 'build_active'
export const BUILD_ACTIVE_TEXT = "Wait for the bot's tools to finish building first."
export const STOPPED_QUEUED_TEXT = 'The run was stopped before it started.'
/** BE-P2-21: a live tool build's end texts (contract "BE-P2-21 Live tool builds with Stop"). */
export const BUILD_STOPPED_REASON = 'build_stopped'
export const BUILD_FAILED_REASON = 'build_failed'
export const buildStoppedText = (bot: string, generation: number) => `Stopped. ${bot} keeps its current tools (version ${generation}).`
export const buildFailedText = (bot: string, generation: number) => `The build failed, so ${bot} keeps its current tools (version ${generation}). Nothing else changed.`
export const buildTimedOutText = (bot: string, generation: number) => `The build took longer than 20 minutes, so ${bot} keeps its current tools (version ${generation}).`
/** BE-P2-21: run.updated for a build's progress and hosts at most this often (status changes always). */
export const BUILD_UPDATE_MS = 1000
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
  /** Runs and exclusive jobs (undo) in or waiting for the bot's slot. Absent: only RunService's own runs count. */
  activeRuns?(agentId: string): number
  /** Called when a bot's `activeRuns` changes; returns an unsubscribe. */
  onSlotChange?(fn: (agentId: string) => void): () => void
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
  /** BE-P2-20: the bot's files check (botFilesMissingMessage); a message refuses runs and undos with 409 files_missing. */
  filesMissing?(agent: Agent): string | null
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
  /** BE-P2-21: tests only (default TOOL_BUILD_TIMEOUT_MS). */
  toolBuildTimeoutMs?: number
}

/** BE-P2-21: what a live build's `build` callback gets (BotEnvService BuildOptions). */
export interface ToolBuildControl {
  signal: AbortSignal
  onOutput(stream: 'stdout' | 'stderr', chunk: string): void
  onProgress(progress: { step: number; steps: number; label: string }): void
  onHosts(hosts: HostContact[]): void
}

/** BE-P2-21: a live tool build (Rebuild, vm_install), recorded as a ScriptRun kind 'tool_build' with a chat card. */
export interface ToolBuildSpec {
  agentId: string
  /** The card's conversation (vm_install: where it was called), or a function that makes the bot's DM (called after the 409 checks). */
  conversationId: string | (() => string)
  context?: StartRunInput['context']
  agentRunId?: string
  via: ToolBuildInfo['via']
  startedBy: ToolBuildInfo['startedBy']
  argv: string[]
  /** The full package list of the new generation, and what changes. */
  packages: string[]
  added: string[]
  removed?: string[]
  network: 'off' | 'on'
  permissions: ScriptRunPermission[]
  /**
   * false (user Rebuild): 409 run_active while the bot has a run. true (vm_install): recorded `queued`
   * (`queuedReason:'slot'`) and started once the bot's current runs end; runs queued after it wait for it.
   */
  waitForRuns: boolean
  /** Checks after build_active / run_active (e.g. internet_never, proxy_unavailable); throw to refuse with no record. */
  precheck?(agent: Agent): void | Promise<void>
  /** The build itself, given the bot as it is when the build starts. A thrown `stopped` / `timedOut` error ends it that way. */
  build(ctl: ToolBuildControl, agent: Agent): Promise<{ generation: number; log?: string; hosts?: HostContact[]; hostsTotal?: number }>
}

export interface RunListPage {
  runs: ScriptRunSummary[]
  hasMore: boolean
}

export type ToolBuildAction = 'rebuild' | 'rollback'
const TOOL_BUILD_WHY: Record<ToolBuildAction, string> = {
  rebuild: "Rebuild the bot's tools",
  rollback: "Go back to the previous version of the bot's tools",
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
  /**
   * BE-P2-17: a tool rebuild or rollback (VM tab), kept as a `ScriptRun` (kind `tool_build`, no
   * chat card). 409 `run_active` while the bot has a run queued or running (or an undo). A 4xx
   * from `build` (e.g. no_previous_generation, internet_unavailable) is passed on with no record; any
   * other failure is recorded as a failed run and then passed on (e.g. 502 build_failed).
   */
  toolBuild(agentId: string, action: ToolBuildAction, build: () => Promise<{ generation: number; log: string }>): Promise<ScriptRunWithReason>
  /**
   * BE-P2-22: true while the bot's tools are building (a toolBuild or a withToolBuild job).
   * Reset answers 409 `build_active` then; toolBuild does too.
   */
  buildActive(agentId: string): boolean
  /**
   * BE-P2-22: run `fn` (a tool build outside toolBuild, e.g. vm_install) holding the bot's build
   * lock: the bot's queued runs wait ("Queued · after tool build") and start once it ends, on the
   * generation it left. No run_active check (runs already going keep their container). Unrecorded.
   */
  withToolBuild<T>(agentId: string, fn: () => Promise<T>): Promise<T>
  /**
   * BE-P2-21: start a live tool build: 404, 409 build_active, 409 run_active (unless waitForRuns),
   * the spec's precheck, 409 low_disk; then the record (queued or running) is returned at once.
   * Stop it with stop(runId); it ends succeeded | failed | timed_out | stopped.
   */
  startToolBuild(spec: ToolBuildSpec): Promise<ScriptRunWithReason>
  /** BE-P2-21: VmInfo.activeBuild / VmToolsInfo.activeBuild (null: no live build). */
  activeBuild(agentId: string): ActiveToolBuild | null
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
    ...(run.status === 'queued' && run.queuePosition !== undefined ? { queuePosition: run.queuePosition } : {}),
    ...(run.status === 'queued' && run.queuedReason ? { queuedReason: run.queuedReason } : {}),
    filesChangedCount: run.filesChanged.length,
    ...(run.groupId ? { groupId: run.groupId } : {}),
    files: filesSplit(run.filesChanged),
    network: run.network,
    // BE-P2-21: history rows of live builds ("internet once", up to 3 hosts, the build).
    ...(run.build ? { build: run.build, internet: internetOf(run) } : {}),
    ...(run.build && run.hostsContacted?.length ? { hosts: reachedHosts(run.hostsContacted).slice(0, 3) } : {}),
  }
}

/** BE-P2-21: "off" / "on (allowed once)" / "on (always allowed)" from the run's network and permissions. */
export function internetOf(run: Pick<ScriptRun, 'network' | 'permissions'>): InternetUse {
  if (run.network !== 'on') return 'off'
  const p = (run.permissions ?? []).find((x) => x.type === 'internet')
  return p && (p.decision === 'always' || p.source === 'policy') ? 'always' : 'once'
}

function reachedHosts(hosts: readonly HostContact[]): string[] {
  return hosts.filter((h) => !h.blocked).map((h) => h.host)
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
  /** BE-P2-21: each bot's live tool build (one at a time). */
  interface BuildEntry {
    l: Live
    spec: ToolBuildSpec
    /** The bot's runs live when it was recorded: the build waits for them, and they aren't held by it. */
    waitFor: Set<string>
    started: boolean
    timedOut: boolean
    lastEmit: number
    tick?: ReturnType<typeof setTimeout>
    vmDirty: boolean
    limit?: ReturnType<typeof setTimeout>
  }
  const builds = new Map<string, BuildEntry>()
  /** Every known run (tails dropped once ended; the full record is on disk). */
  const index = new Map<string, { run: ScriptRunWithReason; slug: string }>()
  const live = new Map<string, Live>()
  const queue: string[] = []
  const running = new Set<string>()
  /** Launched runs whose runner.run call is in progress (counted by runner.activeRuns). */
  const inRunner = new Set<string>()
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
    if (run.status === 'queued' && run.queuedReason) s.queuedReason = run.queuedReason
    if (run.exitCode !== undefined) s.exitCode = run.exitCode
    if (run.durationMs !== undefined) s.durationMs = run.durationMs
    if (run.runtime !== undefined) s.runtime = run.runtime
    // BE-P2-21: the live build card ("Rebuild tools", progress, sites used so far, end text).
    if (run.kind === 'tool_build' && run.build) {
      delete s.scriptName
      s.name = TOOL_BUILD_CARD_NAME
      s.build = run.build
      s.network = run.network
      s.internet = internetOf(run)
      if (run.startedAt) s.startedAt = run.startedAt
      if (run.hostsContacted?.length) {
        s.hostsContacted = run.hostsContacted.slice(0, CHAT_RUN_HOSTS_MAX)
        const total = run.hostsContactedTotal ?? run.hostsContacted.length
        if (total > s.hostsContacted.length) s.hostsContactedTotal = total
      }
      if (run.reason) s.reason = run.reason
      if (run.error && !isActive(run.status)) s.error = run.error
    }
    // BE-P2-22: a run queued behind a live build names it ("runs on the new tools (version 3)").
    if (run.status === 'queued' && run.queuedReason === 'tool_build') {
      const b = builds.get(run.agentId)
      if (b && b.l.run.build) s.afterBuild = { runId: b.l.run.id, generation: b.l.run.build.generation }
    }
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
    // BE-P2-17: a rollback (no `build`) shows in the VM tab's history only; BE-P2-21: live builds get a card.
    if (run.kind === 'tool_build' && !run.build) return summary
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
      msg.content = runMessageContent(summary, deps.getAgent(run.agentId)?.name)
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
    const b = builds.get(entry.run.agentId)
    if (b && b.l.run === entry.run) b.lastEmit = Date.now()
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

  /**
   * Runs ahead of each queued one: those running now plus the queued before it (plan: "Queued · 1 ahead").
   * BE-P2-22: a tool build of the same bot counts as 1 ahead, and sets queuedReason 'tool_build'.
   */
  function queueSpot(agentId: string, ahead: number, runId?: string): { pos: number; reason: QueuedReason } {
    const b = heldByBuild(agentId, runId)
    // Plus whatever holds the bot's slot outside RunService (an undo).
    return { pos: ahead + outside(agentId) + (b ? 1 : 0), reason: b ? 'tool_build' : 'slot' }
  }
  function updatePositions(): void {
    let ahead = running.size
    for (const id of queue) {
      const l = live.get(id)
      if (!l) continue
      // BE-P2-21: a queued build has its own position (the runs it waits for).
      if (l.run.kind === 'tool_build') continue
      const { pos, reason } = queueSpot(l.run.agentId, ahead, l.run.id)
      if (l.run.queuePosition !== pos || l.run.queuedReason !== reason) {
        l.run.queuePosition = pos
        l.run.queuedReason = reason
        emit(l.run, false)
      }
      ahead++
    }
  }

  /** Jobs in or waiting for the bot's runner slot that aren't RunService runs (undo, recovery). */
  /**
   * BE-P2-17: bots with a tool rebuild/rollback in progress (one at a time per bot).
   * BE-P2-22: the bot's build lock — also held by withToolBuild (vm_install), so a count. Its
   * queued runs wait while it's held and start when it's released (after the build's record).
   */
  const building = new Map<string, number>()
  const isBuilding = (agentId: string) => (building.get(agentId) ?? 0) > 0 || builds.has(agentId)
  /** BE-P2-21: whether the bot's build holds this run back (runs a vm_install build waits for are not held). */
  function heldByBuild(agentId: string, runId?: string): boolean {
    if ((building.get(agentId) ?? 0) > 0) return true
    const b = builds.get(agentId)
    return !!b && !(runId && b.waitFor.has(runId))
  }
  function lockBuild(agentId: string): void {
    building.set(agentId, (building.get(agentId) ?? 0) + 1)
    updatePositions()
  }
  function unlockBuild(agentId: string): void {
    const n = (building.get(agentId) ?? 1) - 1
    if (n > 0) building.set(agentId, n)
    else building.delete(agentId)
    void pump()
  }

  function outside(agentId: string): number {
    const n = deps.runner.activeRuns?.(agentId) ?? 0
    if (!n) return 0
    let ours = 0
    for (const id of inRunner) if (live.get(id)?.run.agentId === agentId) ours++
    return Math.max(0, n - ours)
  }

  /** Back into the queue in queuedAt order (its bot's slot was taken while it launched). */
  function requeue(l: Live): void {
    running.delete(l.run.id)
    let i = queue.findIndex((id) => {
      const o = live.get(id)?.run
      return !!o && (o.queuedAt > l.run.queuedAt || (o.queuedAt === l.run.queuedAt && o.id > l.run.id))
    })
    if (i < 0) i = queue.length
    queue.splice(i, 0, l.run.id)
    updatePositions()
  }

  function finish(l: Live, patch: Partial<ScriptRunWithReason>): void {
    flush(l)
    closeLogs(l)
    const run = l.run
    Object.assign(run, patch)
    delete run.queuePosition
    delete run.queuedReason
    run.endedAt = run.endedAt ?? now().toISOString()
    if (run.durationMs === undefined && run.startedAt) run.durationMs = Math.max(0, Date.parse(run.endedAt) - Date.parse(run.startedAt))
    const b = builds.get(run.agentId)
    if (b && b.l === l) {
      if (b.tick) clearTimeout(b.tick)
      if (b.limit) clearTimeout(b.limit)
      delete run.build?.progress
    }
    changed({ run, slug: l.slug })
    // BE-P2-21: gone before vm.updated, so VmInfo.activeBuild is cleared in it.
    if (b && b.l === l) builds.delete(run.agentId)
    live.delete(run.id)
    running.delete(run.id)
    const qi = queue.indexOf(run.id)
    if (qi >= 0) queue.splice(qi, 1)
    l.resolve(run)
    prune(run.agentId, l.slug)
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

  /** Whether the run's snapshot is still kept (its record is needed for undo). */
  function snapshotKept(slug: string, r: ScriptRunWithReason): boolean {
    if (!r.snapshot) return false
    if (!deps.undoState) return true
    const u = deps.undoState(slug, r.id)
    return u !== null && u.state !== 'unavailable'
  }

  /**
   * Past the bot's last 20 runs and 7+ days old: logs of runs without a snapshot are removed
   * (snapshot runs' logs go with their snapshot), and records too unless the run's snapshot is
   * still kept or a kept run points at it (undoOfRunId / undo.undoRunId).
   */
  function prune(agentId: string, slug: string): void {
    const cutoff = now().getTime() - LOG_KEEP_MS
    const all = runsOf(agentId)
    const old = (r: ScriptRunWithReason, i: number) => {
      if (i < LOG_KEEP_RUNS || isActive(r.status) || live.has(r.id)) return false
      const at = Date.parse(r.endedAt ?? r.queuedAt)
      return Number.isFinite(at) && at < cutoff
    }
    const keep = new Set<string>()
    all.forEach((r, i) => {
      if (!old(r, i)) keep.add(r.id)
      else if (!r.snapshot) removeLogs(slug, r.id)
      else if (snapshotKept(slug, r)) keep.add(r.id)
    })
    // Links from kept runs (an undo run names its run; an undone run names its undo run), transitively.
    const byId = new Map(all.map((r) => [r.id, r]))
    const stack = [...keep]
    while (stack.length) {
      const r = byId.get(stack.pop()!)
      for (const id of [r?.undoOfRunId, r?.undo.undoRunId]) {
        if (id && byId.has(id) && !keep.has(id)) {
          keep.add(id)
          stack.push(id)
        }
      }
    }
    for (const r of all) {
      if (keep.has(r.id)) continue
      removeLogs(slug, r.id)
      rmSync(fileOf(slug, r.id, 'json'), { force: true })
      index.delete(r.id)
    }
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
      // The bot's slot was taken while the floor was checked (e.g. an undo), or (BE-P2-22) its tools
      // started building (vm_install): wait without a machine slot.
      if (outside(run.agentId) > 0 || heldByBuild(run.agentId, run.id)) {
        requeue(l)
        void pump()
        return
      }
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
      delete run.queuedReason
      changed({ run, slug: l.slug })
      const req = requestOf(run, l)
      inRunner.add(run.id)
      const res = await deps.runner.run(req).finally(() => inRunner.delete(run.id)).catch((err: Error): RunScriptResult => ({
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
    // BE-P2-13: the proxy was down, so the online run never started.
    else if (res.reason === 'proxy_unavailable') patch.reason = res.reason
    if (res.hostsContacted) {
      patch.hostsContacted = res.hostsContacted
      if (res.hostsContactedTotal !== undefined) patch.hostsContactedTotal = res.hostsContactedTotal
    }
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
          // A machine slot is taken only once the bot's own slot is free (its run or an undo).
          // BE-P2-22: nor while its tools are building (it starts on the generation the build leaves).
          if (busy.has(l.run.agentId) || outside(l.run.agentId) > 0 || heldByBuild(l.run.agentId, l.run.id)) continue
          busy.add(l.run.agentId)
          queue.splice(queue.indexOf(id), 1)
          running.add(id)
          void track(launch(l))
        }
        startBuilds()
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

  const botName = (agentId: string) => deps.getAgent(agentId)?.name?.trim() || 'The bot'

  /** BE-P2-21: the runs a waiting build still waits for (its own runs from before it, plus an undo). */
  function buildAhead(b: BuildEntry): number {
    let n = outside(b.l.run.agentId)
    for (const id of b.waitFor) if (live.has(id)) n++
    return n
  }

  /** BE-P2-21: start each waiting build whose bot is free; update the others' positions. */
  function startBuilds(): void {
    for (const b of builds.values()) {
      if (b.started) continue
      const ahead = buildAhead(b)
      if (ahead === 0) {
        b.started = true
        void track(runBuild(b))
      } else if (b.l.run.queuePosition !== ahead) {
        b.l.run.queuePosition = ahead
        emit(b.l.run, false)
      }
    }
  }

  /** BE-P2-21: progress / hosts: run.updated at most once per BUILD_UPDATE_MS (and vm.updated on a step change). */
  function buildTick(b: BuildEntry): void {
    if (b.tick) return
    const wait = Math.max(0, b.lastEmit + BUILD_UPDATE_MS - Date.now())
    b.tick = setTimeout(() => {
      b.tick = undefined
      if (builds.get(b.l.run.agentId) !== b) return
      b.lastEmit = Date.now()
      emit(b.l.run, false)
      if (b.vmDirty) {
        b.vmDirty = false
        deps.onRunsChanged?.(b.l.run.agentId)
      }
    }, wait)
    b.tick.unref?.()
  }

  async function runBuild(b: BuildEntry): Promise<void> {
    const { l, spec } = b
    const run = l.run
    const build = run.build!
    try {
      const agent = deps.getAgent(run.agentId)
      if (!agent) return finish(l, { status: 'failed', error: 'Bot not found.' })
      if (l.controller.signal.aborted) return finish(l, { status: 'stopped', reason: BUILD_STOPPED_REASON, error: buildStoppedText(botName(run.agentId), build.fromGeneration) })
      // The generation it starts from (a queued build may have waited).
      build.fromGeneration = agent.vm.image.generation
      build.generation = build.fromGeneration + 1
      build.base = agent.vm.image.base
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
      delete run.queuedReason
      changed({ run, slug: l.slug })
      deps.onRunsChanged?.(run.agentId)
      b.limit = setTimeout(() => {
        b.timedOut = true
        l.controller.abort()
      }, deps.toolBuildTimeoutMs ?? TOOL_BUILD_TIMEOUT_MS)
      b.limit.unref?.()
      const ctl: ToolBuildControl = {
        signal: l.controller.signal,
        onOutput: (stream, chunk) => onOutput(l, stream, chunk),
        onProgress: (p) => {
          if (!live.has(run.id)) return
          const prev = build.progress
          build.progress = { step: p.step, steps: p.steps, label: p.label }
          if (!prev || prev.step !== p.step || prev.steps !== p.steps) b.vmDirty = true
          buildTick(b)
        },
        onHosts: (hosts) => {
          if (!live.has(run.id)) return
          const c = capHostContacts(hosts)
          run.hostsContacted = c.hosts
          if (c.total !== undefined) run.hostsContactedTotal = c.total
          else delete run.hostsContactedTotal
          b.vmDirty = true
          buildTick(b)
        },
      }
      log(`runs: ${l.slug}: tool build ${run.id} (version ${build.generation}) started`)
      let res: Awaited<ReturnType<ToolBuildSpec['build']>>
      try {
        res = await spec.build(ctl, agent)
      } catch (err) {
        const e = err as Error & { statusCode?: number; reason?: string; stopped?: boolean; timedOut?: boolean; buildLog?: string }
        const bot = botName(run.agentId)
        if (b.timedOut || e.timedOut) {
          return finish(l, { status: 'timed_out', error: buildTimedOutText(bot, build.fromGeneration) })
        }
        if (e.stopped || l.controller.signal.aborted) {
          return finish(l, { status: 'stopped', reason: BUILD_STOPPED_REASON, error: buildStoppedText(bot, build.fromGeneration) })
        }
        // The engine's own line goes to the log; the card shows the plain sentence.
        if (!run.outputBytes && e.buildLog) onOutput(l, 'stdout', e.buildLog.endsWith('\n') ? e.buildLog : `${e.buildLog}\n`)
        onOutput(l, 'stderr', `${e.message}\n`)
        if (e.reason === 'proxy_unavailable') return finish(l, { status: 'failed', reason: e.reason, error: e.message })
        return finish(l, { status: 'failed', reason: BUILD_FAILED_REASON, error: buildFailedText(bot, build.fromGeneration) })
      }
      if (!run.outputBytes && res.log) onOutput(l, 'stdout', res.log.endsWith('\n') ? res.log : `${res.log}\n`)
      const patch: Partial<ScriptRunWithReason> = { status: 'succeeded', exitCode: 0 }
      build.generation = res.generation
      if (res.hosts) {
        const c = capHostContacts(res.hosts)
        patch.hostsContacted = c.hosts
        const total = Math.max(res.hostsTotal ?? 0, c.total ?? 0)
        if (total > c.hosts.length) patch.hostsContactedTotal = total
      }
      finish(l, patch)
    } catch (err) {
      if (live.has(run.id)) finish(l, { status: 'failed', reason: BUILD_FAILED_REASON, error: buildFailedText(botName(run.agentId), build.fromGeneration) })
      log(`runs: tool build ${run.id} failed: ${(err as Error).message}`)
    }
  }

  /** BE-P2-21: Stop on a build: a waiting one ends at once; a running one is killed (BotEnv removes the half-built image). */
  function stopBuild(b: BuildEntry): boolean {
    if (!b.started) {
      finish(b.l, { status: 'stopped', reason: BUILD_STOPPED_REASON, error: buildStoppedText(botName(b.l.run.agentId), b.l.run.build!.fromGeneration) })
      return true
    }
    b.l.controller.abort()
    return false
  }

  // A bot's slot freed (or taken) outside RunService: start what can start, refresh positions.
  deps.runner.onSlotChange?.(() => {
    void pump()
  })

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
      const missing = deps.filesMissing?.(agent)
      if (missing) failWithReason(409, 'files_missing', missing)
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
      const spot = queueSpot(agent.id, running.size + queue.length - 1)
      run.queuePosition = spot.pos
      run.queuedReason = spot.reason
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
      const b = builds.get(l.run.agentId)
      if (b && b.l === l) {
        if (stopBuild(b)) return l.run
      } else if (queue.includes(runId)) {
        finish(l, { status: 'stopped', error: STOPPED_QUEUED_TEXT })
        return l.run
      } else l.controller.abort()
      const t = new Promise<null>((r) => setTimeout(() => r(null), 15_000).unref?.())
      return (await Promise.race([l.done, t])) ?? l.run
    },
    async stopAgent(agentId) {
      let n = 0
      for (const l of [...live.values()]) {
        if (l.run.agentId !== agentId) continue
        n++
        const b = builds.get(agentId)
        if (b && b.l === l) stopBuild(b)
        else if (queue.includes(l.run.id)) finish(l, { status: 'stopped', error: STOPPED_QUEUED_TEXT })
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
      const missing = deps.filesMissing?.(agent)
      if (missing) failWithReason(409, 'files_missing', missing)
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
    async toolBuild(agentId, action, build) {
      load()
      const agent = deps.getAgent(agentId)
      if (!agent) fail(404, 'Bot not found.')
      // BE-P2-22: a build in progress first (409 build_active), then runs (409 run_active).
      if (isBuilding(agent.id)) failWithReason(409, BUILD_ACTIVE_REASON, BUILD_ACTIVE_TEXT)
      let busy = outside(agent.id)
      for (const l of live.values()) if (l.run.agentId === agent.id) busy++
      if (busy > 0) failWithReason(409, 'run_active', "Wait for the bot's run to finish first.")
      const dm = deps.conversations().find((c) => c.kind === 'dm' && c.agentId === agent.id)
      const startedAt = now().toISOString()
      const record = (status: ScriptRunStatus, out: { log: string; error?: string; reason?: string }) => {
        const run: ScriptRunWithReason = {
          ...baseRun({ agentId: agent.id, conversationId: dm?.id ?? '', context: { kind: 'dm' }, argv: [action], cwd: 'workspace', why: TOOL_BUILD_WHY[action], kind: 'tool_build' }, agent, deps.newRunId()),
          status,
          queuedAt: startedAt,
          startedAt,
          endedAt: now().toISOString(),
          ...(status === 'succeeded' ? { exitCode: 0 } : {}),
          ...(out.error ? { error: out.error } : {}),
          ...(out.reason ? { reason: out.reason } : {}),
        }
        run.durationMs = Math.max(0, Date.parse(run.endedAt!) - Date.parse(startedAt))
        const text = Buffer.from(out.log, 'utf8')
        run.outputBytes = text.length
        run.stdoutTail = tailUtf8(out.log, 64 * 1024)
        run.outputTruncated = text.length > 64 * 1024
        createLogs(agent.slug, run.id)
        try {
          writeFileSync(fileOf(agent.slug, run.id, 'stdout.log'), text)
        } catch (err) {
          log(`runs: couldn't write the build log for ${run.id}: ${(err as Error).message}`)
        }
        changed({ run, slug: agent.slug })
        deps.onRunsChanged?.(agent.id)
        return run
      }
      // BE-P2-22: the lock is released after the record is written, so the build's record comes
      // before any run that waited for it starts (on the new generation, or the old one on failure).
      lockBuild(agent.id)
      try {
        let res: { generation: number; log: string }
        try {
          res = await build()
        } catch (err) {
          const e = err as Error & { statusCode?: number; reason?: string }
          if (e.statusCode !== undefined && e.statusCode < 500) throw err
          record('failed', { log: `${e.message}\n`, error: e.message, reason: e.reason ?? 'build_failed' })
          throw err
        }
        return record('succeeded', { log: res.log })
      } finally {
        unlockBuild(agent.id)
      }
    },
    buildActive(agentId) {
      return isBuilding(agentId)
    },
    async withToolBuild(agentId, fn) {
      lockBuild(agentId)
      try {
        return await fn()
      } finally {
        unlockBuild(agentId)
      }
    },
    async startToolBuild(spec) {
      load()
      const agent = deps.getAgent(spec.agentId)
      if (!agent) fail(404, 'Bot not found.')
      if (isBuilding(agent.id)) failWithReason(409, BUILD_ACTIVE_REASON, BUILD_ACTIVE_TEXT)
      const waitFor = new Set<string>()
      for (const l of live.values()) if (l.run.agentId === agent.id) waitFor.add(l.run.id)
      if (!spec.waitForRuns && waitFor.size + outside(agent.id) > 0) failWithReason(409, 'run_active', "Wait for the bot's run to finish first.")
      const missing = deps.filesMissing?.(agent)
      if (missing) failWithReason(409, 'files_missing', missing)
      await spec.precheck?.(agent)
      const floor = await freeFloorBlock()
      if (floor) failWithReason(409, floor.reason, floor.message)
      // Again: the awaits above let another build in.
      if (isBuilding(agent.id)) failWithReason(409, BUILD_ACTIVE_REASON, BUILD_ACTIVE_TEXT)
      const conversationId = typeof spec.conversationId === 'function' ? spec.conversationId() : spec.conversationId
      const id = deps.newRunId()
      const run = baseRun(
        { agentId: agent.id, conversationId, context: spec.context ?? { kind: 'dm' }, argv: spec.argv, cwd: 'workspace', why: TOOL_BUILD_WHY.rebuild, kind: 'tool_build', network: spec.network, ...(spec.agentRunId ? { agentRunId: spec.agentRunId } : {}) },
        agent,
        id,
      )
      run.permissions = spec.permissions.map((p) => ({ ...p }))
      run.build = {
        generation: agent.vm.image.generation + 1,
        fromGeneration: agent.vm.image.generation,
        packages: [...spec.packages],
        added: [...spec.added],
        ...(spec.removed?.length ? { removed: [...spec.removed] } : {}),
        startedBy: spec.startedBy,
        via: spec.via,
        base: agent.vm.image.base,
      }
      const l = newLive(run, agent.slug)
      const b: BuildEntry = { l, spec, waitFor, started: false, timedOut: false, lastEmit: 0, vmDirty: false }
      createLogs(agent.slug, id)
      live.set(id, l)
      builds.set(agent.id, b)
      const ahead = buildAhead(b)
      if (ahead > 0) {
        run.queuePosition = ahead
        run.queuedReason = 'slot'
      }
      changed({ run, slug: agent.slug })
      log(`runs: ${agent.slug}: tool build ${id} recorded (${spec.via}, ${ahead ? `waits for ${ahead} run(s)` : 'starting'})`)
      // Queued runs of the bot now wait for it ("Queued · after tool build").
      updatePositions()
      deps.onRunsChanged?.(agent.id)
      await pump()
      return run
    },
    activeBuild(agentId) {
      const b = builds.get(agentId)
      const run = b?.l.run
      const build = run?.build
      if (!run || !build || !isActive(run.status)) return null
      return {
        runId: run.id,
        status: run.status === 'running' ? 'running' : run.status === 'waiting_permission' ? 'waiting_permission' : 'queued',
        ...(run.startedAt ? { startedAt: run.startedAt } : {}),
        build: { ...build },
        internet: internetOf(run),
        hosts: reachedHosts(run.hostsContacted ?? []),
      }
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
        delete full.queuedReason
        // BE-P2-21: a build left by a restart keeps its generation (BotEnv saves only on success).
        if (full.build) delete full.build.progress
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
      // Old records and logs of every bot (a bot that never runs again is pruned here only).
      const bots = new Map<string, string>()
      for (const e of index.values()) bots.set(e.run.agentId, e.slug)
      for (const [agentId, slug] of bots) prune(agentId, slug)
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
