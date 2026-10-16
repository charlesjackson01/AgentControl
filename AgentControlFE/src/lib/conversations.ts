/* Pure helpers for the chat-first sidebar and thread (tests/conversations.test.mjs). */
import type { Agent, ChatMessage, Conversation, ConversationLastMessage, Project } from './types.ts'

type AgentLike = Pick<Agent, 'id' | 'name' | 'isPrimary'> & Partial<Pick<Agent, 'pinned' | 'hidden'>>
type ProjectLike = Pick<Project, 'id' | 'name'>

/** When a conversation last had activity (last message, else creation). */
export function lastActivity(c: Pick<Conversation, 'createdAt' | 'lastMessage'>): string {
  return c.lastMessage?.createdAt ?? c.createdAt
}

function rank(c: Conversation, agents: Map<string, AgentLike>): number {
  const agent = c.agentId ? agents.get(c.agentId) : undefined
  if (c.kind === 'dm' && agent?.isPrimary) return 0
  if (agent?.pinned) return 1
  return 2
}

/** Primary's DM first, then pinned agents' DMs, then everything else by last activity (newest first). */
export function sortConversations(list: readonly Conversation[], agents: readonly AgentLike[]): Conversation[] {
  const byId = new Map(agents.map((a) => [a.id, a]))
  return [...list].sort(
    (a, b) => rank(a, byId) - rank(b, byId) || lastActivity(b).localeCompare(lastActivity(a)) || a.id.localeCompare(b.id),
  )
}

/** Drops DMs with hidden agents unless `showHidden`; also DMs whose agent no longer exists. */
export function visibleConversations(list: readonly Conversation[], agents: readonly AgentLike[], showHidden = false): Conversation[] {
  const byId = new Map(agents.map((a) => [a.id, a]))
  return list.filter((c) => {
    if (c.kind !== 'dm') return true
    const agent = c.agentId ? byId.get(c.agentId) : undefined
    if (!agent) return false
    return showHidden || !agent.hidden
  })
}

export function hiddenCount(list: readonly Conversation[], agents: readonly AgentLike[]): number {
  return visibleConversations(list, agents, true).length - visibleConversations(list, agents, false).length
}

/** The Primary agent's DM, if the BE has one. */
export function primaryConversation(list: readonly Conversation[], agents: readonly AgentLike[]): Conversation | undefined {
  const primary = agents.find((a) => a.isPrimary)
  return primary ? list.find((c) => c.kind === 'dm' && c.agentId === primary.id) : undefined
}

/** Row title: agent name for DMs, project name for project chats. */
export function conversationTitle(c: Conversation, agents: readonly AgentLike[], projects: readonly ProjectLike[] = []): string {
  if (c.kind === 'dm') return agents.find((a) => a.id === c.agentId)?.name ?? 'Unknown agent'
  return projects.find((p) => p.id === c.projectId)?.name ?? 'Project chat'
}

/** One-line preview: whitespace collapsed, "You: " for the user (and the speaker in group chats), clipped. */
export function previewText(
  last: ConversationLastMessage | undefined,
  opts: { kind: Conversation['kind']; agents?: readonly AgentLike[]; max?: number } = { kind: 'dm' },
): string {
  if (!last) return 'No messages yet'
  const max = opts.max ?? 80
  const body = last.text.replace(/\s+/g, ' ').trim() || '…'
  let prefix = ''
  if (last.author === 'user') prefix = 'You: '
  else if (opts.kind === 'project') {
    const name = opts.agents?.find((a) => a.id === last.author)?.name
    if (name) prefix = `${name}: `
  }
  const full = prefix + body
  const chars = Array.from(full)
  return chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : full
}

/** Compact relative time for sidebar rows: "now", "5m", "3h", "Yesterday", "Mon", "Oct 3", "Oct 3, 2025". */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso)
  const t = then.getTime()
  if (Number.isNaN(t)) return ''
  const diff = now.getTime() - t
  if (diff < 60_000) return 'now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((startOfDay(now) - startOfDay(then)) / 86_400_000)
  if (days <= 0) return `${Math.floor(diff / 3_600_000)}h`
  if (days === 1) return 'Yesterday'
  if (days < 7) return then.toLocaleDateString('en-US', { weekday: 'short' })
  if (then.getFullYear() === now.getFullYear()) return then.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return then.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

/** Badge text: "" for none, "99+" past 99. */
export function unreadLabel(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return ''
  return n > 99 ? '99+' : String(Math.floor(n))
}

export function totalUnread(list: readonly Pick<Conversation, 'unreadCount'>[]): number {
  return list.reduce((sum, c) => sum + Math.max(0, c.unreadCount || 0), 0)
}

/** Optimistic "read": zero the badge and stamp lastReadAt. Returns the same array when nothing changes. */
export function markReadLocally(list: Conversation[], id: string, at: string = new Date().toISOString()): Conversation[] {
  const i = list.findIndex((c) => c.id === id)
  if (i < 0 || list[i].unreadCount === 0) return list
  const next = [...list]
  next[i] = { ...list[i], unreadCount: 0, lastReadAt: at }
  return next
}

/** Insert or replace a conversation (e.g. from a send result). */
export function upsertConversation(list: readonly Conversation[], c: Conversation): Conversation[] {
  const i = list.findIndex((x) => x.id === c.id)
  if (i < 0) return [...list, c]
  const next = [...list]
  next[i] = c
  return next
}

/** Merge message lists by id (later copies win), oldest first. */
export function mergeMessages(...lists: readonly (readonly ChatMessage[])[]): ChatMessage[] {
  const byId = new Map<string, ChatMessage>()
  for (const list of lists) for (const m of list) byId.set(m.id, m)
  return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
}

/** Cursor for the next older page: createdAt of the oldest message shown. */
export function olderCursor(messages: readonly ChatMessage[]): string | undefined {
  return messages[0]?.createdAt
}

/** Messages after the user's last read point that weren't written by the user. */
export function countUnread(messages: readonly ChatMessage[], lastReadAt: string | undefined): number {
  return messages.filter((m) => m.author !== 'user' && (!lastReadAt || m.createdAt > lastReadAt)).length
}
