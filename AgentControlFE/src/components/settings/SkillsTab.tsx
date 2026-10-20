import { memo, startTransition, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import Toggle from './Toggle'
import { SearchIcon } from '../icons'
import { api } from '../../lib/api'
import { agentPutBody } from '../../lib/agent-put'
import { friendlyError as friendly } from '../../lib/chat-format'
import { normalizeRules } from '../../lib/agent-profile'
import { budgetMeter, groupSkills, skillDetailLine, skillWriteError, toggleSkillId, visibleSkills, withImportedSkill, type SkillsResponse } from '../../lib/skills-catalog'
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
  // Sort order is fixed when the tab opens, so toggling never moves a row.
  const [orderIds] = useState<readonly string[]>(() => [...agent.skillIds])
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

  // 359 skills with BE-6: typing stays responsive while the filtered list catches up.
  const shownQuery = useDeferredValue(query)
  const groups = useMemo(
    () => (catalog ? groupSkills(catalog.skills, catalog.sources, ids, shownQuery, orderIds) : []),
    [catalog, ids, shownQuery, orderIds],
  )
  const total = catalog?.skills.length ?? 0
  const meter = budget?.value ? budgetMeter(budget.value) : null

  // Toggles apply at once and save in order (one PUT at a time, each with the
  // full list so far), so no switch has to be disabled while another saves.
  const liveIds = useRef(ids)
  const savedIds = useRef<string[]>([...agent.skillIds])
  const queue = useRef<Promise<void>>(Promise.resolve())
  const toggle = (id: string, on: boolean) => {
    const next = toggleSkillId(liveIds.current, id, on)
    liveIds.current = next
    setIds(next)
    setError(null)
    queue.current = queue.current.then(async () => {
      if (liveIds.current !== next) return // a later toggle will save a newer list
      try {
        const saved = await api.updateAgent(agent.id, agentPutBody(agent, { skillIds: next }))
        savedIds.current = [...saved.skillIds]
        onAgentSaved(saved)
      } catch (err) {
        if (liveIds.current === next) {
          liveIds.current = savedIds.current
          setIds(savedIds.current)
        }
        setError(friendly(err, 'Could not save the skill change.'))
      }
    })
  }

  const latest = useRef({ toggle, openDetail })
  useEffect(() => {
    latest.current = { toggle, openDetail }
  })
  const onToggle = useCallback((id: string, v: boolean) => latest.current.toggle(id, v), [])
  const onOpen = useCallback((s: SkillSummary) => latest.current.openDetail(s), [])

  const importFile = async (file: File) => {
    setImportNote(null)
    try {
      const skill = await api.importSkill(await file.text())
      // Imports are custom skills: editable, off by default. The user turns it on here.
      const row = { sourceId: 'custom' as const, defaultOn: false, ...skill }
      setCatalog((c) => (c ? withImportedSkill(c, row) : c))
      setQuery(row.name)
      setImportNote({ tone: 'ok', text: `Imported ${row.name}. Switch it on below to give it to ${agent.name}.` })
    } catch (err) {
      setImportNote({ tone: 'err', text: skillWriteError(err, 'Could not import that SKILL.md.') })
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
          <b>Loaded on demand.</b> {agent.name} reads a skill in full only when a task needs it. Skill scripts run in {agent.name}&apos;s sandbox VM; internet needs your OK.
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

      {/* Expand/collapse run as transitions: mounting ECC's ~300 rows is sliced, not one long frame. */}
      {groups.map((g) => {
        const isCollapsed = collapsed[g.id] ?? (g.id === 'core' && !shownQuery && groups.length > 1)
        const { rows, more } = visibleSkills(g, Boolean(expanded[g.id]), shownQuery)
        return (
          <section key={g.id} className="cf-card cf-skills__grp">
            <button
              type="button"
              className="cf-skills__hd"
              aria-expanded={!isCollapsed}
              onClick={() => startTransition(() => setCollapsed((c) => ({ ...c, [g.id]: !isCollapsed })))}
            >
              <span className="cf-skills__caret" aria-hidden="true">{isCollapsed ? '▸' : '▾'}</span>
              <span className="cf-skills__title">{g.title}</span>
              {g.meta && <span className="cf-skills__meta" title={g.meta}>{g.meta}</span>}
              {g.readOnly && <span className="cf-tag cf-tag--muted" title="Vendored at a pinned commit; not editable here">read-only</span>}
              <span className="cf-grow" />
              <span className="cf-skills__count">
                {g.enabled} of {g.total} on
              </span>
            </button>
            {!isCollapsed && (
              <ul className="cf-skills__list">
                {rows.map((s) => (
                  <SkillRow
                    key={s.id}
                    skill={s}
                    on={ids.includes(s.id)}
                    detail={detail?.id === s.id ? detail : null}
                    agentName={agent.name}
                    onToggle={onToggle}
                    onOpen={onOpen}
                  />
                ))}
                {(more > 0 || g.note) && (
                  <li className="cf-skills__foot">
                    {more > 0 && (
                      <button type="button" className="cf-skills__more" onClick={() => startTransition(() => setExpanded((x) => ({ ...x, [g.id]: true })))}>
                        ＋ {more} more
                      </button>
                    )}
                    {g.note && <span className="cf-skills__note">{more > 0 ? ' · ' : ''}{g.note}</span>}
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

type RowProps = {
  skill: SkillSummary
  on: boolean
  detail: Detail | null
  agentName: string
  onToggle: (id: string, on: boolean) => void
  onOpen: (s: SkillSummary) => void
}

/** One skill row; memoised so a toggle or detail fetch re-renders one row, not all 359. */
const SkillRow = memo(function SkillRow({ skill: s, on, detail, agentName, onToggle, onOpen }: RowProps) {
  const open = detail !== null
  return (
    <li className="cf-skills__row">
      <div className="cf-skills__txt">
        <p className="cf-skills__name">
          <button type="button" className="cf-skills__open cf-mono" onClick={() => onOpen(s)} aria-expanded={open} title="Show details">
            {s.name}
          </button>
          {s.hasScripts && <span className="cf-tag">runs scripts</span>}
          {s.defaultOn && <span className="cf-tag" title="On by default for new bots">essentials</span>}
        </p>
        <p className="cf-skills__desc">{s.description}</p>
        {detail && (
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
      <Toggle on={on} onChange={(v) => onToggle(s.id, v)} label={`${s.name} for ${agentName}`} />
    </li>
  )
})
