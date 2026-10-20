import { useState } from 'react'
import Toggle from './Toggle'
import { SearchIcon } from '../icons'
import { agentChatFirstFields, botFolder } from '../../lib/agent-put'
import type { AgentChange } from '../../lib/agent-patch'
import { friendlyError as friendly } from '../../lib/chat-format'
import {
  MEMORY_CATEGORIES, MEMORY_MAX_CHARS, categoryLabel, dropMemory, memorySourceLine, memoryView, upsertMemory, validateMemoryText,
  type MemoryFilter, type MemoryLoad, type memoryApi,
} from '../../lib/memory'
import type { Agent, MemoryCategory, MemoryItem } from '../../lib/types'

type Props = {
  agent: Agent
  load: MemoryLoad | null
  api: ReturnType<typeof memoryApi>
  onRetry: () => void
  onItems: (items: MemoryItem[]) => void
  onAgentSaved: (a: Agent) => void
  /** PATCH /api/agents/:id (BE-4), PUT fallback before it lands. */
  saveChange: (agent: Agent, change: AgentChange) => Promise<{ agent: Agent }>
}

type Editing = { id: string | null; text: string; category: MemoryCategory; error: string | null; saving: boolean }

/** 03b: what this bot remembers (BE-4), plus "Learn from chat" (BE-1 `memoryLearn`). */
export default function MemoryTab({ agent, load, api, onRetry, onItems, onAgentSaved, saveChange }: Props) {
  const { slug, memoryLearn } = agentChatFirstFields(agent)
  const [learn, setLearn] = useState(memoryLearn)
  const [learnSaving, setLearnSaving] = useState(false)
  const [learnError, setLearnError] = useState<string | null>(null)
  const [filter, setFilter] = useState<MemoryFilter>({ query: '', category: 'all' })
  const [editing, setEditing] = useState<Editing | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null)

  const items = load?.status === 'ok' ? load.page.items : []
  const view = memoryView(items, filter)
  const folder = botFolder(slug)

  const saveLearn = async (on: boolean) => {
    setLearn(on)
    setLearnSaving(true)
    setLearnError(null)
    try {
      onAgentSaved((await saveChange(agent, { memoryLearn: on })).agent)
    } catch (err) {
      setLearn(!on)
      setLearnError(friendly(err, 'Could not save the setting.'))
    } finally {
      setLearnSaving(false)
    }
  }

  const submitEdit = async () => {
    if (!editing) return
    const problem = validateMemoryText(editing.text)
    if (problem) {
      setEditing({ ...editing, error: problem })
      return
    }
    setEditing({ ...editing, saving: true, error: null })
    try {
      const body = { text: editing.text.trim(), category: editing.category }
      const saved = editing.id ? await api.update(agent.id, editing.id, body) : await api.create(agent.id, body)
      onItems(upsertMemory(items, saved))
      setEditing(null)
    } catch (err) {
      setEditing({ ...editing, saving: false, error: friendly(err, 'Could not save this memory.') })
    }
  }

  const remove = async (id: string) => {
    setRowError(null)
    try {
      await api.remove(agent.id, id)
      onItems(dropMemory(items, id))
      setConfirmDelete(null)
    } catch (err) {
      setRowError({ id, message: friendly(err, 'Could not delete this memory.') })
    }
  }

  const editor = (e: Editing) => (
    <form
      className="cf-mem__edit"
      onSubmit={(ev) => {
        ev.preventDefault()
        void submitEdit()
      }}
    >
      <textarea
        className="input"
        value={e.text}
        onChange={(ev) => setEditing({ ...e, text: ev.target.value, error: null })}
        rows={2}
        maxLength={MEMORY_MAX_CHARS + 50}
        aria-label="Memory text"
        autoFocus
        placeholder={`Something ${agent.name} should remember…`}
      />
      <div className="cf-mem__editbar">
        <select className="input cf-mem__cat" value={e.category} onChange={(ev) => setEditing({ ...e, category: ev.target.value as MemoryCategory })} aria-label="Category">
          {MEMORY_CATEGORIES.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
        <span className="cf-mem__len">
          {e.text.trim().length}/{MEMORY_MAX_CHARS}
        </span>
        <span className="cf-grow" />
        <button type="button" className="btn" onClick={() => setEditing(null)} disabled={e.saving}>
          Cancel
        </button>
        <button type="submit" className="btn btn--primary" disabled={e.saving}>
          {e.saving ? 'Saving…' : e.id ? 'Save' : 'Add'}
        </button>
      </div>
      {e.error && <p className="field__err" role="alert">{e.error}</p>}
    </form>
  )

  return (
    <div className="cf-set__stack">
      <div className="cf-mem__head">
        <div>
          <h3 className="cf-mem__title">What {agent.name} remembers</h3>
          <p className="cf-mem__sub">
            Private to {agent.name}.{folder && <> Saved in <code>{folder}memory/</code>.</>}
          </p>
        </div>
        <label className="cf-mem__learn">
          <span>Learn from chat</span>
          <Toggle on={learn} onChange={(v) => void saveLearn(v)} label="Learn from chat" disabled={learnSaving} />
        </label>
      </div>
      {learnError && <p className="field__err" role="alert">{learnError}</p>}

      {load === null ? (
        <p className="cf-set__muted" role="status">Loading memory…</p>
      ) : load.status === 'unavailable' ? (
        <div className="notice notice--info cf-set__notice" role="status">
          Memory isn&apos;t available on this server yet (it arrives with BE-4). &ldquo;Learn from chat&rdquo; is still saved to the bot.
        </div>
      ) : load.status === 'error' ? (
        <div className="notice notice--warn cf-set__notice" role="alert">
          Could not load memory: {load.message}{' '}
          <button type="button" className="btn btn--sm" onClick={onRetry}>
            Retry
          </button>
        </div>
      ) : (
        <>
          <div className="cf-set__bar">
            <label className="cf-search cf-search--boxed cf-grow">
              <SearchIcon size={13} />
              <input
                value={filter.query}
                onChange={(e) => setFilter((f) => ({ ...f, query: e.target.value }))}
                placeholder="Search memory"
                aria-label="Search memory"
                type="search"
              />
            </label>
            <button
              type="button"
              className="btn"
              onClick={() => setEditing({ id: null, text: '', category: filter.category === 'all' ? 'about-you' : filter.category, error: null, saving: false })}
              disabled={editing !== null}
            >
              ＋ Add memory
            </button>
          </div>
          <div className="cf-chips" role="group" aria-label="Filter by category">
            {view.chips.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`cf-chip${filter.category === c.id ? ' cf-chip--on' : ''}`}
                aria-pressed={filter.category === c.id}
                onClick={() => setFilter((f) => ({ ...f, category: c.id }))}
              >
                {c.label} {c.count}
              </button>
            ))}
          </div>
          {editing && editing.id === null && <div className="cf-card cf-mem__row">{editor(editing)}</div>}
          <ul className="cf-mem__list">
            {view.shown.map((m) => (
              <li key={m.id} className="cf-card cf-mem__row">
                {editing?.id === m.id ? (
                  editor(editing)
                ) : (
                  <>
                    <span className="cf-mem__pill">{categoryLabel(m.category)}</span>
                    <div className="cf-mem__text">
                      <p>{m.text}</p>
                      <p className="cf-mem__src">{memorySourceLine(m)}</p>
                      {confirmDelete === m.id && (
                        <p className="cf-mem__confirm">
                          Delete this memory?{' '}
                          <button type="button" className="btn btn--sm btn--danger" onClick={() => void remove(m.id)}>
                            Delete
                          </button>{' '}
                          <button type="button" className="btn btn--sm" onClick={() => setConfirmDelete(null)}>
                            Keep
                          </button>
                        </p>
                      )}
                      {rowError?.id === m.id && <p className="field__err" role="alert">{rowError.message}</p>}
                    </div>
                    <span className="cf-mem__acts">
                      <button
                        type="button"
                        className="cf-iconbtn"
                        aria-label="Edit memory"
                        onClick={() => setEditing({ id: m.id, text: m.text, category: m.category, error: null, saving: false })}
                        disabled={editing !== null}
                      >
                        ✎
                      </button>
                      <button type="button" className="cf-iconbtn" aria-label="Delete memory" onClick={() => setConfirmDelete(m.id)}>
                        ×
                      </button>
                    </span>
                  </>
                )}
              </li>
            ))}
          </ul>
          {items.length === 0 && !editing ? (
            <p className="cf-set__muted">
              Nothing yet. {learn ? `${agent.name} saves things worth remembering as you chat, or add one yourself.` : 'Add something, or turn on Learn from chat.'}
            </p>
          ) : view.shown.length === 0 && items.length > 0 ? (
            <p className="cf-set__muted">No memories match.</p>
          ) : null}
          {items.length > 0 && (
            <p className="cf-set__foot">
              Showing {view.shown.length} of {items.length} · Group chats keep their own memory, separate from this
              {load.page.promptTokens ? ` · ≈${load.page.promptTokens.toLocaleString()} tokens in the prompt` : ''}
            </p>
          )}
        </>
      )}
    </div>
  )
}
