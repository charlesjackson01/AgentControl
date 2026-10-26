import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Avatar from '../Avatar'
import { Confirm } from '../Confirm'
import GroupAvatar from '../shell/GroupAvatar'
import UserAvatar from '../shell/UserAvatar'
import MemoryTab from './MemoryTab'
import FilesTab from './FilesTab'
import Toggle from './Toggle'
import { api, putRaw, request, serverMessage } from '../../lib/api'
import { friendlyError as friendly } from '../../lib/chat-format'
import { memoryApi, type MemoryLoad } from '../../lib/memory'
import { filesApi, filesTotal } from '../../lib/files'
import {
  GROUP_TABS,
  MAX_GROUP_BOTS,
  MAX_GROUP_NAME,
  MIN_GROUP_BOTS,
  addableBots,
  groupPanelSub,
  memberRule,
  membersCount,
  orderedMembers,
  withMembers,
  withoutMember,
  type GroupTab,
} from '../../lib/groups'
import { displayName } from '../../lib/profile'
import type { Agent, ConversationSummary, GroupConversation, GroupPatch, GroupSummary } from '../../lib/types'
import { useProfile } from '../../state/profile-context'
import { useMutedGroups, useSetMuted } from '../../hooks/useMutedGroups'

const memory = memoryApi(request)
const files = filesApi(request, putRaw, serverMessage)

type Group = ConversationSummary & GroupConversation

type Props = {
  group: Group
  agents: readonly Agent[]
  tab: GroupTab
  onTab: (tab: GroupTab) => void
  filesPath?: string
  onFilesPath?: (path: string) => void
  onClose: () => void
  /** After a PATCH, with the saved group. */
  onSaved: (g: GroupSummary) => void
  onDeleted: () => void
}

