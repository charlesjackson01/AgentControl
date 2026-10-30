/**
 * BE-P2-9: SnapshotService (plan §7.1, §7.2, §11). Every run gets an undo snapshot of the bot's
 * writable zones (its workspace and the shared folder of each group it's in), taken by one of
 * three drivers, picked by the runtime probe for this host:
 *
 * - reflink: before the run, each zone is cloned (metadata-only copy) into
 *   `<snapshots>/<slug>/<runId>/files/<zone>/`. After the run, clones of files the run didn't
 *   modify or delete are dropped, so only the originals of changed files are retained.
 * - overlay: the zones are mounted in the bot's container as Podman overlay mounts
 *   (`-v <zone>:<target>:O,upperdir=…,workdir=…`, per bot and zone under
 *   `<snapshots>/<slug>/.overlay/<zone>/`) with the real folder as the lower layer. The run's
 *   writes land in the upper layer. After the run ends (succeeded, failed, timed out or stopped)
 *   the container is stopped and the upper layer is committed into the real folder: each
 *   replaced or deleted original is first moved into the snapshot (a same-filesystem rename,
 *   so no copy), whiteouts become deletes and opaque folders replace their lower folder.
 * - copy: a content-addressed per-bot blob store (`<snapshots>/<slug>/.blobs/<sha256>`) fed by
 *   the hash index: a file is copied only when its content isn't stored yet, so the first
 *   snapshot copies everything and later ones only what changed.
 *
 * For every run: a pre-run manifest (`manifest.json`), a post-run manifest (`post.json`, for
 * conflict checks at undo time) and `meta.json` (the changes and retained bytes). The bot's hash
 * index (`.index.json`) is updated from the post-run manifest. `.pending.json` marks a snapshot
 * whose run hasn't been finished; the next begin (or `recover`) finishes it, so a crashed run's
 * writes are still committed and undoable. Snapshots are per bot, with no sharing between bots.
 *
 * BE-P2-10: `evict` drops a run's retained originals (files/, manifest.json, post.json) and
 * records `undo: {state:'unavailable', reason, at}` in its meta.json, which stays as the run's
 * record; `gcBlobs` (copy) removes blobs no longer referenced by the index, a kept snapshot or
 * the pending run. The eviction policy (budgets, §7.4) is in snapshot-budget.ts.
 *
 * BE-P2-11: an undo is itself a snapshotted run (`begin` with the reversed run's zones and
 * `undoOf`): with reflink/copy the pre-run clone/blobs hold what undo replaces; with overlay
 * (where undo writes the real folders directly) `retain` copies each file into the snapshot
 * before it is replaced. `markUndone` records `undo: {state:'done', undoRunId}` on the reversed
 * run and drops its retained data (undoing the undo uses the undo run's own snapshot); `hold`
 * keeps eviction off a run while its undo is applied.
 *
 * Note (Team lead, BE-P2-9 review): the copy driver is close to the 2 s pre-run budget on a
 * 10k-file workspace — about 1.3 s standalone before the hash-while-copying fix and about 2.0 s
 * under the full parallel test suite (reflink: 0.78 s). Keep an eye on it before adding work to
 * copy's begin.
 */
import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  closeSync, constants, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync, writeSync, type Stats,
} from 'node:fs'
import path from 'node:path'
import type { Agent, FileChange, ScriptRunUndo, SnapshotDriver, UndoUnavailableReason } from './shared/types.js'
import type { BotMount } from './isolation.js'
import {
  createHashIndex, diffManifests, hashChanged, indexFrom, openNoFollow, stillInside, takeManifest, type ManifestChange, type ManifestEntry,
} from './snapshot-manifest.js'

/**
 * Copy a regular file without following symlinks (O_NOFOLLOW on the source, O_EXCL on the
 * destination), so a file swapped for a symlink mid-snapshot is never read through. Returns the
 * sha256 of the bytes copied.
 */
