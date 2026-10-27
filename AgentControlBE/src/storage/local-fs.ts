/**
 * BE-P2-6: LocalFs, the in-process StorageBackend (Mac/Linux, and tests).
 * The guard and the no-follow I/O are the Phase 1 code from files.ts, moved
 * here unchanged; files.ts re-exports them for older callers.
 */
import {
  closeSync, constants as fsc, createReadStream, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, readSync, realpathSync, renameSync, rmSync, writeFileSync, writeSync, type Stats,
} from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import type { Readable } from 'node:stream'
import { fail } from '../http.js'
import {
  MARKER_FILE, StorageNotImplementedError, volSegments,
  type SnapshotRef, type StorageBackend, type StorageDirent, type StorageStat, type VolPath, type WriteMode,
} from './types.js'

// --- path guard (Phase 1, unchanged) ---------------------------------------------

/**
 * The real path for `parts` under `root`. Every existing segment is lstat'd
 * (no symlinks anywhere), and the deepest existing ancestor's realpath must
 * stay inside the root's realpath. Returns the joined path (it may not exist).
 */
export function guardedPath(root: string, parts: readonly string[]): string {
  const realRoot = realpathSync(root)
  let current = root
  for (const part of parts) {
    current = join(current, part)
    let info: Stats
    try {
      info = lstatSync(current)
    } catch {
      break // the rest does not exist yet
    }
    if (info.isSymbolicLink()) fail(400, 'Symbolic links are not allowed in bot folders.')
    const real = realpathSync(current)
    if (real !== realRoot && !real.startsWith(realRoot + sep)) fail(400, 'That path is outside the bot folder.')
  }
  const target = resolve(root, ...parts)
  if (target !== resolve(root) && !target.startsWith(resolve(root) + sep)) fail(400, 'That path is outside the bot folder.')
  return target
}

const O_NOFOLLOW = fsc.O_NOFOLLOW ?? 0

/** Open an existing regular file for reading without following a symlink at the last segment. */
export function openNoFollow(path: string): number {
  let fd: number
  try {
    fd = openSync(path, fsc.O_RDONLY | O_NOFOLLOW)
  } catch (err) {
    if ((err as { code?: string }).code === 'ELOOP') fail(400, 'Symbolic links are not allowed in bot folders.')
    throw err
  }
  if (!fstatSync(fd).isFile()) {
    closeSync(fd)
    fail(400, 'That is not a regular file.')
  }
  return fd
}

/** Write a new file (O_CREAT|O_EXCL|O_NOFOLLOW): never follows or replaces anything. */
export function writeNewNoFollow(path: string, body: Buffer | string): void {
  const fd = openSync(path, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | O_NOFOLLOW, 0o644)
  try { writeSync(fd, typeof body === 'string' ? Buffer.from(body) : body) } finally { closeSync(fd) }
}

/** Append to an existing regular file without following a symlink. */
export function appendNoFollow(path: string, body: Buffer | string): void {
  let fd: number
  try {
    fd = openSync(path, fsc.O_WRONLY | fsc.O_APPEND | O_NOFOLLOW)
  } catch (err) {
    if ((err as { code?: string }).code === 'ELOOP') fail(400, 'Symbolic links are not allowed in bot folders.')
    throw err
  }
  try {
    if (!fstatSync(fd).isFile()) fail(400, 'That is not a regular file.')
    writeSync(fd, typeof body === 'string' ? Buffer.from(body) : body)
  } finally { closeSync(fd) }
}

/** A temp file next to `full`, written no-follow; the caller renames or links it into place. */
export function tempNoFollow(full: string, body: Buffer | string): string {
  const temporary = join(dirname(full), `.${full.slice(dirname(full).length + 1)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`)
  writeNewNoFollow(temporary, body)
  return temporary
}

/** Make parent folders segment by segment, re-checking each against symlinks. */
export function mkdirsGuarded(root: string, parts: readonly string[]): void {
  for (let i = 1; i <= parts.length; i++) {
    const p = guardedPath(root, parts.slice(0, i))
    try {
      const st = lstatSync(p)
      if (!st.isDirectory()) fail(409, `"${parts.slice(0, i).join('/')}" is a file, not a folder.`)
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode) throw err
      mkdirSync(p)
    }
  }
}

export function writeIfChanged(path: string, text: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) fail(400, 'Symbolic links are not allowed in bot folders.')
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode) throw err
  }
  let current: string | null = null
  try { current = readFileSync(path, 'utf8') } catch { current = null }
  if (current !== text) writeFileSync(path, text, { mode: 0o644 })
}

/** Bytes used on disk under `dir` (symlinks are not followed). */
export function folderBytes(dir: string): number {
  let total = 0
  let names: string[]
  try { names = readdirSync(dir) } catch { return 0 }
  for (const n of names) {
    const p = join(dir, n)
    const info = lstatSync(p)
    if (info.isDirectory()) total += folderBytes(p)
    else if (info.isFile()) total += info.size
  }
  return total
}

/** Regular files under `dir` (symlinks and our own .tmp files are skipped). */
export function countFiles(dir: string): number {
  let total = 0
  let names: string[]
  try { names = readdirSync(dir) } catch { return 0 }
  for (const n of names) {
    const info = lstatSync(join(dir, n))
    if (info.isDirectory()) total += countFiles(join(dir, n))
    else if (info.isFile() && !(n.startsWith('.') && n.endsWith('.tmp'))) total += 1
  }
  return total
}

export function statOf(info: Stats): StorageStat {
  const kind = info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'dir' : info.isFile() ? 'file' : 'other'
  return { kind, size: info.size, mtimeMs: info.mtimeMs }
}

