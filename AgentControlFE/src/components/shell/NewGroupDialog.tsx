import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Dialog from '../Dialog'
import Avatar from '../Avatar'
import { api } from '../../lib/api'
import { friendlyError as friendly } from '../../lib/chat-format'
import { MAX_GROUP_BOTS, createGroupBody, createGroupError, isLocked, pickerInitial, suggestName, togglePick } from '../../lib/groups'
import { useConversations } from '../../state/conversations-context'
import type { Agent } from '../../lib/types'

/**
 * GAP-G4 · not in mockups: "＋ New group" / `/group` opens this picker. Primary is
 * preselected and locked (it leads every group, BE-5); 2–8 bots; POST /api/groups.
 */
export default function NewGroupDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null
  return <NewGroupBody onClose={onClose} />
}

const roleOf = (a: Agent) => (a.role || a.description || '').replace(/\s+/g, ' ').trim()

function NewGroupBody({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate()
  const { agents, reload, upsert } = useConversations()
  const [selected, setSelected] = useState<string[]>(() => pickerInitial(agents))
  const [name, setName] = useState('')
  const [nameTouched, setNameTouched] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const shownName = nameTouched ? name : suggestName(selected, agents)
  const problem = createGroupError(shownName, selected, agents)
  // Primary first, then the rest by name; hidden bots last.
  const list = [...agents].sort((a, b) => Number(Boolean(b.isPrimary)) - Number(Boolean(a.isPrimary)) || Number(Boolean(a.hidden)) - Number(Boolean(b.hidden)) || a.name.localeCompare(b.name))
  const full = selected.length >= MAX_GROUP_BOTS

  const create = async () => {
    if (problem || saving) return setError(problem)
    setSaving(true)
    setError(null)
    try {
      const group = await api.createGroup(createGroupBody(shownName, selected, agents))
      upsert(group)
      reload()
      onClose()
      navigate(`/c/${encodeURIComponent(group.id)}`)
    } catch (err) {
      setError(friendly(err, 'Could not create the group.'))
      setSaving(false)
    }
  }

  return (
    <Dialog
      open
      title="New group"
      subtitle="Primary leads every group. Pick who else joins."
      onClose={onClose}
      footer={
        <>
          <span className="cf-ng__count">
            {selected.length} of {MAX_GROUP_BOTS} bots
          </span>
          <span className="cf-grow" />
          <button type="button" className="btn" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" onClick={() => void create()} disabled={saving || problem !== null}>
            {saving ? 'Creating…' : 'Create group'}
          </button>
        </>
      }
    >
      <div className="cf-ng" data-gap="GAP-G4">
        <label className="field">
          <span className="field__label">Group name</span>
          <input
            className="input"
            value={shownName}
            maxLength={80}
            placeholder="Harbor team"
            onChange={(e) => {
              setNameTouched(true)
              setName(e.target.value)
              setError(null)
            }}
            onKeyDown={(e) => e.key === 'Enter' && void create()}
            autoFocus
          />
        </label>
        <p className="field__label">Members</p>
        <ul className="cf-ng__list" aria-label="Bots">
          {list.map((a) => {
            const on = selected.includes(a.id)
            const locked = isLocked(a.id, agents)
            return (
              <li key={a.id}>
                <label className={`cf-ng__row${on ? ' is-on' : ''}${locked ? ' is-locked' : ''}`}>
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={locked || (!on && full) || saving}
                    onChange={() => {
                      setSelected((s) => togglePick(s, a.id, agents))
                      setError(null)
                    }}
                  />
                  <Avatar name={a.name} agentId={a.id} avatar={a.avatar} color={a.color} size="sm" decorative />
                  <span className="cf-ng__txt">
                    <span className="cf-ng__name">
                      {a.name}
                      {locked && <span className="cf-pill">★ Leads the group</span>}
                    </span>
                    <span className="cf-ng__sub">{locked ? 'Always in the group' : roleOf(a) || (a.hidden ? 'Hidden from the chat list' : '')}</span>
                  </span>
                </label>
              </li>
            )
          })}
        </ul>
        {error && <p className="field__err" role="alert">{error}</p>}
        {!error && problem && selected.length > 0 && nameTouched && <p className="cf-ng__hint">{problem}</p>}
      </div>
    </Dialog>
  )
}
