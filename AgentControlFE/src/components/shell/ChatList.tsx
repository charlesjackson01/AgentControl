import { useEffect, useState } from 'react'
import { NavLink } from 'react-router-dom'
import Avatar from '../Avatar'
import GroupAvatar from './GroupAvatar'
import UserAvatar from './UserAvatar'
import { SearchIcon, SparkIcon } from '../icons'
import { dmAgentId, hiddenCount, isErrorPreview, unreadLabel } from '../../lib/conversations'
import { chatSections, listTime, previewLine, type ShellConversation } from '../../lib/shell'
import { displayName } from '../../lib/profile'
import type { Agent, ConversationSummary } from '../../lib/types'
import { useConversations } from '../../state/conversations-context'
import { useProfile } from '../../state/profile-context'
import { useShell } from '../../state/shell-context'

const SHOW_HIDDEN_KEY = 'agentcontrol.sidebar.showHidden'

/** Re-render every minute so list times stay fresh. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(t)
  }, [])
  return now
}

function Row({ c, agents, now, onNavigate }: { c: ConversationSummary; agents: Agent[]; now: Date; onNavigate: () => void }) {
  const s = c as ShellConversation
  const group = c.kind === 'group'
  const agent = group ? undefined : agents.find((a) => a.id === dmAgentId(c))
  const title = group ? (s.name ?? 'Group chat') : (agent?.name ?? 'Unknown bot')
  const unread = unreadLabel(c.unreadCount)
  const error = isErrorPreview(c.lastMessage)
  const typing = c.typingAgentId ? agents.find((a) => a.id === c.typingAgentId) : undefined
  return (
    <NavLink
      to={`/c/${c.id}`}
      onClick={onNavigate}
      className={({ isActive }) => `cf-crow${isActive ? ' cf-crow--on' : ''}${unread ? ' cf-crow--unread' : ''}`}
      aria-label={`${title}${unread ? `, ${c.unreadCount} unread` : ''}`}
    >
      {group ? (
        <GroupAvatar memberAgentIds={s.memberAgentIds} leadAgentId={s.leadAgentId} agents={agents} />
      ) : (
        <Avatar name={title} agentId={agent?.id} avatar={agent?.avatar} color={agent?.color} size="lg" decorative className="cf-crow__av" />
      )}
      <span className="cf-crow__col">
        <span className="cf-crow__l1">
          <span className="cf-crow__nm">{title}</span>
          {agent?.isPrimary && <span className="cf-tag">Primary</span>}
          <span className="cf-crow__tm">{c.lastMessage ? listTime(c.lastMessage.createdAt, now) : ''}</span>
        </span>
        <span className="cf-crow__l2">
          {typing ? (
            <span className="cf-crow__pv cf-crow__pv--typing">{group ? `${typing.name} is typing…` : 'typing…'}</span>
          ) : (
            <span className={`cf-crow__pv${error ? ' cf-crow__pv--error' : ''}${unread ? ' cf-crow__pv--unread' : ''}`}>
              {error && <span aria-hidden="true">⚠ </span>}
              {previewLine(c, agents)}
            </span>
          )}
          {unread && <span className="cf-badge">{unread}</span>}
        </span>
      </span>
    </NavLink>
  )
}

/** FE-1 chat list (01a): Bots + Group chats, 308 px, fully hidden when toggled off. */
export default function ChatList() {
  const { conversations, agents, error, reload } = useConversations()
  const shell = useShell()
  const { profile } = useProfile()
  const name = displayName(profile)
  const now = useNow()
  const [query, setQuery] = useState('')
  const [showHidden, setShowHidden] = useState(() => localStorage.getItem(SHOW_HIDDEN_KEY) === '1')

  useEffect(() => {
    localStorage.setItem(SHOW_HIDDEN_KEY, showHidden ? '1' : '0')
  }, [showHidden])

  const all = conversations ?? []
  const { bots, groups } = chatSections(all, agents, { query, showHidden })
  const hidden = hiddenCount(all, agents)

  return (
    <aside className="cf-side" aria-label="Chats">
      <div className="cf-side__top">
        <span className="cf-logo" aria-hidden="true">
          <SparkIcon size={14} />
        </span>
        <h2 className="cf-side__ttl">Chats</h2>
        <span className="cf-sp" />
        <button type="button" className="cf-hbtn cf-hbtn--ic" title="New bot" aria-label="New bot" onClick={shell.openNewBot}>
          ✎
        </button>
        <button type="button" className="cf-hbtn cf-hbtn--ic" title="Hide chats (⌘\)" aria-label="Hide chats" onClick={shell.toggleList}>
          ⇤
        </button>
      </div>

      <div className="cf-side__search">
        <label className="cf-search">
          <SearchIcon size={13} />
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" aria-label="Search chats" />
        </label>
      </div>

      <nav className="cf-side__list" aria-label="Conversations">
        {error && !conversations ? (
          <p className="cf-side__note">
            Could not load chats.{' '}
            <button type="button" className="linkbtn" onClick={reload}>
              Retry
            </button>
          </p>
        ) : !conversations ? (
          <p className="cf-side__note">Loading…</p>
        ) : (
          <>
            <p className="cf-ssec">Bots</p>
            {bots.length === 0 && <p className="cf-side__note">{query ? 'No bots match.' : 'No bots yet.'}</p>}
            {bots.map((c) => (
              <Row key={c.id} c={c} agents={agents} now={now} onNavigate={shell.closeListIfOverlay} />
            ))}
            {groups.length > 0 && <p className="cf-ssec cf-ssec--gap">Group chats</p>}
            {groups.map((c) => (
              <Row key={c.id} c={c} agents={agents} now={now} onNavigate={shell.closeListIfOverlay} />
            ))}
            {(hidden > 0 || showHidden) && (
              <button type="button" className="linkbtn cf-side__hidden" onClick={() => setShowHidden((v) => !v)}>
                {showHidden ? 'Hide hidden bots' : `Show ${hidden} hidden`}
              </button>
            )}
          </>
        )}
      </nav>

      <div className="cf-side__foot">
        <button type="button" className="cf-me" onClick={shell.openSettings} aria-label="Profile & endpoints">
          <UserAvatar profile={profile} name={name} size="md" />
          <span className="cf-me__col">
            <span className="cf-me__nm">{name}</span>
            <span className="cf-me__sub">Profile &amp; endpoints</span>
          </span>
          <span className="cf-hbtn cf-hbtn--ic" aria-hidden="true">
            ⚙
          </span>
        </button>
      </div>
    </aside>
  )
}
