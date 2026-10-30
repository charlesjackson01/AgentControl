/**
 * BE-P2-11: undo of a script run (plan §7.3).
 *
 * - preview: what undo would do (delete what the run added, restore what it modified or
 *   deleted), the conflicts (a file whose state now differs from what the run left), the caveats
 *   (internet side effects and installed tools aren't reversed) and the bot's undo budget.
 * - apply: 409 `conflicts` (with the list) unless `force`, which overwrites the conflicting files
 *   the run touched. It runs in the bot's run slot (so it waits for, and blocks, the bot's runs),
 *   takes its own snapshot (the undo is a run, "undo of R", which is itself undoable), writes each
 *   file atomically through the StorageBackend (temp + rename) and marks R undone.
 * - 409 `run_active` while the bot has a run queued or running; 409 `already_undone`; 410 with
 *   the eviction reason when R's snapshot is gone (`expired` when even the record was pruned).
 *
 * The routes (/api/runs/:runId/undo[/preview]) and the ScriptRun records are BE-P2-17/BE-P2-12;
 * this service is what they call (app.vmUndo).
 */
import type { Agent, FileChange, ScriptRunUndo, UndoPreview, UndoPreviewChange } from './shared/types.js'
import { fail, failWithReason } from './http.js'
import type { SnapshotOutcome, SnapshotService, SnapshotZone, UndoSourceEntry, ZoneInfo } from './snapshot.js'
import { undoUnavailableText } from './snapshot-budget.js'
import type { EntryInfo, RestoreSource, StorageBackend, VolPath } from './storage/types.js'

export const UNDO_CAVEATS: UndoPreview['caveats'] = ['internet', 'tools']
export const UNDO_RUN_ACTIVE_TEXT = 'Wait for the bot\'s run to finish first.'
export const UNDO_ALREADY_DONE_TEXT = 'This run was already undone. To bring its changes back, undo the undo.'

/** Where one of the run's zones is now: its snapshot zone (host folder) and its StorageBackend location. */
export interface ResolvedZone {
  zone: SnapshotZone
  /** The volume root the zone's files are under (e.g. bots/<slug>, groups/<slug>). */
  vol: VolPath
  /** The zone folder's segments under `vol` (e.g. ['workspace'], ['shared']). */
  sub: string[]
}

export interface UndoDeps {
  snapshots: SnapshotService
  storage: () => StorageBackend
  /** A zone of the run, as it is now (a group folder that still exists, member or not), or null. */
  zone: (agent: Agent, info: ZoneInfo) => ResolvedZone | null
  /** The volume path of a host path under the volume (the retained originals), or null. */
  volOf: (hostPath: string) => VolPath | null
  activeRuns: (agentId: string) => number
  /** Run `fn` in the bot's run slot (ContainerRunner.exclusive). */
  exclusive: <T>(agentId: string, fn: () => Promise<T>) => Promise<T>
  /** Stop the bot's container (overlay: undo writes the real folders). */
  stopBot: (agent: Agent) => Promise<void>
  newRunId: () => string
  /** After the undo run's snapshot (budget eviction, like any run); its undo state. */
  afterUndo?: (slug: string, runId: string) => ScriptRunUndo | null
  /** The bot's undo budget for the preview. */
  usage?: (slug: string) => { bytes: number; budgetBytes: number }
  /** For the 410 text ('budget_bot'). */
  perBotBytes?: () => number
  log?: (msg: string) => void
}

export interface UndoSkipped {
  path: string
  root: 'agent' | 'group'
  groupId?: string
  groupName?: string
  /** group_gone: the group folder no longer exists; folder: a folder is there now; original_missing: the retained copy is gone. */
  why: 'group_gone' | 'folder' | 'original_missing'
}

export interface UndoApplyResult {
  /** The run that was undone, and its new undo state ('done'). */
  runId: string
  undo: ScriptRunUndo
  /** The undo run (kind 'undo', undoOfRunId = runId): its snapshot, files and undo state. */
  undoRunId: string
  snapshot: SnapshotOutcome['snapshot']
  filesChanged: FileChange[]
  undoRunUndo: ScriptRunUndo
  /** Files undo left alone (see UndoSkipped.why). */
  skipped: UndoSkipped[]
}

export interface UndoService {
  preview(agent: Agent, runId: string): UndoPreview
  apply(agent: Agent, runId: string, opts?: { force?: boolean }): Promise<UndoApplyResult>
}

interface Planned {
  entry: UndoSourceEntry
  where: ResolvedZone | null
  parts: string[]
  conflict: boolean
}

