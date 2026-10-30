/*
 * FE-4 Files tab (mockup 03d) against BE-2 c2257b1. Pure apart from the injected
 * request/fetch; tests/files.test.mjs.
 *
 * Mockup gaps (not shown in v3 03d; minimal neutral versions, pending Charles):
 *   GAP-F1 "Shared by you" / "All files": Shared opens shared/, All files opens the folder root.
 *   GAP-F2 tab count ("Files 31"): the latest listing's optional `totalFiles` (files in the whole
 *          bot folder, not folders, no trash; same on every path), when valid (filesTotal); no
 *          count otherwise. Resolved once BE-2 adds `totalFiles`.
 *   GAP-F3 "sent in chat" needs `sharedAt` (BE-9); without it the line shows the date only.
 *   GAP-F4 folder cards and file rows outside shared/: date only ("9 items · Oct 14").
 *   GAP-F5 row "⋯" menu (Open, Download, Rename…, Delete…): plain list popover; images and
 *          folder cards get the same "⋯" (03d shows none on them).
 *   GAP-F6 New folder / Rename: small dialogs with one name field.
 *   GAP-F7 Delete confirmation wording.
 *   GAP-F8 upload progress, upload/listing errors: one status/alert line above the panes.
 *   GAP-F9 drop highlight: dashed outline on the right pane while dragging.
 *   GAP-F10 empty folder ("This folder is empty.") and loading ("Loading…").
 *   GAP-F11 read-only folders: Upload and Folder disabled with a title.
 *   GAP-F12 search: filters the open folder by name.
 *   GAP-F13 a path refused in the UI (?path= with "..", etc.): alert line, nothing requested.
 *   GAP-F14 (closed by FE-P2-5) Sandbox tab was disabled; the VM tab replaces it.
 *   GAP-F15 breadcrumb segments are clickable (03d shows plain text).
 */
import type { FileEntry, FileListing, FileZone } from './types.ts'
import { humanSize, shortDate, wholeSize } from './file-format.ts'
import { listTime } from './shell.ts'

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024
export const WRITABLE_ZONES: readonly FileZone[] = ['shared', 'workspace']

/* ---------- paths ---------- */

/** NUL, C0 controls or DEL anywhere in the string. */
function hasControl(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x20 || c === 0x7f) return true
  }
  return false
}

export type PathCheck = { ok: true; path: string } | { ok: false; error: string }

/**
 * Client-side copy of BE-2's path guard: relative, forward slashes, no ".", ".."
 * or empty segments, no NUL or control characters. A trailing slash is dropped.
 * '' is the folder root. Anything refused is never sent to the server.
 */
export function checkPath(raw: unknown): PathCheck {
  if (raw === null || raw === undefined) return { ok: true, path: '' }
  if (typeof raw !== 'string') return { ok: false, error: 'That path is not valid.' }
  if (raw.length > 1024) return { ok: false, error: 'That path is too long.' }
  if (hasControl(raw)) return { ok: false, error: 'That path has control characters.' }
  if (raw.includes('\\')) return { ok: false, error: 'That path must use forward slashes.' }
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) return { ok: false, error: 'That path must be inside the bot folder.' }
  const trimmed = raw.replace(/\/+$/, '')
  if (trimmed === '') return { ok: true, path: '' }
  const parts = trimmed.split('/')
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return { ok: false, error: 'That path must stay inside the bot folder (no "." or ".." parts).' }
  return { ok: true, path: parts.join('/') }
}

/** A single file or folder name for New folder / Rename / upload. Null when fine, else the reason. */
export function nameError(raw: string): string | null {
  const name = raw.trim()
  if (name === '') return 'Enter a name.'
  if (name === '.' || name === '..') return 'That name is not allowed.'
  if (name.includes('/') || name.includes('\\')) return 'Names cannot contain / or \\.'
  if (hasControl(name)) return 'Names cannot contain control characters.'
  if (name.length > 255) return 'That name is too long.'
  return null
}

export const joinPath = (dir: string, name: string) => (dir ? `${dir}/${name}` : name)
export const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')
export const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)

