import { chmodSync, copyFileSync, utimesSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync, readlinkSync, lstatSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Agent, SnapshotDriver } from './shared/types.js'
import { commitOverlay, createSnapshotService, newRunId, RUN_ID_RE, type SnapshotService, type SnapshotZone, type UndoSourceEntry } from './snapshot.js'
import { diffManifests, takeManifest } from './snapshot-manifest.js'

const agent = { slug: 'analyst' } as Agent
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = (p = 'ac-snap-') => {
  const d = mkdtempSync(path.join(tmpdir(), p))
  dirs.push(d)
  return d
}
const put = (file: string, text: string) => {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
}
const read = (file: string) => readFileSync(file, 'utf8')

interface Env {
  base: string
  zone: string
  group: string
  zones: SnapshotZone[]
  svc: SnapshotService
  make: () => SnapshotService
  /** Writes as the bot would make them: straight to the folder, or (overlay) into the upper layer. */
  bot: { write(rel: string, text: string, zone?: string): void; rm(rel: string, zone?: string): void; rename(a: string, b: string, zone?: string): void; replaceDir(rel: string, zone?: string): void }
}

/** fuse-overlayfs style markers: `.wh.<name>` for a delete, `.wh..wh..opq` in a replaced folder. */
function makeEnv(driver: SnapshotDriver, opts: { opaque?: Set<string> } = {}): Env {
  const base = tmp()
  const zone = path.join(base, 'files', 'analyst', 'workspace')
  const group = path.join(base, 'files', 'groups', 'research', 'shared')
  mkdirSync(zone, { recursive: true })
  mkdirSync(group, { recursive: true })
  const zones: SnapshotZone[] = [
    { key: 'workspace', dir: zone, target: '/bot/workspace', root: 'agent', prefix: 'workspace' },
    { key: 'group-research', dir: group, target: '/bot/groups/research', root: 'group', prefix: 'shared', groupId: 'g1', groupName: 'Research' },
  ]
  const root = path.join(base, 'snapshots')
  const make = () => createSnapshotService({
    root: () => root, driver: () => driver, zones: () => zones,
    clone: (s, d) => copyFileSync(s, d), // reflink simulated (ext4 here); the real one is COPYFILE_FICLONE_FORCE
    opaqueDirs: async (ds) => new Set(ds.filter((d) => opts.opaque?.has(d) || existsSync(path.join(d, '.wh..wh..opq')))),
  })
  const svc = make()
  const lower = (z?: string) => (z === 'group' ? group : zone)
  const upper = (z?: string) => svc.overlayDirs('analyst', z === 'group' ? 'group-research' : 'workspace')!.upper
  const ov = driver === 'overlay'
  const bot: Env['bot'] = {
    write(rel, text, z) {
      put(path.join(ov ? upper(z) : lower(z), rel), text)
    },
    rm(rel, z) {
      if (!ov) return rmSync(path.join(lower(z), rel), { recursive: true })
      rmSync(path.join(upper(z), rel), { recursive: true, force: true })
      if (existsSync(path.join(lower(z), rel))) put(path.join(upper(z), path.dirname(rel), `.wh.${path.basename(rel)}`), '')
    },
    rename(a, b, z) {
      if (!ov) {
        mkdirSync(path.dirname(path.join(lower(z), b)), { recursive: true })
        return renameSync(path.join(lower(z), a), path.join(lower(z), b))
      }
      const src = existsSync(path.join(upper(z), a)) ? path.join(upper(z), a) : path.join(lower(z), a)
      put(path.join(upper(z), b), read(src))
      bot.rm(a, z)
    },
    replaceDir(rel, z) {
      if (!ov) {
        rmSync(path.join(lower(z), rel), { recursive: true })
        return mkdirSync(path.join(lower(z), rel))
      }
      rmSync(path.join(upper(z), rel), { recursive: true, force: true })
      mkdirSync(path.join(upper(z), rel), { recursive: true })
      put(path.join(upper(z), rel, '.wh..wh..opq'), '')
    },
  }
  return { base, zone, group, zones, svc, make, bot }
}

