/*
 * FE-P2-6: Settings › VMs view model (M3 plan §5, mockups m3-01…m3-10).
 * Pure. Markup: components/settings/VmsSection.tsx. Tests: tests/vms-page.test.mjs.
 *
 * States with no mockup are listed in VMS_PAGE_GAPS and built in the same cards.
 */
import { humanSize } from './file-format.ts'
import {
  SCRIPT_RUN_ACTIVE, SNAPSHOT_BUDGET_BOUNDS, VM_MACHINE_DEFAULTS,
  type BackupInfo, type BackupRestoreResult, type BrowserAddonInfo, type GlobalRuntimeMode, type ScriptRunStatus, type VmHostInfo, type VmProbeResult, type VmSettingsView,
} from './types.ts'

export const VMS_PAGE_GAPS = {
  G1: 'Backup row while status is in_progress: pill "In progress", "N of M" in the detail when progress is set, no Restore',
  G2: 'A failed restore shows the server message under the backup list (inline, not a toast)',
  G3: 'Grow 400 (low disk and the other grow refusals) shows the server message under the Grow button',
  G4: 'Remove download confirm for the shared Chromium image',
  G5: 'Linux host with machine null: no Podman machine disk to grow',
  G6: 'Phone settings section switcher sits at the bottom of the pane (the 390 mockup has no nav)',
  G7: 'A failed backup row: pill "Failed" and the error, no Restore',
  G8: 'Undone host setup steps (including a future firewall-image step) listed above the cards',
  G9: "Restore answered 200 with BackupRestoreResult tools:'failed': the bot name and toolsMessage under the backup list",
} as const

export const SETTINGS_TITLE = 'Settings'
export const SETTINGS_SUBTITLE = 'Profile, endpoints, appearance, and VMs.'

export const ACCOUNT_SECTIONS = [
  { id: 'profile', label: 'Profile' },
  { id: 'endpoints', label: 'Endpoints' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'vms', label: 'VMs' },
  { id: 'runtime', label: 'Runtime' },
  { id: 'danger', label: 'Danger' },
] as const

export type AccountSection = (typeof ACCOUNT_SECTIONS)[number]['id']

export function accountSection(id: string | null | undefined): AccountSection {
  return ACCOUNT_SECTIONS.some((s) => s.id === id) ? (id as AccountSection) : 'profile'
}

const GVISOR_MODES: { value: GlobalRuntimeMode; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'force_on', label: 'Force on' },
  { value: 'force_off', label: 'Force off' },
]
export const GVISOR_MODE_OPTIONS = GVISOR_MODES

export const GVISOR_HINT = 'Default for every bot that uses "Use global". Bots can still Force on or Force off in their own VM tab.'
export const GVISOR_MODE_SUB = 'Auto picks gVisor when the probe passes.'
export const GROW_HINT = 'Grows on demand. Host needs free space for the new size.'
export const GROW_BUSY_HINT = 'Grow is unavailable while a bot has a run in progress.'
export const BUDGET_INTRO = "Undo space. Eviction keeps each bot's newest snapshot when possible."
export const DOWNLOADS_INTRO = "Images shared by every bot. They do not count against each bot's 10 GB."
export const OPEN_VMS_LABEL = 'Open Settings › VMs'
export const LOAD_ERROR_TITLE = "Couldn't load VMs settings"
export const LOAD_ERROR_TEXT = 'Check that AgentControl is running, then try again.'
export const BACKUP_LIST_ERROR = "Couldn't load backups. Check that AgentControl is running, then try again."
export const RESTORE_BODY = "Restores personal data and the tool manifest into the current machine. Snapshots from before the restore won't be undoable (reason: machine restored). Active runs must finish first."
export const BASE_IMAGE_SUB = 'Built locally · ready'

