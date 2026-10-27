/**
 * BE-2: each bot's folder, data/bots/<slug>/:
 *   shared/     what the user sent; user-writable, bot read-only
 *   workspace/  bot-writable (BE-3 tools) and user-writable
 *   memory/MEMORY.md, BOT.md   generated from the store, read-only
 *   skills/     virtual read-only listing of the bot's enabled skills (nothing copied)
 * Paths are always relative to the bot root; absolute server paths are never sent.
 */
import { closeSync, constants as fsc, createReadStream, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync, type Stats } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import type { Readable } from 'node:stream'
import { archiveStamp } from './archive.js'
import { fail } from './http.js'
import type { Agent, FileEntry, FileListing, FileZone, Skill } from './shared/types.js'
import { VM_LIMITS } from './shared/types.js'
import type { WorkspaceStore } from './store.js'
import { skillFolder } from './tools/skills.js'
import { archiveShares, moveShares, readShares, withShares } from './share-records.js'

/** Phase 2 (decision 1): 10 GB of personal data per bot; each group's shared/ gets its own 10 GB. */
export const BOT_QUOTA_BYTES = VM_LIMITS.personalDiskMb * 1024 * 1024
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024
export const WRITABLE_ZONES = ['shared', 'workspace'] as const
const ZONES = ['shared', 'workspace', 'memory', 'skills'] as const
const BOT_MD = 'BOT.md'
const MEMORY_MD = 'memory/MEMORY.md'
const MAX_PATH = 1024
/** Virtual skills/ folders carry the server start time (they have no mtime of their own). */
const SERVER_STARTED = new Date().toISOString()

/** Quota in bytes; AGENTCONTROL_BOT_QUOTA_BYTES overrides it (tests). */
export function quotaBytes(): number {
  const raw = Number(process.env.AGENTCONTROL_BOT_QUOTA_BYTES)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : BOT_QUOTA_BYTES
}

export function botsDir(store: WorkspaceStore): string {
  return join(store.dataDir, 'bots')
}

export function botRoot(store: WorkspaceStore, agent: Agent): string {
  if (!/^[a-z0-9-]{1,40}$/.test(agent.slug)) fail(400, 'This bot has no valid folder name.')
  return join(botsDir(store), agent.slug)
}

// --- path guard ---------------------------------------------------------------

/**
 * A client path as clean segments. 400 for absolute paths, `..`, `.`, empty
 * segments, NUL bytes, backslashes and anything over 1,024 chars. '' (or '/')
 * is the bot root. A single trailing slash is allowed.
 */
export function parseClientPath(raw: unknown, field = 'path'): string[] {
  if (raw === undefined || raw === null) return []
  if (typeof raw !== 'string') fail(400, `"${field}" must be a string.`)
  if (raw.length > MAX_PATH) fail(400, `"${field}" is too long.`)
  if (raw.includes('\0')) fail(400, `"${field}" must not contain NUL bytes.`)
  if (raw.includes('\\')) fail(400, `"${field}" must use forward slashes.`)
  if (raw.startsWith('/') && raw !== '/') fail(400, `"${field}" must be relative to the bot folder.`)
  if (/^[A-Za-z]:/.test(raw)) fail(400, `"${field}" must be relative to the bot folder.`)
  const trimmed = raw.replace(/\/$/, '')
  if (trimmed === '') return []
  const parts = trimmed.split('/')
  for (const p of parts) {
    if (p === '' || p === '.' || p === '..') fail(400, `"${field}" must not contain empty, "." or ".." segments.`)
    if (/[\u0000-\u001f\u007f]/.test(p)) fail(400, `"${field}" must not contain control characters.`)
  }
  return parts
}

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

function zoneOf(parts: readonly string[]): FileZone | null {
  if (parts.length === 1 && parts[0] === BOT_MD) return 'meta'
  const z = parts[0]
  return z && (ZONES as readonly string[]).includes(z) ? (z as FileZone) : null
}

/** Writes need a path strictly inside shared/ or workspace/ (403 otherwise). */
export function assertWritable(parts: readonly string[], field = 'path'): void {
  const zone = parts[0]
  if (parts.length < 2 || !(WRITABLE_ZONES as readonly string[]).includes(zone ?? '')) {
    fail(403, `"${field}" must be inside shared/ or workspace/; the rest of the bot folder is read-only.`)
  }
}

