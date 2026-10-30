import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent, SnapshotDriver } from './shared/types.js'
import { createSnapshotService, type SnapshotService, type SnapshotZone } from './snapshot.js'
import {
  budgetLimits, createSnapshotBudget, freeBytesAt, gbText, isTooLarge, planEviction, planPrune, undoUnavailableText,
  type BudgetLimits, type BudgetRecord, type RunLogs,
} from './snapshot-budget.js'

const MB = 1024 * 1024
const GB = 1024 * MB
const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-10-29T12:00:00Z')
const DEFAULTS: BudgetLimits = budgetLimits({ perBotMb: 2048, globalMb: 15360, freeFloorMb: 5120 })
const id = (i: number) => `r${String(i).padStart(3, '0')}`
/** n runs of one bot, oldest first: run i ended `age(i)` ms before NOW. */
const runs = (slug: string, n: number, bytes: number | ((i: number) => number), age: (i: number) => number, base = 0): BudgetRecord[] =>
  Array.from({ length: n }, (_, i) => ({ slug, runId: id(base + i), endedAtMs: NOW - age(i), bytes: typeof bytes === 'number' ? bytes : bytes(i), kept: true }))
const plan = (records: BudgetRecord[], o: { limits?: BudgetLimits; freeBytes?: number | null } = {}) =>
  planEviction(records, { nowMs: NOW, limits: o.limits ?? DEFAULTS, freeBytes: o.freeBytes === undefined ? 100 * GB : o.freeBytes })

describe('budgetLimits / isTooLarge / gbText', () => {
  it('reads settings.vm.snapshotBudget in MB', () => {
    expect(DEFAULTS).toEqual({ perBotBytes: 2 * GB, globalBytes: 15 * GB, freeFloorBytes: 5 * GB })
  })
  it('too large means more than 2× the per-bot budget (> 4 GB by default)', () => {
    expect(isTooLarge(4 * GB, DEFAULTS)).toBe(false)
    expect(isTooLarge(4 * GB + 1, DEFAULTS)).toBe(true)
  })
  it('gbText: GiB, one decimal, rounded up, whole numbers bare', () => {
    expect(gbText(10 * GB)).toBe('10')
    expect(gbText(10.2 * GB)).toBe('10.2')
    expect(gbText(10 * GB + 1)).toBe('10.1')
    expect(gbText(2 * GB)).toBe('2')
    expect(gbText(0)).toBe('0')
    expect(gbText(6.15 * GB)).toBe('6.2')
  })
})

