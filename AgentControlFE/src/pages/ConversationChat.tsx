import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { BotRow, TypingDots, UserRow } from '../components/shell/ChatRows'
import ChatHeader from '../components/shell/ChatHeader'
import BotSettingsPanel from '../components/settings/BotSettingsPanel'
import { settingsOpen, settingsTab, withSettingsTab, withoutPanel } from '../lib/settings-tabs'
import { filesPanelOpen, filesPathParam, withFilesPath } from '../lib/files'
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
import { activityView, runFilesChanged } from '../lib/activity'
import { ActivityCard, FileCards } from '../components/shell/MessageActivity'
import { Markdown } from '../components/Markdown'
import { NewBotTurn } from '../components/shell/NewBotFlow'
import { useNewBot } from '../hooks/useNewBot'
import { composerLocked, createBody, createFailureText, newBotApi, newCommandPrompt, placeholderFor, profilePrefill, readNewBotNav, tooLongNotice } from '../lib/new-bot'
import { request } from '../lib/api'

/** New-message check while the thread is open and the tab visible. */
const THREAD_POLL_MS = 10_000

type Pending = { text: string; ts: string; status: 'typing' | 'error'; error?: string }

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
  const [runError, setRunError] = useState<string | null>(null)
  /** BE-3: top-level `filesChanged` of runs sent from this screen, by run id (when the send result carries it). */
  const [runFiles, setRunFiles] = useState<Record<string, unknown[]>>({})
  const [shownFor, setShownFor] = useState(conversationId)
  const shell = useShell()
  // Deep links: `?m=<messageId>` (palette → message) and `?panel=settings[&tab=…]` (FE-3 picks the tab).
  const [params, setParams] = useSearchParams()
  const jumpId = params.get('m')
  const [slashActive, setSlashActive] = useState(0)
  const [slashClosedFor, setSlashClosedFor] = useState<string | null>(null)
  const [cmdNotice, setCmdNotice] = useState<string | null>(null)
  const jumpTries = useRef(0)
  // FE-5: the /new draft card, only in Primary's DM.
  const nbs = useNewBot(conversationId)
  const isPrimaryDm = Boolean(agent?.isPrimary) && !isGroup
  const location = useLocation()
  const navigate = useNavigate()

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
    nbs.setSession(null)
  }

  // "＋ New bot" / palette /new land here with router state; start the card once, then drop the state.
  const navNewBot = readNewBotNav(location.state)
  useEffect(() => {
    if (!navNewBot || !agent) return
    if (isPrimaryDm) nbs.start(navNewBot.prompt)
    navigate({ pathname: location.pathname, search: location.search }, { replace: true, state: null })
  }, [navNewBot?.nonce, agent?.id, isPrimaryDm]) // eslint-disable-line react-hooks/exhaustive-deps

  const endpoints = useAsync(api.listEndpoints, [])

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
    // FE-5: re-anchor per /new turn (not on every keystroke in the card).
  }, [newestId, messages?.length, pending, jumpId, nbs.session?.turn, nbs.session?.phase.kind, nbs.session?.userTs])

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
      const changed = runFilesChanged(result.run)
      if (changed) setRunFiles((prev) => ({ ...prev, [result.run.id]: changed }))
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

  // Bot settings (FE-3) live in the URL: ?panel=settings[&tab=…]. Closing drops panel/tab/path.
  // FE-4: ?panel=files&path=… opens the same panel on Files at that folder.
  const panelOpen = settingsOpen(params) || filesPanelOpen(params)
  const panelTab = filesPanelOpen(params) ? 'files' : settingsTab(params)
  const openSettings = () => setParams((p) => withSettingsTab(p, 'profile'))
  const closeProfile = () => setParams((p) => withoutPanel(p), { replace: true })

  // Slash autocomplete: open while the draft is `/` + letters, until Esc for that draft.
  const slash = slashPrefix(draft)
  const slashItems = slash !== null && slashClosedFor !== draft && canSend ? matchCommands(slash) : []
  const slashIdx = Math.min(slashActive, Math.max(0, slashItems.length - 1))
  const runSlash = (def: CommandDef, args = '') => {
    const reason = shell.runCommand(def.name, args)
    if (reason) setCmdNotice(`/${def.name}: ${reason}`)
    else setDraft('')
  }
  const nbSession = isPrimaryDm ? nbs.session : null
  const nbPhase = nbSession?.phase ?? null
  // S7: the description's raw length (what POST /api/agents/draft counts), for /new and for replies to the card.
  const slashNew = newCommandPrompt(draft)
  const limitText = slashNew !== null ? slashNew : nbPhase?.kind === 'ask' || nbPhase?.kind === 'card' ? draft : ''
  const tooLong = canSend ? tooLongNotice(limitText) : null
  const locked = composerLocked(nbPhase)

  const submit = (text: string) => {
    if (tooLong || locked) return
    const parsed = parseSlash(text)
    if (parsed?.command.name === 'new') {
      const raw = newCommandPrompt(text) ?? parsed.args
      if (isPrimaryDm) {
        setDraft('')
        setCmdNotice(null)
        nbs.start(raw)
      } else runSlash(parsed.command, raw)
      return
    }
    if (parsed) return runSlash(parsed.command, parsed.args)
    if (!text.trim()) return
    if (nbPhase?.kind === 'ask') {
      setDraft('')
      return nbs.answer(text)
    }
    if (nbPhase?.kind === 'card') {
      setDraft('')
      return nbs.reply(text)
    }
    if (nbSession) nbs.end()
    void send(text)
  }

  const createBot = async () => {
    const s = nbs.session
    if (!s?.card || s.phase.kind !== 'card' || s.phase.creating) return
    const card = s.card
    nbs.setSession((x) => (x ? { ...x, phase: { kind: 'card', warning: s.phase.kind === 'card' ? s.phase.warning : undefined, creating: true } } : x))
    let saved: Agent
    try {
      saved = await newBotApi(request).create<Agent>(createBody(card, nbs.extras.defaults))
    } catch (err) {
      nbs.setSession((x) => (x ? { ...x, phase: { kind: 'card', warning: s.phase.kind === 'card' ? s.phase.warning : undefined, error: createFailureText(card.name, err) } } : x))
      return
    }
    // The bot exists now; a failed picture upload leaves the emoji (or initials) and still opens its chat.
    if (nbs.file) await api.uploadAgentAvatar(saved.id, nbs.file.file).catch(() => undefined)
    nbs.end()
    reloadSidebar()
    navigate(`/agents/${encodeURIComponent(saved.id)}`)
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
      submit(draft)
    }
  }

  const items = messages ? threadItems(messages, { typingSeen }) : []
  const lastIdx = (messages?.length ?? 0) - 1

  return (
    <>
      <ChatHeader conversation={conversation} agent={agent} sending={sending} onInfo={agent ? openSettings : undefined} />
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
                  const act = activityView(m.activity, undefined, (m.runId && runFiles[m.runId]) || null)
                  return (
                    <BotRow
                      key={item.key}
                      author={authorOf(m)}
                      meta={item.meta}
                      error={view.kind === 'error'}
                      mid={m.id}
                      hit={m.id === jumpId}
                      before={act && <ActivityCard view={act} />}
                      after={act && <FileCards files={act.files} conversationId={conversationId} />}
                    >
                      {view.kind === 'assistant' ? <Markdown text={view.text} /> : view.text}
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
                {nbSession && (
                  <NewBotTurn
                    nbs={nbs}
                    primary={agent}
                    onCreate={() => void createBot()}
                    onOpenFull={() => nbs.session?.card && shell.openNewBotForm(profilePrefill(nbs.session.card, nbs.extras.defaults))}
                  />
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
              placeholder={isGroup ? "Sending in group chats isn't available yet" : agent ? placeholderFor(nbPhase, agent.name) : 'Message…'}
              rows={1}
              disabled={sending || !canSend || locked}
              aria-label="Message"
            />
            <button type="button" className="cf-cbtn" disabled title="Skills aren't available here yet" aria-label="Skills">
              ✦
            </button>
            <button
              type="button"
              className="cf-send"
              onClick={() => submit(draft)}
              disabled={sending || !draft.trim() || !canSend || locked || tooLong !== null}
              aria-label={sending ? 'Sending' : 'Send'}
            >
              {sending ? <span className="spinner" aria-hidden="true" /> : '↑'}
            </button>
          </div>
          {tooLong || cmdNotice ? (
            <p className="cf-hint cf-hint--notice" role="status">{tooLong ?? cmdNotice}</p>
          ) : (
            <p className="cf-hint">Enter to send · / for commands · Files you send are saved in this bot&apos;s folder</p>
          )}
        </div>
      </main>

      {agent && panelOpen && (
        <BotSettingsPanel
          agent={agent}
          endpoints={endpoints.data ?? []}
          tab={panelTab}
          onTab={(t) => setParams((p) => withSettingsTab(p, t), { replace: true })}
          filesPath={filesPathParam(params)}
          onFilesPath={(path) => setParams((p) => withFilesPath(p, path), { replace: true })}
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
