/*
 * FE-P2-5: the bot settings VM tab (PHASE2_PLAN.md §14, mockups c-settings-vm-tab-v2{,-lower,-windows}).
 * Pure view model: every line of copy the tab shows, from VmInfo (+ VmHostInfo / VmProbeResult when
 * loaded). Markup: ./vm-tab-render.ts. Component: components/settings/VmTab.tsx. Tests: tests/vm-tab.test.mjs.
 */
import {
  ENV_NAME, MAX_ENV_VALUE_CHARS, MAX_ENV_VARS, RESERVED_ENV_NAMES, RESERVED_ENV_PREFIX, UNDO_RETENTION,
  type EnvVar, type GlobalRuntimeMode, type InternetPolicy, type RuntimeMode, type ScriptRunSummary, type ToolManifest,
  type VmHostInfo, type VmInfo, type VmProbeResult,
} from './types.ts'
import { durationText, limitText } from './run-card.ts'
import { scriptName } from './live-store.ts'
import { undoGoneText, undoReasonText } from './undo.ts'
import { humanSize } from './file-format.ts'
import { FILES_MISSING_TEXT } from './files.ts'

/**
 * States and notices with no mockup, built from the tab's own patterns (shots in shots/p2-fe-5/).
 * M1 rulings: Browser toggle shown but disabled; Back up / Restore hidden (Export only);
 * no Settings › VMs links.
 */
export const VM_TAB_GAPS = {
  V1: 'VM states other than Running (not set up, starting, stopped, error, files missing): same header, badge and copy per state',
  V2: 'Reset VM confirmation dialog (ConfirmDialog; copy from Team lead 2026-10-27, no backup claim)',
  V3: 'Linux "where files live" (no shared VM line)',
  V4: 'gVisor active, active (forced), off (forced), required but unavailable: badge + one line each (§4 wording)',
  V5: 'Notices: grow disk offer, keep-id fallback (isolationNote), copy snapshot driver, over 10 GB',
  V6: 'Env editing: inline row editor with errors under the field',
  V7: 'Installed tools Details dialog, with Rebuild tools / Roll back',
  V8: 'Run history: Output dialog (RunOutputDialog), "Show older runs" paging, running/undo/tool-build rows',
  V9: 'Phone layout (2-column meters, wrapped history rows)',
  V10: 'Tab dot meaning: ● while the VM is running, ! when it needs attention (error, files missing, gVisor required but unavailable)',
  V11: 'files_missing offers Restore / Start empty in §14; Restore is hidden in M1 and there is no Start-empty route, so the tab explains and offers nothing',
  V12: 'Bot files & tools meter note reads "workspace N · tools and packages N" (mockup had "tools N · env N"; imageLayer is vm_install packages, BE be7afe4)',
} as const

/* ---- formatting ---- */

const GB = 1024 ** 3

/** "0.6", "1.9", "10", "10.2": one decimal, ".0" dropped. */
export function gbNumber(bytes: number): string {
  const v = Math.round((Math.max(0, bytes) / GB) * 10) / 10
  return String(v)
}

export function gbFromMb(mb: number): string {
  return gbNumber(mb * 1024 * 1024)
}

/** 12-hour clock, "5:33 PM". */
export function clock(d: Date): string {
  const h = d.getHours()
  return `${h % 12 === 0 ? 12 : h % 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString()

/** History times (mockup c lower): "5:33 PM" today, "Yesterday", "Oct 19" (year when it differs). */
export function historyTime(iso: string | undefined, now: Date = new Date()): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  if (sameDay(d, now)) return clock(d)
  const y = new Date(now)
  y.setDate(y.getDate() - 1)
  if (sameDay(d, y)) return 'Yesterday'
  return `${MONTHS[d.getMonth()]} ${d.getDate()}${d.getFullYear() === now.getFullYear() ? '' : `, ${d.getFullYear()}`}`
}

/** "today 9:02 AM", "yesterday 9:02 AM", "Oct 19, 9:02 AM". */
export function whenText(iso: string | undefined, now: Date = new Date()): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  if (sameDay(d, now)) return `today ${clock(d)}`
  const y = new Date(now)
  y.setDate(y.getDate() - 1)
  if (sameDay(d, y)) return `yesterday ${clock(d)}`
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${clock(d)}`
}

