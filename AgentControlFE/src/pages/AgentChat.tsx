import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Bubble, TypingBubble } from '../components/ChatBubble'
import { StatusPill } from '../components/StatusPill'
import { ProfilePanel } from '../components/ProfilePanel'
import Avatar from '../components/Avatar'
import { ErrorState, Skeleton } from '../components/States'
import { api } from '../lib/api'
import { friendlyError as friendly, turnTime } from '../lib/chat-format'
import type { AgentRun } from '../lib/types'
import { runReplyView } from '../lib/run-reply'
import { useAsync } from '../hooks/useAsync'

/**
 * Collapsed run-audit affordance under a persisted assistant turn. Renders only
 * when the BE recorded a system prompt or tool calls (pre-audit runs omit both
 * fields entirely).
 */
function TurnAudit({ run }: { run: AgentRun }) {
  if (run.systemPrompt === undefined && run.toolCalls === undefined) return null
  const skills = run.skillSnapshot ?? []
  const tools = run.toolCalls ?? []
  const summarized = skills.filter((s) => s.mode === 'summary').length
  const summaryParts: string[] = []
  if (run.systemPrompt !== undefined) {
    const kb = (run.systemPrompt.length / 1024).toFixed(1)
    const asSummaries = summarized > 0 ? `, ${summarized} as ${summarized === 1 ? 'summary' : 'summaries'}` : ''
    summaryParts.push(`System prompt (${kb} KB · ${skills.length} ${skills.length === 1 ? 'skill' : 'skills'}${asSummaries})`)
  }
  if (tools.length > 0) {
    summaryParts.push(`${tools.length} tool ${tools.length === 1 ? 'call' : 'calls'}`)
  }
  return (
    <details className="turn-audit">
      <summary>{summaryParts.join(' · ')}</summary>
      {tools.length > 0 && (
        <ul className="turn-audit__tools">
          {tools.map((t, i) => (
            <li key={i} className={t.ok ? undefined : 'turn-audit__tool--fail'}>
              {t.ok ? '✓' : '✗'} {t.name}{' '}
              <code>
                {t.arguments.length > 80 ? `${t.arguments.slice(0, 80)}…` : t.arguments}
              </code>{' '}
              → {t.resultChars.toLocaleString('en-US')} chars
            </li>
          ))}
        </ul>
      )}
      {skills.length > 0 && (
        <ul className="turn-audit__skills">
          {skills.map((s) => (
            <li key={s.id}>
              {s.name}
              {s.mode === 'summary' && (
                <span
                  className="pill turn-audit__mode"
                  title="Only a short summary went into the prompt; the agent could read the full text with get_skill."
                >
                  summary
                </span>
              )}{' '}
              — {s.contentChars.toLocaleString('en-US')} chars
            </li>
          ))}
        </ul>
      )}
      {run.systemPrompt !== undefined &&
        (run.systemPrompt === '' ? (
          <p className="turn-audit__empty">No system prompt was sent.</p>
        ) : (
          <pre className="turn-audit__prompt">{run.systemPrompt}</pre>
        ))}
    </details>
  )
}

/** A turn awaiting server confirmation: optimistic user bubble + typing/error state. */
type Pending = {
  input: string
  ts: string
  status: 'typing' | 'done' | 'error'
  run?: AgentRun
  error?: string
}

function RunReply({ run }: { run: AgentRun }) {
  const view = runReplyView(run)
  return (
    <Bubble kind={view.kind}>
      <div className="bubble__body">{view.text}</div>
    </Bubble>
  )
}

