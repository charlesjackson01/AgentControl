import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Bubble, TypingBubble } from '../components/ChatBubble'
import ConfirmDialog from '../components/ConfirmDialog'
import Dialog from '../components/Dialog'
import { EmptyState, ErrorState, Skeleton } from '../components/States'
import { ChevronLeftIcon, PlusIcon, ProjectsIcon } from '../components/icons'
import { api, ApiError } from '../lib/api'
import { friendlyError, turnTime } from '../lib/chat-format'
import {
  PLAN_STATUS_LABELS,
  TASK_STATUS_LABELS,
  addCandidates,
  applyBody,
  describeProgress,
  failedResultIds,
  initialSelection,
  isTaskBlocked,
  isUserPrompt,
  latestUnansweredPrompt,
  memberIds,
  mergeMessages,
  needsPolling,
  newerProject,
  planHasItems,
  planProgress,
  pollDelay,
  selectedCount,
  sortMessages,
  taskSource,
  toggleAdd,
  toggleCreate,
  toggleTask,
  type PlanSelection,
} from '../lib/project-chat'
import type { Agent, Project, ProjectMessage, TaskStatus, TeamPlan, TeamPlanApply, TeamPlanResponse } from '../lib/types'

/* ==========================================================================
   Project chat (/projects/:id): the project's own thread (D-P3). The user
   prompts, Primary (the Team Lead) answers with a team plan; team changes
   wait for Apply (D-P1), then tasks run and report back here. The page polls
   while Primary plans or a task is queued/running.
   ========================================================================== */

const MESSAGE_MAX = 20_000

const TASK_PILL: Record<TaskStatus, { cls: string; dot: string }> = {
  queued: { cls: '', dot: ' dot--idle' },
  running: { cls: ' status--active', dot: ' dot--warn dot--pulse' },
  done: { cls: ' status--done', dot: '' },
  failed: { cls: ' status--error', dot: ' dot--danger' },
}

function TaskPill({ status }: { status: TaskStatus }) {
  const pill = TASK_PILL[status] ?? TASK_PILL.queued
  return (
    <span className={`status${pill.cls}`}>
      <span className={`dot${pill.dot}`} />
      {TASK_STATUS_LABELS[status] ?? status}
    </span>
  )
}

type Names = {
  /** Display name for a message author or assignee id. */
  of: (id: string | undefined) => string
  byId: Map<string, Agent>
}

/* -- Plan confirm card ------------------------------------------------------ */

