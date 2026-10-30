/**
 * BE-P2-10: undo snapshot budgets and eviction (plan §5, §7.4).
 *
 * A snapshot is kept while its run is among the bot's last 20 runs or under 7 days old
 * (UNDO_RETENTION), and only while the budgets allow: 2 GB per bot (its retained snapshot data,
 * including group folders snapshotted for its runs, plus the runs' full logs), 15 GB across bots,
 * and at least 5 GB free on the disk holding the snapshots (settings.vm.snapshotBudget).
 *
 * Eviction (`planEviction`, pure) runs after every run, on a timer and when the settings change:
 *  1. policy-expired snapshots (not in the last 20 runs and 7+ days old)      → 'expired'
 *  2. a bot over its budget: its oldest first, never its newest              → 'budget_bot'
 *  3. over the global budget, or under the free-space floor: the oldest across
 *     bots by run end time, skipping each bot's newest                        → 'budget_global' / 'low_disk'
 *  4. still over (only newest snapshots left): the largest first             → same reason as 3
 *  5. right after a run: a run retaining more than 2× the per-bot budget is
 *     dropped at once                                                         → 'too_large'
 * Every evicted run gets `undo: {state:'unavailable', reason, at}` in its snapshot meta.json.
 */
import { statfsSync } from 'node:fs'
import path from 'node:path'
import { UNDO_RETENTION, type ScriptRunUndo, type UndoUnavailableReason } from './shared/types.js'
import type { SnapshotMeta, SnapshotService } from './snapshot.js'

const MB = 1024 * 1024
const GB = 1024 * MB
const DAY_MS = 24 * 60 * 60 * 1000

export interface BudgetLimits {
  perBotBytes: number
  globalBytes: number
  /** Evict while less than this is free. */
  freeFloorBytes: number
}

export function budgetLimits(s: { perBotMb: number; globalMb: number; freeFloorMb: number }): BudgetLimits {
  return { perBotBytes: s.perBotMb * MB, globalBytes: s.globalMb * MB, freeFloorBytes: s.freeFloorMb * MB }
}

export interface BudgetRecord {
  slug: string
  runId: string
  /** The run's end (ms). */
  endedAtMs: number
  /** Bytes it holds while kept (snapshot data + run log). */
  bytes: number
  /** False once evicted (or undone): it still counts as one of the bot's runs. */
  kept: boolean
}

export interface Eviction {
  slug: string
  runId: string
  reason: UndoUnavailableReason
  bytes: number
}

export interface PlanOptions {
  nowMs: number
  limits: BudgetLimits
  /** Free bytes on the snapshots' disk (null: unknown, the floor isn't checked). */
  freeBytes: number | null
  retention?: { runs: number; days: number }
}

/** Newest first; ties by run id (newest id last in sort order, so first here). */
const newestFirst = (a: BudgetRecord, b: BudgetRecord) => b.endedAtMs - a.endedAtMs || (a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0)

/** The §7.4 eviction order (steps 1–4) over all bots' snapshot records. Pure. */
export function planEviction(records: readonly BudgetRecord[], o: PlanOptions): Eviction[] {
  const retention = o.retention ?? UNDO_RETENTION
  const out: Eviction[] = []
  const gone = new Set<BudgetRecord>()
  const evict = (r: BudgetRecord, reason: UndoUnavailableReason) => {
    gone.add(r)
    out.push({ slug: r.slug, runId: r.runId, reason, bytes: r.bytes })
  }
  const bySlug = new Map<string, BudgetRecord[]>()
  for (const r of records) bySlug.set(r.slug, [...(bySlug.get(r.slug) ?? []), r])
  const newest = new Set<BudgetRecord>()
  for (const list of bySlug.values()) {
    list.sort(newestFirst)
    // Step 1: the rank counts every run with a snapshot record (kept or not).
    list.forEach((r, rank) => {
      if (r.kept && rank >= retention.runs && o.nowMs - r.endedAtMs >= retention.days * DAY_MS) evict(r, 'expired')
    })
    const n = list.find((r) => r.kept && !gone.has(r))
    if (n) newest.add(n)
  }
  const keptOf = (list: readonly BudgetRecord[]) => list.filter((r) => r.kept && !gone.has(r))
  const sum = (list: readonly BudgetRecord[]) => list.reduce((t, r) => t + r.bytes, 0)

  // Step 2: per bot, oldest first, never the newest.
  for (const list of bySlug.values()) {
    let total = sum(keptOf(list))
    for (const r of [...keptOf(list)].reverse()) {
      if (total <= o.limits.perBotBytes) break
      if (newest.has(r)) continue
      evict(r, 'budget_bot')
      total -= r.bytes
    }
  }

  // Steps 3–4: global budget and the free-space floor.
  let total = sum(keptOf(records))
  let free = o.freeBytes
  const overGlobal = () => total > o.limits.globalBytes
  const underFloor = () => free !== null && free < o.limits.freeFloorBytes
  const take = (r: BudgetRecord) => {
    evict(r, overGlobal() ? 'budget_global' : 'low_disk')
    total -= r.bytes
    if (free !== null) free += r.bytes
  }
  const oldestFirst = keptOf(records).filter((r) => !newest.has(r)).sort((a, b) => newestFirst(b, a))
  for (const r of oldestFirst) {
    if (!overGlobal() && !underFloor()) break
    take(r)
  }
  const largestFirst = keptOf(records).sort((a, b) => b.bytes - a.bytes || newestFirst(b, a))
  for (const r of largestFirst) {
    if (!overGlobal() && !underFloor()) break
    take(r)
  }
  return out
}

