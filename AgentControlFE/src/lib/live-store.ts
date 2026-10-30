/*
 * FE-P2-1: the client-side store for Phase 2 live data: script runs (and their live
 * output), run-card summaries by chat message, bot VM info and permission requests.
 * Pure reducer + selectors; tests/live-store.test.mjs. The React side is
 * state/LiveProvider.tsx (via live-controller.ts).
 *
 * Rules:
 * - Events and fetched snapshots both go through mergeRun, which never lets an older
 *   lifecycle step (e.g. a stale "running" fetch) replace a newer one ("succeeded").
 * - run.updated with a messageId keeps that chat message's card summary in step
 *   (the message itself still arrives through the existing messages fetch).
 * - A run's live output is its stdout/stderr tail plus run.output chunks, capped at 64 KB.
 * - resyncPlan: what to re-fetch on every (re)connect and on `event: reset` (M1: SSE only).
 */
import {
  CHAT_RUN_HOSTS_MAX, SCRIPT_RUN_ACTIVE,
  type BrowserAddonInfo, type ChatMessage, type ChatRunSummary, type FileChange, type LiveEvent, type PermissionRequest, type ScriptRun,
  type ScriptRunStatus, type ScriptRunSummary, type VmInfo,
} from './types.ts'
import type { LiveConnectionStatus } from './live-events.ts'

/** Same as the BE's kept tail per stream. */
export const OUTPUT_TAIL_CHARS = 64 * 1024
/** VmInfo.runs holds at most this many (older via GET /api/agents/:id/script-runs?before=). */
export const VM_RUNS_MAX = 50

export type RunOutput = { stdout: string; stderr: string }

export type LiveState = {
  connection: LiveConnectionStatus | 'idle'
  runs: Record<string, ScriptRun>
  output: Record<string, RunOutput>
  /** By ChatMessage id (kind 'run'). */
  summaries: Record<string, ChatRunSummary>
  vms: Record<string, VmInfo>
  permissions: Record<string, PermissionRequest>
  /** Bumped on every `event: reset`, so views holding their own copies (thread pages) can re-fetch. */
  resets: number
  /**
   * FE-P2-3: server clock minus this browser's clock (ms), from PermissionListResponse.now (contract fec4670),
   * so a card's countdown from expiresAt ignores clock skew. 0 until a list carried `now`.
   */
  clockSkewMs: number
  /** FE-P2-3: the shared Chromium download (browser.updated, GET /api/vm/browser), for a setup card's live progress. */
  browser?: BrowserAddonInfo
}

export const initialLiveState: LiveState = { connection: 'idle', runs: {}, output: {}, summaries: {}, vms: {}, permissions: {}, resets: 0, clockSkewMs: 0 }

export type LiveAction =
  | { type: 'connection'; status: LiveConnectionStatus }
  | { type: 'event'; event: LiveEvent }
  /** A run fetched over REST (GET /api/runs/:id, a stop/undo/rebuild response). */
  | { type: 'run'; run: ScriptRun }
  | { type: 'vm'; vm: VmInfo }
  /** GET /api/permissions?status=pending: the full pending list (unfiltered). `skewMs`: from the list's `now`. */
  | { type: 'pending'; requests: PermissionRequest[]; skewMs?: number }
  /** FE-P2-3: requests from GET /api/permissions/:id, an answer's reply or its 409 body (any status). */
  | { type: 'permissions'; requests: PermissionRequest[] }
  /** FE-P2-3: GET /api/vm/browser or a retry's reply. */
  | { type: 'browser'; browser: BrowserAddonInfo }
  | { type: 'reset' }

/* ---------- status helpers ---------- */

export function isActiveStatus(status: ScriptRunStatus): boolean {
  return SCRIPT_RUN_ACTIVE.includes(status)
}

/** Lifecycle order: queued < waiting_permission < running < ended < undone. */
export function statusRank(status: ScriptRunStatus): number {
  switch (status) {
    case 'queued':
      return 0
    case 'waiting_permission':
      return 1
    case 'running':
      return 2
    case 'undone':
      return 4
    default:
      return 3
  }
}

