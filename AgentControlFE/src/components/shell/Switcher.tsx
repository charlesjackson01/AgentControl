import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Avatar from '../Avatar'
import GroupAvatar from './GroupAvatar'
import { CheckIcon, SearchIcon } from '../icons'
import { unreadLabel } from '../../lib/conversations'
import { switcherOrder, switcherSections, type SwitcherItem } from '../../lib/shell'
import { useConversations } from '../../state/conversations-context'
import { useShell } from '../../state/shell-context'

/** The bot switcher popover (02a): find a bot or group by name. ⌘K opens the palette instead. */
export default function Switcher({ currentId }: { currentId?: string }) {
  const shell = useShell()
  const navigate = useNavigate()
  const { conversations, agents } = useConversations()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const popRef = useRef<HTMLDivElement>(null)

  const sections = useMemo(
    () => switcherSections(conversations ?? [], agents, { query, currentId }),
    [conversations, agents, query, currentId],
  )
  const order = switcherOrder(sections)
  const activeIdx = Math.min(active, Math.max(0, order.length - 1))

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Close on outside click.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) shell.closeSwitcher()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [shell])

  const go = (item: SwitcherItem | undefined) => {
    if (!item) return
    shell.closeSwitcher()
    navigate(`/c/${item.id}`)
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      shell.closeSwitcher()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => (order.length ? (Math.min(i, order.length - 1) + 1) % order.length : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => (order.length ? (Math.min(i, order.length - 1) - 1 + order.length) % order.length : 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      go(order[activeIdx])
    }
  }

  const renderItem = (item: SwitcherItem) => {
    const idx = order.indexOf(item)
    const agent = item.agentId ? agents.find((a) => a.id === item.agentId) : undefined
    const unread = unreadLabel(item.unread)
    return (
      <li key={item.id}>
        <button
          type="button"
          role="option"
          aria-selected={idx === activeIdx}
          className={`cf-it${idx === activeIdx ? ' cf-it--on' : ''}`}
          onMouseEnter={() => setActive(idx)}
          onClick={() => go(item)}
        >
          {item.kind === 'group' ? (
            <GroupAvatar memberAgentIds={item.memberAgentIds} agents={agents} size="sm" />
          ) : (
            <Avatar name={item.title} agentId={agent?.id} avatar={agent?.avatar} color={agent?.color} size="sm" decorative />
          )}
          <span className="cf-it__col">
            <span className="cf-it__t">
              {item.title}
              {item.isPrimary && <span className="cf-tag">Primary</span>}
            </span>
            <span className="cf-it__s">{item.subtitle}</span>
          </span>
          <span className="cf-it__r">
            {item.current ? <CheckIcon size={14} /> : unread ? <span className="cf-badge">{unread}</span> : item.time}
          </span>
        </button>
      </li>
    )
  }

  return (
    <div className="cf-pop cf-switcher" ref={popRef} onKeyDown={onKey} role="dialog" aria-label="Go to a bot or group">
      <div className="cf-switcher__search">
        <label className="cf-search cf-search--boxed">
          <SearchIcon size={13} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActive(0)
            }}
            placeholder="Go to a bot or group…"
            aria-label="Go to a bot or group"
          />
        </label>
      </div>
      <div className="cf-switcher__list" role="listbox" aria-label="Bots and groups">
        {sections.bots.length > 0 && <p className="cf-sec">Bots</p>}
        <ul>{sections.bots.map(renderItem)}</ul>
        {sections.groups.length > 0 && <p className="cf-sec">Group chats</p>}
        <ul>{sections.groups.map(renderItem)}</ul>
        {order.length === 0 && <p className="cf-switcher__none">No bots or groups match “{query}”.</p>}
      </div>
      <div className="cf-switcher__foot">
        <button type="button" className="cf-btn" onClick={shell.openNewBot}>
          ＋ New bot
        </button>
        <button type="button" className="cf-btn" disabled title="Group chats aren't available yet">
          ＋ New group
        </button>
      </div>
    </div>
  )
}
