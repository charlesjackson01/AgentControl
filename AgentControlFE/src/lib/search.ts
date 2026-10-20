/*
 * FE-2 command palette data (02b). BE-10 `GET /api/search` lives behind
 * `fetchSearch`; when the route isn't there (404) the palette still finds bots,
 * groups and commands locally and marks message/file search unavailable.
 * Pure apart from the injected fetcher; tests/search.test.mjs.
 */
import type { Agent } from './types.ts'
import { chatPanelPath, matchCommands, messagePath, type CommandContext, type CommandDef } from './commands.ts'
import { agentDmPath, chatSections, conversationTitle, isGroup, listTime, type ShellConversation } from './shell.ts'
import { dmAgentId } from './conversations.ts'

type AgentLike = Pick<Agent, 'id' | 'name' | 'isPrimary'> & Partial<Pick<Agent, 'pinned' | 'hidden' | 'role' | 'avatar' | 'color'>>

/** BE-10 response (phase1-tickets.md, BE-10). */
export type SearchResults = {
  agents: { id: string; name: string }[]
  groups: { id: string; name: string }[]
  messages: { conversationId: string; messageId: string; snippet: string; authorAgentId?: string; createdAt: string }[]
  files: { root: 'agent' | 'group'; ownerId: string; path: string; name: string; modifiedAt: string }[]
}

export type RemoteSearch =
  | { status: 'idle' }
  | { status: 'loading'; query: string }
  | { status: 'ok'; query: string; results: SearchResults }
  /** The server has no search route yet (pre BE-10). */
  | { status: 'unavailable' }
  | { status: 'error'; query: string; message: string }

export const SEARCH_LIMIT = 20
export const SEARCH_MIN_CHARS = 2
export const SEARCH_DEBOUNCE_MS = 160

/** Server search only for real text queries; `/…` is command mode. */
export function shouldSearch(query: string): boolean {
  const q = query.trim()
  return q.length >= SEARCH_MIN_CHARS && !q.startsWith('/')
}

export function searchPath(query: string, limit = SEARCH_LIMIT): string {
  return `/api/search?${new URLSearchParams({ q: query.trim(), limit: String(limit) })}`
}

function emptyResults(): SearchResults {
  return { agents: [], groups: [], messages: [], files: [] }
}

/** Tolerates partial bodies: missing arrays become empty. */
export function normalizeResults(body: unknown): SearchResults {
  const out = emptyResults()
  if (typeof body !== 'object' || body === null) return out
  const b = body as Partial<Record<keyof SearchResults, unknown>>
  for (const k of Object.keys(out) as (keyof SearchResults)[]) if (Array.isArray(b[k])) (out[k] as unknown[]) = b[k] as unknown[]
  return out
}

/** Statuses that mean "this server has no search", not "search failed". */
const NO_ROUTE = new Set([404, 405, 501])

export async function fetchSearch(query: string, get: (path: string) => Promise<unknown>): Promise<RemoteSearch> {
  try {
    return { status: 'ok', query, results: normalizeResults(await get(searchPath(query))) }
  } catch (err) {
    const status = (err as { status?: unknown })?.status
    if (typeof status === 'number' && NO_ROUTE.has(status)) return { status: 'unavailable' }
    return { status: 'error', query, message: err instanceof Error ? err.message : String(err) }
  }
}

/* -------------------------------------------------------------------------- */
/* Sections                                                                    */
/* -------------------------------------------------------------------------- */

export type PaletteItem =
  | {
      type: 'message'
      key: string
      to: string
      conversationId: string
      authorAgentId?: string
      /** "Researcher" in a group, else null (the chat is the bot). */
      authorName: string | null
      snippet: string
      chatTitle: string
      memberAgentIds?: string[]
      leadAgentId?: string
      time: string
    }
  | { type: 'file'; key: string; to: string | null; path: string; name: string; ownerTitle: string; image: boolean }
  | { type: 'chat'; key: string; to: string; conversation: ShellConversation; title: string; subtitle: string }
  | { type: 'command'; key: string; command: CommandDef; reason: string | null }

export type PaletteSections = {
  messages: PaletteItem[]
  files: PaletteItem[]
  chats: PaletteItem[]
  commands: PaletteItem[]
  /** Messages + files can't be searched on this server. */
  remoteUnavailable: boolean
  remoteLoading: boolean
  remoteError: string | null
}

const CHAT_LIMIT = 6

const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|avif)$/i

export function fileTarget(
  f: SearchResults['files'][number],
  list: readonly ShellConversation[],
): string | null {
  if (f.root === 'group') return chatPanelPath(f.ownerId, 'files', f.path)
  const dm = agentDmPath(f.ownerId, list)
  return dm ? chatPanelPath(dm.slice('/c/'.length), 'files', f.path) : null
}