describe('planEviction (plan §7.4)', () => {
  it('20 runs: nothing expires, however old', () => {
    expect(plan(runs('analyst', 20, MB, (i) => (30 - i) * DAY))).toEqual([])
  })
  it('the 21st run expires the oldest only if it is also older than 7 days', () => {
    // 21 runs, all within the last 7 days: kept.
    expect(plan(runs('analyst', 21, MB, (i) => (21 - i) * 60 * 60 * 1000))).toEqual([])
    // The oldest is 8 days old: expired.
    const old = runs('analyst', 21, MB, (i) => (i === 0 ? 8 * DAY : (21 - i) * 60 * 60 * 1000))
    expect(plan(old)).toEqual([{ slug: 'analyst', runId: id(0), reason: 'expired', bytes: MB }])
    // Exactly 7 days counts as 7+ days.
    expect(plan(runs('analyst', 21, MB, (i) => (i === 0 ? 7 * DAY : 60_000)))).toHaveLength(1)
    // Just under 7 days: kept.
    expect(plan(runs('analyst', 21, MB, (i) => (i === 0 ? 7 * DAY - 1 : 60_000)))).toEqual([])
  })
  it('expiry counts evicted records toward the last 20, and per bot', () => {
    const rs = runs('analyst', 22, MB, (i) => (30 - i) * DAY)
    rs[0]!.kept = false // already evicted; still one of the 22 runs
    rs[0]!.bytes = 0
    expect(plan(rs).map((e) => [e.runId, e.reason])).toEqual([[id(1), 'expired']])
    // Another bot's runs don't push this bot's past 20.
    const two = [...runs('analyst', 20, MB, (i) => (30 - i) * DAY), ...runs('coder', 20, MB, (i) => (30 - i) * DAY, 100)]
    expect(plan(two)).toEqual([])
  })
  it('per-bot overflow evicts that bot\'s oldest first, never its newest', () => {
    const rs = runs('analyst', 5, 600 * MB, (i) => (5 - i) * 60_000) // 3000 MB > 2048
    const out = plan(rs)
    expect(out.map((e) => [e.runId, e.reason])).toEqual([[id(0), 'budget_bot'], [id(1), 'budget_bot']])
    // Remaining 1800 MB fits.
    // A single newest run over the budget (but not too large) stays.
    expect(plan(runs('analyst', 1, 3 * GB, () => 0))).toEqual([])
    // Old small + new huge: the old one goes, the newest stays even though still over.
    const mixed = [...runs('analyst', 2, 100 * MB, (i) => (10 - i) * 60_000), ...runs('analyst', 1, 3 * GB, () => 0, 2)]
    expect(plan(mixed).map((e) => e.runId)).toEqual([id(0), id(1)])
  })
  it('per-bot overflow only touches that bot', () => {
    const rs = [...runs('analyst', 3, 1 * GB, (i) => (3 - i) * DAY), ...runs('coder', 3, 100 * MB, (i) => (30 - i) * DAY, 100)]
    const out = plan(rs)
    expect(out.every((e) => e.slug === 'analyst' && e.reason === 'budget_bot')).toBe(true)
    expect(out.map((e) => e.runId)).toEqual([id(0)])
  })
  it('global overflow evicts the oldest across bots (each bot\'s newest skipped)', () => {
    // 10 bots × 2 runs × 900 MB = 18000 MB > 15360; each bot is within 2048.
    const rs: BudgetRecord[] = []
    for (let b = 0; b < 10; b++) rs.push(...runs(`bot${b}`, 2, 900 * MB, (i) => (100 - b * 2 - i) * 60_000, b * 10))
    const out = plan(rs)
    expect(out.every((e) => e.reason === 'budget_global')).toBe(true)
    // The oldest runs, across bots: bot0's first, then bot1's first, then bot2's first.
    expect(out.map((e) => `${e.slug}/${e.runId}`)).toEqual(['bot0/r000', 'bot1/r010', 'bot2/r020'])
    // 18000 - 3*900 = 15300 <= 15360.
    const left = rs.filter((r) => !out.some((e) => e.slug === r.slug && e.runId === r.runId)).reduce((t, r) => t + r.bytes, 0)
    expect(left).toBeLessThanOrEqual(DEFAULTS.globalBytes)
  })
  it('global overflow with only newest snapshots left: the largest go first', () => {
    const limits = budgetLimits({ perBotMb: 2048, globalMb: 3000, freeFloorMb: 0 })
    const rs = [
      ...runs('a', 1, 1500 * MB, () => 3 * 60_000),
      ...runs('b', 1, 1800 * MB, () => 2 * 60_000, 10),
      ...runs('c', 1, 500 * MB, () => 60_000, 20),
    ]
    expect(plan(rs, { limits }).map((e) => [e.slug, e.reason])).toEqual([['b', 'budget_global']])
  })
  it('the free-space floor triggers eviction (low_disk), oldest across bots, until the floor is met', () => {
    const rs = [...runs('a', 3, 500 * MB, (i) => (10 - i) * 60_000), ...runs('b', 3, 500 * MB, (i) => (9.5 - i) * 60_000, 10)]
    // 4.2 GB free < 5 GB floor: needs 0.8 GB → two 500 MB snapshots, oldest first (a/r000, b/r010).
    const out = plan(rs, { freeBytes: 4.2 * GB })
    expect(out.map((e) => `${e.slug}/${e.runId}:${e.reason}`)).toEqual(['a/r000:low_disk', 'b/r010:low_disk'])
    // Enough free: nothing.
    expect(plan(rs, { freeBytes: 6 * GB })).toEqual([])
    // Unknown free space: the floor isn't checked.
    expect(plan(rs, { freeBytes: null })).toEqual([])
  })
  it('under the floor even the newest go (largest first) once nothing else is left', () => {
    const rs = [...runs('a', 1, 300 * MB, () => 60_000), ...runs('b', 1, 700 * MB, () => 2 * 60_000, 10)]
    const out = plan(rs, { freeBytes: 4.5 * GB })
    expect(out.map((e) => `${e.slug}:${e.reason}`)).toEqual(['b:low_disk'])
  })
  it('order: expired, then budget_bot, then global; evicted records are never evicted twice', () => {
    const limits = budgetLimits({ perBotMb: 1000, globalMb: 1500, freeFloorMb: 0 })
    const rs = [
      ...runs('a', 22, 100 * MB, (i) => (40 - i) * DAY), // 2 expired, then 20 × 100 MB = 2000 > 1000
      ...runs('b', 2, 400 * MB, (i) => (2 - i) * 60_000, 100),
    ]
    const out = plan(rs, { limits })
    expect(out.slice(0, 2).map((e) => e.reason)).toEqual(['expired', 'expired'])
    expect(out.filter((e) => e.reason === 'budget_bot').length).toBe(10)
    const keys = out.map((e) => `${e.slug}/${e.runId}`)
    expect(new Set(keys).size).toBe(keys.length)
    expect(out.every((e) => e.reason)).toBe(true)
    // a: 1000 MB left, b: 800 MB → 1800 > 1500: the oldest across bots goes: b's older run (a's are older? a's remaining are 30..21 days old).
    const glob = out.filter((e) => e.reason === 'budget_global')
    expect(glob.map((e) => e.slug)).toEqual(['a', 'a', 'a'])
  })
  it('records already not kept never count or get evicted', () => {
    const rs = runs('a', 3, 3 * GB, (i) => (3 - i) * 60_000).map((r, i) => (i < 2 ? { ...r, kept: false, bytes: 0 } : r))
    expect(plan(rs)).toEqual([])
  })
})

