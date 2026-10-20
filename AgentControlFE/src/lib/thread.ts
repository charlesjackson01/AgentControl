/* Pure helpers for the FE-1 thread layout (tests/thread.test.mjs). */
import type { ChatMessage } from './types.ts'

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

/** "9:43 PM". */
export function clockTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

/** Day separator: "Today", "Yesterday", "Monday" (this week), "Oct 3", "Oct 3, 2025". */
export function dayLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  if (sameDay(d, now)) return 'Today'
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((start(now) - start(d)) / 86_400_000)
  if (days === 1) return 'Yesterday'
  if (days > 1 && days < 7) return d.toLocaleDateString('en-US', { weekday: 'long' })
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

/** "Read 9:42 PM" (or "Read Oct 3, 9:42 PM" when read on a later day than it was sent). */
export function readReceipt(sentAt: string, readAt: string | null | undefined): string | undefined {
  if (!readAt) return undefined
  const read = new Date(readAt)
  const sent = new Date(sentAt)
  if (Number.isNaN(read.getTime()) || Number.isNaN(sent.getTime())) return undefined
  const time = clockTime(readAt)
  if (sameDay(read, sent)) return `Read ${time}`
  return `Read ${read.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${time}`
}

/** Index of the latest user message (system lines skipped); -1 when none. */
export function latestUserIndex(messages: readonly Pick<ChatMessage, 'role' | 'kind'>[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user' && messages[i].kind !== 'system') return i
  }
  return -1
}

/** createdAt of the first assistant message after index `i`; undefined when no bot has answered yet. */
export function firstReplyAfter(messages: readonly Pick<ChatMessage, 'role' | 'kind' | 'createdAt'>[], i: number): string | undefined {
  for (let j = i + 1; j < messages.length; j++) {
    if (messages[j].role === 'assistant' && messages[j].kind !== 'system') return messages[j].createdAt
  }
  return undefined
}

/**
 * When the latest user message counts as read: the first bot reply after it,
 * else the time typing was first seen for it (client-side), else not yet.
 */
export function readAtFor(
  messages: readonly Pick<ChatMessage, 'id' | 'role' | 'kind' | 'createdAt'>[],
  typingSeen?: { messageId: string; at: string } | null,
): string | undefined {
  const i = latestUserIndex(messages)
  if (i < 0) return undefined
  const reply = firstReplyAfter(messages, i)
  if (reply) return reply
  return typingSeen && typingSeen.messageId === messages[i].id ? typingSeen.at : undefined
}

export type ThreadItem =
  | { type: 'day'; key: string; label: string }
  | {
      type: 'message'
      key: string
      message: ChatMessage
      /** Index in the input list (for Retry lookups). */
      index: number
      /** Text under the bubble: the receipt on the latest user message, else the time. */
      meta: string
    }

/**
 * The thread, oldest first, with a day separator wherever the calendar day
 * changes. The latest user message shows "Read <time>" in place of its time
 * once a bot has replied (or typing was seen for it; see readAtFor).
 */
export function threadItems(
  messages: readonly ChatMessage[],
  options: { typingSeen?: { messageId: string; at: string } | null; now?: Date } = {},
): ThreadItem[] {
  const now = options.now ?? new Date()
  const lastUser = latestUserIndex(messages)
  const readAt = readAtFor(messages, options.typingSeen)
  const items: ThreadItem[] = []
  let prevDay = ''
  messages.forEach((m, index) => {
    const d = new Date(m.createdAt)
    const day = Number.isNaN(d.getTime()) ? '' : `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
    if (day && day !== prevDay) {
      items.push({ type: 'day', key: `day-${day}`, label: dayLabel(m.createdAt, now) })
      prevDay = day
    }
    const receipt = index === lastUser ? readReceipt(m.createdAt, readAt) : undefined
    items.push({ type: 'message', key: m.id, message: m, index, meta: receipt ?? clockTime(m.createdAt) })
  })
  return items
}

/**
 * Typing runs that started in this poll: conversations with `typingAgentId` set
 * now but not in the previous poll's `wasTyping` set.
 */
export function noteTyping(
  list: readonly { id: string; typingAgentId?: string | null }[],
  wasTyping: ReadonlySet<string>,
  at: string,
): { typing: Set<string>; started: string[]; at: string } {
  const typing = new Set(list.filter((c) => c.typingAgentId).map((c) => c.id))
  return { typing, started: [...typing].filter((id) => !wasTyping.has(id)), at }
}

/** The held typing time applies to the latest user message only when typing began at or after it was sent. */
export function typingSeenFor(
  messages: readonly Pick<ChatMessage, 'id' | 'role' | 'kind' | 'createdAt'>[],
  typingSince: string | undefined,
): { messageId: string; at: string } | null {
  const i = latestUserIndex(messages)
  if (i < 0 || !typingSince || typingSince < messages[i].createdAt) return null
  return { messageId: messages[i].id, at: typingSince }
}
