/* Pure helpers for the FE-1 chat-only shell (tests/shell.test.mjs). */
import type { Agent, ChatMessage, ConversationSummary } from './types.ts'
import { dmAgentId, previewText, sortConversations, totalUnread, visibleConversations } from './conversations.ts'

type AgentLike = Pick<Agent, 'id' | 'name' | 'isPrimary'> &
  Partial<Pick<Agent, 'pinned' | 'hidden' | 'role' | 'skillIds' | 'status' | 'endpointId'>>

/** The fields the shell reads from a summary; DMs and BE-5 groups both fit. */
export type ShellConversation = Pick<ConversationSummary, 'id' | 'updatedAt' | 'unreadCount' | 'lastMessage'> & {
  kind?: 'dm' | 'group'
  agentId?: string
  name?: string
  memberAgentIds?: string[]
  leadAgentId?: string
}

/* -------------------------------------------------------------------------- */
/* Chat list visibility (persisted)                                           */
/* -------------------------------------------------------------------------- */

export const CHAT_LIST_KEY = 'agentcontrol.chatList.open'

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

/** Whether the chat list is shown. Stored as '1' / '0'; anything else (or no storage) -> `fallback`. */
export function readChatListOpen(storage: StorageLike | null | undefined, fallback = true): boolean {
  try {
    const v = storage?.getItem(CHAT_LIST_KEY)
    if (v === '1') return true
    if (v === '0') return false
  } catch {
    // Private mode / blocked storage: use the default.
  }
  return fallback
}

export function writeChatListOpen(storage: StorageLike | null | undefined, open: boolean): void {
  try {
    storage?.setItem(CHAT_LIST_KEY, open ? '1' : '0')
  } catch {
    // Not persisted; the in-memory state still applies.
  }
}

/* -------------------------------------------------------------------------- */
/* Keyboard                                                                    */
/* -------------------------------------------------------------------------- */

export type ShellShortcut = 'toggle-list' | 'search' | null

/** ⌘\ (Ctrl+\ off-Mac) toggles the chat list; ⌘K / Ctrl+K opens search. */
export function shellShortcut(e: { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean }): ShellShortcut {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return null
  if (e.key === '\\') return 'toggle-list'
  if (!e.shiftKey && (e.key === 'k' || e.key === 'K')) return 'search'
  return null
}

/* -------------------------------------------------------------------------- */
/* Routing                                                                     */
/* -------------------------------------------------------------------------- */

export type HomeTarget = { kind: 'chat'; id: string } | { kind: 'setup' } | { kind: 'empty' }

function activityAt(c: ShellConversation): string {
  return c.lastMessage?.createdAt ?? c.updatedAt
}

/**
 * Where `/` goes: the newest conversation that has a message, else Primary's DM,
 * else any visible chat. No agents at all -> first-run setup (create Primary).
 * DMs are auto-created, so "newest" ignores empty ones (a just-created bot's
 * empty DM would otherwise win).
 */
export function homeTarget(list: readonly ShellConversation[], agents: readonly AgentLike[]): HomeTarget {
  if (agents.length === 0) return { kind: 'setup' }
  const visible = visibleConversations(list, agents)
  const active = visible
    .filter((c) => c.lastMessage)
    .sort((a, b) => activityAt(b).localeCompare(activityAt(a)) || a.id.localeCompare(b.id))
  if (active[0]) return { kind: 'chat', id: active[0].id }
  const primary = agents.find((a) => a.isPrimary)
  const dm = primary ? visible.find((c) => dmAgentId(c) === primary.id) : undefined
  if (dm) return { kind: 'chat', id: dm.id }
  const first = sortConversations(visible, agents)[0]
  return first ? { kind: 'chat', id: first.id } : { kind: 'empty' }
}

/** Retired `/agents/:id` -> that bot's DM (`/c/:id`), or null when it has none (yet). */
export function agentDmPath(agentId: string, list: readonly ShellConversation[]): string | null {
  const dm = list.find((c) => dmAgentId(c) === agentId)
  return dm ? `/c/${dm.id}` : null
}

/* -------------------------------------------------------------------------- */
/* Chat list + switcher                                                        */
/* -------------------------------------------------------------------------- */

export function isGroup(c: { kind?: 'dm' | 'group' }): boolean {
  return c.kind === 'group'
}

/** Row title: the bot's name for a DM, the group name for a group. */
export function conversationTitle(c: ShellConversation, agents: readonly AgentLike[]): string {
  if (isGroup(c)) return c.name ?? 'Group chat'
  return agents.find((a) => a.id === dmAgentId(c))?.name ?? 'Unknown bot'
}

function matches(query: string, ...fields: (string | undefined)[]): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return fields.some((f) => (f ?? '').toLowerCase().includes(q))
}

/**
 * The two sections of the chat list / switcher. Bots: Primary, then pinned, then
 * newest; hidden bots only with `showHidden`. Groups: newest first. `query`
 * filters by name (and a bot's role).
 */
