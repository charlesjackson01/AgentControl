/*
 * FE-P2-5: the bot settings VM tab (PHASE2_PLAN.md §14, mockups c-settings-vm-tab-v2{,-lower,-windows}).
 * Pure view model: every line of copy the tab shows, from VmInfo (+ VmHostInfo / VmProbeResult when
 * loaded). Markup: ./vm-tab-render.ts. Component: components/settings/VmTab.tsx. Tests: tests/vm-tab.test.mjs.
 */
import {
  ENV_NAME, MAX_ENV_VALUE_CHARS, MAX_ENV_VARS, RESERVED_ENV_NAMES, RESERVED_ENV_PREFIX, UNDO_RETENTION,
  type ActiveToolBuild, type BotBrowserInfo, type BrowserAddonInfo, type BrowserError, type InternetUse, type ToolBuildInfo,
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
  // FE-P2-10 (M2, mockups m2-11…14; contract fec4670). Shots in shots/p2-fe-10/.
  V13: 'Working "Stop build" in the "Building tools" head (Charles 2026-10-30; mockup 14 has none): enabled, stopping, error, plus "Stopping keeps the current tools (version N)."',
  V14: 'Building tools head while the build is queued (vm_install behind a run) or waiting for the internet OK',
  V15: 'Browser setup failed for low disk (BrowserError low_disk): the contract low-disk sentence under the row, Try again / Turn off',
  V16: 'Browser setup failed in the rebuild (build_failed, including a stopped build): the server message under the row, Try again / Turn off',
  V17: 'Browser being turned off (rebuild back onto the base): "Off. Rebuilding <Bot>\'s tools without the browser…", switch disabled',
  V18: 'Turning the browser off has no confirm (mockup 13 is turn-on only); errors from the switch, Try again, Re-check and Remove download show under the Permissions card',
  V19: 'Turn-on confirm dialog with a 409 (low_disk / internet_never): the server message in the dialog, which stays open',
  V20: 'Browser on, waiting for the shared download to start (setting_up with no download progress yet): "On. Getting headless Chromium ready…"',
  V21: 'History rows: tool builds list their sites (mockup 14 row); ended tool builds; internet always; "Queued · after tool build" only for queuedReason tool_build',
  V22: 'build_active 409 (a click that raced the build starting): the mockup copy "Available when the build finishes." (Team lead), then the tab reloads',
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
  // Mockup 14: while tools build, Stop and Reset wait (both 409 build_active); "Stop build" is the build's own.
  if (vm.activeBuild) return { ...base, badge: 'Building tools', tone: 'run', spinner: true, start: null, stop: true, reset: true, busy: true }
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
/** Mockup 11: the line under the Internet choice, per policy. */
export function internetSub(policy: InternetPolicy, botName: string): string {
  if (policy === 'always') return 'Scripts get the internet without asking. Every site used is listed on the run.'
  if (policy === 'never') return 'Scripts that need the internet are denied without asking.'
  return `${botName} shows a card in the chat when a script needs it. No answer in 10 minutes counts as Deny.`
}

/** Mockup 11: what "Home network & Tailscale" blocks (plan §5). */
export const BLOCKED_RANGES = ['192.168.0.0/16', '10.0.0.0/8', '172.16.0.0/12', '100.64.0.0/10 (Tailscale)', 'fd7a:115c:a1e0::/48', 'localhost', '169.254.169.254'] as const

export function permissionsHint(botName: string): string {
  return `Scripts run without asking. ${botName} asks only for what is off here.`
}

/* ---- low disk (contract fec4670, turn-on flow step 1; Charles 2026-10-30) ---- */

/** The browser download (SHARED_IMAGE_APPROX_BYTES.browser, 1343 MB). */
export const BROWSER_DOWNLOAD_BYTES = 1343 * 1000 ** 2
/** The run floor (RUN_FREE_FLOOR_BYTES, 3 × 1024³). */
export const RUN_FREE_FLOOR_BYTES = 3 * 1024 ** 3
/** M1's run-floor text (BE run-service LOW_DISK_TEXT). */
export const LOW_DISK_TEXT = "This computer is almost out of disk space (less than 3 GB free), so scripts can't run until some space is freed."

/** Free space in 1024³ units, one decimal, rounded down ("2.5"). */
export function freeGbText(freeBytes: number): string {
  return (Math.floor((Math.max(0, freeBytes) / GB) * 10) / 10).toFixed(1)
}

/**
 * The low-disk sentence for turning the browser on, or null when there's room. Compared in bytes:
 * under the download → the mockup sentence; under download + floor → the floor sentence (no ending);
 * a reused download checks only the floor (M1's text).
 */
export function lowDiskText(freeBytes: number, reused = false): string | null {
  if (reused) return freeBytes < RUN_FREE_FLOOR_BYTES ? LOW_DISK_TEXT : null
  const free = freeGbText(freeBytes)
  if (freeBytes < BROWSER_DOWNLOAD_BYTES) return `The download needs about 1.3 GB and this computer has ${free} GB free. Free some space, then try again.`
  if (freeBytes < BROWSER_DOWNLOAD_BYTES + RUN_FREE_FLOOR_BYTES) return `The download needs about 1.3 GB, plus 3 GB kept free for runs, and this computer has ${free} GB free.`
  return null
}

/** A BrowserError low_disk line: the server's message, else built from its bytes, else M1's floor text. */
export function browserLowDiskText(e: Pick<BrowserError, 'message' | 'freeBytes'> | undefined, reused = false): string {
  if (e?.message?.trim()) return e.message.trim()
  return (typeof e?.freeBytes === 'number' ? lowDiskText(e.freeBytes, reused) : null) ?? LOW_DISK_TEXT
}

/* ---- browser row (mockups 11, 12, 13) ---- */

export const BROWSER_SIZE_TEXT = 'about 1.3 GB'

export type BrowserRowView = {
  on: boolean
  text: string
  /** Progress bar: pct null = no figure yet (indeterminate). */
  progress: { pct: number | null; text: string } | null
  sub: string | null
  actions: ('retry' | 'recheck' | 'turn_off' | 'remove')[]
  error: string | null
  /** The switch waits while setup or turn-off is under way. */
  locked: boolean
  gap: keyof typeof VM_TAB_GAPS | null
}

const mbText = (bytes: number) => `${Math.round(bytes / 1000 ** 2)} MB`
const gbDecimal = (bytes: number) => `${(bytes / 1000 ** 3).toFixed(1)} GB`

/** "about 1 min left". */
export function etaText(sec: number | undefined): string | null {
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec < 0) return null
  return `about ${Math.max(1, Math.round(sec / 60))} min left`
}