describe('planPrune: evicted-run records', () => {
  const ev = (rs: BudgetRecord[], ids: number[]) => rs.map((r, i) => (ids.includes(i) ? { ...r, kept: false, evicted: true } : r))
  const pruned = (rs: BudgetRecord[]) => planPrune(rs, { nowMs: NOW }).map((r) => `${r.slug}/${r.runId}`).sort()
  it('removes an evicted record only outside both the last 20 runs and the 7-day window', () => {
    // 25 runs, oldest first, all 30+ days old; the oldest 5 (ranks 20–24) are outside the last 20.
    const rs = ev(runs('a', 25, MB, (i) => (60 - i) * DAY), [0, 1, 2, 3, 4, 10, 24])
    expect(pruned(rs)).toEqual([id(0), id(1), id(2), id(3), id(4)].map((r) => `a/${r}`))
  })
  it('keeps an evicted record in the last 20 however old, and one under 7 days old however far back', () => {
    // r000 is outside the last 20 but under 7 days old; r005 is old but in the last 20.
    const rs = ev(runs('a', 25, MB, (i) => (i === 0 ? 7 * DAY - 1 : i < 5 ? 30 * DAY : (25 - i) * 60_000)), [0, 5])
    expect(pruned(rs)).toEqual([])
    // Exactly 7 days counts as 7+ days.
    expect(pruned(ev(runs('a', 21, MB, (i) => (i === 0 ? 7 * DAY : 60_000)), [0]))).toEqual(['a/r000'])
  })
  it('never removes kept or undone (not evicted) records', () => {
    const rs = runs('a', 25, MB, () => 30 * DAY).map((r, i) => (i === 1 ? { ...r, kept: false } : r))
    expect(pruned(rs)).toEqual([])
  })
  it('ranks per bot', () => {
    const a = ev(runs('a', 21, MB, (i) => (40 - i) * DAY), [0])
    const b = ev(runs('b', 20, MB, (i) => (40 - i) * DAY), [0])
    expect(pruned([...a, ...b])).toEqual(['a/r000'])
  })
})

