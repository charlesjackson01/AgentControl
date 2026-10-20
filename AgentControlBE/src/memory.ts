/**
 * BE-4: memory per bot (scope agent) and per group (scope group). 200 items
 * per scope; the prompt gets the newest items up to MEMORY_PROMPT_TOKENS.
 * A group run sees only the group's memory, never a member bot's private one.
 */
import { randomUUID } from 'node:crypto'
import { ensureBotFolder } from './files.js'
import { fail } from './http.js'
import { MAX_MEMORY_TEXT_CHARS, MEMORY_CATEGORIES, type MemoryCategory, type MemoryItem } from './shared/types.js'
import type { WorkspaceStore } from './store.js'

/** Same chars/4 estimate as prompt.ts (kept local so the tool registry loads without a cycle). */
const estimateTokens = (chars: number): number => Math.ceil(chars / 4)

export const MAX_MEMORY_PER_SCOPE = 200
export const MEMORY_PROMPT_TOKENS = 1_500
export const MEMORY_LIST_MAX = 200
export const MEMORY_HEADER = 'What you remember (newest first):\n'

export type MemoryScope = MemoryItem['scope']

export const sameScope = (a: MemoryScope, b: MemoryScope): boolean =>
  a.kind === 'agent' ? b.kind === 'agent' && a.agentId === b.agentId : b.kind === 'group' && a.groupId === b.groupId

const newestFirst = (a: MemoryItem, b: MemoryItem) =>
  b.updatedAt === a.updatedAt ? (b.createdAt === a.createdAt ? b.id.localeCompare(a.id) : b.createdAt.localeCompare(a.createdAt)) : b.updatedAt.localeCompare(a.updatedAt)

export function scopeItems(store: WorkspaceStore, scope: MemoryScope): MemoryItem[] {
  return store.memories.filter((m) => sameScope(m.scope, scope)).sort(newestFirst)
}

/** The scope's prompt section: newest items while the section stays within MEMORY_PROMPT_TOKENS. '' when empty. */
export function memoryPromptBlock(store: WorkspaceStore, scope: MemoryScope, maxTokens = MEMORY_PROMPT_TOKENS): string {
  let text = ''
  for (const m of scopeItems(store, scope)) {
    const line = `- [${m.category}] ${m.text.replace(/\s*\n\s*/g, ' ')}\n`
    const next = `${text || MEMORY_HEADER}${line}`
    if (estimateTokens(next.length) > maxTokens) break
    text = next
  }
  return text.trimEnd()
}

export function parseText(raw: unknown, required: boolean): string | undefined {
  if (raw === undefined && !required) return undefined
  if (typeof raw !== 'string' || raw.trim() === '') fail(400, '"text" must be a non-empty string.')
  const text = raw.trim()
  if (text.length > MAX_MEMORY_TEXT_CHARS) fail(400, `"text" can be at most ${MAX_MEMORY_TEXT_CHARS} characters.`)
  return text
}

export function parseCategory(raw: unknown, fallback?: MemoryCategory): MemoryCategory | undefined {
  if (raw === undefined) return fallback
  if (!MEMORY_CATEGORIES.includes(raw as MemoryCategory)) fail(400, `"category" must be one of ${MEMORY_CATEGORIES.join(', ')}.`)
  return raw as MemoryCategory
}

/** Regenerate memory/MEMORY.md for an agent scope (group folders arrive with BE-5). */
export function refreshMemoryFile(store: WorkspaceStore, scope: MemoryScope): void {
  if (scope.kind !== 'agent') return
  const agent = store.agents.find((a) => a.id === scope.agentId)
  if (!agent) return
  try { ensureBotFolder(store, agent) } catch { /* the file catches up on the next change or boot */ }
}

function commit(store: WorkspaceStore, previous: MemoryItem[], scope: MemoryScope): void {
  if (!store.save()) {
    store.memories = previous
    fail(500, 'Memory could not be saved. Please retry.')
  }
  refreshMemoryFile(store, scope)
}