function seed(e: Env) {
  put(path.join(e.zone, 'a.txt'), 'alpha\n')
  put(path.join(e.zone, 'b.txt'), 'bravo bravo\n')
  put(path.join(e.zone, 'sub', 'c.txt'), 'charlie!\n')
  put(path.join(e.zone, 'big.bin'), 'x'.repeat(1 << 20)) // unchanged: must not be retained
  put(path.join(e.group, 'notes.md'), '# notes\n')
  symlinkSync('a.txt', path.join(e.zone, 'link'))
}
const snapshotOf = (dir: string) => Object.fromEntries(takeManifest(dir, { zone: '', hash: 'none' }).map((x) => [x.path, x.kind === 'file' ? read(path.join(dir, x.path)) : x.kind === 'symlink' ? `-> ${readlinkSync(path.join(dir, x.path))}` : 'dir']))

/** What undo will do with undoSource: put originals back, remove added files. */
function applyUndo(entries: UndoSourceEntry[], zones: SnapshotZone[]) {
  const dirOf = new Map(zones.map((z) => [z.key, z.dir]))
  for (const u of entries) {
    const to = path.join(dirOf.get(u.zone)!, u.rel)
    rmSync(to, { recursive: true, force: true })
    if (!u.original) continue
    mkdirSync(path.dirname(to), { recursive: true })
    if (u.original.kind === 'symlink') symlinkSync(u.original.target, to)
    else copyFileSync(u.original.file, to)
  }
}

