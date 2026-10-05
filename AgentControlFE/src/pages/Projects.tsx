import PageShell from '../components/PageShell'
import { PlusIcon, ProjectsIcon } from '../components/icons'

const projects: { name: string; desc: string; agents: number; updated: string }[] = [
  { name: 'Support Automation', desc: 'Triage and reply pipeline for inbound tickets.', agents: 4, updated: '2h ago' },
  { name: 'Docs Refresh', desc: 'Rewrites stale guides from the product changelog.', agents: 2, updated: 'Yesterday' },
  { name: 'Data Platform', desc: 'Nightly ETL plus schema drift monitoring.', agents: 6, updated: '3d ago' },
]

export default function Projects() {
  return (
    <PageShell
      eyebrow="Workspace"
      title="Projects"
      subtitle="Group agents into projects to share context, budgets, and schedules."
      actions={
        <button type="button" className="btn">
          <PlusIcon size={16} />
          New Project
        </button>
      }
    >
      <div className="grid">
        {projects.map((p) => (
          <button type="button" className="tile" key={p.name}>
            <div className="tile__top">
              <span className="tile__icon">
                <ProjectsIcon size={16} />
              </span>
              <span className="tile__name">{p.name}</span>
            </div>
            <p className="tile__desc">{p.desc}</p>
            <div className="tile__meta">
              <span>
                {p.agents} {p.agents === 1 ? 'agent' : 'agents'}
              </span>
              <span>·</span>
              <span>Updated {p.updated}</span>
            </div>
          </button>
        ))}
      </div>
    </PageShell>
  )
}
