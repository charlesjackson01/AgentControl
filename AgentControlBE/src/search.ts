/**
 * BE-10: palette search. Case-insensitive substring match over bot and group
 * names, chat messages (newest 5,000) and file paths in bot and group folders
 * (first 5,000 files walked). Single-user app: every conversation and folder is the user's.
 */
import { lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { botRoot } from './files.js'
import { groupRoot } from './group-files.js'
import { liveGroups } from './groups.js'
import { fail } from './http.js'
import type { ChatMessage, SearchResults } from './shared/types.js'
import type { WorkspaceStore } from './store.js'

export const SEARCH_DEFAULT_LIMIT = 20
export const SEARCH_MAX_LIMIT = 50
export const MAX_SEARCH_MESSAGES = 5000
export const MAX_SEARCH_FILES = 5000
const SNIPPET_CHARS = 120
/** Folders under a bot root that hold the user's and the bot's files (memory and skills are generated). */
const BOT_FILE_ZONES = ['shared', 'workspace']
const GROUP_FILE_ZONES = ['shared']

export function parseSearchQuery(raw: { q?: unknown; limit?: unknown }): { q: string; limit: number } {
  const q = typeof raw.q === 'string' ? raw.q.trim() : ''
  if (q === '') fail(400, 'Type something to search for.')
  if (q.length > 200) fail(400, 'The search is too long (200 characters at most).')
  let limit = SEARCH_DEFAULT_LIMIT
  if (raw.limit !== undefined) {
    const n = Number(raw.limit)
    if (!Number.isInteger(n) || n < 1 || n > SEARCH_MAX_LIMIT) fail(400, `limit must be an integer from 1 to ${SEARCH_MAX_LIMIT}`)
    limit = n
  }
  return { q, limit }
}

/** ~120 chars of `text` centred on the match at `at`, whitespace collapsed, with … where cut. */
export function snippetAround(text: string, at: number, matchLength: number): string {
  const before = Math.max(0, Math.floor((SNIPPET_CHARS - matchLength) / 2))
  let start = Math.max(0, at - before)
  const end = Math.min(text.length, start + Math.max(SNIPPET_CHARS, matchLength))
  start = Math.max(0, Math.min(start, end - SNIPPET_CHARS))
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim()
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`
}

export function search(store: WorkspaceStore, q: string, limit: number): SearchResults {
  const needle = q.toLowerCase()
  const has = (s: string) => s.toLowerCase().includes(needle)
  const groups = liveGroups(store)

  const agents = store.agents.filter((a) => has(a.name)).slice(0, limit).map((a) => ({ id: a.id, name: a.name }))
  const groupHits = groups.filter((g) => has(g.name)).slice(0, limit).map((g) => ({ id: g.id, name: g.name }))

  // Messages: live conversations only (archived groups are hidden), system lines skipped.
  const live = new Set(store.conversations.filter((c) => c.kind !== 'group' || c.archivedAt === undefined).map((c) => c.id))
  const newest: ChatMessage[] = store.chatMessages
    .filter((m) => live.has(m.conversationId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, MAX_SEARCH_MESSAGES)
  const messages: SearchResults['messages'] = []
  for (const m of newest) {
    if (messages.length >= limit) break
    if (m.kind === 'system' || typeof m.content !== 'string') continue
    const at = m.content.toLowerCase().indexOf(needle)
    if (at === -1) continue
    messages.push({
      conversationId: m.conversationId,
      messageId: m.id,
      snippet: snippetAround(m.content, at, q.length),
      ...(m.authorAgentId ? { authorAgentId: m.authorAgentId } : {}),
      createdAt: m.createdAt,
    })
  }

  // Files: walk bot then group folders, stopping after MAX_SEARCH_FILES files. Symlinks are skipped.
  const files: SearchResults['files'] = []
  let walked = 0
  const walk = (root: string, parts: string[], hit: (path: string, name: string, modifiedAt: string) => void) => {
    if (walked >= MAX_SEARCH_FILES) return
    let names: string[]
    try {
      names = readdirSync(join(root, ...parts)).sort()
    } catch {
      return
    }
    for (const name of names) {
      if (walked >= MAX_SEARCH_FILES) return
      const next = [...parts, name]
      let info
      try {
        info = lstatSync(join(root, ...next))
      } catch {
        continue
      }
      if (info.isSymbolicLink()) continue
      if (info.isDirectory()) {
        walk(root, next, hit)
      } else if (info.isFile()) {
        walked++
        const path = next.join('/')
        if (has(path)) hit(path, name, info.mtime.toISOString())
      }
    }
  }
  const roots: { root: 'agent' | 'group'; ownerId: string; dir: string; zones: string[] }[] = []
  for (const agent of store.agents) {
    try {
      roots.push({ root: 'agent', ownerId: agent.id, dir: botRoot(store, agent), zones: BOT_FILE_ZONES })
    } catch {
      // A bot without a valid folder name has no files to search.
    }
  }
  for (const group of groups) {
    try {
      roots.push({ root: 'group', ownerId: group.id, dir: groupRoot(store, group.slug), zones: GROUP_FILE_ZONES })
    } catch {
      // Same for a group.
    }
  }
  for (const r of roots) {
    for (const zone of r.zones) {
      walk(r.dir, [zone], (path, name, modifiedAt) => files.push({ root: r.root, ownerId: r.ownerId, path, name, modifiedAt }))
    }
  }
  files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.path.localeCompare(b.path))

  return { agents, groups: groupHits, messages, files: files.slice(0, limit) }
}