describe('undoUnavailableText', () => {
  it('has plain text for every reason', () => {
    expect(undoUnavailableText({ reason: 'expired' }, 'Analyst', 2 * GB)).toBe('Undo isn\'t available for this run: it\'s older than 7 days and not in the last 20 runs.')
    expect(undoUnavailableText({ reason: 'budget_bot' }, 'Analyst', 2 * GB)).toBe('Undo isn\'t available for this run: it was removed to stay within Analyst\'s 2 GB undo space.')
    expect(undoUnavailableText({ reason: 'budget_global' }, 'Analyst', 2 * GB)).toBe('Undo isn\'t available for this run: it was removed to free disk space.')
    expect(undoUnavailableText({ reason: 'low_disk' }, 'Analyst', 2 * GB)).toBe('Undo isn\'t available for this run: it was removed to free disk space.')
    expect(undoUnavailableText({ reason: 'too_large', changedBytes: 6.2 * GB }, 'Analyst', 2 * GB)).toBe('Undo isn\'t available for this run: it changed 6.2 GB, more than the undo space.')
    expect(undoUnavailableText({ reason: 'machine_restored' }, 'Analyst', 2 * GB)).toBe('This bot\'s computer was restored from a backup, so this run can\'t be undone.')
  })
})

describe('freeBytesAt', () => {
  it('walks up to an existing folder', () => {
    const n = freeBytesAt(path.join(tmpdir(), 'no', 'such', 'dir'))
    expect(typeof n).toBe('number')
    expect(n!).toBeGreaterThan(0)
  })
})

// ---------- The service, over a real SnapshotService on a temp folder ----------

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

interface Env {
  root: string
  svc: SnapshotService
  zoneOf: (slug: string) => string
  clock: { t: number }
  run: (slug: string, runId: string, write: (zone: string) => void, opts?: { endAgo?: number }) => Promise<void>
}

function env(driver: SnapshotDriver): Env {
  const base = mkdtempSync(path.join(tmpdir(), 'ac-budget-'))
  dirs.push(base)
  const root = path.join(base, 'snapshots')
  const zoneOf = (slug: string) => path.join(base, 'files', slug, 'workspace')
  const clock = { t: NOW }
  const svc = createSnapshotService({
    root: () => root,
    driver: () => driver,
    zones: (a: Agent): SnapshotZone[] => {
      mkdirSync(zoneOf(a.slug), { recursive: true })
      return [{ key: 'workspace', dir: zoneOf(a.slug), target: '/bot/workspace', root: 'agent', prefix: 'workspace' }]
    },
    clone: (s, d) => copyFileSync(s, d),
    opaqueDirs: async () => new Set(),
    now: () => new Date(clock.t),
  })
  return {
    root, svc, zoneOf, clock,
    async run(slug, runId, write, opts = {}) {
      const h = (await svc.begin({ slug } as Agent, runId))!
      write(zoneOf(slug))
      const keep = clock.t
      clock.t = NOW - (opts.endAgo ?? 0)
      await svc.finish(h)
      clock.t = keep
    },
  }
}
const fill = (dir: string, name: string, bytes: number) => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, name), Buffer.alloc(bytes, name.charCodeAt(0)))
}

