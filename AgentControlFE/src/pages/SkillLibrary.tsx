import { useMemo, useState, type FormEvent, type ReactNode } from 'react'
import PageShell from '../components/PageShell'
import Dialog from '../components/Dialog'
import ConfirmDialog from '../components/ConfirmDialog'
import { EmptyState, ErrorState, Skeleton } from '../components/States'
import { PlusIcon, SkillLibraryIcon } from '../components/icons'
import { api } from '../lib/api'
import type { Skill, SkillInput } from '../lib/types'
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

type SkillPreview = { name: string; description: string; content: string }

/** Mirrors the BE's SKILL.md parser so the preview matches what import will save. */
function parsePreview(markdown: string): SkillPreview | { error: string } {
  const text = markdown.replace(/\r\n/g, '\n').trim()
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text)
  if (!match) {
    return { error: 'SKILL.md has no frontmatter block — start the file with a "--- name … ---" header.' }
  }
  const meta: Record<string, string> = {}
  for (const line of (match[1] ?? '').split('\n')) {
    if (/^\s/.test(line)) continue
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim()
    if (key) meta[key] = value
  }
  if (!meta.name) return { error: 'SKILL.md frontmatter is missing a "name" field.' }
  if (!meta.description) return { error: 'SKILL.md frontmatter is missing a "description" field.' }
  const content = text.slice(match[0].length).replace(/^\n+/, '').trimEnd()
  return { name: meta.name, description: meta.description, content }
}

function SkillForm({
  initial,
  saving,
  serverError,
  onSubmit,
}: {
  initial: Skill | null
  saving: boolean
  serverError: string | null
  onSubmit: (input: SkillInput) => void
}) {
  const [name, setName] = useState(initial?.name ?? '')
  const [tag, setTag] = useState(initial?.tag ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [content, setContent] = useState(initial?.content ?? '')
  const [errors, setErrors] = useState<{ name?: string; content?: string }>({})

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const next: typeof errors = {}
    if (!name.trim()) next.name = 'Give the skill a name.'
    if (!content.trim()) next.content = 'Skills need content — it is injected into the run prompt.'
    setErrors(next)
    if (Object.keys(next).length > 0) return
    onSubmit({ name: name.trim(), tag: tag.trim(), description: description.trim(), content: content.trim() })
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

      <div className="field">
        <p className="field__label">Tools</p>
        {initial && initial.tools.length > 0 ? (
          <>
            <div className="rows">
              {initial.tools.map((t) => (
                <div className="row" key={t.name}>
                  <div className="row__text">
                    <p className="row__label meta__v--mono">{t.name}</p>
                    {t.description && <p className="row__hint">{t.description}</p>}
                  </div>
                </div>
              ))}
            </div>
            <p className="field__hint">Declared only — tool execution is coming soon.</p>
          </>
        ) : (
          <p className="field__hint">No tools declared. Tool execution is coming soon.</p>
        )}
      </div>

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
  | { mode: 'edit'; skill: Skill }
  | { mode: 'delete'; skill: Skill }
  | { mode: 'import' }
  | null

export default function SkillLibrary() {
  const skills = useAsync(api.listSkills, [])
  const agents = useAsync(api.listAgents, [])

  const [dialog, setDialog] = useState<DialogState>(null)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)

  const [importText, setImportText] = useState('')
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)

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

  const closeDialog = () => {
    if (saving || deleting || importing) return
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
        <div className="grid">
          {(skills.data ?? []).map((s) => {
            const users = usedBy.get(s.id) ?? []
            return (
              <button
                type="button"
                className="tile"
                key={s.id}
                onClick={() => {
                  setServerError(null)
                  setDialog({ mode: 'edit', skill: s })
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
                  {s.content.slice(0, 160)}
                  {s.content.length > 160 ? '…' : ''}
                </pre>
                <div className="tile__meta">
                  <span>
                    Used by {users.length} agent{users.length === 1 ? '' : 's'}
                  </span>
                  <span>·</span>
                  <span className="pill" title="Declared only — tool execution is coming soon.">
                    {s.tools.length} {s.tools.length === 1 ? 'tool' : 'tools'} · execution coming soon
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
        {dialog?.mode === 'edit' && (
          <SkillForm key={dialog.skill.id} initial={dialog.skill} saving={saving} serverError={serverError} onSubmit={(input) => void save(input)} />
        )}
        {dialog?.mode === 'create' && (
          <SkillForm key="create" initial={null} saving={saving} serverError={serverError} onSubmit={(input) => void save(input)} />
        )}
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
