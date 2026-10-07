import { useCallback } from 'react'
import { Link, useParams } from 'react-router-dom'
import { AgentsIcon, ChevronLeftIcon } from '../components/icons'
import { ErrorState, Skeleton } from '../components/States'
import { api } from '../lib/api'
import AgentForm from '../components/AgentForm'
import { useAsync } from '../hooks/useAsync'

export default function AgentFormPage() {
  const { id } = useParams()
  const isEdit = id !== undefined

  const loadAgent = useCallback(() => (isEdit && id ? api.getAgent(id) : Promise.resolve(null)), [id, isEdit])
  const agents = useAsync(api.listAgents, [])
  const endpoints = useAsync(api.listEndpoints, [])
  const skills = useAsync(api.listSkills, [])
  const agent = useAsync(loadAgent, [id ?? ''])

  // DD-7: new agents preselect the Team Lead's endpoint as the default.
  const primary = (agents.data ?? []).find((a) => a.isPrimary)
  const defaultEndpointId = isEdit ? null : (primary?.endpointId ?? null)

  const error = agents.error ?? endpoints.error ?? skills.error ?? agent.error

  if (!error && (agents.loading || endpoints.loading || skills.loading || agent.loading)) {
    return (
      <main className="page">
        <div className="page__inner page__inner--narrow">
          <div className="formpage__head">
            <span className="skeleton" style={{ display: 'block', width: 44, height: 44, borderRadius: 15 }} />
            <div style={{ flex: 1, minWidth: 180 }}>
              <Skeleton width="38%" height={20} />
              <div style={{ height: 10 }} />
              <Skeleton width="66%" height={10} />
            </div>
          </div>
          <div className="formcard">
            {[0, 1, 2].map((i) => (
              <div className="formsection" key={i}>
                <Skeleton width="22%" height={12} />
                <div style={{ height: 16 }} />
                <Skeleton height={38} />
              </div>
            ))}
          </div>
        </div>
      </main>
    )
  }

  if (error) {
    return (
      <main className="page">
        <div className="page__inner page__inner--narrow">
          <ErrorState error={error} onRetry={() => void 0} />
        </div>
      </main>
    )
  }

  if (isEdit && !agent.data) {
    return (
      <main className="page">
        <div className="page__inner page__inner--narrow">
          <ErrorState title="Agent not found" error={new Error('This agent may have been deleted.')} />
        </div>
      </main>
    )
  }

  return (
    <main className="page">
      <div className="page__inner page__inner--narrow">
        {isEdit && agent.data && (
          <Link to={`/agents/${agent.data.id}`} className="detail__back">
            <ChevronLeftIcon size={14} />
            Back to agent
          </Link>
        )}
        {!isEdit && (
          <Link to="/agents" className="detail__back">
            <ChevronLeftIcon size={14} />
            Back to agents
          </Link>
        )}

        <div className="formpage__head">
          <span className="detail__icon">
            <AgentsIcon size={22} />
          </span>
          <div>
            <p className="page__eyebrow">{isEdit ? 'Agents' : 'New'}</p>
            <h1 className="detail__name">{isEdit ? 'Edit agent' : 'New agent'}</h1>
            <p className="page__sub">
              {isEdit
                ? 'Changes take effect on the next run. In-flight runs keep the old configuration.'
                : 'Name it, pick an endpoint and model, and give it the skills it needs.'}
            </p>
          </div>
        </div>

        <AgentForm
          key={id ?? 'new'}
          compact
          initial={agent.data ?? null}
          isEdit={isEdit}
          endpoints={endpoints.data ?? []}
          skills={skills.data ?? []}
          defaultEndpointId={defaultEndpointId}
        />
      </div>
    </main>
  )
}