/** FE-6 group panel (06b–06d): Members, Memory, Shared files, Settings (GAP-G5). Same 720 px slide-over as FE-3. */
export default function GroupSettingsPanel({ group: fromList, agents, tab, onTab, filesPath = 'shared', onFilesPath, onClose, onSaved, onDeleted }: Props) {
  const [saved, setSaved] = useState<GroupSummary | null>(null)
  const group: Group = saved && saved.id === fromList.id && saved.updatedAt >= fromList.updatedAt ? { ...fromList, ...saved } : fromList
  const [mem, setMem] = useState<MemoryLoad | null>(null)
  const [memAttempt, setMemAttempt] = useState(0)
  const [filesCount, setFilesCount] = useState<number | undefined>(undefined)
  const navigate = useNavigate()
  const muted = useMutedGroups().has(group.id)
  const setMuted = useSetMuted()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    files.list({ groupId: fromList.id }, '').then(
      (l) => live && setFilesCount(filesTotal(l)),
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [fromList.id])
  const onFilesTotal = useCallback((n: number | undefined) => setFilesCount(n), [])

  useEffect(() => {
    let live = true
    void memory.list({ groupId: fromList.id }).then((r) => live && setMem(r))
    return () => {
      live = false
    }
  }, [fromList.id, memAttempt])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('.dialog-backdrop, [role="alertdialog"]')) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const patch = useCallback(
    async (body: GroupPatch): Promise<GroupSummary> => {
      const g = await api.updateGroup(fromList.id, body)
      setSaved(g)
      onSaved(g)
      return g
    },
    [fromList.id, onSaved],
  )

  const deleteGroup = async () => {
    setDeleting(true)
    setDeleteError(null)
    try {
      await api.deleteGroup(group.id)
      setMuted(group.id, false)
      onDeleted()
      navigate('/', { replace: true })
    } catch (err) {
      setDeleteError(friendly(err, 'Could not delete the group.'))
      setDeleting(false)
    }
  }

  const sub = groupPanelSub(group, agents)
  const counts: Partial<Record<GroupTab, number>> = {
    // 06b "Members 4": you plus the bots.
    members: group.memberAgentIds.length + 1,
    memory: mem?.status === 'ok' ? mem.page.total : undefined,
    files: filesCount,
  }

  const footer = (
    <div className="cf-gset__foot">
      <button type="button" className="btn" aria-pressed={muted} onClick={() => setMuted(group.id, !muted)}>
        {muted ? 'Unmute notifications' : 'Mute notifications'}
      </button>
      <span className="cf-grow" />
      <button type="button" className="btn cf-gset__del" onClick={() => setConfirmDelete(true)}>
        Delete group
      </button>
    </div>
  )

  return (
    <>
      <div className="cf-set-scrim" onMouseDown={onClose} aria-hidden="true" />
      <aside className="cf-set" role="dialog" aria-modal="true" aria-label={`${group.name} settings`}>
        <header className="cf-set__hdr">
          <GroupAvatar memberAgentIds={group.memberAgentIds} leadAgentId={group.leadAgentId} agents={[...agents]} size="lg" />
          <div className="cf-set__who">
            <h2 className="cf-set__name">{group.name}</h2>
            <p className="cf-set__sub">
              {sub.text}
              {sub.folder && <code>{sub.folder}</code>}
            </p>
          </div>
          <button type="button" className="cf-set__x" onClick={onClose} aria-label="Close settings">
            ×
          </button>
        </header>
        <nav className="cf-set__tabs" role="tablist" aria-label="Group sections">
          {GROUP_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`cf-set-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls="cf-set-body"
              className={`cf-set__tab${tab === t.id ? ' cf-set__tab--on' : ''}`}
              onClick={() => onTab(t.id)}
            >
              {t.label}
              {counts[t.id] !== undefined && <span className="cf-set__count">{counts[t.id]}</span>}
            </button>
          ))}
        </nav>
        <div className="cf-set__body" id="cf-set-body" role="tabpanel" aria-labelledby={`cf-set-tab-${tab}`}>
          {tab === 'members' && (
            <>
              <MembersTab group={group} agents={agents} patch={patch} />
              {footer}
            </>
          )}
          {tab === 'memory' && (
            <MemoryTab
              key={group.id}
              group={{
                group,
                agents,
                saveLearn: async (on) => (await patch({ memoryLearn: on })).memoryLearn,
              }}
              load={mem}
              api={memory}
              onRetry={() => setMemAttempt((n) => n + 1)}
              onItems={(items) => setMem((m) => (m?.status === 'ok' ? { status: 'ok', page: { ...m.page, items, total: items.length } } : m))}
            />
          )}
          {tab === 'files' && <FilesTab key={group.id} group={{ group, agents }} path={filesPath} onPath={(p) => onFilesPath?.(p)} onTotal={onFilesTotal} />}
          {tab === 'settings' && (
            <>
              <SettingsTab key={group.id} group={group} patch={patch} />
              {footer}
            </>
          )}
        </div>
      </aside>
      <Confirm
        open={confirmDelete}
        title={`Delete ${group.name}?`}
        subtitle="The group leaves your chat list for everyone in it. Each bot keeps its own chat, files and memory."
        confirmLabel="Delete group"
        loading={deleting}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => void deleteGroup()}
      >
        <p className="prose">
          The group&apos;s messages, shared folder <code>{sub.folder ?? 'groups/…'}</code> and memory are archived on the server, not erased.
        </p>
        {deleteError && <p className="field__err" role="alert">{deleteError}</p>}
      </Confirm>
    </>
  )
}

const roleLine = (a: Agent) => [a.role || a.description, a.isPrimary ? 'personal agent' : null].filter(Boolean).join(' · ')

/** 06b Members: you, the lead (locked), the rest; ＋ Add bot (GAP-G6), inline remove (GAP-G7), "What members can see". */
function MembersTab({ group, agents, patch }: { group: Group; agents: readonly Agent[]; patch: (b: GroupPatch) => Promise<GroupSummary> }) {
  const { profile } = useProfile()
  const me = displayName(profile)
  const [adding, setAdding] = useState<string[] | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const addable = addableBots(group, agents)
  const full = group.memberAgentIds.length >= MAX_GROUP_BOTS
  const folder = group.slug ? `groups/${group.slug}/` : 'the shared folder'

  const run = async (body: GroupPatch, done: () => void) => {
    setBusy(true)
    setError(null)
    try {
      await patch(body)
      done()
    } catch (err) {
      setError(friendly(err, 'Could not update the group.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <section className="cf-card cf-gmem">
        <div className="cf-gmem__hdr">
          <b>Members</b>
          <span className="cf-gmem__count">{membersCount(group)} bots</span>
          <span className="cf-grow" />
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => setAdding(adding ? null : [])}
            disabled={busy || full || addable.length === 0}
            title={full ? `A group can have at most ${MAX_GROUP_BOTS} bots.` : addable.length === 0 ? 'Every bot is already in this group.' : undefined}
            aria-expanded={adding !== null}
          >
            ＋ Add bot
          </button>
        </div>
        {adding && (
          // GAP-G6: pick bots that aren't members yet.
          <div className="cf-gmem__add" data-gap="GAP-G6">
            <ul className="cf-ng__list">
              {addable.map((a) => {
                const on = adding.includes(a.id)
                const room = group.memberAgentIds.length + adding.length < MAX_GROUP_BOTS
                return (
                  <li key={a.id}>
                    <label className={`cf-ng__row${on ? ' is-on' : ''}`}>
                      <input type="checkbox" checked={on} disabled={busy || (!on && !room)} onChange={() => setAdding(on ? adding.filter((x) => x !== a.id) : [...adding, a.id])} />
                      <Avatar name={a.name} agentId={a.id} avatar={a.avatar} color={a.color} size="sm" decorative />
                      <span className="cf-ng__txt">
                        <span className="cf-ng__name">{a.name}</span>
                        <span className="cf-ng__sub">{roleLine(a)}</span>
                      </span>
                    </label>
                  </li>
                )
              })}
            </ul>
            <div className="cf-gmem__addfoot">
              <button type="button" className="btn btn--sm" onClick={() => setAdding(null)} disabled={busy}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn--sm btn--primary"
                disabled={busy || adding.length === 0}
                onClick={() => void run({ memberAgentIds: withMembers(group, adding) }, () => setAdding(null))}
              >
                {busy ? 'Adding…' : adding.length > 1 ? `Add ${adding.length} bots` : 'Add bot'}
              </button>
            </div>
          </div>
        )}
        <div className="cf-gmem__row">
          <UserAvatar profile={profile} name={me} size="md" />
          <div className="cf-grow">
            <div className="cf-gmem__nm">{me} (you)</div>
            <div className="cf-gmem__sub">Owner</div>
          </div>
          <span className="cf-gmem__x" aria-hidden="true" />
        </div>
        {orderedMembers(group).map((id) => {
          const a = agents.find((x) => x.id === id)
          const isLead = id === group.leadAgentId
          const last = group.memberAgentIds.length <= MIN_GROUP_BOTS
          const lockText = isLead
            ? `${a?.name ?? 'The lead'} leads every group and can't be removed. Move the Team Lead role to another bot first.`
            : last
              ? `A group needs at least ${MIN_GROUP_BOTS} bots.`
              : `Remove ${a?.name ?? 'this bot'}`
          return (
            <div key={id}>
              <div className="cf-gmem__row">
                <Avatar name={a?.name ?? 'A deleted bot'} agentId={id} avatar={a?.avatar} color={a?.color} size="md" decorative />
                <div className="cf-grow">
                  <div className="cf-gmem__nm">
                    {a?.name ?? 'A deleted bot'}
                    {isLead && <span className="cf-pill">★ Leads the group</span>}
                  </div>
                  {a && <div className="cf-gmem__sub">{roleLine(a)}</div>}
                </div>
                <span className="cf-gmem__rule">{memberRule(id, group, agents)}</span>
                <button
                  type="button"
                  className="cf-gmem__x"
                  title={lockText}
                  aria-label={isLead || last ? lockText : `Remove ${a?.name ?? 'this bot'}`}
                  disabled={isLead || last || busy}
                  onClick={() => setRemoving(removing === id ? null : id)}
                >
                  ×
                </button>
              </div>
              {removing === id && !isLead && (
                // GAP-G7: confirm inline under the row.
                <div className="cf-gmem__confirm" role="group" aria-label={`Remove ${a?.name}`} data-gap="GAP-G7">
                  <span className="cf-grow">
                    Remove {a?.name ?? 'this bot'} from {group.name}? It keeps its own chat, files and memory.
                  </span>
                  <button type="button" className="btn btn--sm" onClick={() => setRemoving(null)} disabled={busy}>
                    Keep
                  </button>
                  <button
                    type="button"
                    className="btn btn--sm btn--danger"
                    disabled={busy}
                    onClick={() => {
                      const next = withoutMember(group, id)
                      if (next) void run({ memberAgentIds: next }, () => setRemoving(null))
                    }}
                  >
                    {busy ? 'Removing…' : 'Remove'}
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </section>
      {error && <p className="field__err" role="alert">{error}</p>}
      <section className="cf-card cf-gsee">
        <b>What members can see</b>
        <ul>
          <li>
            <span className="cf-gsee__ok" aria-label="Yes">✓</span>
            <span>
              This group&apos;s messages and its shared folder <code>{folder}</code> (read and write)
            </span>
          </li>
          <li>
            <span className="cf-gsee__ok" aria-label="Yes">✓</span>
            <span>The group&apos;s own memory (Memory tab), separate from each bot&apos;s private memory</span>
          </li>
          <li>
            <span className="cf-gsee__no" aria-label="No">✕</span>
            <span>Each other&apos;s private chats, folders and memory</span>
          </li>
        </ul>
      </section>
    </>
  )
}

/** GAP-G5: Settings tab. Rename and Learn from chat are BE-5 PATCH fields; Mute is this browser only. */
function SettingsTab({ group, patch }: { group: Group; patch: (b: GroupPatch) => Promise<GroupSummary> }) {
  const [name, setName] = useState(group.name)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [learnSaving, setLearnSaving] = useState(false)
  const trimmed = name.trim().replace(/\s+/g, ' ')
  const nameProblem = !trimmed ? 'Name the group.' : trimmed.length > MAX_GROUP_NAME ? `Keep the name under ${MAX_GROUP_NAME} characters.` : null

  const rename = async () => {
    if (nameProblem || trimmed === group.name) return
    setSaving(true)
    setError(null)
    try {
      const g = await patch({ name: trimmed })
      setName(g.name)
    } catch (err) {
      setError(friendly(err, 'Could not rename the group.'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="cf-gset" data-gap="GAP-G5">
      <section className="cf-card">
        <label className="field">
          <span className="field__label">Group name</span>
          <span className="cf-gset__name">
            <input
              className="input"
              value={name}
              maxLength={80}
              onChange={(e) => {
                setName(e.target.value)
                setError(null)
              }}
              onKeyDown={(e) => e.key === 'Enter' && void rename()}
            />
            <button type="button" className="btn btn--primary" onClick={() => void rename()} disabled={saving || nameProblem !== null || trimmed === group.name}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </span>
        </label>
        {(error || (nameProblem && name !== group.name)) && (
          <p className="field__err" role="alert">
            {error ?? nameProblem}
          </p>
        )}
        <p className="row__hint">Everyone in the group sees “You renamed the group …” in the chat.</p>
      </section>
      <section className="cf-card cf-gset__row">
        <div className="cf-grow">
          <p className="row__label">Learn from chat</p>
          <p className="row__hint">Bots may save facts from this group to the group&apos;s memory. Each bot&apos;s private memory is never used here.</p>
        </div>
        <Toggle
          on={group.memoryLearn}
          label="Learn from chat"
          disabled={learnSaving}
          onChange={(v) => {
            setLearnSaving(true)
            setError(null)
            patch({ memoryLearn: v })
              .catch((err: unknown) => setError(friendly(err, 'Could not save.')))
              .finally(() => setLearnSaving(false))
          }}
        />
      </section>
      <p className="row__hint cf-gset__mutehint">Mute hides this group from the unread count on this browser only.</p>
    </div>
  )
}