describe.each(['reflink', 'copy', 'overlay'] as const)('SnapshotService (%s)', (driver) => {
  it('add / modify / delete / rename: the diff, FileChange paths and group info are right', async () => {
    const e = makeEnv(driver)
    seed(e)
    const h = (await e.svc.begin(agent, 'run-1'))!
    expect(h.driver).toBe(driver)
    expect(e.svc.pending(agent)).toBe(true)
    e.bot.write('a.txt', 'alpha changed\n')
    e.bot.write('new.txt', 'new\n')
    e.bot.rm('b.txt')
    e.bot.rename('sub/c.txt', 'sub/d.txt')
    e.bot.write('notes.md', '# notes\nmore\n', 'group')
    const out = await e.svc.finish(h)
    expect(e.svc.pending(agent)).toBe(false)
    const fc = [...out.filesChanged].sort((x, y) => x.path.localeCompare(y.path))
    expect(fc.map((c) => [c.path, c.change, c.root])).toEqual([
      ['shared/notes.md', 'modified', 'group'],
      ['workspace/a.txt', 'modified', 'agent'],
      ['workspace/b.txt', 'deleted', 'agent'],
      ['workspace/new.txt', 'added', 'agent'],
      ['workspace/sub/c.txt', 'deleted', 'agent'],
      ['workspace/sub/d.txt', 'added', 'agent'],
    ])
    expect(fc[0]).toMatchObject({ groupId: 'g1', groupName: 'Research', bytes: 13 })
    expect(fc.find((c) => c.path === 'workspace/new.txt')).toMatchObject({ bytes: 4, modifiedAt: expect.any(String) })
    expect(fc.find((c) => c.path === 'workspace/b.txt')?.bytes).toBeUndefined()
    // The real folders hold the run's result (overlay: committed from the upper layer).
    expect(snapshotOf(e.zone)).toMatchObject({ 'a.txt': 'alpha changed\n', 'new.txt': 'new\n', 'sub/d.txt': 'charlie!\n' })
    expect(existsSync(path.join(e.zone, 'b.txt'))).toBe(false)
    expect(existsSync(path.join(e.zone, 'sub', 'c.txt'))).toBe(false)
    expect(out.snapshot).toMatchObject({ id: 'run-1', driver })
    expect(e.svc.read('analyst', 'run-1')?.changes).toHaveLength(6)
  })

  it('retained bytes = the originals of changed files only', async () => {
    const e = makeEnv(driver)
    seed(e)
    const h = (await e.svc.begin(agent, 'run-1'))!
    e.bot.write('a.txt', 'A\n')
    e.bot.rm('b.txt')
    e.bot.write('fresh.txt', 'f'.repeat(5000))
    const out = await e.svc.finish(h)
    const want = 'alpha\n'.length + 'bravo bravo\n'.length
    expect(out.snapshot.retainedBytes).toBe(want)
    if (driver !== 'copy') {
      const kept = takeManifest(path.join(e.base, 'snapshots', 'analyst', 'run-1', 'files'), { zone: '', hash: 'none' }).filter((x) => x.kind !== 'dir')
      expect(kept.map((x) => x.path).sort()).toEqual(['workspace/a.txt', 'workspace/b.txt'])
      expect(kept.reduce((n, x) => n + x.size, 0)).toBe(want)
    } else {
      // copy: the blob store holds each content once; a second snapshot adds only what changed.
      const blobs = path.join(e.base, 'snapshots', 'analyst', '.blobs')
      const n1 = readdirSync(blobs).length
      const h2 = (await e.svc.begin(agent, 'run-2'))!
      await e.svc.finish(h2)
      expect(readdirSync(blobs).length).toBe(n1 + 2) // run-1's new contents (A\n, fresh.txt); the rest is shared
    }
  })

  it('undo from undoSource restores the folders exactly (files, deletes, renames, symlinks)', async () => {
    const e = makeEnv(driver)
    seed(e)
    const before = { ws: snapshotOf(e.zone), g: snapshotOf(e.group) }
    const h = (await e.svc.begin(agent, 'run-1'))!
    e.bot.write('a.txt', 'zzz\n')
    e.bot.rm('b.txt')
    e.bot.rm('link')
    e.bot.rename('sub/c.txt', 'moved/c.txt')
    e.bot.write('notes.md', 'gone\n', 'group')
    await e.svc.finish(h)
    const src = e.svc.undoSource('analyst', 'run-1')!
    expect(src.find((u) => u.rel === 'link')?.original).toEqual({ kind: 'symlink', target: 'a.txt' })
    for (const u of src) if (u.change !== 'added') expect(u.original).toBeDefined()
    applyUndo(src, e.zones)
    // Empty folders left by the rename aren't part of the diff (files and symlinks only).
    rmSync(path.join(e.zone, 'moved'), { recursive: true, force: true })
    expect(snapshotOf(e.zone)).toEqual(before.ws)
    expect(snapshotOf(e.group)).toEqual(before.g)
  })

  it('a killed run: its partial writes are committed by the next begin (recovered) and undoable', async () => {
    const e = makeEnv(driver)
    seed(e)
    const before = snapshotOf(e.zone)
    await e.svc.begin(agent, 'killed-run')
    e.bot.write('a.txt', 'half writ')
    e.bot.write('partial.tmp', 'partial')
    e.bot.rm('b.txt')
    // The server died here: no finish. A new service (restart) finds the pending snapshot.
    const svc2 = e.make()
    expect(svc2.pending(agent)).toBe(true)
    const h2 = (await svc2.begin(agent, 'next-run'))!
    const meta = svc2.read('analyst', 'killed-run')!
    expect(meta.recovered).toBe(true)
    expect(meta.changes.map((c) => [c.path, c.change]).sort()).toEqual([['a.txt', 'modified'], ['b.txt', 'deleted'], ['partial.tmp', 'added']])
    expect(read(path.join(e.zone, 'a.txt'))).toBe('half writ')
    const next = await svc2.finish(h2)
    expect(next.filesChanged).toEqual([])
    applyUndo(svc2.undoSource('analyst', 'killed-run')!, e.zones)
    expect(snapshotOf(e.zone)).toEqual(before)
  })

  it.each([
    ['just written (every file in the mtime window: all compared by content)', 0],
    ['written an hour ago (only the run\'s files in the window)', 3_600_000],
  ])('a 10k-file workspace snapshot takes under 2 s: %s', async (_label, age) => {
    const e = makeEnv(driver)
    const old = new Date(Date.now() - (age as number))
    for (let i = 0; i < 10_000; i++) {
      const f = path.join(e.zone, `d${i % 100}`, `f${i}.txt`)
      put(f, `file ${i}\n`)
      if (age) utimesSync(f, old, old)
    }
    let t = performance.now()
    const h = (await e.svc.begin(agent, 'big-1'))!
    const beginMs = performance.now() - t
    e.bot.write('d1/f1.txt', 'changed\n')
    t = performance.now()
    const out = await e.svc.finish(h)
    const finishMs = performance.now() - t
    expect(out.filesChanged.map((c) => c.path)).toEqual(['workspace/d1/f1.txt'])
    // The second snapshot uses the hash index (copy: no new blobs) for files older than the window.
    t = performance.now()
    const h2 = (await e.svc.begin(agent, 'big-2'))!
    const begin2Ms = performance.now() - t
    await e.svc.finish(h2)
    const second = performance.now() - t
    // The 2 s timing is logged always (before any check) and enforced only off CI (GitHub runners are slower).
    const enforceTiming = !process.env.CI
    console.info(`[snapshot timing${enforceTiming ? '' : ', CI: not enforced'}] ${driver} age=${age}: begin ${beginMs.toFixed(0)} ms, finish ${finishMs.toFixed(0)} ms, second begin ${begin2Ms.toFixed(0)} ms, second begin+finish ${second.toFixed(0)} ms`)
    if (enforceTiming) {
      expect(beginMs).toBeLessThan(2000)
      expect(finishMs).toBeLessThan(2000)
      expect(second).toBeLessThan(2000)
    }
  }, 30_000)

  it('mtime window: a same-size rewrite that keeps the mtime is still a change (content compared); same bytes are not', async () => {
    const e = makeEnv(driver)
    seed(e)
    const a = path.join(e.zone, 'a.txt')
    const b = path.join(e.zone, 'b.txt')
    // Whole seconds, so the restored mtime is exactly the pre-run one; it's within the window.
    const sec = Math.floor(Date.now() / 1000)
    utimesSync(a, sec, sec)
    utimesSync(b, sec, sec)
    const h = (await e.svc.begin(agent, 'run-1'))!
    const bot = driver === 'overlay' ? e.svc.overlayDirs('analyst', 'workspace')!.upper : e.zone
    e.bot.write('a.txt', 'ALPHA\n') // same size as 'alpha\n'
    utimesSync(path.join(bot, 'a.txt'), sec, sec) // and the same mtime
    e.bot.write('b.txt', 'bravo bravo\n') // same bytes, same mtime
    utimesSync(path.join(bot, 'b.txt'), sec, sec)
    const out = await e.svc.finish(h)
    expect(statSync(a).size).toBe(6)
    expect(Math.floor(statSync(a).mtimeMs)).toBe(sec * 1000)
    expect(out.filesChanged.map((c) => [c.path, c.change])).toEqual([['workspace/a.txt', 'modified']])
    applyUndo(e.svc.undoSource('analyst', 'run-1')!, e.zones)
    expect(read(a)).toBe('alpha\n')
    expect(e.svc.read('analyst', 'run-1')!.window).toMatchObject({ startMs: expect.any(Number), endMs: expect.any(Number), marginMs: 2000 })
  })

  it('mtime window: a same-size, same-mtime rewrite between runs isn\'t hidden by the hash index', async () => {
    const e = makeEnv(driver)
    seed(e)
    const a = path.join(e.zone, 'a.txt')
    const sec = Math.floor(Date.now() / 1000)
    writeFileSync(a, 'one!!\n')
    utimesSync(a, sec, sec)
    const h1 = (await e.svc.begin(agent, 'run-1'))! // copy: stores a blob of 'one!!'
    e.bot.write('b.txt', 'run 1 edits b\n')
    await e.svc.finish(h1)
    // Right after run-1 (the index holds 'one!!' for this size and mtime), the user rewrites it.
    expect(Math.floor(statSync(a).mtimeMs)).toBe(sec * 1000)
    writeFileSync(a, 'two!!\n')
    utimesSync(a, sec, sec)
    const h2 = (await e.svc.begin(agent, 'run-2'))!
    e.bot.write('a.txt', 'three\n')
    await e.svc.finish(h2)
    const src = e.svc.undoSource('analyst', 'run-2')!.find((u) => u.rel === 'a.txt')!
    expect(src.original?.kind === 'file' && read(src.original.file)).toBe('two!!\n')
    expect(e.svc.read('analyst', 'run-2')!.changes.find((c) => c.path === 'a.txt')?.beforeSha).toBe(createHash('sha256').update('two!!\n').digest('hex'))
  })

  it('mtime window: files older than the window keep the fast size/mtime check (not re-read); overlay compares every touched file', async () => {
    const e = makeEnv(driver)
    seed(e)
    const a = path.join(e.zone, 'a.txt')
    const old = Math.floor(Date.now() / 1000) - 3600
    utimesSync(a, old, old)
    const h = (await e.svc.begin(agent, 'run-1'))!
    const bot = driver === 'overlay' ? e.svc.overlayDirs('analyst', 'workspace')!.upper : e.zone
    e.bot.write('a.txt', 'ALPHA\n')
    utimesSync(path.join(bot, 'a.txt'), old, old) // an explicit set-back to an hour-old mtime
    const out = await e.svc.finish(h)
    expect(out.filesChanged.map((c) => c.path)).toEqual(driver === 'overlay' ? ['workspace/a.txt'] : [])
  })
})