export function zoneOfPath(path: string): FileZone | null {
  if (path === 'BOT.md' || path === 'GROUP.md') return 'meta'
  const z = path.split('/')[0]
  return (['shared', 'workspace', 'memory', 'skills'] as const).find((x) => x === z) ?? null
}

/** Uploads and new folders can go into this folder (shared/ and workspace/ and below). */
export function canWriteInto(dir: string): boolean {
  const z = zoneOfPath(dir)
  return z !== null && WRITABLE_ZONES.includes(z)
}

/** Rename and delete: entries strictly inside shared/ or workspace/. */
export function canModify(path: string): boolean {
  return path.includes('/') && canWriteInto(path)
}

/* ---------- zones and icons (03d) ---------- */

export type ZoneBadge = { label: string; tone: 'green' | 'neutral' }

/** Badges on the tree's top-level rows: workspace "scripts write", memory and BOT.md "managed", skills "read-only". */
export function zoneBadge(entry: Pick<FileEntry, 'path'>, group = false): ZoneBadge | null {
  // FE-6 (06c): in a group, shared/ is where members' scripts write; GROUP.md is managed.
  if (group) return entry.path === 'shared' ? { label: 'scripts write', tone: 'green' } : entry.path === 'memory' || entry.path === 'GROUP.md' ? { label: 'managed', tone: 'neutral' } : null
  switch (entry.path) {
    case 'workspace':
      return { label: 'scripts write', tone: 'green' }
    case 'memory':
    case 'BOT.md':
      return { label: 'managed', tone: 'neutral' }
    case 'skills':
      return { label: 'read-only', tone: 'neutral' }
    default:
      return null
  }
}

const ext = (name: string) => (name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '')

export function isImage(e: Pick<FileEntry, 'kind' | 'mime' | 'name'>): boolean {
  if (e.kind !== 'file') return false
  if (e.mime) return e.mime.startsWith('image/')
  return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp'].includes(ext(e.name))
}

/** 03d icons: 🖼 images, 📕 PDF, 📊 spreadsheets, 📄 everything else. */
export function fileIcon(e: Pick<FileEntry, 'kind' | 'mime' | 'name'>): string {
  if (isImage(e)) return '🖼'
  const x = ext(e.name)
  if (e.mime === 'application/pdf' || x === 'pdf') return '📕'
  if (['csv', 'tsv', 'xls', 'xlsx', 'ods'].includes(x)) return '📊'
  return '📄'
}

/** Tree order: the root as in 03d (shared, workspace, memory, skills, BOT.md; BE-2 sorts by name), shared/ newest first. */
const ROOT_ORDER = ['shared', 'workspace', 'memory', 'skills', 'BOT.md']
export function treeEntries(dir: string, entries: readonly FileEntry[]): FileEntry[] {
  // shared/ is newest first in 03d's tree too (files sent today above the older site-photos folder).
  if (zoneOfPath(dir) === 'shared')
    return [...entries].sort((a, b) => (a.modifiedAt !== b.modifiedAt ? (a.modifiedAt < b.modifiedAt ? 1 : -1) : a.name.localeCompare(b.name)))
  if (dir !== '') return [...entries]
  const rank = (e: FileEntry) => {
    const i = ROOT_ORDER.indexOf(e.path)
    return i === -1 ? ROOT_ORDER.length : i
  }
  return [...entries].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}

/**
 * Tree auto-expand (03d): workspace/ opens with the subfolder holding the bot's latest
 * work expanded (03d: briefs/, which has the lindmere-harbor.md the chat just produced;
 * drafts/ stays collapsed). Rule: in workspace/ only, the one subfolder whose newest
 * entry (from the one-level prefetch; else the folder's own mtime) is the most recent.
 * shared/ is not auto-expanded (03d keeps site-photos/ collapsed). Ties: name order.
 */
export function latestSubfolder(dir: string, entries: readonly FileEntry[], children: Readonly<Record<string, Pick<FileListing, 'entries'> | undefined>>): string | null {
  if (dir !== 'workspace') return null
  let best: { path: string; at: string } | null = null
  const dirs = entries.filter((e) => e.kind === 'dir').sort((a, b) => a.name.localeCompare(b.name))
  for (const d of dirs) {
    const kids = children[d.path]?.entries ?? []
    const at = kids.reduce((m, k) => (k.modifiedAt > m ? k.modifiedAt : m), d.modifiedAt ?? '')
    if (!best || at > best.at) best = { path: d.path, at }
  }
  return best?.path ?? null
}