// --- folder lifecycle -----------------------------------------------------------

function botMarkdown(agent: Agent): string {
  const lines = [`# ${agent.name}`, '']
  if (agent.role) lines.push(`Role: ${agent.role}`, '')
  if (agent.description) lines.push(agent.description, '')
  lines.push('## Instructions', '', agent.instructions.trim() || '(none)', '')
  const rules = (agent.rules ?? []).map((r) => r.trim()).filter(Boolean)
  if (rules.length > 0) lines.push('## Rules', '', ...rules.map((r) => `- ${r}`), '')
  lines.push('_Generated by AgentControl from this bot\'s profile; edit it in Settings._', '')
  return lines.join('\n')
}

function memoryMarkdown(store: WorkspaceStore, agent: Agent): string {
  const items = store.memories.filter((m) => m.scope.kind === 'agent' && m.scope.agentId === agent.id)
  const lines = [`# What ${agent.name} remembers`, '']
  if (items.length === 0) lines.push('(nothing yet)', '')
  for (const m of items) lines.push(`- [${m.category}] ${m.text.replace(/\s*\n\s*/g, ' ')}`)
  if (items.length > 0) lines.push('')
  lines.push('_Generated by AgentControl from this bot\'s memory; edit it in Settings._', '')
  return lines.join('\n')
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

/** Create the bot's folder (idempotent) and refresh BOT.md and memory/MEMORY.md. */
export function ensureBotFolder(store: WorkspaceStore, agent: Agent): string {
  const root = botRoot(store, agent)
  mkdirSync(root, { recursive: true })
  for (const z of ['shared', 'workspace', 'memory']) {
    const dir = guardedPath(root, [z])
    mkdirSync(dir, { recursive: true })
  }
  writeIfChanged(guardedPath(root, [BOT_MD]), botMarkdown(agent))
  writeIfChanged(guardedPath(root, MEMORY_MD.split('/')), memoryMarkdown(store, agent))
  return root
}

/** Boot: a folder for every bot. Failures are logged, never fatal. */
export function ensureAllBotFolders(store: WorkspaceStore, log: (msg: string) => void = console.warn): void {
  for (const agent of store.agents) {
    try {
      ensureBotFolder(store, agent)
    } catch (err) {
      log(`[files] could not prepare the folder for ${agent.slug}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

/** Unique destination under `dir` for `base` (adds -2, -3… on a clash). */
export function freeName(dir: string, base: string): string {
  let name = base
  for (let n = 2; existsSync(join(dir, name)); n++) name = `${base}-${n}`
  return join(dir, name)
}

/** Bot delete: move the folder to data/archive/bots/<slug>-<ts>/. Never removes it. Returns the archive name. */
export function archiveBotFolder(store: WorkspaceStore, agent: Agent, at = new Date()): string | null {
  const root = botRoot(store, agent)
  if (!existsSync(root)) return null
  const dir = join(store.dataDir, 'archive', 'bots')
  mkdirSync(dir, { recursive: true })
  const target = freeName(dir, `${agent.slug}-${archiveStamp(at)}`)
  renameSync(root, target)
  archiveShares(root, target)
  return relative(join(store.dataDir, 'archive'), target).split(sep).join('/')
}

// --- entries ------------------------------------------------------------------------

const MIME: Record<string, string> = {
  '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json', '.html': 'text/html',
  '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.ts': 'text/plain',
  '.py': 'text/x-python', '.sh': 'text/x-shellscript', '.yaml': 'application/yaml', '.yml': 'application/yaml',
  '.xml': 'application/xml', '.log': 'text/plain', '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.zip': 'application/zip',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}
export function mimeFor(name: string): string {
  return MIME[extname(name).toLowerCase()] ?? 'application/octet-stream'
}

export function entryFor(parts: readonly string[], info: Stats, zone: FileZone): FileEntry {
  const path = parts.join('/')
  const name = parts[parts.length - 1] ?? ''
  const dir = info.isDirectory()
  return {
    path,
    name,
    kind: dir ? 'dir' : 'file',
    size: dir ? 0 : info.size,
    ...(dir ? {} : { mime: mimeFor(name) }),
    modifiedAt: info.mtime.toISOString(),
    zone,
  }
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

// --- quota (BE-3: trash counts, and is pruned oldest-first to make room) ---------------

export function trashDir(store: WorkspaceStore, agent: Agent): string {
  return join(store.dataDir, 'archive', 'trash', agent.slug)
}

export function folderUsage(store: WorkspaceStore, agent: Agent): { bytes: number; quotaBytes: number; trashBytes: number } {
  const trashBytes = folderBytes(trashDir(store, agent))
  return { bytes: folderBytes(botRoot(store, agent)) + trashBytes, quotaBytes: quotaBytes(), trashBytes }
}

/**
 * Make room for `adding` bytes (replacing `freeing` bytes). When the folder plus
 * trash would go over the quota, the oldest trash batches are removed first
 * (trash only, never live files); 413 if it still does not fit.
 */
export function ensureRoom(store: WorkspaceStore, agent: Agent, adding: number, freeing = 0): void {
  ensureRoomAt(botRoot(store, agent), trashDir(store, agent), adding, freeing, 'bot folder')
}

/** ensureRoom for any folder with its own trash (BE-5 group folders use it too). */
export function ensureRoomAt(liveRoot: string, trash: string, adding: number, freeing: number, what: string): void {
  const quota = quotaBytes()
  const live = folderBytes(liveRoot)
  if (live - freeing + adding > quota) fail(413, `This would put the ${what} over its ${Math.round(quota / 1024 / 1024)} MiB limit.`)
  let trashBytes = folderBytes(trash)
  if (live - freeing + adding + trashBytes <= quota) return
  let batches: string[] = []
  try { batches = readdirSync(trash).sort() } catch { batches = [] }
  for (const b of batches) {
    const p = join(trash, b)
    if (lstatSync(p).isSymbolicLink()) continue
    const size = lstatSync(p).isDirectory() ? folderBytes(p) : lstatSync(p).size
    rmSync(p, { recursive: true, force: true })
    trashBytes -= size
    if (live - freeing + adding + trashBytes <= quota) return
  }
}

// --- no-follow file I/O ----------------------------------------------------------------

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

export const byKindThenName = (a: FileEntry, b: FileEntry) =>
  a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1

/** Bytes used on disk under the bot root (symlinks are not followed). */
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

// --- virtual skills/ -----------------------------------------------------------------

interface VirtualNode {
  kind: 'file' | 'dir'
  size: number
  modifiedAt: string
  /** For files: SKILL.md text, or the on-disk vendored file. */
  text?: string
  disk?: string
}

const safeRel = (p: string) => p !== '' && !p.startsWith('/') && !p.includes('\\') && !p.split('/').some((s) => s === '' || s === '.' || s === '..')

/** The bot's enabled skills as a read-only tree keyed by 'skills/…' paths. */
function skillsTree(store: WorkspaceStore, agent: Agent): Map<string, VirtualNode> {
  const tree = new Map<string, VirtualNode>()
  const epoch = SERVER_STARTED
  const addDirs = (path: string) => {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) {
      const d = parts.slice(0, i).join('/')
      if (!tree.has(d)) tree.set(d, { kind: 'dir', size: 0, modifiedAt: epoch })
    }
  }
  tree.set('skills', { kind: 'dir', size: 0, modifiedAt: epoch })
  const seen = new Set<string>()
  for (const id of agent.skillIds) {
    const skill: Skill | undefined = store.skills.find((s) => s.id === id)
    if (!skill || seen.has(skill.id) || !safeRel(skill.id)) continue
    seen.add(skill.id)
    const base = `skills/${skill.id}`
    const content = skill.content ?? ''
    addDirs(`${base}/SKILL.md`)
    tree.set(base, { kind: 'dir', size: 0, modifiedAt: epoch })
    tree.set(`${base}/SKILL.md`, { kind: 'file', size: Buffer.byteLength(content), modifiedAt: epoch, text: content })
    const folder = skillFolder(skill)
    if (!folder) continue
    for (const f of skill.files ?? []) {
      if (f === 'SKILL.md' || !safeRel(f)) continue
      const disk = resolve(folder, f)
      if (!disk.startsWith(resolve(folder) + sep)) continue
      let info: Stats
      try { info = lstatSync(disk) } catch { continue }
      if (!info.isFile()) continue
      addDirs(`${base}/${f}`)
      tree.set(`${base}/${f}`, { kind: 'file', size: info.size, modifiedAt: info.mtime.toISOString(), disk })
    }
  }
  return tree
}

function virtualEntry(path: string, node: VirtualNode): FileEntry {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return {
    path, name, kind: node.kind, size: node.size,
    ...(node.kind === 'file' ? { mime: mimeFor(name) } : {}),
    modifiedAt: node.modifiedAt, zone: 'skills',
  }
}

// --- operations ---------------------------------------------------------------------

export function listFolder(store: WorkspaceStore, agent: Agent, rawPath: unknown): FileListing {
  const root = ensureBotFolder(store, agent)
  const parts = parseClientPath(rawPath)
  const path = parts.join('/')
  const usage = folderUsage(store, agent)
  const totalFiles = countFiles(root)
  const listing = (entries: FileEntry[]): FileListing => ({ root: `bots/${agent.slug}/`, path, entries: entries.sort(byKindThenName), usage, totalFiles })
  if (parts.length === 0) {
    const entries: FileEntry[] = []
    for (const z of ['shared', 'workspace', 'memory'] as const) entries.push(entryFor([z], statSync(guardedPath(root, [z])), z))
    const tree = skillsTree(store, agent)
    entries.push(virtualEntry('skills', tree.get('skills')!))
    entries.push(entryFor([BOT_MD], statSync(guardedPath(root, [BOT_MD])), 'meta'))
    return listing(entries)
  }
  const zone = zoneOf(parts)
  if (!zone) fail(404, `Nothing at "${path}" in this bot's files.`)
  if (zone === 'skills') {
    const tree = skillsTree(store, agent)
    const node = tree.get(path)
    if (!node) fail(404, `Nothing at "${path}" in this bot's files.`)
    if (node.kind !== 'dir') fail(400, `"${path}" is a file; read it with /files/content.`)
    const prefix = `${path}/`
    const entries = [...tree.entries()]
      .filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
      .map(([p, n]) => virtualEntry(p, n))
    return listing(entries)
  }
  const dir = guardedPath(root, parts)
  let info: Stats
  try { info = lstatSync(dir) } catch { fail(404, `Nothing at "${path}" in this bot's files.`) }
  if (!info.isDirectory()) fail(400, `"${path}" is a file; read it with /files/content.`)
  const entries: FileEntry[] = []
  for (const name of readdirSync(dir)) {
    const st = lstatSync(join(dir, name))
    if (st.isSymbolicLink() || (!st.isFile() && !st.isDirectory())) continue // never listed, never served
    if (name.endsWith('.tmp') && name.startsWith('.')) continue
    entries.push(entryFor([...parts, name], st, zone))
  }
  return listing(withShares(entries, readShares(root)))
}

/** Every file under shared/, flat, newest first. */
export function listShared(store: WorkspaceStore, agent: Agent): { entries: FileEntry[] } {
  const root = ensureBotFolder(store, agent)
  const out: FileEntry[] = []
  const walk = (parts: string[]) => {
    const dir = guardedPath(root, parts)
    for (const name of readdirSync(dir)) {
      const st = lstatSync(join(dir, name))
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) walk([...parts, name])
      else if (st.isFile() && !(name.startsWith('.') && name.endsWith('.tmp'))) out.push(entryFor([...parts, name], st, 'shared'))
    }
  }
  walk(['shared'])
  out.sort((a, b) => (a.modifiedAt === b.modifiedAt ? a.path.localeCompare(b.path) : a.modifiedAt < b.modifiedAt ? 1 : -1))
  return { entries: withShares(out, readShares(root)) }
}

export interface FileContent {
  name: string
  mime: string
  size: number
  body: Buffer | Readable
}

export async function readContent(store: WorkspaceStore, agent: Agent, rawPath: unknown): Promise<FileContent> {
  const root = ensureBotFolder(store, agent)
  const parts = parseClientPath(rawPath)
  const path = parts.join('/')
  if (parts.length === 0) fail(400, '"path" is required.')
  const zone = zoneOf(parts)
  if (!zone) fail(404, `No file "${path}" in this bot's files.`)
  const name = parts[parts.length - 1]!
  if (zone === 'skills') {
    const node = skillsTree(store, agent).get(path)
    if (!node) fail(404, `No file "${path}" in this bot's files.`)
    if (node.kind === 'dir') fail(400, `"${path}" is a folder; list it with /files.`)
    const body = node.text !== undefined ? Buffer.from(node.text) : await readFile(node.disk!)
    return { name, mime: mimeFor(name), size: body.length, body }
  }
  const full = guardedPath(root, parts)
  let info: Stats
  try { info = lstatSync(full) } catch { fail(404, `No file "${path}" in this bot's files.`) }
  if (info.isDirectory()) fail(400, `"${path}" is a folder; list it with /files.`)
  if (!info.isFile()) fail(404, `No file "${path}" in this bot's files.`)
  const fd = openNoFollow(full)
  return { name, mime: mimeFor(name), size: fstatSync(fd).size, body: createReadStream('', { fd }) }
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

export function writeContent(store: WorkspaceStore, agent: Agent, rawPath: unknown, body: Buffer, overwrite: boolean): FileEntry {
  const root = ensureBotFolder(store, agent)
  const parts = parseClientPath(rawPath)
  assertWritable(parts)
  const full = guardedPath(root, parts)
  let existing: Stats | null = null
  try { existing = lstatSync(full) } catch { existing = null }
  if (existing?.isDirectory()) fail(409, `"${parts.join('/')}" is a folder.`)
  if (existing && !overwrite) fail(409, `"${parts.join('/')}" already exists. Pass overwrite=1 to replace it.`)
  ensureRoom(store, agent, body.length, existing?.isFile() ? existing.size : 0)
  mkdirsGuarded(root, parts.slice(0, -1))
  const temporary = tempNoFollow(full, body)
  try {
    guardedPath(root, parts) // re-check: nothing was swapped for a symlink meanwhile
    renameSync(temporary, full)
  } catch (err) {
    rmSync(temporary, { force: true })
    throw err
  }
  return entryFor(parts, statSync(full), parts[0] as FileZone)
}

export function makeFolder(store: WorkspaceStore, agent: Agent, rawPath: unknown): FileEntry {
  const root = ensureBotFolder(store, agent)
  const parts = parseClientPath(rawPath)
  assertWritable(parts)
  const full = guardedPath(root, parts)
  if (existsSync(full)) fail(409, `"${parts.join('/')}" already exists.`)
  mkdirsGuarded(root, parts)
  return entryFor(parts, statSync(full), parts[0] as FileZone)
}

export function movePath(store: WorkspaceStore, agent: Agent, rawFrom: unknown, rawTo: unknown): FileEntry {
  const root = ensureBotFolder(store, agent)
  if (typeof rawFrom !== 'string' || rawFrom.trim() === '') fail(400, '"from" is required.')
  if (typeof rawTo !== 'string' || rawTo.trim() === '') fail(400, '"to" is required.')
  const from = parseClientPath(rawFrom, 'from')
  const to = parseClientPath(rawTo, 'to')
  assertWritable(from, 'from')
  assertWritable(to, 'to')
  const src = guardedPath(root, from)
  const dst = guardedPath(root, to)
  let info: Stats
  try { info = lstatSync(src) } catch { fail(404, `Nothing at "${from.join('/')}" in this bot's files.`) }
  if (existsSync(dst)) fail(409, `"${to.join('/')}" already exists.`)
  if (info.isDirectory() && (dst + sep).startsWith(src + sep)) fail(400, 'A folder cannot be moved inside itself.')
  mkdirsGuarded(root, to.slice(0, -1))
  renameSync(src, dst)
  moveShares(root, from.join('/'), to.join('/'))
  return withShares([entryFor(to, statSync(dst), to[0] as FileZone)], readShares(root))[0]!
}

/** Move a file or folder to data/archive/trash/<slug>/<ts>/<path>. Never removed. */
export function trashPath(store: WorkspaceStore, agent: Agent, rawPath: unknown, at = new Date()): void {
  const root = ensureBotFolder(store, agent)
  const parts = parseClientPath(rawPath)
  assertWritable(parts)
  const src = guardedPath(root, parts)
  try { lstatSync(src) } catch { fail(404, `Nothing at "${parts.join('/')}" in this bot's files.`) }
  const trash = trashDir(store, agent)
  mkdirSync(trash, { recursive: true })
  const dest = join(freeName(trash, archiveStamp(at)), ...parts)
  mkdirSync(dirname(dest), { recursive: true })
  renameSync(src, dest)
  moveShares(root, parts.join('/'), null)
}

