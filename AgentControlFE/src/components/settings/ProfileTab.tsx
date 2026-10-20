import { useCallback, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import AgentProfile from '../AgentProfile'
import { Confirm } from '../Confirm'
import { api } from '../../lib/api'
import { friendlyError as friendly } from '../../lib/chat-format'
import { INTERNET_POLICY_LABELS, agentChatFirstFields, botFolder } from '../../lib/agent-put'
import { useAsync } from '../../hooks/useAsync'
import type { Agent, Endpoint } from '../../lib/types'

type Props = {
  agent: Agent
  endpoints: Endpoint[]
  onSaved: (a: Agent) => void
  onClose: () => void
  onCleared?: () => void
  onDeleted?: () => void
}

/** 03a: the existing profile form (avatar, name, role, description, model, colour, rules, instructions). */
export default function ProfileTab({ agent, endpoints, onSaved, onClose, onCleared, onDeleted }: Props) {
  const navigate = useNavigate()
  const skills = useAsync(api.listSkills, [])
  const [busy, setBusy] = useState<null | 'clear' | 'delete'>(null)
  const [confirm, setConfirm] = useState<null | 'clear' | 'delete'>(null)
  const [error, setError] = useState<string | null>(null)
  const { slug, internetPolicy } = agentChatFirstFields(agent)
  const folder = botFolder(slug)

  const clearChat = useCallback(async () => {
    setBusy('clear')
    setError(null)
    try {
      await api.deleteAgentRuns(agent.id)
      onCleared?.()
      setConfirm(null)
      onClose()
    } catch (err) {
      setError(friendly(err, 'Could not clear the chat history.'))
    } finally {
      setBusy(null)
    }
  }, [agent.id, onClose, onCleared])

  const deleteAgent = useCallback(async () => {
    setBusy('delete')
    setError(null)
    try {
      await api.deleteAgent(agent.id)
      onDeleted?.()
      navigate('/', { replace: true })
    } catch (err) {
      setError(friendly(err, 'Could not delete this bot.'))
      setBusy(null)
    }
  }, [agent.id, navigate, onDeleted])

  return (
    <div className="cf-set__stack cf-set__profile">
      <AgentProfile
        initial={agent}
        isEdit
        compact
        inPanel
        endpoints={endpoints}
        skills={skills.data ?? []}
        onSaved={onSaved}
        onCancel={onClose}
      />

      <section className="cf-card">
        <h3 className="cf-card__title">Folder &amp; access</h3>
        <dl className="cf-kv">
          <dt>Private folder</dt>
          <dd>
            {folder ? <code>{folder}</code> : 'Not reported by this server yet'}
            <span className="cf-kv__note">Set when the bot is created; it can't be renamed.</span>
          </dd>
          <dt>Internet for scripts</dt>
          <dd>
            {INTERNET_POLICY_LABELS[internetPolicy]}
            <span className="cf-kv__note">Change it in the Sandbox tab (FE-4).</span>
          </dd>
        </dl>
      </section>

      <section className="cf-card cf-danger">
        <div className="cf-danger__row">
          <div>
            <p className="row__label">Clear chat history</p>
            <p className="row__hint">Empties this bot&apos;s transcript. Prior turns stop feeding context.</p>
          </div>
          <button type="button" className="btn" onClick={() => setConfirm('clear')} disabled={busy !== null}>
            Clear…
          </button>
        </div>
        {!agent.isPrimary && (
          <div className="cf-danger__row">
            <div>
              <p className="row__label">Delete bot</p>
              <p className="row__hint">Removes the bot and its run history. Cannot be undone.</p>
            </div>
            <button type="button" className="btn btn--danger" onClick={() => setConfirm('delete')} disabled={busy !== null}>
              Delete…
            </button>
          </div>
        )}
      </section>

      <Confirm
        open={confirm === 'clear'}
        title="Clear chat history?"
        subtitle={`This empties ${agent.name}'s transcript. It cannot be undone.`}
        confirmLabel="Clear history"
        loading={busy === 'clear'}
        onCancel={() => setConfirm(null)}
        onConfirm={() => void clearChat()}
      >
        <p className="prose">The bot keeps its settings, memory and skills; only the conversation is removed.</p>
        {error && <p className="field__err" role="alert">{error}</p>}
      </Confirm>
      {!agent.isPrimary && (
        <Confirm
          open={confirm === 'delete'}
          title={`Delete ${agent.name}?`}
          subtitle="This removes the bot and its run history. It cannot be undone."
          confirmLabel="Delete bot"
          loading={busy === 'delete'}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void deleteAgent()}
        >
          {error && <p className="field__err" role="alert">{error}</p>}
        </Confirm>
      )}
    </div>
  )
}