export function copyNoFollow(src: string, dst: string): string {
  const h = createHash('sha256')
  const inFd = openNoFollow(src)
  try {
    const outFd = openSync(dst, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
    try {
      const buf = Buffer.allocUnsafe(1024 * 1024)
      for (;;) {
        const n = readSync(inFd, buf, 0, buf.length, null)
        if (n <= 0) break
        h.update(buf.subarray(0, n))
        let off = 0
        while (off < n) off += writeSync(outFd, buf, off, n - off)
      }
    } finally {
      closeSync(outFd)
    }
  } finally {
    closeSync(inFd)
  }
  return h.digest('hex')
}

const SWAPPED = 'a file in the bot\'s folders was replaced by a link while the snapshot was taken'

/** One writable zone of a bot (a folder it can write in its container). */
export interface SnapshotZone {
  /** 'workspace' or 'group-<slug>'; a folder name in the snapshot. */
  key: string
  /** Host path of the real folder. */
  dir: string
  /** Mount target in the container. */
  target: string
  root: 'agent' | 'group'
  /** FileChange path prefix: 'workspace' (root agent) or 'shared' (root group). */
  prefix: string
  groupId?: string
  groupName?: string
}

export type ZoneInfo = Omit<SnapshotZone, 'dir' | 'target'>

export interface SnapshotDeps {
  /** `<filesRoot>/snapshots`; null when the bots' files have no host path (snapshots off). */
  root: () => string | null
  /** The driver the probe picked (null: not known yet / snapshots off). */
  driver: () => SnapshotDriver | null
  zones: (agent: Agent) => SnapshotZone[]
  /** reflink clone of one file (default: copyFile with COPYFILE_FICLONE_FORCE). */
  clone?: (src: string, dst: string) => void
  /** Folders (absolute) among `dirs` that are overlay-opaque (default: reads the xattrs with python3). */
  opaqueDirs?: (dirs: string[]) => Promise<Set<string>>
  now?: () => Date
  log?: (msg: string) => void
}

export interface SnapshotHandle {
  slug: string
  runId: string
  driver: SnapshotDriver
  dir: string
  zones: SnapshotZone[]
  startedAt: string
  pre: Record<string, ManifestEntry[]>
  /** BE-P2-11: this run is an undo of that run. */
  undoOf?: string
  /** overlay: what the commits touched, per zone. */
  touched: Record<string, { files: string[]; dirs: string[] }>
}

export interface SnapshotChange {
  zone: string
  path: string
  change: 'added' | 'modified' | 'deleted'
  kind: 'file' | 'symlink'
  beforeSize?: number
  afterSize?: number
  beforeSha?: string
  afterSha?: string
  afterMtimeMs?: number
  beforeTarget?: string
  /** BE-P2-11: permission bits of the original (restored with the bytes). */
  beforeMode?: number
  /** BE-P2-11: kind after the run, when it differs from `kind` (e.g. a file replaced by a link). */
  afterKind?: 'file' | 'symlink'
  /** BE-P2-11: a symlink's text after the run (conflict check). */
  afterTarget?: string
}

export interface SnapshotMeta {
  v: 1
  runId: string
  slug: string
  driver: SnapshotDriver
  startedAt: string
  endedAt: string
  /** Finished after a crash or restart (the run's own end wasn't seen). */
  recovered?: true
  zones: ZoneInfo[]
  changes: SnapshotChange[]
  retainedBytes: number
  /** BE-P2-10: absent while the snapshot is kept; set when it's evicted (or, BE-P2-11, undone). */
  undo?: ScriptRunUndo
  /** BE-P2-11: this run is an undo ("undo of <runId>"). */
  undoOf?: string
}

export interface SnapshotOutcome {
  snapshot: { id: string; driver: SnapshotDriver; retainedBytes: number }
  filesChanged: FileChange[]
  meta: SnapshotMeta
}

/** Where undo gets one file back from (BE-P2-11). */
export interface UndoSourceEntry {
  zone: string
  root: 'agent' | 'group'
  groupId?: string
  groupName?: string
  /** FileChange path (with the zone prefix). */
  path: string
  /** Path within the zone. */
  rel: string
  change: 'added' | 'modified' | 'deleted'
  /** modified/deleted: the original (host path of the retained file, or a symlink's target). */
  original?: { kind: 'file'; file: string; size: number; sha256?: string; mode?: number } | { kind: 'symlink'; target: string }
  /** Size before the run (modified/deleted). */
  beforeSize?: number
  /** BE-P2-11: what the run left (added/modified), for the conflict check. */
  after?: { kind: 'file' | 'symlink'; size?: number; mtimeMs?: number; target?: string }
  /** The hash after the run (conflict check: current hash ≠ this). */
  afterSha?: string
}

export interface SnapshotService {
  driver(): SnapshotDriver | null
  /** The bot's mounts with overlay upper/work dirs added to its writable zones (driver overlay). */
  mountsFor(agent: Agent, mounts: BotMount[]): BotMount[]
  /**
   * True when the container must be stopped around runs: driver overlay, or (given the bot) the
   * bot still has overlay layers left from before a switch to another driver.
   */
  needsStop(agent?: Agent): boolean
  /** Is a snapshot unfinished (crash) for the bot? */
  pending(agent: Agent): boolean
  /**
   * Pre-run: manifest, clone/blobs, pending marker. Null when snapshots are off. BE-P2-11: an
   * undo passes the reversed run's zones (`zones`, instead of the bot's writable zones now) and `undoOf`.
   */
  begin(agent: Agent, runId: string, opts?: { zones?: SnapshotZone[]; undoOf?: string }): Promise<SnapshotHandle | null>
  /** Post-run (every outcome): commit (overlay), post manifest, diff, retained originals. */
  finish(h: SnapshotHandle, opts?: { recovered?: boolean }): Promise<SnapshotOutcome>
  /**
   * BE-P2-11 (overlay): before undo replaces or removes `rel` in a zone directly, copy the file
   * into the undo run's snapshot and mark it touched. A no-op for reflink and copy (their
   * pre-run clone/blobs already hold it).
   */
  retain(h: SnapshotHandle, zone: string, rel: string): void
  /** BE-P2-11: record that `undoRunId` reversed the run, and drop its retained data. Null when there's no such snapshot. */
  markUndone(slug: string, runId: string, undoRunId: string): SnapshotMeta | null
  /** BE-P2-11: keep eviction (`evict`) off a run until the returned release is called. */
  hold(slug: string, runId: string): () => void
  /** Finish an unfinished snapshot (container must be stopped for overlay). */
  recover(agent: Agent): Promise<SnapshotOutcome | null>
  read(slug: string, runId: string): SnapshotMeta | null
  undoSource(slug: string, runId: string): UndoSourceEntry[] | null
  /** overlay dirs of one zone (created). */
  overlayDirs(slug: string, zone: string): { upper: string; work: string } | null
  /** BE-P2-10: bots with a snapshot folder. */
  slugs(): string[]
  /** BE-P2-10: the bot's finished snapshots (meta.json), kept or evicted; unordered. */
  list(slug: string): SnapshotMeta[]
  /** BE-P2-10: bytes a kept snapshot holds on disk: its retained originals plus its manifests. */
  sizeOf(meta: SnapshotMeta): number
  /**
   * BE-P2-10: drop a snapshot's retained data and record why in its meta.json (kept as the run's
   * record). Null when there's no such finished snapshot. Copy blobs go with `gcBlobs`.
   */
  evict(slug: string, runId: string, reason: UndoUnavailableReason, extra?: { changedBytes?: number }): SnapshotMeta | null
  /** BE-P2-10: remove an evicted run's record (its folder). False unless the run is evicted (undo unavailable). */
  prune(slug: string, runId: string): boolean
  /** BE-P2-10 (copy): remove blobs nothing references any more; returns the bytes freed. Not while the bot's run is snapshotting. */
  gcBlobs(slug: string): number
}

export const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/
const ZONE_KEY_RE = /^(workspace|group-[a-z0-9-]{1,40})$/
const SLUG_RE = /^[a-z0-9-]{1,40}$/
const PENDING = '.pending.json'
const INDEX = '.index.json'
const BLOBS = '.blobs'
const OVERLAY = '.overlay'
const WH_OPAQUE = '.wh..wh..opq'

export function newRunId(): string {
  return `r${Date.now().toString(36)}${randomBytes(4).toString('hex')}`
}

export function reflinkClone(src: string, dst: string): void {
  copyFileSync(src, dst, constants.COPYFILE_FICLONE_FORCE)
}

/** Whether `dir`'s filesystem can clone files (reflink). The test files are removed. */
export function canReflink(dir: string, clone: (src: string, dst: string) => void = reflinkClone): boolean {
  const t = path.join(dir, `.ac-reflink-probe-${randomBytes(4).toString('hex')}`)
  try {
    mkdirSync(t, { recursive: true })
    writeFileSync(path.join(t, 'a'), 'reflink\n')
    clone(path.join(t, 'a'), path.join(t, 'b'))
    return readFileSync(path.join(t, 'b'), 'utf8') === 'reflink\n'
  } catch {
    return false
  } finally {
    rmSync(t, { recursive: true, force: true })
  }
}

const OPAQUE_PY = [
  'import json,os,sys',
  'out=[]',
  'for d in json.load(sys.stdin):',
  '  for k in ("user.overlay.opaque","trusted.overlay.opaque"):',
  '    try:',
  '      if os.getxattr(d,k,follow_symlinks=False)==b"y":',
  '        out.append(d);break',
  '    except OSError:',
  '      pass',
  'print(json.dumps(out))',
].join('\n')

/** Overlay-opaque folders, read from the user./trusted.overlay.opaque xattrs (python3; Node has no xattr API). */
export function readOpaqueDirs(dirs: string[]): Promise<Set<string>> {
  if (!dirs.length) return Promise.resolve(new Set())
  return new Promise((resolve, reject) => {
    const p = spawn('python3', ['-c', OPAQUE_PY], { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    p.stdout.on('data', (c: Buffer) => (out += c.toString()))
    p.stderr.on('data', (c: Buffer) => (err += c.toString()))
    p.on('error', (e) => reject(new Error(`can't read overlay folder flags: ${e.message}`)))
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`can't read overlay folder flags: ${err.trim().split('\n').pop() ?? code}`))
      try {
        resolve(new Set(JSON.parse(out) as string[]))
      } catch (e) {
        reject(new Error(`can't read overlay folder flags: ${(e as Error).message}`))
      }
    })
    p.stdin.end(JSON.stringify(dirs))
  })
}