function PlanCard({
  message,
  plan,
  names,
  availableIds,
  skillNames,
  progress,
  onApply,
  onCancel,
}: {
  message: ProjectMessage
  plan: TeamPlan
  names: Names
  /** Agents a task can go to without a team change: the team and Primary. */
  availableIds: string[]
  skillNames: Map<string, string>
  progress: string
  onApply: (body: Required<TeamPlanApply>) => Promise<void>
  onCancel: () => Promise<void>
}) {
  const [selection, setSelection] = useState<PlanSelection>(() => initialSelection(plan))
  const [busy, setBusy] = useState<'apply' | 'cancel' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const status = message.planStatus ?? 'applied'
  const pending = status === 'pending'
  const body = applyBody(plan, selection, availableIds)
  const count = selectedCount(body)

  const run = async (kind: 'apply' | 'cancel') => {
    if (busy) return
    setBusy(kind)
    setError(null)
    try {
      if (kind === 'apply') await onApply(body)
      else await onCancel()
    } catch (err) {
      setError(friendlyError(err, kind === 'apply' ? 'Could not apply the plan.' : 'Could not cancel the plan.'))
    } finally {
      setBusy(null)
    }
  }

  const assigneeLabel = (agent: string) => {
    const source = taskSource(plan, { agent, task: '' }, availableIds)
    if (source.kind === 'create') return `${plan.create[source.index].name} (new)`
    return names.of(source.agentId)
  }

  const items = (
    <>
      {plan.add.length > 0 && (
        <div className="plan__section">
          <p className="plan__section__title">Add to the team</p>
          {plan.add.map((a) => {
            const agent = names.byId.get(a.agentId)
            const on = selection.add.includes(a.agentId)
            const text = (
              <span className="skillrow__text">
                <span className="skillrow__name">
                  {names.of(a.agentId)}
                  {agent?.role && <span className="plan__role">{agent.role}</span>}
                </span>
                {a.reason && <span className="skillrow__desc">{a.reason}</span>}
              </span>
            )
            return pending ? (
              <label className={`skillrow${on ? ' skillrow--on' : ''}`} key={a.agentId}>
                <input type="checkbox" checked={on} disabled={busy !== null} onChange={() => setSelection((s) => toggleAdd(s, a.agentId))} />
                {text}
              </label>
            ) : (
              <div className="plan__row" key={a.agentId}>
                {text}
              </div>
            )
          })}
        </div>
      )}
      {plan.create.length > 0 && (
        <div className="plan__section">
          <p className="plan__section__title">Create project specialists</p>
          {plan.create.map((c, i) => {
            const on = selection.create.includes(i)
            const skills = c.skillIds.map((id) => skillNames.get(id) ?? id)
            const text = (
              <span className="skillrow__text">
                <span className="skillrow__name">
                  {c.name}
                  {c.role && <span className="plan__role">{c.role}</span>}
                  <span className="pill pill--project">new</span>
                </span>
                {c.reason && <span className="skillrow__desc">{c.reason}</span>}
                {skills.length > 0 && <span className="plan__skills">Skills: {skills.join(', ')}</span>}
              </span>
            )
            return (
              <div className="plan__item" key={i}>
                {pending ? (
                  <label className={`skillrow${on ? ' skillrow--on' : ''}`}>
                    <input type="checkbox" checked={on} disabled={busy !== null} onChange={() => setSelection((s) => toggleCreate(s, i))} />
                    {text}
                  </label>
                ) : (
                  <div className="plan__row">{text}</div>
                )}
                {c.instructions && (
                  <details className="turn-audit plan__instructions">
                    <summary>Instructions</summary>
                    <pre className="turn-audit__prompt">{c.instructions}</pre>
                  </details>
                )}
              </div>
            )
          })}
        </div>
      )}
      {plan.tasks.length > 0 && (
        <div className="plan__section">
          <p className="plan__section__title">Tasks</p>
          {plan.tasks.map((t, i) => {
            const blocked = pending && isTaskBlocked(plan, selection, i, availableIds)
            const on = !blocked && selection.tasks.includes(i)
            const text = (
              <span className="skillrow__text">
                <span className="skillrow__name">{assigneeLabel(t.agent)}</span>
                <span className="skillrow__desc plan__task">{t.task}</span>
                {blocked && <span className="plan__blocked">Skipped: its agent is not joining the team.</span>}
              </span>
            )
            return pending ? (
              <label className={`skillrow${on ? ' skillrow--on' : ''}${blocked ? ' skillrow--blocked' : ''}`} key={i}>
                <input
                  type="checkbox"
                  checked={on}
                  disabled={blocked || busy !== null}
                  onChange={() => setSelection((s) => toggleTask(s, i))}
                />
                {text}
              </label>
            ) : (
              <div className="plan__row" key={i}>
                {text}
              </div>
            )
          })}
        </div>
      )}
    </>
  )

  const total = plan.add.length + plan.create.length + plan.tasks.length

  return (
    <section className={`plan${pending ? '' : ' plan--settled'}`} aria-label="Team plan">
      <div className="plan__head">
        <span className="plan__title">Team plan</span>
        <span className={`pill${status === 'pending' ? ' pill--lead' : status === 'applied' ? ' pill--done' : ''}`}>
          {PLAN_STATUS_LABELS[status] ?? status}
        </span>
        {status === 'applied' && progress && <span className="plan__progress">{progress}</span>}
      </div>

      {pending ? (
        items
      ) : (
        <details className="turn-audit plan__review">
          <summary>
            Show proposal ({total} {total === 1 ? 'item' : 'items'})
          </summary>
          <div className="plan__review__body">{items}</div>
        </details>
      )}

      {plan.warnings.length > 0 && (
        <ul className="plan__warnings">
          {plan.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}

      {pending && (
        <div className="plan__foot">
          <p className="plan__hint">
            {count === 0 ? 'Nothing selected. Tick what to accept, or cancel the plan.' : 'Team changes happen only when you apply.'}
          </p>
          {error && (
            <p className="field__err plan__err" role="alert">
              {error}
            </p>
          )}
          <button type="button" className="btn" onClick={() => void run('cancel')} disabled={busy !== null}>
            {busy === 'cancel' ? 'Cancelling…' : 'Cancel'}
          </button>
          <button type="button" className="btn btn--primary" onClick={() => void run('apply')} disabled={busy !== null || count === 0}>
            {busy === 'apply' && <span className="spinner" aria-hidden="true" />}
            {busy === 'apply' ? 'Applying…' : `Apply (${count})`}
          </button>
        </div>
      )}
    </section>
  )
}

/* -- Task assignment row ------------------------------------------------------ */

function TaskAssignment({
  message,
  names,
  onRetry,
}: {
  message: ProjectMessage
  names: Names
  onRetry: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const status = message.taskStatus ?? 'queued'

  const retry = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await onRetry()
    } catch (err) {
      setError(friendlyError(err, 'Could not retry the task.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`task task--${status}`}>
      <div className="task__head">
        <span className="task__route">
          {message.assigneeId === message.author
            ? `${names.of(message.author)} took this task`
            : `${names.of(message.author)} → ${names.of(message.assigneeId)}`}
        </span>
        <TaskPill status={status} />
      </div>
      <div className="task__body">{message.text}</div>
      {status === 'failed' && (
        <button type="button" className="chat__retry" onClick={() => void retry()} disabled={busy}>
          {busy ? 'Retrying…' : 'Retry'}
        </button>
      )}
      {error && (
        <p className="field__err" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

/* -- Team dialogs ------------------------------------------------------------- */

function AddAgentsDialog({
  open,
  candidates,
  projectId,
  onClose,
  onAdd,
}: {
  open: boolean
  candidates: Agent[]
  projectId: string
  onClose: () => void
  onAdd: (ids: string[]) => Promise<void>
}) {
  const [picked, setPicked] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const close = () => {
    if (saving) return
    setPicked([])
    setError(null)
    onClose()
  }

  const submit = async () => {
    if (saving || picked.length === 0) return
    setSaving(true)
    setError(null)
    try {
      await onAdd(picked)
      setPicked([])
      onClose()
    } catch (err) {
      setError(friendlyError(err, 'Could not update the team.'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={open}
      title="Add agents to the team"
      subtitle="Pick library agents for this project. The Team Lead is always available and does not need adding."
      onClose={close}
      footer={
        <>
          <button type="button" className="btn" onClick={close} disabled={saving}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" onClick={() => void submit()} disabled={saving || picked.length === 0}>
            {saving ? 'Adding…' : picked.length > 1 ? `Add ${picked.length} agents` : 'Add to team'}
          </button>
        </>
      }
    >
      {candidates.length === 0 ? (
        <p className="field__hint">
          Every library agent is already on this team.{' '}
          <Link to="/agents/new" className="link">
            Create a new agent
          </Link>
        </p>
      ) : (
        <div className="skillpick" role="group" aria-label="Library agents">
          {candidates.map((a) => {
            const on = picked.includes(a.id)
            return (
              <label className={`skillrow${on ? ' skillrow--on' : ''}`} key={a.id}>
                <input
                  type="checkbox"
                  checked={on}
                  disabled={saving}
                  onChange={() => setPicked((prev) => (prev.includes(a.id) ? prev.filter((x) => x !== a.id) : [...prev, a.id]))}
                />
                <span className="skillrow__text">
                  <span className="skillrow__name">
                    {a.name}
                    {a.role && <span className="plan__role">{a.role}</span>}
                    {a.projectId === projectId && <span className="pill pill--project">project</span>}
                  </span>
                  {a.description && <span className="skillrow__desc">{a.description}</span>}
                </span>
              </label>
            )
          })}
        </div>
      )}
      {error && (
        <p className="field__err" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  )
}

/* -- Page ----------------------------------------------------------------------- */

export default function ProjectChat() {
  const { id = '' } = useParams()
  // A fresh instance per project: no state (or in-flight response) carries over.
  return <ProjectChatPage key={id} id={id} />
}

function ProjectChatPage({ id }: { id: string }) {
  const [project, setProject] = useState<Project | undefined>(undefined)
  const [messages, setMessages] = useState<ProjectMessage[] | undefined>(undefined)
  const [agents, setAgents] = useState<Agent[] | undefined>(undefined)
  const [skillNames, setSkillNames] = useState<Map<string, string>>(new Map())
  const [loadError, setLoadError] = useState<Error | undefined>(undefined)
  const [syncError, setSyncError] = useState<string | null>(null)

  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  /** The prompt Primary is planning for, while POST team-plan is in flight. */
  const [planning, setPlanning] = useState<string | null>(null)
  const [planError, setPlanError] = useState<{ messageId: string; message: string } | null>(null)

  const [addOpen, setAddOpen] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<string | null>(null)
  const [removing, setRemoving] = useState(false)
  const [removeError, setRemoveError] = useState<string | null>(null)

  // Every refresh and every route response takes a ticket. A refresh applies
  // only if nothing newer landed since it started, so a slow poll never rolls
  // the thread, the team or the agent list back.
  const ticket = useRef(0)
  const applied = useRef(0)
  const alive = useRef(true)
  const busy = useRef({ sending: false, planning: false })
  const failures = useRef(0)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  /** Refetch project, messages and agents together; settles once the refetch is applied or dropped. */
  const refresh = useCallback((): Promise<void> => {
    const mine = ++ticket.current
    return Promise.all([api.getProject(id), api.listProjectMessages(id), api.listAgents()]).then(
      ([p, list, roster]) => {
        if (!alive.current || mine < applied.current) return
        applied.current = mine
        setProject(p)
        setMessages(sortMessages(list))
        setAgents(roster)
        setLoadError(undefined)
        setSyncError(null)
        failures.current = 0
      },
      (err: unknown) => {
        if (!alive.current || mine < applied.current) return
        const error = err instanceof Error ? err : new Error(String(err))
        failures.current += 1
        // Before the first load the whole page shows the error; afterwards the
        // thread stays readable and a notice says updates paused. A project
        // deleted meanwhile drops the thread, which also stops polling.
        setLoadError(error)
        setSyncError(friendlyError(error, 'Could not refresh the project.'))
        if (error instanceof ApiError && error.status === 404) setMessages(undefined)
      },
    )
  }, [id])

  useEffect(() => {
    void refresh()
    // Skill names only label proposed specialists; a failure just shows ids.
    api.listSkills().then(
      (skills) => {
        if (alive.current) setSkillNames(new Map(skills.map((s) => [s.id, s.name])))
      },
      () => undefined,
    )
  }, [refresh])

  /** Fold a route response in and mark it newest, so refreshes already in flight are dropped. */
  const take = useCallback((res: Partial<TeamPlanResponse>) => {
    if (!alive.current) return
    applied.current = ++ticket.current
    const changed = res.messages
    if (res.project) {
      const next = res.project
      setProject((prev) => newerProject(prev, next))
    }
    if (changed) setMessages((prev) => mergeMessages(prev ?? [], changed))
  }, [])

  const polling = messages !== undefined && needsPolling(messages, planning !== null)

  // Chained timeouts: one request in flight at a time, backing off on errors,
  // stopped when idle and on unmount.
  useEffect(() => {
    if (!polling) return
    let stopped = false
    let timer = 0
    const tick = async () => {
      await refresh()
      if (!stopped) timer = window.setTimeout(() => void tick(), pollDelay(failures.current))
    }
    timer = window.setTimeout(() => void tick(), pollDelay(failures.current))
    return () => {
      stopped = true
      window.clearTimeout(timer)
    }
  }, [polling, refresh])

  const primary = useMemo(() => agents?.find((a) => a.isPrimary), [agents])
  const byId = useMemo(() => new Map((agents ?? []).map((a) => [a.id, a])), [agents])
  const names = useMemo<Names>(
    () => ({
      byId,
      of: (agentId) => {
        if (agentId === 'user') return 'You'
        if (!agentId) return 'Unassigned'
        return byId.get(agentId)?.name ?? 'Removed agent'
      },
    }),
    [byId],
  )
  const members = useMemo(() => memberIds(project?.teamAgentIds ?? [], primary?.id), [project, primary])
  const candidates = useMemo(() => addCandidates(agents ?? [], project?.teamAgentIds ?? []), [agents, project])
  const availableIds = useMemo(
    () => [...(project?.teamAgentIds ?? []), ...(primary ? [primary.id] : [])],
    [project, primary],
  )
  const answered = useMemo(
    () => new Set((messages ?? []).filter((m) => m.kind === 'team-plan' && m.replyTo).map((m) => m.replyTo as string)),
    [messages],
  )
  const unanswered = useMemo(() => latestUnansweredPrompt(messages ?? []), [messages])
  const failedResults = useMemo(() => failedResultIds(messages ?? []), [messages])

  // Stick to the bottom as messages arrive, unless the user scrolled up to read.
  const threadRef = useRef<HTMLElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const onScroll = () => {
    const el = threadRef.current
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
  }
  const count = messages?.length ?? 0
  useEffect(() => {
    if (stick.current) endRef.current?.scrollIntoView({ block: 'end' })
  }, [count, planning, planError])

  const requestPlan = useCallback(
    async (messageId: string) => {
      if (busy.current.planning) return
      busy.current.planning = true
      setPlanning(messageId)
      setPlanError(null)
      stick.current = true
      try {
        take(await api.requestTeamPlan(id, messageId))
      } catch (err) {
        if (alive.current) setPlanError({ messageId, message: friendlyError(err, 'Primary could not plan this.') })
      } finally {
        busy.current.planning = false
        if (alive.current) setPlanning(null)
        // New specialists, a changed team or a plan created by a lost
        // response: resync either way.
        void refresh()
      }
    },
    [id, take, refresh],
  )

  const send = async () => {
    const text = draft.trim()
    if (!text || !primary || busy.current.sending || busy.current.planning) return
    busy.current.sending = true
    setSending(true)
    setSendError(null)
    stick.current = true
    try {
      const message = await api.postProjectMessage(id, { author: 'user', text })
      take({ messages: [message] })
      setDraft('')
      void requestPlan(message.id)
    } catch (err) {
      if (alive.current) setSendError(friendlyError(err, 'Could not send the message.'))
    } finally {
      busy.current.sending = false
      if (alive.current) setSending(false)
    }
  }

  const applyPlan = async (messageId: string, body: Required<TeamPlanApply>) => {
    try {
      take(await api.applyTeamPlan(id, messageId, body))
    } finally {
      void refresh()
    }
  }

  const cancelPlan = async (messageId: string) => {
    try {
      take(await api.cancelTeamPlan(id, messageId))
    } finally {
      void refresh()
    }
  }

  const retryTask = async (messageId: string) => {
    try {
      take(await api.retryProjectTask(id, messageId))
    } finally {
      void refresh()
    }
  }

  // PATCH rejects unknown ids, so ids of agents deleted since they joined
  // (shown as "Removed agent") are dropped with any team edit.
  const saveTeam = async (teamAgentIds: string[]) => {
    const known = [...new Set(teamAgentIds)].filter((agentId) => byId.has(agentId))
    take({ project: await api.updateProject(id, { teamAgentIds: known }) })
  }

  const removeMember = async () => {
    if (!project || !removeTarget || removing) return
    setRemoving(true)
    setRemoveError(null)
    try {
      await saveTeam(project.teamAgentIds.filter((x) => x !== removeTarget))
      setRemoveTarget(null)
    } catch (err) {
      setRemoveError(friendlyError(err, 'Could not update the team.'))
    } finally {
      setRemoving(false)
    }
  }

  const closeRemove = () => {
    if (removing) return
    setRemoveTarget(null)
    setRemoveError(null)
  }

  /* -- Render ------------------------------------------------------------------ */

  if (loadError && !messages) {
    const missing = loadError instanceof ApiError && loadError.status === 404
    return (
      <main className="page">
        <div className="page__inner">
          <Link to="/projects" className="detail__back">
            <ChevronLeftIcon size={14} />
            Projects
          </Link>
          <ErrorState
            title={missing ? 'Project not found' : 'Could not load the project'}
            error={missing ? new Error('It may have been deleted.') : loadError}
            onRetry={
              missing
                ? undefined
                : () => {
                    setLoadError(undefined)
                    void refresh()
                  }
            }
          />
        </div>
      </main>
    )
  }

  const primaryName = primary?.name ?? 'Primary'
  const removeAgent = removeTarget ? byId.get(removeTarget) : undefined
  // Typing stays open while Primary plans; only sending waits.
  const canSend = Boolean(primary) && !sending && planning === null

  const renderMessage = (m: ProjectMessage, index: number) => {
    const divider =
      index > 0 && isUserPrompt(m) ? (
        <div className="chat__ts">
          <span>{turnTime(m.createdAt)}</span>
        </div>
      ) : null

    let body: ReactNode
    if (m.kind === 'team-plan') {
      const plan = m.plan
      body = (
        <>
          <Bubble kind="assistant" speaker={names.of(m.author)}>
            <div className="bubble__body">{plan?.reply || m.text}</div>
          </Bubble>
          {plan && planHasItems(plan) ? (
            <PlanCard
              message={m}
              plan={plan}
              names={names}
              availableIds={availableIds}
              skillNames={skillNames}
              progress={describeProgress(planProgress(messages ?? [], m.id))}
              onApply={(b) => applyPlan(m.id, b)}
              onCancel={() => cancelPlan(m.id)}
            />
          ) : (
            plan &&
            plan.warnings.length > 0 && (
              <ul className="plan__warnings plan__warnings--loose">
                {plan.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )
          )}
        </>
      )
    } else if (m.kind === 'team-update') {
      body = (
        <p className="chat__system" role="status">
          {m.text}
        </p>
      )
    } else if (m.kind === 'task-assignment') {
      body = <TaskAssignment message={m} names={names} onRetry={() => retryTask(m.id)} />
    } else if (m.author === 'user') {
      body = (
        <Bubble kind="user">
          <div className="bubble__body">{m.text}</div>
        </Bubble>
      )
    } else {
      // task-result and plain agent messages: the agent's own bubble.
      body = (
        <Bubble kind={failedResults.has(m.id) ? 'error' : 'assistant'} speaker={names.of(m.author)}>
          <div className="bubble__body">{m.text}</div>
          {m.kind === 'task-result' && <div className="bubble__meta">Task result</div>}
        </Bubble>
      )
    }

    // What follows a prompt Primary has not answered: planning, the error, or a nudge.
    let after: ReactNode = null
    if (isUserPrompt(m) && !answered.has(m.id)) {
      if (planning === m.id) {
        after = <TypingBubble label={`${primaryName} is planning`} speaker={`${primaryName} is planning…`} />
      } else if (planError?.messageId === m.id) {
        after = (
          <Bubble kind="error" speaker={primaryName}>
            <div className="bubble__body">{planError.message}</div>
            <button type="button" className="chat__retry" onClick={() => void requestPlan(m.id)} disabled={planning !== null}>
              Retry
            </button>
          </Bubble>
        )
      } else if (unanswered?.id === m.id && primary && planning === null) {
        after = (
          <div className="chat__nudge">
            <span>{primaryName} has not answered this yet.</span>
            <button type="button" className="chat__retry chat__retry--accent" onClick={() => void requestPlan(m.id)}>
              Ask {primaryName}
            </button>
          </div>
        )
      }
    }

    return (
      <div className="chat__turn" key={m.id}>
        {divider}
        {body}
        {after}
      </div>
    )
  }

  return (
    <main className="page page--chat">
      <div className="page__inner">
        <header className="chat__header">
          <div className="chat__header__left">
            <Link to="/projects" className="btn btn--ghost btn--icon" aria-label="Back to Projects">
              <ChevronLeftIcon size={17} />
            </Link>
            {project ? (
              <div className="chat__header__id">
                <h1 className="chat__header__name">{project.name}</h1>
                {project.desc && <p className="chat__header__role">{project.desc}</p>}
                <p className="project__folder" title="Project folder">
                  {project.folder}
                </p>
              </div>
            ) : (
              <div className="chat__header__id project__header__skel">
                <Skeleton width={180} height={14} />
                <Skeleton width={260} height={9} />
              </div>
            )}
          </div>
        </header>

        <section className="teamstrip" aria-label="Team">
          <span className="teamstrip__label">Team</span>
          {primary ? (
            <span className="teamchip teamchip--lead">
              <Link to={`/agents/${primary.id}`} className="teamchip__name">
                {primary.name}
              </Link>
              <span className="pill pill--lead">Team Lead</span>
            </span>
          ) : agents ? (
            <span className="teamchip teamchip--missing">No Team Lead yet</span>
          ) : (
            <Skeleton width={120} height={22} />
          )}
          {project &&
            members.map((memberId) => {
              const agent = byId.get(memberId)
              const name = names.of(memberId)
              return (
                <span className="teamchip" key={memberId}>
                  {agent ? (
                    <Link to={`/agents/${agent.id}`} className="teamchip__name">
                      {name}
                    </Link>
                  ) : (
                    <span className="teamchip__name">{name}</span>
                  )}
                  {agent?.role && <span className="teamchip__role">{agent.role}</span>}
                  {agent?.projectId === project.id && <span className="pill pill--project">project</span>}
                  <button
                    type="button"
                    className="teamchip__remove"
                    aria-label={`Remove ${name} from the team`}
                    title="Remove from the team"
                    onClick={() => {
                      setRemoveError(null)
                      setRemoveTarget(memberId)
                    }}
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true">
                      <path d="M6 6l12 12M18 6 6 18" />
                    </svg>
                  </button>
                </span>
              )
            })}
          {project && primary && members.length === 0 && (
            <span className="teamstrip__hint">
              No members yet. Describe what you want and {primaryName} will propose specialists.
            </span>
          )}
          {project && (
            <button type="button" className="btn btn--ghost teamstrip__add" onClick={() => setAddOpen(true)}>
              <PlusIcon size={14} />
              Add agent
            </button>
          )}
        </section>

        <section className="chat__thread" aria-label="Project conversation" ref={threadRef} onScroll={onScroll}>
          {!messages ? (
            <div className="chat__thread__placeholder">
              <Skeleton height={12} width="30%" />
              <Skeleton height={64} width="70%" />
              <Skeleton height={64} width="55%" />
            </div>
          ) : messages.length === 0 ? (
            <div className="chat__thread__empty">
              <EmptyState
                icon={<ProjectsIcon size={20} />}
                title="Start the project"
                text={
                  primary
                    ? `Describe what you want to build or accomplish. ${primaryName} checks the team, proposes specialists if any are missing, and assigns tasks once you approve.`
                    : 'Create the Team Lead first: it reads your prompt, assembles the team and assigns tasks.'
                }
              />
            </div>
          ) : (
            messages.map(renderMessage)
          )}
          <div ref={endRef} />
        </section>

        <div className="chat__composer">
          {syncError && messages && (
            <p className="notice notice--warn" role="status">
              Updates paused: {syncError} Retrying…
            </p>
          )}
          {!primary && agents ? (
            <p className="notice notice--info">
              Project chat needs a Team Lead to plan the work.{' '}
              <Link to="/agents" className="link">
                Set one up in onboarding
              </Link>
              .
            </p>
          ) : null}
          <div className="chat__composer__input">
            <textarea
              className="textarea"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void send()
                }
              }}
              placeholder={primary ? `Tell ${primaryName} what to do…` : 'Create the Team Lead first'}
              rows={1}
              maxLength={MESSAGE_MAX}
              disabled={!primary || sending}
              aria-label="Message"
            />
            <div className="chat__composer__actions">
              <button type="button" className="btn btn--primary" onClick={() => void send()} disabled={!canSend || !draft.trim()}>
                {(sending || planning !== null) && <span className="spinner" aria-hidden="true" />}
                {sending ? 'Sending…' : planning !== null ? 'Planning…' : 'Send'}
              </button>
            </div>
          </div>
          {sendError ? (
            <p className="field__err" role="alert">
              {sendError}
            </p>
          ) : (
            <p className="chat__composer__hint">
              {planning !== null ? `${primaryName} is planning…` : 'Enter to send · Shift+Enter for a new line'}
            </p>
          )}
        </div>
      </div>

      <AddAgentsDialog
        open={addOpen}
        candidates={candidates}
        projectId={id}
        onClose={() => setAddOpen(false)}
        onAdd={(ids) => saveTeam([...(project?.teamAgentIds ?? []), ...ids])}
      />

      <ConfirmDialog
        open={removeTarget !== null}
        title={`Remove ${removeTarget ? names.of(removeTarget) : 'agent'} from the team?`}
        subtitle="The agent stays in your library; only this project's team changes."
        confirmLabel="Remove from team"
        loading={removing}
        onCancel={closeRemove}
        onConfirm={() => void removeMember()}
      >
        <p className="prose">
          {removeAgent?.projectId === id
            ? `${removeAgent.name} was created for this project. It stays in the library, tagged with the project, and you can add it back later.`
            : 'You can add the agent back at any time.'}
        </p>
        {removeError && (
          <p className="field__err" role="alert">
            {removeError}
          </p>
        )}
      </ConfirmDialog>
    </main>
  )
}