/** The newer of two copies of one run; equal steps take `next` (undo state, tails and counts move on). */
export function mergeRun(prev: ScriptRun | undefined, next: ScriptRun): ScriptRun {
  if (!prev) return next
  return statusRank(next.status) < statusRank(prev.status) ? prev : next
}

export function fileCounts(files: readonly FileChange[]): ChatRunSummary['files'] {
  const out = { added: 0, modified: 0, deleted: 0 }
  for (const f of files) if (f.change in out) out[f.change] += 1
  return out
}

/** The BE's card name rule, minus the skill lookup: the script's file name (argv[1] or argv[0]), else "script". */
export function scriptName(run: Pick<ScriptRun, 'argv'>): string {
  const pick = run.argv[1] ?? run.argv[0]
  if (!pick) return 'script'
  const base = pick.replace(/\/+$/, '').split('/').pop()
  return base || 'script'
}

/** A card summary from a fetched run; the name stays the server's when we already have one (it knows skill names). */
export function summaryFromRun(run: ScriptRun, prev?: ChatRunSummary): ChatRunSummary {
  return {
    status: run.status,
    kind: run.kind,
    name: prev?.name ?? scriptName(run),
    files: fileCounts(run.filesChanged),
    undo: run.undo,
    ...(run.queuePosition !== undefined ? { queuePosition: run.queuePosition } : {}),
    ...(run.exitCode !== undefined ? { exitCode: run.exitCode } : {}),
    ...m2Summary(run, prev),
  }
}

/**
 * M2 contract (fec4670): the ChatRunSummary fields a card draws from the message alone. queuedReason/afterBuild
 * aren't on ScriptRun (BE-P2-22's), so they stay the server's while the run is still queued; internet stays the
 * server's (the run only carries grants).
 */
function m2Summary(run: ScriptRun, prev?: ChatRunSummary): Partial<ChatRunSummary> {
  const out: Partial<ChatRunSummary> = { network: run.network, browser: run.browser }
  if (run.startedAt !== undefined) out.startedAt = run.startedAt
  if (run.durationMs !== undefined) out.durationMs = run.durationMs
  if (run.status === 'waiting_permission' && run.waitingFor !== undefined) out.waitingFor = run.waitingFor
  if (run.reason !== undefined) out.reason = run.reason
  if (run.error !== undefined) out.error = run.error
  if (run.build !== undefined) out.build = run.build
  if (run.hostsContacted?.length) {
    out.hostsContacted = run.hostsContacted.slice(0, CHAT_RUN_HOSTS_MAX)
    const total = Math.max(run.hostsContactedTotal ?? 0, run.hostsContacted.length)
    if (total > out.hostsContacted.length) out.hostsContactedTotal = total
  }
  if (prev?.internet !== undefined) out.internet = prev.internet
  if (run.status === 'queued') {
    if (prev?.queuedReason !== undefined) out.queuedReason = prev.queuedReason
    if (prev?.afterBuild !== undefined) out.afterBuild = prev.afterBuild
  }
  return out
}

/** The VM tab's history row for a run. */
export function runSummaryRow(run: ScriptRun): ScriptRunSummary {
  const row: ScriptRunSummary = {
    id: run.id, agentId: run.agentId, conversationId: run.conversationId, kind: run.kind, argv: run.argv, status: run.status,
    queuedAt: run.queuedAt, runtime: run.runtime, undo: run.undo, filesChangedCount: run.filesChanged.length,
  }
  if (run.why !== undefined) row.why = run.why
  if (run.exitCode !== undefined) row.exitCode = run.exitCode
  if (run.startedAt !== undefined) row.startedAt = run.startedAt
  if (run.endedAt !== undefined) row.endedAt = run.endedAt
  if (run.durationMs !== undefined) row.durationMs = run.durationMs
  if (run.undoOfRunId !== undefined) row.undoOfRunId = run.undoOfRunId
  if (run.groupId !== undefined) row.groupId = run.groupId
  return row
}

