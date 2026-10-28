/**
 * BE-P2-6: where bot and group files live. Every file operation in files.ts,
 * group-files.ts, file-service.ts and attachments.ts goes through a
 * StorageBackend, so the same code runs on the host disk (LocalFs, Mac/Linux)
 * and inside the WSL distro (WslFs → `podman exec ac-storaged acfs <op>`,
 * Windows; PHASE2_PLAN §6).
 *
 * Paths:
 *  - A volume path (VolPath) is a POSIX path relative to the volume root
 *    ('bots/analyst', 'archive/trash/groups/team'). The volume root is the
 *    data dir on Mac/Linux and /var/lib/agentcontrol on Windows.
 *  - Guarded operations take a folder (`root`, a VolPath) plus clean segments
 *    (`parts`, from parseClientPath). The backend applies the same guard as
 *    Phase 1 everywhere: every existing segment is lstat'd (no symlinks), the
 *    real path must stay inside the root, opens are O_NOFOLLOW, writes are
 *    temp + rename (or link for no-clobber).
 *
 * The interface is synchronous because the Phase 1 file code and the model's
 * FileService tools are synchronous; only reading a file body streams.
 */
import type { Readable } from 'node:stream'
import type { StorageBackendKind } from '../shared/types.js'

export type VolPath = string

export interface StorageStat {
  kind: 'file' | 'dir' | 'symlink' | 'other'
  size: number
  mtimeMs: number
}

export interface StorageDirent extends StorageStat {
  name: string
}

/**
 * replace: temp + rename (creates or replaces);
 * create: temp + link, never clobbers (throws an error with code 'EEXIST');
 * append: append to an existing regular file, no-follow.
 */
export type WriteMode = 'replace' | 'create' | 'append'

/** Volume marker check result (VmHostInfo.storage.volumeState). */
export type VolumeState = 'ok' | 'missing' | 'mismatch'

export interface SnapshotRef { root: VolPath; snapshotId: string }

export interface StorageBackend {
  readonly kind: StorageBackendKind
  /** Where the volume lives, for display (VmInfo.storage.location). Never sent for bot paths. */
  readonly location: string
  /** The host path for a volume path when this process can reach it directly (LocalFs), else null. */
  hostPath(vol: VolPath): string | null

  // --- volume level (our own metadata; not guarded per segment, but no '..') ---
  /** mkdir -p of a volume folder. */
  ensureDir(vol: VolPath): void
  existsAt(vol: VolPath): boolean
  /** UTF-8 text of a small metadata file, or null if absent/unreadable. */
  readTextAt(vol: VolPath): string | null
  /** Write a small metadata file (parents created). */
  writeTextAt(vol: VolPath, text: string): void
  /** Rename one volume path to another (parents of `to` created). */
  renameAt(from: VolPath, to: VolPath): void
  /** Bytes of regular files under a volume folder (symlinks not followed); 0 if missing. */
  du(vol: VolPath): number
  /** Regular files under a volume folder (symlinks and our .tmp files skipped); 0 if missing. */
  countFiles(vol: VolPath): number
  /** The volume marker (`.ac-volume-id` at the volume root), or null when absent. */
  readMarker(): string | null
  /** Write the volume marker. Only on first-ever start; never to "repair" a mismatch. */
  writeMarker(volumeId: string): void

  // --- guarded (root + clean segments) ---
  /** lstat (no-follow) of root/parts; null when it does not exist. */
  stat(root: VolPath, parts: readonly string[]): StorageStat | null
  /** Entries of a folder with their lstat; throws when it is missing. Callers filter symlinks/.tmp. */
  list(root: VolPath, parts: readonly string[]): StorageDirent[]
  /** Up to `maxBytes` of a regular file (no-follow). */
  read(root: VolPath, parts: readonly string[], maxBytes: number): Buffer
  /** A regular file (no-follow) as a stream, with its size. */
  openRead(root: VolPath, parts: readonly string[]): { size: number; stream: Readable }
  /** Write a file (parents must exist; see mkdirs). Returns the new stat. */
  write(root: VolPath, parts: readonly string[], body: Buffer, mode: WriteMode): StorageStat
  /** Write generated text (BOT.md, MEMORY.md) only when it changed. */
  writeIfChanged(root: VolPath, parts: readonly string[], text: string): void
  /** Make folders segment by segment, re-checking each; 409 when a segment is a file. */
  mkdirs(root: VolPath, parts: readonly string[]): void
  /** Rename inside one root. */
  move(root: VolPath, from: readonly string[], to: readonly string[]): void
  /** Move root/parts out to a volume path (trash, archive); parents of `dest` created. */
  moveOut(root: VolPath, parts: readonly string[], dest: VolPath): void
  /** rm -rf root/parts (trash pruning only). */
  remove(root: VolPath, parts: readonly string[]): void

  // --- snapshots (BE-P2-9 / BE-P2-11 / BE-P2-18): interface only in BE-P2-6 ---
  snapshot(root: VolPath, runId: string): SnapshotRef
  diff(ref: SnapshotRef): never
  undo(ref: SnapshotRef): never
  exportZip(root: VolPath): Readable
}

/** Thrown by the snapshot/diff/undo/export stubs until their tasks land. */
export class StorageNotImplementedError extends Error {
  readonly statusCode = 501
  constructor(op: string, task: string) {
    super(`${op} is not implemented yet (${task}).`)
    this.name = 'StorageNotImplementedError'
  }
}

/** A volume path from segments, refusing anything that could leave the volume. */
export function volPath(...segments: string[]): VolPath {
  const parts = segments.flatMap((s) => s.split('/'))
  for (const p of parts) {
    if (p === '' || p === '.' || p === '..' || p.includes('\\') || p.includes('\0')) throw new Error(`Bad volume path segment ${JSON.stringify(p)}.`)
  }
  return parts.join('/')
}

export function volSegments(vol: VolPath): string[] {
  return vol === '' ? [] : volPath(vol).split('/')
}

export const MARKER_FILE = '.ac-volume-id'
