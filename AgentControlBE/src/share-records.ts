/**
 * BE-9: which files the user shared into a chat. Kept next to the folder
 * (data/bots/<slug>.shared.json, data/groups/<slug>.shared.json) so it is
 * never listed, never counted, and never writable by a bot. Keys are paths
 * relative to the folder root ('shared/report.pdf').
 * BE-P2-6: `root` is a volume path ('bots/<slug>'), read and written through the StorageBackend.
 */
import type { FileEntry } from './shared/types.js'
import type { StorageBackend, VolPath } from './storage/types.js'

export interface ShareRecord {
  sharedAt: string
  sharedInConversationId: string
}

const fileFor = (root: VolPath) => `${root}.shared.json`

export function readShares(fs: StorageBackend, root: VolPath): Record<string, ShareRecord> {
  try {
    const text = fs.readTextAt(fileFor(root))
    if (text === null) return {}
    const raw: unknown = JSON.parse(text)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const out: Record<string, ShareRecord> = {}
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const r = v as Partial<ShareRecord> | null
      if (r && typeof r.sharedAt === 'string' && typeof r.sharedInConversationId === 'string') {
        out[k] = { sharedAt: r.sharedAt, sharedInConversationId: r.sharedInConversationId }
      }
    }
    return out
  } catch {
    return {}
  }
}

function writeShares(fs: StorageBackend, root: VolPath, map: Record<string, ShareRecord>): void {
  fs.writeTextAt(fileFor(root), `${JSON.stringify(map, null, 2)}\n`)
}

export function recordShare(fs: StorageBackend, root: VolPath, path: string, record: ShareRecord): void {
  writeShares(fs, root, { ...readShares(fs, root), [path]: record })
}

/** Move (to a path) or drop (to null) the records at and under `from`. */
export function moveShares(fs: StorageBackend, root: VolPath, from: string, to: string | null): void {
  if (!fs.existsAt(fileFor(root))) return
  const map = readShares(fs, root)
  let changed = false
  for (const key of Object.keys(map)) {
    if (key !== from && !key.startsWith(`${from}/`)) continue
    const value = map[key]!
    delete map[key]
    if (to !== null) map[to + key.slice(from.length)] = value
    changed = true
  }
  if (changed) writeShares(fs, root, map)
}

/** The folder was archived to `target`: its records go with it (as target/.shared.json). */
export function archiveShares(fs: StorageBackend, root: VolPath, target: VolPath): void {
  if (fs.existsAt(fileFor(root))) fs.renameAt(fileFor(root), `${target}/.shared.json`)
}

/** Add sharedAt / sharedInConversationId to file entries the user shared into a chat. */
export function withShares(entries: FileEntry[], map: Record<string, ShareRecord>): FileEntry[] {
  return entries.map((e) => {
    const r = e.kind === 'file' ? map[e.path] : undefined
    return r ? { ...e, sharedAt: r.sharedAt, sharedInConversationId: r.sharedInConversationId } : e
  })
}