const possessive = (name: string) => `${name}'s`

/* ---- platform ---- */

export type VmPlatform = 'mac' | 'windows' | 'linux' | 'unknown'

/** Host OS: VmHostInfo when loaded, else guessed from the storage backend and provider. */
export function vmPlatform(vm: Pick<VmInfo, 'storage' | 'host'>, host?: Pick<VmHostInfo, 'os'> | null): VmPlatform {
  if (host?.os === 'darwin') return 'mac'
  if (host?.os === 'win32') return 'windows'
  if (host?.os === 'linux') return 'linux'
  if (vm.storage.backend === 'wsl') return 'windows'
  const p = vm.host.provider
  if (p === 'libkrun' || p === 'applehv') return 'mac'
  if (p === 'wsl' || p === 'hyperv') return 'windows'
  if (p === 'native') return 'linux'
  return 'unknown'
}

const PLACE: Record<VmPlatform, string> = { mac: 'this Mac', windows: 'this PC', linux: 'this computer', unknown: 'this computer' }

/* ---- header ---- */

export type VmTone = 'ok' | 'bad' | 'run' | 'off'

export type VmHeaderView = {
  badge: string
  tone: VmTone
  spinner: boolean
  title: string
  subtitle: string
  /** A plain line under the header (error text, setup hint). */
  message: string | null
  /** files_missing: a warning block. */
  banner: string | null
  start: string | null
  stop: boolean
  reset: boolean
  /** Start/Stop/Reset are disabled (starting). */
  busy: boolean
}

export function engineLabel(engine: VmInfo['host']['engine']): string | null {
  if (engine === 'podman') return 'Podman'
  if (engine === 'docker') return 'Docker'
  return null
}

/** "Analyst's own container · Podman on this Mac (libkrun) · idle stop in 9 min". */
export function vmSubtitle(vm: VmInfo, botName: string, platform: VmPlatform, now: Date = new Date()): string {
  const engine = engineLabel(vm.host.engine)
  const provider = vm.storage.backend === 'wsl' || platform === 'windows' ? 'WSL' : vm.host.provider && vm.host.provider !== 'native' ? vm.host.provider : null
  const where = engine ? `${engine} on ${PLACE[platform]}${provider ? ` (${provider})` : ''}` : 'no container engine found yet'
  const parts = [`${possessive(botName)} own container`, where]
  if (vm.state === 'running' && vm.idleStopAt) {
    const min = Math.max(1, Math.ceil((Date.parse(vm.idleStopAt) - now.getTime()) / 60_000))
    if (Number.isFinite(min)) parts.push(`idle stop in ${min} min`)
  }
  return parts.join(' · ')
}

export function vmHeader(vm: VmInfo, botName: string, platform: VmPlatform, now: Date = new Date()): VmHeaderView {
  const base = { title: `${possessive(botName)} VM`, subtitle: vmSubtitle(vm, botName, platform, now), message: null, banner: null, spinner: false, busy: false }
  switch (vm.state) {
    case 'running':
      return { ...base, badge: 'Running', tone: 'ok', start: null, stop: true, reset: true }
    case 'starting':
      return { ...base, badge: 'Starting', tone: 'run', spinner: true, start: null, stop: true, reset: true, busy: true }
    case 'stopped':
      return { ...base, badge: 'Stopped', tone: 'off', start: 'Start', stop: false, reset: true, message: vm.stateMessage ?? `Starts by itself on ${possessive(botName)} next run.` }
    case 'not_setup':
      return {
        ...base,
        badge: 'Not set up',
        tone: 'off',
        start: 'Set up now',
        stop: false,
        reset: false,
        message: vm.stateMessage ?? `${possessive(botName)} VM is set up the first time it runs a script (a minute or two), or now.`,
      }
    case 'error':
      return { ...base, badge: 'Error', tone: 'bad', start: 'Try again', stop: false, reset: true, message: vm.stateMessage ?? "The VM couldn't start." }
    case 'files_missing':
      return {
        ...base,
        badge: 'Files missing',
        tone: 'bad',
        start: null,
        stop: false,
        reset: false,
        // The server's message (be-6 wording, same check as the file routes' 409); be-6's text if absent.
        banner: vm.stateMessage?.trim() ? vm.stateMessage : FILES_MISSING_TEXT,
        message: 'Restoring from a backup arrives in a later update.',
      }
  }
}

