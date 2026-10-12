import { useCallback, useMemo, useState } from 'react'
import PageShell from '../components/PageShell'
import Dialog from '../components/Dialog'
import ConfirmDialog from '../components/ConfirmDialog'
import { EmptyState, ErrorState, Skeleton } from '../components/States'
import { NotesIcon, SearchIcon } from '../components/icons'
import { useAsync } from '../hooks/useAsync'
import { api } from '../lib/api'
import { filterNotes } from '../lib/notes'
import type { NoteSummary } from '../lib/types'

function NoteDetail({ id }: { id: string }) {
  const loader = useCallback(() => api.getNote(id), [id])
  const note = useAsync(loader, [id])
  if (note.loading) return <Skeleton height={120} />
  if (note.error) return <ErrorState error={note.error} onRetry={note.reload} />
  if (!note.data) return null
  return (
    <>
      <p className="field__hint">By {note.data.authorName ?? (note.data.authorAgentId || 'Unknown agent')} · Updated {formatDate(note.data.updatedAt)}</p>
      <div className="chips">{note.data.tags.map((tag) => <span className="pill" key={tag}>{tag}</span>)}</div>
      <pre className="skillview__content">{note.data.body}</pre>
    </>
  )
}

function formatDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Unknown date' : date.toLocaleString()
}

export default function Notes() {
  const notes = useAsync(api.listNotes, [])
  const [query, setQuery] = useState('')
  const [dialog, setDialog] = useState<{ mode: 'view' | 'delete'; note: NoteSummary } | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const visible = useMemo(() => filterNotes(notes.data ?? [], query), [notes.data, query])
  const close = () => {
    if (deleting) return
    setDialog(null)
    setError(null)
  }
  const remove = async () => {
    if (!dialog || deleting) return
    setDeleting(true)
    setError(null)
    try {
      await api.deleteNote(dialog.note.id)
      setDialog(null)
      notes.reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the note.')
    } finally {
      setDeleting(false)
    }
  }
  return (
    <PageShell eyebrow="Workspace" title="Notes" subtitle="Shared workspace memory written by your agents. Read saved notes or remove those you no longer need."
      actions={<div className="search"><span className="search__icon"><SearchIcon size={15} /></span>
        <input type="search" aria-label="Search notes" placeholder="Search titles, tags, authors, snippets…" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>}>
      {notes.loading ? <div className="grid">{[0, 1, 2].map((n) => <div className="skel-card" key={n}><Skeleton height={13} /><Skeleton height={9} /></div>)}</div>
        : notes.error ? <ErrorState error={notes.error} onRetry={notes.reload} />
        : (notes.data ?? []).length === 0 ? <EmptyState icon={<NotesIcon size={20} />} title="No notes yet" text="Agents with note tools can save useful information here during a run." />
        : visible.length === 0 ? <EmptyState icon={<SearchIcon size={20} />} title="No notes match" text="Search matches titles, tags, authors, and visible snippets. Try another search."
          actions={<button type="button" className="btn" onClick={() => setQuery('')}>Clear search</button>} />
        : <div className="grid">{visible.map((note) => (
          <button type="button" className="tile" key={note.id} onClick={() => { setError(null); setDialog({ mode: 'view', note }) }}>
            <div className="tile__top"><span className="tile__icon"><NotesIcon size={16} /></span><span className="tile__name">{note.title}</span></div>
            <p className="tile__desc">{note.snippet || 'Empty note.'}</p>
            <div className="chips">{note.tags.map((tag) => <span className="pill" key={tag}>{tag}</span>)}</div>
            <div className="tile__meta"><span>{note.authorName ?? (note.authorAgentId || 'Unknown agent')}</span><span>·</span><span>{note.chars.toLocaleString()} characters</span></div>
            <p className="field__hint">Updated {formatDate(note.updatedAt)}</p>
          </button>
        ))}</div>}
      <Dialog open={dialog?.mode === 'view'} title={dialog?.note.title ?? ''} onClose={close}
        footer={<><button type="button" className="btn btn--danger" onClick={() => { if (dialog) setDialog({ ...dialog, mode: 'delete' }) }}>Delete…</button><button type="button" className="btn" onClick={close}>Close</button></>}>
        {dialog?.mode === 'view' && <NoteDetail key={dialog.note.id} id={dialog.note.id} />}
      </Dialog>
      <ConfirmDialog open={dialog?.mode === 'delete'} title={`Delete ${dialog?.note.title ?? 'note'}?`} subtitle="This removes the shared note from the workspace."
        confirmLabel="Delete note" loading={deleting} onCancel={close} onConfirm={() => void remove()}>
        <p className="prose">Agents will no longer be able to read this note. This cannot be undone.</p>
        {error && <p className="field__err" role="alert">{error}</p>}
      </ConfirmDialog>
    </PageShell>
  )
}
