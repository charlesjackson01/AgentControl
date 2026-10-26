/**
 * BE-9: which files the user shared into a chat. Kept next to the folder
 * (data/bots/<slug>.shared.json, data/groups/<slug>.shared.json) so it is
 * never listed, never counted, and never writable by a bot. Keys are paths
 * relative to the folder root ('shared/report.pdf').
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { FileEntry } from './shared/types.js'

export interface ShareRecord {
  sharedAt: string
  sharedInConversationId: string
}

const fileFor = (root: string) => `${root}.shared.json`

export function readShares(root: string): Record<string, ShareRecord> {
  try {
    const raw: unknown = JSON.parse(readFileSync(fileFor(root), 'utf8'))
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

function writeShares(root: string, map: Record<string, ShareRecord>): void {
  mkdirSync(dirname(root), { recursive: true })
  writeFileSync(fileFor(root), `${JSON.stringify(map, null, 2)}\n`)
}

export function recordShare(root: string, path: string, record: ShareRecord): void {
  writeShares(root, { ...readShares(root), [path]: record })
}

/** Move (to a path) or drop (to null) the records at and under `from`. */
export function moveShares(root: string, from: string, to: string | null): void {
  if (!existsSync(fileFor(root))) return
  const map = readShares(root)
  let changed = false
  for (const key of Object.keys(map)) {
    if (key !== from && !key.startsWith(`${from}/`)) continue
    const value = map[key]!
    delete map[key]
    if (to !== null) map[to + key.slice(from.length)] = value
    changed = true
  }
  if (changed) writeShares(root, map)
}

/** The folder was archived to `target`: its records go with it (as target/.shared.json). */
export function archiveShares(root: string, target: string): void {
  if (existsSync(fileFor(root))) renameSync(fileFor(root), join(target, '.shared.json'))
}

/** Add sharedAt / sharedInConversationId to file entries the user shared into a chat. */
export function withShares(entries: FileEntry[], map: Record<string, ShareRecord>): FileEntry[] {
  return entries.map((e) => {
    const r = e.kind === 'file' ? map[e.path] : undefined
    return r ? { ...e, sharedAt: r.sharedAt, sharedInConversationId: r.sharedInConversationId } : e
  })
}