/** Step 5: a run retaining more than 2× the per-bot budget is dropped right after it. */
export const isTooLarge = (retainedBytes: number, limits: BudgetLimits): boolean => retainedBytes > 2 * limits.perBotBytes

/** "6.2 GB" (GiB, one decimal, rounded up so an over-limit size never reads as the limit). */
export function gbText(bytes: number): string {
  const v = Math.ceil((bytes / GB) * 10 - 1e-9) / 10
  return Number.isInteger(v) ? String(v) : v.toFixed(1)
}

/** Plain-language text for an unavailable undo (plan §7.4); BE-P2-11 serves it in the 410. */
export function undoUnavailableText(undo: Pick<ScriptRunUndo, 'reason' | 'changedBytes'>, botName: string, perBotBytes: number): string {
  switch (undo.reason) {
    case 'expired': return 'Undo isn\'t available for this run: it\'s older than 7 days and not in the last 20 runs.'
    case 'budget_bot': return `Undo isn't available for this run: it was removed to stay within ${botName}'s ${gbText(perBotBytes)} GB undo space.`
    case 'budget_global':
    case 'low_disk': return 'Undo isn\'t available for this run: it was removed to free disk space.'
    case 'too_large': return `Undo isn't available for this run: it changed ${gbText(undo.changedBytes ?? 0)} GB, more than the undo space.`
    case 'machine_restored': return 'This bot\'s computer was restored from a backup, so this run can\'t be undone.'
    default: return 'Undo isn\'t available for this run.'
  }
}

/** Free bytes on the filesystem holding `dir` (its nearest existing parent), or null. */
export function freeBytesAt(dir: string): number | null {
  let d = dir
  for (;;) {
    try {
      const s = statfsSync(d)
      return Number(s.bavail) * Number(s.bsize)
    } catch {
      const up = path.dirname(d)
      if (up === d) return null
      d = up
    }
  }
}

/** BE-P2-12's run logs, counted in the per-bot budget and removed with an evicted snapshot. */
export interface RunLogs {
  bytes(slug: string, runId: string): number
  remove(slug: string, runId: string): void
}

export interface SnapshotBudgetDeps {
  snapshots: SnapshotService
  /** settings.vm.snapshotBudget, read per call (a change applies at the next enforce). */
  limits: () => BudgetLimits
  /** Free bytes on the snapshots' disk (default: statfs of `root`; null: unknown). */
  freeBytes?: () => number | null
  root?: () => string | null
  logs?: RunLogs
  /** Is a run (and so its snapshot) in progress for the bot? Its copy blobs aren't collected then. */
  busy?: (slug: string) => boolean
  now?: () => Date
  log?: (msg: string) => void
}

export interface SnapshotUsage {
  /** Kept snapshot data plus the kept runs' logs. */
  bytes: number
  budgetBytes: number
  runsWithUndo: number
}

