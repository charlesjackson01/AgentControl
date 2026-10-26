/*
 * FE-3 Memory tab. BE-4 routes are isolated in `memoryApi`; a missing route
 * (pre BE-4) resolves to { status: 'unavailable' } instead of throwing.
 * Pure apart from the injected request; tests/memory.test.mjs.
 */
import type { MemoryCategory, MemoryItem, MemoryPage } from './types.ts'
import { isRouteMissing } from './route-missing.ts'
import { listTime } from './shell.ts'

export const MEMORY_CATEGORIES: readonly { id: MemoryCategory; label: string }[] = [
  { id: 'about-you', label: 'About you' },
  { id: 'preferences', label: 'Preferences' },
  { id: 'work', label: 'Work' },
  { id: 'other', label: 'Other' },
]
export const MEMORY_MAX_CHARS = 500
/** BE-4 keeps at most 200 items per scope (a 201st add is a 409), so one page (limit=200) holds the whole scope. */
export const MEMORY_SCOPE_LIMIT = 200

/*
 * Mockup gaps (03b shows neither; neutral versions):
 *   GAP-M1 promptTokens: "≈N tokens in the prompt" appended to the footer line.
 *   GAP-M2 full scope (200 items, 409): the server's message under the editor; Add stays enabled.
 *   GAP-M3 add / edit: inline editor card (textarea, category select, n/500, Cancel / Add|Save).
 *   GAP-M4 delete: inline "Delete this memory? Delete / Keep" under the row.
 *   GAP-M5 empty scope: one muted line (with or without Learn from chat).
 */

/** 03b footer: "Showing 6 of 12 · Group chats keep their own memory, separate from this" (+ GAP-M1 tokens). */
export function memoryFooter(shown: number, total: number, promptTokens: number): string {
  const tokens = promptTokens > 0 ? ` · ≈${promptTokens.toLocaleString('en-US')} tokens in the prompt` : ''
  return `Showing ${shown} of ${total} · Group chats keep their own memory, separate from this${tokens}`
}

export function categoryLabel(c: MemoryCategory): string {
  return MEMORY_CATEGORIES.find((x) => x.id === c)?.label ?? 'Other'
}

type Req = <T>(path: string, init?: RequestInit) => Promise<T>

export type MemoryLoad =
  | { status: 'ok'; page: MemoryPage }
  | { status: 'unavailable' }
  | { status: 'error'; message: string }

/** FE-6: a bot's memory (agent id) or a group's (`{ groupId }`, BE-5 /api/groups/:id/memory). */
export type MemoryOwner = string | { groupId: string }
const base = (owner: MemoryOwner) =>
  typeof owner === 'string' ? `/api/agents/${encodeURIComponent(owner)}/memory` : `/api/groups/${encodeURIComponent(owner.groupId)}/memory`

export function memoryApi(request: Req) {
  return {
    async list(agentId: MemoryOwner): Promise<MemoryLoad> {
      try {
        const page = await request<MemoryPage>(`${base(agentId)}?${new URLSearchParams({ limit: String(MEMORY_SCOPE_LIMIT) })}`)
        return { status: 'ok', page: { items: page.items ?? [], total: page.total ?? page.items?.length ?? 0, promptTokens: page.promptTokens ?? 0 } }
      } catch (err) {
        if (isRouteMissing(err)) return { status: 'unavailable' }
        return { status: 'error', message: err instanceof Error ? err.message : String(err) }
      }
    },
    create(agentId: MemoryOwner, body: { text: string; category: MemoryCategory }): Promise<MemoryItem> {
      return request<MemoryItem>(base(agentId), { method: 'POST', body: JSON.stringify(body) })
    },
    update(agentId: MemoryOwner, id: string, body: { text?: string; category?: MemoryCategory }): Promise<MemoryItem> {
      return request<MemoryItem>(`${base(agentId)}/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) })
    },
    remove(agentId: MemoryOwner, id: string): Promise<unknown> {
      return request<unknown>(`${base(agentId)}/${encodeURIComponent(id)}`, { method: 'DELETE' })
    },
  }
}

/** Client-side validation matching BE-4 (1-500 chars after trim). */
export function validateMemoryText(text: string): string | null {
  const t = text.trim()
  if (!t) return 'Write something to remember.'
  if (t.length > MEMORY_MAX_CHARS) return `Keep it under ${MEMORY_MAX_CHARS} characters (${t.length} now).`
  return null
}

export type MemoryFilter = { query: string; category: MemoryCategory | 'all' }

/** Shown items (newest first) and chip counts for the whole scope. Search ignores the chip counts. */
export function memoryView(items: readonly MemoryItem[], filter: MemoryFilter) {
  const q = filter.query.trim().toLowerCase()
  const counts: Record<MemoryCategory | 'all', number> = { all: items.length, 'about-you': 0, preferences: 0, work: 0, other: 0 }
  for (const m of items) counts[m.category] = (counts[m.category] ?? 0) + 1
  const shown = items
    .filter((m) => (filter.category === 'all' || m.category === filter.category) && (!q || m.text.toLowerCase().includes(q)))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
  /** Chips in 03b order, empty categories hidden (All always shows). */
  const chips = [{ id: 'all' as const, label: 'All', count: counts.all }, ...MEMORY_CATEGORIES.map((c) => ({ ...c, count: counts[c.id] }))].filter(
    (c) => c.id === 'all' || c.count > 0 || c.id === filter.category,
  )
  return { shown, counts, chips }
}

/** "You told me · Oct 12" / "Learned in chat · Today". */
export function memorySourceLine(m: Pick<MemoryItem, 'source' | 'createdAt'>, now: Date = new Date()): string {
  const when = listTime(m.createdAt, now)
  const day = /\d:\d\d/.test(when) ? 'Today' : when
  return `${m.source.kind === 'user' ? 'You told me' : 'Learned in chat'}${day ? ` · ${day}` : ''}`
}

/** FE-6 (06d) group rows: "Saved by Researcher · Today" or "You added this · Today" (GAP-G13). */
export function groupMemorySourceLine(m: Pick<MemoryItem, 'source' | 'createdAt'>, nameOf: (id: string) => string, now: Date = new Date()): string {
  const t = listTime(m.createdAt, now)
  const when = /\d:\d\d/.test(t) ? `Today ${t}` : t
  return `${m.source.kind === 'user' ? 'You added this' : `Saved by ${nameOf(m.source.agentId)}`}${when ? ` · ${when}` : ''}`
}

/** Local list after a create/update (replace by id, else prepend) or delete. */
export function upsertMemory(items: readonly MemoryItem[], item: MemoryItem): MemoryItem[] {
  return items.some((m) => m.id === item.id) ? items.map((m) => (m.id === item.id ? item : m)) : [item, ...items]
}
export function dropMemory(items: readonly MemoryItem[], id: string): MemoryItem[] {
  return items.filter((m) => m.id !== id)
}
