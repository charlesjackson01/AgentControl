import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api } from '../lib/api'
import { markReadLocally, upsertConversation } from '../lib/conversations'
import type { Agent, ConversationSummary } from '../lib/types'
import { ConversationsContext, type ConversationsState } from './conversations-context'

/** Sidebar refresh cadence; a visible tab only. */
const POLL_MS = 15_000

/** Loads conversations + the agents/projects they reference, shared by the sidebar, landing and thread. */
export default function ConversationsProvider({ children }: { children: ReactNode }) {
  const [conversations, setConversations] = useState<ConversationSummary[] | undefined>(undefined)
  const [agents, setAgents] = useState<Agent[]>([])
  const [error, setError] = useState<Error | undefined>(undefined)
  const [loaded, setLoaded] = useState(false)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let active = true
    // Agents load on their own so the landing fallback still works if conversations fail.
    Promise.all([
      api.listConversations().then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e })),
      api.listAgents().catch(() => null),
    ]).then(([convs, ags]) => {
      if (!active) return
      if (ags) setAgents(ags)
      if (convs.ok) {
        setConversations(convs.v)
        setError(undefined)
      } else {
        setError(convs.e instanceof Error ? convs.e : new Error(String(convs.e)))
      }
      setLoaded(true)
    })
    return () => {
      active = false
    }
  }, [tick])

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') setTick((n) => n + 1)
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [])

  const reload = useCallback(() => setTick((n) => n + 1), [])
  const markRead = useCallback((id: string) => {
    setConversations((list) => (list ? markReadLocally(list, id) : list))
    api.markConversationRead(id).then(
      (summary) => setConversations((list) => upsertConversation(list ?? [], summary)),
      () => {
        // The next poll restores the server's count; nothing to show the user.
      },
    )
  }, [])
  const upsert = useCallback((c: ConversationSummary) => {
    setConversations((list) => upsertConversation(list ?? [], c))
  }, [])

  const value = useMemo<ConversationsState>(
    () => ({ conversations, agents, error, loaded, reload, markRead, upsert }),
    [conversations, agents, error, loaded, reload, markRead, upsert],
  )
  return <ConversationsContext.Provider value={value}>{children}</ConversationsContext.Provider>
}
