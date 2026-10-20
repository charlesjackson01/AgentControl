import { useId, useState } from 'react'
import { Link } from 'react-router-dom'
import { activityLabel, fileOpenPath, type ActivityView } from '../../lib/activity'

/**
 * FE-7: the skill/steps card above an assistant bubble (mockups 04, 05b).
 * GAP-2: collapsed by default (05b; 04 shows it expanded). The header is a button
 * with aria-expanded when there is anything to expand, plain otherwise (GAP-3).
 * Gaps are listed in lib/activity.ts.
 */
export function ActivityCard({ view }: { view: ActivityView }) {
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  if (!view.card) return null

  // Mockup 04 header: "✦ Skill  systematic-debugging  obra/superpowers  ····  5 steps ▾".
  // Mockup 05b (narrow, shell.css): "✦  doc-coauthoring · 3 steps ▸".
  const head = (
    <>
      {view.pill && (
        <span className="cf-act__pill" aria-hidden="true">
          ✦<span className="cf-act__pilltxt">{view.pill}</span>
        </span>
      )}
      {view.title && <span className="cf-act__name">{view.title}</span>}
      {view.source && <span className="cf-act__src">{view.source}</span>}
      <span className="cf-act__sp" />
      {view.count && <span className="cf-act__count">{view.count}</span>}
      {view.expandable && <span className="cf-act__chev" aria-hidden="true">{open ? '▾' : '▸'}</span>}
    </>
  )

  return (
    <div className={`cf-act${open ? ' cf-act--open' : ''}`}>
      {view.expandable ? (
        <button
          type="button"
          className="cf-act__head"
          aria-expanded={open}
          aria-controls={bodyId}
          aria-label={activityLabel(view)}
          onClick={() => setOpen((o) => !o)}
        >
          {head}
        </button>
      ) : (
        <div className="cf-act__head" aria-label={activityLabel(view)} role="group">
          {head}
        </div>
      )}
      {view.expandable && (
        <div className="cf-act__body" id={bodyId} hidden={!open}>
          {/* GAP-5: several skills, sources listed here in the header's name/source style. */}
          {view.skills.length > 1 && (
            <ul className="cf-act__skills" aria-label="Skills used">
              {view.skills.map((s) => (
                <li key={s.id}>
                  <span className="cf-act__name">{s.name}</span>
                  {s.source && <span className="cf-act__src">{s.source}</span>}
                </li>
              ))}
            </ul>
          )}
          {view.steps.length > 0 && (
            <ol className="cf-act__steps" aria-label="Steps">
              {view.steps.map((st, i) => (
                <li key={i} className={`cf-act__step${st.ok ? '' : ' cf-act__step--failed'}`}>
                  {/* GAP-1: a failed step shows ✕ in the neutral muted colour; no failed design in v3. */}
                  <span className="cf-act__ok" aria-hidden="true">{st.ok ? '✓' : '✕'}</span>
                  <span className="sr-only">{st.ok ? 'Done:' : 'Failed:'}</span>
                  <span className="cf-act__verb">{st.verb}</span>
                  {st.target && <span className="cf-act__target">{st.target}</span>}
                  {st.summary && <span className="cf-act__sum">{st.summary}</span>}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * FE-7: one card per file the run added or changed (mockup 04, below the bubble).
 * GAP-7 resolved (FE-4): Open is a link to this chat's Files panel at the file's path
 * (`?panel=files&path=…`), which picks the file out in its folder. Download: not in v3, left out.
 */
export function FileCards({ files, conversationId }: { files: ActivityView['files']; conversationId: string }) {
  if (files.length === 0) return null
  return (
    <ul className="cf-fcards" aria-label="Files changed">
      {files.map((f) => (
        <li key={f.path} className="cf-fcard">
          <span className="cf-fcard__ico" aria-hidden="true">📄</span>
          <span className="cf-fcard__txt">
            <span className="cf-fcard__name" title={f.path}>{f.name}</span>
            <span className="cf-fcard__meta">
              {/* Mockup 04: "workspace/briefs · 2.4 KB · updated just now" (GAP-6, resolved once BE-3 sends bytes/modifiedAt). */}
              {f.meta}
            </span>
          </span>
          {/* Mockup 04: Open (GAP-7 resolved). Download: not in v3, left out. */}
          <Link className="cf-btn cf-fcard__open" to={fileOpenPath(conversationId, f.path)} aria-label={`Open ${f.name} in Files`}>
            Open
          </Link>
        </li>
      ))}
    </ul>
  )
}