export interface SnapshotBudget {
  /**
   * Right after a run's snapshot is finished (the caller holds the bot's run slot): step 5, then
   * the full eviction. Returns the run's undo state.
   */
  afterRun(slug: string, runId: string): ScriptRunUndo | null
  /** Steps 1–4 over every bot; then unreferenced copy blobs of every idle bot (and `gcSlug`) are collected. */
  enforce(opts?: { gcSlug?: string }): Eviction[]
  usage(slug: string): SnapshotUsage
  /** A run's undo state from its snapshot record (null: no snapshot). */
  undoState(slug: string, runId: string): ScriptRunUndo | null
  /** enforce every `ms` (default 10 min: the floor and budgets are checked between runs too). */
  startTimer(ms?: number): () => void
}

export const BUDGET_SWEEP_MS = 10 * 60 * 1000

export function undoOf(meta: SnapshotMeta): ScriptRunUndo {
  return meta.undo ?? { state: 'available' }
}

export function createSnapshotBudget(deps: SnapshotBudgetDeps): SnapshotBudget {
  const now = deps.now ?? (() => new Date())
  const log = deps.log ?? (() => {})
  const freeBytes = deps.freeBytes ?? (() => {
    const root = deps.root?.()
    return root ? freeBytesAt(root) : null
  })
  const snaps = deps.snapshots

  const logBytes = (slug: string, runId: string) => {
    try {
      return deps.logs?.bytes(slug, runId) ?? 0
    } catch {
      return 0
    }
  }
  const recordOf = (m: SnapshotMeta): BudgetRecord => {
    const kept = m.undo === undefined || m.undo.state === 'available'
    const t = Date.parse(m.endedAt)
    return { slug: m.slug, runId: m.runId, endedAtMs: Number.isFinite(t) ? t : 0, kept, bytes: kept ? snaps.sizeOf(m) + logBytes(m.slug, m.runId) : 0 }
  }
  const records = (): BudgetRecord[] => snaps.slugs().flatMap((slug) => snaps.list(slug).map(recordOf))

  function apply(e: Pick<Eviction, 'slug' | 'runId' | 'reason'>, extra?: { changedBytes?: number }): void {
    if (!snaps.evict(e.slug, e.runId, e.reason, extra)) return
    try {
      deps.logs?.remove(e.slug, e.runId)
    } catch (x) {
      log(`snapshots: ${e.slug}: couldn't remove the log of run ${e.runId}: ${(x as Error).message}`)
    }
  }

  function enforce(opts: { gcSlug?: string } = {}): Eviction[] {
    if (!snaps.driver() && snaps.slugs().length === 0) return []
    const plan = planEviction(records(), { nowMs: now().getTime(), limits: deps.limits(), freeBytes: freeBytes() })
    for (const e of plan) apply(e)
    // Every idle bot (an eviction deferred while it was busy is collected later), plus gcSlug.
    for (const slug of snaps.slugs()) {
      if (slug !== opts.gcSlug && deps.busy?.(slug)) continue
      snaps.gcBlobs(slug)
    }
    if (plan.length) log(`snapshots: evicted ${plan.length} (${[...new Set(plan.map((e) => e.reason))].join(', ')})`)
    return plan
  }

  return {
    afterRun(slug, runId) {
      if (!snaps.read(slug, runId)) return null
      // This run, and a crashed run its snapshot start just finished (recovered), if too large.
      for (const m of snaps.list(slug)) {
        if (m.undo !== undefined || (m.runId !== runId && !m.recovered)) continue
        if (isTooLarge(m.retainedBytes, deps.limits())) apply({ slug, runId: m.runId, reason: 'too_large' }, { changedBytes: m.retainedBytes })
      }
      enforce({ gcSlug: slug })
      const after = snaps.read(slug, runId)
      return after ? undoOf(after) : null
    },
    enforce,
    usage(slug) {
      const kept = snaps.list(slug).map(recordOf).filter((r) => r.kept)
      return { bytes: kept.reduce((t, r) => t + r.bytes, 0), budgetBytes: deps.limits().perBotBytes, runsWithUndo: kept.length }
    },
    undoState(slug, runId) {
      const m = snaps.read(slug, runId)
      return m ? undoOf(m) : null
    },
    startTimer(ms = BUDGET_SWEEP_MS) {
      const t = setInterval(() => {
        try {
          enforce()
        } catch (x) {
          log(`snapshots: eviction failed: ${(x as Error).message}`)
        }
      }, ms)
      t.unref?.()
      return () => clearInterval(t)
    },
  }
}
