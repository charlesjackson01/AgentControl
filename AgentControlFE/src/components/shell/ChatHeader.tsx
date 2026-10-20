import { useEffect, useRef, useState } from 'react'
import Avatar from '../Avatar'
import GroupAvatar from './GroupAvatar'
import Switcher from './Switcher'
import UserAvatar from './UserAvatar'
import { SearchIcon } from '../icons'
import { agentStatusLine } from '../../lib/shell'
import { unreadLabel } from '../../lib/conversations'
import { displayName } from '../../lib/profile'
import type { Agent, ConversationSummary } from '../../lib/types'
import { useConversations } from '../../state/conversations-context'
import { useProfile } from '../../state/profile-context'
import { useShell } from '../../state/shell-context'

function UserMenu() {
  const shell = useShell()
  const { profile } = useProfile()
  const name = displayName(profile)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  return (
    <div className="cf-usermenu" ref={ref}>
      <button type="button" className="cf-usermenu__btn" aria-haspopup="menu" aria-expanded={open} aria-label="Account menu" onClick={() => setOpen((o) => !o)}>
        <UserAvatar profile={profile} name={name} size="md" />
      </button>
      {open && (
        <div className="cf-pop cf-usermenu__pop" role="menu">
          <p className="cf-usermenu__name">{name}</p>
          <button
            type="button"
            role="menuitem"
            className="cf-it"
            onClick={() => {
              setOpen(false)
              shell.openSettings()
            }}
          >
            Profile &amp; endpoints
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * FE-1 header: ☰ (only while the list is hidden, with the unread total), the
 * bot switcher or the group title, then Search ⌘K, ⓘ and the account menu.
 * The account lives in the list footer while the list is showing (01a vs 01b).
 */
export default function ChatHeader({
  conversation,
  agent,
  onInfo,
}: {
  conversation?: ConversationSummary
  agent?: Agent
  onInfo?: () => void
}) {
  const shell = useShell()
  const { agents } = useConversations()
  const group = conversation?.kind === 'group' ? conversation : undefined
  const badge = unreadLabel(shell.unread)

  return (
    <header className="cf-hdr">
      {!shell.listOpen && (
        <button
          type="button"
          className="cf-hbtn cf-hbtn--ic cf-menubtn"
          onClick={shell.toggleList}
          title="Show chats (⌘\)"
          aria-label={badge ? `Show chats, ${shell.unread} unread` : 'Show chats'}
        >
          ☰{badge && <span className="cf-badge cf-badge--tiny">{badge}</span>}
        </button>
      )}

      <div className="cf-hdr__who">
        {group ? (
          <div className="cf-switch cf-switch--static">
            <GroupAvatar memberAgentIds={group.memberAgentIds} leadAgentId={group.leadAgentId} agents={agents} size="sm" />
            <div>
              <h1 className="cf-switch__nm">{group.name}</h1>
              <p className="cf-switch__rl">
                {group.memberAgentIds.length} {group.memberAgentIds.length === 1 ? 'bot' : 'bots'}
              </p>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className={`cf-switch${shell.switcherOpen ? ' cf-switch--on' : ''}`}
            onClick={() => (shell.switcherOpen ? shell.closeSwitcher() : shell.openSwitcher())}
            aria-haspopup="dialog"
            aria-expanded={shell.switcherOpen}
            aria-label={agent ? `${agent.name}, switch bot` : 'Switch bot'}
          >
            {agent && <Avatar name={agent.name} agentId={agent.id} avatar={agent.avatar} color={agent.color} size="md" decorative />}
            <span>
              <span className="cf-switch__nm">
                {agent?.name ?? 'Chats'} <span className="cf-chev">▾</span>
              </span>
              {agent && (
                <span className="cf-switch__rl">
                  <span className={`cf-presence cf-presence--${agent.status}`}>●</span> {agentStatusLine(agent)}
                </span>
              )}
            </span>
          </button>
        )}
        {shell.switcherOpen && <Switcher currentId={conversation?.id} />}
      </div>

      <span className="cf-sp" />

      <button type="button" className="cf-hbtn cf-hbtn--b cf-searchbtn" onClick={shell.openSwitcher} aria-label="Search (⌘K)">
        <SearchIcon size={13} />
        <span className="cf-searchbtn__t">Search messages, files</span>
        <kbd>⌘K</kbd>
      </button>
      <button
        type="button"
        className="cf-hbtn cf-hbtn--ic"
        title={onInfo ? 'Settings' : 'Group settings arrive with group chats'}
        aria-label="Settings"
        onClick={onInfo}
        disabled={!onInfo}
      >
        ⓘ
      </button>
      {!shell.listOpen && <UserMenu />}
    </header>
  )
}