/* ---- meters ---- */

export type MeterView = { key: string; label: string; value: string; of: string | null; pct: number | null; tone: 'ok' | 'warn' | 'bad'; note: string | null }

const meterTone = (pct: number): MeterView['tone'] => (pct >= 100 ? 'bad' : pct >= 80 ? 'warn' : 'ok')
const pctOf = (used: number, total: number) => (total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0)

/**
 * "workspace 0.4 · tools and packages 1.5": files (workspace+inputs+memory) and tools and packages
 * (~/.local + /opt + the image layer, i.e. what vm_install added; BE be7afe4 contract). Env vars are
 * tiny and not counted. The parts sum to usage.personalBytes. (Mockup said "env"; GAP-V12.)
 */
export function breakdownText(b: VmInfo['usage']['breakdown']): string {
  return `workspace ${gbNumber(b.workspace + b.inputs + b.memory)} · tools and packages ${gbNumber(b.tools + b.opt + b.imageLayer)}`
}

export function vmMeters(vm: VmInfo): MeterView[] {
  const u = vm.usage
  const memPct = pctOf(u.memoryMb, vm.limits.memoryMb)
  const quota = u.personalQuotaBytes || vm.limits.personalDiskMb * 1024 * 1024
  const diskPct = pctOf(u.personalBytes, quota)
  const snapPct = pctOf(u.snapshots.bytes, u.snapshots.budgetBytes)
  const runs = u.snapshots.runsWithUndo
  return [
    { key: 'memory', label: 'Memory', value: `${gbFromMb(u.memoryMb)} GB`, of: `of ${gbFromMb(vm.limits.memoryMb)} GB`, pct: memPct, tone: meterTone(memPct), note: null },
    {
      key: 'disk',
      label: 'Bot files & tools',
      value: `${gbNumber(u.personalBytes)} GB`,
      of: `of ${gbNumber(quota)} GB`,
      pct: diskPct,
      tone: u.personalBytes > quota ? 'bad' : meterTone(diskPct),
      note: breakdownText(u.breakdown),
    },
    {
      key: 'undo',
      label: 'Undo snapshots',
      value: `${gbNumber(u.snapshots.bytes)} GB`,
      of: `of ${gbNumber(u.snapshots.budgetBytes)} GB`,
      pct: snapPct,
      tone: meterTone(snapPct),
      note: `separate budget · ${runs} ${runs === 1 ? 'run' : 'runs'}`,
    },
    {
      key: 'run',
      label: 'Per run',
      value: `${vm.limits.cpus} CPUs`,
      of: `· ${limitText(vm.limits.timeoutSec)}`,
      pct: null,
      tone: 'ok',
      note: `${vm.limits.pids} processes · ${vm.limits.outputMb} MB output`,
    },
  ]
}

/* ---- permissions ---- */

export const INTERNET_OPTIONS: readonly { value: InternetPolicy; label: string }[] = [
  { value: 'ask', label: 'Ask each time' },
  { value: 'always', label: 'Always allow' },
  { value: 'never', label: 'Never' },
]

export const INTERNET_TEXT = "Public internet only, through AgentControl's proxy. Every site used is listed on the run."
export const HOME_NETWORK_TEXT = 'Blocked, including this computer and your model server.'
/** M1 ruling: the toggle is shown but disabled. */
export const BROWSER_LATER_TEXT = 'Turning the browser on is available in a later update.'

export function permissionsHint(botName: string): string {
  return `Scripts run without asking. ${botName} asks only for what is off here.`
}

export function browserText(vm: Pick<VmInfo, 'permissions'>, botName: string): string {
  const p = vm.permissions
  if (!p.browser)
    return `Off. ${botName} asks in chat when a script needs a browser. Turning it on downloads headless Chromium once (about 1.1 GB, shared by all bots, not counted in ${possessive(botName)} 10 GB). Web pages still follow the Internet rule.`
  if (p.browserState === 'downloading') return `On. Downloading headless Chromium${typeof p.progress === 'number' ? ` (${Math.round(p.progress * 100)}%)` : ''}…`
  if (p.browserState === 'error') return "On, but headless Chromium couldn't be downloaded."
  return 'On. Web pages still follow the Internet rule.'
}

