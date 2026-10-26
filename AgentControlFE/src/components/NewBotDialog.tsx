import { useNavigate } from 'react-router-dom'
import Dialog from './Dialog'
import AgentProfile, { type AgentPrefill } from './AgentProfile'
import { ErrorState, Skeleton } from './States'
import { api } from '../lib/api'
import { useAsync } from '../hooks/useAsync'
import { useConversations } from '../state/conversations-context'

/**
 * The full New bot form. FE-5: "Open full settings" / "＋ Browse" on the /new draft card open it
 * prefilled from the card; it is also the fallback when there is no Primary chat to draft in.
 */
export default function NewBotDialog({ open, onClose, prefill }: { open: boolean; onClose: () => void; prefill?: AgentPrefill }) {
  if (!open) return null
  return <NewBotBody onClose={onClose} prefill={prefill} />
}

function NewBotBody({ onClose, prefill }: { onClose: () => void; prefill?: AgentPrefill }) {
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
          prefill={prefill}
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
