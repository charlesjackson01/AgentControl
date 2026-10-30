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
import {
  VM_LIMITS, type ChatRunSummary, type FileChange, type HostBlockReason, type HostContact, type InternetUse, type M2RunReason,
  type QueuedReason, type RunWaitingFor, type ScriptRun, type ScriptRunKind, type ScriptRunStatus, type ToolBuildInfo,
} from './types.ts'
import { undoGoneText, undoReasonText, type UndoReasonContext } from './undo.ts'

export const RUN_CARD_GAPS = {
  queued: 'GAP-R1: queued, with its place in line ("Queued · 2 ahead")',
  timedOut: 'GAP-R2: timed out (failed-card pattern, "Timed out · 10 min")',
  stopped: 'GAP-R3: stopped (grey pill, files kept and undoable)',
  denied: 'GAP-R4: denied (failed-card pattern; M2 only)',
  undone: 'GAP-R5: undone (grey "Undone" pill + "Undone at …" note)',
  toolBuild: 'GAP-R6: tool-build card ("⚙ Tool build" pill, no Undo)',
  undoRun: 'GAP-R7: undo-of-a-run card ("↶ Undo" pill, "Undo of <name>", collapsed or expanded)',
  tooLarge: 'GAP-R8: too-large output note (outputTruncated)',
  runtime: 'GAP-R9: runtime label placement (last item of the meta line)',
  group: 'GAP-R10: group placement (author line above the card, like a reply)',
  fullOutput: 'GAP-R11: "Full output" opens a dialog with stdout and stderr',
  narrow: 'GAP-R12: 390 px layout (source hidden, files and actions wrap)',
  loading: 'GAP-R13: details still loading / failed to load',
  waiting: 'GAP-R14: waiting for permission (M2 only; not reachable in M1)',
  collapsed: 'GAP-R15: finished cards start collapsed (head from the message summary; the run loads on expand, contract 146cd18)',
  groupFile: 'GAP-R16: a group-folder file row names the folder ("TL-1 Launch Room group folder")',
  // FE-P2-9 (M2): states with no mockup.
  hostsMore: 'GAP-R17: more sites than the card lists ("+ N more sites", from hostsContactedTotal)',
  hostReasons: 'GAP-R18: blocked-row labels for reasons no mockup shows (this computer, model server, cloud metadata, port, reserved)',
  waitingBrowserMeta: 'GAP-R19: "Waiting for the browser" shows the contract meta (Browser on · Internet asks after the browser); mockup 04 shows none',
  buildEnded: 'GAP-R20: tool build stopped / timed out / succeeded (mockups show running and failed only)',
  deniedOther: 'GAP-R21: denied by timeout or a denied browser, and browser setup failures (mockup 02/08 pattern)',
} as const

export type RunTone = 'ok' | 'bad' | 'run' | 'undone'

export type RunMetaItem = { key: string; label: string; value: string; suffix?: string }
export type RunFileRow = { key: string; change: FileChange['change']; path: string; size: string | null; folder: string | null }
export type RunLog = { text: string; error: boolean; live: boolean }
export type RunHostRow = { key: string; blocked: boolean; label: 'reached' | 'blocked'; host: string; note: string }
export type RunHosts = { title: string; rows: RunHostRow[]; more: number }
/** A browser run's screenshot preview: a file the card opens through the files route. */
export type RunThumb = { path: string; root: 'agent' | 'group'; groupId?: string }
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
  /** M2 "Sites used" ("Sites used so far" while active). */
  hosts: RunHosts | null
  /** M2: browser run screenshot under the files. */
  thumb: RunThumb | null
  /** M2: the line under the meta on a waiting card ("⏸ Not started. …"). */
  wait: string | null
  /** run.error, when it isn't already the log box's text. */
  error: string | null
  /** M2 (mockup 08): the red line goes under the log instead of above it. */
  errorLast: boolean
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

/* ---- M2: internet, sites used, thumbnails, error rows ---- */

/** M2 run reasons whose card shows the error as a red line (no log box unless there's stderr). */
export const M2_RUN_REASONS: readonly M2RunReason[] = [
  'internet_never', 'network_off', 'permission_denied', 'permission_timeout', 'proxy_unavailable',
  'browser_unavailable', 'chromium_check_failed', 'host_blocked', 'build_failed', 'build_stopped',
]
const isM2Reason = (r: string | undefined): r is M2RunReason => !!r && (M2_RUN_REASONS as readonly string[]).includes(r)

