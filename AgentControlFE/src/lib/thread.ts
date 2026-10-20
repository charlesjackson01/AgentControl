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
export function readReceipt(sentAt: string, lastReadAt: string | null | undefined): string | undefined {
  if (!lastReadAt) return undefined
  const read = new Date(lastReadAt)
  const sent = new Date(sentAt)
  if (Number.isNaN(read.getTime()) || Number.isNaN(sent.getTime()) || read.getTime() < sent.getTime()) return undefined
  const time = clockTime(lastReadAt)
  if (sameDay(read, sent)) return `Read ${time}`
  return `Read ${read.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${time}`
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
 * changes. The latest user message shows "Read <lastReadAt>" in place of its
 * time once lastReadAt is at or after it.
 */
export function threadItems(
  messages: readonly ChatMessage[],
  options: { lastReadAt?: string | null; now?: Date } = {},
): ThreadItem[] {
  const now = options.now ?? new Date()
  let lastUser = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user' && messages[i].kind !== 'system') {
      lastUser = i
      break
    }
  }
  const items: ThreadItem[] = []
  let prevDay = ''
  messages.forEach((m, index) => {
    const d = new Date(m.createdAt)
    const day = Number.isNaN(d.getTime()) ? '' : `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
    if (day && day !== prevDay) {
      items.push({ type: 'day', key: `day-${day}`, label: dayLabel(m.createdAt, now) })
      prevDay = day
    }
    const receipt = index === lastUser ? readReceipt(m.createdAt, options.lastReadAt) : undefined
    items.push({ type: 'message', key: m.id, message: m, index, meta: receipt ?? clockTime(m.createdAt) })
  })
  return items
}