export function addMemory(store: WorkspaceStore, scope: MemoryScope, text: string, category: MemoryCategory, source: MemoryItem['source'], now = new Date()): MemoryItem {
  const existing = scopeItems(store, scope)
  if (existing.length >= MAX_MEMORY_PER_SCOPE) fail(409, `Memory is full (${MAX_MEMORY_PER_SCOPE} items). Delete something first.`)
  const duplicate = existing.find((m) => m.text.toLowerCase() === text.toLowerCase())
  if (duplicate) return duplicate
  const at = now.toISOString()
  const item: MemoryItem = { id: `mem_${randomUUID()}`, scope: structuredClone(scope), text, category, source, createdAt: at, updatedAt: at }
  const previous = store.memories
  store.memories = [...previous, item]
  commit(store, previous, scope)
  return item
}

export function findMemory(store: WorkspaceStore, scope: MemoryScope, id: string): MemoryItem {
  const item = store.memories.find((m) => m.id === id && sameScope(m.scope, scope))
  if (!item) fail(404, `No memory with id "${id}"`)
  return item
}

export function updateMemory(store: WorkspaceStore, scope: MemoryScope, id: string, body: unknown, now = new Date()): MemoryItem {
  const raw = (body ?? {}) as Record<string, unknown>
  if (typeof raw !== 'object' || Array.isArray(raw)) fail(400, 'Send { text?, category? }.')
  const current = findMemory(store, scope, id)
  const text = parseText(raw.text, false)
  const category = parseCategory(raw.category)
  if (text === undefined && category === undefined) return current
  const next: MemoryItem = { ...current, ...(text !== undefined ? { text } : {}), ...(category !== undefined ? { category } : {}), updatedAt: now.toISOString() }
  const previous = store.memories
  store.memories = previous.map((m) => (m.id === id ? next : m))
  commit(store, previous, scope)
  return next
}

export function deleteMemory(store: WorkspaceStore, scope: MemoryScope, id: string): void {
  findMemory(store, scope, id)
  const previous = store.memories
  store.memories = previous.filter((m) => m.id !== id)
  commit(store, previous, scope)
}

export interface MemoryQuery { q?: unknown; category?: unknown; limit?: unknown; offset?: unknown }

function intParam(raw: unknown, name: string, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw === '') return fallback
  const n = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : typeof raw === 'number' && Number.isInteger(raw) ? raw : Number.NaN
  if (!Number.isFinite(n) || n < min || n > max) fail(400, `"${name}" must be a whole number from ${min} to ${max}.`)
  return n
}

/** GET …/memory: { items, total, promptTokens }. total counts the filtered items; promptTokens is the scope's prompt section. */
export function listMemory(store: WorkspaceStore, scope: MemoryScope, query: MemoryQuery): { items: MemoryItem[]; total: number; promptTokens: number } {
  const limit = intParam(query.limit, 'limit', 50, 1, MEMORY_LIST_MAX)
  const offset = intParam(query.offset, 'offset', 0, 0, 1_000_000)
  if (query.q !== undefined && typeof query.q !== 'string') fail(400, '"q" must be a string.')
  const category = query.category === undefined || query.category === '' ? undefined : parseCategory(query.category)
  const needle = typeof query.q === 'string' ? query.q.trim().toLowerCase() : ''
  const all = scopeItems(store, scope).filter((m) => (!category || m.category === category) && (!needle || m.text.toLowerCase().includes(needle)))
  const block = memoryPromptBlock(store, scope)
  return { items: all.slice(offset, offset + limit), total: all.length, promptTokens: block ? estimateTokens(block.length) : 0 }
}

/** recall: items whose text shares words with the query, best match first, then newest. */
export function recallMemory(store: WorkspaceStore, scope: MemoryScope, query: string, limit: number): MemoryItem[] {
  const words = [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1))]
  const items = scopeItems(store, scope)
  if (words.length === 0) return items.slice(0, limit)
  return items
    .map((m, i) => {
      const t = m.text.toLowerCase()
      return { m, i, score: words.reduce((s, w) => s + (t.includes(w) ? 1 : 0), 0) }
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.m)
}
