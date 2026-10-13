import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import PageShell from '../components/PageShell'
import { StatusPill } from '../components/StatusPill'
import { EmptyState, ErrorState, Skeleton } from '../components/States'
import { AgentsIcon, PlusIcon, SearchIcon } from '../components/icons'
import { api } from '../lib/api'
import type { AgentStatus } from '../lib/types'
import BootstrapPage from './BootstrapPage'
import { useAsync } from '../hooks/useAsync'

type Filter = AgentStatus | 'all'
type Sort = 'recent' | 'name' | 'runs'

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'running', label: 'Running' },
  { value: 'idle', label: 'Idle' },
  { value: 'queued', label: 'Queued' },
  { value: 'error', label: 'Error' },
]

const SORTS: { value: Sort; label: string }[] = [
  { value: 'recent', label: 'Last run' },
  { value: 'name', label: 'Name' },
  { value: 'runs', label: 'Most runs' },
]

function relativeTime(iso: string | null): string {
  if (!iso) return 'Never run'
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.round(diff / 60_000)
  if (mins < 1) return 'Just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return `${days}d ago`
}

export default function Agents() {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [sort, setSort] = useState<Sort>('recent')

  const agents = useAsync(api.listAgents, [])
  const endpoints = useAsync(api.listEndpoints, [])
  // Names for the project tag on project-scoped specialists (D-P2).
  const projects = useAsync(api.listProjects, [])

  const endpointById = useMemo(() => new Map((endpoints.data ?? []).map((e) => [e.id, e])), [endpoints.data])
  const projectNameById = useMemo(() => new Map((projects.data ?? []).map((p) => [p.id, p.name])), [projects.data])

  const displayModel = useMemo(() => {
    return (a: { modelId: string; endpointId: string }) => {
      const ep = endpointById.get(a.endpointId)
      return `${a.modelId} · ${ep ? ep.name : 'Custom endpoint'}`
    }
  }, [endpointById])

  const counts = useMemo(() => {
    const base: Record<Filter, number> = { all: 0, running: 0, idle: 0, queued: 0, error: 0 }
    for (const a of agents.data ?? []) {
      base.all += 1
      base[a.status] += 1
    }
    return base
  }, [agents.data])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = (agents.data ?? []).filter((a) => {
      if (filter !== 'all' && a.status !== filter) return false
      if (!q) return true
      return (
        a.name.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q) ||
        displayModel(a).toLowerCase().includes(q)
      )
    })

    return list.sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name)
      if (sort === 'runs') return b.runCount - a.runCount
      const at = a.lastRunAt ? new Date(a.lastRunAt).getTime() : -1
      const bt = b.lastRunAt ? new Date(b.lastRunAt).getTime() : -1
      return bt - at
    })
  }, [agents.data, query, filter, sort, displayModel])

  return (
    <PageShell
      eyebrow="Workspace"
      title="Agents"
      subtitle="Every autonomous worker in this workspace, with live status and recent activity."
      actions={
        // Hidden until onboarding has created the Team Lead.
        agents.data !== undefined && agents.data.length === 0 ? undefined : (
          <Link to="/agents/new" className="btn btn--primary">
            <PlusIcon size={16} />
            New Agent
          </Link>
        )
      }
    >
      <div className="toolbar">
        <div className="search">
          <span className="search__icon">
            <SearchIcon size={15} />
          </span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search agents or models…"
            aria-label="Search agents"
            type="search"
          />
          {query && (
            <button type="button" className="search__clear" onClick={() => setQuery('')} aria-label="Clear search">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
          )}
        </div>

        <div className="filters" role="group" aria-label="Filter by status">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              className={`filter${filter === f.value ? ' filter--on' : ''}`}
              onClick={() => setFilter(f.value)}
              aria-pressed={filter === f.value}
            >
              {f.label}
              <span className="filter__n">{counts[f.value]}</span>
            </button>
          ))}
        </div>

        <select
          className="select toolbar__sort"
          value={sort}
          onChange={(e) => setSort(e.target.value as Sort)}
          aria-label="Sort agents"
        >
          {SORTS.map((s) => (
            <option key={s.value} value={s.value}>
              Sort: {s.label}
            </option>
          ))}
        </select>
      </div>

      {agents.data !== undefined && agents.data.length === 0 ? (
        /* DD-7 bootstrap: an empty workspace has no Team Lead yet. */
        <BootstrapPage />
      ) : agents.loading ? (
        <div className="grid">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div className="skel-card" key={i}>
              <Skeleton width={i % 2 ? '58%' : '72%'} height={13} />
              <Skeleton height={9} />
              <Skeleton width="40%" height={9} />
            </div>
          ))}
        </div>
      ) : agents.error ? (
        <ErrorState error={agents.error} onRetry={agents.reload} />
      ) : visible.length === 0 ? (
        <EmptyState
          icon={<SearchIcon size={20} />}
          title="No agents match"
          text="Try a different search, or clear the status filter to see everything."
          actions={
            <button
              type="button"
              className="btn"
              onClick={() => {
                setQuery('')
                setFilter('all')
              }}
            >
              Clear filters
            </button>
          }
        />
      ) : (
        <div className="grid">
          {visible.map((a) => (
            <Link to={`/agents/${a.id}`} className="tile" key={a.id}>
              <div className="tile__top">
                <span className="tile__icon">
                  <AgentsIcon size={16} />
                </span>
                <span className="tile__name">{a.name}</span>
                {a.isPrimary && (
                  <span className="pill pill--lead tile__lead">
                    Team Lead
                  </span>
                )}
                <span className="tile__status">
                  <StatusPill status={a.status} />
                </span>
              </div>
              {a.role && <p className="tile__role">{a.role}</p>}
              {a.projectId && (
                <p className="tile__project">
                  <span className="pill pill--project" title="Created by the Team Lead for this project">
                    {projectNameById.has(a.projectId) ? `Project: ${projectNameById.get(a.projectId)}` : 'Project'}
                  </span>
                </p>
              )}
              <p className="tile__desc">{a.description || 'No description yet.'}</p>
              <div className="tile__meta">
                <span>{displayModel(a)}</span>
                <span>·</span>
                <span>
                  {a.skillIds.length} {a.skillIds.length === 1 ? 'skill' : 'skills'}
                </span>
                <span>·</span>
                <span>{relativeTime(a.lastRunAt)}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </PageShell>
  )
}