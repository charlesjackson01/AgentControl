import PageShell from '../components/PageShell'
import { PlusIcon, SkillLibraryIcon } from '../components/icons'

const skills: { name: string; desc: string; used: string; tag: string }[] = [
  { name: 'Web Research', desc: 'Search, fetch, and cite with source ranking.', used: 'Used by 4 agents', tag: 'Core' },
  { name: 'Summarize', desc: 'Condenses long documents to key points.', used: 'Used by 6 agents', tag: 'Core' },
  { name: 'Code Interpreter', desc: 'Runs sandboxed snippets and plots results.', used: 'Used by 2 agents', tag: 'Sandbox' },
  { name: 'CRM Lookup', desc: 'Reads contact and deal history.', used: 'Used by 1 agent', tag: 'Integration' },
  { name: 'SQL Query', desc: 'Read-only warehouse access with a query guard.', used: 'Used by 3 agents', tag: 'Integration' },
]

export default function SkillLibrary() {
  return (
    <PageShell
      eyebrow="Workspace"
      title="Skill Library"
      subtitle="Reusable capabilities your agents can call. Changes apply to every agent that references them."
      actions={
        <button type="button" className="btn">
          <PlusIcon size={16} />
          New Skill
        </button>
      }
    >
      <div className="grid">
        {skills.map((s) => (
          <button type="button" className="tile" key={s.name}>
            <div className="tile__top">
              <span className="tile__icon">
                <SkillLibraryIcon size={16} />
              </span>
              <span className="tile__name">{s.name}</span>
            </div>
            <p className="tile__desc">{s.desc}</p>
            <div className="tile__meta">
              <span className="pill">{s.tag}</span>
              <span>·</span>
              <span>{s.used}</span>
            </div>
          </button>
        ))}
      </div>
    </PageShell>
  )
}