const TRIGGER_LABEL: Record<BackupInfo['trigger'], string> = {
  nightly: 'Nightly',
  manual: 'Back up now',
  pre_reset: 'Before Reset',
  pre_upgrade: 'Before upgrade',
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function isWindowsHost(host: Pick<VmHostInfo, 'os' | 'storage'> | null | undefined): boolean {
  return !!host && (host.storage.backend === 'wsl' || host.os === 'win32')
}

export function runsLookActive(runs: readonly { status?: ScriptRunStatus | string }[]): boolean {
  return runs.some((r) => typeof r.status === 'string' && (SCRIPT_RUN_ACTIVE as readonly string[]).includes(r.status))
}

function clock(d: Date): string {
  const h = d.getHours()
  const m = String(d.getMinutes()).padStart(2, '0')
  return `${h % 12 === 0 ? 12 : h % 12}:${m} ${h < 12 ? 'AM' : 'PM'}`
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

function dayBefore(a: Date, b: Date): boolean {
  const y = new Date(b.getFullYear(), b.getMonth(), b.getDate() - 1)
  return sameDay(a, y)
}

/** "03:00" → "3:00 AM". Anything else is returned unchanged. */
export function clockFromHHMM(time: string): string {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time)
  if (!m) return time
  const h = Number(m[1])
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`
}

/** "Today, 3:00 AM" / "Yesterday, 3:00 AM" / "Nov 4, 4:12 PM". */
export function backupWhen(iso: string, now: Date = new Date()): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const t = clock(d)
  if (sameDay(d, now)) return `Today, ${t}`
  if (dayBefore(d, now)) return `Yesterday, ${t}`
  const year = d.getFullYear() === now.getFullYear() ? '' : `, ${d.getFullYear()}`
  return `${MONTHS[d.getMonth()]} ${d.getDate()}${year}, ${t}`
}

export function backupWho(b: Pick<BackupInfo, 'agentIds'>, names: ReadonlyMap<string, string>): string {
  if (b.agentIds.length === 1) return names.get(b.agentIds[0]) ?? '1 bot'
  return `${b.agentIds.length} bots`
}

/** "1 of 3" while a backup is running and the server sent progress. */
export function backupProgressText(b: Pick<BackupInfo, 'status' | 'progress'>): string | null {
  if (b.status !== 'in_progress' || !b.progress) return null
  const { done, total } = b.progress
  if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return null
  return `${done} of ${total}`
}

export function backupDetail(b: BackupInfo, names: ReadonlyMap<string, string>): string {
  const base = `${TRIGGER_LABEL[b.trigger]} · ${backupWho(b, names)}`
  const progress = backupProgressText(b)
  return progress ? `${base} · ${progress}` : base
}

function backupEqual(a: BackupInfo, b: BackupInfo): boolean {
  return a.id === b.id && a.createdAt === b.createdAt && a.trigger === b.trigger && a.bytes === b.bytes
    && a.path === b.path && a.status === b.status && a.error === b.error && a.finishedAt === b.finishedAt
    && a.progress?.done === b.progress?.done && a.progress?.total === b.progress?.total
    && a.agentIds.length === b.agentIds.length && a.agentIds.every((id, i) => id === b.agentIds[i])
}

/** Newest first. An incoming row replaces the same id (live progress) or is inserted. */
export function mergeBackupList(list: readonly BackupInfo[], incoming: readonly BackupInfo[]): BackupInfo[] {
  if (incoming.length === 0) return list as BackupInfo[]
  const byId = new Map(list.map((b) => [b.id, b]))
  let changed = false
  for (const b of incoming) {
    const prev = byId.get(b.id)
    if (prev && backupEqual(prev, b)) continue
    byId.set(b.id, b)
    changed = true
  }
  if (!changed) return list as BackupInfo[]
  return [...byId.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
}

/** The live store's backup map: same id, unchanged row keeps the previous record. */
export function mergeBackupRecord(record: Readonly<Record<string, BackupInfo>>, backup: BackupInfo): Record<string, BackupInfo> {
  const prev = record[backup.id]
  if (prev && backupEqual(prev, backup)) return record
  return { ...record, [backup.id]: backup }
}

/**
 * Shown under the backup list after a 200 restore when a bot's tools did not come back.
 * No mockup (GAP-G9). `null` when every bot is 'started' or 'not_needed'.
 */
export function restoreToolsNote(result: BackupRestoreResult, names: ReadonlyMap<string, string>): string | null {
  const lines = result.agents.filter((a) => a.tools === 'failed').map((a) => {
    const name = names.get(a.agentId) ?? a.agentId
    const why = a.toolsMessage?.trim()
    return why ? `${name}: ${why}` : `${name}: tools didn't start after the restore.`
  })
  return lines.length ? lines.join('\n') : null
}