/** GAP-F2: "Files N" (whole bot folder) from a listing's optional `totalFiles`; undefined (no count) when missing or invalid. */
export function filesTotal(listing: unknown): number | undefined {
  if (!listing || typeof listing !== 'object') return undefined
  const n = (listing as { totalFiles?: unknown }).totalFiles
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : undefined
}

/** FE-7 Open (`?panel=files&path=<file>`): true when `path` is a file in its folder's listing. */
export function fileTarget(parent: Pick<FileListing, 'entries'> | undefined, path: string): boolean {
  return !!parent?.entries.some((e) => e.path === path && e.kind === 'file')
}

/* ---------- right pane (03d) ---------- */

export type PaneView = { images: FileEntry[]; folders: FileEntry[]; files: FileEntry[] }

/** Images grid, folder cards, file list. shared/ is newest first (03d), elsewhere folders then names. */
export function paneView(entries: readonly FileEntry[], dir: string, query = ''): PaneView {
  const q = query.trim().toLowerCase()
  const list = entries.filter((e) => (q ? e.name.toLowerCase().includes(q) : true))
  const newest = zoneOfPath(dir) === 'shared'
  const sorted =
    dir === ''
      ? treeEntries('', list)
      : [...list].sort((a, b) =>
          newest && a.modifiedAt !== b.modifiedAt ? (a.modifiedAt < b.modifiedAt ? 1 : -1) : a.name.localeCompare(b.name),
        )
  return {
    images: sorted.filter((e) => isImage(e)),
    folders: sorted.filter((e) => e.kind === 'dir'),
    files: sorted.filter((e) => e.kind === 'file' && !isImage(e)),
  }
}

/** "412 KB · Today" under an image. */
export function imageLine(e: FileEntry, now = new Date()): string {
  return [humanSize(e.size), shortDate(e.modifiedAt, now)].filter(Boolean).join(' · ')
}

/** "9 items · sent Oct 14" on a folder card (03d, shared/); GAP-F4 elsewhere: "9 items · Oct 14". */
export function folderLine(e: FileEntry, count: number | undefined, now = new Date()): string {
  const date = shortDate(e.modifiedAt, now)
  const items = count === undefined ? null : `${count} ${count === 1 ? 'item' : 'items'}`
  return [items, date ? (e.zone === 'shared' ? `sent ${date}` : date) : null].filter(Boolean).join(' · ')
}

/** "sent in chat · Today" on a file row when BE-9 says so (sharedAt); GAP-F3: the date alone otherwise. */
export function fileWhen(e: FileEntry, now = new Date()): string {
  if (e.sharedAt) {
    const d = shortDate(e.sharedAt, now)
    return d ? `sent in chat · ${d}` : 'sent in chat'
  }
  return shortDate(e.modifiedAt, now) ?? ''
}

/** FE-6 (06c) group rows: "Researcher · 8:29 PM" (who added it, when); the date alone when unknown. */
export function groupFileWhen(e: FileEntry, who: string, now = new Date()): string {
  const t = listTime(e.modifiedAt, now)
  return [who || null, t || null].filter(Boolean).join(' · ')
}

/** FE-6 (06c) group image cards: "You · Today". */
export function groupImageLine(e: FileEntry, who: string, now = new Date()): string {
  return [who || null, shortDate(e.modifiedAt, now)].filter(Boolean).join(' · ') || (imageLine(e, now))
}

/** GAP-G12 "By member": files under who added them (the user first, then bots by name, unknown last). */
export function byMember(entries: readonly FileEntry[], nameOf: (addedBy: string) => string): { key: string; label: string; entries: FileEntry[] }[] {
  const groups = new Map<string, FileEntry[]>()
  for (const e of entries) {
    const k = e.addedBy ?? ''
    groups.set(k, [...(groups.get(k) ?? []), e])
  }
  const rank = (k: string) => (k === 'user' ? 0 : k === '' ? 2 : 1)
  return [...groups.entries()]
    .map(([key, list]) => ({ key, label: key ? nameOf(key) : 'Added outside chat', entries: list }))
    .sort((a, b) => rank(a.key) - rank(b.key) || a.label.localeCompare(b.label))
}

