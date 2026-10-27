/*
 * FE-P2-4: the undo dialog's logic (PHASE2_PLAN §7.3, §7.4; mockup d-undo-confirm).
 * Pure: the phase machine, the preview → rows mapping, and the copy. The markup lives in
 * undo-render.ts (createElement, so tests can render it) and UndoDialog.tsx wraps it in <Dialog>.
 * tests/undo.test.mjs.
 */
import { humanSize } from './file-format.ts'
import { scriptName } from './live-store.ts'
import { UNDO_MACHINE_RESTORED_TEXT, type ScriptRun, type UndoPreview, type UndoPreviewChange, type UndoUnavailableReason } from './types.ts'
import type { UndoError } from './vm-api.ts'

/* ---- copy ---- */

export type UndoReasonContext = {
  /** The bot whose undo space it is ("Analyst's 2 GB undo space"). */
  botName?: string
  /** Its per-bot snapshot budget (VmInfo.usage.snapshots.budgetBytes); 2 GB by default. */
  budgetBytes?: number
  /** too_large: how much the run changed (6.2 GB), when known. */
  changedBytes?: number
}

/**
 * Why undo is gone, §7.4's wording; reused by the run card (FE-P2-2) and run history (FE-P2-5).
 * machine_restored is a full sentence (BE UNDO_MACHINE_RESTORED_TEXT): see undoGoneText.
 */
export function undoReasonText(reason: UndoUnavailableReason, ctx: UndoReasonContext = {}): string {
  switch (reason) {
    case 'expired':
      return 'older than 7 days and not in the last 20 runs'
    case 'budget_bot': {
      const who = ctx.botName ? `${ctx.botName}'s` : "the bot's"
      const size = humanSize(ctx.budgetBytes)
      return `removed to stay within ${who} ${size ? `${size} ` : ''}undo space`
    }
    case 'budget_global':
    case 'low_disk':
      return 'removed to free disk space'
    case 'too_large': {
      const size = humanSize(ctx.changedBytes)
      return size ? `it changed ${size}, more than the undo space` : 'it changed more than the undo space'
    }
    case 'machine_restored':
      return "this bot's computer was restored from a backup"
    default:
      return 'its undo copy was removed'
  }
}

/**
 * "Undo no longer available: <reason>." (the run card's line, §12 v2). machine_restored uses the
 * BE's own sentence (the 410's error text when given, else UNDO_MACHINE_RESTORED_TEXT, Team lead's wording).
 */
export function undoGoneText(reason: UndoUnavailableReason, ctx: UndoReasonContext & { error?: string } = {}): string {
  if (reason === 'machine_restored') return ctx.error?.trim() || UNDO_MACHINE_RESTORED_TEXT
  return `Undo no longer available: ${undoReasonText(reason, ctx)}.`
}

/** The grey note (mockup d): undo never reverses internet side effects or installed tools (§7.3.6). */
export function caveatText(caveats: readonly UndoPreview['caveats'][number][]): string | null {
  const internet = caveats.includes('internet')
  const tools = caveats.includes('tools')
  if (internet && tools) return "Undo changes files only; it can't take back anything a script sent over the internet, or tools it installed."
  if (internet) return "Undo changes files only; it can't take back anything a script sent over the internet."
  if (tools) return "Undo changes files only; it can't take back tools a script installed."
  return null
}

const pad = (n: number) => String(n).padStart(2, '0')
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "today 5:31 PM", "yesterday 9:02 AM", "Oct 12, 5:31 PM" (mockup d's subtitle). Null for bad values. */
export function runWhen(iso: string | undefined, now: Date = new Date()): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const h = d.getHours()
  const time = `${h % 12 === 0 ? 12 : h % 12}:${pad(d.getMinutes())} ${h < 12 ? 'AM' : 'PM'}`
  if (sameDay(d, now)) return `today ${time}`
  const y = new Date(now)
  y.setDate(y.getDate() - 1)
  if (sameDay(d, y)) return `yesterday ${time}`
  return `${MONTHS[d.getMonth()]} ${d.getDate()}${d.getFullYear() === now.getFullYear() ? '' : `, ${d.getFullYear()}`}, ${time}`
}

/** What the run was, for the subtitle and labels: the script, or a tool build / an undo. */
export function runLabel(run: Pick<ScriptRun, 'argv' | 'kind'>): string {
  if (run.kind === 'tool_build') return 'Tool build'
  return scriptName(run)
}

/** "clean_sales.py · today 5:31 PM · Analyst". */
export function undoSubtitle(run: Pick<ScriptRun, 'argv' | 'kind' | 'queuedAt' | 'startedAt'>, botName: string | undefined, now: Date = new Date()): string {
  return [runLabel(run), runWhen(run.startedAt ?? run.queuedAt, now), botName].filter(Boolean).join(' · ')
}

