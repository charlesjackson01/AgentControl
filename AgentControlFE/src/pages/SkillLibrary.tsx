import { useMemo, useState, type FormEvent, type ReactNode } from 'react'
import PageShell from '../components/PageShell'
import Dialog from '../components/Dialog'
import ConfirmDialog from '../components/ConfirmDialog'
import ToolPicker from '../components/ToolPicker'
import { EmptyState, ErrorState, Skeleton } from '../components/States'
import { PlusIcon, SearchIcon, SkillLibraryIcon } from '../components/icons'
import { api } from '../lib/api'
import type { Skill, SkillInput } from '../lib/types'
import { parsePreview, serializeSkillMarkdown, skillFileName } from '../lib/skill-markdown'
import { filterSkills } from '../lib/skill-search'
import { classifyImportTools } from '../lib/skill-tools'
import { useAsync } from '../hooks/useAsync'

const DISCOVERY_HINT: ReactNode = (
  <>
    Find SKILL.md files at{' '}
    <a className="link" href="https://skillmd.com" target="_blank" rel="noreferrer">
      skillmd.com
    </a>{' '}
    or{' '}
    <a className="link" href="https://github.com/seb1n/awesome-ai-agent-skills" target="_blank" rel="noreferrer">
      seb1n/awesome-ai-agent-skills
    </a>
    .
  </>
)

/**
 * Built-in (seeded) skills carry a `source`; the library's create and import
 * never set one, and Duplicate drops it, so copies count as the user's own.
 */
const isBuiltIn = (skill: Skill): boolean => Boolean(skill.source)

const BUILT_IN_HINT =
  'Built-in skill: editing it stops it from receiving future built-in upgrades. To customize it, duplicate it and edit the copy.'

