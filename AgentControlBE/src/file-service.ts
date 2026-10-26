/**
 * BE-3: the disk side of the file tools (src/tools/files.ts reaches it only
 * through ctx.files, so tool modules never import node:fs). A run sees its own
 * bot folder (bots/<slug>/: shared/, workspace/, memory/, BOT.md) and, in a
 * group run, the group's shared/ as `group:shared/...`. Writes go to
 * workspace/ (own folder) or group:shared/. Paths are always relative;
 * absolute server paths never reach the model. Every open is no-follow, and
 * each segment is lstat-checked (guardedPath).
 */
import { closeSync, existsSync, linkSync, lstatSync, readSync, readdirSync, renameSync, rmSync, statSync, type Stats } from 'node:fs'
import { join } from 'node:path'
import {
  appendNoFollow,
  ensureBotFolder,
  ensureRoom,
  folderBytes,
  guardedPath,
  mimeFor,
  mkdirsGuarded,
  openNoFollow,
  parseClientPath,
  quotaBytes,
  tempNoFollow,
} from './files.js'
import type { Agent } from './shared/types.js'
import { ensureGroupRoom, recordAddedBy } from './group-files.js'
import type { WorkspaceStore } from './store.js'
import { argError } from './tools/args.js'
import type { FileItem, FileService, SearchHit } from './tools/types.js'

export const MAX_READ_BYTES = 5 * 1024 * 1024
const MAX_SEARCH_FILE_BYTES = 1024 * 1024
const MAX_SEARCH_FILES = 2_000
const GROUP = 'group:'
const BOT_READ_ZONES = ['shared', 'workspace', 'memory']
const isTemp = (n: string) => n.startsWith('.') && n.endsWith('.tmp')

interface Resolved {
  space: 'bot' | 'group'
  /** Absolute folder the parts are relative to (never shown). */
  root: string
  parts: string[]
  /** The path as the model writes it: 'workspace/a.md' or 'group:shared/a.md'. */
  shown: string
}

/** Turn an HTTP-style fail() into a plain tool error (message only). */
function clean<T>(fn: () => T): T {
  try {
    return fn()
  } catch (err) {
    throw new Error(err instanceof Error ? err.message.replace(/bot folder/g, 'allowed folders') : String(err))
  }
}

const decoder = new TextDecoder('utf-8', { fatal: true })
/** UTF-8 text, or null for binary (a NUL in the first 8 KB, or invalid UTF-8). */
function asText(buf: Buffer): string | null {
  if (buf.subarray(0, 8_000).includes(0)) return null
  try { return decoder.decode(buf) } catch { return null }
}

function readCapped(full: string, cap: number): Buffer {
  const fd = clean(() => openNoFollow(full))
  try {
    const buf = Buffer.alloc(cap)
    let n = 0
    while (n < cap) {
      const got = readSync(fd, buf, n, cap - n, null)
      if (got === 0) break
      n += got
    }
    return buf.subarray(0, n)
  } finally { closeSync(fd) }
}

function itemFor(shown: string, info: Stats): FileItem {
  return info.isDirectory()
    ? { path: `${shown}/`, kind: 'folder', modifiedAt: info.mtime.toISOString() }
    : { path: shown, kind: 'file', size: info.size, modifiedAt: info.mtime.toISOString() }
}

/**
 * The file service for one run: `agent`'s own folder, plus `group`'s shared/
 * when the run belongs to a group (data/groups/<slug>/, created by BE-5).
 * Membership is the caller's job: only a member's group run passes `group`.
 */