/** Upsert a row into a newest-first history (by queuedAt), capped at VM_RUNS_MAX. */
export function upsertRunRow(rows: readonly ScriptRunSummary[], row: ScriptRunSummary): ScriptRunSummary[] {
  const rest = rows.filter((r) => r.id !== row.id)
  const at = rest.findIndex((r) => r.queuedAt < row.queuedAt)
  const next = at === -1 ? [...rest, row] : [...rest.slice(0, at), row, ...rest.slice(at)]
  return next.slice(0, VM_RUNS_MAX)
}

const tail = (s: string) => (s.length > OUTPUT_TAIL_CHARS ? s.slice(s.length - OUTPUT_TAIL_CHARS) : s)

/** A run copy's output vs what chunks built: an ended run's tails are final; else the longer one wins. */
function outputAfterRun(prev: RunOutput | undefined, run: ScriptRun): RunOutput {
  const fromRun = { stdout: tail(run.stdoutTail ?? ''), stderr: tail(run.stderrTail ?? '') }
  if (!prev || !isActiveStatus(run.status)) return fromRun
  return {
    stdout: fromRun.stdout.length >= prev.stdout.length ? fromRun.stdout : prev.stdout,
    stderr: fromRun.stderr.length >= prev.stderr.length ? fromRun.stderr : prev.stderr,
  }
}

const PERMISSION_STATUS = { allow_once: 'allowed_once', always: 'always', enable: 'enabled', deny: 'denied', timeout: 'timeout' } as const

/** A fetched run also tells us how its permission requests ended. */
function permissionsAfterRun(perms: Record<string, PermissionRequest>, run: ScriptRun): Record<string, PermissionRequest> {
  let next = perms
  for (const p of run.permissions ?? []) {
    // fec4670: requestId is absent for grants without a card (policy Always, a Rebuild click).
    const known = p.requestId ? perms[p.requestId] : undefined
    if (!p.requestId || !known || known.status !== 'pending' || p.decision === 'pending') continue
    if (next === perms) next = { ...perms }
    next[p.requestId] = { ...known, status: PERMISSION_STATUS[p.decision] }
  }
  return next
}

/**
 * The server's pending list is the truth: listed requests are stored (a resolved copy we
 * already hold is kept, since the list can be older than a resolved event), and requests we
 * held as pending that aren't listed any more are dropped (resolved while we were away; the
 * decision isn't in the list, and a fetch of the run or a resolved event fills it in).
 */
function permissionsAfterList(perms: Record<string, PermissionRequest>, pending: PermissionRequest[]): Record<string, PermissionRequest> {
  const listed = new Set(pending.map((p) => p.id))
  const next: Record<string, PermissionRequest> = {}
  for (const [id, p] of Object.entries(perms)) if (p.status !== 'pending' || listed.has(id)) next[id] = p
  for (const p of pending) if (!next[p.id] || next[p.id].status === 'pending') next[p.id] = p
  return next
}

/** A request we hold that's resolved is never reopened by an older pending copy; otherwise the incoming one wins. */
function putPermission(perms: Record<string, PermissionRequest>, req: PermissionRequest): Record<string, PermissionRequest> {
  const prev = perms[req.id]
  if (prev && prev.status !== 'pending' && req.status === 'pending') return perms
  return { ...perms, [req.id]: req }
}

function applyRun(state: LiveState, incoming: ScriptRun, messageId?: string, summary?: ChatRunSummary): LiveState {
  const prev = state.runs[incoming.id]
  const run = mergeRun(prev, incoming)
  const stale = run !== incoming
  const next: LiveState = { ...state, runs: { ...state.runs, [run.id]: run } }
  if (!stale) next.output = { ...state.output, [run.id]: outputAfterRun(state.output[run.id], run) }
  const msgId = messageId ?? run.messageId
  if (msgId && !stale) {
    next.summaries = { ...state.summaries, [msgId]: summary ?? summaryFromRun(run, state.summaries[msgId]) }
  }
  const vm = state.vms[run.agentId]
  if (vm && !stale) next.vms = { ...state.vms, [run.agentId]: { ...vm, runs: upsertRunRow(vm.runs, runSummaryRow(run)) } }
  if (!stale) next.permissions = permissionsAfterRun(state.permissions, run)
  return next
}