/** Blocked-row label ("home network · 1 try"). */
export const HOST_BLOCK_LABEL: Record<HostBlockReason, string> = {
  home_network: 'home network',
  tailscale: 'Tailscale',
  this_computer: 'this computer',
  model_server: 'model server',
  metadata: 'cloud metadata',
  private_name: 'private name',
  port: 'port',
  reserved: 'reserved address',
}

const ALWAYS_BLOCKED = 'Home network and Tailscale are always blocked in Phase 2.'
/** host_blocked error lines, written out in full (review §1: every line, plus reserved). The BE's `error` wins when sent. */
export const HOST_BLOCKED_TEXT: Record<HostBlockReason, string> = {
  tailscale: `The script tried to reach your Tailscale network. ${ALWAYS_BLOCKED}`,
  home_network: `The script tried to reach your home network. ${ALWAYS_BLOCKED}`,
  private_name: `The script tried to reach your home network. ${ALWAYS_BLOCKED}`,
  this_computer: `The script tried to reach this computer. ${ALWAYS_BLOCKED}`,
  model_server: `The script tried to reach your model server. ${ALWAYS_BLOCKED}`,
  metadata: `The script tried to reach a cloud metadata address. ${ALWAYS_BLOCKED}`,
  port: 'The script tried a port other than 80 or 443, which is blocked.',
  reserved: 'The script tried to reach a reserved address, which is always blocked.',
}

/** Card error copy when the run carries a reason but no `error` text (the BE's text is shown as is otherwise). */
export function reasonErrorText(
  reason: string | undefined,
  ctx: { botName?: string; browser?: boolean; hosts?: readonly HostContact[]; build?: ToolBuildInfo; status?: ScriptRunStatus },
): string | null {
  const bot = ctx.botName || 'The bot'
  const kept = ctx.build ? ` (version ${ctx.build.fromGeneration})` : ''
  switch (reason) {
    case 'permission_denied':
      return ctx.browser ? "You denied the browser, so this run didn't start. No files changed." : "You denied internet access, so this run didn't start. No files changed."
    case 'permission_timeout':
      return "No answer in 10 minutes, so this run didn't start. No files changed."
    case 'internet_never':
      return `Internet is set to Never for ${bot}, so this run didn't start. Change it in Settings › VM.`
    case 'network_off':
      return `This run was started with the internet off, so connecting failed. ${bot} can run it again with the internet on.`
    case 'proxy_unavailable':
      return "AgentControl's internet proxy isn't running, so this run couldn't get the internet. Try again; if it keeps failing, re-check in Settings › VM."
    case 'host_blocked': {
      const first = ctx.hosts?.find((h) => h.blocked && h.reason)
      return first?.reason ? HOST_BLOCKED_TEXT[first.reason] : null
    }
    case 'browser_unavailable':
      return "The browser couldn't be turned on, so this run didn't start."
    case 'chromium_check_failed':
      return `Chromium didn't start for ${bot}, so this run didn't start.`
    case 'build_failed':
      return ctx.status === 'timed_out'
        ? `The build took longer than 20 minutes, so ${bot} keeps its current tools${kept}.`
        : `The build failed, so ${bot} keeps its current tools${kept}. Nothing else changed.`
    case 'build_stopped':
      return `Stopped. ${bot} keeps its current tools${kept}.`
    default:
      return null
  }
}

/** InternetUse from the summary, else from the run's grants. */
export function internetUseOf(run: ScriptRun | undefined, summary: ChatRunSummary | undefined): InternetUse | 'on' {
  if (summary?.internet) return summary.internet
  const network = run?.network ?? summary?.network
  if (network !== 'on') return 'off'
  const grant = run?.permissions.find((p) => p.type === 'internet' && p.decision !== 'pending')
  if (grant?.decision === 'allow_once') return 'once'
  if (grant?.decision === 'always' || grant?.decision === 'enable') return 'always'
  return 'on'
}

const INTERNET_VALUE: Record<InternetUse | 'on', string> = { off: 'off', once: 'on (allowed once)', always: 'on (always allowed)', on: 'on' }

/** Contract meta rows for a waiting card: Browser "asked"/"on", Internet "asked"/"asks after the browser"/"off". */
function waitingMeta(run: ScriptRun, waitingFor: RunWaitingFor | undefined): RunMetaItem[] {
  const pending = run.permissions.find((p) => p.decision === 'pending')?.type
  const browserAsked = waitingFor !== 'browser' && pending === 'browser'
  const meta: RunMetaItem[] = []
  if (run.browser) meta.push({ key: 'br', label: 'Browser', value: browserAsked ? 'asked' : 'on' })
  let net: string
  if (run.network !== 'on') net = 'off'
  else if (run.browser && (waitingFor === 'browser' || browserAsked)) net = 'asks after the browser'
  else if (waitingFor === 'permission' || pending === 'internet') net = 'asked'
  else net = INTERNET_VALUE[internetUseOf(run, undefined)]
  meta.push({ key: 'net', label: 'Internet', value: net })
  return meta
}

