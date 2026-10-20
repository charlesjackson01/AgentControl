import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Avatar from '../Avatar'
import GroupAvatar from './GroupAvatar'
import { SearchIcon } from '../icons'
import { request } from '../../lib/api'
import { type CommandContext } from '../../lib/commands'
import {
  SEARCH_DEBOUNCE_MS, fetchSearch, highlight, moveActive, paletteOrder, paletteSections, shouldSearch,
  type PaletteItem, type RemoteSearch,
} from '../../lib/search'
import { isGroup } from '../../lib/shell'
import type { Agent } from '../../lib/types'
import { useConversations } from '../../state/conversations-context'
import { useShell } from '../../state/shell-context'

function Marked({ text, query }: { text: string; query: string }) {
  return (
    <>
      {highlight(text, query).map((part, i) => (part.match ? <b key={i}>{part.text}</b> : <span key={i}>{part.text}</span>))}
    </>
  )
}

/**
 * ⌘K command palette (02b): Messages, Files, Bots & groups, Commands. Messages and
 * files come from BE-10 `/api/search`; bots, groups and commands are matched locally,
 * so the palette still works (with a notice) on a server without search.
 */
export default function CommandPalette({ ctx }: { ctx: CommandContext }) {
  const shell = useShell()
  const navigate = useNavigate()
  const { conversations, agents } = useConversations()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [remote, setRemote] = useState<RemoteSearch>({ status: 'idle' })
  const [notice, setNotice] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // Once the server says it has no search route, stop asking for this palette session.
  const unavailable = remote.status === 'unavailable'

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    if (unavailable || !shouldSearch(query)) return
    let live = true
    const timer = setTimeout(() => {
      setRemote({ status: 'loading', query })
      void fetchSearch(query, (path) => request<unknown>(path)).then((r) => {
        if (live) setRemote(r)
      })
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [query, unavailable])

  const sections = useMemo(
    () => paletteSections(query, { conversations: conversations ?? [], agents, remote, ctx }),
    [query, conversations, agents, remote, ctx],
  )
  const order = paletteOrder(sections)
  const activeIdx = order.length ? Math.min(active, order.length - 1) : -1

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [activeIdx])

  const open = (item: PaletteItem | undefined) => {
    if (!item) return
    if (item.type === 'command') {
      const reason = shell.runCommand(item.command.name)
      if (reason) setNotice(`/${item.command.name}: ${reason}`)
      else shell.closePalette()
      return
    }
    if (!item.to) {
      setNotice("That file's chat isn't in your list.")
      return
    }
    shell.closePalette()
    navigate(item.to)
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      shell.closePalette()
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(0, moveActive(i, e.key === 'ArrowDown' ? 1 : -1, order.length)))
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      open(order[activeIdx])
    }
  }

  const row = (item: PaletteItem, body: React.ReactNode) => {
    const idx = order.indexOf(item)
    const on = idx === activeIdx
    const disabled = item.type === 'command' && item.reason !== null
    return (
      <li key={item.key}>
        <button
          type="button"
          role="option"
          id={`cf-pal-${idx}`}
          aria-selected={on}
          aria-disabled={disabled || undefined}
          className={`cf-it${on ? ' cf-it--on' : ''}${disabled ? ' cf-it--off' : ''}`}
          onMouseMove={() => idx !== activeIdx && setActive(idx)}
          onClick={() => open(item)}
        >
          {body}
          {on && <kbd className="cf-it__k">↵</kbd>}
        </button>
      </li>
    )
  }

  const q = query.trim()
  const remoteNote = sections.remoteUnavailable
    ? "Message and file search isn't available on this server yet."
    : sections.remoteError
      ? `Search failed: ${sections.remoteError}`
      : null

  return (
    <>
      <div className="cf-scrim cf-scrim--pal" onMouseDown={shell.closePalette} aria-hidden="true" />
      <div className="cf-pop cf-pal" role="dialog" aria-modal="true" aria-label="Search and commands" onKeyDown={onKey}>
        <div className="cf-pal__in">
          <SearchIcon size={14} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActive(0)
              setNotice(null)
            }}
            placeholder="Search messages, files, bots… or type / for commands"
            aria-label="Search messages, files, bots and commands"
            role="combobox"
            aria-expanded="true"
            aria-controls="cf-pal-list"
            aria-activedescendant={activeIdx >= 0 ? `cf-pal-${activeIdx}` : undefined}
            spellCheck={false}
          />
          <kbd>esc</kbd>
        </div>
        <div className="cf-pal__list" id="cf-pal-list" role="listbox" aria-label="Results" ref={listRef}>
          {sections.messages.length > 0 && <p className="cf-sec">Messages</p>}
          <ul>
            {sections.messages.map((item) =>
              item.type !== 'message'
                ? null
                : row(
                    item,
                    <>
                      {item.memberAgentIds ? (
                        <GroupAvatar memberAgentIds={item.memberAgentIds} leadAgentId={item.leadAgentId} agents={agents} size="sm" />
                      ) : (
                        <AgentAv agents={agents} agentId={item.authorAgentId ?? dmOf(item, conversations ?? [])} />
                      )}
                      <span className="cf-it__col">
                        <span className="cf-it__t cf-pal__t">
                          {item.authorName ? `${item.authorName}: ` : ''}“<Marked text={item.snippet} query={q} />”
                        </span>
                        <span className="cf-it__s">
                          in {item.chatTitle}
                          {item.time ? ` · ${item.time}` : ''}
                        </span>
                      </span>
                    </>,
                  ),
            )}
          </ul>
          {sections.files.length > 0 && <p className="cf-sec">Files</p>}
          <ul>
            {sections.files.map((item) =>
              item.type !== 'file'
                ? null
                : row(
                    item,
                    <>
                      <span className="cf-pal__ic" aria-hidden="true">{item.image ? '🖼' : '📄'}</span>
                      <span className="cf-it__col">
                        <span className="cf-it__t cf-pal__t cf-mono"><Marked text={item.path} query={q} /></span>
                        <span className="cf-it__s">{item.ownerTitle}</span>
                      </span>
                    </>,
                  ),
            )}
          </ul>
          {(sections.remoteLoading || remoteNote) && q && !q.startsWith('/') && (
            <p className={`cf-pal__note${sections.remoteLoading ? ' cf-pal__note--busy' : ''}`} role="status">
              {sections.remoteLoading ? 'Searching messages and files…' : remoteNote}
            </p>
          )}
          {sections.chats.length > 0 && <p className="cf-sec">Bots &amp; groups</p>}
          <ul>
            {sections.chats.map((item) =>
              item.type !== 'chat'
                ? null
                : row(
                    item,
                    <>
                      {isGroup(item.conversation) ? (
                        <GroupAvatar memberAgentIds={item.conversation.memberAgentIds} leadAgentId={item.conversation.leadAgentId} agents={agents} size="sm" />
                      ) : (
                        <AgentAv agents={agents} agentId={item.conversation.agentId} />
                      )}
                      <span className="cf-it__col">
                        <span className="cf-it__t"><span><Marked text={item.title} query={q} /></span></span>
                        <span className="cf-it__s">{item.subtitle}</span>
                      </span>
                    </>,
                  ),
            )}
          </ul>
          {sections.commands.length > 0 && <p className="cf-sec">Commands</p>}
          <ul>
            {sections.commands.map((item) =>
              item.type !== 'command'
                ? null
                : row(
                    item,
                    <>
                      <span className="cf-pal__ic cf-pal__ic--cmd" aria-hidden="true">/</span>
                      <span className="cf-it__col">
                        <span className="cf-it__t">
                          <span className="cf-mono">/{item.command.name}</span>
                          <span className="cf-pal__lbl">{item.command.label}</span>
                        </span>
                        <span className="cf-it__s">{item.reason ?? item.command.hint}</span>
                      </span>
                    </>,
                  ),
            )}
          </ul>
          {order.length === 0 && !sections.remoteLoading && (
            <p className="cf-pal__none">Nothing matches “{q}”.</p>
          )}
        </div>
        {notice && (
          <p className="cf-pal__notice" role="alert">
            {notice}
          </p>
        )}
      </div>
    </>
  )
}

function AgentAv({ agentId, agents }: { agentId?: string; agents: Agent[] }) {
  const a = agents.find((x) => x.id === agentId)
  return <Avatar name={a?.name ?? 'Bot'} agentId={a?.id} avatar={a?.avatar} color={a?.color} size="sm" decorative />
}

function dmOf(item: { conversationId: string }, list: readonly { id: string; agentId?: string }[]): string | undefined {
  return list.find((c) => c.id === item.conversationId)?.agentId
}
