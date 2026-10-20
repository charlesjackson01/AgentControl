/**
 * BE-1: Projects were retired. Migration `chat-first-archive-v1` copies what
 * the store held for them into data/archive/projects-<ISO>.json and only then
 * drops them from the live store. Project folders on disk are never touched;
 * the archive records their paths.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentRun, Note, ProjectArchiveFile } from './shared/types.js'

export const ARCHIVE_MIGRATION = 'chat-first-archive-v1'
export const PROJECTS_RETIRED = 'Projects were retired; see /api/archive/projects'

/** What the archive file holds: the store's project data exactly as it was loaded. */
export interface ProjectArchive {
  version: 1
  createdAt: string
  projects: unknown[]
  projectMessages: unknown[]
  /** Runs that belonged to a project task (they also stay in the store). */
  projectRuns: AgentRun[]
  /** Notes at archive time (BE-4 migrates them into memory). */
  notes: Note[]
  /** Project folders, left on disk untouched. Server-side only; never served. */
  folders: string[]
}

/** File-name safe ISO stamp: 2026-10-19T14-03-22-511Z. */
export function archiveStamp(at: Date): string {
  return at.toISOString().replace(/[:.]/g, '-')
}

/**
 * Write the archive durably: temp file, fsync, rename, then fsync the folder.
 * Throws on any failure (the temp file is removed); the caller then leaves
 * the store unchanged.
 */
export function writeProjectArchive(dataDir: string, archive: ProjectArchive, at: Date): ProjectArchiveFile {
  const dir = join(dataDir, 'archive')
  mkdirSync(dir, { recursive: true })
  let name = `projects-${archiveStamp(at)}.json`
  // Two boots in the same millisecond would otherwise overwrite each other.
  for (let n = 2; existsSync(join(dir, name)); n++) name = `projects-${archiveStamp(at)}-${n}.json`
  const target = join(dir, name)
  const temporary = `${target}.${process.pid}.tmp`
  try {
    const fd = openSync(temporary, 'w', 0o600)
    try {
      writeSync(fd, JSON.stringify(archive, null, 2))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temporary, target)
  } catch (err) {
    try { rmSync(temporary, { force: true }) } catch { /* keep the original error */ }
    throw err
  }
  try {
    const dirFd = openSync(dir, 'r')
    try { fsyncSync(dirFd) } finally { closeSync(dirFd) }
  } catch {
    // Some platforms cannot fsync a directory; the file itself is synced.
  }
  return { name, createdAt: archive.createdAt, projectCount: archive.projects.length }
}

