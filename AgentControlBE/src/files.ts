/**
 * BE-2: each bot's folder, data/bots/<slug>/:
 *   shared/     what the user sent; user-writable, bot read-only
 *   workspace/  bot-writable (BE-3 tools) and user-writable
 *   memory/MEMORY.md, BOT.md   generated from the store, read-only
 *   skills/     virtual read-only listing of the bot's enabled skills (nothing copied)
 * Paths are always relative to the bot root; absolute server paths are never sent.
 * BE-P2-6: every disk operation goes through the workspace's StorageBackend
 * (src/storage/): LocalFs on Mac/Linux, WslFs on Windows. Bot folders are
 * the volume paths bots/<slug>; trash is archive/trash/<slug>. When the files
 * volume is missing (files_missing) every operation here is refused with 409.
 */
import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { lstatSync, type Stats } from 'node:fs'
import type { Readable } from 'node:stream'
import { archiveStamp } from './archive.js'
import { fail } from './http.js'
import type { Agent, FileEntry, FileListing, FileZone, Skill } from './shared/types.js'
import { VM_LIMITS } from './shared/types.js'
import type { WorkspaceStore } from './store.js'
import { skillFolder } from './tools/skills.js'
import { archiveShares, moveShares, readShares, withShares } from './share-records.js'
import { storageFor, storageReady, type StorageBackend, type StorageStat, type VolPath } from './storage/index.js'

// Phase 1 helpers now live with LocalFs; re-exported for older callers and tests.
export {
  appendNoFollow, countFiles, folderBytes, guardedPath, mkdirsGuarded, openNoFollow, tempNoFollow, writeIfChanged, writeNewNoFollow,
} from './storage/local-fs.js'

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