export function createFileService(store: WorkspaceStore, agent: Agent, group?: { slug: string }): FileService {
  const botRootDir = (): string => clean(() => ensureBotFolder(store, agent))
  const groupRootDir = (): string => {
    const slug = group?.slug ?? ''
    if (!/^[a-z0-9-]{1,40}$/.test(slug)) throw new Error('This group has no valid folder name.')
    return join(store.dataDir, 'groups', slug)
  }

  function resolvePath(raw: unknown, example: Record<string, unknown>): Resolved {
    const text = typeof raw === 'string' ? raw.trim() : raw
    if (typeof text === 'string' && text.startsWith(GROUP)) {
      if (!group) throw argError('There is no group in this conversation, so group: paths are not available.', { ...example, path: 'workspace/' })
      const parts = clean(() => parseClientPath(text.slice(GROUP.length)))
      if (parts.length > 0 && parts[0] !== 'shared') throw argError('Only group:shared/ is available in a group.', { ...example, path: 'group:shared/' })
      const p = parts.length ? parts : ['shared']
      return { space: 'group', root: groupRootDir(), parts: p, shown: `${GROUP}${p.join('/')}` }
    }
    const parts = clean(() => parseClientPath(text))
    if (parts.length > 0 && !(BOT_READ_ZONES.includes(parts[0]!) || (parts.length === 1 && parts[0] === 'BOT.md'))) {
      throw argError(`Nothing at "${parts.join('/')}". Use shared/, workspace/, memory/ or BOT.md${group ? ', or group:shared/' : ''}.`, { ...example, path: 'workspace/' })
    }
    return { space: 'bot', root: botRootDir(), parts, shown: parts.join('/') }
  }

  function writableTarget(raw: unknown, example: Record<string, unknown>): Resolved {
    const where = group ? 'workspace/ (your own files) or group:shared/ (the group)' : 'workspace/'
    const notWritable = (shown: string) =>
      argError(`You can only write inside ${where}; "${shown || '/'}" is read-only.`, { ...example, path: 'workspace/notes.md' })
    // An unknown top-level path (e.g. notes/x.md) gets the write hint, not the read-zone list.
    const text = typeof raw === 'string' ? raw.trim() : raw
    if (typeof text !== 'string' || !text.startsWith(GROUP)) {
      const parts = clean(() => parseClientPath(text))
      if (parts.length > 0 && !(BOT_READ_ZONES.includes(parts[0]!) || (parts.length === 1 && parts[0] === 'BOT.md'))) {
        throw notWritable(parts.join('/'))
      }
    }
    const r = resolvePath(raw, example)
    const ok = r.space === 'group' ? r.parts.length >= 2 : r.parts[0] === 'workspace' && r.parts.length >= 2
    if (!ok) throw notWritable(r.shown)
    if (r.space === 'group' && !existsSync(r.root)) throw new Error('This group has no folder yet.')
    return r
  }

  function guarded(r: Resolved): string {
    if (r.space === 'group' && !existsSync(r.root)) throw new Error(`Nothing at "${r.shown}" yet.`)
    return clean(() => guardedPath(r.root, r.parts))
  }

  function stat(full: string, shown: string): Stats {
    try { return lstatSync(full) } catch { throw new Error(`Nothing at "${shown}".`) }
  }

  /** Top-level places this run can see. */
  function topLevel(): Resolved[] {
    const root = botRootDir()
    const out: Resolved[] = [...BOT_READ_ZONES, 'BOT.md'].map((z) => ({ space: 'bot' as const, root, parts: [z], shown: z }))
    if (group) {
      const g = groupRootDir()
      if (existsSync(join(g, 'shared'))) out.push({ space: 'group', root: g, parts: ['shared'], shown: `${GROUP}shared` })
    }
    return out
  }

  /** Depth-first walk under r (no symlinks, no .tmp); stops when visit returns false. */
  function walk(r: Resolved, visit: (child: Resolved, info: Stats) => boolean): boolean {
    const full = guarded(r)
    let names: string[]
    try { names = readdirSync(full).sort() } catch { return true }
    for (const n of names) {
      if (isTemp(n)) continue
      const child: Resolved = { ...r, parts: [...r.parts, n], shown: `${r.shown}/${n}` }
      const info = lstatSync(join(full, n))
      if (info.isSymbolicLink()) continue
      if (!visit(child, info)) return false
      if (info.isDirectory() && !walk(child, visit)) return false
    }
    return true
  }

  const isTop = (raw: unknown) => raw === undefined || raw === null || raw === '' || raw === '/'

  return {
    list(raw, { recursive, max }) {
      const items: FileItem[] = []
      let truncated = false
      const add = (shown: string, info: Stats): boolean => {
        if (items.length >= max) { truncated = true; return false }
        items.push(itemFor(shown, info))
        return true
      }
      if (isTop(raw)) {
        for (const r of topLevel()) {
          const full = guarded(r)
          if (!existsSync(full)) continue
          const info = lstatSync(full)
          if (!add(r.shown, info)) break
          if (recursive && info.isDirectory() && !walk(r, (c, i) => add(c.shown, i))) break
        }
        return { path: '', entries: items, truncated }
      }
      const r = resolvePath(raw, { path: 'shared/', recursive: false })
      const full = guarded(r)
      const info = stat(full, r.shown)
      if (!info.isDirectory()) return { path: r.shown, entries: [itemFor(r.shown, info)], truncated }
      if (recursive) {
        walk(r, (c, i) => add(c.shown, i))
      } else {
        let names: string[] = []
        try { names = readdirSync(full).sort() } catch { names = [] }
        for (const n of names) {
          if (isTemp(n)) continue
          const ci = lstatSync(join(full, n))
          if (ci.isSymbolicLink()) continue
          if (!add(`${r.shown}/${n}`, ci)) break
        }
      }
      return { path: `${r.shown}/`, entries: items, truncated }
    },

    read(raw) {
      const r = resolvePath(raw, { path: 'shared/notes.md' })
      const full = guarded(r)
      const info = stat(full, r.shown)
      if (info.isDirectory()) throw argError(`"${r.shown}" is a folder; use list_files.`, { path: r.shown })
      if (!info.isFile()) throw new Error(`"${r.shown}" is not a regular file.`)
      const meta = { path: r.shown, size: info.size, mime: mimeFor(r.parts[r.parts.length - 1]!), modifiedAt: info.mtime.toISOString() }
      const buf = readCapped(full, Math.min(info.size, MAX_READ_BYTES) + 1)
      if (buf.length > MAX_READ_BYTES) return { ...meta, text: null, tooLarge: true }
      return { ...meta, text: asText(buf), tooLarge: false }
    },

    search(query, raw, { maxHits }) {
      const needle = query.toLowerCase()
      const roots = isTop(raw) ? topLevel() : [resolvePath(raw, { query, path: 'shared/' })]
      const hits: SearchHit[] = []
      let files = 0
      let truncated = false
      const visit = (c: Resolved, info: Stats): boolean => {
        if (hits.length >= maxHits || files >= MAX_SEARCH_FILES) { truncated = true; return false }
        if (c.parts[c.parts.length - 1]!.toLowerCase().includes(needle)) hits.push({ path: info.isDirectory() ? `${c.shown}/` : c.shown, match: 'name' })
        if (!info.isFile()) return true
        files += 1
        if (info.size > MAX_SEARCH_FILE_BYTES) return true
        const text = asText(readCapped(join(c.root, ...c.parts), info.size))
        if (text === null) return true
        let perFile = 0
        const lines = text.split('\n')
        for (let i = 0; i < lines.length && perFile < 3; i++) {
          if (!lines[i]!.toLowerCase().includes(needle)) continue
          if (hits.length >= maxHits) { truncated = true; return false }
          hits.push({ path: c.shown, match: 'text', line: i + 1, text: lines[i]!.trim().slice(0, 160) })
          perFile += 1
        }
        return true
      }
      for (const r of roots) {
        const full = guarded(r)
        if (!existsSync(full)) {
          if (roots.length === 1) throw new Error(`Nothing at "${r.shown}".`)
          continue
        }
        const info = lstatSync(full)
        if (info.isSymbolicLink()) continue
        if (info.isDirectory() ? !walk(r, visit) : !visit(r, info)) break
      }
      return { hits, truncated }
    },

    write(raw, content, mode) {
      const example = { path: 'workspace/summary.md', content: '# Summary', mode: 'create' }
      const body = Buffer.from(content, 'utf8')
      const r = writableTarget(raw, example)
      const full = guarded(r)
      let existing: Stats | null = null
      try { existing = lstatSync(full) } catch { existing = null }
      if (existing && !existing.isFile()) throw new Error(`"${r.shown}" is a folder, not a file.`)
      if (mode === 'create' && existing) throw argError(`"${r.shown}" already exists. Use mode "overwrite" or "append", or pick another name.`, { ...example, path: r.shown, mode: 'overwrite' })
      const freeing = mode === 'overwrite' && existing ? existing.size : 0
      if (r.space === 'bot') {
        clean(() => ensureRoom(store, agent, body.length, freeing))
      } else {
        clean(() => ensureGroupRoom(store, group!.slug, body.length, freeing))
      }
      clean(() => mkdirsGuarded(r.root, r.parts.slice(0, -1)))
      if (mode === 'append' && existing) {
        clean(() => appendNoFollow(full, body))
      } else {
        const temporary = clean(() => tempNoFollow(full, body))
        try {
          clean(() => guardedPath(r.root, r.parts))
          if (existing) renameSync(temporary, full)
          else linkSync(temporary, full) // no-clobber: fails if something appeared meanwhile
        } catch (err) {
          if ((err as { code?: string }).code === 'EEXIST') throw new Error(`"${r.shown}" already exists.`)
          throw err
        } finally {
          rmSync(temporary, { force: true })
        }
      }
      if (r.space === 'group') recordAddedBy(store, group!.slug, r.parts.join('/'), agent.id)
      const info = statSync(full)
      return { path: r.shown, change: existing ? 'modified' : 'added', bytes: info.size, modifiedAt: info.mtime.toISOString() }
    },

    makeFolder(raw) {
      const r = writableTarget(raw, { path: 'workspace/drafts' })
      const full = guarded(r)
      let existing: Stats | null = null
      try { existing = lstatSync(full) } catch { existing = null }
      if (existing && !existing.isDirectory()) throw new Error(`"${r.shown}" is a file.`)
      if (existing) return { path: `${r.shown}/`, created: false }
      clean(() => mkdirsGuarded(r.root, r.parts))
      return { path: `${r.shown}/`, created: true }
    },
  }
}