/* ---- isolation ---- */

export const RUNTIME_MODE_OPTIONS = (globalMode: GlobalRuntimeMode): { value: RuntimeMode; label: string }[] => [
  { value: 'inherit', label: `Use global (${GLOBAL_MODE_LABEL[globalMode]})` },
  { value: 'force_on', label: 'Force on' },
  { value: 'force_off', label: 'Force off' },
]

const GLOBAL_MODE_LABEL: Record<GlobalRuntimeMode, string> = { auto: 'Auto', force_on: 'Force on', force_off: 'Force off' }

export type IsolationView = {
  badge: string
  tone: 'on' | 'off' | 'warn' | 'bad'
  text: string
  /** Under the segmented control (M1: no Settings › VMs link). */
  hint: string
  checked: string | null
}

/** The failing probe check's message, for when VmInfo has no reason. */
export function probeReason(probe?: VmProbeResult | null): string | undefined {
  return probe?.checks?.find((c) => c.status === 'fail')?.message
}

export function isolationView(vm: VmInfo, botName: string, opts: { probe?: VmProbeResult | null; now?: Date } = {}): IsolationView {
  const now = opts.now ?? new Date()
  const r = vm.runtime
  const reason = r.reason ?? probeReason(opts.probe)
  const checkedWhen = whenText(r.checkedAt ?? opts.probe?.checkedAt ?? undefined, now)
  const checked = checkedWhen ? `Checked ${checkedWhen}.` : null
  const forcedOn = r.mode === 'force_on' || (r.mode === 'inherit' && r.globalMode === 'force_on')
  const standard = `Standard runtime: ${botName} has its own container, user IDs and network, separate from other bots.`
  const hint = `Global setting: ${GLOBAL_MODE_LABEL[r.globalMode]}. Force on stops runs with a clear error if gVisor can't be used.`
  switch (r.status) {
    case 'active':
      return {
        badge: forcedOn ? 'gVisor · Active (forced)' : 'gVisor · Active',
        tone: 'on',
        text: `${botName} runs in its own container behind gVisor, a second kernel boundary, with its own user IDs and network.`,
        hint,
        checked,
      }
    case 'not_installed':
      return { badge: 'gVisor · Not installed', tone: 'off', text: `${standard} gVisor adds a second kernel boundary when it is installed in the VM.`, hint, checked: null }
    case 'incompatible_fallback':
      return {
        badge: 'gVisor · Incompatible',
        tone: 'warn',
        text: `gVisor is installed but failed the check${reason ? ` (${reason})` : ''}, so ${botName} fell back to the standard runtime. ${botName} is still in its own container.`,
        hint,
        checked,
      }
    case 'forced_off':
      return {
        badge: 'gVisor · Off (forced)',
        tone: 'off',
        text: `${standard} gVisor is turned off ${r.mode === 'force_off' ? `for ${botName}` : 'for all bots'}.`,
        hint,
        checked: null,
      }
    case 'required_unavailable':
      return {
        badge: 'gVisor · Required but unavailable',
        tone: 'bad',
        text: `gVisor is required for ${botName} but isn't available${reason ? ` (${reason})` : ''}. Runs stop with an error until you turn off Force on or fix gVisor.`,
        hint,
        checked,
      }
  }
}

/* ---- environment ---- */

/** "matplotlib==3.10.1" → "matplotlib 3.10.1"; "csv-parse@5.5.0" / "@scope/x@1" → "csv-parse 5.5.0". */
export function packageLabel(spec: string): string {
  const pip = /^([^=<>~!\s]+)\s*==\s*(\S+)$/.exec(spec)
  if (pip) return `${pip[1]} ${pip[2]}`
  const at = spec.lastIndexOf('@')
  if (at > 0) return `${spec.slice(0, at)} ${spec.slice(at + 1)}`
  return spec
}

export type ToolsLine = { text: string; system: string[]; built: string | null } | null

