import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import Avatar from '../Avatar'
import GroupAvatar from './GroupAvatar'
import Switcher from './Switcher'
import UserAvatar from './UserAvatar'
import { SearchIcon } from '../icons'
import { agentStatusLine, isAgentTyping } from '../../lib/shell'
import { groupHeaderLine, nameOf, orderedMembers } from '../../lib/groups'
import { unreadLabel } from '../../lib/conversations'
import { displayName } from '../../lib/profile'
import { mobileBack } from '../../lib/mobile'
import type { Agent, ConversationSummary, GroupConversation } from '../../lib/types'
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
  sending = false,
}: {
  conversation?: ConversationSummary
  agent?: Agent
  onInfo?: () => void
  /** Our own DM send is in flight (the reply is being generated). */
  sending?: boolean
}) {
  const shell = useShell()
  const { agents } = useConversations()
  const group = conversation?.kind === 'group' ? conversation : undefined
  const badge = unreadLabel(shell.unread)
  const typing = sending || isAgentTyping(conversation, agent?.id)
  const subline = agent ? agentStatusLine(agent, { typing }) : ''

  if (shell.narrow) return <MobileHeader conversation={conversation} agent={agent} onInfo={onInfo} typing={typing} />

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
          <button
            type="button"
            className={`cf-switch${shell.switcherOpen ? ' cf-switch--on' : ''}`}
            onClick={() => (shell.switcherOpen ? shell.closeSwitcher() : shell.openSwitcher())}
            aria-haspopup="dialog"
            aria-expanded={shell.switcherOpen}
            aria-label={`${group.name}, switch chat`}
          >
            <GroupAvatar memberAgentIds={group.memberAgentIds} leadAgentId={group.leadAgentId} agents={agents} size="sm" />
            <span>
              <span className="cf-switch__nm">
                {group.name} <span className="cf-chev">▾</span>
              </span>
              <GroupSubline group={group} agents={agents} />
            </span>
          </button>
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
              {subline && (
                <span className={`cf-switch__rl${typing ? ' cf-switch__rl--typing' : ''}`} aria-live="polite">
                  {typing && <span className="cf-presence">●</span>} {subline}
                </span>
              )}
            </span>
          </button>
        )}
        {shell.switcherOpen && <Switcher currentId={conversation?.id} />}
      </div>

      <span className="cf-sp" />
      {group && <MemberStack group={group} agents={agents} />}

      <button type="button" className="cf-hbtn cf-hbtn--b cf-searchbtn" onClick={shell.openPalette} aria-label="Search (⌘K)">
        <SearchIcon size={13} />
        <span className="cf-searchbtn__t">Search messages, files</span>
        <kbd>⌘K</kbd>
      </button>
      <button
        type="button"
        className="cf-hbtn cf-hbtn--ic"
        title={group ? 'Group settings' : 'Settings'}
        aria-label={group ? 'Group settings' : 'Settings'}
        onClick={onInfo}
        disabled={!onInfo}
      >
        ⓘ
      </button>
      {!shell.listOpen && <UserMenu />}
    </header>
  )
}

/**
 * FE-8 phone header (05b): ‹ with the unread total back to the list screen, the
 * bot centred (avatar over "Name ▾", which opens the switcher), and ⓘ. No search
 * or account here; those live on the list screen.
 */
