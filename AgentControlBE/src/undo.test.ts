/**
 * BE-P2-11: undo (plan §7.3) over the snapshot service (reflink simulated, copy, overlay
 * simulated), with the files written through the StorageBackend (LocalFs, and WslFs over acfs
 * in-process). The real-container version is undo.vm.test.ts (@vm).
 */
import {
  chmodSync, copyFileSync, utimesSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent, SnapshotDriver, UndoConflict, UndoGone } from './shared/types.js'
import { buildApp } from './app.js'
import { failWithReason } from './http.js'
import { createContainerRunner } from './podman-runner.js'
import { createSnapshotService, newRunId, type SnapshotMeta, type SnapshotService, type SnapshotZone } from './snapshot.js'
import { createStore } from './store.js'
import { inProcessTransport, LocalFs, WslFs } from './storage/index.js'
import type { StorageBackend } from './storage/types.js'
import { createUndoService, UNDO_ALREADY_DONE_TEXT, UNDO_RUN_ACTIVE_TEXT, type UndoService } from './undo.js'

const agent = { id: 'ag1', slug: 'analyst', name: 'Analyst' } as Agent
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const put = (file: string, text: string) => {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
}
const read = (file: string) => readFileSync(file, 'utf8')
const modeOf = (file: string) => statSync(file).mode & 0o777

interface Env {
  vol: string
  zone: string
  group: string
  svc: SnapshotService
  undo: UndoService
  stops: number
  active: { n: number }
  /** A run as the bot would make it (overlay: writes go to the upper layer). */
  run(fn: (b: Bot) => void): Promise<string>
}
interface Bot { write(rel: string, text: string, zone?: 'group'): void; setMtime(rel: string, sec: number): void; rm(rel: string, zone?: 'group'): void; chmod(rel: string, mode: number): void; link(rel: string, target: string): void }

function makeEnv(driver: SnapshotDriver, opts: { backend?: 'local' | 'wsl'; groupGone?: () => boolean } = {}): Env {
  const vol = mkdtempSync(path.join(tmpdir(), 'ac-undo-'))
  dirs.push(vol)
  const zone = path.join(vol, 'bots', 'analyst', 'workspace')
  const group = path.join(vol, 'groups', 'research', 'shared')
  mkdirSync(zone, { recursive: true })
  mkdirSync(group, { recursive: true })
  const zones: SnapshotZone[] = [
    { key: 'workspace', dir: zone, target: '/bot/workspace', root: 'agent', prefix: 'workspace' },
    { key: 'group-research', dir: group, target: '/bot/groups/research', root: 'group', prefix: 'shared', groupId: 'g1', groupName: 'Research' },
  ]
  const root = path.join(vol, 'snapshots')
  const svc = createSnapshotService({
    root: () => root, driver: () => driver, zones: () => zones,
    clone: (s, d) => copyFileSync(s, d),
    opaqueDirs: async (ds) => new Set(ds.filter((d) => existsSync(path.join(d, '.wh..wh..opq')))),
  })
  const local = new LocalFs(vol)
  const fs: StorageBackend = opts.backend === 'wsl' ? new WslFs(inProcessTransport(local)) : local
  const runner = createContainerRunner({
    botEnv: {} as never, engine: async () => null, getAgent: () => agent, runtime: () => ({}) as never,
  })
  const active = { n: 0 }
  const env: Env = {
    vol, zone, group, svc, stops: 0, active,
    undo: createUndoService({
      snapshots: svc,
      storage: () => fs,
      zone: (_a, info) => {
        const z = zones.find((x) => x.key === info.key)
        if (!z || (z.root === 'group' && opts.groupGone?.())) return null
        return { zone: z, vol: z.root === 'group' ? 'groups/research' : 'bots/analyst', sub: [z.root === 'group' ? 'shared' : 'workspace'] }
      },
      volOf: (p) => {
        const rel = path.relative(vol, p)
        return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : null
      },
      activeRuns: (id) => active.n + runner.activeRuns(id),
      exclusive: (id, fn) => runner.exclusive(id, fn),
      stopBot: async () => { env.stops++ },
      newRunId,
      usage: () => ({ bytes: 123, budgetBytes: 2048 }),
      perBotBytes: () => 2 * 1024 ** 3,
    }),
    async run(fn) {
      const id = newRunId()
      const h = (await svc.begin(agent, id))!
      const ov = driver === 'overlay'
      const lower = (z?: 'group') => (z ? group : zone)
      const upper = (z?: 'group') => svc.overlayDirs('analyst', z ? 'group-research' : 'workspace')!.upper
      const b: Bot = {
        write: (rel, text, z) => put(path.join(ov ? upper(z) : lower(z), rel), text),
        setMtime: (rel, sec) => utimesSync(path.join(ov ? upper() : lower(), rel), sec, sec),
        rm: (rel, z) => {
          if (!ov) return rmSync(path.join(lower(z), rel))
          put(path.join(upper(z), path.dirname(rel), `.wh.${path.basename(rel)}`), '')
        },
        chmod: (rel, mode) => {
          if (ov && !existsSync(path.join(upper(), rel))) put(path.join(upper(), rel), read(path.join(lower(), rel)))
          chmodSync(path.join(ov ? upper() : lower(), rel), mode)
        },
        link: (rel, target) => {
          const p = path.join(ov ? upper() : lower(), rel)
          mkdirSync(path.dirname(p), { recursive: true })
          rmSync(p, { force: true })
          symlinkSync(target, p)
        },
      }
      fn(b)
      await svc.finish(h)
      return id
    },
  }
  return env
}