export const fileSize = (e: FileEntry) => humanSize(e.size) ?? ''
/** Tree rows: whole sizes ("2 KB"); 03d shows none on shared/ files. */
export const treeSize = (e: FileEntry) => (e.kind === 'file' && e.zone !== 'shared' ? (wholeSize(e.size) ?? '') : '')

/**
 * "46 MB of 500 MB" (03d) and the bar's width (0–100). BE-3: `bytes` already includes
 * the trash, which counts toward the quota, so label and bar show usage with trash.
 * The visible label stays as in 03d (a separate trash figure isn't in v3); `valueText`
 * names the trash part for screen readers when there is any.
 */
export function usageView(u: FileListing['usage'] | null | undefined): { label: string; percent: number; valueText: string } | null {
  if (!u || typeof u.bytes !== 'number' || typeof u.quotaBytes !== 'number' || u.quotaBytes <= 0) return null
  const used = humanSize(u.bytes)
  const quota = humanSize(u.quotaBytes)
  if (!used || !quota) return null
  const label = `${used} of ${quota}`
  const t = u.trashBytes
  const trash = typeof t === 'number' && Number.isFinite(t) && t > 0 ? humanSize(t) : null
  return { label, percent: Math.min(100, Math.max(0, (u.bytes / u.quotaBytes) * 100)), valueText: trash ? `${label}, including ${trash} in trash` : label }
}

/** Breadcrumb "primary / shared / site-photos". */
export function breadcrumb(slug: string, path: string): { label: string; path: string }[] {
  const out = [{ label: slug, path: '' }]
  if (!path) return out
  const parts = path.split('/')
  parts.forEach((p, i) => out.push({ label: p, path: parts.slice(0, i + 1).join('/') }))
  return out
}

/** Folders to show expanded in the tree for `path`: every ancestor and itself. */
export function ancestorsOf(path: string): string[] {
  if (!path) return []
  const parts = path.split('/')
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'))
}

/* ---------- uploads ---------- */

/** Size check before an upload; the BE refuses bodies over 25 MiB too. */
export function uploadError(file: { name: string; size: number }): string | null {
  if (file.size > MAX_UPLOAD_BYTES) return `"${file.name}" is over the 25 MB upload limit (${humanSize(file.size)}).`
  return null
}

/**
 * Error text for a failed files request: the server's own message for 400/403/409
 * and the quota 413; Fastify's body-limit 413 becomes the 25 MB message.
 */
export function filesErrorMessage(status: number, serverMessage: string | null, fileName?: string): string {
  if (status === 413 && (!serverMessage || /body is too large|payload too large/i.test(serverMessage)))
    return fileName ? `"${fileName}" is over the 25 MB upload limit.` : 'That file is over the 25 MB upload limit.'
  if (serverMessage) return serverMessage
  if (status === 403) return 'That part of the bot folder is read-only.'
  if (status === 404) return 'That file or folder no longer exists.'
  return 'Something went wrong with the files request.'
}

/* ---------- URL (?panel=files&path=…, ?panel=settings&tab=files) ---------- */

type ParamsLike = { get(name: string): string | null }

/** The bot settings panel opens on Files for `?panel=files`. */
export function filesPanelOpen(params: ParamsLike): boolean {
  return params.get('panel') === 'files'
}

/** Folder the Files tab shows: `?path=` (raw, checked by the caller), default shared/. */
export function filesPathParam(params: ParamsLike): string {
  return params.get('panel') === 'files' ? (params.get('path') ?? 'shared') : 'shared'
}

/** Params for browsing a folder: `?panel=files&path=…` (other keys kept, tab dropped). */
export function withFilesPath(params: URLSearchParams, path: string): URLSearchParams {
  const next = new URLSearchParams(params)
  next.set('panel', 'files')
  next.delete('tab')
  next.set('path', path)
  return next
}

/* ---------- API (BE-2 c2257b1) ---------- */

type Req = <T>(path: string, init?: RequestInit) => Promise<T>