describe.each(['reflink', 'copy'] as const)('createSnapshotBudget (%s)', (driver) => {
  const KB = 1024
  // Scaled down: per bot 100 KB, global 250 KB, floor 0 (free space mocked).
  const small: BudgetLimits = { perBotBytes: 100 * KB, globalBytes: 250 * KB, freeFloorBytes: 0 }

  it('afterRun: a too-large run is dropped at once with too_large and changedBytes', async () => {
    const e = env(driver)
    fill(e.zoneOf('analyst'), 'big.bin', 250 * KB) // the run overwrites it: the 250 KB original is retained
    const b = createSnapshotBudget({ snapshots: e.svc, limits: () => small, freeBytes: () => null })
    await e.run('analyst', 'r001', (z) => fill(z, 'big.bin', 10))
    const undo = b.afterRun('analyst', 'r001')!
    expect(undo.state).toBe('unavailable')
    expect(undo.reason).toBe('too_large')
    expect(undo.changedBytes).toBeGreaterThan(200 * KB)
    expect(undo.at).toBe(new Date(NOW).toISOString())
    expect(e.svc.undoSource('analyst', 'r001')).toBeNull()
    expect(existsSync(path.join(e.root, 'analyst', 'r001', 'meta.json'))).toBe(true)
    expect(existsSync(path.join(e.root, 'analyst', 'r001', 'manifest.json'))).toBe(false)
    expect(b.undoState('analyst', 'r001')).toEqual(undo)
    expect(b.usage('analyst').runsWithUndo).toBe(0)
  })

  it('afterRun: within budget the run stays available; usage counts kept snapshots', async () => {
    const e = env(driver)
    fill(e.zoneOf('analyst'), 'a.txt', 10 * KB)
    const b = createSnapshotBudget({ snapshots: e.svc, limits: () => small, freeBytes: () => null })
    await e.run('analyst', 'r001', (z) => fill(z, 'a.txt', 20 * KB))
    expect(b.afterRun('analyst', 'r001')).toEqual({ state: 'available' })
    const u = b.usage('analyst')
    expect(u.runsWithUndo).toBe(1)
    expect(u.budgetBytes).toBe(100 * KB)
    expect(u.bytes).toBeGreaterThanOrEqual(10 * KB) // the kept original, plus the records
    expect(e.svc.undoSource('analyst', 'r001')).not.toBeNull()
    expect(b.afterRun('analyst', 'nope')).toBeNull()
  })

  it('per-bot overflow: the oldest are evicted, the newest kept; every evicted run has a reason', async () => {
    const e = env(driver)
    const b = createSnapshotBudget({ snapshots: e.svc, limits: () => small, freeBytes: () => null })
    for (let i = 1; i <= 5; i++) {
      fill(e.zoneOf('analyst'), `f${i}.bin`, 30 * KB) // each run changes a 30 KB file: retains 30 KB
      await e.run('analyst', id(i), (z) => fill(z, `f${i}.bin`, 1), { endAgo: (10 - i) * 60_000 })
    }
    const ev = b.enforce()
    expect(ev.map((x) => [x.runId, x.reason])).toEqual([[id(1), 'budget_bot'], [id(2), 'budget_bot']])
    for (const m of e.svc.list('analyst')) {
      if ([id(1), id(2)].includes(m.runId)) expect(m.undo).toMatchObject({ state: 'unavailable', reason: 'budget_bot' })
      else expect(m.undo).toBeUndefined()
    }
    expect(b.usage('analyst').bytes).toBeLessThanOrEqual(100 * KB)
    // Idempotent.
    expect(b.enforce()).toEqual([])
  })

  it('global overflow evicts the oldest across bots', async () => {
    const e = env(driver)
    const b = createSnapshotBudget({ snapshots: e.svc, limits: () => small, freeBytes: () => null })
    let t = 100
    for (const slug of ['a', 'b', 'c']) {
      for (let i = 1; i <= 2; i++) {
        fill(e.zoneOf(slug), `f${i}.bin`, 45 * KB)
        await e.run(slug, id(i), (z) => fill(z, `f${i}.bin`, 1), { endAgo: t-- * 60_000 })
      }
    }
    // 6 × ~45 KB = 270 KB > 250 KB; each bot is within 100 KB.
    const ev = b.enforce()
    expect(ev.map((x) => `${x.slug}/${x.runId}:${x.reason}`)).toEqual(['a/r001:budget_global'])
  })

  it('the free-space floor triggers eviction (low_disk)', async () => {
    const e = env(driver)
    let free = 10 * KB
    const b = createSnapshotBudget({ snapshots: e.svc, limits: () => ({ ...small, freeFloorBytes: 50 * KB }), freeBytes: () => free })
    for (let i = 1; i <= 3; i++) {
      fill(e.zoneOf('a'), `f${i}.bin`, 30 * KB)
      await e.run('a', id(i), (z) => fill(z, `f${i}.bin`, 1), { endAgo: (10 - i) * 60_000 })
    }
    const ev = b.enforce()
    expect(ev.map((x) => x.reason)).toEqual(['low_disk', 'low_disk'])
    expect(ev.map((x) => x.runId)).toEqual([id(1), id(2)])
    free = 100 * KB
    expect(b.enforce()).toEqual([])
  })

  it('the 21st run expires the oldest only when it is 7+ days old', async () => {
    const e = env(driver)
    const b = createSnapshotBudget({ snapshots: e.svc, limits: () => DEFAULTS, freeBytes: () => null })
    for (let i = 1; i <= 21; i++) {
      fill(e.zoneOf('a'), 'f.txt', i)
      await e.run('a', id(i), (z) => fill(z, 'f.txt', i + 100), { endAgo: (i === 1 ? 6 : 0) * DAY + (30 - i) * 60_000 })
    }
    expect(b.enforce()).toEqual([])
    e.clock.t = NOW + 2 * DAY
    const b2 = createSnapshotBudget({ snapshots: e.svc, limits: () => DEFAULTS, freeBytes: () => null, now: () => new Date(e.clock.t) })
    expect(b2.enforce().map((x) => [x.runId, x.reason])).toEqual([[id(1), 'expired']])
  })

  it('a settings change applies at the next enforce', async () => {
    const e = env(driver)
    let limits = DEFAULTS
    const b = createSnapshotBudget({ snapshots: e.svc, limits: () => limits, freeBytes: () => null })
    for (let i = 1; i <= 3; i++) {
      fill(e.zoneOf('a'), `f${i}.bin`, 30 * KB)
      await e.run('a', id(i), (z) => fill(z, `f${i}.bin`, 1), { endAgo: (10 - i) * 60_000 })
    }
    expect(b.enforce()).toEqual([])
    limits = { ...small, perBotBytes: 40 * KB }
    expect(b.enforce().map((x) => x.reason)).toEqual(['budget_bot', 'budget_bot'])
  })

  it('run logs count toward the bot budget and are removed with the snapshot', async () => {
    const e = env(driver)
    const removed: string[] = []
    const logs: RunLogs = { bytes: () => 40 * KB, remove: (_s, r) => void removed.push(r) }
    const b = createSnapshotBudget({ snapshots: e.svc, limits: () => small, freeBytes: () => null, logs })
    for (let i = 1; i <= 3; i++) {
      fill(e.zoneOf('a'), `f${i}.txt`, 10)
      await e.run('a', id(i), (z) => fill(z, `f${i}.txt`, 1), { endAgo: (10 - i) * 60_000 })
    }
    expect(b.enforce().map((x) => x.runId)).toEqual([id(1)])
    expect(removed).toEqual([id(1)])
  })

  it('a recovered too-large snapshot is dropped by the next run\'s afterRun', async () => {
    const e = env(driver)
    const b = createSnapshotBudget({ snapshots: e.svc, limits: () => small, freeBytes: () => null })
    fill(e.zoneOf('a'), 'big.bin', 250 * KB)
    await e.svc.begin({ slug: 'a' } as Agent, 'r001') // crash: never finished
    fill(e.zoneOf('a'), 'big.bin', 1)
    const h = (await e.svc.begin({ slug: 'a' } as Agent, 'r002'))! // finishes r001 as recovered
    fill(e.zoneOf('a'), 'x.txt', 1)
    await e.svc.finish(h)
    expect(e.svc.read('a', 'r001')!.recovered).toBe(true)
    expect(b.afterRun('a', 'r002')).toEqual({ state: 'available' })
    expect(e.svc.read('a', 'r001')!.undo).toMatchObject({ state: 'unavailable', reason: 'too_large' })
  })

  it('startTimer sweeps and stops', async () => {
    vi.useFakeTimers()
    try {
      const e = env(driver)
      const spy = vi.spyOn(e.svc, 'slugs')
      const b = createSnapshotBudget({ snapshots: e.svc, limits: () => small, freeBytes: () => null })
      const stop = b.startTimer(1000)
      vi.advanceTimersByTime(3000)
      expect(spy.mock.calls.length).toBeGreaterThanOrEqual(3)
      stop()
      const n = spy.mock.calls.length
      vi.advanceTimersByTime(3000)
      expect(spy.mock.calls.length).toBe(n)
    } finally {
      vi.useRealTimers()
    }
  })

  it('prune: an evicted record outside the last 20 and 7+ days old is removed by enforce; the rest stay', async () => {
    const e = env(driver)
    // 24 runs: r001–r003 are 10 days old, r004 6 days old (rank 20), the rest recent.
    for (let i = 1; i <= 24; i++) {
      fill(e.zoneOf('a'), 'f.txt', i)
      await e.run('a', id(i), (z) => fill(z, 'f.txt', i + 100), { endAgo: i <= 3 ? 10 * DAY - i * 60_000 : i === 4 ? 6 * DAY : (30 - i) * 60_000 })
    }
    e.svc.evict('a', id(4), 'budget_bot')
    e.svc.evict('a', id(10), 'budget_bot')
    const b = createSnapshotBudget({ snapshots: e.svc, limits: () => DEFAULTS, freeBytes: () => null, now: () => new Date(e.clock.t) })
    // r001–r003 expire (step 1) and, being evicted, outside the 20 and 7+ days old, are pruned.
    expect(b.enforce().map((x) => [x.runId, x.reason]).sort()).toEqual([[id(1), 'expired'], [id(2), 'expired'], [id(3), 'expired']])
    const dirsOf = () => readdirSync(path.join(e.root, 'a')).filter((n) => /^r\d+$/.test(n)).sort()
    expect(dirsOf()).not.toContain(id(1))
    expect(dirsOf()).not.toContain(id(3))
    // r004: outside the 20 but under 7 days old; r010: in the 20. Both records stay.
    expect(e.svc.read('a', id(4))!.undo).toMatchObject({ state: 'unavailable', reason: 'budget_bot' })
    expect(e.svc.read('a', id(10))!.undo).toMatchObject({ state: 'unavailable', reason: 'budget_bot' })
    expect(dirsOf()).toHaveLength(21)
    // Two days later r004 is 8 days old and goes too; nothing else changes.
    e.clock.t = NOW + 2 * DAY
    expect(b.enforce()).toEqual([])
    expect(e.svc.read('a', id(4))).toBeNull()
    expect(dirsOf()).toHaveLength(20)
    expect(e.svc.read('a', id(10))).not.toBeNull()
    expect(b.prune()).toBe(0)
  })

  it('prune runs with a run\'s eviction (afterRun): the 21st run pushes an old evicted record out', async () => {
    const e = env(driver)
    for (let i = 1; i <= 20; i++) {
      fill(e.zoneOf('a'), 'f.txt', i)
      await e.run('a', id(i), (z) => fill(z, 'f.txt', i + 100), { endAgo: i === 1 ? 9 * DAY : (30 - i) * 60_000 })
    }
    e.svc.evict('a', id(1), 'budget_bot')
    const b = createSnapshotBudget({ snapshots: e.svc, limits: () => DEFAULTS, freeBytes: () => null })
    expect(b.enforce()).toEqual([])
    expect(e.svc.read('a', id(1))).not.toBeNull() // still one of the last 20
    fill(e.zoneOf('a'), 'f.txt', 5)
    await e.run('a', id(21), (z) => fill(z, 'f.txt', 6))
    expect(b.afterRun('a', id(21))).toEqual({ state: 'available' })
    expect(e.svc.read('a', id(1))).toBeNull()
    expect(existsSync(path.join(e.root, 'a', id(1)))).toBe(false)
  })

  it('prune (service): only evicted records; a kept or unknown run is left alone', async () => {
    const e = env(driver)
    fill(e.zoneOf('a'), 'f.txt', 3)
    await e.run('a', id(1), (z) => fill(z, 'f.txt', 4))
    await e.run('a', id(2), (z) => fill(z, 'f.txt', 5))
    expect(e.svc.prune('a', id(1))).toBe(false)
    expect(e.svc.prune('a', 'nope')).toBe(false)
    expect(e.svc.prune('a', '../x')).toBe(false)
    expect(e.svc.read('a', id(1))).not.toBeNull()
    e.svc.evict('a', id(1), 'budget_bot')
    expect(e.svc.prune('a', id(1))).toBe(true)
    expect(existsSync(path.join(e.root, 'a', id(1)))).toBe(false)
    expect(e.svc.read('a', id(2))).not.toBeNull()
  })

  it('the sweep (startTimer) prunes', async () => {
    const e = env(driver)
    for (let i = 1; i <= 21; i++) {
      fill(e.zoneOf('a'), 'f.txt', i)
      await e.run('a', id(i), (z) => fill(z, 'f.txt', i + 100), { endAgo: i === 1 ? 9 * DAY : (30 - i) * 60_000 })
    }
    e.svc.evict('a', id(1), 'budget_bot')
    vi.useFakeTimers()
    try {
      const b = createSnapshotBudget({ snapshots: e.svc, limits: () => DEFAULTS, freeBytes: () => null })
      const stop = b.startTimer(1000)
      expect(e.svc.read('a', id(1))).not.toBeNull()
      vi.advanceTimersByTime(1000)
      expect(e.svc.read('a', id(1))).toBeNull()
      stop()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('copy driver: blob collection', () => {
  it('evicting a snapshot frees its originals unless still referenced; busy bots wait', async () => {
    const e = env('copy')
    const blobs = () => readdirSync(path.join(e.root, 'a', '.blobs')).filter((n) => /^[0-9a-f]{64}$/.test(n))
    let busy = true
    const b = createSnapshotBudget({ snapshots: e.svc, limits: () => ({ perBotBytes: 1, globalBytes: 1e12, freeFloorBytes: 0 }), freeBytes: () => null, busy: () => busy })
    fill(e.zoneOf('a'), 'one.bin', 5000)
    await e.run('a', 'r001', (z) => fill(z, 'one.bin', 6000), { endAgo: 120_000 })
    await e.run('a', 'r002', (z) => fill(z, 'one.bin', 7000), { endAgo: 60_000 })
    const before = blobs().length
    const ev = b.enforce() // r001 evicted (budget_bot); bot busy: no collection
    expect(ev.map((x) => x.runId)).toEqual(['r001'])
    expect(blobs().length).toBe(before)
    busy = false
    b.enforce()
    expect(blobs().length).toBeLessThan(before)
    // r002's original (the 6000-byte version) is still there.
    expect(e.svc.undoSource('a', 'r002')![0]!.original).toMatchObject({ kind: 'file', size: 6000 })
    expect(existsSync((e.svc.undoSource('a', 'r002')![0]!.original as { file: string }).file)).toBe(true)
    // gcSlug collects even while busy (the caller holds the run slot).
    busy = true
    expect(() => b.enforce({ gcSlug: 'a' })).not.toThrow()
  })
})
