import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api } from '../lib/api'
import { markReadLocally, upsertConversation } from '../lib/conversations'
import { noteTyping, noteTypingFor } from '../lib/thread'
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
  const [typingSince, setTypingSince] = useState<Record<string, string>>({})
  const typingIds = useRef<Set<string>>(new Set())

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
        const seen = noteTyping(convs.v, typingIds.current, new Date().toISOString())
        typingIds.current = seen.typing
        if (seen.started.length) setTypingSince((prev) => ({ ...prev, ...Object.fromEntries(seen.started.map((id) => [id, seen.at])) }))
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
    // BE-10: a thread's first page can report typing before the sidebar poll does; start its clock now.
    const seen = noteTypingFor(c, typingIds.current, new Date().toISOString())
    typingIds.current = seen.typing
    if (seen.started.length) setTypingSince((prev) => ({ ...prev, [c.id]: seen.at }))
    setConversations((list) => upsertConversation(list ?? [], c))
  }, [])

  const value = useMemo<ConversationsState>(
    () => ({ conversations, agents, error, loaded, reload, markRead, upsert, typingSince }),
    [conversations, agents, error, loaded, reload, markRead, upsert, typingSince],
  )
  return <ConversationsContext.Provider value={value}>{children}</ConversationsContext.Provider>
}
