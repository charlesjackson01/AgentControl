import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import Avatar from '../components/Avatar'
import { BotRow, TypingDots, UserRow } from '../components/shell/ChatRows'
import ChatHeader from '../components/shell/ChatHeader'
import GroupSettingsPanel from '../components/settings/GroupSettingsPanel'
import { ActivityCard, GroupFileCards } from '../components/shell/MessageActivity'
import { Markdown } from '../components/Markdown'
import { ErrorState, Skeleton } from '../components/States'
import { api } from '../lib/api'
import { friendlyError as friendly } from '../lib/chat-format'
import { mergeMessages, olderCursor, pageSummary } from '../lib/conversations'
import { settingsOpen, withoutPanel } from '../lib/settings-tabs'
import { filesPanelOpen, filesPathParam, withFilesPath } from '../lib/files'
import { clockTime, dayLabel } from '../lib/thread'
import { matchCommands, parseSlash, slashPrefix, type CommandDef } from '../lib/commands'
import { moveActive } from '../lib/search'
import { chatMessageView } from '../lib/run-reply'
import { activityView } from '../lib/activity'
import {
  DELETED_BOT,
  GROUP_POLL_MS,
  IDLE_POLL,
  afterCursor,
  groupTab,
  insertMention,
  mentionCandidates,
  mentionMatches,
  mentionQuery,
  nameOf,
  nextPoll,
  seenBy,
  skippedMentions,
  systemLineText,
  typingAfterSend,
  typingLabel,
  withGroupTab,
  type PollState,
} from '../lib/groups'
import { renderMentions } from '../lib/mention-render'
import { AttachButton, AttachmentCards, AttachTray } from '../components/shell/Attachments'
import { useFileDrop } from '../hooks/useFileDrop'
import { useAttachments } from '../hooks/useAttachments'
import { sendFailureHint, type Chip } from '../lib/attachments'
import type { Agent, Attachment, ChatMessage, ConversationSummary, GroupConversation } from '../lib/types'
import { useConversations } from '../state/conversations-context'
import { useShell } from '../state/shell-context'

/** Background check while no turn is running (the sidebar poll restarts the fast poll on typing). */
const IDLE_THREAD_POLL_MS = 10_000
/** Consecutive failed fast polls before giving up and offering "Check again". */
const MAX_POLL_FAILS = 8

type Group = ConversationSummary & GroupConversation
type Pending = { text: string; ts: string; status: 'sending' | 'error'; error?: string; attachments?: Attachment[] }

/**
 * FE-6 group thread (06a) on BE-5. A send returns 202 with the user's message; the lead,
 * then mentioned bots, then the lead's wrap-up reply in the background, ~20 s apart. While a
 * turn runs this polls `?after=<newest id>` every 1.5 s and shows who is typing (GAP-G1).
 */