/** FE-6: a bot's folder (agent id) or a group's (`{ groupId }`, BE-5 /api/groups/:id/files). */
export type FilesOwner = string | { groupId: string }
const filesBase = (owner: FilesOwner) =>
  typeof owner === 'string' ? `/api/agents/${encodeURIComponent(owner)}/files` : `/api/groups/${encodeURIComponent(owner.groupId)}/files`

/** GET …/files/content; `download` adds Content-Disposition: attachment. */
export function fileContentPath(agentId: FilesOwner, path: string, download = false): string {
  const qs = new URLSearchParams({ path })
  if (download) qs.set('download', '1')
  return `${filesBase(agentId)}/content?${qs}`
}

export type Uploader = (url: string, body: Blob) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>

export function filesApi(request: Req, upload: Uploader, messageOf: (body: unknown) => string | null) {
  return {
    list: (agentId: FilesOwner, path: string) => request<FileListing>(`${filesBase(agentId)}?${new URLSearchParams({ path })}`),
    makeFolder: (agentId: FilesOwner, path: string) => request<FileEntry>(`${filesBase(agentId)}/folders`, { method: 'POST', body: JSON.stringify({ path }) }),
    move: (agentId: FilesOwner, from: string, to: string) => request<FileEntry>(filesBase(agentId), { method: 'PATCH', body: JSON.stringify({ from, to }) }),
    remove: (agentId: FilesOwner, path: string) => request<void>(`${filesBase(agentId)}?${new URLSearchParams({ path })}`, { method: 'DELETE' }),
    /** PUT the raw file; refuses over 25 MiB before sending. Throws { status, message }. */
    async upload(agentId: FilesOwner, dir: string, file: File | (Blob & { name: string })): Promise<FileEntry> {
      const tooBig = uploadError(file)
      if (tooBig) throw Object.assign(new Error(tooBig), { status: 413 })
      const bad = nameError(file.name)
      if (bad) throw Object.assign(new Error(bad), { status: 400 })
      const res = await upload(`${filesBase(agentId)}/content?${new URLSearchParams({ path: joinPath(dir, file.name) })}`, file)
      let body: unknown = null
      try {
        body = await res.json()
      } catch {
        body = null
      }
      if (!res.ok) throw Object.assign(new Error(filesErrorMessage(res.status, body ? messageOf(body) : null, file.name)), { status: res.status })
      return body as FileEntry
    },
  }
}

/* ---------- files_missing (BE be-6: every file route answers 409 {reason:'files_missing'}) ---------- */

/** be-6's wording, used only when a files_missing body carries no message of its own. */
export const FILES_MISSING_TEXT =
  "AgentControl can't find the bots' files, so files and runs are paused to keep anything from being overwritten. Chats still work."

/** The server's message for a 409 `reason:'files_missing'` error (ApiError: status + parsed body), else null. */
export function filesMissingOf(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null
  const { status, body } = err as { status?: unknown; body?: unknown }
  if (status !== 409 || !body || typeof body !== 'object') return null
  const b = body as { reason?: unknown; message?: unknown }
  if (b.reason !== 'files_missing') return null
  return typeof b.message === 'string' && b.message.trim() ? b.message : FILES_MISSING_TEXT
}

/** The hint under shared/ (03d). None in files_missing: there is nowhere to drop files. */
export function sharedHint(o: { group: boolean; ownerName: string; filesMissing: boolean }): string | null {
  if (o.filesMissing) return null
  return o.group
    ? 'Files sent in the group chat land here. Your private chats with each bot keep their own folders.'
    : `Drop files here, or send them in chat, to share them with ${o.ownerName}.`
}

/**
 * What the Folder contents pane does with a drag: 'accept' (highlight + upload), 'refuse'
 * (files_missing: swallowed with no highlight and no upload, so the browser doesn't open the file
 * instead), or 'ignore' (not a file drag).
 */
export function paneDrop(types: readonly string[] | undefined | null, filesMissing: boolean): 'accept' | 'refuse' | 'ignore' {
  if (!types || !Array.from(types).includes('Files')) return 'ignore'
  return filesMissing ? 'refuse' : 'accept'
}
