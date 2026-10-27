/* Pure helpers for the chat-first sidebar and thread (tests/conversations.test.mjs). */
import type { Agent, ChatMessage, ChatRunSummary, ConversationSummary, ScriptRunStatus } from './types.ts'
import { attachmentsPreview } from './attachments.ts'

type AgentLike = Pick<Agent, 'id' | 'name' | 'isPrimary'> & Partial<Pick<Agent, 'pinned' | 'hidden'>>
/** DMs carry `agentId`; groups (BE-5) carry `kind: 'group'` and no agentId. */
type Summary = Pick<ConversationSummary, 'id' | 'updatedAt'> & { kind?: 'dm' | 'group'; agentId?: string }

/** The DM's agent id; undefined for a group. */
export function dmAgentId(c: { kind?: 'dm' | 'group'; agentId?: string }): string | undefined {
  return c.kind === 'group' ? undefined : c.agentId
}

function rank(c: Summary, agents: Map<string, AgentLike>): number {
  const id = dmAgentId(c)
  const agent = id ? agents.get(id) : undefined
  if (agent?.isPrimary) return 0
  if (agent?.pinned) return 1
  return 2
}

/** Primary's DM first, then pinned agents, then by last activity (updatedAt, newest first). */
export function sortConversations<T extends Summary>(list: readonly T[], agents: readonly AgentLike[]): T[] {
  const byId = new Map(agents.map((a) => [a.id, a]))
  return [...list].sort(
    (a, b) => rank(a, byId) - rank(b, byId) || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
  )
}

/** Drops DMs with hidden agents unless `showHidden`, and DMs whose agent no longer exists. Groups always stay. */
export function visibleConversations<T extends Summary>(list: readonly T[], agents: readonly AgentLike[], showHidden = false): T[] {
  const byId = new Map(agents.map((a) => [a.id, a]))
  return list.filter((c) => {
    if (c.kind === 'group') return true
    const id = dmAgentId(c)
    const agent = id ? byId.get(id) : undefined
    return Boolean(agent) && (showHidden || !agent?.hidden)
  })
}

export function hiddenCount(list: readonly Summary[], agents: readonly AgentLike[]): number {
  return visibleConversations(list, agents, true).length - visibleConversations(list, agents, false).length
}

/** The Primary agent's DM. */
export function primaryConversation<T extends Summary>(list: readonly T[], agents: readonly AgentLike[]): T | undefined {
  const primary = agents.find((a) => a.isPrimary)
  return primary ? list.find((c) => dmAgentId(c) === primary.id) : undefined
}

/** True when the preview is a failed reply (assistant message with `error: true`). */
export function isErrorPreview(last: Pick<ChatMessage, 'role' | 'error'> | null | undefined): boolean {
  return !!last && last.role === 'assistant' && last.error === true
}

/** One-line preview: "You: " for the user, "Failed: " for a failed reply, whitespace collapsed, clipped to `max` characters. */
const RUN_ENDED: Partial<Record<ScriptRunStatus, string>> = { failed: 'failed', timed_out: 'timed out', stopped: 'stopped', denied: 'denied' }

/**
 * A run message's preview when its content is empty: "Ran report.py", "Ran report.py · failed",
 * "Running report.py". The message's own content wins whenever it has any (shown as is).
 */
export function runPreview(run: Pick<ChatRunSummary, 'name' | 'scriptName' | 'status'> | undefined): string {
  const name = run?.scriptName || run?.name || 'a script'
  if (!run) return `Ran ${name}`
  if (run.status === 'queued' || run.status === 'running' || run.status === 'waiting_permission') return `Running ${name}`
  const ended = RUN_ENDED[run.status]
  return ended ? `Ran ${name} · ${ended}` : `Ran ${name}`
}

export function previewText(
  last: (Pick<ChatMessage, 'role' | 'content' | 'error'> & Partial<Pick<ChatMessage, 'kind' | 'scriptRun'>> & { attachments?: readonly { name: string }[] }) | null | undefined,
  max = 80,
): string {
  if (!last) return 'No messages yet'
  // FE-7: a files-only message previews as "You: 📎 plan.pdf" / "You: 📎 3 files".
  const body =
    last.content.replace(/\s+/g, ' ').trim() ||
    (last.kind === 'run' ? runPreview(last.scriptRun) : '') ||
    attachmentsPreview(last.attachments) ||
    (isErrorPreview(last) ? 'The run failed.' : '…')
  const prefix = last.role === 'user' ? 'You: ' : isErrorPreview(last) ? 'Failed: ' : ''
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

export function totalUnread(list: readonly Pick<ConversationSummary, 'unreadCount'>[]): number {
  return list.reduce((sum, c) => sum + Math.max(0, c.unreadCount || 0), 0)
}

/** Optimistic "read": zero the badge and stamp lastReadAt. Same array back when nothing changes. */
export function markReadLocally<T extends Pick<ConversationSummary, 'id' | 'unreadCount' | 'lastReadAt'>>(
  list: T[],
  id: string,
  at: string = new Date().toISOString(),
): T[] {
  const i = list.findIndex((c) => c.id === id)
  if (i < 0 || list[i].unreadCount === 0) return list
  const next = [...list]
  next[i] = { ...list[i], unreadCount: 0, lastReadAt: at }
  return next
}

/** Insert or replace a summary (e.g. the POST /read response). */
export function upsertConversation<T extends { id: string }>(list: readonly T[], c: T): T[] {
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

/** `before` cursor for the next older page: createdAt of the oldest message shown. */
export function olderCursor(messages: readonly ChatMessage[]): string | undefined {
  return messages[0]?.createdAt
}

/** Mirrors the BE: assistant messages newer than lastReadAt (null = never opened -> all). */
export function countUnread(messages: readonly (Pick<ChatMessage, 'role' | 'createdAt'> & { kind?: ChatMessage['kind'] })[], lastReadAt: string | null): number {
  // FE-6: system lines ("You added Researcher.") never count, as on the BE.
  return messages.filter((m) => m.role === 'assistant' && m.kind !== 'system' && (lastReadAt === null || m.createdAt > lastReadAt)).length
}

/**
 * BE-10: the summary a messages page carries (every page since 085be14; only `?after=`
 * before that). Older servers send a plain Conversation on the first page: null, and the
 * caller keeps relying on the sidebar poll for unread and typing.
 */
export function pageSummary(c: unknown): ConversationSummary | null {
  if (!c || typeof c !== 'object') return null
  const o = c as Record<string, unknown>
  if (typeof o.id !== 'string') return null
  if (o.kind !== undefined && o.kind !== 'dm' && o.kind !== 'group') return null
  if (typeof o.unreadCount !== 'number' || !Number.isFinite(o.unreadCount) || !('lastMessage' in o)) return null
  if (o.typingAgentId !== undefined && o.typingAgentId !== null && typeof o.typingAgentId !== 'string') return null
  return c as ConversationSummary
}
