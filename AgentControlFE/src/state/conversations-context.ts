import { createContext, useContext } from 'react'
import type { Agent, ConversationSummary } from '../lib/types'

export type ConversationsState = {
  conversations: ConversationSummary[] | undefined
  agents: Agent[]
  error: Error | undefined
  /** True once the first conversations request has settled (ok or error). */
  loaded: boolean
  reload: () => void
  /** Optimistically zero a row's unread badge, then take the BE's summary. */
  markRead: (id: string) => void
  /** Replace a row with the server's copy. */
  upsert: (c: ConversationSummary) => void
}

export const ConversationsContext = createContext<ConversationsState | null>(null)

export function useConversations(): ConversationsState {
  const ctx = useContext(ConversationsContext)
  if (!ctx) throw new Error('useConversations must be used inside <ConversationsProvider>')
  return ctx
}
