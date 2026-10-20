import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
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
function BotRow({ author, meta, error, children }: { author?: Agent; meta?: string; error?: boolean; children: React.ReactNode }) {
  return (
    <div className="cf-row">
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

function UserRow({ meta, children }: { meta?: string; children: React.ReactNode }) {
  return (
    <div className="cf-row cf-row--u">
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
                      <UserRow key={item.key} meta={item.meta}>
                        {view.text}
                      </UserRow>
                    )
                  const retryText = view.kind === 'error' ? retryTextBefore(messages, item.index) : undefined
                  return (
                    <BotRow key={item.key} author={authorOf(m)} meta={item.meta} error={view.kind === 'error'}>
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
          <div className="cf-comp">
            <button type="button" className="cf-cbtn cf-cbtn--plus" disabled title="Attachments aren't available yet" aria-label="Attach files">
              ＋
            </button>
            <textarea
              className="cf-comp__input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  void send(draft)
                }
              }}
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
          <p className="cf-hint">Enter to send · / for commands · Files you send are saved in this bot&apos;s folder</p>
        </div>
      </main>

      {agent && (
        <ProfilePanel
          open={profileOpen}
          agent={agent}
          endpoints={endpoints.data ?? []}
          skills={skills.data ?? []}
          onClose={() => setProfileOpen(false)}
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
