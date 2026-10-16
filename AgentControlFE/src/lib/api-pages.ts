import type { ChatMessage, ChatMessagePage } from './types.ts'

/** Accept either a bare array or { messages, hasMore }; always return oldest-first. */
export function normalizeMessagePage(body: ChatMessage[] | { messages: ChatMessage[]; hasMore?: boolean }, limit: number): ChatMessagePage {
  const list = Array.isArray(body) ? body : body.messages
  const messages = [...list].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  const hasMore = Array.isArray(body) ? list.length >= limit : Boolean(body.hasMore)
  return { messages, hasMore }
}