function seed(e: Env) {
  put(path.join(e.zone, 'a.txt'), 'alpha\n')
  chmodSync(path.join(e.zone, 'a.txt'), 0o750)
  put(path.join(e.zone, 'b.txt'), 'bravo\n')
  put(path.join(e.zone, 'sub', 'c.txt'), 'charlie\n')
  put(path.join(e.zone, 'keep.txt'), 'untouched\n')
  put(path.join(e.group, 'notes.md'), '# notes\n')
  symlinkSync('a.txt', path.join(e.zone, 'link'))
}

const errOf = async (p: Promise<unknown> | (() => unknown)): Promise<Error & { statusCode?: number; reason?: string; conflicts?: unknown[] }> => {
  try {
    await (typeof p === 'function' ? p() : p)
  } catch (x) {
    return x as Error & { statusCode?: number; reason?: string; conflicts?: unknown[] }
  }
  throw new Error('expected an error')
}

describe.each(['reflink', 'copy', 'overlay'] as const)('undo (%s)', (driver) => {
  it('restores exact bytes and mode, deletes added files, restores deleted ones and links; R is done; undo of undo', async () => {
    const e = makeEnv(driver)
    seed(e)
    const r = await e.run((b) => {
      b.write('a.txt', 'alpha CHANGED by the run\n')
      b.chmod('a.txt', 0o600)
      b.write('new/added.txt', 'added\n')
      b.rm('b.txt')
      b.write('notes.md', '# notes, rewritten\n', 'group')
      b.link('link', 'b.txt')
    })
    const prev = e.undo.preview(agent, r)
    expect(prev.conflicts).toEqual([])
    expect(prev.caveats).toEqual(['internet', 'tools'])
    expect(prev.budget).toEqual({ usedBytes: 123, limitBytes: 2048 })
    const by = Object.fromEntries(prev.changes.map((c) => [c.path, c]))
    expect(by['workspace/new/added.txt']).toMatchObject({ action: 'delete', root: 'agent', afterBytes: 6, beforeBytes: null })
    expect(by['workspace/b.txt']).toMatchObject({ action: 'restore', afterBytes: null, beforeBytes: 6 })
    expect(by['workspace/a.txt']).toMatchObject({ action: 'restore', afterBytes: 25, beforeBytes: 6 })
    expect(by['shared/notes.md']).toMatchObject({ action: 'restore', root: 'group', groupId: 'g1', groupName: 'Research' })
    expect(by['workspace/link']).toMatchObject({ action: 'restore' })

    const res = await e.undo.apply(agent, r)
    expect(read(path.join(e.zone, 'a.txt'))).toBe('alpha\n')
    expect(modeOf(path.join(e.zone, 'a.txt'))).toBe(0o750)
    expect(read(path.join(e.zone, 'b.txt'))).toBe('bravo\n')
    expect(existsSync(path.join(e.zone, 'new', 'added.txt'))).toBe(false)
    expect(read(path.join(e.group, 'notes.md'))).toBe('# notes\n')
    expect(lstatSync(path.join(e.zone, 'link')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(path.join(e.zone, 'link'))).toBe('a.txt')
    expect(read(path.join(e.zone, 'keep.txt'))).toBe('untouched\n')
    expect(res.skipped).toEqual([])
    expect(res.undo).toMatchObject({ state: 'done', undoRunId: res.undoRunId })
    expect(e.stops).toBe(driver === 'overlay' ? 1 : 0)
    // R: done, its retained data dropped; the undo run: "undo of R", itself undoable.
    expect(e.svc.read('analyst', r)!.undo).toMatchObject({ state: 'done', undoRunId: res.undoRunId })
    expect(existsSync(path.join(e.vol, 'snapshots', 'analyst', r, 'files'))).toBe(false)
    expect(e.svc.sizeOf(e.svc.read('analyst', r)!)).toBe(0)
    const u = e.svc.read('analyst', res.undoRunId)!
    expect(u.undoOf).toBe(r)
    expect(res.filesChanged.map((f) => `${f.change} ${f.path}`).sort()).toEqual([
      'added workspace/b.txt', 'deleted workspace/new/added.txt', 'modified shared/notes.md', 'modified workspace/a.txt', 'modified workspace/link',
    ])
    expect(res.snapshot.id).toBe(res.undoRunId)
    // R again: 409 already_undone.
    const again = await errOf(e.undo.apply(agent, r))
    expect(again).toMatchObject({ statusCode: 409, reason: 'already_undone', message: UNDO_ALREADY_DONE_TEXT })
    expect((await errOf(() => e.undo.preview(agent, r))).statusCode).toBe(409)

    // Undo of the undo brings the run's changes back.
    const back = await e.undo.apply(agent, res.undoRunId)
    expect(read(path.join(e.zone, 'a.txt'))).toBe('alpha CHANGED by the run\n')
    expect(modeOf(path.join(e.zone, 'a.txt'))).toBe(0o600)
    expect(read(path.join(e.zone, 'new', 'added.txt'))).toBe('added\n')
    expect(existsSync(path.join(e.zone, 'b.txt'))).toBe(false)
    expect(read(path.join(e.group, 'notes.md'))).toBe('# notes, rewritten\n')
    expect(readlinkSync(path.join(e.zone, 'link'))).toBe('b.txt')
    expect(e.svc.read('analyst', back.undoRunId)!.undoOf).toBe(res.undoRunId)
  })

  it('a later run\'s change is a conflict: 409 with the list, force overwrites only what R touched', async () => {
    const e = makeEnv(driver)
    seed(e)
    const r = await e.run((b) => {
      b.write('a.txt', 'run 1\n')
      b.write('added.txt', 'added by run 1\n')
      b.rm('b.txt')
    })
    await e.run((b) => {
      b.write('a.txt', 'run 2\n')
      b.write('b.txt', 'run 2 recreates b\n')
      b.write('keep.txt', 'run 2 edits keep\n')
    })
    const prev = e.undo.preview(agent, r)
    expect(prev.conflicts).toEqual([
      { path: 'workspace/a.txt', root: 'agent' },
      { path: 'workspace/b.txt', root: 'agent' },
    ])
    const err = await errOf(e.undo.apply(agent, r))
    expect(err).toMatchObject({ statusCode: 409, reason: 'conflicts' })
    expect(err.message).toMatch(/2 files changed after this run/)
    expect(err.conflicts).toEqual(prev.conflicts)
    expect(read(path.join(e.zone, 'a.txt'))).toBe('run 2\n')
    expect(e.svc.read('analyst', r)!.undo).toBeUndefined()

    const res = await e.undo.apply(agent, r, { force: true })
    expect(read(path.join(e.zone, 'a.txt'))).toBe('alpha\n')
    expect(read(path.join(e.zone, 'b.txt'))).toBe('bravo\n')
    expect(existsSync(path.join(e.zone, 'added.txt'))).toBe(false)
    expect(read(path.join(e.zone, 'keep.txt'))).toBe('run 2 edits keep\n')
    // The overwritten later edits are in the undo run's snapshot: undoing the undo brings them back.
    await e.undo.apply(agent, res.undoRunId)
    expect(read(path.join(e.zone, 'a.txt'))).toBe('run 2\n')
    expect(read(path.join(e.zone, 'b.txt'))).toBe('run 2 recreates b\n')
  })

  it('mtime window: a later same-size rewrite that keeps R\'s mtime is a conflict (content compared); the same bytes are not', async () => {
    const e = makeEnv(driver)
    seed(e)
    // Whole seconds, so the restored mtime is exactly the one R left (as a rewrite inside one
    // timestamp tick would leave it); it's within R's window.
    const sec = Math.floor(Date.now() / 1000)
    const r = await e.run((b) => {
      b.write('a.txt', 'run 1\n')
      b.setMtime('a.txt', sec)
      b.write('sub/c.txt', 'by run1\n')
      b.setMtime('sub/c.txt', sec)
    })
    const left = e.svc.read('analyst', r)!.changes.find((c) => c.path === 'a.txt')!.afterMtimeMs
    expect(left).toBe(sec * 1000)
    await e.run((b) => {
      b.write('a.txt', 'run X\n') // same size as R's 'run 1\n'
      b.setMtime('a.txt', sec) // and the same mtime
      b.write('sub/c.txt', 'by run1\n') // same bytes, same mtime: not a conflict
      b.setMtime('sub/c.txt', sec)
    })
    expect(statSync(path.join(e.zone, 'a.txt')).size).toBe('run 1\n'.length)
    expect(Math.floor(statSync(path.join(e.zone, 'a.txt')).mtimeMs)).toBe(left)
    expect(e.undo.preview(agent, r).conflicts).toEqual([{ path: 'workspace/a.txt', root: 'agent' }])
    expect(await errOf(e.undo.apply(agent, r))).toMatchObject({ statusCode: 409, reason: 'conflicts', conflicts: [{ path: 'workspace/a.txt', root: 'agent' }] })
    await e.undo.apply(agent, r, { force: true })
    expect(read(path.join(e.zone, 'a.txt'))).toBe('alpha\n')
    expect(read(path.join(e.zone, 'sub', 'c.txt'))).toBe('charlie\n')
  })
})

describe('undo: states and safety', () => {
  it('410 carries the eviction reason (and expired when the record is gone)', async () => {
    const e = makeEnv('copy')
    seed(e)
    const r = await e.run((b) => b.write('a.txt', 'x\n'))
    e.svc.evict('analyst', r, 'budget_bot')
    const gone = await errOf(e.undo.apply(agent, r))
    expect(gone).toMatchObject({ statusCode: 410, reason: 'budget_bot' })
    expect(gone.message).toBe('Undo isn\'t available for this run: it was removed to stay within Analyst\'s 2 GB undo space.')
    expect(await errOf(() => e.undo.preview(agent, r))).toMatchObject({ statusCode: 410, reason: 'budget_bot' })
    const r2 = await e.run((b) => b.write('a.txt', 'y\n'))
    e.svc.evict('analyst', r2, 'machine_restored')
    expect(await errOf(e.undo.apply(agent, r2))).toMatchObject({ statusCode: 410, reason: 'machine_restored', message: 'This bot\'s computer was restored from a backup, so this run can\'t be undone.' })
    expect(await errOf(e.undo.apply(agent, newRunId()))).toMatchObject({ statusCode: 410, reason: 'expired' })
    expect(read(path.join(e.zone, 'a.txt'))).toBe('y\n')
  })

  it('409 run_active while the bot has a run; undo runs in the bot\'s run slot', async () => {
    const e = makeEnv('reflink')
    seed(e)
    const r = await e.run((b) => b.write('a.txt', 'x\n'))
    e.active.n = 1
    expect(await errOf(e.undo.apply(agent, r))).toMatchObject({ statusCode: 409, reason: 'run_active', message: UNDO_RUN_ACTIVE_TEXT })
    expect(read(path.join(e.zone, 'a.txt'))).toBe('x\n')
    e.active.n = 0
    await e.undo.apply(agent, r)
    expect(read(path.join(e.zone, 'a.txt'))).toBe('alpha\n')
  })

  it('a crafted record (path traversal, odd zone, odd blob name) is refused and nothing is touched', async () => {
    for (const driver of ['reflink', 'copy'] as const) {
      const e = makeEnv(driver)
      seed(e)
      put(path.join(e.vol, 'outside.txt'), 'outside\n')
      const r = await e.run((b) => {
        b.write('a.txt', 'x\n')
        b.write('added.txt', 'y\n')
      })
      const file = path.join(e.vol, 'snapshots', 'analyst', r, 'meta.json')
      const meta = JSON.parse(read(file)) as SnapshotMeta
      for (const bad of ['../../../outside.txt', '/etc/passwd', 'sub/../../x', '']) {
        writeFileSync(file, JSON.stringify({ ...meta, changes: [...meta.changes, { ...meta.changes[0]!, path: bad }] }))
        expect((await errOf(e.undo.apply(agent, r, { force: true }))).statusCode).toBe(400)
        expect((await errOf(() => e.undo.preview(agent, r))).statusCode).toBe(400)
      }
      writeFileSync(file, JSON.stringify({ ...meta, changes: [...meta.changes, { ...meta.changes[0]!, zone: 'group-../../x' }] }))
      expect((await errOf(e.undo.apply(agent, r, { force: true }))).statusCode).toBe(400)
      if (driver === 'copy') {
        // A blob name that isn't a hash: the original is treated as missing (never read).
        const changes = meta.changes.map((c) => (c.change === 'modified' ? { ...c, beforeSha: '../../../../outside.txt' } : c))
        writeFileSync(file, JSON.stringify({ ...meta, changes }))
        const res = await e.undo.apply(agent, r, { force: true })
        expect(res.skipped).toEqual([{ path: 'workspace/a.txt', root: 'agent', why: 'original_missing' }])
        expect(read(path.join(e.zone, 'a.txt'))).toBe('x\n')
      } else {
        expect(read(path.join(e.zone, 'a.txt'))).toBe('x\n')
        expect(read(path.join(e.zone, 'added.txt'))).toBe('y\n')
      }
      expect(read(path.join(e.vol, 'outside.txt'))).toBe('outside\n')
    }
  })

  it('a link planted on the way is never followed (the restore fails, the partial undo is recorded)', async () => {
    const e = makeEnv('reflink')
    seed(e)
    const outside = mkdtempSync(path.join(tmpdir(), 'ac-undo-out-'))
    dirs.push(outside)
    const r = await e.run((b) => b.write('sub/c.txt', 'changed\n'))
    rmSync(path.join(e.zone, 'sub'), { recursive: true })
    symlinkSync(outside, path.join(e.zone, 'sub'))
    const err = await errOf(e.undo.apply(agent, r, { force: true }))
    expect(err.statusCode).toBe(400)
    expect(existsSync(path.join(outside, 'c.txt'))).toBe(false)
    expect(e.svc.read('analyst', r)!.undo).toBeUndefined()
    expect(e.svc.pending(agent)).toBe(false)
  })

  it('files in a group folder that no longer exists are conflicts, and skipped with force', async () => {
    let gone = false
    const e = makeEnv('copy', { groupGone: () => gone })
    seed(e)
    const r = await e.run((b) => {
      b.write('a.txt', 'x\n')
      b.write('notes.md', 'changed\n', 'group')
    })
    gone = true
    expect(e.undo.preview(agent, r).conflicts).toEqual([{ path: 'shared/notes.md', root: 'group', groupId: 'g1', groupName: 'Research' }])
    const res = await e.undo.apply(agent, r, { force: true })
    expect(res.skipped).toEqual([{ path: 'shared/notes.md', root: 'group', groupId: 'g1', groupName: 'Research', why: 'group_gone' }])
    expect(read(path.join(e.zone, 'a.txt'))).toBe('alpha\n')
  })

  it('a run being undone is not evicted meanwhile (hold)', async () => {
    const e = makeEnv('copy')
    seed(e)
    const r = await e.run((b) => b.write('a.txt', 'x\n'))
    const release = e.svc.hold('analyst', r)
    expect(e.svc.evict('analyst', r, 'budget_bot')).toBeNull()
    expect(e.svc.read('analyst', r)!.undo).toBeUndefined()
    release()
    release()
    expect(e.svc.evict('analyst', r, 'budget_bot')!.undo).toMatchObject({ state: 'unavailable' })
  })

  it('works through the WslFs backend (acfs ops inspect/restore, in-process)', async () => {
    const e = makeEnv('copy', { backend: 'wsl' })
    seed(e)
    const r = await e.run((b) => {
      b.write('a.txt', 'x\n')
      b.write('added.txt', 'y\n')
      b.rm('b.txt')
    })
    await e.undo.apply(agent, r)
    expect(read(path.join(e.zone, 'a.txt'))).toBe('alpha\n')
    expect(modeOf(path.join(e.zone, 'a.txt'))).toBe(0o750)
    expect(read(path.join(e.zone, 'b.txt'))).toBe('bravo\n')
    expect(existsSync(path.join(e.zone, 'added.txt'))).toBe(false)
  })
})

describe('ContainerRunner.exclusive', () => {
  it('waits for the runs before it, counts as active, and holds later ones', async () => {
    const runner = createContainerRunner({ botEnv: {} as never, engine: async () => null, getAgent: () => agent, runtime: () => ({}) as never })
    const order: string[] = []
    let release!: () => void
    const first = runner.exclusive('ag1', () => new Promise<void>((r) => { order.push('first'); release = r }))
    const second = runner.exclusive('ag1', async () => { order.push('second') })
    await new Promise((r) => setTimeout(r, 5))
    expect(runner.activeRuns('ag1')).toBe(2)
    expect(order).toEqual(['first'])
    release()
    await Promise.all([first, second])
    expect(order).toEqual(['first', 'second'])
    expect(runner.activeRuns('ag1')).toBe(0)
    await expect(runner.exclusive('ag1', async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(runner.activeRuns('ag1')).toBe(0)
  })
})

describe('undo error bodies (app error handler)', () => {
  it('409 conflicts carries the list; 410 carries the reason; app.vmUndo is wired', async () => {
    vi.stubEnv('AGENTCONTROL_SECRET', 'be11-secret')
    vi.stubEnv('AGENTCONTROL_AUTH_TOKEN', '')
    const dir = mkdtempSync(path.join(tmpdir(), 'ac-undo-app-'))
    dirs.push(dir)
    const app = buildApp(createStore(path.join(dir, 'store.json')))
    try {
      const conflicts = [{ path: 'shared/notes.md', root: 'group' as const, groupId: 'g1', groupName: 'Research' }]
      app.get('/test-only/undo-409', async () => failWithReason(409, 'conflicts', '1 file changed after this run.', { conflicts }))
      app.get('/test-only/undo-410', async () => app.vmUndo.preview({ id: 'x', slug: 'nobody', name: 'Nobody' } as Agent, newRunId()))
      const c = await app.inject({ method: 'GET', url: '/test-only/undo-409' })
      expect(c.statusCode).toBe(409)
      expect(c.json<UndoConflict>()).toEqual({ statusCode: 409, error: 'Request Error', message: '1 file changed after this run.', reason: 'conflicts', conflicts })
      const g = await app.inject({ method: 'GET', url: '/test-only/undo-410' })
      expect(g.statusCode).toBe(410)
      expect(g.json<UndoGone>()).toMatchObject({ statusCode: 410, error: 'Request Error', reason: 'expired' })
      expect(g.json<UndoGone>().message).toMatch(/older than 7 days/)
    } finally {
      await app.close()
      vi.unstubAllEnvs()
    }
  })
})
