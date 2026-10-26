import { useState } from 'react'
import Toggle from './Toggle'
import { SearchIcon } from '../icons'
import { agentChatFirstFields, botFolder } from '../../lib/agent-put'
import { saveLearnToggle, type AgentChange } from '../../lib/agent-patch'
import { friendlyError as friendly } from '../../lib/chat-format'
import {
  MEMORY_CATEGORIES, MEMORY_MAX_CHARS, categoryLabel, dropMemory, memoryFooter, memorySourceLine, memoryView, upsertMemory, validateMemoryText,
  type MemoryFilter, type MemoryLoad, type memoryApi,
} from '../../lib/memory'
import type { Agent, GroupConversation, MemoryCategory, MemoryItem } from '../../lib/types'
import Avatar from '../Avatar'
import UserAvatar from '../shell/UserAvatar'
import { groupMemorySourceLine } from '../../lib/memory'
import { nameOf } from '../../lib/groups'
import { useProfile } from '../../state/profile-context'
import { displayName } from '../../lib/profile'

/** FE-6 (06d): the same tab for a group's own memory (BE-5 /api/groups/:id/memory). */
export type GroupMemoryOwner = {
  group: GroupConversation
  agents: readonly Agent[]
  /** PATCH /api/groups/:id { memoryLearn }; resolves with the saved value. */
  saveLearn: (on: boolean) => Promise<boolean>
}

type Props = {
  agent?: Agent
  group?: GroupMemoryOwner
  load: MemoryLoad | null
  api: ReturnType<typeof memoryApi>
  /** Re-list (Retry, and after every change so total and promptTokens follow the server). */
  onRetry: () => void
  onItems: (items: MemoryItem[]) => void
  onAgentSaved?: (a: Agent) => void
  /** PATCH /api/agents/:id (BE-4); no PUT fallback. */
  saveChange?: (agent: Agent, change: AgentChange) => Promise<{ agent: Agent }>
}

type Editing = { id: string | null; text: string; category: MemoryCategory; error: string | null; saving: boolean }

/** 03b: what this bot remembers (BE-4), plus "Learn from chat" (BE-1 `memoryLearn`). */
export default function MemoryTab({ agent, group, load, api, onRetry, onItems, onAgentSaved, saveChange }: Props) {
  const fields = agent ? agentChatFirstFields(agent) : null
  const slug = group ? group.group.slug : (fields?.slug ?? '')
  const memoryLearn = group ? group.group.memoryLearn : (fields?.memoryLearn ?? false)
  const ownerName = group ? group.group.name : (agent?.name ?? '')
  const owner = group ? { groupId: group.group.id } : (agent?.id ?? '')
  const { profile } = useProfile()
  const [learn, setLearn] = useState(memoryLearn)
  const [learnSaving, setLearnSaving] = useState(false)
  const [learnError, setLearnError] = useState<string | null>(null)
  const [filter, setFilter] = useState<MemoryFilter>({ query: '', category: 'all' })
  const [editing, setEditing] = useState<Editing | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null)

  const items = load?.status === 'ok' ? load.page.items : []
  const view = memoryView(items, filter)
  const folder = group ? `groups/${slug}/` : botFolder(slug)

  const saveLearn = async (on: boolean) => {
    setLearn(on)
    setLearnSaving(true)
    setLearnError(null)
    if (group) {
      try {
        setLearn(await group.saveLearn(on))
      } catch (err) {
        setLearn(!on)
        setLearnError(friendly(err, 'Could not save the setting.'))
      }
      setLearnSaving(false)
      return
    }
    if (!agent || !saveChange) return setLearnSaving(false)
    const res = await saveLearnToggle((change) => saveChange(agent, change), on, (err) => friendly(err, 'Could not save the setting.'))
    setLearn(res.learn)
    setLearnError(res.error)
    if (res.agent) onAgentSaved?.(res.agent)
    setLearnSaving(false)
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
      const saved = editing.id ? await api.update(owner, editing.id, body) : await api.create(owner, body)
      onItems(upsertMemory(items, saved))
      setEditing(null)
      onRetry()
    } catch (err) {
      // GAP-M2: a full scope is a 409 with the server's "Memory is full (200 items)…" message.
      setEditing({ ...editing, saving: false, error: friendly(err, 'Could not save this memory.') })
    }
  }

  const remove = async (id: string) => {
    setRowError(null)
    try {
      await api.remove(owner, id)
      onItems(dropMemory(items, id))
      setConfirmDelete(null)
      onRetry()
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
        placeholder={group ? 'Something this group should remember…' : `Something ${ownerName} should remember…`}
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
          <h3 className="cf-mem__title">What {ownerName} remembers</h3>
          {group ? (
            <p className="cf-mem__sub">
              Shared by everyone in this group, and kept apart from each bot&apos;s private memory. Saved in <code>{folder}memory/</code>.
            </p>
          ) : (
            <p className="cf-mem__sub">
              Private to {ownerName}.{folder && <> Saved in <code>{folder}memory/</code>.</>}
            </p>
          )}
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
                placeholder={group ? 'Search group memory' : 'Search memory'}
                aria-label={group ? 'Search group memory' : 'Search memory'}
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
          {!group && <div className="cf-chips" role="group" aria-label="Filter by category">
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
          </div>}
          {editing && editing.id === null && <div className="cf-card cf-mem__row">{editor(editing)}</div>}
          <ul className="cf-mem__list">
            {view.shown.map((m) => (
              <li key={m.id} className="cf-card cf-mem__row">
                {editing?.id === m.id ? (
                  editor(editing)
                ) : (
                  <>
                    {group ? (
                      <span className="cf-mem__who">
                        {m.source.kind === 'user' ? (
                          <UserAvatar profile={profile} name={displayName(profile)} />
                        ) : (
                          <MemberAvatar id={m.source.agentId} agents={group.agents} />
                        )}
                      </span>
                    ) : (
                      <span className="cf-mem__pill">{categoryLabel(m.category)}</span>
                    )}
                    <div className="cf-mem__text">
                      <p>{m.text}</p>
                      <p className="cf-mem__src">{group ? groupMemorySourceLine(m, (id) => nameOf(id, group.agents)) : memorySourceLine(m)}</p>
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
              {/* GAP-G13: group memory empty state. */}
              Nothing yet. {group ? (learn ? 'Bots in this group save what the whole group should know as you chat, or add one yourself.' : 'Add something, or turn on Learn from chat.') : learn ? `${ownerName} saves things worth remembering as you chat, or add one yourself.` : 'Add something, or turn on Learn from chat.'}
            </p>
          ) : view.shown.length === 0 && items.length > 0 ? (
            <p className="cf-set__muted">No memories match.</p>
          ) : null}
          {items.length > 0 && (
            <p className="cf-set__foot">
              {group
                ? `Showing ${view.shown.length} of ${Math.max(load.page.total, items.length)} · Only members of this group can read it`
                : memoryFooter(view.shown.length, Math.max(load.page.total, items.length), load.page.promptTokens)}
            </p>
          )}
        </>
      )}
    </div>
  )
}

function MemberAvatar({ id, agents }: { id: string; agents: readonly Agent[] }) {
  const a = agents.find((x) => x.id === id)
  return <Avatar name={a?.name ?? nameOf(id, agents)} agentId={a?.id} avatar={a?.avatar} color={a?.color} size="sm" decorative />
}