export function paletteSections(
  query: string,
  data: {
    conversations: readonly ShellConversation[]
    agents: readonly AgentLike[]
    remote: RemoteSearch
    ctx: CommandContext
    now?: Date
  },
): PaletteSections {
  const q = query.trim()
  const { conversations, agents, remote, ctx } = data
  const now = data.now ?? new Date()
  const commandMode = q.startsWith('/')
  const commands: PaletteItem[] = matchCommands(q).map(
    (command) => ({ type: 'command', key: `cmd:${command.name}`, command, reason: command.unavailable(ctx) }),
  )
  const empty: PaletteSections = { messages: [], files: [], chats: [], commands, remoteUnavailable: false, remoteLoading: false, remoteError: null }
  if (commandMode) return empty

  const { bots, groups } = chatSections(conversations, agents, { query: q, showHidden: true })
  const chats: PaletteItem[] = [...bots, ...groups].slice(0, CHAT_LIMIT).map((c) => {
    const agent = agents.find((a) => a.id === dmAgentId(c))
    return {
      type: 'chat',
      key: `chat:${c.id}`,
      to: `/c/${c.id}`,
      conversation: c,
      title: conversationTitle(c, agents),
      subtitle: isGroup(c) ? `Group · ${(c.memberAgentIds ?? []).length} bots` : agent?.role || 'Bot',
    }
  })

  const live = remote.status === 'ok' && remote.query.trim() === q
  const results = live ? remote.results : emptyResults()
  const byId = new Map(conversations.map((c) => [c.id, c]))
  const messages: PaletteItem[] = results.messages.map((m) => {
    const c = byId.get(m.conversationId)
    const group = c ? isGroup(c) : false
    return {
      type: 'message',
      key: `msg:${m.conversationId}:${m.messageId}`,
      to: messagePath(m.conversationId, m.messageId),
      conversationId: m.conversationId,
      authorAgentId: m.authorAgentId,
      authorName: group && m.authorAgentId ? (agents.find((a) => a.id === m.authorAgentId)?.name ?? null) : null,
      snippet: m.snippet,
      chatTitle: c ? conversationTitle(c, agents) : 'a chat',
      memberAgentIds: c?.memberAgentIds,
      leadAgentId: c?.leadAgentId,
      time: listTime(m.createdAt, now),
    }
  })
  const files: PaletteItem[] = results.files.map((f) => {
    const owner =
      f.root === 'group'
        ? `${byId.get(f.ownerId)?.name ?? 'Group'}'s shared folder`
        : `${agents.find((a) => a.id === f.ownerId)?.name ?? 'Bot'}'s files`
    return { type: 'file', key: `file:${f.root}:${f.ownerId}:${f.path}`, to: fileTarget(f, conversations), path: f.path, name: f.name, ownerTitle: owner, image: IMAGE_RE.test(f.name) }
  })
  return {
    messages,
    files,
    chats,
    commands,
    remoteUnavailable: remote.status === 'unavailable',
    remoteLoading: shouldSearch(q) && !live && remote.status !== 'unavailable' && !(remote.status === 'error' && remote.query.trim() === q),
    remoteError: remote.status === 'error' && remote.query.trim() === q ? remote.message : null,
  }
}

/** Keyboard order: Messages, Files, Bots & groups, Commands (02b top to bottom). */
export function paletteOrder(s: Pick<PaletteSections, 'messages' | 'files' | 'chats' | 'commands'>): PaletteItem[] {
  return [...s.messages, ...s.files, ...s.chats, ...s.commands]
}

/** Next active index for ↑/↓ (wraps); -1 when empty. */
export function moveActive(current: number, delta: 1 | -1, length: number): number {
  if (length <= 0) return -1
  const from = Math.min(Math.max(current, 0), length - 1)
  return (from + delta + length) % length
}

/** Split text around case-insensitive matches of `query` for <b> highlighting. */
export function highlight(text: string, query: string): { text: string; match: boolean }[] {
  const q = query.trim()
  if (!q) return [{ text, match: false }]
  const out: { text: string; match: boolean }[] = []
  const lower = text.toLowerCase()
  const ql = q.toLowerCase()
  let i = 0
  for (let at = lower.indexOf(ql); at !== -1; at = lower.indexOf(ql, i)) {
    if (at > i) out.push({ text: text.slice(i, at), match: false })
    out.push({ text: text.slice(at, at + q.length), match: true })
    i = at + q.length
  }
  if (i < text.length) out.push({ text: text.slice(i), match: false })
  return out.length ? out : [{ text, match: false }]
}