export default function AgentChat() {
  const { id = '' } = useParams()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [pending, setPending] = useState<Pending | null>(null)

  const loadAgent = useCallback(() => api.getAgent(id), [id])
  const agent = useAsync(loadAgent, [id])
  const endpoints = useAsync(api.listEndpoints, [])
  const skills = useAsync(api.listSkills, [])

  // Transcript fetcher with manual reload — unlike useAsync, refetches keep
  // the previous data rendered, so the thread never blanks mid-send.
  const [runsList, setRunsList] = useState<AgentRun[] | undefined>(undefined)
  const [runsError, setRunsError] = useState<Error | undefined>(undefined)
  const [runTick, setRunTick] = useState(0)
  useEffect(() => {
    let active = true
    api.listAgentRuns(id).then(
      (data) => {
        if (active) {
          setRunsList(data)
          setRunsError(undefined)
        }
      },
      (err: unknown) => {
        if (active) setRunsError(err instanceof Error ? err : new Error(String(err)))
      },
    )
    return () => {
      active = false
    }
  }, [id, runTick])
  const reloadRuns = useCallback(() => setRunTick((n) => n + 1), [])

  // GET /api/agents/:id/runs is newest-first; the chat reads oldest-first.
  // Runs made for a project task belong to that project's chat, not this one.
  // The BE now returns personal runs only; the filter just guards older BEs.
  const sortedRuns = (runsList ?? []).filter((r) => !r.projectId).sort((a, b) => a.startedAt.localeCompare(b.startedAt))

  // The optimistic turn disappears once the refetched transcript contains it;
  // derived during render so no clearing effect is needed.
  const pendingActive =
    pending &&
    !runsError &&
    !(
      pending.status === 'done' &&
      pending.run &&
      (runsList ?? []).some((r) => r.id === pending.run?.id)
    )
      ? pending
      : null

  // Stick to the bottom as turns arrive.
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [sortedRuns.length, pendingActive])

  const send = async (text: string) => {
    const input = text.trim()
    if (!input || sending) return
    setSending(true)
    setPending({ input, ts: new Date().toISOString(), status: 'typing' })
    setDraft('')
    try {
      const run = await api.runAgent(id, input)
      setPending({ input, ts: new Date().toISOString(), status: 'done', run })
      reloadRuns()
    } catch (err) {
      setPending({ input, ts: new Date().toISOString(), status: 'error', error: friendly(err, 'The run failed.') })
    } finally {
      setSending(false)
    }
  }

  return (
    <main className="page page--chat">
      <div className="page__inner">
        <header className="chat__header">
          <div className="chat__header__left">
            {agent.data && (
              <button
                type="button"
                className="chat__header__avatar"
                onClick={() => setSettingsOpen(true)}
                aria-label={`Open ${agent.data.name}'s profile`}
              >
                <Avatar name={agent.data.name} agentId={agent.data.id} avatar={agent.data.avatar} color={agent.data.color} size="md" decorative />
              </button>
            )}
            <div className="chat__header__id">
              <h1 className="chat__header__name">{agent.data?.name ?? ''}</h1>
              {agent.data?.role && <p className="chat__header__role">{agent.data.role}</p>}
            </div>
            {agent.data && (
              <span className="chat__header__status">
                <StatusPill status={agent.data.status} />
              </span>
            )}
            {agent.data?.isPrimary && (
              <span className="pill pill--lead">
                Team Lead
              </span>
            )}
          </div>
          <div className="chat__header__right">
            <button
              type="button"
              className="btn"
              onClick={() => setSettingsOpen(true)}
              aria-label="Agent profile"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="3.2" />
                <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.65 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.08a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.08a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1.05Z" />
              </svg>
              Profile
            </button>
          </div>
        </header>

        <section className="chat__thread" aria-label="Conversation">
          {runsError ? (
            <div className="chat__thread__error">
              <ErrorState title="Could not load the conversation" error={runsError} onRetry={reloadRuns} />
            </div>
          ) : !runsList ? (
            <div className="chat__thread__placeholder">
              <Skeleton height={12} width="30%" />
              <Skeleton height={64} width="70%" />
              <Skeleton height={64} width="55%" />
            </div>
          ) : (
            <>
              {sortedRuns.map((run, i) => (
                <div className="chat__turn" key={run.id}>
                  {i > 0 && (
                    <div className="chat__ts">
                      <span>{turnTime(run.startedAt)}</span>
                    </div>
                  )}
                  <Bubble kind="user">
                    <div className="bubble__body">{run.input}</div>
                  </Bubble>
                  <RunReply run={run} />
                  <TurnAudit run={run} />
                </div>
              ))}

              {pendingActive && (
                <div className="chat__turn">
                  {sortedRuns.length > 0 && (
                    <div className="chat__ts">
                      <span>{turnTime(pendingActive.ts)}</span>
                    </div>
                  )}
                  <Bubble kind="user">
                    <div className="bubble__body">{pendingActive.input}</div>
                  </Bubble>
                  {pendingActive.status === 'typing' && <TypingBubble label="Agent is typing" />}
                  {pendingActive.status === 'done' && pendingActive.run && (
                    <>
                      <RunReply run={pendingActive.run} />
                    </>
                  )}
                  {pendingActive.status === 'error' && (
                    <Bubble kind="error">
                      <div className="bubble__body">{pendingActive.error}</div>
                      <button type="button" className="chat__retry" onClick={() => void send(pendingActive.input)}>
                        Retry
                      </button>
                    </Bubble>
                  )}
                </div>
              )}
            </>
          )}
          <div ref={endRef} />
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
              placeholder="Message this agent…"
              rows={1}
              disabled={sending}
              aria-label="Message"
            />
            <div className="chat__composer__actions">
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => void send(draft)}
                disabled={sending || !draft.trim()}
              >
                {sending && <span className="spinner" aria-hidden="true" />}
                {sending ? 'Sending…' : 'Send'}
              </button>
            </div>
          </div>
          <p className="chat__composer__hint">Enter to send · Shift+Enter for a new line</p>
        </div>
      </div>

      <ProfilePanel
        open={settingsOpen}
        agent={agent.data ?? null}
        endpoints={endpoints.data ?? []}
        skills={skills.data ?? []}
        onClose={() => setSettingsOpen(false)}
        onSaved={agent.reload}
        onCleared={reloadRuns}
      />
    </main>
  )
}
