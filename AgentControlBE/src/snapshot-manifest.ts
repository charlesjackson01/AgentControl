/**
 * BE-P2-9: manifests and the diff for run snapshots (plan §7.1, §7.2).
 *
 * A manifest lists one writable zone (a folder): every regular file, symlink and folder with
 * `{path, size, mtimeMs, mode, sha256?}`. Symlinks are recorded (their target), never followed.
 * Special files (sockets, fifos, devices) are ignored. Paths are POSIX, relative to the zone.
 *
 * Hashes come from the bot's hash index when a file's size and mtime match it, else the file is
 * hashed (so only files changed since the last run are read). The diff compares a pre- and a
 * post-run manifest: added / modified / deleted (a rename is a delete plus an add).
 */
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readlinkSync, readSync, realpathSync, type Stats } from 'node:fs'
import path from 'node:path'

export type ManifestKind = 'file' | 'symlink' | 'dir'

export interface ManifestEntry {
  /** POSIX path relative to the zone. */
  path: string
  kind: ManifestKind
  /** Bytes (files), the target length (symlinks), 0 (folders). */
  size: number
  mtimeMs: number
  /** Permission bits (mode & 0o7777). */
  mode: number
  /** Files only, when known. */
  sha256?: string
  /** Symlinks only: the link text (never followed). */
  target?: string
}

/** zone key → path → index entry. */
export interface HashIndex {
  get(zone: string, p: string): { size: number; mtimeMs: number; sha256: string } | undefined
}

export interface MapHashIndex extends HashIndex {
  entries: Map<string, { size: number; mtimeMs: number; sha256: string }>
}

const key = (zone: string, p: string) => `${zone}\0${p}`

export function createHashIndex(raw?: unknown): MapHashIndex {
  const entries = new Map<string, { size: number; mtimeMs: number; sha256: string }>()
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { entries?: unknown }).entries : undefined
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (Array.isArray(v) && typeof v[0] === 'number' && typeof v[1] === 'number' && typeof v[2] === 'string' && /^[0-9a-f]{64}$/.test(v[2])) {
        entries.set(k, { size: v[0], mtimeMs: v[1], sha256: v[2] })
      }
    }
  }
  return {
    entries,
    get: (zone, p) => entries.get(key(zone, p)),
  }
}

/** The index after a run: every file of the post-run manifests that has a hash. */
export function indexFrom(manifests: Record<string, readonly ManifestEntry[]>): { v: 1; entries: Record<string, [number, number, string]> } {
  const entries: Record<string, [number, number, string]> = {}
  for (const [zone, list] of Object.entries(manifests)) {
    for (const e of list) if (e.kind === 'file' && e.sha256) entries[key(zone, e.path)] = [e.size, e.mtimeMs, e.sha256]
  }
  return { v: 1, entries }
}

const CHUNK = 1024 * 1024
let chunkBuf: Buffer | null = null

/** Open a regular file for reading without following a symlink at its last component (O_NOFOLLOW). */
export function openNoFollow(file: string): number {
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  if (!fstatSync(fd).isFile()) {
    closeSync(fd)
    throw Object.assign(new Error(`not a regular file: ${file}`), { code: 'ENOTREG' })
  }
  return fd
}

/**
 * True when `file`'s folder still resolves inside `zoneDir` (no folder on the way was swapped
 * for a symlink, e.g. by a process the bot left running). Used after reading a file.
 */
const zoneReal = new Map<string, string>()
export function stillInside(zoneDir: string, file: string): boolean {
  try {
    // The zone folder itself is a host path the bot can't replace; its realpath is cached.
    let root = zoneReal.get(zoneDir)
    if (root === undefined) {
      root = realpathSync(zoneDir)
      if (zoneReal.size > 256) zoneReal.clear()
      zoneReal.set(zoneDir, root)
    }
    const parent = realpathSync(path.dirname(file))
    return parent === root || parent.startsWith(root.endsWith(path.sep) ? root : root + path.sep)
  } catch {
    return false
  }
}

/** sha256 of a regular file (opened with O_NOFOLLOW, read in 1 MB chunks). */
export function sha256File(file: string): string {
  const h = createHash('sha256')
  const fd = openNoFollow(file)
  try {
    chunkBuf ??= Buffer.allocUnsafe(CHUNK)
    for (;;) {
      const n = readSync(fd, chunkBuf, 0, CHUNK, null)
      if (n <= 0) break
      h.update(n === CHUNK ? chunkBuf : chunkBuf.subarray(0, n))
    }
  } finally {
    closeSync(fd)
  }
  return h.digest('hex')
}

function entryOf(rel: string, st: Stats, full: string): ManifestEntry | null {
  const base = { path: rel, mtimeMs: Math.floor(st.mtimeMs), mode: st.mode & 0o7777 }
  if (st.isFile()) return { ...base, kind: 'file', size: st.size }
  if (st.isDirectory()) return { ...base, kind: 'dir', size: 0 }
  if (st.isSymbolicLink()) {
    const target = readlinkSync(full)
    return { ...base, kind: 'symlink', size: Buffer.byteLength(target), target }
  }
  return null
}