/** "1:12" from start to now. */
export function elapsedText(startIso: string | undefined, now: Date): string | null {
  const t = startIso ? new Date(startIso).getTime() : NaN
  if (Number.isNaN(t)) return null
  const s = Math.max(0, Math.floor((now.getTime() - t) / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** "today 9:54 AM", else "Oct 19". */
function checkedText(iso: string, now: Date): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return sameDay(d, now) ? `today ${clock(d)}` : historyTime(iso, now)
}

export function browserOffText(botName: string): string {
  return `Off. ${botName} asks in chat when a script needs a browser. Turning it on downloads headless Chromium once (${BROWSER_SIZE_TEXT}, shared by all bots, not counted in ${possessive(botName)} 10 GB). Web pages still follow the Internet rule.`
}

export type BrowserInput = {
  vm: Pick<VmInfo, 'permissions' | 'browser' | 'activeBuild'>
  botName: string
  addon?: BrowserAddonInfo | null
  now?: Date
}

export function browserRow({ vm, botName, addon, now = new Date() }: BrowserInput): BrowserRowView {
  const on = vm.permissions.browser
  const b: BotBrowserInfo = vm.browser ?? { state: on ? 'setting_up' : 'off' }
  const base: BrowserRowView = { on, text: '', progress: null, sub: null, actions: [], error: null, locked: false, gap: null }
  const bot = possessive(botName)
  const total = addon?.totalBytes ?? BROWSER_DOWNLOAD_BYTES
  if (!on) {
    if (b.state === 'rebuilding' || b.state === 'waiting_idle') return { ...base, text: `Off. Rebuilding ${bot} tools without the browser…`, locked: true, gap: 'V17' }
    if (addon?.state === 'ready' && addon.usedBy.length === 0)
      return { ...base, text: `Off. ${botName} asks in chat when a script needs a browser.`, sub: `The Chromium download (${gbDecimal(total)}) is still on this computer and no bot uses it.`, actions: ['remove'] }
    return { ...base, text: browserOffText(botName) }
  }
  const at = (iso: string | undefined) => (iso ? checkedText(iso, now) : '')
  switch (b.state) {
    case 'off':
    case 'setting_up': {
      const p = addon?.state === 'downloading' ? addon.progress ?? vm.permissions.progress : vm.permissions.browserState === 'downloading' ? vm.permissions.progress : undefined
      if (typeof p === 'number') {
        const pct = Math.max(0, Math.min(100, Math.round(p * 100)))
        const bytes = addon?.bytes ?? Math.round(p * total)
        const text = [`${mbText(bytes)} of ${gbDecimal(total)}`, etaText(addon?.etaSec), `then ${bot} tools are rebuilt and its VM restarts when idle`].filter(Boolean).join(' · ')
        return { ...base, text: `On. Downloading headless Chromium (${pct}%)…`, progress: { pct, text }, locked: true }
      }
      return { ...base, text: 'On. Getting headless Chromium ready…', progress: { pct: null, text: `then ${bot} tools are rebuilt and its VM restarts when idle` }, locked: true, gap: 'V20' }
    }
    case 'rebuilding': {
      const build = vm.activeBuild?.build.via === 'browser' ? vm.activeBuild : undefined
      const pg = build?.build.progress
      const pct = pg && pg.steps > 0 ? Math.round((pg.step / pg.steps) * 100) : null
      const started = build?.startedAt ?? b.setup?.rebuild.startedAt
      const el = elapsedText(started, now)
      const text = ['Step 2 of 3', el ? `rebuild ${el}` : null, 'next: restart when idle and check Chromium'].filter(Boolean).join(' · ')
      return { ...base, text: `On. Rebuilding ${bot} tools on the browser base…`, progress: { pct, text }, locked: true }
    }
    case 'waiting_idle':
      return { ...base, text: `On. Ready; ${bot} VM restarts after the current run finishes.`, locked: true }
    case 'ready': {
      const n = addon?.usedBy.length
      const parts = [
        b.chromium ? `Chromium ${b.chromium.version}` : null,
        b.chromium ? `checked ${at(b.chromium.checkedAt)}` : null,
        typeof n === 'number' && n > 0 ? `download shared by ${n} ${n === 1 ? 'bot' : 'bots'} (${gbDecimal(total)})` : null,
      ].filter(Boolean)
      return { ...base, text: 'On. Web pages still follow the Internet rule.', sub: parts.length ? parts.join(' · ') : null }
    }
    case 'error': {
      const e = b.error
      const when = e?.at ? at(e.at) : ''
      const stamp = (label: string) => (when ? `${label} · ${when}` : label)
      switch (e?.reason) {
        case 'chromium_check_failed':
          return {
            ...base,
            text: `On, but Chromium didn't start in ${bot} VM, so ${botName} kept its previous tools.`,
            actions: ['recheck', 'turn_off'],
            error: `Chromium check failed: ${e.detail ?? e.cause ?? e.message}`,
          }
        case 'low_disk':
          return { ...base, text: "On, but headless Chromium couldn't be set up: this computer is low on disk space.", actions: ['retry', 'turn_off'], error: browserLowDiskText(e, b.setup?.download.reused === true), gap: 'V15' }
        case 'build_failed':
          return { ...base, text: `On, but ${bot} tools couldn't be rebuilt on the browser base.`, actions: ['retry', 'turn_off'], error: e.message, gap: 'V16' }
        default: {
          const why = e?.detail ? `: ${e.detail}` : ''
          return { ...base, text: `On, but headless Chromium couldn't be downloaded${why}.`, actions: ['retry', 'turn_off'], error: stamp('Download failed') }
        }
      }
    }
  }
}

/** Mockup 13: the confirm before turning the browser on. */
export function browserConfirm(botName: string, policy: InternetPolicy): { title: string; lead: string; items: string[]; rule: string; confirm: string } {
  const bot = possessive(botName)
  return {
    title: `Turn on the browser for ${botName}?`,
    lead: `${bot} scripts will be able to use headless Chromium (Playwright).`,
    items: [
      `Downloads Chromium once: ${BROWSER_SIZE_TEXT}, shared by all bots, not counted in ${bot} 10 GB.`,
      `Rebuilds ${bot} tools and restarts its VM when it's idle (a few minutes).`,
      `Web pages still follow ${bot} Internet rule: `,
    ],
    rule: INTERNET_OPTIONS.find((o) => o.value === policy)?.label ?? 'Ask each time',
    confirm: 'Turn on browser',
  }
}

/* ---- tool build in progress (mockup 14; BE-P2-21) ---- */

/** "matplotlib and pandas", "a, b and c". */
export function andList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}

export function internetUseText(internet: InternetUse): string {
  if (internet === 'always') return 'internet always allowed'
  if (internet === 'off') return 'no internet needed'
  return 'internet allowed once for this build'
}

export const BUILD_WAIT_TEXT = 'Available when the build finishes.'

export type BuildHeadView = {
  runId: string
  /** "Adding matplotlib and pandas (version 3) · 1:12. New runs wait for the build, then use the new tools." */
  text: string
  progress: { pct: number | null; text: string }
  /** V13: under the Stop build button. */
  stopNote: string
  gap: keyof typeof VM_TAB_GAPS | null
}

function buildWhat(b: ToolBuildInfo): string {
  if (b.added.length) return `Adding ${andList(b.added)} (version ${b.generation})`
  if (b.removed?.length) return `Removing ${andList(b.removed)} (version ${b.generation})`
  if (b.via === 'browser') return `Rebuilding on the ${b.base === 'browser' ? 'browser' : 'standard'} base (version ${b.generation})`
  return `Rebuilding tools (version ${b.generation})`
}

export function buildHead(a: ActiveToolBuild, botName: string, now: Date = new Date()): BuildHeadView {
  const b = a.build
  const stopNote = `Stopping keeps the current tools (version ${b.fromGeneration}).`
  const tail = 'New runs wait for the build, then use the new tools.'
  if (a.status === 'queued')
    return { runId: a.runId, text: `${buildWhat(b)} · waits for ${possessive(botName)} current run to finish. ${tail}`, progress: { pct: null, text: 'Queued' }, stopNote, gap: 'V14' }
  if (a.status === 'waiting_permission')
    return { runId: a.runId, text: `${buildWhat(b)} · waiting for your OK in the chat to use the internet. ${tail}`, progress: { pct: null, text: 'Waiting for permission' }, stopNote, gap: 'V14' }
  const el = elapsedText(a.startedAt, now)
  const pg = b.progress
  const pct = pg && pg.steps > 0 ? Math.round((pg.step / pg.steps) * 100) : null
  const text = [pg ? `Step ${pg.step} of ${pg.steps}` : null, pg?.label || null, internetUseText(a.internet)].filter(Boolean).join(' · ')
  return { runId: a.runId, text: `${buildWhat(b)}${el ? ` · ${el}` : ''}. ${tail}`, progress: { pct, text }, stopNote, gap: null }
}

/** Mockup 14 env card: "Version 2: … · building version 3: + matplotlib, pandas" (names shown as code). */
export type BuildingTools = { from: number; generation: number; added: string[]; removed: string[] }

export function buildingTools(b: ToolBuildInfo): BuildingTools {
  return { from: b.fromGeneration, generation: b.generation, added: [...b.added], removed: [...(b.removed ?? [])] }
}

/** Plain-text form (tests, aria). */
export function buildingToolsText(b: BuildingTools): string {
  const parts = [b.added.length ? `+ ${b.added.join(', ')}` : null, b.removed.length ? `− ${b.removed.join(', ')}` : null].filter(Boolean)
  return `building version ${b.generation}${parts.length ? `: ${parts.join(' ')}` : ''}`
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

/** Mockup 14: "1 file added"; a mix: "1 file added, 2 modified". Falls back to the count. */
export function filesSplitText(run: Pick<ScriptRunSummary, 'files' | 'filesChangedCount'>): string {
  const f = run.files
  if (!f || f.added + f.modified + f.deleted !== run.filesChangedCount || run.filesChangedCount === 0) return filesText(run.filesChangedCount)
  const parts = (['added', 'modified', 'deleted'] as const).filter((k) => f[k] > 0).map((k) => [f[k], k] as const)
  return parts.map(([n, k], i) => (i === 0 ? `${n} ${n === 1 ? 'file' : 'files'} ${k}` : `${n} ${k}`)).join(', ')
}

/** "internet once" / "internet always"; nothing for offline runs. */
export function internetRowText(run: Pick<ScriptRunSummary, 'internet' | 'network'>): string | null {
  const use = run.internet ?? (run.network === 'on' ? 'once' : 'off')
  return use === 'off' ? null : `internet ${use}`
}

function where(run: ScriptRunSummary, names?: Readonly<Record<string, string>>): string {
  if (run.groupId) return names?.[run.groupId] ?? 'group'
  return 'DM'
}

function rowName(run: ScriptRunSummary, byId?: Readonly<Record<string, ScriptRunSummary>>): string {
  if (run.kind === 'tool_build') return run.build ? `Tool build · version ${run.build.generation}` : 'Tool build'
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
  const files = filesSplitText(run)
  const net = internetRowText(run)
  const sites = run.kind === 'tool_build' && run.hosts?.length ? run.hosts.join(', ') : null

  if (run.status === 'queued' && run.queuedReason === 'tool_build') {
    return { ...base, icon: '◌', iconTone: 'run', meta: ['Queued · after tool build', place].join(' · '), action: 'none' }
  }
  if (run.kind === 'tool_build' && run.status === 'running') {
    const el = run.startedAt ? elapsedText(run.startedAt, now) : null
    return { ...base, icon: '⚙', iconTone: 'run', meta: [el ? `Running ${el}` : 'Running', net, sites].filter(Boolean).join(' · '), action: 'output' }
  }
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
  const meta = (run.kind === 'tool_build' ? [head, dur, net, sites] : [head, files, dur, net, place]).filter(Boolean).join(' · ')
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
/** A 409 build_active (BE-P2-22). */
export function isBuildActive(err: unknown): boolean {
  const e = err as { status?: unknown; body?: { reason?: unknown } } | null
  return !!e && e.status === 409 && e.body?.reason === 'build_active'
}

export function vmActionError(err: unknown, fallback: string): string {
  const e = err as { status?: unknown; message?: unknown } | null
  // GAP-V22 (Team lead): one build_active text server-side; the tab shows the mockup's copy.
  if (isBuildActive(err)) return BUILD_WAIT_TEXT
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
  /** The shared Chromium download (GET /api/vm/browser, `browser.updated`). */
  browserAddon?: BrowserAddonInfo | null
  now?: Date
}

export type VmTabModel = {
  botName: string
  platform: VmPlatform
  header: VmHeaderView
  meters: MeterView[]
  internetPolicy: InternetPolicy
  internetSub: string
  browser: BrowserRowView
  /** Mockup 14: the "Building tools" head and environment, while VmInfo.activeBuild is set. */
  build: BuildHeadView | null
  /** "building version 3: + matplotlib, pandas" (env card, during a build). */
  buildingTools: BuildingTools | null
  /** "Go back to version N" (env card during a build; disabled). */
  previousGeneration: number | null
  generation: number
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
  /** A run (or a tool build) is going on (Reset and Grow wait). */
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
    internetSub: internetSub(vm.internetPolicy, botName),
    browser: browserRow({ vm, botName, addon: input.browserAddon, now }),
    build: vm.activeBuild ? buildHead(vm.activeBuild, botName, now) : null,
    buildingTools: vm.activeBuild ? buildingTools(vm.activeBuild.build) : null,
    previousGeneration: vm.image.previous ?? null,
    generation: vm.image.generation,
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
    runActive: !!vm.activeBuild || runs.some((r) => r.status === 'queued' || r.status === 'waiting_permission' || r.status === 'running'),
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
