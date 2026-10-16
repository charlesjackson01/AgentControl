import { Navigate } from 'react-router-dom'
import { Skeleton } from '../components/States'
import { primaryConversation } from '../lib/conversations'
import { useConversations } from '../state/conversations-context'

/** D-C1: land on Primary's 1:1. Falls back to the old agent chat, then /agents. */
export default function Landing() {
  const { conversations, agents, loaded } = useConversations()
  if (!loaded) {
    return (
      <main className="page">
        <div className="page__inner">
          <Skeleton height={14} width="30%" />
        </div>
      </main>
    )
  }
  const dm = primaryConversation(conversations ?? [], agents)
  if (dm) return <Navigate to={`/c/${dm.id}`} replace />
  const primary = agents.find((a) => a.isPrimary)
  return <Navigate to={primary ? `/agents/${primary.id}` : '/agents'} replace />
}