/* ---- rows ---- */

export type UndoRow = {
  key: string
  action: 'delete' | 'restore'
  path: string
  /** "added by this run", "modified by this run", "deleted by this run". */
  note: string
  /** Group-folder rows name the folder (§7.3.5); null for the bot's own files. */
  folder: string | null
}

export type UndoRowContext = {
  /** groupId → its name, so group rows say whose folder they are in. */
  groupNames?: Readonly<Record<string, string>>
}

/** The preview's own groupName (BE 77cc66e) first, then the caller's groupId → name map. */
function folderOf(root: 'agent' | 'group', groupId: string | undefined, groupName: string | undefined, ctx: UndoRowContext): string | null {
  if (root !== 'group') return null
  const name = groupName || (groupId ? ctx.groupNames?.[groupId] : undefined)
  return name ? `${name} group folder` : 'group folder'
}

/** The run's own record of a preview path (same folder: root + groupId, the UndoPreview shape; BE 3a70c34). */
function changeOf(run: Pick<ScriptRun, 'filesChanged'> | undefined, c: Pick<UndoPreviewChange, 'path' | 'root' | 'groupId'>) {
  const files = run?.filesChanged ?? []
  const group = c.root === 'group'
  return files.find((f) => f.path === c.path && (f.root === 'group') === group && (!group || f.groupId === c.groupId))?.change
}

/**
 * The row's grey note (mockup d). delete: "added by this run". restore of a modified file:
 * "151 KB → 158 KB original" (afterBytes → beforeBytes, BE 77cc66e). restore of a file the run
 * deleted (afterBytes null): "deleted by this run · 158 KB original". Without sizes (older BE):
 * "modified by this run" / "deleted by this run" from the run's filesChanged.
 */
export function undoRowNote(c: Pick<UndoPreviewChange, 'action' | 'afterBytes' | 'beforeBytes'>, change?: 'added' | 'modified' | 'deleted'): string {
  if (c.action === 'delete') return 'added by this run'
  const before = typeof c.beforeBytes === 'number' ? humanSize(c.beforeBytes) : null
  const deleted = c.afterBytes === null || (c.afterBytes === undefined && change === 'deleted')
  if (deleted) return before ? `deleted by this run · ${before} original` : 'deleted by this run'
  const after = typeof c.afterBytes === 'number' ? humanSize(c.afterBytes) : null
  if (after && before) return `${after} → ${before} original`
  return 'modified by this run'
}

/** Preview changes → rows (mockup d): delete (red) or restore, with undoRowNote's note. */
export function undoRows(preview: Pick<UndoPreview, 'changes'>, run?: Pick<ScriptRun, 'filesChanged'>, ctx: UndoRowContext = {}): UndoRow[] {
  return preview.changes.map((c, i) => {
    const note = undoRowNote(c, changeOf(run, c))
    return { key: `${i}:${c.root}:${c.groupId ?? ''}:${c.path}`, action: c.action, path: c.path, note, folder: folderOf(c.root, c.groupId, c.groupName, ctx) }
  })
}

export type ConflictRow = { key: string; path: string; folder: string | null }

export function conflictRows(conflicts: UndoPreview['conflicts'], ctx: UndoRowContext = {}): ConflictRow[] {
  return conflicts.map((c, i) => ({ key: `${i}:${c.root}:${c.groupId ?? ''}:${c.path}`, path: c.path, folder: folderOf(c.root, c.groupId, c.groupName, ctx) }))
}

/* ---- phases ---- */

export type UndoPhase =
  /** Fetching the preview (GAP: no mockup). */
  | { kind: 'loading' }
  /** The preview, ready to confirm (mockup d). `error`: the last POST failed for another reason. */
  | { kind: 'ready'; preview: UndoPreview; error?: string }
  /** Files changed since the run: list them, offer "Undo anyway" (force). GAP. */
  | { kind: 'conflicts'; preview: UndoPreview; conflicts: UndoPreview['conflicts']; error?: string }
  /** POST in flight. */
  | { kind: 'submitting'; preview: UndoPreview; conflicts: UndoPreview['conflicts']; force: boolean }
  /** 409 run_active: blocked while the bot has an active run (§7.3.4). GAP. */
  | { kind: 'run_active'; preview?: UndoPreview }
  /**
   * 410: the snapshot is gone, with why (§7.4). GAP. `error`: the 410's text (machine_restored shows it as is);
   * `budgetBytes`: the preview's budget.limitBytes when a preview had loaded.
   */
  | { kind: 'gone'; reason: UndoUnavailableReason; error?: string; budgetBytes?: number }
  /** The preview call failed otherwise. GAP. */
  | { kind: 'error'; message: string }
  /** Undone: the caller closes the dialog. */
  | { kind: 'done' }