function MobileHeader({ conversation, agent, onInfo, typing }: { conversation?: ConversationSummary; agent?: Agent; onInfo?: () => void; typing: boolean }) {
  const shell = useShell()
  const { agents } = useConversations()
  const group = conversation?.kind === 'group' ? conversation : undefined
  const back = mobileBack(shell.unread)
  return (
    <header className="cf-hdr cf-mhdr">
      <Link to={back.to} className="cf-mhdr__back" aria-label={back.label}>
        <span className="cf-mhdr__chev" aria-hidden="true">
          ‹
        </span>
        {back.badge && <span className="cf-badge">{back.badge}</span>}
      </Link>

      <div className="cf-hdr__who cf-mhdr__who">
        {group ? (
          // GAP-G10 (was GAP-B4): 05b is a DM; a group's phone header is not mocked. Same pieces, centred, plus the lead line.
          <button
            type="button"
            className="cf-mhdr__id cf-mhdr__id--group"
            onClick={() => (shell.switcherOpen ? shell.closeSwitcher() : shell.openSwitcher())}
            aria-haspopup="dialog"
            aria-expanded={shell.switcherOpen}
            aria-label={`${group.name}, switch chat`}
          >
            <GroupAvatar memberAgentIds={group.memberAgentIds} leadAgentId={group.leadAgentId} agents={agents} size="sm" />
            <span className="cf-mhdr__nm">
              {group.name} <span className="cf-mhdr__caret">▾</span>
            </span>
            <GroupSubline group={group} agents={agents} compact />
          </button>
        ) : (
          <button
            type="button"
            className="cf-mhdr__id"
            onClick={() => (shell.switcherOpen ? shell.closeSwitcher() : shell.openSwitcher())}
            aria-haspopup="dialog"
            aria-expanded={shell.switcherOpen}
            aria-label={agent ? `${agent.name}, switch bot` : 'Switch bot'}
          >
            {agent && <Avatar name={agent.name} agentId={agent.id} avatar={agent.avatar} color={agent.color} size="md" decorative />}
            <span className="cf-mhdr__nm">
              {agent?.name ?? 'Chats'} <span className="cf-mhdr__caret">▾</span>
            </span>
            {typing && <span className="sr-only" aria-live="polite">{agent?.name} is typing</span>}
          </button>
        )}
        {shell.switcherOpen && <Switcher currentId={conversation?.id} />}
      </div>

      <button
        type="button"
        className="cf-hbtn cf-hbtn--ic cf-mhdr__info"
        title={group ? 'Group settings' : 'Settings'}
        aria-label={group ? 'Group settings' : 'Settings'}
        onClick={onInfo}
        disabled={!onInfo}
      >
        ⓘ
      </button>
    </header>
  )
}

type GroupSummaryLike = ConversationSummary & GroupConversation

/** 06a: "★ Led by Primary" (accent) "· You, Researcher, Summarizer"; while a bot replies, "● Researcher is typing…". */
function GroupSubline({ group, agents, compact = false }: { group: GroupSummaryLike; agents: readonly Agent[]; compact?: boolean }) {
  const line = groupHeaderLine(group, agents)
  const typing = group.typingAgentId ? nameOf(group.typingAgentId, agents) : null
  if (typing)
    return (
      <span className="cf-switch__rl cf-switch__rl--typing" aria-live="polite">
        <span className="cf-presence">●</span> {typing} is typing…
      </span>
    )
  return (
    <span className={`cf-switch__rl${compact ? ' cf-mhdr__rl' : ''}`}>
      <span className="cf-switch__lead">{line.lead}</span>
      {!compact && <> · {line.members}</>}
    </span>
  )
}

/** 06a header stack: lead, the other bots, then you. */
function MemberStack({ group, agents }: { group: GroupSummaryLike; agents: readonly Agent[] }) {
  const { profile } = useProfile()
  const ids = orderedMembers(group)
  const shown = ids.slice(0, 5)
  return (
    <span className="cf-stack cf-hdr__stack" aria-hidden="true">
      {shown.map((id) => {
        const a = agents.find((x) => x.id === id)
        return <Avatar key={id} name={a?.name ?? '?'} agentId={id} avatar={a?.avatar} color={a?.color} size="sm" decorative />
      })}
      {ids.length > shown.length && <span className="avatar avatar--sm cf-stack__more">+{ids.length - shown.length}</span>}
      <UserAvatar profile={profile} name={displayName(profile)} size="sm" />
    </span>
  )
}