describe('SnapshotService: overlay details', () => {
  it('an opaque (replaced) folder: the whole old folder is kept and restorable', async () => {
    const e = makeEnv('overlay')
    put(path.join(e.zone, 'd', 'old1.txt'), '1')
    put(path.join(e.zone, 'd', 'deep', 'old2.txt'), '22')
    const h = (await e.svc.begin(agent, 'r1'))!
    e.bot.replaceDir('d')
    e.bot.write('d/fresh.txt', 'fresh')
    const out = await e.svc.finish(h)
    expect(out.filesChanged.map((c) => [c.path, c.change]).sort()).toEqual([['workspace/d/deep/old2.txt', 'deleted'], ['workspace/d/fresh.txt', 'added'], ['workspace/d/old1.txt', 'deleted']])
    expect(out.snapshot.retainedBytes).toBe(3)
    expect(snapshotOf(path.join(e.zone, 'd'))).toEqual({ 'fresh.txt': 'fresh' })
  })

  it('writes made between runs are committed into the next run; the upper layer is empty after a commit', async () => {
    const e = makeEnv('overlay')
    put(path.join(e.zone, 'a.txt'), 'a')
    e.bot.write('idle.txt', 'from an exec at idle')
    const h = (await e.svc.begin(agent, 'r1'))!
    expect(readdirSync(e.svc.overlayDirs('analyst', 'workspace')!.upper)).toEqual([])
    const out = await e.svc.finish(h)
    expect(out.filesChanged.map((c) => c.path)).toEqual(['workspace/idle.txt'])
  })

  it('mountsFor adds upper/work to writable zone mounts only; needsStop only for overlay', () => {
    const e = makeEnv('overlay')
    const mounts = [
      { source: e.zone, target: '/bot/workspace', readonly: false },
      { source: '/x/shared', target: '/bot/shared', readonly: true },
      { source: e.group, target: '/bot/groups/research', readonly: false },
    ]
    const m = e.svc.mountsFor(agent, mounts as never)
    expect(m[0]!.overlay?.upper).toBe(path.join(e.base, 'snapshots', 'analyst', '.overlay', 'workspace', 'upper'))
    expect(m[1]!.overlay).toBeUndefined()
    expect(m[2]!.overlay?.work).toBe(path.join(e.base, 'snapshots', 'analyst', '.overlay', 'group-research', 'work'))
    expect(e.svc.needsStop()).toBe(true)
    expect(makeEnv('copy').svc.mountsFor(agent, mounts as never)).toEqual(mounts)
    expect(makeEnv('reflink').svc.needsStop()).toBe(false)
  })

  it('commitOverlay: a lower path of another type is replaced whole; the earliest original is kept', async () => {
    const d = tmp()
    const [u, l, o] = ['u', 'l', 'o'].map((x) => path.join(d, x)) as [string, string, string]
    put(path.join(l, 'x', 'inside.txt'), 'dir before')
    put(path.join(u, 'x'), 'now a file')
    put(path.join(l, 'f.txt'), 'v1')
    put(path.join(o, 'f.txt'), 'v0') // an earlier commit in the same run kept v0
    put(path.join(u, 'f.txt'), 'v2')
    const t = await commitOverlay(u, l, o, async () => new Set())
    expect(read(path.join(l, 'x'))).toBe('now a file')
    expect(read(path.join(o, 'x', 'inside.txt'))).toBe('dir before')
    expect(read(path.join(o, 'f.txt'))).toBe('v0')
    expect(read(path.join(l, 'f.txt'))).toBe('v2')
    expect([...t.files].sort()).toEqual(['f.txt', 'x'])
    expect(t.dirs.has('x')).toBe(true)
    expect(readdirSync(u)).toEqual([])
  })
})