/** The bot's folder as a volume path: 'bots/<slug>'. */
export function botVol(agent: Agent): VolPath {
  if (!/^[a-z0-9-]{1,40}$/.test(agent.slug)) fail(400, 'This bot has no valid folder name.')
  return `bots/${agent.slug}`
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

/** Create the bot's folder (idempotent) and refresh BOT.md and memory/MEMORY.md. Returns its volume path. */
export function ensureBotFolder(store: WorkspaceStore, agent: Agent): VolPath {
  const fs = storageReady(store)
  const root = botVol(agent)
  fs.ensureDir(root)
  for (const z of ['shared', 'workspace', 'memory']) fs.mkdirs(root, [z])
  fs.writeIfChanged(root, [BOT_MD], botMarkdown(agent))
  fs.writeIfChanged(root, MEMORY_MD.split('/'), memoryMarkdown(store, agent))
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

/** Unique destination under the volume folder `dir` for `base` (adds -2, -3… on a clash). */
export function freeName(fs: StorageBackend, dir: VolPath, base: string): VolPath {
  let name = base
  for (let n = 2; fs.existsAt(`${dir}/${name}`); n++) name = `${base}-${n}`
  return `${dir}/${name}`
}

/** Bot delete: move the folder to archive/bots/<slug>-<ts>/. Never removes it. Returns the archive name. */
export function archiveBotFolder(store: WorkspaceStore, agent: Agent, at = new Date()): string | null {
  const fs = storageReady(store)
  const root = botVol(agent)
  if (!fs.existsAt(root)) return null
  fs.ensureDir('archive/bots')
  const target = freeName(fs, 'archive/bots', `${agent.slug}-${archiveStamp(at)}`)
  fs.renameAt(root, target)
  archiveShares(fs, root, target)
  return target.slice('archive/'.length)
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

/** A FileEntry from a backend stat (or, for older callers, a node Stats). */
export function entryFor(parts: readonly string[], info: StorageStat | Stats, zone: FileZone): FileEntry {
  const path = parts.join('/')
  const name = parts[parts.length - 1] ?? ''
  const dir = 'kind' in info ? info.kind === 'dir' : info.isDirectory()
  return {
    path,
    name,
    kind: dir ? 'dir' : 'file',
    size: dir ? 0 : info.size,
    ...(dir ? {} : { mime: mimeFor(name) }),
    modifiedAt: new Date(info.mtimeMs).toISOString(),
    zone,
  }
}

export const isTempName = (name: string) => name.startsWith('.') && name.endsWith('.tmp')

// --- quota (BE-3: trash counts, and is pruned oldest-first to make room) ---------------

export function trashVol(agent: Agent): VolPath {
  return `archive/trash/${botVol(agent).slice('bots/'.length)}`
}

export function folderUsage(store: WorkspaceStore, agent: Agent): { bytes: number; quotaBytes: number; trashBytes: number } {
  const fs = storageReady(store)
  const trashBytes = fs.du(trashVol(agent))
  return { bytes: fs.du(botVol(agent)) + trashBytes, quotaBytes: quotaBytes(), trashBytes }
}

/**
 * Make room for `adding` bytes (replacing `freeing` bytes). When the folder plus
 * trash would go over the quota, the oldest trash batches are removed first
 * (trash only, never live files); 413 if it still does not fit.
 */
export function ensureRoom(store: WorkspaceStore, agent: Agent, adding: number, freeing = 0): void {
  // BE-P2-10: the bot's tools volumes and image layer share its 10 GB personal limit (plan §5).
  ensureRoomAt(storageReady(store), botVol(agent), trashVol(agent), adding + personalExtraBytes(agent), freeing, 'bot folder')
}

let personalExtraBytes: (agent: Agent) => number = () => 0
/** BE-P2-10: bytes outside the folder counted in the bot's limit (its tools volumes and image layer, last measured). */
export function setPersonalExtraBytes(fn: ((agent: Agent) => number) | null): void {
  personalExtraBytes = fn ?? (() => 0)
}

/** ensureRoom for any folder with its own trash (BE-5 group folders use it too). */
export function ensureRoomAt(fs: StorageBackend, liveRoot: VolPath, trash: VolPath, adding: number, freeing: number, what: string): void {
  const quota = quotaBytes()
  const live = fs.du(liveRoot)
  if (live - freeing + adding > quota) fail(413, `This would put the ${what} over its ${Math.round(quota / 1024 / 1024)} MiB limit.`)
  let trashBytes = fs.du(trash)
  if (live - freeing + adding + trashBytes <= quota) return
  let batches: { name: string; kind: StorageStat['kind']; size: number }[] = []
  try { batches = fs.existsAt(trash) ? fs.list(trash, []).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) : [] } catch { batches = [] }
  for (const b of batches) {
    if (b.kind === 'symlink') continue
    const size = b.kind === 'dir' ? fs.du(`${trash}/${b.name}`) : b.size
    fs.remove(trash, [b.name])
    trashBytes -= size
    if (live - freeing + adding + trashBytes <= quota) return
  }
}

export const byKindThenName = (a: FileEntry, b: FileEntry) =>
  a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1

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

/** Entries of a folder (symlinks, special files and our .tmp files are never listed, never served). */
export function listEntries(fs: StorageBackend, root: VolPath, parts: readonly string[], zone: FileZone): FileEntry[] {
  const entries: FileEntry[] = []
  for (const d of fs.list(root, parts)) {
    if (d.kind !== 'file' && d.kind !== 'dir') continue
    if (isTempName(d.name)) continue
    entries.push(entryFor([...parts, d.name], d, zone))
  }
  return entries
}

/** Every regular file under root/parts, flat (symlinks and .tmp skipped). */
export function walkFiles(fs: StorageBackend, root: VolPath, parts: readonly string[], zone: FileZone): FileEntry[] {
  const out: FileEntry[] = []
  const walk = (at: readonly string[]) => {
    for (const d of fs.list(root, at)) {
      if (d.kind === 'symlink') continue
      if (d.kind === 'dir') walk([...at, d.name])
      else if (d.kind === 'file' && !isTempName(d.name)) out.push(entryFor([...at, d.name], d, zone))
    }
  }
  walk(parts)
  return out
}

export const newestFirst = (a: FileEntry, b: FileEntry) =>
  (a.modifiedAt === b.modifiedAt ? a.path.localeCompare(b.path) : a.modifiedAt < b.modifiedAt ? 1 : -1)

export function listFolder(store: WorkspaceStore, agent: Agent, rawPath: unknown): FileListing {
  const root = ensureBotFolder(store, agent)
  const fs = storageReady(store)
  const parts = parseClientPath(rawPath)
  const path = parts.join('/')
  const usage = folderUsage(store, agent)
  const totalFiles = fs.countFiles(root)
  const listing = (entries: FileEntry[]): FileListing => ({ root: `bots/${agent.slug}/`, path, entries: entries.sort(byKindThenName), usage, totalFiles })
  const statOr404 = (p: readonly string[]): StorageStat => fs.stat(root, p) ?? fail(404, `Nothing at "${p.join('/')}" in this bot's files.`)
  if (parts.length === 0) {
    const entries: FileEntry[] = []
    for (const z of ['shared', 'workspace', 'memory'] as const) entries.push(entryFor([z], statOr404([z]), z))
    const tree = skillsTree(store, agent)
    entries.push(virtualEntry('skills', tree.get('skills')!))
    entries.push(entryFor([BOT_MD], statOr404([BOT_MD]), 'meta'))
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
  const info = fs.stat(root, parts)
  if (!info) fail(404, `Nothing at "${path}" in this bot's files.`)
  if (info.kind !== 'dir') fail(400, `"${path}" is a file; read it with /files/content.`)
  return listing(withShares(listEntries(fs, root, parts, zone), readShares(fs, root)))
}

/** Every file under shared/, flat, newest first. */
export function listShared(store: WorkspaceStore, agent: Agent): { entries: FileEntry[] } {
  const root = ensureBotFolder(store, agent)
  const fs = storageReady(store)
  const out = walkFiles(fs, root, ['shared'], 'shared').sort(newestFirst)
  return { entries: withShares(out, readShares(fs, root)) }
}

export interface FileContent {
  name: string
  mime: string
  size: number
  body: Buffer | Readable
}

export async function readContent(store: WorkspaceStore, agent: Agent, rawPath: unknown): Promise<FileContent> {
  const root = ensureBotFolder(store, agent)
  const fs = storageReady(store)
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
  const info = fs.stat(root, parts)
  if (!info) fail(404, `No file "${path}" in this bot's files.`)
  if (info.kind === 'dir') fail(400, `"${path}" is a folder; list it with /files.`)
  if (info.kind !== 'file') fail(404, `No file "${path}" in this bot's files.`)
  const opened = fs.openRead(root, parts)
  return { name, mime: mimeFor(name), size: opened.size, body: opened.stream }
}

export function writeContent(store: WorkspaceStore, agent: Agent, rawPath: unknown, body: Buffer, overwrite: boolean): FileEntry {
  const root = ensureBotFolder(store, agent)
  const fs = storageReady(store)
  const parts = parseClientPath(rawPath)
  assertWritable(parts)
  const existing = fs.stat(root, parts)
  if (existing?.kind === 'dir') fail(409, `"${parts.join('/')}" is a folder.`)
  if (existing && !overwrite) fail(409, `"${parts.join('/')}" already exists. Pass overwrite=1 to replace it.`)
  ensureRoom(store, agent, body.length, existing?.kind === 'file' ? existing.size : 0)
  fs.mkdirs(root, parts.slice(0, -1))
  const info = fs.write(root, parts, body, 'replace')
  return entryFor(parts, info, parts[0] as FileZone)
}

export function makeFolder(store: WorkspaceStore, agent: Agent, rawPath: unknown): FileEntry {
  const root = ensureBotFolder(store, agent)
  const fs = storageReady(store)
  const parts = parseClientPath(rawPath)
  assertWritable(parts)
  if (fs.stat(root, parts)) fail(409, `"${parts.join('/')}" already exists.`)
  fs.mkdirs(root, parts)
  return entryFor(parts, fs.stat(root, parts)!, parts[0] as FileZone)
}

/** True when `inner` is `outer` or inside it. */
export const isWithin = (outer: readonly string[], inner: readonly string[]) =>
  inner.length >= outer.length && outer.every((p, i) => inner[i] === p)

export function movePath(store: WorkspaceStore, agent: Agent, rawFrom: unknown, rawTo: unknown): FileEntry {
  const root = ensureBotFolder(store, agent)
  const fs = storageReady(store)
  if (typeof rawFrom !== 'string' || rawFrom.trim() === '') fail(400, '"from" is required.')
  if (typeof rawTo !== 'string' || rawTo.trim() === '') fail(400, '"to" is required.')
  const from = parseClientPath(rawFrom, 'from')
  const to = parseClientPath(rawTo, 'to')
  assertWritable(from, 'from')
  assertWritable(to, 'to')
  const info = fs.stat(root, from)
  const taken = fs.stat(root, to) !== null
  if (!info) fail(404, `Nothing at "${from.join('/')}" in this bot's files.`)
  if (taken) fail(409, `"${to.join('/')}" already exists.`)
  if (info.kind === 'dir' && isWithin(from, to)) fail(400, 'A folder cannot be moved inside itself.')
  fs.mkdirs(root, to.slice(0, -1))
  fs.move(root, from, to)
  moveShares(fs, root, from.join('/'), to.join('/'))
  return withShares([entryFor(to, fs.stat(root, to)!, to[0] as FileZone)], readShares(fs, root))[0]!
}

/** Move a file or folder to archive/trash/<slug>/<ts>/<path>. Never removed. */
export function trashPath(store: WorkspaceStore, agent: Agent, rawPath: unknown, at = new Date()): void {
  const root = ensureBotFolder(store, agent)
  const fs = storageReady(store)
  const parts = parseClientPath(rawPath)
  assertWritable(parts)
  if (!fs.stat(root, parts)) fail(404, `Nothing at "${parts.join('/')}" in this bot's files.`)
  const trash = trashVol(agent)
  fs.ensureDir(trash)
  fs.moveOut(root, parts, `${freeName(fs, trash, archiveStamp(at))}/${parts.join('/')}`)
  moveShares(fs, root, parts.join('/'), null)
}

/**
 * Host path of a bot folder. Only for code that still reads the disk directly
 * (search index, sandbox stub); LocalFs only. Prefer botVol + the backend.
 */
export function botRoot(store: WorkspaceStore, agent: Agent): string {
  const vol = botVol(agent)
  return storageHostPath(store, vol)
}

function storageHostPath(store: WorkspaceStore, vol: VolPath): string {
  const host = storageFor(store).backend.hostPath(vol)
  if (host === null) fail(500, 'This storage has no host path.')
  return host
}