export default function GroupChat({ group }: { group: Group }) {
  const { conversationId = '' } = useParams()
  const { conversations, agents, markRead, upsert, reload: reloadSidebar } = useConversations()
  const shell = useShell()
  const [params, setParams] = useSearchParams()
  const jumpId = params.get('m')

  const [messages, setMessages] = useState<ChatMessage[] | undefined>(undefined)
  const [hasMore, setHasMore] = useState(false)
  const [loadError, setLoadError] = useState<Error | undefined>(undefined)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [olderError, setOlderError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [draft, setDraft] = useState('')
  const [caret, setCaret] = useState(0)
  const [pending, setPending] = useState<Pending | null>(null)
  const [polling, setPolling] = useState(false)
  const [awaiting, setAwaiting] = useState(false)
  const [pollLost, setPollLost] = useState(false)
  const [shownFor, setShownFor] = useState(conversationId)
  const [popActive, setPopActive] = useState(0)
  const [popClosedFor, setPopClosedFor] = useState<string | null>(null)
  const [cmdNotice, setCmdNotice] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [typingFrom, setTypingFrom] = useState<{ id: string | null; at: number }>({ id: null, at: 0 })
  const pollState = useRef<PollState>(IDLE_POLL)
  const msgsRef = useRef<ChatMessage[] | undefined>(undefined)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // FE-7: files picked with ＋ or dropped on the chat land in the group's shared/ folder.
  const att = useAttachments(conversationId)
  const [sendError, setSendError] = useState<string | null>(null)

  if (shownFor !== conversationId) {
    setShownFor(conversationId)
    setMessages(undefined)
    setHasMore(false)
    setLoadError(undefined)
    setOlderError(null)
    setPending(null)
    setDraft('')
    setCmdNotice(null)
    setSendError(null)
    setPolling(false)
    setAwaiting(false)
    setPollLost(false)
  }

  useEffect(() => {
    msgsRef.current = messages
  }, [messages])

  // First page.
  useEffect(() => {
    if (!conversationId) return
    let active = true
    api.listConversationMessages(conversationId).then(
      (page) => {
        if (!active) return
        // BE-10: the first page's summary shows a bot already typing (and starts the fast poll) on open.
        const summary = pageSummary(page.conversation)
        if (summary) {
          upsert(summary)
          const typing = summary.typingAgentId ?? null
          if (typing) {
            const at = Date.now()
            setTypingFrom((prev) => (prev.id === typing ? prev : { id: typing, at }))
          }
        }
        setMessages((prev) => mergeMessages(prev ?? [], page.messages))
        setHasMore(page.hasMore)
        setLoadError(undefined)
      },
      (err: unknown) => active && setLoadError(err instanceof Error ? err : new Error(String(err))),
    )
    return () => {
      active = false
    }
  }, [conversationId, attempt, upsert])

  const startPoll = useCallback((state: PollState) => {
    pollState.current = state
    setPollLost(false)
    setPolling(true)
  }, [])

  // Typing seen by the sidebar poll (another tab, a reload mid-turn) also runs the fast poll.
  const typingId = group.typingAgentId ?? null
  const fastPoll = polling || (Boolean(typingId) && !pollLost)

  // The fast poll (1.5 s, `?after=`). Keeps going while anyone types, however long a reply takes.
  useEffect(() => {
    if (!fastPoll || !conversationId) return
    let alive = true
    let fails = 0
    let tail = false
    let timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      const after = afterCursor(msgsRef.current ?? [])
      try {
        const page = after ? await api.listMessagesAfter(conversationId, after) : await api.listConversationMessages(conversationId)
        if (!alive) return
        fails = 0
        if (page.messages.length) setMessages((prev) => mergeMessages(prev ?? [], page.messages))
        // `?after=` returns the summarised conversation (BE-5: unread + typingAgentId); the first page does too since BE-10.
        const summary = pageSummary(page.conversation)
        if (summary) upsert(summary)
        const typingId = summary?.typingAgentId ?? null
        if (typingId) setAwaiting(false)
        // GAP-G1: when this bot started typing, for "· 25s".
        const at = Date.now()
        setTypingFrom((prev) => (prev.id === typingId ? prev : { id: typingId, at }))
        const r = nextPoll(pollState.current, { typingAgentId: typingId }, Date.now())
        pollState.current = r.state
        if (page.hasMore) {
          timer = setTimeout(() => void tick(), 0)
          return
        }
        if (r.poll) {
          tail = false
          timer = setTimeout(() => void tick(), GROUP_POLL_MS)
          return
        }
        // One more look after the turn ends, in case the last reply landed just after typing cleared.
        if (!tail) {
          tail = true
          pollState.current = IDLE_POLL
          timer = setTimeout(() => void tick(), GROUP_POLL_MS)
          return
        }
        setAwaiting(false)
        setPolling(false)
      } catch {
        if (!alive) return
        fails += 1
        if (fails >= MAX_POLL_FAILS) {
          setAwaiting(false)
          setPollLost(true)
          setPolling(false)
          return
        }
        timer = setTimeout(() => void tick(), GROUP_POLL_MS)
      }
    }
    timer = setTimeout(() => void tick(), GROUP_POLL_MS)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [fastPoll, conversationId, upsert])

  // One look for new messages now (a panel save adds a system line to the thread).
  const pullNew = useCallback(() => {
    const after = afterCursor(msgsRef.current ?? [])
    if (!conversationId || !after) return
    api.listMessagesAfter(conversationId, after).then(
      (page) => page.messages.length && setMessages((prev) => (prev ? mergeMessages(prev, page.messages) : prev)),
      () => {},
    )
  }, [conversationId])

  // Slow background check while idle.
  useEffect(() => {
    if (!conversationId || fastPoll) return
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return
      const after = afterCursor(msgsRef.current ?? [])
      if (!after) return
      api.listMessagesAfter(conversationId, after).then(
        (page) => page.messages.length && setMessages((prev) => (prev ? mergeMessages(prev, page.messages) : prev)),
        () => {},
      )
    }, IDLE_THREAD_POLL_MS)
    return () => clearInterval(timer)
  }, [conversationId, fastPoll])

  // GAP-G1: how long the current bot has been typing ("· 25s" past 10 s).
  useEffect(() => {
    if (!typingId && !awaiting) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [typingId, awaiting])

  // Mark read on open and as replies land.
  const newestId = messages?.[messages.length - 1]?.id
  const unread = group.unreadCount ?? 0
  useEffect(() => {
    if (!conversationId || messages === undefined) return
    if (document.visibilityState === 'visible') markRead(conversationId)
  }, [conversationId, newestId, unread, messages === undefined, markRead]) // eslint-disable-line react-hooks/exhaustive-deps

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
  }, [newestId, messages?.length, pending, jumpId, typingId, awaiting])

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

  // Jump (palette → message): drop ?m= after showing it (older pages are a click away).
  useEffect(() => {
    if (!jumpId || !messages) return
    const t = setTimeout(() => setParams((p) => (p.delete('m'), p), { replace: true }), 2500)
    return () => clearTimeout(t)
  }, [jumpId, messages === undefined]) // eslint-disable-line react-hooks/exhaustive-deps

  const sending = pending?.status === 'sending'
  const send = useCallback(
    async (raw: string, attachments: Attachment[] = [], taken: Chip[] = []) => {
      const text = raw.trim()
      if ((!text && attachments.length === 0) || sending) return
      setPending({ text, ts: new Date().toISOString(), status: 'sending', attachments })
      setDraft('')
      setSendError(null)
      try {
        const result = await api.sendGroupMessage(conversationId, text, attachments)
        setMessages((prev) => mergeMessages(prev ?? [], result.messages))
        if (result.conversation) upsert(result.conversation)
        setPending(null)
        // BE-5 d5e5a99: the 202 names the lead as typing, so its row (and the "· 25s" clock) starts now.
        const typingNow = typingAfterSend(result.conversation)
        if (typingNow) setTypingFrom({ id: typingNow, at: Date.now() })
        setAwaiting(!typingNow)
        startPoll({ sentAt: Date.now(), sawTyping: Boolean(typingNow) })
      } catch (err) {
        const error = friendly(err, 'The message could not be sent.')
        if (taken.length) {
          // GAP-A6: text and files go back to the composer, the file the 400 names marked.
          setPending(null)
          att.restore(taken, error)
          setDraft((d) => d || text)
          setSendError(sendFailureHint(taken, error))
          return
        }
        setPending({ text, ts: new Date().toISOString(), status: 'error', error, attachments })
      }
    },
    [sending, conversationId, upsert, startPoll, att],
  )

  const drop = useFileDrop(att, !sending)
  const lead = agents.find((a) => a.id === group.leadAgentId)
  const cands = useMemo(() => mentionCandidates(group, agents), [group, agents])
  const renderText = useCallback((t: string, key: string) => renderMentions(t, cands, key), [cands])
  const authorOf = (m: ChatMessage): Agent | undefined => (m.authorAgentId ? agents.find((a) => a.id === m.authorAgentId) : undefined)
  const typingAgent = typingId ? agents.find((a) => a.id === typingId) : undefined
  const turnOver = !typingId && !awaiting && !fastPoll
  const seen = messages ? seenBy(messages, typingId) : null
  const skipped = messages && turnOver ? skippedMentions(messages, group, agents) : []

  // Panel: ?panel=settings[&tab=members|memory|settings] or ?panel=files&path=… (Shared files).
  const panelOpen = settingsOpen(params) || filesPanelOpen(params)
  const tab = groupTab(params)
  const openPanel = () => setParams((p) => withGroupTab(p, 'members'))
  const closePanel = () => setParams((p) => withoutPanel(p), { replace: true })

  // Composer popovers: slash commands, else @mentions (GAP-G11).
  const slash = slashPrefix(draft)
  const slashItems = slash !== null && popClosedFor !== draft ? matchCommands(slash) : []
  const mq = slash === null ? mentionQuery(draft, caret) : null
  const mentionItems = mq && popClosedFor !== draft ? mentionMatches(mq.query, cands) : []
  const popLen = slashItems.length || mentionItems.length
  const popIdx = Math.min(popActive, Math.max(0, popLen - 1))
  const runSlash = (def: CommandDef, args = '') => {
    const reason = shell.runCommand(def.name, args)
    if (reason) setCmdNotice(`/${def.name}: ${reason}`)
    else setDraft('')
  }
  const pickMention = (name: string) => {
    if (!mq) return
    const next = insertMention(draft, mq.start, caret, name)
    setDraft(next.draft)
    setCaret(next.caret)
    setPopActive(0)
    requestAnimationFrame(() => {
      const el = inputRef.current
      if (el) {
        el.focus()
        el.setSelectionRange(next.caret, next.caret)
      }
    })
  }
  const submit = (text: string) => {
    const parsed = parseSlash(text)
    if (parsed) return runSlash(parsed.command, parsed.args)
    if (!att.canSend(text)) return
    if (att.chips.length > 0) {
      const ready = att.ready
      void send(text, ready, att.take())
      return
    }
    void send(text)
  }
  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return
    if (popLen) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setPopActive((i) => Math.max(0, moveActive(i, e.key === 'ArrowDown' ? 1 : -1, popLen)))
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setPopClosedFor(draft)
        return
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault()
        if (slashItems.length) runSlash(slashItems[popIdx])
        else pickMention(mentionItems[popIdx].name)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit(draft)
    }
  }

  const who = (m: ChatMessage, a: Agent | undefined) => (
    <>
      <span className="cf-who__nm">{a?.name ?? DELETED_BOT}</span>
      {m.authorAgentId === group.leadAgentId && <span className="cf-pill">★ Lead</span>}
    </>
  )

  const rows = useMemo(() => {
    if (!messages) return []
    const out: ({ type: 'day'; key: string; label: string } | { type: 'msg'; key: string; m: ChatMessage; day: string | null; index: number })[] = []
    let prev = ''
    messages.forEach((m, index) => {
      const d = new Date(m.createdAt)
      const day = Number.isNaN(d.getTime()) ? '' : `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
      let label: string | null = null
      if (day && day !== prev) {
        prev = day
        label = dayLabel(m.createdAt)
        // 06a: a system line that opens the day carries the day itself ("Today · You created …").
        if (m.kind !== 'system') out.push({ type: 'day', key: `day-${day}`, label })
      }
      out.push({ type: 'msg', key: m.id, m, day: m.kind === 'system' ? label : null, index })
    })
    return out
  }, [messages])
  const lastUserIdx = messages ? messages.map((m) => m.role === 'user' && m.kind !== 'system').lastIndexOf(true) : -1
  const hasChat = Boolean(messages?.some((m) => m.kind !== 'system'))

  const seenMeta = (m: ChatMessage) =>
    seen ? (
      <span title={seen.ids.map((id) => nameOf(id, agents)).join(', ')}>
        Seen by {seen.ids.length} · {clockTime(seen.at)}
        <span className="cf-stack cf-stack--xs" aria-hidden="true">
          {seen.ids.map((id) => {
            const a = agents.find((x) => x.id === id)
            return <Avatar key={id} name={a?.name ?? DELETED_BOT} agentId={id} avatar={a?.avatar} color={a?.color} size="xs" decorative />
          })}
        </span>
      </span>
    ) : (
      clockTime(m.createdAt)
    )

  return (
    <>
      <ChatHeader conversation={group} onInfo={openPanel} />
      <main className="cf-main" {...drop.handlers}>
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
                {rows.map((row) => {
                  if (row.type === 'day') return <div key={row.key} className="cf-daysep">{row.label}</div>
                  const { m } = row
                  if (m.kind === 'system')
                    return (
                      <p key={row.key} className="cf-system" data-mid={m.id}>
                        {systemLineText(m.content, row.day, clockTime(m.createdAt))}
                      </p>
                    )
                  const view = chatMessageView(m)
                  if (view.kind === 'user') {
                    const files = m.attachments ?? []
                    return (
                      <UserRow
                        key={row.key}
                        meta={row.index === lastUserIdx ? seenMeta(m) : clockTime(m.createdAt)}
                        mid={m.id}
                        hit={m.id === jumpId}
                        before={<AttachmentCards attachments={files} ctx={{ groupId: group.id }} />}
                        bare={files.length > 0 && !view.text.trim()}
                      >
                        {renderMentions(view.text, cands, m.id)}
                      </UserRow>
                    )
                  }
                  const author = authorOf(m)
                  const act = activityView(m.activity, undefined, null)
                  const authorChat = author ? conversations?.find((c) => c.kind === 'dm' && c.agentId === author.id)?.id : undefined
                  return (
                    <BotRow
                      key={row.key}
                      author={author}
                      authorName={DELETED_BOT}
                      who={who(m, author)}
                      meta={clockTime(m.createdAt)}
                      error={view.kind === 'error'}
                      mid={m.id}
                      hit={m.id === jumpId}
                      before={act && <ActivityCard view={act} />}
                      after={act && <GroupFileCards files={act.files} groupId={group.id} authorName={author?.name ?? DELETED_BOT} authorChatId={authorChat} />}
                    >
                      {view.kind === 'assistant' ? <Markdown text={view.text} renderText={renderText} /> : view.text}
                    </BotRow>
                  )
                })}
                {!hasChat && !pending && (
                  // GAP-G9: an empty group.
                  <p className="cf-thread__empty" data-gap="GAP-G9">
                    {lead ? `${lead.name} answers first. @mention a bot to bring it in.` : 'No messages yet.'}
                  </p>
                )}
                {skipped.length > 0 && (
                  // GAP-G3: BE-5 gives one message at most 4 bot replies; say who wasn't asked.
                  <p className="cf-system cf-capnote" data-gap="GAP-G3">
                    {skipped.map((id) => nameOf(id, agents)).join(', ')} {skipped.length === 1 ? "wasn't" : "weren't"} asked: each message gets up to 4 replies. @mention{' '}
                    {skipped.length === 1 ? 'it' : 'them'} again to ask.
                  </p>
                )}
                {pending && (
                  <>
                    <UserRow
                      meta={pending.status === 'sending' ? 'Sending…' : clockTime(pending.ts)}
                      before={<AttachmentCards attachments={pending.attachments ?? []} ctx={{ groupId: group.id }} />}
                      bare={Boolean(pending.attachments?.length) && !pending.text}
                    >
                      {renderMentions(pending.text, cands, 'pending')}
                    </UserRow>
                    {pending.status === 'error' && (
                      <p className="cf-sendfail" role="alert">
                        {pending.error}{' '}
                        <button type="button" className="chat__retry" onClick={() => void send(pending.text, pending.attachments)}>
                          Retry
                        </button>
                      </p>
                    )}
                  </>
                )}
                {typingId && (
                  // GAP-G1: who is typing, and for how long once it passes 10 s.
                  <BotRow
                    author={typingAgent}
                    authorName={DELETED_BOT}
                    who={<span className="cf-who__nm">{typingAgent?.name ?? DELETED_BOT}</span>}
                    meta={<span aria-live="polite">{typingLabel(typingAgent?.name ?? DELETED_BOT, typingFrom.id === typingId ? typingFrom.at : null, now)}</span>}
                  >
                    <TypingDots />
                  </BotRow>
                )}
                {!typingId && awaiting && (
                  <p className="cf-system cf-waiting" role="status" data-gap="GAP-G1">
                    Waiting for replies…
                  </p>
                )}
                {pollLost && (
                  <p className="cf-system" role="status">
                    Lost touch with the group.{' '}
                    <button type="button" className="cf-linkbtn" onClick={() => startPoll({ sentAt: Date.now(), sawTyping: false })}>
                      Check again
                    </button>
                  </p>
                )}
              </>
            )}
          </div>
        </section>

        <div className="cf-compwrap">
          {slashItems.length > 0 && (
            <div className="cf-pop cf-slash" role="listbox" id="cf-pop" aria-label="Commands">
              <p className="cf-sec">Commands</p>
              <ul>
                {slashItems.map((def, i) => {
                  const reason = def.unavailable({ conversationId, isGroup: true })
                  return (
                    <li key={def.name}>
                      <button
                        type="button"
                        role="option"
                        id={`cf-pop-${i}`}
                        aria-selected={i === popIdx}
                        aria-disabled={reason !== null || undefined}
                        className={`cf-it${i === popIdx ? ' cf-it--on' : ''}${reason ? ' cf-it--off' : ''}`}
                        onMouseDown={(e) => e.preventDefault()}
                        onMouseMove={() => i !== popIdx && setPopActive(i)}
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
                        {i === popIdx && <kbd className="cf-it__k">↵</kbd>}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}
          {mentionItems.length > 0 && (
            // GAP-G11: @mention autocomplete (members other than the lead, as BE-5 resolves them).
            <div className="cf-pop cf-slash cf-mentionpop" role="listbox" id="cf-pop" aria-label="Mention a bot" data-gap="GAP-G11">
              <p className="cf-sec">Mention a bot</p>
              <ul>
                {mentionItems.map((c, i) => {
                  const a = agents.find((x) => x.id === c.id)
                  return (
                    <li key={c.id}>
                      <button
                        type="button"
                        role="option"
                        id={`cf-pop-${i}`}
                        aria-selected={i === popIdx}
                        className={`cf-it${i === popIdx ? ' cf-it--on' : ''}`}
                        onMouseDown={(e) => e.preventDefault()}
                        onMouseMove={() => i !== popIdx && setPopActive(i)}
                        onClick={() => pickMention(c.name)}
                      >
                        <Avatar name={c.name} agentId={c.id} avatar={a?.avatar} color={a?.color} size="sm" decorative />
                        <span className="cf-it__col">
                          <span className="cf-it__t">{c.name}</span>
                          {a?.role && <span className="cf-it__s">{a.role}</span>}
                        </span>
                        {i === popIdx && <kbd className="cf-it__k">↵</kbd>}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}
          <AttachTray att={att} disabled={sending} />
          <div className={`cf-comp${drop.over ? ' cf-comp--drop' : ''}`} data-gap={drop.over ? 'GAP-A2' : undefined}>
            <AttachButton att={att} disabled={sending} />
            <textarea
              ref={inputRef}
              className="cf-comp__input"
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value)
                setCaret(e.target.selectionStart ?? e.target.value.length)
                setPopActive(0)
                setCmdNotice(null)
              }}
              onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
              onKeyDown={onKey}
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={popLen > 0}
              aria-controls={popLen > 0 ? 'cf-pop' : undefined}
              aria-activedescendant={popLen > 0 ? `cf-pop-${popIdx}` : undefined}
              placeholder={`Message ${group.name}…${lead ? ` ${lead.name} answers, or @ a bot` : ''}`}
              rows={1}
              disabled={sending}
              aria-label="Message"
            />
            <button type="button" className="cf-cbtn cf-cbtn--skills" disabled title="Skills aren't available here yet" aria-label="Skills">
              ✦
            </button>
            <button type="button" className="cf-send" onClick={() => submit(draft)} disabled={sending || !att.canSend(draft)} aria-label={sending ? 'Sending' : 'Send'}>
              {sending ? <span className="spinner" aria-hidden="true" /> : '↑'}
            </button>
          </div>
          {drop.over ? (
            <p className="cf-hint cf-hint--drop">Drop to attach. Files you send are saved in the group&apos;s folder</p>
          ) : sendError ? (
            <p className="cf-hint cf-hint--err" role="alert" data-gap="GAP-A6">Not sent: {sendError}</p>
          ) : cmdNotice ? (
            <p className="cf-hint cf-hint--notice" role="status">{cmdNotice}</p>
          ) : (
            <p className="cf-hint">Enter to send · / for commands · Files you send are saved in the group&apos;s folder</p>
          )}
        </div>
      </main>

      {panelOpen && (
        <GroupSettingsPanel
          group={group}
          agents={agents}
          tab={tab}
          onTab={(t) => setParams((p) => withGroupTab(p, t), { replace: true })}
          filesPath={filesPathParam(params)}
          onFilesPath={(path) => setParams((p) => withFilesPath(p, path), { replace: true })}
          onClose={closePanel}
          onSaved={(g) => {
            upsert(g)
            reloadSidebar()
            pullNew()
          }}
          onDeleted={reloadSidebar}
        />
      )}
    </>
  )
}