/** "pip: matplotlib 3.10.1, pandas 2.2.3 · npm: csv-parse · system: poppler-utils (Analyst's own image layer, built 5:33 PM)". */
export function toolsLine(vm: Pick<VmInfo, 'tools' | 'packages' | 'image'>, botName: string, now: Date = new Date()): ToolsLine {
  const t: ToolManifest | undefined = vm.tools
  const parts: string[] = []
  if (t?.pip.length) parts.push(`pip: ${t.pip.map(packageLabel).join(', ')}`)
  if (t?.npm.length) parts.push(`npm: ${t.npm.map(packageLabel).join(', ')}`)
  if (t?.optBin.length) parts.push(`/opt: ${t.optBin.join(', ')}`)
  if (!parts.length && !vm.packages.length) return null
  const builtAt = vm.image.builtAt ? new Date(vm.image.builtAt) : null
  const built = builtAt && !Number.isNaN(builtAt.getTime()) ? (sameDay(builtAt, now) ? clock(builtAt) : historyTime(vm.image.builtAt, now)) : null
  return { text: parts.join(' · '), system: [...vm.packages], built: vm.packages.length ? `${possessive(botName)} own image layer${built ? `, built ${built}` : ''}` : null }
}

export function noToolsText(botName: string): string {
  return `None yet. ${botName} installs packages in a run (pip, npm or system packages), and they stay until Reset VM.`
}

export function environmentHint(botName: string): string {
  return `Belongs to ${botName} only and stays between runs: installed packages, tools and caches, and these variables. Reset VM clears it.`
}

export function environmentTitle(botName: string): string {
  return `${possessive(botName)} environment`
}

export const ENV_SECRET_NOTE = "Don't put passwords or keys here. Secret variables are not part of Phase 2."

/** The BE's envNameProblem wording (vm-defaults.ts @ 3a70c34), so the inline error matches a 400. */
export function envNameProblem(name: string): string | null {
  if (!ENV_NAME.test(name)) return `"${name.slice(0, 64)}" isn't a valid variable name. Use letters, digits and _, starting with a letter or _.`
  const upper = name.toUpperCase()
  if (upper === 'PATH') return '"PATH" is reserved. Use PATH_APPEND to add folders to it.'
  if (RESERVED_ENV_NAMES.includes(upper)) return `"${name}" is reserved and set by AgentControl.`
  if (upper.startsWith(RESERVED_ENV_PREFIX)) return `Names starting with ${RESERVED_ENV_PREFIX} are reserved for AgentControl.`
  return null
}

export type EnvErrors = { name: string | null; value: string | null }

/**
 * Checks one edited row against the list. `index` is the row being edited (-1 = new).
 * Empty names say "Enter a name." rather than the regex message.
 */
export function envRowErrors(list: readonly EnvVar[], index: number, name: string, value: string): EnvErrors {
  const n = name.trim()
  let nameErr: string | null = n ? envNameProblem(n) : 'Enter a name.'
  if (!nameErr && list.some((e, i) => i !== index && e.name === n)) nameErr = `"${n}" is already set.`
  if (!nameErr && index < 0 && list.length >= MAX_ENV_VARS) nameErr = `${MAX_ENV_VARS} variables is the most a bot can have.`
  const valueErr = value.length > MAX_ENV_VALUE_CHARS ? `Values can be up to ${MAX_ENV_VALUE_CHARS.toLocaleString('en-US')} characters.` : null
  return { name: nameErr, value: valueErr }
}

/** The list after saving row `index` (-1 = add) or removing it (`remove`). */
export function envWith(list: readonly EnvVar[], index: number, row: EnvVar | null): EnvVar[] {
  if (row === null) return list.filter((_, i) => i !== index)
  const clean = { name: row.name.trim(), value: row.value }
  if (index < 0) return [...list, clean]
  return list.map((e, i) => (i === index ? clean : e))
}

/* ---- where files live ---- */

export type FilesLiveView = {
  /** Text before / inside / after the <code> path. */
  before: string
  code: string | null
  after: string
  /** wsl: the backup line (M1: no Back up now / Restore buttons). */
  backup: string | null
  /** wsl: Export (M1 keeps only Export). */
  exportLabel: string | null
}

export function machineLine(host: Pick<VmHostInfo, 'machine'> | null | undefined): string | null {
  const m = host?.machine
  if (!m) return null
  return `Shared VM "${m.name}": ${gbFromMb(m.memoryMb)} GB RAM · ${m.cpus} vCPU · disk ${Math.round(m.diskUsedGb)} of ${Math.round(m.diskGb)} GB used (grows on demand).`
}

