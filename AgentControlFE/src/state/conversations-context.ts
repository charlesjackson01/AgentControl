import { createContext, useContext } from 'react'
import type { Agent, Conversation, Project } from '../lib/types'

export type ConversationsState = {
  conversations: Conversation[] | undefined
  agents: Agent[]
  projects: Project[]
  error: Error | undefined
  /** True once the first conversations request has settled (ok or error). */
  loaded: boolean
  reload: () => void
  /** Optimistically zero a row's unread badge and tell the BE (fire-and-forget). */
  markRead: (id: string) => void
  /** Replace a row with the server's copy (e.g. from a send result). */
  upsert: (c: Conversation) => void
}

export const ConversationsContext = createContext<ConversationsState | null>(null)

export function useConversations(): ConversationsState {
  const ctx = useContext(ConversationsContext)
  if (!ctx) throw new Error('useConversations must be used inside <ConversationsProvider>')
  return ctx
}
