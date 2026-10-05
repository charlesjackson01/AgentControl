import { useCallback, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import Dialog from '../components/Dialog'
import { StatusPill } from '../components/StatusPill'
import { ErrorState, Skeleton } from '../components/States'
import { AgentsIcon } from '../components/icons'
import { api, TIER_LABELS } from '../lib/api'
import type { AgentRun, RunStatus } from '../lib/types'
import { useAsync } from '../hooks/useAsync'

const RUN_LABELS: Record<RunStatus, string> = {
  succeeded: 'Succeeded',
  failed: 'Failed',
  running: 'Running',
}

const RUN_DOT: Record<RunStatus, string> = {
  succeeded: '',
  failed: ' dot--danger',
  running: ' dot--warn',
}

function formatDuration(ms: number): string {
  if (ms === 0) return '—'
  if (ms < 1000) return `${ms}ms`
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function formatWhen(iso: string): string {
  const date = new Date(iso)
  const diff = Date.now() - date.getTime()
  const mins = Math.round(diff / 60_000)
  if (mins < 60) return `${Math.max(mins, 0)}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function RunRow({ run }: { run: AgentRun }) {
  return (
    <div className="run">
      <span className={`dot${RUN_DOT[run.status]}`} />
      <div style={{ minWidth: 0 }}>
        <p className="run__when">{formatWhen(run.startedAt)}</p>
        <p className="run__meta">
          {RUN_LABELS[run.status]} · {run.steps} {run.steps === 1 ? 'step' : 'steps'}
        </p>
        {run.error && <p className="run__error">{run.error}</p>}
      </div>
      <span className="run__right">{formatDuration(run.durationMs)}</span>
    </div>
  )
}

export default function AgentDetail() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [runInput, setRunInput] = useState('')
  const [running, setRunning] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const [lastRun, setLastRun] = useState<AgentRun | null>(null)

  const loadAgent = useCallback(() => api.getAgent(id), [id])
  const agent = useAsync(loadAgent, [id])
  const loadRuns = useCallback(() => api.listAgentRuns(id), [id])
  const runs = useAsync(loadRuns, [id])
  const models = useAsync(api.listModels, [])
  const endpoints = useAsync(api.listEndpoints, [])
  const skills = useAsync(api.listSkills, [])

  const model = (models.data ?? []).find((m) => m.id === agent.data?.modelId)
  const endpoint = agent.data?.endpointId
    ? (endpoints.data ?? []).find((e) => e.id === agent.data?.endpointId)
    : null
  const attached = (skills.data ?? []).filter((s) => agent.data?.skillIds.includes(s.id))

  const onDelete = async () => {
    setDeleting(true)
    try {
      await api.deleteAgent(id)
      navigate('/agents', { replace: true })
    } catch (err) {
      setDeleting(false)
      setConfirmingDelete(false)
      throw err
    }
  }

  const onRun = async () => {
    const input = runInput.trim()
    if (!input || running) return
    setRunning(true)
    setRunError(null)
    setLastRun(null)
    try {
      const result = await api.runAgent(id, input)
      setLastRun(result)
      runs.reload()
    } catch (err) {
      setRunError(err instanceof Error ? err.message : 'Run failed.')
    } finally {
      setRunning(false)
    }
  }

  return (
    <main className="page">
      <div className="page__inner">
        <Link to="/agents" className="detail__back">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m14 6-6 6 6 6" />
          </svg>
          Agents
        </Link>

        {agent.loading ? (
          <>
            <div className="detail__head">
              <span className="skeleton" style={{ display: 'block', width: 44, height: 44, borderRadius: 15 }} />
              <div style={{ flex: 1, minWidth: 180 }}>
                <Skeleton width="42%" height={20} />
                <div style={{ height: 10 }} />
                <Skeleton width="62%" height={10} />
              </div>
            </div>
            <div className="card" style={{ padding: 18, marginTop: 22 }}>
              <Skeleton height={11} />
              <div style={{ height: 9 }} />
              <Skeleton width="80%" height={11} />
            </div>
          </>
        ) : agent.error ? (
          <ErrorState
            title={agent.error.message.includes('404') || agent.error.name === 'ApiError' ? 'Agent not found' : 'Could not load this agent'}
            error={
              agent.error.name === 'ApiError' && agent.error.message.includes('404')
                ? new Error('This agent may have been deleted.')
                : agent.error
            }
            onRetry={agent.reload}
          />
        ) : agent.data ? (
          <>
            <div className="detail__head">
              <span className="detail__icon">
                <AgentsIcon size={22} />
              </span>
              <div style={{ minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <h1 className="detail__name">{agent.data.name}</h1>
                  <StatusPill status={agent.data.status} />
                </div>
                <p className="page__sub" style={{ marginTop: 4 }}>
                  {agent.data.description || 'No description yet.'}
                </p>
              </div>
              <div className="detail__actions">
                <Link to={`/agents/${agent.data.id}/edit`} className="btn">
                  Edit
                </Link>
                <button type="button" className="btn btn--danger" onClick={() => setConfirmingDelete(true)}>
                  Delete
                </button>
              </div>
            </div>

            <section className="section">
              <div className="section__head">
                <h2 className="section__title">Configuration</h2>
              </div>
              <div className="card" style={{ padding: 18 }}>
                <div className="meta">
                  <div>
                    <p className="meta__k">Model</p>
                    {agent.data.endpointId ? (
                      <>
                        <p className="meta__v">{agent.data.modelId} · Custom</p>
                        <p className="field__hint">{endpoint ? `${endpoint.name} · ${endpoint.baseUrl}` : 'Custom endpoint (deleted?)'}</p>
                      </>
                    ) : (
                      <>
                        <p className="meta__v">{model ? `${model.name} · ${TIER_LABELS[model.tier]}` : 'Unknown model'}</p>
                        <p className="field__hint">{model ? `${model.provider} · ${model.contextWindow.toLocaleString()} ctx` : ''}</p>
                      </>
                    )}
                  </div>
                  <div>
                    <p className="meta__k">Skills</p>
                    <p className="meta__v">{attached.length} attached</p>
                    <p className="field__hint">{attached.map((s) => s.name).join(', ') || 'None'}</p>
                  </div>
                  <div>
                    <p className="meta__k">Runs</p>
                    <p className="meta__v">{agent.data.runCount.toLocaleString()}</p>
                    <p className="field__hint">
                      Last run {agent.data.lastRunAt ? formatWhen(agent.data.lastRunAt) : 'never'}
                    </p>
                  </div>
                  <div>
                    <p className="meta__k">Created</p>
                    <p className="meta__v">{new Date(agent.data.createdAt).toLocaleDateString()}</p>
                    <p className="field__hint meta__v--mono">{agent.data.id}</p>
                  </div>
                </div>
              </div>
            </section>

            <section className="section">
              <div className="section__head">
                <h2 className="section__title">Instructions</h2>
              </div>
              <div className="card" style={{ padding: 18 }}>
                {agent.data.instructions ? (
                  <p className="prose">{agent.data.instructions}</p>
                ) : (
                  <p className="field__hint">No instructions set. This agent runs on defaults until you add some.</p>
                )}
              </div>
            </section>

            <section className="section">
              <div className="section__head">
                <h2 className="section__title">Run</h2>
              </div>
              <div className="card" style={{ padding: 18 }}>
                <div className="field">
                  <textarea
                    id="ad-run-input"
                    className="textarea"
                    value={runInput}
                    onChange={(e) => setRunInput(e.target.value)}
                    placeholder="What should this agent do?"
                    rows={4}
                    aria-label="Run input"
                    disabled={running}
                  />
                </div>
                <div className="formactions">
                  <button
                    type="button"
                    className="btn btn--primary"
                    disabled={running || !runInput.trim()}
                    onClick={() => void onRun()}
                  >
                    {running && <span className="spinner" aria-hidden="true" />}
                    {running ? 'Running…' : 'Run'}
                  </button>
                </div>
                {runError && (
                  <p className="field__err" role="alert" style={{ marginTop: 10, overflowWrap: 'anywhere' }}>
                    {runError}
                  </p>
                )}
                {lastRun && (
                  <div className="card" style={{ padding: 16, marginTop: 12, background: 'var(--c-surface-2)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                      <span className={`status${lastRun.status === 'succeeded' ? ' status--running' : ' status--error'}`}>
                        {RUN_LABELS[lastRun.status]}
                      </span>
                      <span className="run__meta">{formatDuration(lastRun.durationMs)}</span>
                    </div>
                    {lastRun.error ? (
                      <p className="field__err" style={{ marginTop: 10, overflowWrap: 'anywhere' }}>
                        {lastRun.error}
                      </p>
                    ) : (
                      <p className="prose" style={{ marginTop: 10 }}>
                        {lastRun.output || 'No output returned.'}
                      </p>
                    )}
                  </div>
                )}
              </div>
            </section>

            <section className="section">
              <div className="section__head">
                <h2 className="section__title">Recent runs</h2>
              </div>
              {runs.loading ? (
                <div className="card" style={{ padding: 18 }}>
                  <Skeleton height={11} />
                  <div style={{ height: 9 }} />
                  <Skeleton width="70%" height={11} />
                </div>
              ) : runs.error ? (
                <ErrorState error={runs.error} onRetry={runs.reload} />
              ) : (runs.data ?? []).length === 0 ? (
                <div className="card" style={{ padding: '18px 16px' }}>
                  <p className="field__hint">This agent hasn’t run yet.</p>
                </div>
              ) : (
                <div className="rows">
                  {(runs.data ?? []).map((r) => (
                    <RunRow key={r.id} run={r} />
                  ))}
                </div>
              )}
            </section>

            <Dialog
              open={confirmingDelete}
              size="sm"
              title={`Delete ${agent.data.name}?`}
              subtitle="This removes the agent and its run history. It cannot be undone."
              onClose={() => setConfirmingDelete(false)}
              footer={
                <>
                  <button type="button" className="btn" onClick={() => setConfirmingDelete(false)} disabled={deleting}>
                    Cancel
                  </button>
                  <button type="button" className="btn btn--danger" onClick={() => void onDelete()} disabled={deleting}>
                    {deleting && <span className="spinner" aria-hidden="true" />}
                    {deleting ? 'Deleting…' : 'Delete agent'}
                  </button>
                </>
              }
            >
              <p className="prose">
                If other agents depend on this one’s skills, they keep working — skills are shared, not owned.
              </p>
            </Dialog>
          </>
        ) : null}
      </div>
    </main>
  )
}