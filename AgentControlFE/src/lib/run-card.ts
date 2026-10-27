/*
 * FE-P2-2: the run card's logic (PHASE2_PLAN §7.1, §7.4, §12 v2; mockup a-run-cards).
 * Pure: a ChatRunSummary and/or ScriptRun → what the card shows. The markup lives in
 * run-card-render.ts (createElement, so tests can render it); RunCard.tsx wires it to the live store.
 * tests/run-card.test.mjs.
 *
 * Mockup (a) has three states: succeeded, failed, running. Everything else follows those patterns
 * and is a GAP (listed in RUN_CARD_GAPS).
 */
import { humanSize } from './file-format.ts'
import { isActiveStatus, scriptName } from './live-store.ts'
import { VM_LIMITS, type ChatRunSummary, type FileChange, type ScriptRun, type ScriptRunKind, type ScriptRunStatus } from './types.ts'
import { undoGoneText, undoReasonText, type UndoReasonContext } from './undo.ts'

export const RUN_CARD_GAPS = {
  queued: 'GAP-R1: queued, with its place in line ("Queued · 2 ahead")',
  timedOut: 'GAP-R2: timed out (failed-card pattern, "Timed out · 10 min")',
  stopped: 'GAP-R3: stopped (grey pill, files kept and undoable)',
  denied: 'GAP-R4: denied (failed-card pattern; M2 only)',
  undone: 'GAP-R5: undone (grey "Undone" pill + "Undone at …" note)',
  toolBuild: 'GAP-R6: tool-build card ("⚙ Tool build" pill, no Undo)',
  undoRun: 'GAP-R7: undo-of-a-run card ("↶ Undo" pill, "undo of <name>")',
  tooLarge: 'GAP-R8: too-large output note (outputTruncated)',
  runtime: 'GAP-R9: runtime label placement (last item of the meta line)',
  group: 'GAP-R10: group placement (author line above the card, like a reply)',
  fullOutput: 'GAP-R11: "Full output" opens a dialog with stdout and stderr',
  narrow: 'GAP-R12: 390 px layout (source hidden, files and actions wrap)',
  loading: 'GAP-R13: details still loading / failed to load',
  waiting: 'GAP-R14: waiting for permission (M2 only; not reachable in M1)',
  collapsed: 'GAP-R15: finished cards start collapsed (head from the message summary; the run loads on expand, contract 146cd18)',
  groupFile: 'GAP-R16: a group-folder file row names the folder ("TL-1 Launch Room group folder")',
} as const

export type RunTone = 'ok' | 'bad' | 'run' | 'undone'

export type RunMetaItem = { key: string; label: string; value: string; suffix?: string }
export type RunFileRow = { key: string; change: FileChange['change']; path: string; size: string | null; folder: string | null }
export type RunLog = { text: string; error: boolean; live: boolean }
export type RunActions = {
  stop: boolean
  undo: boolean
  output: boolean
}

export type RunCardView = {
  kind: ScriptRunKind
  pill: string
  pillIcon: string
  name: string
  source: string | null
  status: ScriptRunStatus
  tone: RunTone
  statusText: string
  /** The same without the ticking clock, for the screen-reader status line. */
  statusLabel: string
  spinner: boolean
  /** Red border (mockup's failed card). */
  bad: boolean
  /** Running bar under the head. */
  progress: boolean
  active: boolean
  command: string | null
  meta: RunMetaItem[]
  files: RunFileRow[]
  moreFiles: number
  /** run.error, when it isn't already the log box's text. */
  error: string | null
  log: RunLog | null
  truncated: string | null
  actions: RunActions
  note: string | null
  /** Note left, buttons right (failed card); else buttons left, note right. */
  noteFirst: boolean
  /** Full run not loaded yet: head only + a skeleton (or the load error). */
  loading: boolean
}

export type RunCardInput = {
  /** The message's summary, live-updated from run.updated by messageId. */
  summary?: ChatRunSummary
  /** GET /api/runs/:id (or the live store's copy). */
  run?: ScriptRun
  /** Live output from run.output; falls back to the run's tails. */
  output?: { stdout: string; stderr: string }
  now?: number
  /** For kind 'undo': the undone run's name. */
  undoOfName?: string
  /** groupId → name, when a group FileChange has no groupName. */
  groupNames?: Readonly<Record<string, string>>
} & UndoReasonContext

export const FILES_SHOWN = 5
const LOG_LINES = 6

/* ---- formatting ---- */