// --- the backend ------------------------------------------------------------------

export class LocalFs implements StorageBackend {
  readonly kind = 'local' as const
  readonly location: string

  constructor(readonly volumeRoot: string) {
    this.location = volumeRoot
  }

  /** Absolute path of a volume path (validated: no '..', no empty segments). */
  private abs(vol: VolPath): string {
    return join(this.volumeRoot, ...volSegments(vol))
  }

  private guarded(root: VolPath, parts: readonly string[]): string {
    return guardedPath(this.abs(root), parts)
  }

  hostPath(vol: VolPath): string {
    return this.abs(vol)
  }

  ensureDir(vol: VolPath): void {
    mkdirSync(this.abs(vol), { recursive: true })
  }

  existsAt(vol: VolPath): boolean {
    const full = this.abs(vol) // a bad volume path throws; only absence is false
    try { lstatSync(full); return true } catch { return false }
  }

  readTextAt(vol: VolPath): string | null {
    const full = this.abs(vol)
    try { return readFileSync(full, 'utf8') } catch { return null }
  }

  writeTextAt(vol: VolPath, text: string): void {
    const full = this.abs(vol)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, text)
  }

  renameAt(from: VolPath, to: VolPath): void {
    const dest = this.abs(to)
    mkdirSync(dirname(dest), { recursive: true })
    renameSync(this.abs(from), dest)
  }

  du(vol: VolPath): number {
    return folderBytes(this.abs(vol))
  }

  countFiles(vol: VolPath): number {
    return countFiles(this.abs(vol))
  }

  readMarker(): string | null {
    let text: string
    try {
      if (!lstatSync(join(this.volumeRoot, MARKER_FILE)).isFile()) return null
      text = readFileSync(join(this.volumeRoot, MARKER_FILE), 'utf8')
    } catch {
      return null
    }
    const id = text.trim()
    return id === '' ? null : id
  }

  writeMarker(volumeId: string): void {
    mkdirSync(this.volumeRoot, { recursive: true })
    const full = join(this.volumeRoot, MARKER_FILE)
    const temporary = tempNoFollow(full, `${volumeId}\n`)
    try {
      renameSync(temporary, full)
    } catch (err) {
      rmSync(temporary, { force: true })
      throw err
    }
  }

  stat(root: VolPath, parts: readonly string[]): StorageStat | null {
    const full = this.guarded(root, parts)
    try { return statOf(lstatSync(full)) } catch { return null }
  }

  list(root: VolPath, parts: readonly string[]): StorageDirent[] {
    const dir = this.guarded(root, parts)
    return readdirSync(dir).map((name) => ({ name, ...statOf(lstatSync(join(dir, name))) }))
  }

  read(root: VolPath, parts: readonly string[], maxBytes: number): Buffer {
    const fd = openNoFollow(this.guarded(root, parts))
    try {
      const buf = Buffer.alloc(maxBytes)
      let n = 0
      while (n < maxBytes) {
        const got = readSync(fd, buf, n, maxBytes - n, null)
        if (got === 0) break
        n += got
      }
      return buf.subarray(0, n)
    } finally { closeSync(fd) }
  }

  openRead(root: VolPath, parts: readonly string[]): { size: number; stream: Readable } {
    const fd = openNoFollow(this.guarded(root, parts))
    return { size: fstatSync(fd).size, stream: createReadStream('', { fd }) }
  }

  write(root: VolPath, parts: readonly string[], body: Buffer, mode: WriteMode): StorageStat {
    const full = this.guarded(root, parts)
    if (mode === 'append') {
      appendNoFollow(full, body)
    } else {
      const temporary = tempNoFollow(full, body)
      try {
        this.guarded(root, parts) // re-check: nothing was swapped for a symlink meanwhile
        if (mode === 'replace') renameSync(temporary, full)
        else linkSync(temporary, full) // no-clobber: fails with EEXIST if something appeared meanwhile
      } catch (err) {
        rmSync(temporary, { force: true })
        throw err
      }
      if (mode === 'create') rmSync(temporary, { force: true })
    }
    return statOf(lstatSync(full))
  }

  writeIfChanged(root: VolPath, parts: readonly string[], text: string): void {
    writeIfChanged(this.guarded(root, parts), text)
  }

  mkdirs(root: VolPath, parts: readonly string[]): void {
    mkdirsGuarded(this.abs(root), parts)
  }

  move(root: VolPath, from: readonly string[], to: readonly string[]): void {
    const src = this.guarded(root, from)
    const dst = this.guarded(root, to)
    renameSync(src, dst)
  }

  moveOut(root: VolPath, parts: readonly string[], dest: VolPath): void {
    const src = this.guarded(root, parts)
    const target = this.abs(dest)
    mkdirSync(dirname(target), { recursive: true })
    renameSync(src, target)
  }

  remove(root: VolPath, parts: readonly string[]): void {
    rmSync(this.guarded(root, parts), { recursive: true, force: true })
  }

  snapshot(_root: VolPath, _runId: string): SnapshotRef {
    throw new StorageNotImplementedError('Run snapshots', 'BE-P2-9')
  }

  diff(_ref: SnapshotRef): never {
    throw new StorageNotImplementedError('Snapshot diff', 'BE-P2-9')
  }

  undo(_ref: SnapshotRef): never {
    throw new StorageNotImplementedError('Undo', 'BE-P2-11')
  }

  exportZip(_root: VolPath): Readable {
    throw new StorageNotImplementedError('Export', 'BE-P2-17')
  }
}