export type UndoAction =
  | { type: 'load' }
  | { type: 'preview'; preview: UndoPreview }
  | { type: 'preview_failed'; error: UndoError }
  | { type: 'submit' }
  | { type: 'undo_failed'; error: UndoError }
  | { type: 'undone' }

export const initialUndoPhase: UndoPhase = { kind: 'loading' }

const withConflicts = (preview: UndoPreview, conflicts: UndoPreview['conflicts'], error?: string): UndoPhase =>
  conflicts.length > 0 ? { kind: 'conflicts', preview, conflicts, ...(error ? { error } : {}) } : { kind: 'ready', preview, ...(error ? { error } : {}) }

export function undoReducer(phase: UndoPhase, action: UndoAction): UndoPhase {
  switch (action.type) {
    case 'load':
      return { kind: 'loading' }
    case 'preview':
      return withConflicts(action.preview, action.preview.conflicts)
    case 'preview_failed': {
      const e = action.error
      if (e.kind === 'run_active') return { kind: 'run_active' }
      if (e.kind === 'gone') return { kind: 'gone', reason: e.reason, error: e.message }
      return { kind: 'error', message: e.message }
    }
    case 'submit':
      if (phase.kind === 'ready') return { kind: 'submitting', preview: phase.preview, conflicts: [], force: false }
      // "Undo anyway" exists only while there are conflicts.
      if (phase.kind === 'conflicts') return { kind: 'submitting', preview: phase.preview, conflicts: phase.conflicts, force: true }
      return phase
    case 'undo_failed': {
      if (phase.kind !== 'submitting') return phase
      const e = action.error
      if (e.kind === 'run_active') return { kind: 'run_active', preview: phase.preview }
      if (e.kind === 'gone') {
        const budgetBytes = phase.preview.budget?.limitBytes
        return { kind: 'gone', reason: e.reason, error: e.message, ...(budgetBytes !== undefined ? { budgetBytes } : {}) }
      }
      // Someone changed files between the preview and the click: show them and offer Undo anyway.
      if (e.kind === 'conflicts') return withConflicts(phase.preview, e.conflicts.length > 0 ? e.conflicts : phase.conflicts)
      return withConflicts(phase.preview, phase.conflicts, e.message)
    }
    case 'undone':
      return phase.kind === 'submitting' ? { kind: 'done' } : phase
    default:
      return phase
  }
}

/* ---- view ---- */

export type UndoFooter = {
  /** "Cancel" while undo is possible, "Close" when it isn't. */
  dismiss: 'Cancel' | 'Close'
  /** The main button; absent when there is nothing to confirm. */
  primary?: { label: string; danger: boolean; disabled: boolean; action: 'undo' | 'retry' }
  busy: boolean
}

export function undoFooter(phase: UndoPhase): UndoFooter {
  switch (phase.kind) {
    case 'loading':
      return { dismiss: 'Cancel', primary: { label: 'Undo run', danger: true, disabled: true, action: 'undo' }, busy: false }
    case 'ready':
      return phase.preview.changes.length === 0
        ? { dismiss: 'Close', busy: false }
        : { dismiss: 'Cancel', primary: { label: 'Undo run', danger: true, disabled: false, action: 'undo' }, busy: false }
    case 'conflicts':
      return { dismiss: 'Cancel', primary: { label: 'Undo anyway', danger: true, disabled: false, action: 'undo' }, busy: false }
    case 'submitting':
      return { dismiss: 'Cancel', primary: { label: 'Working…', danger: true, disabled: true, action: 'undo' }, busy: true }
    case 'run_active':
    case 'error':
      return { dismiss: 'Close', primary: { label: 'Try again', danger: false, disabled: false, action: 'retry' }, busy: false }
    case 'gone':
    case 'done':
      return { dismiss: 'Close', busy: false }
  }
}

/** Copy for the non-mockup states (all GAP). */
export function runActiveText(botName: string | undefined): string {
  return `${botName ?? 'The bot'} is running a script right now. You can undo once it finishes.`
}
export const CONFLICTS_TEXT = 'These files changed after this run, by a later run or by you. Undo anyway puts back how they were before this run, and their newer changes are lost:'
export const NOTHING_TEXT = "This run didn't change any files, so there's nothing to undo."
export const INTRO_TEXT = 'Your files go back to how they were right before this run:'