export const HOSTS_SHOWN = 8

/**
 * "Sites used" rows: reached first, then blocked (mockup 06). Blocked rows always make the cut.
 * Names refused before resolving carry no IP, and no row shows one (Charles: no IP arrows).
 * "+ N more" counts hostsContactedTotal (the BE caps the list) beyond the rows shown.
 */
export function hostRows(hosts: readonly HostContact[] | undefined, total?: number, active = false): RunHosts | null {
  if (!hosts?.length) return null
  const blocked = hosts.filter((h) => h.blocked)
  const reached = hosts.filter((h) => !h.blocked)
  const keepBlocked = blocked.slice(0, HOSTS_SHOWN)
  const keepReached = reached.slice(0, Math.max(0, HOSTS_SHOWN - keepBlocked.length))
  const row = (h: HostContact, i: number): RunHostRow => {
    const host = h.port !== undefined && h.port !== 443 ? `${h.host}:${h.port}` : h.host
    const note = h.blocked
      ? [h.reason ? HOST_BLOCK_LABEL[h.reason] : null, plural(h.count, 'try', 'tries')].filter(Boolean).join(' · ')
      : plural(h.count, 'request')
    return { key: `${i}:${host}`, blocked: h.blocked, label: h.blocked ? 'blocked' : 'reached', host, note }
  }
  const rows = [...keepReached, ...keepBlocked].map(row)
  const all = Math.max(total ?? hosts.length, hosts.length)
  return { title: active ? 'Sites used so far' : 'Sites used', rows, more: all - rows.length }
}

const THUMB_EXT = /\.(png|jpe?g|webp)$/i
/** Review: the first .png/.jpg/.jpeg/.webp the run added or modified; never SVG; none once undone. */
export function thumbOf(run: ScriptRun, undone: boolean): RunThumb | null {
  if (!run.browser || undone) return null
  const f = run.filesChanged.find((c) => (c.change === 'added' || c.change === 'modified') && THUMB_EXT.test(c.path))
  if (!f) return null
  return f.root === 'group' && f.groupId ? { path: f.path, root: 'group', groupId: f.groupId } : { path: f.path, root: 'agent' }
}

/**
 * The line under a waiting card: mockup 01 (a permission card is open below) and mockup 07 (a run queued behind its
 * bot's tool build, "(version N)" from afterBuild.generation).
 */
export function waitLine(status: ScriptRunStatus | undefined, waitingFor: RunWaitingFor | undefined, summary: ChatRunSummary | undefined, botName?: string): string | null {
  if (status === 'waiting_permission' && waitingFor !== 'browser') return '⏸ Not started. It starts as soon as you answer below; no answer in 10 min counts as Deny.'
  if (status === 'queued' && summary?.queuedReason === 'tool_build') {
    const who = botName ? `${botName}'s` : "the bot's"
    const ver = summary.afterBuild ? ` (version ${summary.afterBuild.generation})` : ''
    return `⏳ Waits for ${who} tools to finish building, then runs on the new tools${ver}.`
  }
  return null
}

