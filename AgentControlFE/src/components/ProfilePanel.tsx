import { useCallback, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Dialog from './Dialog'
import { Confirm } from './Confirm'
import AgentProfile from './AgentProfile'
import { api } from '../lib/api'
import type { Agent, Endpoint, Skill } from '../lib/types'

type ProfilePanelProps = {
  open: boolean
  agent: Agent | null
  endpoints: Endpoint[]
  skills: Skill[]
  onClose: () => void
  /** After a successful save so the chat header can refresh. */
  onSaved?: () => void
  /** After chat history is cleared so the thread empties. */
  onCleared?: () => void
}

function friendly(err: unknown, fallback: string): string {
  const msg = err instanceof Error ? err.message : fallback
  return msg === 'Failed to fetch' || msg === 'fetch failed'
    ? 'Could not reach the API server. Is the backend running?'
    : msg
}

/** The agent profile panel (chat-first Part 1): replaces the old settings drawer. */
export function ProfilePanel({ open, agent, endpoints, skills, onClose, onSaved, onCleared }: ProfilePanelProps) {
  const navigate = useNavigate()
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [clearError, setClearError] = useState<string | null>(null)
  const [confirmingClear, setConfirmingClear] = useState(false)

  const onDelete = useCallback(async () => {
    if (!agent || deleting) return
    setDeleteError(null)
    setDeleting(true)
    try {
      await api.deleteAgent(agent.id)
      navigate('/agents', { replace: true })
    } catch (err) {
      setDeleteError(friendly(err, 'Could not delete this agent.'))
      setDeleting(false)
    }
  }, [agent, deleting, navigate])

  const handleClearChat = useCallback(async () => {
    if (!agent || clearing) return
    setClearError(null)
    setClearing(true)
    try {
      await api.deleteAgentRuns(agent.id)
      onCleared?.()
      setConfirmingClear(false)
      onClose()
    } catch (err) {
      setClearError(friendly(err, 'Could not clear the chat history.'))
    } finally {
      setClearing(false)
    }
  }, [agent, clearing, onClose, onCleared])

  if (!open || !agent) return null

  return (
    <Dialog
      open={open}
      title={agent.name}
      subtitle="Profile · changes take effect on the next run."
      onClose={onClose}
      size="md"
      footer={
        <button type="button" className="btn" onClick={onClose} disabled={deleting || clearing}>
          Close
        </button>
      }
    >
      <AgentProfile
        key={agent.id}
        initial={agent}
        isEdit
        compact
        endpoints={endpoints}
        skills={skills}
        onSaved={() => {
          onSaved?.()
          onClose()
        }}
        onCancel={onClose}
      />

      <div className="drawer__danger">
        <div className="drawer__danger__row">
          <div>
            <p className="row__label">Clear chat history</p>
            <p className="row__hint">Empties this agent's transcript. Prior turns stop feeding context.</p>
          </div>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setClearError(null)
              setConfirmingClear(true)
            }}
            disabled={deleting || clearing}
          >
            Clear…
          </button>
        </div>
        {!agent.isPrimary && (
          <div className="drawer__danger__row">
            <div>
              <p className="row__label">Delete agent</p>
              <p className="row__hint">Removes the agent and its run history. Cannot be undone.</p>
            </div>
            <button
              type="button"
              className="btn btn--danger"
              onClick={() => {
                setDeleteError(null)
                setConfirmingDelete(true)
              }}
              disabled={deleting || clearing}
            >
              Delete…
            </button>
          </div>
        )}
      </div>

      <Confirm
        open={confirmingClear}
        title="Clear chat history?"
        subtitle={`This empties ${agent.name}'s transcript. It cannot be undone.`}
        confirmLabel="Clear history"
        loading={clearing}
        onCancel={() => setConfirmingClear(false)}
        onConfirm={() => void handleClearChat()}
      >
        <p className="prose">The agent keeps its configuration and skills — only the conversation is removed.</p>
        {clearError && (
          <p className="field__err" role="alert" style={{ marginTop: 10, overflowWrap: 'anywhere' }}>
            {clearError}
          </p>
        )}
      </Confirm>

      {!agent.isPrimary && (
        <Confirm
          open={confirmingDelete}
          title={`Delete ${agent.name}?`}
          subtitle="This removes the agent and its run history. It cannot be undone."
          confirmLabel="Delete agent"
          loading={deleting}
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() => void onDelete()}
        >
          <p className="prose">
            If other agents depend on this one's skills, they keep working — skills are shared, not owned.
          </p>
          {deleteError && (
            <p className="field__err" role="alert" style={{ marginTop: 10, overflowWrap: 'anywhere' }}>
              {deleteError}
            </p>
          )}
        </Confirm>
      )}
    </Dialog>
  )
}