const lst = (p: string): Stats | null => {
  try {
    return lstatSync(p)
  } catch {
    return null
  }
}

function writeJson(file: string, v: unknown): void {
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, JSON.stringify(v), { mode: 0o600 })
  renameSync(tmp, file)
}
function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}

/** rename, or copy + remove across filesystems. */
function moveAny(src: string, dst: string): void {
  try {
    renameSync(src, dst)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
    cpSync(src, dst, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true })
    rmSync(src, { recursive: true, force: true })
  }
}

/** Remove empty folders under `dir` (bottom-up), keeping `dir` itself. */
function removeEmptyDirs(dir: string): boolean {
  let empty = true
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return false
  }
  for (const n of names) {
    const p = path.join(dir, n)
    const s = lst(p)
    if (s?.isDirectory()) {
      if (removeEmptyDirs(p)) rmdirSync(p)
      else empty = false
    } else empty = false
  }
  return empty
}

export interface OverlayCommit {
  files: Set<string>
  dirs: Set<string>
}

/**
 * Commit an overlay upper layer into its lower (real) folder. Originals that get replaced or
 * deleted are moved to `orig` first (keeping the earliest one when a path is committed twice).
 * The upper layer is left empty (the work dir is left alone). Returns the touched paths.
 */
export async function commitOverlay(upper: string, lower: string, orig: string, opaqueDirs: (dirs: string[]) => Promise<Set<string>> = readOpaqueDirs): Promise<OverlayCommit> {
  const touched: OverlayCommit = { files: new Set(), dirs: new Set() }
  if (!lst(upper)?.isDirectory()) return touched
  // Collect the upper folders first: one batch for the opaque flags.
  const dirs: string[] = []
  const stack = ['']
  while (stack.length) {
    const rel = stack.pop()!
    for (const n of readdirSync(path.join(upper, rel))) {
      const r = rel ? `${rel}/${n}` : n
      if (lst(path.join(upper, r))?.isDirectory()) {
        dirs.push(r)
        stack.push(r)
      }
    }
  }
  const opaque = await opaqueDirs(dirs.map((d) => path.join(upper, d)))
  const isOpaque = (r: string) => opaque.has(path.join(upper, r)) || existsSync(path.join(upper, r, WH_OPAQUE))

  const moveToOrig = (r: string) => {
    const l = path.join(lower, r)
    const dst = path.join(orig, r)
    if (lst(dst)) {
      rmSync(l, { recursive: true, force: true })
      return
    }
    mkdirSync(path.dirname(dst), { recursive: true })
    moveAny(l, dst)
  }
  const markGone = (r: string, s: Stats) => {
    if (s.isDirectory()) touched.dirs.add(r)
    else touched.files.add(r)
  }

  const walk = (rel: string) => {
    const names = readdirSync(rel ? path.join(upper, rel) : upper)
    for (const n of names) {
      if (n === WH_OPAQUE) {
        unlinkSync(path.join(upper, rel, n))
        continue
      }
      const fuseWh = n.startsWith('.wh.') ? n.slice(4) : null
      const name = fuseWh ?? n
      const r = rel ? `${rel}/${name}` : name
      const u = path.join(upper, rel, n)
      const l = path.join(lower, r)
      const st = lstatSync(u)
      const lowerSt = lst(l)
      if (fuseWh !== null || (st.isCharacterDevice() && st.rdev === 0)) {
        // Whiteout: the run deleted r.
        if (lowerSt) {
          moveToOrig(r)
          markGone(r, lowerSt)
        }
        unlinkSync(u)
        continue
      }
      if (st.isDirectory()) {
        if (lowerSt && (!lowerSt.isDirectory() || isOpaque(r))) {
          moveToOrig(r)
          markGone(r, lowerSt)
        }
        if (!lst(l)) {
          mkdirSync(l, { mode: st.mode & 0o7777 })
          touched.dirs.add(r)
        }
        walk(r)
        try {
          rmdirSync(u)
        } catch {
          rmSync(u, { recursive: true, force: true })
        }
        continue
      }
      if (st.isFile() || st.isSymbolicLink()) {
        if (lowerSt) {
          moveToOrig(r)
          if (lowerSt.isDirectory()) touched.dirs.add(r)
        }
        moveAny(u, l)
        touched.files.add(r)
        continue
      }
      // Sockets, fifos, devices: never committed.
      unlinkSync(u)
    }
  }
  walk('')
  return touched
}