/** "4.2 s", "38 s", "2 min 5 s", "10 min". */
export function durationText(ms: number | undefined): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null
  const s = ms / 1000
  if (s < 10) return `${(Math.round(s * 10) / 10).toFixed(1)} s`
  if (s < 60) return `${Math.round(s)} s`
  const whole = Math.round(s)
  const m = Math.floor(whole / 60)
  const rest = whole % 60
  return rest ? `${m} min ${rest} s` : `${m} min`
}

/** Elapsed clock for a running card: "0:07", "12:40", "1:02:03". */
export function clockText(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

/** "212 MB", "1.5 GB". */
export function memoryText(mb: number): string {
  if (mb < 1024) return `${Math.round(mb)} MB`
  const gb = Math.round((mb / 1024) * 10) / 10
  return `${String(gb)} GB`
}

/** §12 v2: "gVisor" for runsc, "standard runtime" otherwise. */
export function runtimeLabel(runtime: ScriptRun['runtime']): string | null {
  if (!runtime) return null
  return runtime === 'runsc' ? 'gVisor' : 'standard runtime'
}

/** "10 min" from the 600 s limit. */
export function limitText(sec: number = VM_LIMITS.timeoutSec): string {
  return durationText(sec * 1000) ?? `${sec} s`
}

const SAFE_ARG = /^[\w@%+=:,./-]+$/
/** argv → a copyable command line ("$ python skills/x.py 'a b'"). */
export function commandLine(argv: readonly string[]): string {
  return argv.map((a) => (a === '' ? "''" : SAFE_ARG.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ')
}

/** The last `n` non-empty-trailing lines of some output. */
export function tailLines(text: string, n: number = LOG_LINES): string {
  const lines = text.replace(/\s+$/, '').split('\n')
  return lines.slice(-n).join('\n')
}

const durationOf = (run: ScriptRun | undefined): number | undefined => {
  if (!run) return undefined
  if (run.durationMs !== undefined) return run.durationMs
  if (run.startedAt && run.endedAt) {
    const d = Date.parse(run.endedAt) - Date.parse(run.startedAt)
    return Number.isFinite(d) ? d : undefined
  }
  return undefined
}

/* ---- status ---- */

export function statusTone(status: ScriptRunStatus): RunTone {
  switch (status) {
    case 'succeeded':
      return 'ok'
    case 'failed':
    case 'timed_out':
    case 'denied':
      return 'bad'
    case 'queued':
    case 'waiting_permission':
    case 'running':
      return 'run'
    default:
      return 'undone'
  }
}

/** The pill's text: "Succeeded · 4.2 s", "Failed · exit 1 · 1.1 s", "Running · 0:07", "Queued · 2 ahead". */
export function statusText(
  status: ScriptRunStatus,
  info: { exitCode?: number; queuePosition?: number; durationMs?: number; elapsedMs?: number },
  withClock = true,
): string {
  const dur = durationText(info.durationMs)
  const join = (...parts: (string | null | undefined | false)[]) => parts.filter(Boolean).join(' · ')
  switch (status) {
    case 'queued': {
      const q = info.queuePosition
      return join('Queued', q === undefined ? null : q <= 0 ? 'next' : `${q} ahead`)
    }
    case 'waiting_permission':
      return 'Waiting for permission'
    case 'running':
      return withClock && info.elapsedMs !== undefined ? join('Running', clockText(info.elapsedMs)) : 'Running'
    case 'succeeded':
      return join('Succeeded', dur)
    case 'failed':
      return join('Failed', info.exitCode !== undefined && `exit ${info.exitCode}`, dur)
    case 'timed_out':
      return join('Timed out', dur)
    case 'stopped':
      return join('Stopped', dur)
    case 'denied':
      return 'Denied'
    case 'undone':
      return 'Undone'
    default:
      return 'Run'
  }
}

/* ---- the card ---- */

const PILLS: Record<ScriptRunKind, { pill: string; icon: string }> = {
  script: { pill: 'Script', icon: '▶' },
  tool_build: { pill: 'Tool build', icon: '⚙' },
  undo: { pill: 'Undo', icon: '↶' },
}

function nameOf(input: RunCardInput): string {
  const { run, summary } = input
  const kind = run?.kind ?? summary?.kind ?? 'script'
  if (kind === 'undo') return `undo of ${input.undoOfName ?? 'a run'}`
  if (run?.argv.length && (kind === 'tool_build' || run.skillId)) return scriptName(run)
  // BE 146cd18: scriptName is the card title; name stays the skill's display name.
  if (summary?.scriptName) return summary.scriptName
  if (kind === 'tool_build') return summary?.name ?? 'tools'
  return summary?.name ?? (run ? scriptName(run) : 'script')
}

/** Mockup: the skill ("csv-tools") or the folder it ran in ("workspace"). The summary's name is the skill's display name. */
function sourceOf(input: RunCardInput, name: string): string | null {
  const { run, summary } = input
  const kind = run?.kind ?? summary?.kind
  if (kind !== 'script') return null
  if (!run) return summary?.scriptName && summary.name && summary.name !== name ? summary.name : null
  if (run.skillId) return summary && summary.name !== name ? summary.name : run.skillId
  return run.cwd || null
}

/** A group-scoped file's folder ("TL-1 Launch Room group folder"); the bot's own files have none. */
export function fileFolder(f: Pick<FileChange, 'root' | 'groupId' | 'groupName'>, groupNames?: Readonly<Record<string, string>>): string | null {
  if (f.root !== 'group') return null
  const name = f.groupName || (f.groupId ? groupNames?.[f.groupId] : undefined)
  return name ? `${name} group folder` : 'group folder'
}

/** BE 3a70c34: `path` is relative to its root's folder, with no prefix; it's shown as is. */
function fileRows(files: readonly FileChange[], groupNames?: Readonly<Record<string, string>>): RunFileRow[] {
  return files.map((f, i) => ({
    key: `${i}:${f.root ?? 'agent'}:${f.groupId ?? ''}:${f.path}`,
    change: f.change,
    path: f.path,
    size: f.change === 'deleted' ? null : humanSize(f.bytes),
    folder: fileFolder(f, groupNames),
  }))
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

function internetNote(run: ScriptRun): string {
  if (run.network !== 'on') return 'Internet off'
  const grant = run.permissions.find((p) => p.type === 'internet')
  if (grant?.decision === 'allow_once') return 'Internet on (allowed once)'
  if (grant?.decision === 'always' || grant?.decision === 'enable') return 'Internet on (always allowed)'
  return 'Internet on'
}

function hm(iso: string | undefined): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const h = d.getHours()
  return `${h % 12 === 0 ? 12 : h % 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
}

/** The undo line when the run can't be undone: "Undo no longer available: <reason>." (§12 v2, §7.4). */
export function undoUnavailableText(undo: ScriptRun['undo'], ctx: UndoReasonContext): string | null {
  if (undo.state !== 'unavailable') return null
  if (!undo.reason) return 'Undo no longer available.'
  // §7.4: too_large never had a snapshot, so it isn't "no longer" available.
  if (undo.reason === 'too_large') return `Undo isn't available for this run: ${undoReasonText('too_large', { ...ctx, changedBytes: undo.changedBytes ?? ctx.changedBytes })}.`
  return undoGoneText(undo.reason, ctx)
}

export function runCardView(input: RunCardInput): RunCardView {
  const { run, summary } = input
  const now = input.now ?? Date.now()
  const kind: ScriptRunKind = run?.kind ?? summary?.kind ?? 'script'
  const undo = run?.undo ?? summary?.undo ?? { state: 'unavailable' as const }
  let status: ScriptRunStatus = run?.status ?? summary?.status ?? 'queued'
  if (undo.state === 'done' && !isActiveStatus(status)) status = 'undone'
  const active = isActiveStatus(status)
  const name = nameOf(input)
  const durationMs = durationOf(run) ?? summary?.durationMs
  const elapsedMs = run?.startedAt ? now - Date.parse(run.startedAt) : undefined
  const info = {
    exitCode: run?.exitCode ?? summary?.exitCode,
    queuePosition: run?.queuePosition ?? summary?.queuePosition,
    durationMs,
    elapsedMs: elapsedMs !== undefined && Number.isFinite(elapsedMs) ? elapsedMs : undefined,
  }
  const tone = statusTone(status)
  const base = {
    kind,
    pill: PILLS[kind].pill,
    pillIcon: PILLS[kind].icon,
    name,
    source: sourceOf(input, name),
    status,
    tone,
    statusText: statusText(status, info),
    statusLabel: statusText(status, info, false),
    spinner: status === 'running',
    bad: status === 'failed' || status === 'timed_out' || status === 'denied',
    progress: status === 'running',
    active,
  }

  if (!run) {
    return {
      ...base, command: null, meta: [], files: [], moreFiles: 0, error: null, log: null, truncated: null,
      actions: { stop: active, undo: false, output: false }, note: null, noteFirst: false, loading: true,
    }
  }

  const command = run.argv.length ? `$ ${commandLine(run.argv)}` : run.script ? `$ ${tailLines(run.script, 1)}` : null

  // Meta line (mockup's succeeded card): Exit · Internet · Peak memory · Snapshot · runtime (§12 v2, GAP-R9).
  // The failed card in mockup (a) has no meta line, and an active run's isn't known yet.
  const meta: RunMetaItem[] = []
  if (!active && !base.bad) {
    if (run.exitCode !== undefined) meta.push({ key: 'exit', label: 'Exit', value: String(run.exitCode) })
    meta.push({ key: 'net', label: 'Internet', value: run.network === 'on' ? 'on' : 'off' })
    if (run.peakMemoryMb !== undefined) meta.push({ key: 'mem', label: 'Peak memory', value: memoryText(run.peakMemoryMb), suffix: `of ${memoryText(VM_LIMITS.memoryMb)}` })
    if (run.snapshot) meta.push({ key: 'snap', label: 'Snapshot', value: run.snapshot.id })
    const rt = runtimeLabel(run.runtime)
    if (rt) meta.push({ key: 'rt', label: 'Runtime', value: rt })
  }

  const allFiles = active ? [] : fileRows(run.filesChanged, input.groupNames)
  const files = allFiles.slice(0, FILES_SHOWN)
  const moreFiles = allFiles.length - files.length

  // Log: live tail while active; stdout when it worked; stderr (or the error) in red when it didn't.
  const out = input.output ?? { stdout: run.stdoutTail, stderr: run.stderrTail }
  const stdout = out.stdout.trim() ? tailLines(out.stdout) : ''
  const stderr = out.stderr.trim() ? tailLines(out.stderr) : ''
  const errText = run.error?.trim() || null
  let log: RunLog | null = null
  let error: string | null = null
  if (active) {
    const both = [out.stdout, out.stderr].filter((s) => s.trim()).join('\n')
    log = both ? { text: tailLines(both), error: false, live: status === 'running' } : null
  } else if (base.bad) {
    if (stderr) {
      log = { text: stderr, error: true, live: false }
      error = errText
    } else if (errText) {
      log = { text: errText, error: true, live: false }
    } else if (stdout) {
      log = { text: stdout, error: false, live: false }
    }
  } else {
    log = stdout ? { text: stdout, error: false, live: false } : stderr ? { text: stderr, error: false, live: false } : null
    error = errText
  }

  const truncated = run.outputTruncated ? `Output passed the ${VM_LIMITS.outputMb} MB limit; the rest wasn't kept.` : null

  // Actions and the note.
  const changed = run.filesChanged.length
  let note: string | null
  let noteFirst = false
  const actions: RunActions = { stop: active, undo: false, output: !active }
  if (active) {
    note = status === 'queued' ? `Starts when the machine is free · limit ${limitText()}` : `${internetNote(run)} · limit ${limitText()}`
  } else if (status === 'undone') {
    const at = hm(undo.at)
    note = at ? `Undone at ${at}` : 'Undone'
    noteFirst = true
  } else if (kind === 'tool_build') {
    note = "Undo doesn't cover installed tools"
    noteFirst = true
  } else if (undo.state === 'unavailable' && undo.reason) {
    note = undoUnavailableText(undo, input)
    noteFirst = true
  } else if (changed === 0) {
    note = 'No files changed · nothing to undo'
    noteFirst = true
  } else if (undo.state === 'available') {
    actions.undo = true
    note = `Undo restores the ${changed === 1 ? 'file' : plural(changed, 'file')} above`
  } else {
    note = undoUnavailableText(undo, input)
    noteFirst = true
  }

  return { ...base, command, meta, files, moreFiles, error, log, truncated, actions, note, noteFirst, loading: false }
}

/** One-line label for the card region ("Script run clean_sales.py: Succeeded · 4.2 s"). */
export function runCardLabel(v: Pick<RunCardView, 'pill' | 'name' | 'statusLabel'>): string {
  return `${v.pill} run ${v.name}: ${v.statusLabel}`
}

/** Stop errors: 409 means it already ended (the card refreshes); anything else is shown. */
export function stopErrorText(err: unknown): string | null {
  const status = (err as { status?: unknown } | null)?.status
  if (status === 409) return null
  const msg = err instanceof Error && err.message ? err.message : ''
  return /fetch|network/i.test(msg) || !msg ? "Couldn't stop the run: could not reach the API server." : `Couldn't stop the run: ${msg}`
}

/** Full-output dialog: 404/410 mean the log is gone (§7.1 output eviction). */
export function outputErrorText(err: unknown): string {
  const status = (err as { status?: unknown } | null)?.status
  if (status === 410 || status === 404) return "The full output was removed to free space. The card shows the last lines it kept."
  return "Couldn't load the full output."
}