describe('SnapshotService: guards', () => {
  it('no root or no driver → no snapshot; bad run ids, zone keys and duplicate runs are refused', async () => {
    const none = createSnapshotService({ root: () => null, driver: () => 'copy', zones: () => [] })
    expect(await none.begin(agent, 'r1')).toBeNull()
    expect(none.driver()).toBeNull()
    const off = createSnapshotService({ root: () => tmp(), driver: () => null, zones: () => [] })
    expect(await off.begin(agent, 'r1')).toBeNull()
    const e = makeEnv('copy')
    await expect(e.svc.begin(agent, '../etc')).rejects.toThrow(/bad run id/)
    await e.svc.finish((await e.svc.begin(agent, 'r1'))!)
    await expect(e.svc.begin(agent, 'r1')).rejects.toThrow(/already exists/)
    const bad = createSnapshotService({ root: () => tmp(), driver: () => 'copy', zones: () => [{ key: '../x', dir: tmp(), target: '/t', root: 'agent', prefix: 'workspace' }] })
    await expect(bad.begin(agent, 'r1')).rejects.toThrow(/bad snapshot zone/)
    expect(await e.svc.begin({ slug: '../x' } as Agent, 'r2')).toBeNull()
    expect(e.svc.read('analyst', '../r1')).toBeNull()
    expect(RUN_ID_RE.test(newRunId())).toBe(true)
  })

  it('manifests: symlinks not followed, mode/size changes seen, mtime-only touches ignored when content matches', () => {
    const d = tmp()
    put(path.join(d, 'f'), 'same')
    symlinkSync('/etc/passwd', path.join(d, 'l'))
    const pre = takeManifest(d, { zone: 'w', hash: 'changed' })
    expect(pre.find((x) => x.path === 'l')).toMatchObject({ kind: 'symlink', target: '/etc/passwd' })
    expect(pre.find((x) => x.path === 'l')?.sha256).toBeUndefined()
    const st = statSync(path.join(d, 'f'))
    writeFileSync(path.join(d, 'f'), 'same')
    const later = new Date(st.mtimeMs + 5000)
    utimesSync(path.join(d, 'f'), later, later)
    const post = takeManifest(d, { zone: 'w', hash: 'changed' })
    expect(diffManifests(pre, post)).toEqual([])
    chmodSync(path.join(d, 'f'), 0o600)
    expect(diffManifests(pre, takeManifest(d, { zone: 'w', hash: 'changed' })).map((c) => c.change)).toEqual(['modified'])
    expect(lstatSync(path.join(d, 'l')).isSymbolicLink()).toBe(true)
    unlinkSync(path.join(d, 'l'))
  })
})