export function createSnapshotService(deps: SnapshotDeps): SnapshotService {
  const now = deps.now ?? (() => new Date())
  const log = deps.log ?? (() => {})
  const clone = deps.clone ?? reflinkClone
  const opaqueDirs = deps.opaqueDirs ?? readOpaqueDirs

  const slugDir = (slug: string): string | null => {
    const root = deps.root()
    if (!root || !SLUG_RE.test(slug)) return null
    return path.join(root, slug)
  }
  const zoneInfo = (z: SnapshotZone): ZoneInfo => ({
    key: z.key, root: z.root, prefix: z.prefix, ...(z.groupId ? { groupId: z.groupId } : {}), ...(z.groupName ? { groupName: z.groupName } : {}),
  })
  const checkZones = (zones: SnapshotZone[]): SnapshotZone[] => {
    const seen = new Set<string>()
    for (const z of zones) {
      if (!ZONE_KEY_RE.test(z.key) || seen.has(z.key)) throw new Error(`bad snapshot zone ${JSON.stringify(z.key)}`)
      seen.add(z.key)
    }
    return zones
  }

  function overlayDirs(slug: string, zone: string): { upper: string; work: string } | null {
    const d = slugDir(slug)
    if (!d || !ZONE_KEY_RE.test(zone)) return null
    const base = path.join(d, OVERLAY, zone)
    const upper = path.join(base, 'upper')
    const work = path.join(base, 'work')
    mkdirSync(upper, { recursive: true })
    mkdirSync(work, { recursive: true })
    return { upper, work }
  }

  function loadIndex(d: string) {
    return createHashIndex(readJson(path.join(d, INDEX)))
  }

  /** reflink: clone a zone's files and symlinks (folders recreated). */
  function cloneZone(dir: string, entries: readonly ManifestEntry[], dst: string): void {
    mkdirSync(dst, { recursive: true })
    for (const e of entries) {
      const to = path.join(dst, e.path)
      if (e.kind === 'dir') mkdirSync(to, { recursive: true })
      else if (e.kind === 'symlink') {
        mkdirSync(path.dirname(to), { recursive: true })
        symlinkSync(e.target!, to)
      } else {
        mkdirSync(path.dirname(to), { recursive: true })
        const src = path.join(dir, e.path)
        const before = lst(src)
        if (!before?.isFile()) continue // vanished or no longer a file since the walk
        try {
          clone(src, to)
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue // vanished since the walk
          throw err
        }
        // The clone follows symlinks: make sure it read the same regular file inside the zone.
        const after = lst(src)
        if (!after?.isFile() || after.ino !== before.ino || after.dev !== before.dev || !stillInside(dir, src)) {
          rmSync(to, { force: true })
          throw new Error(SWAPPED)
        }
      }
    }
  }

  /** copy: make sure every file's content is in the blob store (copied only when missing). */
  function storeBlobs(dir: string, entries: ManifestEntry[], blobs: string): void {
    mkdirSync(blobs, { recursive: true })
    for (const e of entries) {
      if (e.kind !== 'file') continue
      if (e.sha256 && existsSync(path.join(blobs, e.sha256))) continue
      const tmp = path.join(blobs, `.tmp-${randomBytes(6).toString('hex')}`)
      const src = path.join(dir, e.path)
      let sha: string
      try {
        sha = copyNoFollow(src, tmp) // hashed while copying: the blob's name matches its content
      } catch (err) {
        rmSync(tmp, { force: true })
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'ENOENT') continue // vanished since the walk
        if (code === 'ELOOP' || code === 'ENOTREG') throw new Error(SWAPPED)
        throw err
      }
      if (!stillInside(dir, src)) {
        rmSync(tmp, { force: true })
        throw new Error(SWAPPED)
      }
      if (existsSync(path.join(blobs, sha))) unlinkSync(tmp)
      else renameSync(tmp, path.join(blobs, sha))
      e.sha256 = sha
    }
  }

  /** Keep only the originals listed in `keep` under a zone's files folder. */
  function pruneOriginals(dir: string, keep: ReadonlySet<string>): void {
    if (!lst(dir)?.isDirectory()) return
    for (const e of takeManifest(dir, { zone: '', hash: 'none' })) {
      if (e.kind === 'dir') continue
      if (!keep.has(e.path)) rmSync(path.join(dir, e.path), { force: true })
    }
    removeEmptyDirs(dir)
  }

  function pendingFile(slug: string): string | null {
    const d = slugDir(slug)
    return d ? path.join(d, PENDING) : null
  }

  async function begin(agent: Agent, runId: string, opts: { zones?: SnapshotZone[]; undoOf?: string } = {}): Promise<SnapshotHandle | null> {
    const driver = deps.driver()
    const d = slugDir(agent.slug)
    if (!driver || !d) return null
    if (!RUN_ID_RE.test(runId)) throw new Error(`bad run id ${JSON.stringify(runId.slice(0, 40))}`)
    mkdirSync(d, { recursive: true })
    await recover(agent)
    const dir = path.join(d, runId)
    if (existsSync(dir)) throw new Error(`a snapshot for run ${runId} already exists`)
    const zones = checkZones(opts.zones ?? deps.zones(agent))
    const index = loadIndex(d)
    const pre: Record<string, ManifestEntry[]> = {}
    // copy hashes new/changed files while storing their blobs, so the walk only reuses the index.
    for (const z of zones) pre[z.key] = takeManifest(z.dir, { zone: z.key, index, hash: driver === 'copy' ? 'none' : 'changed' })
    mkdirSync(dir, { recursive: true })
    if (driver === 'reflink') for (const z of zones) cloneZone(z.dir, pre[z.key]!, path.join(dir, 'files', z.key))
    if (driver === 'copy') for (const z of zones) storeBlobs(z.dir, pre[z.key]!, path.join(d, BLOBS))
    if (driver !== 'overlay') await commitLeftoverOverlay(d, zones, dir)
    const startedAt = now().toISOString()
    const undoOf = opts.undoOf !== undefined && RUN_ID_RE.test(opts.undoOf) ? opts.undoOf : undefined
    const h: SnapshotHandle = { slug: agent.slug, runId, driver, dir, zones, startedAt, pre, touched: {}, ...(undoOf ? { undoOf } : {}) }
    writeJson(path.join(dir, 'manifest.json'), { v: 1, runId, driver, startedAt, zones: zones.map((z) => ({ ...zoneInfo(z), dir: z.dir, target: z.target })), pre, ...(undoOf ? { undoOf } : {}) })
    writeJson(path.join(d, PENDING), { runId })
    if (driver === 'overlay') {
      // Writes made while no run was active (e.g. an exec at idle) are committed now, as part of this run.
      await commitAll(h)
      writeJson(path.join(dir, 'touched.json'), h.touched)
    }
    return h
  }

  /**
   * After a switch away from overlay: writes still sitting in old upper layers are committed into
   * the real folders now, after the pre-run manifest, so they show up as this run's changes (the
   * originals are already in this run's clone/blobs). The layers are then removed.
   */
  async function commitLeftoverOverlay(d: string, zones: SnapshotZone[], runDir: string): Promise<void> {
    const ov = path.join(d, OVERLAY)
    if (!lst(ov)?.isDirectory()) return
    const scratch = path.join(runDir, '.leftover')
    for (const z of zones) {
      const upper = path.join(ov, z.key, 'upper')
      if (!lst(upper)?.isDirectory()) continue
      await commitOverlay(upper, z.dir, path.join(scratch, z.key), opaqueDirs)
    }
    rmSync(scratch, { recursive: true, force: true })
    rmSync(ov, { recursive: true, force: true })
    log(`snapshots: committed overlay layers left from an earlier driver (${path.basename(d)})`)
  }

  async function commitAll(h: SnapshotHandle): Promise<void> {
    for (const z of h.zones) {
      const o = overlayDirs(h.slug, z.key)
      if (!o) continue
      const t = await commitOverlay(o.upper, z.dir, path.join(h.dir, 'files', z.key), opaqueDirs)
      const prev = h.touched[z.key] ?? { files: [], dirs: [] }
      h.touched[z.key] = { files: [...new Set([...prev.files, ...t.files])], dirs: [...new Set([...prev.dirs, ...t.dirs])] }
    }
  }

  async function finish(h: SnapshotHandle, opts: { recovered?: boolean } = {}): Promise<SnapshotOutcome> {
    const d = path.dirname(h.dir)
    if (h.driver === 'overlay') await commitAll(h)
    const post: Record<string, ManifestEntry[]> = {}
    const changes: SnapshotChange[] = []
    const filesChanged: FileChange[] = []
    let retainedBytes = 0
    for (const z of h.zones) {
      const pre = h.pre[z.key] ?? []
      const p = takeManifest(z.dir, { zone: z.key, hash: 'none' })
      hashChanged(z.dir, pre, p)
      post[z.key] = p
      const t = h.touched[z.key]
      const only = h.driver === 'overlay' ? { files: new Set(t?.files ?? []), dirs: new Set(t?.dirs ?? []) } : undefined
      const diff: ManifestChange[] = diffManifests(pre, p, only)
      const keep = new Set<string>()
      for (const c of diff) {
        const kind = (c.before ?? c.after)!.kind === 'symlink' ? 'symlink' : 'file'
        const afterKind = c.after ? (c.after.kind === 'symlink' ? 'symlink' : 'file') : undefined
        changes.push({
          zone: z.key, path: c.path, change: c.change, kind,
          ...(c.before ? { beforeSize: c.before.size, beforeMode: c.before.mode, ...(c.before.sha256 ? { beforeSha: c.before.sha256 } : {}), ...(c.before.target !== undefined ? { beforeTarget: c.before.target } : {}) } : {}),
          ...(c.after ? { afterSize: c.after.size, afterMtimeMs: c.after.mtimeMs, ...(c.after.sha256 ? { afterSha: c.after.sha256 } : {}), ...(c.after.target !== undefined ? { afterTarget: c.after.target } : {}) } : {}),
          ...(afterKind && afterKind !== kind ? { afterKind } : {}),
        })
        if (c.before) {
          keep.add(c.path)
          if (c.before.kind === 'file') retainedBytes += c.before.size
        }
        filesChanged.push({
          path: `${z.prefix}/${c.path}`,
          change: c.change,
          ...(c.after?.kind === 'file' ? { bytes: c.after.size, modifiedAt: new Date(c.after.mtimeMs).toISOString() } : {}),
          root: z.root,
          ...(z.root === 'group' ? { ...(z.groupId ? { groupId: z.groupId } : {}), ...(z.groupName ? { groupName: z.groupName } : {}) } : {}),
        })
      }
      if (h.driver !== 'copy') pruneOriginals(path.join(h.dir, 'files', z.key), keep)
    }
    const meta: SnapshotMeta = {
      v: 1, runId: h.runId, slug: h.slug, driver: h.driver, startedAt: h.startedAt, endedAt: now().toISOString(),
      ...(opts.recovered ? { recovered: true as const } : {}),
      zones: h.zones.map(zoneInfo), changes, retainedBytes, ...(h.undoOf ? { undoOf: h.undoOf } : {}),
    }
    writeJson(path.join(h.dir, 'post.json'), post)
    writeJson(path.join(h.dir, 'meta.json'), meta)
    writeJson(path.join(d, INDEX), indexFrom(post))
    rmSync(path.join(h.dir, 'touched.json'), { force: true })
    const pend = readJson<{ runId?: string }>(path.join(d, PENDING))
    if (pend?.runId === h.runId) rmSync(path.join(d, PENDING), { force: true })
    return { snapshot: { id: h.runId, driver: h.driver, retainedBytes }, filesChanged, meta }
  }

  async function recover(agent: Agent): Promise<SnapshotOutcome | null> {
    const file = pendingFile(agent.slug)
    if (!file) return null
    const pend = readJson<{ runId?: string }>(file)
    if (!pend) return null
    const runId = pend.runId
    const d = path.dirname(file)
    const m = typeof runId === 'string' && RUN_ID_RE.test(runId)
      ? readJson<{ driver: SnapshotDriver; startedAt: string; zones: (ZoneInfo & { dir: string; target: string })[]; pre: Record<string, ManifestEntry[]>; undoOf?: string }>(path.join(d, runId, 'manifest.json'))
      : null
    if (!m || !runId) {
      log(`snapshots: ${agent.slug}: dropping an unreadable pending marker`)
      rmSync(file, { force: true })
      return null
    }
    const touched = readJson<SnapshotHandle['touched']>(path.join(d, runId, 'touched.json')) ?? {}
    log(`snapshots: ${agent.slug}: finishing the snapshot of run ${runId} (its end wasn't recorded)`)
    const undoOf = typeof m.undoOf === 'string' && RUN_ID_RE.test(m.undoOf) ? m.undoOf : undefined
    return finish({ slug: agent.slug, runId, driver: m.driver, dir: path.join(d, runId), zones: m.zones, startedAt: m.startedAt, pre: m.pre, touched, ...(undoOf ? { undoOf } : {}) }, { recovered: true })
  }

  function read(slug: string, runId: string): SnapshotMeta | null {
    const d = slugDir(slug)
    if (!d || !RUN_ID_RE.test(runId)) return null
    return readJson<SnapshotMeta>(path.join(d, runId, 'meta.json'))
  }

  /** BE-P2-11: `${slug}/${runId}` of runs whose undo is being applied (never evicted meanwhile). */
  const held = new Map<string, number>()

  function retain(h: SnapshotHandle, zone: string, rel: string): void {
    if (h.driver !== 'overlay') return
    const z = h.zones.find((x) => x.key === zone)
    if (!z) throw new Error(`zone ${zone} is not part of run ${h.runId}`)
    const parts = rel.split('/')
    if (!rel || parts.some((p) => !p || p === '.' || p === '..')) throw new Error(`bad path ${JSON.stringify(rel.slice(0, 80))}`)
    const src = path.join(z.dir, ...parts)
    const st = lst(src)
    const t = h.touched[zone] ?? { files: [], dirs: [] }
    if (!t.files.includes(rel)) t.files.push(rel)
    h.touched[zone] = t
    if (st?.isFile()) {
      if (!stillInside(z.dir, src)) throw new Error('retain: a folder on the way is a link')
      const dst = path.join(h.dir, 'files', zone, ...parts)
      if (!lst(dst)) {
        mkdirSync(path.dirname(dst), { recursive: true })
        copyNoFollow(src, dst)
      }
    }
    writeJson(path.join(h.dir, 'touched.json'), h.touched)
  }

  const svc: SnapshotService = {
    driver: () => (deps.root() ? deps.driver() : null),
    needsStop(agent) {
      if (deps.root() === null) return false
      if (deps.driver() === 'overlay') return true
      const d = agent ? slugDir(agent.slug) : null
      return d !== null && lst(path.join(d, OVERLAY))?.isDirectory() === true
    },
    mountsFor(agent, mounts) {
      if (deps.driver() !== 'overlay' || !deps.root()) return mounts
      const zones = new Map(checkZones(deps.zones(agent)).map((z) => [z.target, z]))
      return mounts.map((m) => {
        const z = zones.get(m.target)
        if (m.readonly || !z) return m
        const o = overlayDirs(agent.slug, z.key)
        return o ? { ...m, overlay: o } : m
      })
    },
    pending: (agent) => {
      const f = pendingFile(agent.slug)
      return f !== null && existsSync(f)
    },
    begin,
    finish,
    recover,
    read,
    retain,
    markUndone(slug, runId, undoRunId) {
      const d = slugDir(slug)
      if (!d || !RUN_ID_RE.test(runId) || !RUN_ID_RE.test(undoRunId)) return null
      const dir = path.join(d, runId)
      const meta = readJson<SnapshotMeta>(path.join(dir, 'meta.json'))
      if (!meta || meta.runId !== runId) return null
      const next: SnapshotMeta = { ...meta, undo: { state: 'done', at: now().toISOString(), undoRunId } }
      writeJson(path.join(dir, 'meta.json'), next)
      // Its originals are no longer needed: the undo run's own snapshot reverses the undo.
      for (const f of ['files', 'manifest.json', 'post.json', 'touched.json']) rmSync(path.join(dir, f), { recursive: true, force: true })
      log(`snapshots: ${slug}: run ${runId} undone by ${undoRunId}`)
      return next
    },
    hold(slug, runId) {
      const k = `${slug}/${runId}`
      held.set(k, (held.get(k) ?? 0) + 1)
      let done = false
      return () => {
        if (done) return
        done = true
        const n = (held.get(k) ?? 1) - 1
        if (n <= 0) held.delete(k)
        else held.set(k, n)
      }
    },
    undoSource(slug, runId) {
      const meta = read(slug, runId)
      const d = slugDir(slug)
      if (!meta || !d || meta.undo?.state === 'unavailable' || meta.undo?.state === 'done') return null
      const zones = new Map(meta.zones.filter((z) => ZONE_KEY_RE.test(z.key)).map((z) => [z.key, z]))
      // BE-P2-11: a record naming an unknown zone or an odd path is refused as a whole (crafted).
      const badPath = (p: string) => !p || p.split('/').some((x) => !x || x === '.' || x === '..' || x.includes('\\') || x.includes('\0'))
      if (meta.changes.some((c) => !zones.has(c.zone) || typeof c.path !== 'string' || badPath(c.path))) {
        log(`snapshots: ${slug}: the record of run ${runId} names a zone or path that isn't valid`)
        throw Object.assign(new Error('This run\'s undo record has a path that isn\'t valid, so it can\'t be undone.'), { statusCode: 400 })
      }
      return meta.changes.map((c) => {
        const z = zones.get(c.zone)!
        let original: UndoSourceEntry['original']
        if (c.change !== 'added') {
          if (c.kind === 'symlink') original = { kind: 'symlink', target: c.beforeTarget ?? '' }
          else {
            const sha = c.beforeSha && /^[0-9a-f]{64}$/.test(c.beforeSha) ? c.beforeSha : ''
            const file = meta.driver === 'copy' ? (sha ? path.join(d, BLOBS, sha) : '') : path.join(d, runId, 'files', c.zone, c.path)
            if (file && lst(file)?.isFile()) original = { kind: 'file', file, size: c.beforeSize ?? 0, ...(c.beforeSha ? { sha256: c.beforeSha } : {}), ...(c.beforeMode !== undefined ? { mode: c.beforeMode } : {}) }
          }
        }
        const afterKind = c.afterKind ?? c.kind
        const after: UndoSourceEntry['after'] = c.change === 'deleted' ? undefined : {
          kind: afterKind,
          ...(c.afterSize !== undefined ? { size: c.afterSize } : {}),
          ...(c.afterMtimeMs !== undefined ? { mtimeMs: c.afterMtimeMs } : {}),
          ...(c.afterTarget !== undefined ? { target: c.afterTarget } : {}),
        }
        return {
          zone: c.zone, root: z.root, ...(z.groupId ? { groupId: z.groupId } : {}), ...(z.groupName ? { groupName: z.groupName } : {}),
          path: `${z.prefix}/${c.path}`, rel: c.path, change: c.change,
          ...(original ? { original } : {}), ...(c.beforeSize !== undefined ? { beforeSize: c.beforeSize } : {}),
          ...(after ? { after } : {}), ...(c.afterSha ? { afterSha: c.afterSha } : {}),
        }
      })
    },
    overlayDirs,
    slugs() {
      const root = deps.root()
      if (!root) return []
      try {
        return readdirSync(root).filter((n) => SLUG_RE.test(n) && lst(path.join(root, n))?.isDirectory())
      } catch {
        return []
      }
    },
    list(slug) {
      const d = slugDir(slug)
      if (!d) return []
      let names: string[]
      try {
        names = readdirSync(d)
      } catch {
        return []
      }
      const out: SnapshotMeta[] = []
      for (const n of names) {
        if (!RUN_ID_RE.test(n)) continue
        const m = readJson<SnapshotMeta>(path.join(d, n, 'meta.json'))
        if (m && m.runId === n && typeof m.endedAt === 'string') out.push(m)
      }
      return out
    },
    sizeOf(meta) {
      const d = slugDir(meta.slug)
      if (!d || meta.undo?.state === 'unavailable' || meta.undo?.state === 'done') return 0
      const dir = path.join(d, meta.runId)
      let bytes = meta.retainedBytes
      for (const f of ['manifest.json', 'post.json', 'meta.json']) bytes += lst(path.join(dir, f))?.size ?? 0
      return bytes
    },
    evict(slug, runId, reason, extra = {}) {
      const d = slugDir(slug)
      if (!d || !RUN_ID_RE.test(runId)) return null
      const dir = path.join(d, runId)
      const meta = readJson<SnapshotMeta>(path.join(dir, 'meta.json'))
      if (!meta) return null
      if (meta.undo?.state === 'unavailable' || meta.undo?.state === 'done') return meta
      if (held.has(`${slug}/${runId}`)) {
        log(`snapshots: ${slug}: not evicting run ${runId} now (its undo is being applied)`)
        return null
      }
      const undo: ScriptRunUndo = {
        state: 'unavailable', reason, at: now().toISOString(),
        ...(extra.changedBytes !== undefined ? { changedBytes: extra.changedBytes } : {}),
      }
      const next: SnapshotMeta = { ...meta, undo }
      // The record first, so a crash in between leaves it unavailable rather than half there.
      writeJson(path.join(dir, 'meta.json'), next)
      for (const f of ['files', 'manifest.json', 'post.json', 'touched.json']) rmSync(path.join(dir, f), { recursive: true, force: true })
      log(`snapshots: ${slug}: evicted run ${runId} (${reason})`)
      return next
    },
    prune(slug, runId) {
      const d = slugDir(slug)
      if (!d || !RUN_ID_RE.test(runId)) return false
      const dir = path.join(d, runId)
      const meta = readJson<SnapshotMeta>(path.join(dir, 'meta.json'))
      if (meta?.runId !== runId || meta.undo?.state !== 'unavailable') return false
      rmSync(dir, { recursive: true, force: true })
      log(`snapshots: ${slug}: pruned the record of run ${runId}`)
      return true
    },
    gcBlobs(slug) {
      const d = slugDir(slug)
      if (!d) return 0
      const blobs = path.join(d, BLOBS)
      let names: string[]
      try {
        names = readdirSync(blobs)
      } catch {
        return 0
      }
      const keep = new Set<string>()
      // The current index (unchanged files reuse these at the next begin) …
      for (const e of loadIndex(d).entries.values()) keep.add(e.sha256)
      // … the originals kept snapshots need …
      for (const m of svc.list(slug)) {
        if (m.undo?.state === 'unavailable' || m.undo?.state === 'done') continue
        for (const c of m.changes) if (c.beforeSha) keep.add(c.beforeSha)
      }
      // … and everything the pending run's pre-run manifest refers to.
      const pend = readJson<{ runId?: string }>(path.join(d, PENDING))
      if (pend?.runId && RUN_ID_RE.test(pend.runId)) {
        const m = readJson<{ pre?: Record<string, ManifestEntry[]> }>(path.join(d, pend.runId, 'manifest.json'))
        for (const list of Object.values(m?.pre ?? {})) for (const e of list) if (e.sha256) keep.add(e.sha256)
      }
      let freed = 0
      for (const n of names) {
        if (!/^[0-9a-f]{64}$/.test(n) || keep.has(n)) continue
        const f = path.join(blobs, n)
        freed += lst(f)?.size ?? 0
        rmSync(f, { force: true })
      }
      return freed
    },
  }
  return svc
}
