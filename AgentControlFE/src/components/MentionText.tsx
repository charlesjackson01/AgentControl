import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { mentionOrder, mentionSpans, mentionTone, type MentionAgent } from '../lib/mentions'

/* ==========================================================================
   @Name chips (D-O11). A MentionProvider holds the agents a chat can tag, in
   preference order (Primary, the team, the library); MentionText shows a
   message's tags as chips, and AgentTag shows one agent as a chip (task
   routes, plan rows). Text around the chips renders as it did before, so
   line breaks still come from the container's `white-space: pre-wrap`.
   ========================================================================== */

type Directory = {
  /** Taggable agents in preference order. */
  agents: readonly MentionAgent[]
  byId: ReadonlyMap<string, MentionAgent>
  primaryId: string | undefined
}

const MentionContext = createContext<Directory>({ agents: [], byId: new Map(), primaryId: undefined })

export function MentionProvider({
  agents,
  primaryId,
  teamAgentIds,
  children,
}: {
  agents: readonly MentionAgent[]
  primaryId: string | undefined
  teamAgentIds: readonly string[]
  children: ReactNode
}) {
  const value = useMemo<Directory>(() => {
    const ordered = mentionOrder(agents, primaryId, teamAgentIds).map((a) => ({ id: a.id, name: a.name, role: a.role }))
    return { agents: ordered, byId: new Map(ordered.map((a) => [a.id, a])), primaryId }
  }, [agents, primaryId, teamAgentIds])
  return <MentionContext.Provider value={value}>{children}</MentionContext.Provider>
}

/** The chip itself: "@Name" in the agent's colour (the lead in the accent), its role on hover. */
export function Chip({
  name,
  role,
  tone,
  lead = false,
  title,
}: {
  name: string
  role?: string
  /** Colour index from mentionTone; omitted for an agent that has no id yet. */
  tone?: number
  lead?: boolean
  title?: string
}) {
  const cls = lead ? ' mention--lead' : tone === undefined ? ' mention--new' : ` mention--tone-${tone}`
  return (
    <span className={`mention${cls}`} title={title ?? (role || undefined)}>
      @{name.trim()}
    </span>
  )
}

/** One agent as an @Name chip; "You" for the user; plain words for an id no longer in the library. */
export function AgentTag({ id }: { id: string | undefined }) {
  const { byId, primaryId } = useContext(MentionContext)
  if (id === 'user') return <span className="mention-you">You</span>
  const agent = id ? byId.get(id) : undefined
  if (!agent) return <span className="mention-gone">{id ? 'Removed agent' : 'Unassigned'}</span>
  return <Chip name={agent.name} role={agent.role} tone={mentionTone(agent.id)} lead={agent.id === primaryId} />
}

/**
 * Text with its @mentions as chips. `mentions` are the ids a stored message
 * tags (the BE resolved them; a message without any shows no chips).
 * `resolveAll` is for text that is not stored yet (a plan card): every agent
 * the chat knows can match.
 */
export function MentionText({
  text,
  mentions,
  resolveAll = false,
}: {
  text: string
  mentions?: readonly string[]
  resolveAll?: boolean
}) {
  const { agents, byId, primaryId } = useContext(MentionContext)
  const spans = useMemo(() => {
    if (!resolveAll && (!mentions || mentions.length === 0)) return []
    return mentionSpans(text, agents, resolveAll ? undefined : mentions)
  }, [text, agents, mentions, resolveAll])
  if (spans.length === 0) return <>{text}</>

  const parts: ReactNode[] = []
  let at = 0
  for (const span of spans) {
    if (span.start > at) parts.push(text.slice(at, span.start))
    const agent = byId.get(span.id)
    parts.push(
      agent ? (
        <Chip key={span.start} name={agent.name} role={agent.role} tone={mentionTone(agent.id)} lead={agent.id === primaryId} />
      ) : (
        text.slice(span.start, span.end)
      ),
    )
    at = span.end
  }
  if (at < text.length) parts.push(text.slice(at))
  return <>{parts}</>
}
