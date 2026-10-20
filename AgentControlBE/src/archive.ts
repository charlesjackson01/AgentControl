/**
 * BE-1: Projects were retired. Migration `chat-first-archive-v1` copies what
 * the store held for them into data/archive/projects-<ISO>.json and only then
 * drops them from the live store. Project folders on disk are never touched;
 * the archive records their paths.
 */
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_MEMORY_TEXT_CHARS } from './shared/types.js'
import type { Agent, AgentRun, MemoryItem, Note, ProjectArchiveFile } from './shared/types.js'

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
  const name = writeArchiveFile(dataDir, 'projects', archive, at)
  return { name, createdAt: archive.createdAt, projectCount: archive.projects.length }
}

/** Durable data/archive/<prefix>-<stamp>.json; returns the file name. Throws on failure. */
export function writeArchiveFile(dataDir: string, prefix: string, archive: unknown, at: Date): string {
  const dir = join(dataDir, 'archive')
  mkdirSync(dir, { recursive: true })
  let name = `${prefix}-${archiveStamp(at)}.json`
  // Two boots in the same millisecond would otherwise overwrite each other.
  for (let n = 2; existsSync(join(dir, name)); n++) name = `${prefix}-${archiveStamp(at)}-${n}.json`
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
  return name
}

export const NOTES_MIGRATION = 'notes-to-memory-v1'
export const NOTES_RETIRED = "Notes moved into each bot's memory; see /api/agents/:id/memory"

export interface NotesArchive {
  version: 1
  createdAt: string
  notes: Note[]
}

export interface NotesMigrationResult {
  archived: number
  migrated: number
  /** Archive file name under data/archive ('' when there were no notes). */
  file: string
  /** Full-text files written under bots/<slug>/workspace/notes/ (paths relative to the bot folder). */
  fullTextFiles: string[]
}

const NOTE_FILE_SLUG = (title: string): string =>
  title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '') || 'note'

/**
 * notes-to-memory-v1: archive every note to data/archive/notes-<stamp>.json,
 * then turn each into a 'work' memory item in its author's scope with text
 * "title: body" clipped to 500 chars. When it was clipped, the full text also
 * goes to bots/<author slug>/workspace/notes/<slug(title)>.md and the item
 * points at it. The migrated count always equals the archived count (the
 * per-scope cap applies to new items only). Throws when the archive cannot be
 * written; the caller then leaves notes in place and retries next boot.
 */
export function migrateNotesToMemory(
  dataDir: string,
  notes: readonly Note[],
  agents: readonly Agent[],
  dmIdOf: (agentId: string) => string | undefined,
  at: Date,
): { items: MemoryItem[]; result: NotesMigrationResult } {
  if (notes.length === 0) return { items: [], result: { archived: 0, migrated: 0, file: '', fullTextFiles: [] } }
  const file = writeArchiveFile(dataDir, 'notes', { version: 1, createdAt: at.toISOString(), notes: [...notes] } satisfies NotesArchive, at)
  const items: MemoryItem[] = []
  const fullTextFiles: string[] = []
  const used = new Map<string, Set<string>>()
  for (const note of notes) {
    const title = note.title.trim() || 'Untitled'
    const full = `${title}: ${note.body.trim()}`.replace(/\s+$/, '')
    let text = full
    const author = agents.find((a) => a.id === note.authorAgentId)
    if (full.length > MAX_MEMORY_TEXT_CHARS) {
      let pointer = ''
      if (author && /^[a-z0-9-]{1,40}$/.test(author.slug)) {
        const taken = used.get(author.slug) ?? new Set<string>()
        used.set(author.slug, taken)
        const base = NOTE_FILE_SLUG(title)
        let name = `${base}.md`
        const dir = join(dataDir, 'bots', author.slug, 'workspace', 'notes')
        for (let n = 2; taken.has(name) || existsSync(join(dir, name)); n++) name = `${base}-${n}.md`
        taken.add(name)
        try {
          mkdirSync(dir, { recursive: true })
          writeFileSync(join(dir, name), `# ${title}\n\n${note.body.trim()}\n`, { mode: 0o600 })
          pointer = ` (full note: workspace/notes/${name})`
          fullTextFiles.push(`workspace/notes/${name}`)
        } catch {
          // The archive still holds the full text.
        }
      }
      text = `${full.slice(0, MAX_MEMORY_TEXT_CHARS - pointer.length - 1).trimEnd()}…${pointer}`
    }
    const conversationId = dmIdOf(note.authorAgentId)
    items.push({
      id: `mem_${randomUUID()}`,
      scope: { kind: 'agent', agentId: note.authorAgentId },
      text,
      category: 'work',
      source: note.runId && conversationId
        ? { kind: 'chat', conversationId, runId: note.runId, agentId: note.authorAgentId }
        : { kind: 'user' },
      createdAt: note.createdAt,
      updatedAt: note.updatedAt || note.createdAt,
    })
  }
  return { items, result: { archived: notes.length, migrated: items.length, file, fullTextFiles } }
}