/**
 * The low-disk sentence when a backup can't start (507, with reason `low_disk` or with no reason —
 * BE-P2-18 still answers 507 with no reason). Same inline treatment as Grow: the server's sentence.
 * `no_bots` / `backup_incomplete` / `backup_failed` use the server message. Anything else is null
 * so the caller keeps its own fallback.
 */
export const BACKUP_LOW_DISK_FALLBACK = 'Not enough free disk space for a backup. Free some space, then try again.'

const BACKUP_CARD_REASONS = new Set(['no_bots', 'backup_incomplete', 'backup_failed'])

export function backupCardError(status: number | undefined, body: unknown): string | null {
  const rec = body && typeof body === 'object' ? body as { reason?: unknown; message?: unknown } : undefined
  const reason = typeof rec?.reason === 'string' ? rec.reason : undefined
  const message = typeof rec?.message === 'string' ? rec.message.trim() : ''
  if (status === 507 || reason === 'low_disk') return message || BACKUP_LOW_DISK_FALLBACK
  if (reason && BACKUP_CARD_REASONS.has(reason)) return message || null
  return null
}

export type BackupRowView = {
  id: string
  when: string
  detail: string
  size: string
  status: BackupInfo['status']
  statusLabel: string
  error: string | null
  canRestore: boolean
}

const STATUS_LABEL: Record<BackupInfo['status'], string> = {
  complete: 'Complete',
  failed: 'Failed',
  in_progress: 'In progress',
}

export function backupRow(b: BackupInfo, names: ReadonlyMap<string, string>, now: Date = new Date()): BackupRowView {
  return {
    id: b.id,
    when: backupWhen(b.createdAt, now),
    detail: backupDetail(b, names),
    size: humanSize(b.bytes) ?? `${b.bytes} B`,
    status: b.status,
    statusLabel: STATUS_LABEL[b.status],
    error: b.error?.trim() ? b.error.trim() : null,
    canRestore: b.status === 'complete',
  }
}

export function machineSubtitle(host: VmHostInfo): string | null {
  const m = host.machine
  if (!m) return null
  const ram = Math.round(m.memoryMb / 1024)
  let where: string
  if (isWindowsHost(host)) where = 'Podman machine on Windows (WSL2)'
  else if (host.os === 'darwin') where = `Podman machine on this Mac${host.provider && host.provider !== 'native' ? ` (${host.provider})` : ''}`
  else where = 'Podman on this computer'
  return `${m.name} · ${where} · ${ram} GB RAM · ${m.cpus} vCPU`
}

export function diskUsedText(host: VmHostInfo): string | null {
  const m = host.machine
  if (!m) return null
  return `${Math.round(m.diskUsedGb)} of ${Math.round(m.diskGb)} GB used`
}

export function diskFraction(host: VmHostInfo): number {
  const m = host.machine
  if (!m || m.diskGb <= 0) return 0
  return Math.max(0, Math.min(1, m.diskUsedGb / m.diskGb))
}

export function growButtonLabel(toGb: number): string {
  return `Grow to ${toGb} GB...`
}

export function growConfirmTitle(toGb: number): string {
  return `Grow disk to ${toGb} GB?`
}

export function growConfirmBody(toGb: number): string {
  return `The Podman machine disk grows to ${toGb} GB. This needs free space on this computer and can't run while a bot has an active run.`
}

export function growConfirmLabel(toGb: number): string {
  return `Grow to ${toGb} GB`
}

const MACHINE_STATE: Record<NonNullable<VmHostInfo['machine']>['state'], string> = {
  running: 'Running',
  stopped: 'Stopped',
  starting: 'Starting',
  missing: 'Not set up',
  error: 'Error',
}