export function filesLive(vm: VmInfo, botName: string, platform: VmPlatform, host?: VmHostInfo | null, now: Date = new Date()): FilesLiveView {
  const machine = machineLine(host)
  if (vm.storage.backend === 'wsl') {
    const when = whenText(vm.storage.lastBackupAt, now)
    return {
      before: `Inside the Linux disk of the shared VM "${host?.machine?.name ?? 'agentcontrol'}" (WSL), for speed.${vm.storage.explorerPath ? ' Open them read-only in Explorer at ' : ''}`,
      code: vm.storage.explorerPath ?? null,
      after: vm.storage.explorerPath ? '.' : '',
      backup: `${when ? `Last backup ${when} to %LOCALAPPDATA%\\AgentControl\\backups.` : 'No backup yet.'} Removing the WSL distro or Podman machine deletes the live files; restore from a backup.`,
      exportLabel: `Export ${possessive(botName)} files (.zip)`,
    }
  }
  return {
    before: `On ${PLACE[platform]} in `,
    code: vm.storage.location,
    after: `.${machine ? ` ${machine}` : ''}`,
    backup: null,
    exportLabel: null,
  }
}

/* ---- notices ---- */

export type VmNotice = { id: 'over_quota' | 'grow' | 'copy_driver' | 'isolation'; tone: 'warn' | 'info'; text: string; action?: { label: string; toGb: number } }

export function vmNotices(vm: VmInfo, botName: string, host?: VmHostInfo | null): VmNotice[] {
  const out: VmNotice[] = []
  const u = vm.usage
  const quota = u.personalQuotaBytes || vm.limits.personalDiskMb * 1024 * 1024
  if (u.personalBytes > quota)
    out.push({
      id: 'over_quota',
      tone: 'warn',
      text: `${possessive(botName)} files and tools use ${gbNumber(u.personalBytes)} of ${gbNumber(quota)} GB, so new runs are blocked. Free space in Files or remove tools here.`,
    })
  const grow = host?.machine?.growOffer
  if (grow && host?.machine)
    out.push({
      id: 'grow',
      tone: 'info',
      text: `The shared VM's disk is ${pctOf(host.machine.diskUsedGb, host.machine.diskGb)}% full (${Math.round(host.machine.diskUsedGb)} of ${Math.round(host.machine.diskGb)} GB). Growing it can't be undone.`,
      action: { label: `Grow disk to ${grow.toGb} GB`, toGb: grow.toGb },
    })
  if (vm.storage.driver === 'copy')
    out.push({
      id: 'copy_driver',
      tone: 'info',
      text: "This disk can't make quick snapshots, so undo copies files instead. The first run copies the whole folder, which takes longer and uses more undo space.",
    })
  return out
}

/* ---- run history ---- */

export type HistoryAction = 'undo' | 'output' | 'none'

export type HistoryRowView = {
  id: string
  icon: string
  iconTone: 'ok' | 'bad' | 'und' | 'run'
  name: string
  meta: string
  time: string
  action: HistoryAction
  /** "no undo" in italics, when undo is gone. */
  gone: boolean
}

export type HistoryContext = {
  botName: string
  budgetBytes?: number
  groupNames?: Readonly<Record<string, string>>
  /** Earlier rows by id, so an undo run can name what it reversed. */
  byId?: Readonly<Record<string, ScriptRunSummary>>
  now?: Date
}

export const HISTORY_RETENTION_TEXT = (budgetBytes: number) =>
  `undo for the last ${UNDO_RETENTION.runs} runs or ${UNDO_RETENTION.days} days · up to ${humanSize(budgetBytes) ?? '2 GB'}`

const filesText = (n: number) => (n === 0 ? 'no files changed' : n === 1 ? '1 file changed' : `${n} files changed`)

function where(run: ScriptRunSummary, names?: Readonly<Record<string, string>>): string {
  if (run.groupId) return names?.[run.groupId] ?? 'group'
  return 'DM'
}

