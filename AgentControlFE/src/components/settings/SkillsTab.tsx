import { useEffect, useMemo, useRef, useState } from 'react'
import Toggle from './Toggle'
import { SearchIcon } from '../icons'
import { api } from '../../lib/api'
import { agentPutBody } from '../../lib/agent-put'
import { friendlyError as friendly } from '../../lib/chat-format'
import { normalizeRules } from '../../lib/agent-profile'
import { budgetMeter, groupSkills, skillDetailLine, toggleSkillId, visibleSkills, type SkillsResponse } from '../../lib/skills-catalog'
import type { Agent, PromptBudget, Skill, SkillSummary } from '../../lib/types'

/** Characters of a skill body shown in the detail view. */
const PREVIEW_CHARS = 1500

type Detail = { id: string; skill: Skill | null; error: string | null }

const BUDGET_DEBOUNCE_MS = 300

/** 03c: the skill library grouped by source; each toggle saves `agent.skillIds`. */
export default function SkillsTab({ agent, onAgentSaved }: { agent: Agent; onAgentSaved: (a: Agent) => void }) {
  const [catalog, setCatalog] = useState<SkillsResponse | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [ids, setIds] = useState<string[]>(() => [...agent.skillIds])
  const [saving, setSaving] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [budget, setBudget] = useState<{ key: string; value: PromptBudget | null } | null>(null)
  const [importNote, setImportNote] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [detail, setDetail] = useState<Detail | null>(null)

  /** Bodies aren't in BE-6 list rows: fetch `/api/skills/:id` (legacy rows already carry one). */
  const openDetail = (s: SkillSummary) => {
    if (detail?.id === s.id) {
      setDetail(null)
      return
    }
    if (typeof s.content === 'string') {
      setDetail({ id: s.id, skill: s as Skill, error: null })
      return
    }
    setDetail({ id: s.id, skill: null, error: null })
    api.getSkill(s.id).then(
      (skill) => setDetail((d) => (d?.id === s.id ? { ...d, skill } : d)),
      (err: unknown) => setDetail((d) => (d?.id === s.id ? { ...d, error: friendly(err, 'Could not load this skill.') } : d)),
    )
  }

  useEffect(() => {
    let live = true
    api.listSkillCatalog().then(
      (c) => live && setCatalog(c),
      (err: unknown) => live && setLoadError(friendly(err, 'Could not load skills.')),
    )
    return () => {
      live = false
    }
  }, [attempt])

  // Token meter (POST /api/prompt-budget), debounced on the enabled set.
  const budgetKey = JSON.stringify([agent.endpointId, ids])
  useEffect(() => {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      api
        .getPromptBudget(
          { endpointId: agent.endpointId, skillIds: ids, instructions: agent.instructions, rules: normalizeRules(agent.rules ?? []) },
          { signal: controller.signal },
        )
        .then(
          (value) => setBudget({ key: budgetKey, value }),
          () => !controller.signal.aborted && setBudget({ key: budgetKey, value: null }),
        )
    }, BUDGET_DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [budgetKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const groups = useMemo(
    () => (catalog ? groupSkills(catalog.skills, catalog.sources, ids, query) : []),
    [catalog, ids, query],
  )
  const total = catalog?.skills.length ?? 0
  const meter = budget?.value ? budgetMeter(budget.value) : null

  const toggle = async (id: string, on: boolean) => {
    const before = ids
    const next = toggleSkillId(before, id, on)
    setIds(next)
    setSaving(id)
    setError(null)
    try {
      onAgentSaved(await api.updateAgent(agent.id, agentPutBody(agent, { skillIds: next })))
    } catch (err) {
      setIds(before)
      setError(friendly(err, 'Could not save the skill change.'))
    } finally {
      setSaving(null)
    }
  }

  const importFile = async (file: File) => {
    setImportNote(null)
    try {
      const skill = await api.importSkill(await file.text())
      setCatalog((c) => (c ? { ...c, skills: [...c.skills.filter((s) => s.id !== skill.id), skill] } : c))
      await toggle(skill.id, true)
      setImportNote({ tone: 'ok', text: `Imported ${skill.name} and turned it on for ${agent.name}.` })
    } catch (err) {
      setImportNote({ tone: 'err', text: friendly(err, 'Could not import that SKILL.md.') })
    }
  }

  return (
    <div className="cf-set__stack">
      <div className="cf-set__bar">
        <label className="cf-search cf-search--boxed cf-grow">
          <SearchIcon size={13} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search ${total || ''} skills`.replace('  ', ' ')} aria-label="Search skills" type="search" />
        </label>
        <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
          Import SKILL.md
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".md,text/markdown,text/plain"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (f) void importFile(f)
          }}
        />
      </div>
      {importNote && (
        <p className={importNote.tone === 'ok' ? 'cf-set__ok' : 'field__err'} role={importNote.tone === 'ok' ? 'status' : 'alert'}>
          {importNote.text}
        </p>
      )}

      <section className="cf-card cf-skills__info">
        <span className="cf-skills__spark" aria-hidden="true">✦</span>
        <p>
          <b>Loaded on demand.</b> {agent.name} reads a skill in full only when a task needs it.
          {catalog?.legacy ? ' (This server still sends full skills in the prompt until BE-7.)' : ''}
        </p>
        <div className={`cf-meter cf-meter--${meter?.tone ?? 'ok'}`} role="status" aria-live="polite">
          <span className="cf-meter__bar">
            <span style={{ width: `${Math.round((meter?.fraction ?? 0) * 100)}%` }} />
          </span>
          <span className="cf-meter__t">{meter ? meter.label : budget ? 'Token estimate unavailable' : 'Estimating…'}</span>
        </div>
      </section>

      {catalog?.legacy && (
        <p className="cf-set__muted" role="status">
          Skill sources, licences and pinned commits arrive with BE-6; this server&apos;s library is shown as is.
        </p>
      )}
      {error && <p className="field__err" role="alert">{error}</p>}
      {loadError && !catalog && (
        <div className="notice notice--warn cf-set__notice" role="alert">
          {loadError}{' '}
          <button type="button" className="btn btn--sm" onClick={() => setAttempt((n) => n + 1)}>
            Retry
          </button>
        </div>
      )}
      {!catalog && !loadError && <p className="cf-set__muted">Loading skills…</p>}
      {catalog && groups.length === 0 && <p className="cf-set__muted">{query ? `No skills match “${query.trim()}”.` : 'No skills yet.'}</p>}

      {groups.map((g) => {
        const isCollapsed = collapsed[g.id] ?? (g.id === 'core' && !query && groups.length > 1)
        const { rows, more } = visibleSkills(g, Boolean(expanded[g.id]), query)
        return (
          <section key={g.id} className="cf-card cf-skills__grp">
            <button
              type="button"
              className="cf-skills__hd"
              aria-expanded={!isCollapsed}
              onClick={() => setCollapsed((c) => ({ ...c, [g.id]: !isCollapsed }))}
            >
              <span className="cf-skills__caret" aria-hidden="true">{isCollapsed ? '▸' : '▾'}</span>
              <span className="cf-skills__title">{g.title}</span>
              {g.meta && <span className="cf-skills__meta">{g.meta}</span>}
              {g.readOnly && <span className="cf-tag cf-tag--muted" title="Vendored at a pinned commit; not editable here">read-only</span>}
              <span className="cf-grow" />
              <span className="cf-skills__count">
                {g.enabled} of {g.total} on
              </span>
            </button>
            {!isCollapsed && (
              <ul className="cf-skills__list">
                {rows.map((s) => {
                  const on = ids.includes(s.id)
                  const open = detail?.id === s.id
                  return (
                    <li key={s.id} className="cf-skills__row">
                      <div className="cf-skills__txt">
                        <p className="cf-skills__name">
                          <button type="button" className="cf-skills__open cf-mono" onClick={() => openDetail(s)} aria-expanded={open} title="Show details">
                            {s.name}
                          </button>
                          {s.hasScripts && <span className="cf-tag">runs scripts</span>}
                          {s.defaultOn && <span className="cf-tag">default</span>}
                        </p>
                        <p className="cf-skills__desc">{s.description}</p>
                        {open && detail && (
                          <div className="cf-skills__detail">
                            <p className="cf-skills__dline">{skillDetailLine(s)}</p>
                            {detail.error ? (
                              <p className="field__err" role="alert">{detail.error}</p>
                            ) : !detail.skill ? (
                              <p className="cf-set__muted">Loading…</p>
                            ) : (
                              <pre className="cf-skills__body">
                                {detail.skill.content.length > PREVIEW_CHARS ? `${detail.skill.content.slice(0, PREVIEW_CHARS)}…` : detail.skill.content || '(empty)'}
                              </pre>
                            )}
                            {s.files && s.files.length > 0 && (
                              <p className="cf-skills__files">
                                {s.files.slice(0, 8).map((f) => (
                                  <code key={f}>{f}</code>
                                ))}
                                {s.files.length > 8 && <span>＋{s.files.length - 8} more</span>}
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                      <Toggle on={on} onChange={(v) => void toggle(s.id, v)} label={`${s.name} for ${agent.name}`} disabled={saving !== null} />
                    </li>
                  )
                })}
                {more > 0 && (
                  <li>
                    <button type="button" className="cf-skills__more" onClick={() => setExpanded((x) => ({ ...x, [g.id]: true }))}>
                      ＋ {more} more
                    </button>
                  </li>
                )}
              </ul>
            )}
          </section>
        )
      })}
    </div>
  )
}
