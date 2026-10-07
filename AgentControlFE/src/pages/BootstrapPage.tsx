import AgentForm from '../components/AgentForm'
import { AgentsIcon } from '../components/icons'
import { ErrorState, Skeleton } from '../components/States'
import { api } from '../lib/api'
import { useAsync } from '../hooks/useAsync'

/**
 * DD-7 bootstrap: when the workspace has no agents, this full-page form
 * creates the Team Lead (POST /api/agents with isPrimary: true) and routes
 * into the new agent's chat. Its endpoint becomes the default for every
 * agent created afterwards.
 */
export default function BootstrapPage() {
  const endpoints = useAsync(api.listEndpoints, [])
  const skills = useAsync(api.listSkills, [])

  const error = endpoints.error ?? skills.error

  if (error) {
    return (
      <main className="page">
        <div className="page__inner page__inner--narrow setup">
          <ErrorState error={error} onRetry={() => void 0} />
        </div>
      </main>
    )
  }

  if (endpoints.loading || skills.loading) {
    return (
      <main className="page">
        <div className="page__inner page__inner--narrow setup">
          <div className="formpage__head">
            <span className="skeleton" style={{ display: 'block', width: 44, height: 44, borderRadius: 15 }} />
            <div style={{ flex: 1, minWidth: 180 }}>
              <Skeleton width="42%" height={20} />
              <div style={{ height: 10 }} />
              <Skeleton width="60%" height={10} />
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

  return (
    <main className="page">
      <div className="page__inner page__inner--narrow setup">
        <div className="formpage__head">
          <span className="detail__icon">
            <AgentsIcon size={22} />
          </span>
          <div>
            <p className="page__eyebrow">Workspace</p>
            <h1 className="detail__name">Set up your Team Lead</h1>
            <p className="page__sub">
              Every agent runs on an endpoint — there is no hosted fallback. Name the lead agent, point it at a
              server, and its endpoint becomes the default for everyone else.
            </p>
          </div>
        </div>

        <AgentForm
          compact
          isBootstrap
          noCancel
          initial={null}
          isEdit={false}
          endpoints={endpoints.data ?? []}
          skills={skills.data ?? []}
        />
      </div>
    </main>
  )
}