export function chatSections<T extends ShellConversation>(
  list: readonly T[],
  agents: readonly AgentLike[],
  options: { query?: string; showHidden?: boolean } = {},
): { bots: T[]; groups: T[] } {
  const query = options.query ?? ''
  const visible = visibleConversations(list, agents, options.showHidden ?? false)
  const byId = new Map(agents.map((a) => [a.id, a]))
  const bots = sortConversations(
    visible.filter((c) => !isGroup(c)),
    agents,
  ).filter((c) => {
    const agent = byId.get(dmAgentId(c) ?? '')
    return matches(query, agent?.name, agent?.role)
  })
  const groups = visible
    .filter((c) => isGroup(c) && matches(query, c.name))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
  return { bots, groups }
}

/** Total for the ☰ badge: unread across the chats the list can show. */
export function chatListUnread(list: readonly ShellConversation[], agents: readonly AgentLike[]): number {
  return totalUnread(visibleConversations(list, agents))
}

/** Two avatars for a group icon: other members first, then the lead. */
export function groupAvatarIds(g: Pick<ShellConversation, 'memberAgentIds' | 'leadAgentId'>): string[] {
  const members = g.memberAgentIds ?? []
  const others = members.filter((id) => id !== g.leadAgentId)
  const lead = members.filter((id) => id === g.leadAgentId)
  return [...others, ...lead].slice(0, 2)
}

/** Preview line; a group's bot replies are prefixed with the author ("Researcher: …"). */
export function previewLine(
  c: Pick<ShellConversation, 'kind' | 'lastMessage'>,
  agents: readonly Pick<AgentLike, 'id' | 'name'>[],
  max = 80,
): string {
  const last = c.lastMessage as ChatMessage | null
  if (isGroup(c) && last && last.role === 'assistant' && last.authorAgentId && !last.error) {
    const author = agents.find((a) => a.id === last.authorAgentId)?.name
    if (author) return previewText({ ...last, content: `${author}: ${last.content}` }, max)
  }
  return previewText(last, max)
}

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

/** List time: "9:43 PM" today, "Yesterday", weekday this week, "Oct 2", or "Oct 2, 2025". */
export function listTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso)
  if (Number.isNaN(then.getTime())) return ''
  if (sameDay(then, now)) return then.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((start(now) - start(then)) / 86_400_000)
  if (days === 1) return 'Yesterday'
  if (days > 1 && days < 7) return then.toLocaleDateString('en-US', { weekday: 'short' })
  if (then.getFullYear() === now.getFullYear()) return then.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return then.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export type SwitcherItem = {
  id: string
  kind: 'dm' | 'group'
  title: string
  subtitle: string
  /** Right-hand time when nothing is unread. */
  time: string
  unread: number
  current: boolean
  agentId?: string
  isPrimary?: boolean
  memberAgentIds?: string[]
}

/** The bot switcher (02a): sections, subtitles ("Role · 11 skills", "You + 3 bots") and the current chat. */
export function switcherSections(
  list: readonly ShellConversation[],
  agents: readonly AgentLike[],
  options: { query?: string; currentId?: string; now?: Date } = {},
): { bots: SwitcherItem[]; groups: SwitcherItem[] } {
  const { bots, groups } = chatSections(list, agents, { query: options.query })
  const now = options.now ?? new Date()
  const time = (c: ShellConversation) => (c.lastMessage ? listTime(c.lastMessage.createdAt, now) : '')
  return {
    bots: bots.map((c) => {
      const agent = agents.find((a) => a.id === dmAgentId(c))
      const skills = agent?.skillIds?.length ?? 0
      const role = agent?.role?.trim() || 'Bot'
      return {
        id: c.id,
        kind: 'dm' as const,
        title: agent?.name ?? 'Unknown bot',
        subtitle: `${role} · ${skills} ${skills === 1 ? 'skill' : 'skills'}`,
        time: time(c),
        unread: Math.max(0, c.unreadCount || 0),
        current: c.id === options.currentId,
        agentId: agent?.id,
        isPrimary: agent?.isPrimary ?? false,
      }
    }),
    groups: groups.map((c) => {
      const bots = (c.memberAgentIds ?? []).length
      return {
        id: c.id,
        kind: 'group' as const,
        title: c.name ?? 'Group chat',
        subtitle: `You + ${bots} ${bots === 1 ? 'bot' : 'bots'}`,
        time: time(c),
        unread: Math.max(0, c.unreadCount || 0),
        current: c.id === options.currentId,
        memberAgentIds: c.memberAgentIds ?? [],
      }
    }),
  }
}

/** Flat order for arrow-key navigation in the switcher. */
export function switcherOrder(sections: { bots: SwitcherItem[]; groups: SwitcherItem[] }): SwitcherItem[] {
  return [...sections.bots, ...sections.groups]
}

/**
 * Header subline under a bot's name. Only real state: "typing…" while this bot
 * is producing a reply (typingAgentId or our own in-flight send), otherwise the
 * role and model it runs on ("Team Lead · qwen3-32b"). No presence is faked.
 */
export function agentStatusLine(agent: Pick<AgentLike, 'role'> & { modelId?: string }, options: { typing?: boolean } = {}): string {
  const parts = [agent.role?.trim(), options.typing ? 'typing…' : agent.modelId?.trim()].filter(Boolean)
  return parts.join(' · ')
}

/** True when the chat's summary says this bot is the one typing. */
export function isAgentTyping(c: { typingAgentId?: string | null } | undefined, agentId: string | undefined): boolean {
  return Boolean(c?.typingAgentId && agentId && c.typingAgentId === agentId)
}
