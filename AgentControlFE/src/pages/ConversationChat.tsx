import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import Avatar from '../components/Avatar'
import ChatHeader from '../components/shell/ChatHeader'
import { ProfilePanel } from '../components/ProfilePanel'
import { ErrorState, Skeleton } from '../components/States'
import { api } from '../lib/api'
import { friendlyError as friendly } from '../lib/chat-format'
import { dmAgentId, mergeMessages, olderCursor } from '../lib/conversations'
import { clockTime, threadItems, typingSeenFor } from '../lib/thread'
import type { Agent, ChatMessage } from '../lib/types'
import { useAsync } from '../hooks/useAsync'
import { useConversations } from '../state/conversations-context'
import { useShell } from '../state/shell-context'
import { matchCommands, parseSlash, slashPrefix, type CommandDef } from '../lib/commands'
import { moveActive } from '../lib/search'
import { chatMessageView, liveRunOutcome, retryTextBefore } from '../lib/run-reply'

/** New-message check while the thread is open and the tab visible. */
const THREAD_POLL_MS = 10_000

type Pending = { text: string; ts: string; status: 'typing' | 'error'; error?: string }

function TypingDots() {
  return (
    <span className="cf-typing" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  )
}

/** One assistant row: avatar at the bubble's foot, bubble, then its time. */
type RowProps = { meta?: string; mid?: string; hit?: boolean; children: React.ReactNode }

function BotRow({ author, meta, error, mid, hit, children }: RowProps & { author?: Agent; error?: boolean }) {
  return (
    <div className={`cf-row${hit ? ' cf-row--hit' : ''}`} data-mid={mid}>
      <span className="cf-row__av">
        <Avatar name={author?.name ?? 'Bot'} agentId={author?.id} avatar={author?.avatar} color={author?.color} size="md" decorative />
      </span>
      <div className="cf-grp">
        <div className={`cf-bub cf-bub--a${error ? ' cf-bub--error' : ''}`}>{children}</div>
        {meta && <div className="cf-bt">{meta}</div>}
      </div>
    </div>
  )
}

function UserRow({ meta, mid, hit, children }: RowProps) {
  return (
    <div className={`cf-row cf-row--u${hit ? ' cf-row--hit' : ''}`} data-mid={mid}>
      <div className="cf-grp">
        <div className="cf-bub cf-bub--u">{children}</div>
        {meta && <div className="cf-rcpt">{meta}</div>}
      </div>
    </div>
  )
}