export function liveReducer(state: LiveState, action: LiveAction): LiveState {
  switch (action.type) {
    case 'connection':
      return state.connection === action.status ? state : { ...state, connection: action.status }
    case 'reset':
      return { ...state, resets: state.resets + 1 }
    case 'run':
      return applyRun(state, action.run)
    case 'vm':
      return { ...state, vms: { ...state.vms, [action.vm.agentId]: action.vm } }
    case 'pending': {
      const next: LiveState = { ...state, permissions: permissionsAfterList(state.permissions, action.requests) }
      if (typeof action.skewMs === 'number' && Number.isFinite(action.skewMs)) next.clockSkewMs = action.skewMs
      return next
    }
    case 'permissions': {
      let perms = state.permissions
      for (const r of action.requests) perms = putPermission(perms, r)
      return perms === state.permissions ? state : { ...state, permissions: perms }
    }
    case 'browser':
      return { ...state, browser: action.browser }
    case 'event': {
      const ev = action.event
      switch (ev.type) {
        case 'run.updated':
          return applyRun(state, ev.run, ev.messageId, ev.summary)
        case 'run.output': {
          const run = state.runs[ev.runId]
          const prev = state.output[ev.runId] ?? { stdout: tail(run?.stdoutTail ?? ''), stderr: tail(run?.stderrTail ?? '') }
          return { ...state, output: { ...state.output, [ev.runId]: { ...prev, [ev.stream]: tail(prev[ev.stream] + ev.chunk) } } }
        }
        case 'permission.requested':
        case 'permission.resolved':
        case 'permission.updated': {
          // A late "requested" never reopens a resolved request; "updated" (fec4670) carries a resolved
          // browser card's new setup / setupError snapshot.
          const perms = putPermission(state.permissions, ev.request)
          return perms === state.permissions ? state : { ...state, permissions: perms }
        }
        case 'browser.updated':
          return { ...state, browser: ev.browser }
        case 'vm.updated':
          return { ...state, vms: { ...state.vms, [ev.agentId]: ev.vm } }
        default:
          return state
      }
    }
  }
}

/* ---------- selectors ---------- */

/** A run card's summary: the live one when we have it, else the message's own copy. */
export function runSummaryFor(state: LiveState, message: Pick<ChatMessage, 'id' | 'scriptRun'>): ChatRunSummary | undefined {
  return state.summaries[message.id] ?? message.scriptRun
}

export function runOutput(state: LiveState, runId: string): RunOutput | undefined {
  return state.output[runId]
}

/** FE-P2-3: a chat card's request. */
export function permissionFor(state: LiveState, requestId: string | undefined): PermissionRequest | undefined {
  return requestId ? state.permissions[requestId] : undefined
}

export function pendingPermissions(state: LiveState, conversationId?: string): PermissionRequest[] {
  return Object.values(state.permissions)
    .filter((p) => p.status === 'pending' && (!conversationId || p.conversationId === conversationId))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

export type ResyncPlan = { runIds: string[]; agentIds: string[] }

/**
 * What to re-fetch after a (re)connect or a reset (Team lead: SSE only, re-fetch on reconnect):
 * - every run we hold that is still active (queued, waiting_permission, running), plus
 *   `extraRunIds` (active runs a view knows of from a message's scriptRun but hasn't loaded);
 * - the VM info of every bot we hold (that also lists new runs, newest first).
 * Pending permission requests are always re-fetched as one list (GET /api/permissions?status=pending).
 */
export function resyncPlan(state: LiveState, extraRunIds: Iterable<string> = []): ResyncPlan {
  const runIds = new Set<string>()
  for (const r of Object.values(state.runs)) if (isActiveStatus(r.status)) runIds.add(r.id)
  for (const id of extraRunIds) {
    const known = state.runs[id]
    if (!known || isActiveStatus(known.status)) runIds.add(id)
  }
  return { runIds: [...runIds].sort(), agentIds: Object.keys(state.vms).sort() }
}