/** Save the skill as `<id>.md`, a SKILL.md file the Import dialog accepts. */
function downloadSkill(skill: Skill) {
  const blob = new Blob([serializeSkillMarkdown(skill)], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = skillFileName(skill.id)
  document.body.append(link)
  link.click()
  link.remove()
  // Revoke once the click has handed the blob to the download.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function SkillForm({
  initial,
  saving,
  serverError,
  onSubmit,
  registry,
}: {
  registry: ReturnType<typeof useAsync<Awaited<ReturnType<typeof api.listTools>>>>
  initial: Skill | null
  saving: boolean
  serverError: string | null
  onSubmit: (input: SkillInput) => void
}) {
  const [name, setName] = useState(initial?.name ?? '')
  const [tag, setTag] = useState(initial?.tag ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [content, setContent] = useState(initial?.content ?? '')
  const [tools, setTools] = useState(initial?.tools ?? [])
  const [toolsChanged, setToolsChanged] = useState(false)
  const [errors, setErrors] = useState<{ name?: string; content?: string }>({})

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const next: typeof errors = {}
    if (!name.trim()) next.name = 'Give the skill a name.'
    if (!content.trim()) next.content = 'Skills need content — it is injected into the run prompt.'
    setErrors(next)
    if (Object.keys(next).length > 0) return
    onSubmit({ name: name.trim(), tag: tag.trim(), description: description.trim(), content: content.trim(), ...(!initial || toolsChanged ? { tools } : {}) })
  }

  return (
    <form className="form" onSubmit={submit} noValidate>
      <div className="field">
        <label className="field__label" htmlFor="sk-name">
          Name <span className="field__req" aria-hidden="true">*</span>
        </label>
        <input
          id="sk-name"
          className={`input${errors.name ? ' input--invalid' : ''}`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Code Review"
        />
        {errors.name ? <p className="field__err">{errors.name}</p> : <p className="field__hint">Shown on the card and in the agent skill picker.</p>}
      </div>
      <div className="field">
        <label className="field__label" htmlFor="sk-tag">
          Tag
        </label>
        <input id="sk-tag" className="input" value={tag} onChange={(e) => setTag(e.target.value)} placeholder="Core" />
        <p className="field__hint">Groups skills in the library and the picker.</p>
      </div>
      <div className="field">
        <label className="field__label" htmlFor="sk-desc">
          Description
        </label>
        <input
          id="sk-desc"
          className="input"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What this skill teaches the agent, in one line."
        />
      </div>
      <div className="field">
        <label className="field__label" htmlFor="sk-content">
          Content <span className="field__req" aria-hidden="true">*</span>
        </label>
        <textarea
          id="sk-content"
          className={`textarea textarea--mono${errors.content ? ' textarea--invalid' : ''}`}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={12}
          placeholder="The SKILL.md body. Instructions the agent follows on every run."
        />
        {errors.content ? (
          <p className="field__err">{errors.content}</p>
        ) : (
          <p className="field__hint">Plain markdown, injected into the system prompt of every agent that uses this skill.</p>
        )}
      </div>

      <ToolPicker selected={tools} registry={registry.data} loading={registry.loading} error={registry.error}
        disabled={saving} onRetry={registry.reload} onChange={(next) => { setTools(next); setToolsChanged(true) }} />

      {serverError && (
        <p className="field__err" role="alert">
          {serverError}
        </p>
      )}
      <div className="formactions">
        <button type="submit" className="btn btn--primary" disabled={saving}>
          {saving && <span className="spinner" aria-hidden="true" />}
          {saving ? 'Saving…' : initial ? 'Save changes' : 'Create skill'}
        </button>
      </div>
    </form>
  )
}

type DialogState =
  | { mode: 'create' }
  | { mode: 'view'; skill: Skill }
  | { mode: 'edit'; skill: Skill }
  | { mode: 'delete'; skill: Skill }
  | { mode: 'import' }
  | null

export default function SkillLibrary() {
  const skills = useAsync(api.listSkills, [])
  const registry = useAsync(api.listTools, [])
  const agents = useAsync(api.listAgents, [])

  const [dialog, setDialog] = useState<DialogState>(null)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [duplicating, setDuplicating] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)

  const [importText, setImportText] = useState('')
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)

  const [query, setQuery] = useState('')
  const [activeTags, setActiveTags] = useState<string[]>([])

  const usedBy = useMemo(() => {
    const names = new Map<string, string[]>()
    for (const a of agents.data ?? []) {
      for (const id of a.skillIds) {
        names.set(id, [...(names.get(id) ?? []), a.name])
      }
    }
    return names
  }, [agents.data])

  const preview = useMemo(() => (importText.trim() ? parsePreview(importText) : null), [importText])

  const tags = useMemo(() => {
    const set = new Set<string>()
    for (const s of skills.data ?? []) if (s.tag) set.add(s.tag)
    return [...set].sort((a, b) => a.localeCompare(b))
  }, [skills.data])

  // Skill has no createdAt in the contract (types.ts), so the list keeps BE order.
  // Search covers the name, description, tag, and declared tool names.
  const visible = useMemo(() => filterSkills(skills.data ?? [], query, activeTags), [skills.data, query, activeTags])

  const toggleTag = (tag: string) =>
    setActiveTags((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]))

  const clearFilters = () => {
    setQuery('')
    setActiveTags([])
  }

  const viewSkill = dialog?.mode === 'view' ? dialog.skill : null

  const closeDialog = () => {
    if (saving || deleting || importing || duplicating) return
    setDialog(null)
    setServerError(null)
  }

  const save = async (input: SkillInput) => {
    setSaving(true)
    setServerError(null)
    try {
      if (dialog?.mode === 'edit') await api.updateSkill(dialog.skill.id, input)
      else await api.createSkill(input)
      setDialog(null)
      await skills.reload()
    } catch (err) {
      setServerError(err instanceof Error ? err.message : 'Could not save the skill.')
    } finally {
      setSaving(false)
    }
  }

  const remove = async (skill: Skill) => {
    setDeleting(true)
    setServerError(null)
    try {
      await api.deleteSkill(skill.id)
      setDialog(null)
      await skills.reload()
      await agents.reload()
    } catch (err) {
      setServerError(err instanceof Error ? err.message : 'Could not delete the skill.')
    } finally {
      setDeleting(false)
    }
  }

  /** Copy through the regular create API (no `source`, so it is the user's own) and open it for editing. */
  const duplicate = async (skill: Skill) => {
    setDuplicating(true)
    setServerError(null)
    try {
      const copy = await api.createSkill({
        name: `${skill.name} (copy)`,
        description: skill.description,
        tag: skill.tag,
        content: skill.content,
        tools: skill.tools ?? [],
      })
      await skills.reload()
      setDialog({ mode: 'edit', skill: copy })
    } catch (err) {
      setServerError(err instanceof Error ? err.message : 'Could not duplicate the skill.')
    } finally {
      setDuplicating(false)
    }
  }

  const runImport = async () => {
    setImporting(true)
    setImportError(null)
    try {
      await api.importSkill(importText)
      setDialog(null)
      setImportText('')
      await skills.reload()
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Could not import the skill.')
    } finally {
      setImporting(false)
    }
  }

  return (
    <PageShell
      eyebrow="Workspace"
      title="Skill Library"
      subtitle="Reusable capabilities your agents can call. Their content is injected into every agent that references them."
      actions={
        <>
          <div className="search">
            <span className="search__icon">
              <SearchIcon size={15} />
            </span>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search skills or tools…"
              aria-label="Search skills by name, description, tag, or tool"
            />
            {query && (
              <button type="button" className="search__clear" onClick={() => setQuery('')} aria-label="Clear search">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true">
                  <path d="M6 6l12 12M18 6 6 18" />
                </svg>
              </button>
            )}
          </div>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setImportError(null)
              setDialog({ mode: 'import' })
            }}
          >
            Import SKILL.md
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => {
              setServerError(null)
              setDialog({ mode: 'create' })
            }}
          >
            <PlusIcon size={16} />
            New Skill
          </button>
        </>
      }
    >
      {skills.loading ? (
        <div className="grid">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div className="skel-card" key={i}>
              <Skeleton width={i % 2 ? '58%' : '72%'} height={13} />
              <Skeleton height={9} />
              <Skeleton width="40%" height={9} />
            </div>
          ))}
        </div>
      ) : skills.error ? (
        <ErrorState error={skills.error} onRetry={skills.reload} />
      ) : (skills.data ?? []).length === 0 ? (
        <EmptyState
          icon={<SkillLibraryIcon size={20} />}
          title="No skills yet"
          text="Create a skill or import a SKILL.md file — its content is injected into every agent that uses it."
          actions={
            <>
              <button type="button" className="btn" onClick={() => setDialog({ mode: 'import' })}>
                Import SKILL.md
              </button>
              <button type="button" className="btn btn--primary" onClick={() => setDialog({ mode: 'create' })}>
                New Skill
              </button>
            </>
          }
        />
      ) : (
        <>
          {tags.length > 0 && (
            <div className="chips tagfilter" role="group" aria-label="Filter by tag">
              {tags.map((t) => (
                <button
                  key={t}
                  type="button"
                  className={`chip${activeTags.includes(t) ? ' chip--on' : ''}`}
                  onClick={() => toggleTag(t)}
                  aria-pressed={activeTags.includes(t)}
                >
                  {t}
                </button>
              ))}
            </div>
          )}
          {visible.length === 0 ? (
            <EmptyState
              icon={<SearchIcon size={20} />}
              title="No skills match"
              text="Try a different search, or clear the tag filters to see everything."
              actions={
                <button type="button" className="btn" onClick={clearFilters}>
                  Clear filters
                </button>
              }
            />
          ) : (
            <div className="grid">
              {visible.map((s) => {
                const users = usedBy.get(s.id) ?? []
                return (
                  <button
                    type="button"
                    className="tile"
                    key={s.id}
                    onClick={() => {
                      setServerError(null)
                      setDialog({ mode: 'view', skill: s })
                    }}
                  >
                    <div className="tile__top">
                      <span className="tile__icon">
                        <SkillLibraryIcon size={16} />
                      </span>
                      <span className="tile__name">{s.name}</span>
                      {s.tag && <span className="pill">{s.tag}</span>}
                    </div>
                    <p className="tile__desc">{s.description || 'No description yet.'}</p>
                    <pre className="tile__preview">
                      {(s.content ?? '').slice(0, 160)}
                      {(s.content ?? '').length > 160 ? '…' : ''}
                    </pre>
                    <div className="tile__meta">
                      <span>
                        Used by {users.length} agent{users.length === 1 ? '' : 's'}
                      </span>
                      <span>·</span>
                      <span className="pill" title="Executed at run time">
                        {(s.tools ?? []).length} {(s.tools ?? []).length === 1 ? 'tool' : 'tools'}
                      </span>
                      {s.source && (
                        <>
                          <span>·</span>
                          <span>from {s.source}</span>
                        </>
                      )}
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </>
      )}

      <Dialog
        open={dialog?.mode === 'create' || dialog?.mode === 'edit'}
        title={dialog?.mode === 'edit' ? `Edit ${dialog.skill.name}` : 'New skill'}
        subtitle="Content is injected into the system prompt of every agent that uses this skill."
        onClose={closeDialog}
        footer={
          dialog?.mode === 'edit' ? (
            <button
              type="button"
              className="btn btn--danger"
              onClick={() => {
                setServerError(null)
                setDialog({ mode: 'delete', skill: dialog.skill })
              }}
            >
              Delete…
            </button>
          ) : null
        }
      >
        {dialog?.mode === 'edit' && isBuiltIn(dialog.skill) && (
          <div className="notice notice--info skillview__builtin">
            <p>{BUILT_IN_HINT}</p>
            <button
              type="button"
              className="btn"
              disabled={saving || duplicating}
              onClick={() => void duplicate(dialog.skill)}
              title="Copies the saved skill; edits not yet saved here are not copied."
            >
              {duplicating && <span className="spinner" aria-hidden="true" />}
              {duplicating ? 'Duplicating…' : 'Duplicate instead'}
            </button>
          </div>
        )}
        {dialog?.mode === 'edit' && (
          <SkillForm registry={registry} key={dialog.skill.id} initial={dialog.skill} saving={saving} serverError={serverError} onSubmit={(input) => void save(input)} />
        )}
        {dialog?.mode === 'create' && (
          <SkillForm registry={registry} key="create" initial={null} saving={saving} serverError={serverError} onSubmit={(input) => void save(input)} />
        )}
      </Dialog>

      <Dialog
        open={viewSkill !== null}
        title={viewSkill?.name ?? ''}
        onClose={closeDialog}
        footer={
          viewSkill && (
            <>
              <button
                type="button"
                className="btn btn--danger"
                disabled={duplicating}
                onClick={() => {
                  setServerError(null)
                  setDialog({ mode: 'delete', skill: viewSkill })
                }}
              >
                Delete…
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => downloadSkill(viewSkill)}
                title={`Download ${skillFileName(viewSkill.id)} — import it back with Import SKILL.md`}
              >
                Export
              </button>
              <button
                type="button"
                className="btn"
                disabled={duplicating}
                onClick={() => void duplicate(viewSkill)}
                title={`Create “${viewSkill.name} (copy)” and open it for editing`}
              >
                {duplicating && <span className="spinner" aria-hidden="true" />}
                {duplicating ? 'Duplicating…' : 'Duplicate'}
              </button>
              <button type="button" className="btn" onClick={closeDialog} disabled={duplicating}>
                Close
              </button>
              <button
                type="button"
                className="btn btn--primary"
                disabled={duplicating}
                onClick={() => {
                  setServerError(null)
                  setDialog({ mode: 'edit', skill: viewSkill })
                }}
              >
                Edit
              </button>
            </>
          )
        }
      >
        {viewSkill &&
          (() => {
            const users = usedBy.get(viewSkill.id) ?? []
            return (
              <>
                <div className="skillview__head">
                  {viewSkill.tag && (
                    <div className="skillview__top">
                      <span className="pill">{viewSkill.tag}</span>
                    </div>
                  )}
                  <p className="tile__desc">{viewSkill.description || 'No description yet.'}</p>
                  <p className="skillview__usedby">
                    {users.length > 0 ? `Used by: ${users.join(', ')}` : 'Not attached to any agent'}
                  </p>
                  {isBuiltIn(viewSkill) && <p className="notice notice--info">{BUILT_IN_HINT}</p>}
                </div>
                <div className="field">
                  <p className="field__label">Tools</p>
                  <div className="chips">{(viewSkill.tools ?? []).map((tool) => <span className="pill" key={tool.name} title={tool.description}>{tool.name}</span>)}</div>
                  {(viewSkill.tools ?? []).length === 0 && <p className="field__hint">No tools declared.</p>}
                </div>
                <pre className="skillview__content">{viewSkill.content ?? ''}</pre>
                {serverError && (
                  <p className="field__err skillview__err" role="alert">
                    {serverError}
                  </p>
                )}
              </>
            )
          })()}
      </Dialog>

      <ConfirmDialog
        open={dialog?.mode === 'delete'}
        title={dialog?.mode === 'delete' ? `Delete ${dialog.skill.name}?` : ''}
        subtitle="Agents using this skill lose it on their next run."
        confirmLabel="Delete skill"
        loading={deleting}
        onCancel={() => {
          if (!deleting) setDialog(null)
        }}
        onConfirm={() => {
          if (dialog?.mode === 'delete') void remove(dialog.skill)
        }}
      >
        {dialog?.mode === 'delete' &&
          (() => {
            const users = usedBy.get(dialog.skill.id) ?? []
            return (
              <>
                {users.length === 0 ? (
                  <p className="prose">No agent uses this skill, so deleting it cannot affect anyone.</p>
                ) : (
                  <>
                    <p className="field__err" style={{ margin: 0, marginBottom: 10 }}>
                      Used by {users.length} agent{users.length === 1 ? '' : 's'}:
                    </p>
                    <ul style={{ margin: 0, paddingLeft: 20 }}>
                      {users.map((n) => (
                        <li key={n}>{n}</li>
                      ))}
                    </ul>
                    <p className="field__hint">These agents keep working without it. Deletion cannot be undone.</p>
                  </>
                )}
                {serverError && (
                  <p className="field__err" role="alert">
                    {serverError}
                  </p>
                )}
              </>
            )
          })()}
      </ConfirmDialog>

      <Dialog
        open={dialog?.mode === 'import'}
        title="Import SKILL.md"
        subtitle="Paste a SKILL.md file — frontmatter becomes the name and description, the body becomes the content."
        onClose={closeDialog}
        footer={
          <>
            <button type="button" className="btn" onClick={closeDialog} disabled={importing}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void runImport()}
              disabled={importing || !importText.trim() || (preview !== null && 'error' in preview)}
            >
              {importing && <span className="spinner" aria-hidden="true" />}
              {importing ? 'Importing…' : 'Import skill'}
            </button>
          </>
        }
      >
        <div className="field">
          <label className="field__label" htmlFor="sk-import">
            SKILL.md text
          </label>
          <textarea
            id="sk-import"
            className="textarea textarea--mono"
            rows={12}
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            placeholder={'---\nname: my-skill\ndescription: What it does\n---\n\nInstructions the agent follows.'}
          />
          <p className="field__hint">{DISCOVERY_HINT}</p>
        </div>

        {preview !== null &&
          ('error' in preview ? (
            <p className="field__err" role="alert">
              {preview.error}
            </p>
          ) : (
            <div className="importpreview">
              <p className="field__label">Preview — what will be saved</p>
              <p className="row__label">{preview.name}</p>
              <p className="row__hint">{preview.description}</p>
              {preview.tools.length > 0 && (registry.loading ? <p className="field__hint">Loading tool preview…</p> : registry.error ? (
                <ErrorState error={registry.error} onRetry={registry.reload} />
              ) : (() => {
                const resolved = classifyImportTools(preview.tools, registry.data ?? [])
                return <>
                  <p className="field__label">Tools to import</p>
                  <div className="chips">{resolved.tools.map((name) => <span className="pill" key={name}>{name}</span>)}</div>
                  {resolved.tools.length === 0 && <p className="field__hint">No recognized tools declared.</p>}
                  {resolved.ignored.length > 0 && <p className="field__hint">Ignored (unavailable or over the 16-tool limit): {resolved.ignored.join(', ')}</p>}
                </>
              })())}
              <pre className="tile__preview">
                {preview.content.slice(0, 240)}
                {preview.content.length > 240 ? '…' : ''}
              </pre>
            </div>
          ))}

        {importError && (
          <p className="field__err" role="alert">
            {importError}
          </p>
        )}
      </Dialog>
    </PageShell>
  )
}