const where = (e: UndoSourceEntry) => ({
  path: e.path, root: e.root, ...(e.groupId ? { groupId: e.groupId } : {}), ...(e.groupName ? { groupName: e.groupName } : {}),
})

function safeRel(rel: string): string[] | null {
  const parts = rel.split('/')
  return rel && parts.every((p) => p && p !== '.' && p !== '..' && !p.includes('\\') && !p.includes('\0')) ? parts : null
}

export function createUndoService(deps: UndoDeps): UndoService {
  const log = deps.log ?? (() => {})

  /** R's undo source, or the 410/409 for its state. */
  function source(agent: Agent, runId: string): { entries: UndoSourceEntry[]; zones: ZoneInfo[] } {
    const meta = deps.snapshots.read(agent.slug, runId)
    if (!meta) {
      // No record: never snapshotted, or pruned (outside the last 20 runs and older than 7 days).
      failWithReason(410, 'expired', undoUnavailableText({ reason: 'expired' }, agent.name, deps.perBotBytes?.() ?? 0))
    }
    if (meta.undo?.state === 'unavailable') {
      const reason = meta.undo.reason ?? 'expired'
      failWithReason(410, reason, undoUnavailableText(meta.undo, agent.name, deps.perBotBytes?.() ?? 0))
    }
    if (meta.undo?.state === 'done') failWithReason(409, 'already_undone', UNDO_ALREADY_DONE_TEXT)
    const entries = deps.snapshots.undoSource(agent.slug, runId)
    if (!entries) failWithReason(410, 'expired', undoUnavailableText({ reason: 'expired' }, agent.name, deps.perBotBytes?.() ?? 0))
    return { entries, zones: meta.zones }
  }

  /** Whether the file differs from what the run left (or, for a deleted file, whether something is there). */
  function differs(fs: StorageBackend, w: ResolvedZone, parts: string[], e: UndoSourceEntry): boolean {
    const full = [...w.sub, ...parts]
    let now: EntryInfo | null
    try {
      now = fs.inspect(w.vol, full)
    } catch {
      return true // e.g. a folder on the way is now a link
    }
    if (e.change === 'deleted') return now !== null
    const after = e.after
    if (!now || !after) return true
    if (after.kind === 'symlink') return now.kind !== 'symlink' || now.target !== (after.target ?? now.target)
    if (now.kind !== 'file') return true
    if (after.size !== undefined && now.size !== after.size) return true
    if (after.mtimeMs !== undefined && Math.floor(now.mtimeMs) === after.mtimeMs) return false
    if (!e.afterSha) return after.mtimeMs !== undefined
    const hashed = fs.inspect(w.vol, full, { hash: true })
    return hashed?.kind !== 'file' || hashed.sha256 !== e.afterSha
  }

  function plan(agent: Agent, runId: string): { items: Planned[]; zones: ResolvedZone[] } {
    const { entries, zones } = source(agent, runId)
    const fs = deps.storage()
    const resolved = new Map<string, ResolvedZone | null>()
    for (const z of zones) resolved.set(z.key, deps.zone(agent, z))
    const items: Planned[] = []
    for (const e of entries) {
      const parts = safeRel(e.rel)
      if (!parts) {
        // A crafted record: never touched.
        log(`undo: ${agent.slug}: run ${runId}: refusing the path ${JSON.stringify(e.rel.slice(0, 80))}`)
        fail(400, 'This run\'s undo record has a path that isn\'t valid, so it can\'t be undone.')
      }
      const w = resolved.get(e.zone) ?? null
      items.push({ entry: e, where: w, parts, conflict: w === null || differs(fs, w, parts, e) })
    }
    return { items, zones: [...resolved.values()].filter((z): z is ResolvedZone => z !== null) }
  }

  const conflictsOf = (items: Planned[]): UndoPreview['conflicts'] =>
    items.filter((i) => i.conflict).map((i) => {
      const { path, root, groupId, groupName } = where(i.entry)
      return { path, root, ...(groupId ? { groupId } : {}), ...(groupName ? { groupName } : {}) }
    })

  function conflictText(n: number): string {
    return n === 1
      ? '1 file changed after this run. Undo anyway to overwrite it with the version from before the run.'
      : `${n} files changed after this run. Undo anyway to overwrite them with the versions from before the run.`
  }

  function preview(agent: Agent, runId: string): UndoPreview {
    const { items } = plan(agent, runId)
    const changes: UndoPreviewChange[] = items.map(({ entry: e }) => ({
      ...where(e),
      action: e.change === 'added' ? 'delete' : 'restore',
      afterBytes: e.change === 'deleted' ? null : e.after?.kind === 'file' ? (e.after.size ?? null) : null,
      beforeBytes: e.change === 'added' ? null : e.original?.kind === 'file' ? e.original.size : (e.beforeSize ?? null),
    }))
    const u = deps.usage?.(agent.slug)
    return {
      runId,
      changes,
      conflicts: conflictsOf(items),
      caveats: [...UNDO_CAVEATS],
      ...(u ? { budget: { usedBytes: u.bytes, limitBytes: u.budgetBytes } } : {}),
    }
  }

  async function apply(agent: Agent, runId: string, opts: { force?: boolean } = {}): Promise<UndoApplyResult> {
    const force = opts.force === true
    if (deps.activeRuns(agent.id) > 0) failWithReason(409, 'run_active', UNDO_RUN_ACTIVE_TEXT)
    const first = plan(agent, runId)
    const c0 = conflictsOf(first.items)
    if (c0.length && !force) failWithReason(409, 'conflicts', conflictText(c0.length), { conflicts: c0 })
    return deps.exclusive(agent.id, async () => {
      // Re-checked in the run slot: a run queued meanwhile may have changed files (or evicted R).
      const { items, zones } = plan(agent, runId)
      const c = conflictsOf(items)
      if (c.length && !force) failWithReason(409, 'conflicts', conflictText(c.length), { conflicts: c })
      const release = deps.snapshots.hold(agent.slug, runId)
      try {
        if (deps.snapshots.needsStop(agent)) await deps.stopBot(agent)
        const undoRunId = deps.newRunId()
        const h = await deps.snapshots.begin(agent, undoRunId, { zones: zones.map((z) => z.zone), undoOf: runId })
        if (!h) fail(503, 'Undo isn\'t available right now: undo snapshots are off on this computer.')
        const fs = deps.storage()
        const skipped: UndoSkipped[] = []
        let thrown: unknown
        // Deletions first (deepest first), so a file can come back where the run put a folder's contents.
        const ordered = [...items].sort((a, b) => {
          const da = a.entry.change === 'added' ? 0 : 1
          const db = b.entry.change === 'added' ? 0 : 1
          return da - db || (da === 0 ? b.parts.length - a.parts.length : 0)
        })
        try {
          for (const it of ordered) {
            const e = it.entry
            const w = it.where
            if (!w) {
              skipped.push({ ...where(e), why: 'group_gone' })
              continue
            }
            const full = [...w.sub, ...it.parts]
            let src: RestoreSource
            if (e.change === 'added') src = { kind: 'absent' }
            else if (e.original?.kind === 'symlink') src = { kind: 'symlink', target: e.original.target }
            else if (e.original?.kind === 'file') {
              const from = deps.volOf(e.original.file)
              if (!from) {
                skipped.push({ ...where(e), why: 'original_missing' })
                continue
              }
              src = { kind: 'file', from, mode: e.original.mode ?? 0o644 }
            } else {
              skipped.push({ ...where(e), why: 'original_missing' })
              continue
            }
            const now = (() => {
              try {
                return fs.inspect(w.vol, full)
              } catch {
                return null
              }
            })()
            if (now?.kind === 'dir') {
              skipped.push({ ...where(e), why: 'folder' })
              continue
            }
            deps.snapshots.retain(h, w.zone.key, e.rel)
            fs.restore(w.vol, full, src)
          }
        } catch (x) {
          thrown = x
        }
        // Every outcome is recorded: a partial undo is itself a run that can be undone.
        const o = await deps.snapshots.finish(h)
        if (thrown) {
          log(`undo: ${agent.slug}: undoing run ${runId} stopped partway (undo run ${undoRunId} recorded): ${(thrown as Error).message}`)
          throw thrown
        }
        const undone = deps.snapshots.markUndone(agent.slug, runId, undoRunId)
        const undoRunUndo = deps.afterUndo?.(agent.slug, undoRunId) ?? o.meta.undo ?? { state: 'available' }
        if (skipped.length) log(`undo: ${agent.slug}: run ${runId}: left ${skipped.length} file(s) alone`)
        log(`undo: ${agent.slug}: run ${runId} undone by ${undoRunId} (${o.filesChanged.length} file(s))`)
        return {
          runId,
          undo: undone?.undo ?? { state: 'done', undoRunId },
          undoRunId,
          snapshot: o.snapshot,
          filesChanged: o.filesChanged,
          undoRunUndo,
          skipped,
        }
      } finally {
        release()
      }
    })
  }

  return { preview, apply }
}