/** FE-1 thread for one conversation: bottom-anchored, day separators, a time under each bubble. */
export default function ConversationChat() {
  const { conversationId = '' } = useParams()
  const { conversations, agents, loaded, markRead, upsert, reload: reloadSidebar, typingSince } = useConversations()
  const conversation = conversations?.find((c) => c.id === conversationId)
  const agentId = conversation ? dmAgentId(conversation) : undefined
  const agent = agentId ? agents.find((a) => a.id === agentId) : undefined
  const isGroup = conversation?.kind === 'group'

  const [messages, setMessages] = useState<ChatMessage[] | undefined>(undefined)
  const [hasMore, setHasMore] = useState(false)
  const [loadError, setLoadError] = useState<Error | undefined>(undefined)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [olderError, setOlderError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState<Pending | null>(null)
  const [profileOpen, setProfileOpen] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const [shownFor, setShownFor] = useState(conversationId)
  const shell = useShell()
  // Deep links: `?m=<messageId>` (palette → message) and `?panel=settings[&tab=…]` (FE-3 picks the tab).
  const [params, setParams] = useSearchParams()
  const jumpId = params.get('m')
  const panelParam = params.get('panel')
  const [slashActive, setSlashActive] = useState(0)
  const [slashClosedFor, setSlashClosedFor] = useState<string | null>(null)
  const [cmdNotice, setCmdNotice] = useState<string | null>(null)
  const jumpTries = useRef(0)

  // Reset per conversation during render (no effect), so a switch never flashes the old thread.
  if (shownFor !== conversationId) {
    setShownFor(conversationId)
    setMessages(undefined)
    setHasMore(false)
    setLoadError(undefined)
    setOlderError(null)
    setPending(null)
    setRunError(null)
    setDraft('')
    setCmdNotice(null)
  }

  const endpoints = useAsync(api.listEndpoints, [])
  const skills = useAsync(api.listSkills, [])

  // First page.
  useEffect(() => {
    if (!conversationId) return
    let active = true
    api.listConversationMessages(conversationId).then(
      (page) => {
        if (!active) return
        setMessages((prev) => mergeMessages(prev ?? [], page.messages))
        setHasMore(page.hasMore)
        setLoadError(undefined)
      },
      (err: unknown) => {
        if (active) setLoadError(err instanceof Error ? err : new Error(String(err)))
      },
    )
    return () => {
      active = false
    }
  }, [conversationId, attempt])

  // Pick up messages that arrive while open (e.g. an agent finishing a turn).
  useEffect(() => {
    if (!conversationId) return
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return
      api.listConversationMessages(conversationId).then(
        (page) => setMessages((prev) => (prev ? mergeMessages(prev, page.messages) : prev)),
        () => {},
      )
    }, THREAD_POLL_MS)
    return () => clearInterval(timer)
  }, [conversationId])

  // Mark read on open and whenever a new message lands while the thread is open.
  const newestId = messages?.[messages.length - 1]?.id
  const unread = conversation?.unreadCount ?? 0
  useEffect(() => {
    if (!conversationId || messages === undefined) return
    if (document.visibilityState === 'visible') markRead(conversationId)
    // `unread` re-triggers when a sidebar poll reports new unread for the open chat.
  }, [conversationId, newestId, unread, messages === undefined, markRead]) // eslint-disable-line react-hooks/exhaustive-deps

  // Scroll: stick to bottom for new messages; keep position when older ones are prepended.
  const threadRef = useRef<HTMLElement>(null)
  const prependAnchor = useRef<number | null>(null)
  useLayoutEffect(() => {
    const el = threadRef.current
    if (!el) return
    if (prependAnchor.current !== null) {
      el.scrollTop = el.scrollHeight - prependAnchor.current
      prependAnchor.current = null
    } else {
      el.scrollTop = el.scrollHeight
    }
    if (jumpId) el.querySelector(`[data-mid="${CSS.escape(jumpId)}"]`)?.scrollIntoView({ block: 'center' })
  }, [newestId, messages?.length, pending, jumpId])

  const loadOlder = async () => {
    const before = olderCursor(messages ?? [])
    if (!before || loadingOlder) return
    setLoadingOlder(true)
    setOlderError(null)
    try {
      const page = await api.listConversationMessages(conversationId, { before })
      const el = threadRef.current
      if (el) prependAnchor.current = el.scrollHeight - el.scrollTop
      setMessages((prev) => mergeMessages(page.messages, prev ?? []))
      setHasMore(page.hasMore)
    } catch (err) {
      setOlderError(friendly(err, 'Could not load earlier messages.'))
    } finally {
      setLoadingOlder(false)
    }
  }

  // Jump target not loaded yet: page back (at most 10 pages), then drop the param once shown.
  const jumpFound = Boolean(jumpId && messages?.some((m) => m.id === jumpId))
  useEffect(() => {
    if (!jumpId || !messages) return
    if (jumpFound || !hasMore || jumpTries.current >= 10) {
      const t = setTimeout(() => {
        jumpTries.current = 0
        setParams((p) => {
          p.delete('m')
          return p
        }, { replace: true })
      }, jumpFound ? 2500 : 0)
      return () => clearTimeout(t)
    }
    if (loadingOlder) return
    jumpTries.current += 1
    const t = setTimeout(() => void loadOlder(), 0)
    return () => clearTimeout(t)
  }, [jumpId, jumpFound, messages, hasMore, loadingOlder]) // eslint-disable-line react-hooks/exhaustive-deps

  const sending = pending?.status === 'typing'
  const send = useCallback(async (raw: string) => {
    const text = raw.trim()
    if (!text || sending) return
    setPending({ text, ts: new Date().toISOString(), status: 'typing' })
    setDraft('')
    try {
      if (!agent) throw new Error('This chat has no bot.')
      const result = await api.sendConversationMessage(conversationId, agent.id, text)
      setMessages((prev) => mergeMessages(prev ?? [], result.messages))
      if (result.conversation) upsert(result.conversation)
      // A flagged failed reply renders as its own error bubble; otherwise surface run.error once.
      const outcome = liveRunOutcome(result.run, result.messages)
      if (outcome.kind === 'pending') {
        setPending({ text, ts: new Date().toISOString(), status: 'error', error: outcome.text })
        setRunError(null)
      } else {
        setPending(null)
        setRunError(outcome.kind === 'banner' ? (outcome.text ?? 'The run failed.') : null)
      }
    } catch (err) {
      setPending({ text, ts: new Date().toISOString(), status: 'error', error: friendly(err, 'The message could not be sent.') })
    }
  }, [sending, agent, conversationId, upsert])


  const authorOf = (m: ChatMessage): Agent | undefined =>
    (m.authorAgentId ? agents.find((a) => a.id === m.authorAgentId) : undefined) ?? agent
  const typingAgent =
    !pending && conversation?.typingAgentId ? agents.find((a) => a.id === conversation.typingAgentId) : undefined
  const canSend = Boolean(conversation) && !isGroup

  // "Read" before a reply exists: when typing was first seen for this chat (held by the provider).
  const typingSeen = messages && !pending ? typingSeenFor(messages, typingSince[conversationId]) : null

  if (loaded && conversations && !conversation) {
    return (
      <>
        <ChatHeader />
        <main className="cf-main">
          <div className="cf-empty">
            <ErrorState title="Chat not found" error={new Error('This conversation does not exist or was removed.')} onRetry={reloadSidebar} />
            <Link to="/" className="cf-btn">
              Go to your latest chat
            </Link>
          </div>
        </main>
      </>
    )
  }

  const closeProfile = () => {
    setProfileOpen(false)
    if (panelParam)
      setParams((p) => {
        p.delete('panel')
        p.delete('tab')
        p.delete('path')
        return p
      }, { replace: true })
  }

  // Slash autocomplete: open while the draft is `/` + letters, until Esc for that draft.
  const slash = slashPrefix(draft)
  const slashItems = slash !== null && slashClosedFor !== draft && canSend ? matchCommands(slash) : []
  const slashIdx = Math.min(slashActive, Math.max(0, slashItems.length - 1))
  const runSlash = (def: CommandDef, args = '') => {
    const reason = shell.runCommand(def.name, args)
    if (reason) setCmdNotice(`/${def.name}: ${reason}`)
    else setDraft('')
  }
  const onComposerKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return
    if (slashItems.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashActive((i) => Math.max(0, moveActive(i, e.key === 'ArrowDown' ? 1 : -1, slashItems.length)))
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setSlashClosedFor(draft)
        return
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault()
        runSlash(slashItems[slashIdx])
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      const parsed = parseSlash(draft)
      if (parsed) runSlash(parsed.command, parsed.args)
      else void send(draft)
    }
  }

  const items = messages ? threadItems(messages, { typingSeen }) : []
  const lastIdx = (messages?.length ?? 0) - 1

  return (
    <>
      <ChatHeader conversation={conversation} agent={agent} sending={sending} onInfo={agent ? () => setProfileOpen(true) : undefined} />
      <main className="cf-main">
        <section className="cf-thread" aria-label="Conversation" ref={threadRef}>
          <div className="cf-thread__inner">
            {loadError && !messages ? (
              <div className="cf-empty">
                <ErrorState title="Could not load the conversation" error={loadError} onRetry={() => setAttempt((n) => n + 1)} />
              </div>
            ) : !messages ? (
              <div className="cf-thread--placeholder">
                <Skeleton height={12} width="30%" />
                <Skeleton height={48} width="60%" />
                <Skeleton height={48} width="45%" />
              </div>
            ) : (
              <>
                {hasMore && (
                  <div className="cf-older">
                    <button type="button" className="cf-btn" onClick={() => void loadOlder()} disabled={loadingOlder}>
                      {loadingOlder && <span className="spinner" aria-hidden="true" />}
                      {loadingOlder ? 'Loading…' : 'Load earlier messages'}
                    </button>
                    {olderError && <p className="field__err" role="alert">{olderError}</p>}
                  </div>
                )}
                {messages.length === 0 && !pending && (
                  <p className="cf-thread__empty">{agent ? `Say hi to ${agent.name}.` : 'No messages yet.'}</p>
                )}
                {items.map((item) => {
                  if (item.type === 'day') return <div key={item.key} className="cf-daysep">{item.label}</div>
                  const m = item.message
                  if (m.kind === 'system') return <p key={item.key} className="cf-system">{m.content}</p>
                  const view = chatMessageView(m)
                  if (view.kind === 'user')
                    return (
                      <UserRow key={item.key} meta={item.meta} mid={m.id} hit={m.id === jumpId}>
                        {view.text}
                      </UserRow>
                    )
                  const retryText = view.kind === 'error' ? retryTextBefore(messages, item.index) : undefined
                  return (
                    <BotRow key={item.key} author={authorOf(m)} meta={item.meta} error={view.kind === 'error'} mid={m.id} hit={m.id === jumpId}>
                      {view.text}
                      {view.kind === 'error' && retryText !== undefined && item.index === lastIdx && canSend && (
                        <button type="button" className="chat__retry" onClick={() => void send(retryText)} disabled={sending}>
                          Retry
                        </button>
                      )}
                    </BotRow>
                  )
                })}
                {runError && !pending && (
                  <p className="chat__runerr" role="alert">Last run failed: {runError}</p>
                )}
                {pending && (
                  <>
                    <UserRow meta={clockTime(pending.ts)}>{pending.text}</UserRow>
                    {pending.status === 'typing' ? (
                      <BotRow author={agent}>
                        <span className="sr-only">{`${agent?.name ?? 'Bot'} is typing`}</span>
                        <TypingDots />
                      </BotRow>
                    ) : (
                      <BotRow author={agent} error>
                        {pending.error}
                        <button type="button" className="chat__retry" onClick={() => void send(pending.text)}>
                          Retry
                        </button>
                      </BotRow>
                    )}
                  </>
                )}
                {typingAgent && (
                  <BotRow author={typingAgent}>
                    <span className="sr-only">{`${typingAgent.name} is typing`}</span>
                    <TypingDots />
                  </BotRow>
                )}
              </>
            )}
          </div>
        </section>

        <div className="cf-compwrap">
          {slashItems.length > 0 && (
            <div className="cf-pop cf-slash" role="listbox" id="cf-slash" aria-label="Commands">
              <p className="cf-sec">Commands</p>
              <ul>
                {slashItems.map((def, i) => {
                  const reason = def.unavailable({ conversationId, isGroup })
                  return (
                    <li key={def.name}>
                      <button
                        type="button"
                        role="option"
                        id={`cf-slash-${i}`}
                        aria-selected={i === slashIdx}
                        aria-disabled={reason !== null || undefined}
                        className={`cf-it${i === slashIdx ? ' cf-it--on' : ''}${reason ? ' cf-it--off' : ''}`}
                        onMouseDown={(e) => e.preventDefault()}
                        onMouseMove={() => i !== slashIdx && setSlashActive(i)}
                        onClick={() => runSlash(def)}
                      >
                        <span className="cf-pal__ic cf-pal__ic--cmd" aria-hidden="true">/</span>
                        <span className="cf-it__col">
                          <span className="cf-it__t">
                            <span className="cf-mono">/{def.name}</span>
                            <span className="cf-pal__lbl">{def.label}</span>
                          </span>
                          <span className="cf-it__s">{reason ?? def.hint}</span>
                        </span>
                        {i === slashIdx && <kbd className="cf-it__k">↵</kbd>}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}
          <div className="cf-comp">
            <button type="button" className="cf-cbtn cf-cbtn--plus" disabled title="Attachments aren't available yet" aria-label="Attach files">
              ＋
            </button>
            <textarea
              className="cf-comp__input"
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value)
                setSlashActive(0)
                setCmdNotice(null)
              }}
              onKeyDown={onComposerKey}
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={slashItems.length > 0}
              aria-controls={slashItems.length > 0 ? 'cf-slash' : undefined}
              aria-activedescendant={slashItems.length > 0 ? `cf-slash-${slashIdx}` : undefined}
              placeholder={isGroup ? "Sending in group chats isn't available yet" : agent ? `Message ${agent.name}…` : 'Message…'}
              rows={1}
              disabled={sending || !canSend}
              aria-label="Message"
            />
            <button type="button" className="cf-cbtn" disabled title="Skills aren't available here yet" aria-label="Skills">
              ✦
            </button>
            <button
              type="button"
              className="cf-send"
              onClick={() => void send(draft)}
              disabled={sending || !draft.trim() || !canSend}
              aria-label={sending ? 'Sending' : 'Send'}
            >
              {sending ? <span className="spinner" aria-hidden="true" /> : '↑'}
            </button>
          </div>
          {cmdNotice ? (
            <p className="cf-hint cf-hint--notice" role="status">{cmdNotice}</p>
          ) : (
            <p className="cf-hint">Enter to send · / for commands · Files you send are saved in this bot&apos;s folder</p>
          )}
        </div>
      </main>

      {agent && (
        <ProfilePanel
          open={profileOpen || panelParam === 'settings'}
          agent={agent}
          endpoints={endpoints.data ?? []}
          skills={skills.data ?? []}
          onClose={closeProfile}
          onSaved={reloadSidebar}
          onDeleted={reloadSidebar}
          onCleared={() => {
            setMessages([])
            reloadSidebar()
          }}
        />
      )}
    </>
  )
}
