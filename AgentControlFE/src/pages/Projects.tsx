import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import PageShell from '../components/PageShell'
import Dialog from '../components/Dialog'
import ConfirmDialog from '../components/ConfirmDialog'
import { EmptyState, ErrorState, Skeleton } from '../components/States'
import { PlusIcon, ProjectsIcon, SearchIcon } from '../components/icons'
import { useAsync } from '../hooks/useAsync'
import { api } from '../lib/api'
import type { Agent, Project } from '../lib/types'

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.round(diff / 60_000)
  if (mins < 1) return 'Just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return `${days}d ago`
}

type DialogMode = 'create' | 'delete'

function CreateProjectDialog({
  open,
  agents,
  onClose,
  onCreated,
}: {
  open: boolean
  agents: Agent[]
  onClose: () => void
  onCreated: (project: Project) => void
}) {
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [teamIds, setTeamIds] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggle = (id: string) =>
    setTeamIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))

  const submit = async () => {
    if (saving) return
    if (!name.trim()) {
      setError('Give the project a name.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const project = await api.createProject({ name: name.trim(), desc: desc.trim(), teamAgentIds: teamIds })
      setName('')
      setDesc('')
      setTeamIds([])
      onCreated(project)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the project.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={open}
      title="New Project"
      subtitle="AgentControl creates a folder for the project. The team can be empty — the Team Lead assembles one when you send the first prompt."
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" onClick={() => void submit()} disabled={saving}>
            {saving ? 'Creating…' : 'Create project'}
          </button>
        </>
      }
    >
      <div className="field">
        <label className="field__label" htmlFor="pf-name">
          Name <span className="field__req" aria-hidden="true">*</span>
        </label>
        <input id="pf-name" data-autofocus value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
        <p className="field__hint">Unique within the workspace. The folder name is derived from it.</p>
      </div>
      <div className="field">
        <label className="field__label" htmlFor="pf-desc">
          Description
        </label>
        <textarea id="pf-desc" className="textarea" rows={2} value={desc} onChange={(e) => setDesc(e.target.value)} />
        <p className="field__hint">One line on what this project is for.</p>
      </div>
      <div className="field">
        <span className="field__label">Team (optional)</span>
        {agents.length === 0 ? (
          <p className="field__hint">No agents in the library yet. You can add specialists later, or let the Team Lead pick.</p>
        ) : (
          <div className="chips" role="group" aria-label="Project team">
            {agents.map((a) => (
              <button
                type="button"
                key={a.id}
                className={`chip${teamIds.includes(a.id) ? ' chip--on' : ''}`}
                aria-pressed={teamIds.includes(a.id)}
                onClick={() => toggle(a.id)}
              >
                {a.name}
                {a.role ? ` · ${a.role}` : ''}
              </button>
            ))}
          </div>
        )}
        <p className="field__hint">Select existing agents from your library, or leave the team empty.</p>
      </div>
      {error && (
        <p className="field__err" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  )
}

export default function Projects() {
  const navigate = useNavigate()
  const projects = useAsync(api.listProjects, [])
  const agents = useAsync(api.listAgents, [])
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<DialogMode | null>(null)
  const [target, setTarget] = useState<Project | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const agentById = useMemo(() => new Map((agents.data ?? []).map((a) => [a.id, a])), [agents.data])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = projects.data ?? []
    if (!q) return list
    return list.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.desc.toLowerCase().includes(q) ||
        p.folder.toLowerCase().includes(q),
    )
  }, [projects.data, query])

  const close = () => {
    if (deleting) return
    setMode(null)
    setTarget(null)
    setError(null)
  }

  const remove = async () => {
    if (!target || deleting) return
    setDeleting(true)
    setError(null)
    try {
      await api.deleteProject(target.id)
      setMode(null)
      setTarget(null)
      projects.reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the project.')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <PageShell
      eyebrow="Workspace"
      title="Projects"
      subtitle="Each project owns a folder AgentControl creates and a team of your library agents."
      actions={
        <>
          <div className="search">
            <span className="search__icon">
              <SearchIcon size={15} />
            </span>
            <input
              type="search"
              aria-label="Search projects"
              placeholder="Search names, descriptions, folders…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <button type="button" className="btn btn--primary" onClick={() => setMode('create')}>
            <PlusIcon size={16} />
            New Project
          </button>
        </>
      }
    >
      {projects.loading ? (
        <div className="grid">
          {[0, 1, 2].map((n) => (
            <div className="skel-card" key={n}>
              <Skeleton height={13} />
              <Skeleton height={9} />
            </div>
          ))}
        </div>
      ) : projects.error ? (
        <ErrorState error={projects.error} onRetry={projects.reload} />
      ) : (projects.data ?? []).length === 0 ? (
        <EmptyState
          icon={<ProjectsIcon size={20} />}
          title="No projects yet"
          text="Create a project and AgentControl makes its folder. Add agents now or let the Team Lead assemble the team when you send the first prompt."
          actions={
            <button type="button" className="btn btn--primary" onClick={() => setMode('create')}>
              <PlusIcon size={16} />
              New Project
            </button>
          }
        />
      ) : visible.length === 0 ? (
        <EmptyState
          icon={<SearchIcon size={20} />}
          title="No projects match"
          text="Search matches names, descriptions, and folders. Try another search."
          actions={
            <button type="button" className="btn" onClick={() => setQuery('')}>
              Clear search
            </button>
          }
        />
      ) : (
        <div className="grid">
          {visible.map((p) => (
            <div className="tile tile--link" key={p.id}>
              {/* Stretched link: the whole tile opens the project chat; Delete sits above it. */}
              <Link to={`/projects/${p.id}`} className="tile__link" aria-label={`Open ${p.name}`} />
              <div className="tile__top">
                <span className="tile__icon">
                  <ProjectsIcon size={16} />
                </span>
                <span className="tile__name">{p.name}</span>
              </div>
              <p className="tile__desc">{p.desc || 'No description.'}</p>
              {p.teamAgentIds.length > 0 && (
                <div className="chips">
                  {p.teamAgentIds.map((id) => (
                    <span className="pill" key={id}>
                      {agentById.get(id)?.name ?? 'Removed agent'}
                    </span>
                  ))}
                </div>
              )}
              <div className="tile__meta">
                <span>
                  {p.teamAgentIds.length} {p.teamAgentIds.length === 1 ? 'agent' : 'agents'}
                </span>
                <span>·</span>
                <span>Updated {relativeTime(p.updatedAt)}</span>
                <span>·</span>
                <button
                  type="button"
                  className="btn btn--ghost tile__action"
                  onClick={() => {
                    setError(null)
                    setTarget(p)
                    setMode('delete')
                  }}
                >
                  Delete…
                </button>
              </div>
              <p className="field__hint meta__v--mono">{p.folder}</p>
            </div>
          ))}
        </div>
      )}

      <CreateProjectDialog
        open={mode === 'create'}
        agents={agents.data ?? []}
        onClose={close}
        onCreated={(project) => navigate(`/projects/${project.id}`)}
      />

      <ConfirmDialog
        open={mode === 'delete'}
        title={`Delete ${target?.name ?? 'project'}?`}
        subtitle="This removes the project record and its chat. The folder stays on disk."
        confirmLabel="Delete project"
        loading={deleting}
        onCancel={close}
        onConfirm={() => void remove()}
      >
        <p className="prose">
          The folder <span className="meta__v--mono">{target?.folder}</span> is not deleted; remove it yourself if you
          no longer need it. This cannot be undone.
        </p>
        {error && (
          <p className="field__err" role="alert">
            {error}
          </p>
        )}
      </ConfirmDialog>
    </PageShell>
  )
}