describe('symlink swaps and driver switches', () => {
  it('never reads through a symlink: O_NOFOLLOW hashing and blob copies', async () => {
    const { copyNoFollow } = await import('./snapshot.js')
    const { sha256File } = await import('./snapshot-manifest.js')
    const d = tmp()
    put(path.join(d, 'secret'), 'host secret\n')
    symlinkSync(path.join(d, 'secret'), path.join(d, 'link'))
    expect(() => sha256File(path.join(d, 'link'))).toThrow()
    expect(() => copyNoFollow(path.join(d, 'link'), path.join(d, 'out'))).toThrow()
    expect(existsSync(path.join(d, 'out'))).toBe(false)
    copyNoFollow(path.join(d, 'secret'), path.join(d, 'out'))
    expect(read(path.join(d, 'out'))).toBe('host secret\n')
  })

  it('reflink: a file swapped for a symlink during the clone fails the snapshot and keeps no copy of the target', async () => {
    const base = tmp()
    const zone = path.join(base, 'ws')
    const outside = path.join(base, 'outside.txt')
    put(outside, 'host only\n')
    put(path.join(zone, 'a.txt'), 'alpha\n')
    const root = path.join(base, 'snapshots')
    const svc = createSnapshotService({
      root: () => root, driver: () => 'reflink',
      zones: () => [{ key: 'workspace', dir: zone, target: '/bot/workspace', root: 'agent', prefix: 'workspace' }],
      clone: (s, dst) => {
        // A process the bot left running swaps the file just before it is read.
        unlinkSync(s)
        symlinkSync(outside, s)
        copyFileSync(s, dst)
      },
    })
    await expect(svc.begin(agent, 'run-swap')).rejects.toThrow(/replaced by a link/)
    const leaked = existsSync(path.join(root, 'analyst', 'run-swap', 'files', 'workspace', 'a.txt'))
    expect(leaked).toBe(false)
  })

  it('copy: a file that became a symlink to a host file is recorded as a link, never copied into the blob store', async () => {
    const base = tmp()
    const zone = path.join(base, 'ws')
    const outside = path.join(base, 'outside.txt')
    put(outside, 'host only\n')
    put(path.join(zone, 'a.txt'), 'alpha\n')
    const root = path.join(base, 'snapshots')
    const svc = createSnapshotService({ root: () => root, driver: () => 'copy', zones: () => [{ key: 'workspace', dir: zone, target: '/bot/workspace', root: 'agent', prefix: 'workspace' }] })
    await svc.finish((await svc.begin(agent, 'run-1'))!)
    unlinkSync(path.join(zone, 'a.txt'))
    symlinkSync(outside, path.join(zone, 'a.txt'))
    const o = await svc.finish((await svc.begin(agent, 'run-2'))!)
    expect(o.filesChanged).toEqual([])
    const blobs = path.join(root, 'analyst', '.blobs')
    for (const b of readdirSync(blobs)) expect(read(path.join(blobs, b))).not.toBe('host only\n')
  })

  it('switching overlay -> reflink commits leftover upper layers into the next run and removes them', async () => {
    const e = makeEnv('overlay')
    seed(e)
    // An exec at idle under overlay wrote into the upper layer; then the driver changed.
    e.bot.write('a.txt', 'changed at idle\n')
    e.bot.write('new.txt', 'new at idle\n')
    const driver: SnapshotDriver = 'reflink'
    const root = path.join(e.base, 'snapshots')
    const svc = createSnapshotService({ root: () => root, driver: () => driver, zones: () => e.zones, clone: (s, d) => copyFileSync(s, d),
      opaqueDirs: async (ds) => new Set(ds.filter((d) => existsSync(path.join(d, '.wh..wh..opq')))) })
    expect(svc.needsStop(agent)).toBe(true)
    expect(svc.needsStop()).toBe(false)
    const h = await svc.begin(agent, 'run-switch')
    expect(existsSync(path.join(root, 'analyst', '.overlay'))).toBe(false)
    expect(svc.needsStop(agent)).toBe(false)
    expect(read(path.join(e.zone, 'a.txt'))).toBe('changed at idle\n')
    const o = await svc.finish(h!)
    const byPath = Object.fromEntries(o.filesChanged.map((c) => [c.path, c.change]))
    expect(byPath).toEqual({ 'workspace/a.txt': 'modified', 'workspace/new.txt': 'added' })
    const undo = svc.undoSource('analyst', 'run-switch')!
    applyUndo(undo, e.zones)
    expect(read(path.join(e.zone, 'a.txt'))).toBe('alpha\n')
    expect(existsSync(path.join(e.zone, 'new.txt'))).toBe(false)
  })
})