function rowName(run: ScriptRunSummary, byId?: Readonly<Record<string, ScriptRunSummary>>): string {
  if (run.kind === 'tool_build') return 'Tool build'
  if (run.kind === 'undo') {
    const of = run.undoOfRunId ? byId?.[run.undoOfRunId] : undefined
    return of ? `Undo of ${scriptName(of)}` : 'Undo'
  }
  return scriptName(run)
}

/** Mockup c lower: "Undo no longer available: snapshot removed to stay within the 2 GB undo budget". */
export function historyUndoGone(undo: ScriptRunSummary['undo'], ctx: Pick<HistoryContext, 'botName' | 'budgetBytes'>): string {
  const reason = undo.reason
  if (!reason) return 'Undo no longer available'
  if (reason === 'too_large') return `Undo isn't available for this run: ${undoReasonText('too_large', { changedBytes: undo.changedBytes })}`
  if (reason === 'budget_bot') {
    const size = humanSize(ctx.budgetBytes)
    return `Undo no longer available: snapshot removed to stay within the ${size ? `${size} ` : ''}undo budget`
  }
  return undoGoneText(reason, { botName: ctx.botName, budgetBytes: ctx.budgetBytes }).replace(/\.$/, '')
}

export function historyRow(run: ScriptRunSummary, ctx: HistoryContext): HistoryRowView {
  const now = ctx.now ?? new Date()
  const name = rowName(run, ctx.byId)
  const time = historyTime(run.endedAt ?? run.startedAt ?? run.queuedAt, now)
  const dur = durationText(run.durationMs)
  const place = where(run, ctx.groupNames)
  const base = { id: run.id, name, time, gone: false }
  const files = filesText(run.filesChangedCount)

  if (run.status === 'queued' || run.status === 'waiting_permission' || run.status === 'running') {
    const what = run.status === 'running' ? 'running' : run.status === 'queued' ? 'queued' : 'waiting for your OK'
    return { ...base, icon: '●', iconTone: 'run', meta: [what, place].join(' · '), action: 'none' }
  }
  if (run.status === 'undone' || run.undo.state === 'done') {
    const at = run.undo.at ? new Date(run.undo.at) : null
    const when = at && !Number.isNaN(at.getTime()) ? ` ${sameDay(at, now) ? clock(at) : historyTime(run.undo.at, now)}` : ''
    const restored = run.filesChangedCount === 1 ? '1 file restored' : `${run.filesChangedCount} files restored`
    return { ...base, icon: '↶', iconTone: 'und', meta: [`undone${when}`, restored, place].join(' · '), action: 'output' }
  }
  const ok = run.status === 'succeeded'
  const head =
    run.status === 'failed'
      ? `exit ${run.exitCode ?? '?'}`
      : run.status === 'timed_out'
        ? 'timed out'
        : run.status === 'stopped'
          ? 'stopped'
          : run.status === 'denied'
            ? 'denied'
            : null
  const meta = [head, files, dur, place].filter(Boolean).join(' · ')
  const icon = { icon: '●', iconTone: ok ? ('ok' as const) : ('bad' as const) }
  if (run.undo.state === 'unavailable') {
    return { ...base, ...icon, meta: historyUndoGone(run.undo, ctx), action: 'none', gone: true }
  }
  const undoable = run.kind === 'script' && run.undo.state === 'available' && run.filesChangedCount > 0
  return { ...base, ...icon, meta, action: undoable ? 'undo' : 'output' }
}

/* ---- tab dot ---- */

export type TabDot = { text: string; label: string } | null

/** GAP-V10: ● while running; ! when it needs you. */
export function vmTabDot(vm: Pick<VmInfo, 'state' | 'runtime'> | undefined): TabDot {
  if (!vm) return null
  if (vm.state === 'error' || vm.state === 'files_missing' || vm.runtime.status === 'required_unavailable') return { text: '!', label: 'VM needs attention' }
  if (vm.state === 'running' || vm.state === 'starting') return { text: '●', label: 'VM is running' }
  return null
}

/* ---- errors ---- */

/** The server's message for a failed VM action, else a generic line. */
export function vmActionError(err: unknown, fallback: string): string {
  const e = err as { status?: unknown; message?: unknown } | null
  if (e && typeof e.status === 'number' && e.status >= 400 && e.status < 500 && typeof e.message === 'string' && e.message.trim()) return e.message
  return fallback
}