/** Tool build card subtitle: "adds matplotlib, pandas · version 3". */
export function buildSource(build: ToolBuildInfo): string {
  const parts: string[] = []
  if (build.added.length) parts.push(`adds ${build.added.join(', ')}`)
  if (build.removed?.length) parts.push(`removes ${build.removed.join(', ')}`)
  parts.push(`version ${build.generation}`)
  return parts.join(' · ')
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
  info: { exitCode?: number; queuePosition?: number; durationMs?: number; elapsedMs?: number; waitingFor?: RunWaitingFor; clock?: boolean; queuedReason?: QueuedReason },
  withClock = true,
): string {
  // Tool builds (mockups 07/08) read as a clock: "Running · 1:12", "Failed · 0:41", no exit code.
  if (info.clock && status !== 'running' && status !== 'queued' && info.durationMs !== undefined) {
    const label = statusText(status, {}, withClock)
    return ['failed', 'succeeded', 'timed_out', 'stopped'].includes(status) ? `${label} · ${clockText(info.durationMs)}` : label
  }
  const dur = durationText(info.durationMs)
  const join = (...parts: (string | null | undefined | false)[]) => parts.filter(Boolean).join(' · ')
  switch (status) {
    case 'queued': {
      // M2 contract fec4670 (mockups 07/14): a run waiting for its bot's tool build.
      if (info.queuedReason === 'tool_build') return 'Queued · after tool build'
      const q = info.queuePosition
      return join('Queued', q === undefined ? null : q <= 0 ? 'next' : `${q} ahead`)
    }
    case 'waiting_permission':
      return info.waitingFor === 'browser' ? 'Waiting for the browser' : 'Waiting for permission'
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
  // BE be7afe4: summary.undoOfName names the reversed run, so a collapsed card needs no fetch.
  if (kind === 'undo') return `Undo of ${summary?.undoOfName?.trim() || input.undoOfName || 'a run'}`
  // M2 contract: a live tool build is "Rebuild tools" (its packages go in the subtitle).
  if (kind === 'tool_build' && (run?.build ?? summary?.build)) return 'Rebuild tools'
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
  const build = run?.build ?? summary?.build
  if (kind === 'tool_build' && build) return buildSource(build)
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
  // M2 review: summary.startedAt lets a collapsed card tick ("Running · 1:12") before the run loads.
  const startedAt = run?.startedAt ?? summary?.startedAt
  const elapsedMs = startedAt ? now - Date.parse(startedAt) : undefined
  const build = run?.build ?? summary?.build
  const waitingFor = run?.waitingFor ?? summary?.waitingFor
  const reason = run?.reason ?? summary?.reason
  const isBuild = kind === 'tool_build' && !!build
  const info = {
    exitCode: isBuild ? undefined : (run?.exitCode ?? summary?.exitCode),
    queuePosition: run?.queuePosition ?? summary?.queuePosition,
    durationMs,
    elapsedMs: elapsedMs !== undefined && Number.isFinite(elapsedMs) ? elapsedMs : undefined,
    waitingFor,
    clock: isBuild,
    queuedReason: summary?.queuedReason,
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
    spinner: status === 'running' || status === 'waiting_permission',
    bad: status === 'failed' || status === 'timed_out' || status === 'denied',
    progress: status === 'running',
    active,
  }

  if (!run) {
    return {
      ...base, command: null, meta: [], files: [], moreFiles: 0, hosts: null, thumb: null, wait: null, error: null, errorLast: false, log: null, truncated: null,
      actions: { stop: active, undo: false, output: false }, note: null, noteFirst: false, loading: true,
    }
  }

  // Mockups 07/08: a live tool build shows no command line (its packages are in the subtitle).
  const command = isBuild ? null : run.argv.length ? `$ ${commandLine(run.argv)}` : run.script ? `$ ${tailLines(run.script, 1)}` : null
  const internetValue = INTERNET_VALUE[internetUseOf(run, summary)]
  const m2Reason = isM2Reason(reason) ? reason : null

  // Meta line (mockup's succeeded card): Exit · Internet · Peak memory · Snapshot · runtime (§12 v2, GAP-R9).
  // The failed card in mockup (a) has no meta line, and an active run's isn't known yet.
  const meta: RunMetaItem[] = []
  if (status === 'waiting_permission') {
    meta.push(...waitingMeta(run, waitingFor))
  } else if (isBuild && build && !base.bad && status !== 'queued') {
    // Mockup 07: "Internet on (allowed once) · Started by Primary (vm_install)".
    meta.push({ key: 'net', label: 'Internet', value: internetValue })
    meta.push({ key: 'by', label: 'Started by', value: build.startedBy === 'user' ? 'you' : `${input.botName || 'the bot'} (${build.via})` })
  } else if (base.bad && (m2Reason === 'host_blocked' || m2Reason === 'network_off')) {
    // Mockup 08: a run that started and then hit the network shows Exit · Internet.
    if (run.exitCode !== undefined) meta.push({ key: 'exit', label: 'Exit', value: String(run.exitCode) })
    meta.push({ key: 'net', label: 'Internet', value: internetValue })
  } else if (!active && !base.bad) {
    if (run.exitCode !== undefined) meta.push({ key: 'exit', label: 'Exit', value: String(run.exitCode) })
    if (run.browser) meta.push({ key: 'br', label: 'Browser', value: 'on' })
    meta.push({ key: 'net', label: 'Internet', value: internetValue })
    if (run.peakMemoryMb !== undefined) meta.push({ key: 'mem', label: 'Peak memory', value: memoryText(run.peakMemoryMb), suffix: `of ${memoryText(VM_LIMITS.memoryMb)}` })
    if (run.snapshot) meta.push({ key: 'snap', label: 'Snapshot', value: run.snapshot.id })
    const rt = runtimeLabel(run.runtime)
    if (rt) meta.push({ key: 'rt', label: 'Runtime', value: rt })
  }

  const allFiles = active || isBuild ? [] : fileRows(run.filesChanged, input.groupNames)
  const files = allFiles.slice(0, FILES_SHOWN)
  const moreFiles = allFiles.length - files.length

  // Log: live tail while active; stdout when it worked; stderr (or the error) in red when it didn't.
  const out = input.output ?? { stdout: run.stdoutTail, stderr: run.stderrTail }
  const stdout = out.stdout.trim() ? tailLines(out.stdout) : ''
  const stderr = out.stderr.trim() ? tailLines(out.stderr) : ''
  const errText =
    run.error?.trim() ||
    summary?.error?.trim() ||
    reasonErrorText(reason, { botName: input.botName, browser: run.browser, hosts: run.hostsContacted ?? summary?.hostsContacted, build, status }) ||
    null
  let log: RunLog | null = null
  let error: string | null = null
  let errorLast = false
  if (status === 'waiting_permission' || status === 'queued') {
    log = null
  } else if (active) {
    const both = [out.stdout, out.stderr].filter((s) => s.trim()).join('\n')
    log = both ? { text: tailLines(both), error: false, live: status === 'running' } : null
  } else if (base.bad && (m2Reason || isBuild)) {
    // M2 (mockups 02/08): the error is a red line; stderr, when there is any, sits in the red box above it.
    if (stderr) log = { text: stderr, error: true, live: false }
    error = errText
    errorLast = true
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

  const undone = status === 'undone' || undo.state === 'done'
  const hosts = hostRows(run.hostsContacted ?? summary?.hostsContacted, run.hostsContactedTotal ?? summary?.hostsContactedTotal, active)
  const thumb = thumbOf(run, undone)
  const wait = waitLine(status, waitingFor, summary, input.botName)
  const truncated = run.outputTruncated ? `Output passed the ${VM_LIMITS.outputMb} MB limit; the rest wasn't kept.` : null

  // Actions and the note.
  const changed = run.filesChanged.length
  let note: string | null
  let noteFirst = false
  const actions: RunActions = { stop: active, undo: false, output: !active }
  if (status === 'waiting_permission' || (status === 'queued' && summary?.queuedReason === 'tool_build')) {
    // Mockups 01/04/07: Stop only; the wait line says the rest.
    note = null
  } else if (isBuild && build && active && status !== 'queued') {
    // Mockup 07: Stop · Full output · "Stopping keeps the current tools (version 2)."
    actions.output = true
    note = `Stopping keeps the current tools (version ${build.fromGeneration}).`
  } else if (active) {
    note = status === 'queued' ? `Starts when the machine is free · limit ${limitText()}` : `${internetNote(run)} · limit ${limitText()}`
  } else if (status === 'undone') {
    const at = hm(undo.at)
    note = at ? `Undone at ${at}` : 'Undone'
    noteFirst = true
  } else if (kind === 'tool_build') {
    // Mockup 08: a failed build's red line is the whole story.
    note = isBuild && (base.bad || status === 'stopped') ? null : "Undo doesn't cover installed tools"
    noteFirst = true
  } else if (base.bad && m2Reason && m2Reason !== 'host_blocked' && m2Reason !== 'network_off') {
    // Mockups 02/08: a run that never started shows its red line and Full output only.
    note = null
  } else if (base.bad && m2Reason && changed === 0) {
    note = null
  } else if (undo.state === 'unavailable' && undo.reason) {
    note = undoUnavailableText(undo, input)
    noteFirst = true
  } else if (changed === 0) {
    note = 'No files changed · nothing to undo'
    noteFirst = true
  } else if (undo.state === 'available') {
    actions.undo = true
    // Mockup 06: an internet run's undo can't take back what was sent.
    note = run.network === 'on' ? "Undo restores files only. It can't take back what was sent online." : `Undo restores the ${changed === 1 ? 'file' : plural(changed, 'file')} above`
  } else {
    note = undoUnavailableText(undo, input)
    noteFirst = true
  }

  return { ...base, command, meta, files, moreFiles, hosts, thumb, wait, error, errorLast, log, truncated, actions, note, noteFirst, loading: false }
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