export function machineStateLabel(host: VmHostInfo): string | null {
  return host.machine ? MACHINE_STATE[host.machine.state] : null
}

export function probeWhen(iso: string | null | undefined, now: Date = new Date()): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const t = clock(d)
  if (sameDay(d, now)) return `today ${t}`
  if (dayBefore(d, now)) return `yesterday ${t}`
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${t}`
}

/** "Active · runsc 0.1 · checked today 9:11 AM" / "Active · runsc · idmap ok · chromium ok · checked today 9:11 AM". */
export function probeSummary(probe: VmProbeResult | null | undefined, now: Date = new Date()): string {
  if (!probe?.checkedAt) return 'No probe yet.'
  const parts: string[] = [probe.compatible ? 'Active' : 'Check failed']
  if (probe.runsc.installed) parts.push(probe.runsc.version ? `runsc ${probe.runsc.version}` : 'runsc')
  else parts.push('runsc not installed')
  if (probe.uidMapping) parts.push(`${probe.uidMapping} ok`)
  if (probe.checks?.some((c) => c.id === 'chromium' && c.status === 'pass')) parts.push('chromium ok')
  const when = probeWhen(probe.checkedAt, now)
  if (when) parts.push(`checked ${when}`)
  return parts.join(' · ')
}

export function gvisorBadge(settings: VmSettingsView, probe: VmProbeResult | null | undefined): { label: string; on: boolean } {
  if (settings.gvisor === 'force_off') return { label: 'Off', on: false }
  if (probe && probe.checkedAt && !probe.compatible && settings.gvisor === 'force_on') return { label: 'Unavailable', on: false }
  return { label: 'Active', on: true }
}

export type BudgetDraft = { perBotMb: string; globalMb: string; freeFloorMb: string }
export type BudgetErrors = { perBotMb: string | null; globalMb: string | null; freeFloorMb: string | null }

function whole(raw: string): number | null {
  const t = raw.trim()
  if (!/^\d+$/.test(t)) return null
  const n = Number(t)
  return Number.isSafeInteger(n) ? n : null
}

function rangeError(n: number | null, min: number, max: number): string | null {
  if (n === null || n < min || n > max) return `Must be a whole number from ${min} to ${max}.`
  return null
}

/** Live bounds text from mockup 06. The per-bot line is the cross-field rule when both numbers parse and per-bot is larger. */
export function budgetErrors(draft: BudgetDraft): BudgetErrors {
  const per = whole(draft.perBotMb)
  const global = whole(draft.globalMb)
  const floor = whole(draft.freeFloorMb)
  const b = SNAPSHOT_BUDGET_BOUNDS
  let perErr = rangeError(per, b.perBotMb.min, b.perBotMb.max)
  const globalErr = rangeError(global, b.globalMb.min, b.globalMb.max)
  const floorErr = rangeError(floor, b.freeFloorMb.min, b.freeFloorMb.max)
  if (per !== null && global !== null && per > global) perErr = "Per-bot budget can't be larger than the global budget."
  return { perBotMb: perErr, globalMb: globalErr, freeFloorMb: floorErr }
}

export function budgetDraftFrom(settings: VmSettingsView): BudgetDraft {
  const s = settings.snapshotBudget
  return { perBotMb: String(s.perBotMb), globalMb: String(s.globalMb), freeFloorMb: String(s.freeFloorMb) }
}

export function budgetPatch(draft: BudgetDraft): { perBotMb: number; globalMb: number; freeFloorMb: number } | null {
  const e = budgetErrors(draft)
  if (e.perBotMb || e.globalMb || e.freeFloorMb) return null
  return { perBotMb: whole(draft.perBotMb)!, globalMb: whole(draft.globalMb)!, freeFloorMb: whole(draft.freeFloorMb)! }
}

export const BUDGET_HINTS = {
  perBotMb: `${SNAPSHOT_BUDGET_BOUNDS.perBotMb.min}–${SNAPSHOT_BUDGET_BOUNDS.perBotMb.max} · default ${2048}`,
  globalMb: `${SNAPSHOT_BUDGET_BOUNDS.globalMb.min}–${SNAPSHOT_BUDGET_BOUNDS.globalMb.max} · default ${15360}`,
  freeFloorMb: `${SNAPSHOT_BUDGET_BOUNDS.freeFloorMb.min}–${SNAPSHOT_BUDGET_BOUNDS.freeFloorMb.max} · default ${5120}`,
} as const

export function backupsIntro(settings: VmSettingsView, host: VmHostInfo): string {
  const path = isWindowsHost(host)
    ? 'Windows path: %LOCALAPPDATA%\\AgentControl\\backups\\<date>\\'
    : 'Mac/Linux path: data/backups/'
  return `Nightly at ${settings.backups.time} local · keep ${settings.backups.keep}. Personal data + tool manifest as tar.zst. Snapshots are excluded. ${path}`
}

export function backupsEmptyText(time: string): string {
  return `No backups yet. Nightly runs at ${clockFromHHMM(time)} local, or tap Back up now.`
}

export function scheduleLine(settings: VmSettingsView): string {
  return `Time ${settings.backups.time} · Keep last ${settings.backups.keep}`
}

export type WindowsWarning = {
  title: string
  body: string
  rows: { risk: string; then: string }[]
  location: string
}

export function windowsWarning(host: VmHostInfo): WindowsWarning | null {
  if (!isWindowsHost(host)) return null
  const name = host.machine?.name ?? VM_MACHINE_DEFAULTS.name
  return {
    title: 'Windows — bot files live inside the Podman machine',
    body: `Removing the ${name} machine, unregistering its WSL distro, or resetting Podman deletes live bot files, tools and snapshots. Nightly backups are on by default and kept under %LOCALAPPDATA%\\AgentControl\\backups\\.`,
    rows: [
      { risk: 'podman machine rm / reset or WSL unregister', then: 'restore from a backup' },
      { risk: 'VHDX corruption / full Windows drive', then: 'keep free space; backups mitigate' },
      { risk: 'New PC', then: 'copy the backups folder, then Restore' },
    ],
    location: "On Windows, archives are kept under %LOCALAPPDATA%\\AgentControl\\backups\\<date>\\. Size counts against the Windows drive, not each bot's 10 GB.",
  }
}

export function linuxNativeText(): string {
  return 'Bots run on this Linux computer. There is no Podman machine disk to grow.'
}

export type DownloadRow = {
  id: string
  name: string
  sub: string
  remove: boolean
  required: boolean
}

function usedByText(n: number): string {
  return n === 1 ? 'used by 1 bot' : `used by ${n} bots`
}

export function sharedDownloads(browser: BrowserAddonInfo | null | undefined): DownloadRow[] {
  const n = browser?.usedBy.length ?? 0
  const state = browser?.state ?? 'absent'
  const stateWord = state === 'ready' ? 'ready' : state === 'downloading' ? 'downloading' : state === 'error' ? 'failed' : 'not downloaded'
  const browserRow: DownloadRow = {
    id: 'botvm-browser',
    name: 'botvm-browser',
    sub: `Headless Chromium · about 1.3 GB · ${stateWord} · ${usedByText(n)}`,
    remove: state === 'ready' && n === 0,
    required: false,
  }
  const base: DownloadRow = { id: 'botvm', name: 'botvm (base)', sub: BASE_IMAGE_SUB, remove: false, required: true }
  return [browserRow, base]
}

export const REMOVE_DOWNLOAD_BODY = 'Removes the shared headless Chromium image (about 1.3 GB). Bots still using the browser have to turn it off first.'

export type SetupStepView = { id: string; text: string; helpUrl?: string }

export function undoneSetup(host: VmHostInfo): SetupStepView[] {
  return host.setupSteps.filter((s) => !s.done).map((s) => ({ id: s.id, text: s.text, ...(s.helpUrl ? { helpUrl: s.helpUrl } : {}) }))
}

export function restoreSubtitle(row: BackupRowView): string {
  return `${row.when} · ${row.detail} · ${row.size}`
}
