import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import Avatar from '../components/Avatar'
import { Bubble, TypingBubble } from '../components/ChatBubble'
import { ProfilePanel } from '../components/ProfilePanel'
import { ErrorState, Skeleton } from '../components/States'
import { StatusPill } from '../components/StatusPill'
import { api } from '../lib/api'
import { friendlyError as friendly, turnTime } from '../lib/chat-format'
import { mergeMessages, olderCursor } from '../lib/conversations'
import type { ChatMessage } from '../lib/types'
import { useAsync } from '../hooks/useAsync'
import { useConversations } from '../state/conversations-context'

/** New-message check while the thread is open and the tab visible. */
const THREAD_POLL_MS = 10_000
/** Show a time divider when consecutive messages are this far apart. */
const DIVIDER_GAP_MS = 10 * 60_000

type Pending = { text: string; ts: string; status: 'typing' | 'error'; error?: string }

/** Chat-first Part 2: one conversation's thread (Primary's 1:1 is the landing page). */
export default function ConversationChat() {
  const { conversationId = '' } = useParams()
  const { conversations, agents, loaded, markRead, upsert, reload: reloadSidebar } = useConversations()
  const conversation = conversations?.find((c) => c.id === conversationId)
  const agent = conversation ? agents.find((a) => a.id === conversation.agentId) : undefined

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
  }, [newestId, messages?.length, pending])

  const loadOlder = useCallback(async () => {
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
  }, [conversationId, loadingOlder, messages])

  const sending = pending?.status === 'typing'
  const send = async (raw: string) => {
    const text = raw.trim()
    if (!text || sending) return
    setPending({ text, ts: new Date().toISOString(), status: 'typing' })
    setDraft('')
    try {
      if (!agent) throw new Error('This chat has no agent.')
      const result = await api.sendConversationMessage(conversationId, agent.id, text)
      setMessages((prev) => mergeMessages(prev ?? [], result.messages))
      if (result.conversation) upsert(result.conversation)
      // A failed run may have stored no assistant message; surface its error inline.
      const answered = result.messages.some((m) => m.role === 'assistant')
      if (result.run.status === 'failed' && !answered) {
        setPending({ text, ts: new Date().toISOString(), status: 'error', error: result.run.error || 'The run failed.' })
        setRunError(null)
      } else {
        setPending(null)
        setRunError(result.run.status === 'failed' ? (result.run.error || 'The run failed.') : null)
      }
    } catch (err) {
      setPending({ text, ts: new Date().toISOString(), status: 'error', error: friendly(err, 'The message could not be sent.') })
    }
  }


  if (loaded && conversations && !conversation) {
    return (
      <main className="page">
        <div className="page__inner">
          <ErrorState title="Chat not found" error={new Error('This conversation does not exist or was removed.')} onRetry={reloadSidebar} />
          <p className="field__hint" style={{ marginTop: 12 }}>
            <Link to="/agents">Go to agents</Link>
          </p>
        </div>
      </main>
    )
  }

  return (
    <main className="page page--chat">
      <div className="page__inner">
        <header className="chat__header">
          <div className="chat__header__left">
            {agent && (
              <button
                type="button"
                className="chat__header__avatar"
                onClick={() => setProfileOpen(true)}
                aria-label={`Open ${agent.name}'s profile`}
              >
                <Avatar name={agent.name} agentId={agent.id} avatar={agent.avatar} color={agent.color} size="md" decorative />
              </button>
            )}
            <div className="chat__header__id">
              <h1 className="chat__header__name">{agent?.name ?? ''}</h1>
              {agent?.role && <p className="chat__header__role">{agent.role}</p>}
            </div>
            {agent && (
              <span className="chat__header__status">
                <StatusPill status={agent.status} />
              </span>
            )}
            {agent?.isPrimary && <span className="pill pill--lead">Primary</span>}
          </div>
          {agent && (
            <div className="chat__header__right">
              <button type="button" className="btn" onClick={() => setProfileOpen(true)} aria-label="Agent profile">
                Profile
              </button>
            </div>
          )}
        </header>

        <section className="chat__thread" aria-label="Conversation" ref={threadRef}>
          {loadError && !messages ? (
            <div className="chat__thread__error">
              <ErrorState title="Could not load the conversation" error={loadError} onRetry={() => setAttempt((n) => n + 1)} />
            </div>
          ) : !messages ? (
            <div className="chat__thread__placeholder">
              <Skeleton height={12} width="30%" />
              <Skeleton height={64} width="70%" />
              <Skeleton height={64} width="55%" />
            </div>
          ) : (
            <>
              {hasMore && (
                <div className="chat__older">
                  <button type="button" className="btn btn--sm" onClick={() => void loadOlder()} disabled={loadingOlder}>
                    {loadingOlder && <span className="spinner" aria-hidden="true" />}
                    {loadingOlder ? 'Loading…' : 'Load earlier messages'}
                  </button>
                  {olderError && <p className="field__err" role="alert">{olderError}</p>}
                </div>
              )}
              {messages.length === 0 && !pending && (
                <p className="chat__empty">{agent ? `Say hi to ${agent.name}.` : 'No messages yet.'}</p>
              )}
              {messages.map((m, i) => {
                const prev = messages[i - 1]
                const gap = prev ? new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() : Infinity
                return (
                  <div className="chat__turn" key={m.id}>
                    {gap > DIVIDER_GAP_MS && (
                      <div className="chat__ts">
                        <span>{turnTime(m.createdAt)}</span>
                      </div>
                    )}
                    {m.role === 'user' ? (
                      <Bubble kind="user">
                        <div className="bubble__body">{m.content}</div>
                      </Bubble>
                    ) : (
                      <Bubble kind="assistant">
                        <div className="bubble__body">{m.content || '(no output)'}</div>
                      </Bubble>
                    )}
                  </div>
                )
              })}
              {runError && !pending && (
                <p className="chat__runerr" role="alert">Last run failed: {runError}</p>
              )}
              {pending && (
                <div className="chat__turn">
                  <Bubble kind="user">
                    <div className="bubble__body">{pending.text}</div>
                  </Bubble>
                  {pending.status === 'typing' ? (
                    <TypingBubble label={`${agent?.name ?? 'Agent'} is typing`} />
                  ) : (
                    <Bubble kind="error">
                      <div className="bubble__body">{pending.error}</div>
                      <button type="button" className="chat__retry" onClick={() => void send(pending.text)}>
                        Retry
                      </button>
                    </Bubble>
                  )}
                </div>
              )}
            </>
          )}
        </section>

        <div className="chat__composer">
          <div className="chat__composer__input">
            <textarea
              className="textarea"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void send(draft)
                }
              }}
              placeholder={agent ? `Message ${agent.name}…` : 'Message…'}
              rows={1}
              disabled={sending || !conversation}
              aria-label="Message"
            />
            <div className="chat__composer__actions">
              <button type="button" className="btn btn--primary" onClick={() => void send(draft)} disabled={sending || !draft.trim() || !conversation}>
                {sending && <span className="spinner" aria-hidden="true" />}
                {sending ? 'Sending…' : 'Send'}
              </button>
            </div>
          </div>
          <p className="chat__composer__hint">Enter to send · Shift+Enter for a new line</p>
        </div>
      </div>

      {agent && (
        <ProfilePanel
          open={profileOpen}
          agent={agent}
          endpoints={endpoints.data ?? []}
          skills={skills.data ?? []}
          onClose={() => setProfileOpen(false)}
          onSaved={reloadSidebar}
          onCleared={() => {
            setMessages([])
            reloadSidebar()
          }}
        />
      )}
    </main>
  )
}