export const RESET_TITLE = (botName: string) => `Reset ${possessive(botName)} VM?`
/** Team lead 2026-10-27: no backup claim (reset doesn't take one in M1). */
export const RESET_TEXT = 'Your files are kept. Installed tools and packages will be removed.'
export const RESET_ACTIVE_TEXT = 'A run is going on. Stop it or wait for it to finish, then reset.'

/* ---- the whole tab ---- */

export type VmTabInput = {
  vm: VmInfo
  botName: string
  host?: VmHostInfo | null
  probe?: VmProbeResult | null
  groupNames?: Readonly<Record<string, string>>
  /** Rows from "Show older runs" pages, after vm.runs. */
  olderRuns?: readonly ScriptRunSummary[]
  now?: Date
}

export type VmTabModel = {
  botName: string
  platform: VmPlatform
  header: VmHeaderView
  meters: MeterView[]
  internetPolicy: InternetPolicy
  browserOn: boolean
  browserText: string
  isolation: IsolationView
  runtimeMode: RuntimeMode
  modeOptions: { value: RuntimeMode; label: string }[]
  isolationNote: string | null
  tools: ToolsLine
  env: EnvVar[]
  files: FilesLiveView
  notices: VmNotice[]
  retention: string
  rows: HistoryRowView[]
  /** A run is going on (Reset and Grow wait). */
  runActive: boolean
}

export function vmTabModel(input: VmTabInput): VmTabModel {
  const { vm, botName } = input
  const now = input.now ?? new Date()
  const platform = vmPlatform(vm, input.host)
  const seen = new Set<string>()
  const runs = [...vm.runs, ...(input.olderRuns ?? [])].filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))
  const byId = Object.fromEntries(runs.map((r) => [r.id, r]))
  const ctx: HistoryContext = { botName, budgetBytes: vm.usage.snapshots.budgetBytes, groupNames: input.groupNames, byId, now }
  return {
    botName,
    platform,
    header: vmHeader(vm, botName, platform, now),
    meters: vmMeters(vm),
    internetPolicy: vm.internetPolicy,
    browserOn: vm.permissions.browser,
    browserText: browserText(vm, botName),
    isolation: isolationView(vm, botName, { probe: input.probe, now }),
    runtimeMode: vm.runtime.mode,
    modeOptions: RUNTIME_MODE_OPTIONS(vm.runtime.globalMode),
    isolationNote: vm.isolationNote ?? null,
    tools: toolsLine(vm, botName, now),
    env: vm.env,
    files: filesLive(vm, botName, platform, input.host, now),
    notices: vmNotices(vm, botName, input.host),
    retention: HISTORY_RETENTION_TEXT(vm.usage.snapshots.budgetBytes),
    rows: runs.map((r) => historyRow(r, ctx)),
    runActive: runs.some((r) => r.status === 'queued' || r.status === 'waiting_permission' || r.status === 'running'),
  }
}

/* ---------- run history pages ---------- */

/** One page of GET /api/agents/:id/runs (contract: `{ runs: ScriptRunSummary[], hasMore }`). */
export type RunHistoryPage = { runs: ScriptRunSummary[]; hasMore: boolean }

/** Whether a reply is that page shape (the Phase 1 route on the same path answers with a bare array). */

/**
 * The history list: `vm.runs` paints first, then the first page of GET /script-runs?limit=50 and any
 * "Show older runs" pages follow (deduped by id, newest first). `hasMore` comes only from the
 * server (VmInfo.runsHasMore for first paint, then the latest page's hasMore); no row-count guess.
 */
export function vmHistory(
  vm: { runs: readonly ScriptRunSummary[]; runsHasMore?: boolean },
  first: RunHistoryPage | null,
  older: RunHistoryPage | null,
): { runs: ScriptRunSummary[]; hasMore: boolean; before: string | undefined } {
  const seen = new Set<string>()
  const runs = [...vm.runs, ...(first?.runs ?? []), ...(older?.runs ?? [])].filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))
  // BE 187519a VmInfo.runsHasMore covers first paint; then each page's own hasMore.
  const hasMore = runs.length > 0 && (older ? older.hasMore : first ? first.hasMore : vm.runsHasMore === true)
  return { runs, hasMore, before: runs.at(-1)?.id }
}