/**
 * Walk a zone. `hash`: 'changed' hashes files whose size/mtime don't match the index; 'none'
 * only takes hashes from the index. A missing zone folder is an empty manifest.
 */
export function takeManifest(dir: string, opts: { zone: string; index?: HashIndex; hash?: 'changed' | 'none'; skip?: (rel: string) => boolean } = { zone: '' }): ManifestEntry[] {
  const out: ManifestEntry[] = []
  const stack: string[] = ['']
  try {
    if (!lstatSync(dir).isDirectory()) return out
  } catch {
    return out
  }
  while (stack.length) {
    const rel = stack.pop()!
    let names: string[]
    try {
      names = readdirSync(rel ? path.join(dir, rel) : dir)
    } catch (err) {
      // A folder that vanished or can't be read mid-walk: record what we can.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw err
    }
    for (const name of names) {
      const r = rel ? `${rel}/${name}` : name
      if (opts.skip?.(r)) continue
      const full = path.join(dir, r)
      let st: Stats
      try {
        st = lstatSync(full)
      } catch {
        continue
      }
      const e = entryOf(r, st, full)
      if (!e) continue
      if (e.kind === 'dir') stack.push(r)
      else if (e.kind === 'file') {
        const known = opts.index?.get(opts.zone, r)
        if (known && known.size === e.size && known.mtimeMs === e.mtimeMs) e.sha256 = known.sha256
        else if (opts.hash !== 'none') {
          try {
            const sha = sha256File(full)
            if (stillInside(dir, full)) e.sha256 = sha
          } catch {
            // Unreadable, vanished or no longer a regular file: keep it without a hash.
          }
        }
      }
      out.push(e)
    }
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

export interface ManifestChange {
  path: string
  change: 'added' | 'modified' | 'deleted'
  before?: ManifestEntry
  after?: ManifestEntry
}

/** Whether a file/symlink entry differs (folders aren't compared). */
export function entryChanged(a: ManifestEntry, b: ManifestEntry): boolean {
  if (a.kind !== b.kind) return true
  if (a.kind === 'symlink') return a.target !== b.target
  if (a.size !== b.size || a.mode !== b.mode) return true
  if (a.mtimeMs === b.mtimeMs) return false
  // Same size and mode, new mtime: unchanged only when both hashes are known and equal.
  return !(a.sha256 && b.sha256 && a.sha256 === b.sha256)
}

/**
 * Files and symlinks added / modified / deleted between two manifests (folders aren't reported;
 * a folder replaced by a file shows the folder's files deleted and the file added).
 * `only`: restrict to these paths (and, for `dirs`, everything under them).
 */
export function diffManifests(pre: readonly ManifestEntry[], post: readonly ManifestEntry[], only?: { files: ReadonlySet<string>; dirs: ReadonlySet<string> }): ManifestChange[] {
  const inScope = (p: string): boolean => {
    if (!only) return true
    if (only.files.has(p)) return true
    for (let i = p.lastIndexOf('/'); i > 0; i = p.lastIndexOf('/', i - 1)) if (only.dirs.has(p.slice(0, i))) return true
    return only.dirs.has(p)
  }
  const a = new Map(pre.filter((e) => e.kind !== 'dir').map((e) => [e.path, e]))
  const b = new Map(post.filter((e) => e.kind !== 'dir').map((e) => [e.path, e]))
  const out: ManifestChange[] = []
  for (const [p, before] of a) {
    if (!inScope(p)) continue
    const after = b.get(p)
    if (!after) out.push({ path: p, change: 'deleted', before })
    else if (entryChanged(before, after)) out.push({ path: p, change: 'modified', before, after })
  }
  for (const [p, after] of b) if (!a.has(p) && inScope(p)) out.push({ path: p, change: 'added', after })
  return out.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0))
}

/**
 * Fill in hashes in a post-run manifest: unchanged files (same size/mtime/mode as before) take
 * the pre-run hash; others are hashed (needed for conflict checks at undo time).
 */
export function hashChanged(dir: string, pre: readonly ManifestEntry[], post: ManifestEntry[]): void {
  const before = new Map(pre.map((e) => [e.path, e]))
  for (const e of post) {
    if (e.kind !== 'file' || e.sha256) continue
    const b = before.get(e.path)
    if (b?.kind === 'file' && b.sha256 && b.size === e.size && b.mtimeMs === e.mtimeMs) {
      e.sha256 = b.sha256
      continue
    }
    try {
      const full = path.join(dir, e.path)
      const sha = sha256File(full)
      if (stillInside(dir, full)) e.sha256 = sha
    } catch {
      // vanished, or no longer a regular file
    }
  }
}
