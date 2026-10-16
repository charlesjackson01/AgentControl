import { useEffect, useState } from 'react'
import { NavLink } from 'react-router-dom'
import Avatar from './Avatar'
import { SparkIcon } from './icons'
import { primaryNav, secondaryNav, type NavItem } from '../lib/nav'
import {
  hiddenCount,
  isErrorPreview,
  previewText,
  relativeTime,
  sortConversations,
  unreadLabel,
  visibleConversations,
} from '../lib/conversations'
import type { Agent, ConversationSummary } from '../lib/types'
import { useConversations } from '../state/conversations-context'
import { useProfile } from '../state/profile-context'
import { displayName } from '../lib/profile'
import { profileAvatarUrl } from '../lib/profile-api'
import type { UserProfile } from '../lib/types'
import type { useSidebar } from '../hooks/useSidebar'

type SidebarProps = ReturnType<typeof useSidebar>

const SHOW_HIDDEN_KEY = 'agentcontrol.sidebar.showHidden'

function NavRow({ item, collapsed, onNavigate }: { item: NavItem; collapsed: boolean; onNavigate: () => void }) {
  const Icon = item.icon
  return (
    <NavLink
      to={item.to}
      onClick={onNavigate}
      className={({ isActive }) => `nav__item${isActive ? ' nav__item--active' : ''}`}
    >
      <span className="nav__icon">
        <Icon size={17} />
      </span>
      <span className="nav__text sidebar__fade">{item.label}</span>
      {item.count !== undefined && <span className="nav__count sidebar__fade">{item.count}</span>}
      {collapsed && <span className="nav__tip" role="tooltip">{item.label}</span>}
    </NavLink>
  )
}

function UserAvatar({ profile, name }: { profile: UserProfile | null | undefined; name: string }) {
  const avatar = profile?.avatar
  return (
    <Avatar
      name={name}
      avatar={avatar}
      previewUrl={avatar?.kind === 'image' ? profileAvatarUrl(avatar.updatedAt) : null}
      color="#64748b"
      size="md"
      decorative
    />
  )
}

/** Re-render every minute so relative times ("5m") stay fresh. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(t)
  }, [])
  return now
}

function ConversationRow({
  c,
  agent,
  now,
  collapsed,
  onNavigate,
}: {
  c: ConversationSummary
  agent: Agent
  now: Date
  collapsed: boolean
  onNavigate: () => void
}) {
  const unread = unreadLabel(c.unreadCount)
  return (
    <NavLink
      to={`/c/${c.id}`}
      onClick={onNavigate}
      className={({ isActive }) => `convrow${isActive ? ' convrow--active' : ''}${unread ? ' convrow--unread' : ''}`}
      aria-label={`${agent.name}${unread ? `, ${c.unreadCount} unread` : ''}`}
      title={collapsed ? agent.name : undefined}
    >
      <span className="convrow__avatar">
        <Avatar name={agent.name} agentId={agent.id} avatar={agent.avatar} color={agent.color} size="md" decorative />
        {unread && <span className="convrow__dot" aria-hidden="true" />}
      </span>
      <span className="convrow__text sidebar__fade">
        <span className="convrow__top">
          <span className="convrow__name">
            {agent.name}
            {agent.isPrimary && <span className="convrow__tag">Primary</span>}
          </span>
          <span className="convrow__time">{c.lastMessage ? relativeTime(c.lastMessage.createdAt, now) : ''}</span>
        </span>
        <span className="convrow__bottom">
          <span className={`convrow__preview${isErrorPreview(c.lastMessage) ? ' convrow__preview--error' : ''}`}>
            {isErrorPreview(c.lastMessage) && <span aria-hidden="true">⚠ </span>}
            {previewText(c.lastMessage)}
          </span>
          {unread && <span className="convrow__badge">{unread}</span>}
        </span>
      </span>
    </NavLink>
  )
}

export default function Sidebar({ collapsed, mobileOpen, isMobile, close }: SidebarProps) {
  // On mobile the drawer is always full-width, so labels never fade out.
  const rail = collapsed && !isMobile
  const classes = ['sidebar', rail ? 'sidebar--collapsed' : '', mobileOpen ? 'sidebar--open' : '']
  const { conversations, agents, error, reload } = useConversations()
  const [showHidden, setShowHidden] = useState(() => localStorage.getItem(SHOW_HIDDEN_KEY) === '1')
  const now = useNow()
  const { profile } = useProfile()
  const name = displayName(profile)

  useEffect(() => {
    localStorage.setItem(SHOW_HIDDEN_KEY, showHidden ? '1' : '0')
  }, [showHidden])

  const all = conversations ?? []
  const rows = sortConversations(visibleConversations(all, agents, showHidden), agents)
  const hidden = hiddenCount(all, agents)

  return (
    <aside className={classes.filter(Boolean).join(' ')}>
      <div className="brand">
        <span className="brand__mark">
          <SparkIcon size={16} />
        </span>
        <span className="brand__text sidebar__fade">
          <span className="brand__name">AgentControl</span>
          <span className="brand__tag">Console</span>
        </span>
      </div>

      <nav className="nav convlist" aria-label="Conversations">
        <p className="nav__label sidebar__fade">Chats</p>
        {error && !conversations ? (
          <div className="convlist__note sidebar__fade">
            Could not load chats.{' '}
            <button type="button" className="linkbtn" onClick={reload}>
              Retry
            </button>
          </div>
        ) : !conversations ? (
          <p className="convlist__note sidebar__fade">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="convlist__note sidebar__fade">No chats yet.</p>
        ) : (
          rows.map((c) => {
            const agent = agents.find((a) => a.id === c.agentId)
            return agent ? <ConversationRow key={c.id} c={c} agent={agent} now={now} collapsed={rail} onNavigate={close} /> : null
          })
        )}
        {(hidden > 0 || showHidden) && !rail && (
          <button type="button" className="linkbtn convlist__hidden sidebar__fade" onClick={() => setShowHidden((v) => !v)}>
            {showHidden ? 'Hide hidden agents' : `Show ${hidden} hidden`}
          </button>
        )}
      </nav>

      <nav className="nav nav--footer" aria-label="Workspace">
        {[...primaryNav, ...secondaryNav].map((item) => (
          <NavRow key={item.to} item={item} collapsed={rail} onNavigate={close} />
        ))}
      </nav>

      <div className="sidebar__footer">
        <NavLink to="/settings#profile" onClick={close} className="account" title={rail ? name : undefined}>
          <UserAvatar profile={profile} name={name} />
          <span className="account__text sidebar__fade">
            <span className="account__name">{name}</span>
            <span className="account__role">Workspace owner</span>
          </span>
        </NavLink>
      </div>
    </aside>
  )
}
