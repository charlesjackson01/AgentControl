import { useNavigate } from 'react-router-dom'
import Dialog from './Dialog'
import AgentProfile from './AgentProfile'
import { ErrorState, Skeleton } from './States'
import { api } from '../lib/api'
import { useAsync } from '../hooks/useAsync'
import { useConversations } from '../state/conversations-context'

/**
 * Interim "New bot" (keeps today's create form reachable after FE-1 removed
 * /agents/new). FE-5 replaces it with the /new draft card in chat.
 */
export default function NewBotDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null
  return <NewBotBody onClose={onClose} />
}

function NewBotBody({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate()
  const { agents, reload } = useConversations()
  const endpoints = useAsync(api.listEndpoints, [])
  const skills = useAsync(api.listSkills, [])
  const error = endpoints.error ?? skills.error
  const lead = agents.find((a) => a.isPrimary)

  return (
    <Dialog open title="New bot" subtitle="It gets its own chat." onClose={onClose}>
      {error ? (
        <ErrorState error={error} onRetry={() => void 0} />
      ) : endpoints.loading || skills.loading ? (
        <Skeleton height={38} />
      ) : (
        <AgentProfile
          compact
          initial={null}
          isEdit={false}
          endpoints={endpoints.data ?? []}
          skills={skills.data ?? []}
          defaultEndpointId={lead?.endpointId ?? null}
          onSaved={(saved) => {
            reload()
            onClose()
            navigate(`/agents/${saved.id}`, { replace: false })
          }}
          onCancel={onClose}
        />
      )}
    </Dialog>
  )
}
