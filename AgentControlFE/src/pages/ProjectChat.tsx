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
  TASK_STATUS_LABELS,
  addBlock,
  addCandidates,
  applyBody,
  createBlock,
  describeProgress,
  initialSelection,
  isFailedResult,
  isTaskResult,
  isUserPrompt,
  latestPrompt,
  latestUnansweredPrompt,
  memberIds,
  mentionCandidates,
  mentionParts,
  mentionQuery,
  mergeMessages,
  needsPolling,
  newerProject,
  nextTeam,
  planAnchors,
  planHasItems,
  pollDelay,
  resyncAfter,
  selectedCount,
  sendLabel,
  sortMessages,
  stickAfterScroll,
  taskBlock,
  taskProgress,
  taskSource,
  toggleAdd,
  toggleCreate,
  toggleTask,
  type ApplyBody,
  type PlanContext,
  type PlanSelection,
  type TextPart,
} from '../lib/project-chat'
import type { Agent, Project, ProjectMessage, ProjectUpdate, TaskStatus, TeamPlan } from '../lib/types'

/* ==========================================================================
   Project chat (/projects/:id): the project's own thread (D-P3). The user
   prompts and Primary (the Team Lead) answers with a team plan. The plan is
   held here, not on the server, as a confirm card: nothing is written until
   Apply (D-P1), which records Primary's reply, the team change and the tasks.
   Cancel just drops the card; so does a reload, after which the prompt offers
   "Ask Primary" again. The page polls while a task is queued or running, and
   while a refresh is failing.
   ========================================================================== */

const MESSAGE_MAX = 20_000

const TASK_PILL: Record<TaskStatus, { cls: string; dot: string }> = {
  queued: { cls: '', dot: ' dot--idle' },
  running: { cls: ' status--active', dot: ' dot--warn dot--pulse' },
  done: { cls: ' status--done', dot: '' },
  failed: { cls: ' status--error', dot: ' dot--danger' },
  cancelled: { cls: ' status--cancelled', dot: ' dot--idle' },
}

/** D-O11: message text with @Name mentions rendered as chips. */
function MentionText({ text, mentions, names }: { text: string; mentions: readonly string[] | undefined; names: Names }) {
  const parts: TextPart[] = mentionParts(text, mentions, (id) => names.byId.get(id)?.name)
  return (
    <>
      {parts.map((p, i) =>
        p.kind === 'text' ? (
          <span key={i}>{p.text}</span>
        ) : (
          <span key={i} className="mention-chip" title={names.of(p.id)}>
            @{p.name}
          </span>
        ),
      )}
    </>
  )
}

/** D-O11: the composer's '@' picker list (keyboard: ↑↓, Enter/Tab, Esc). */
function MentionPicker({ options, index, onPick }: { options: readonly Agent[]; index: number; onPick: (a: Agent) => void }) {
  if (options.length === 0) return null
  return (
    <div className="mention-picker" role="listbox" aria-label="Mention an agent">
      {options.map((a, i) => (
        <button
          key={a.id}
          type="button"
          role="option"
          aria-selected={i === index}
          className={`mention-picker__item${i === index ? ' mention-picker__item--on' : ''}`}
          onMouseDown={(e) => {
            e.preventDefault()
            onPick(a)
          }}
        >
          @{a.name}
          {a.isPrimary ? <span className="mention-picker__tag">lead</span> : null}
        </button>
      ))}
    </div>
  )
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

/** A plan Primary returned for one of the user's prompts, waiting for Apply or Cancel. */
type PendingPlan = {
  messageId: string
  plan: TeamPlan
  /** Bumped per answer, so asking again resets the card's selection. */
  seq: number
}

/* -- Plan confirm card ------------------------------------------------------ */

function PlanCard({
  pending,
  leadName,
  names,
  ctx,
  skillNames,
  onApply,
  onCancel,
}: {
  pending: PendingPlan
  leadName: string
  names: Names
  ctx: PlanContext
  skillNames: Map<string, string>
  onApply: (body: ApplyBody) => Promise<void>
  onCancel: () => void
}) {
  const { plan, messageId } = pending
  const [selection, setSelection] = useState<PlanSelection>(() => initialSelection(plan))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const body = applyBody(plan, selection, ctx, messageId)
  const count = selectedCount(body)
  const hasItems = planHasItems(plan)
  // A plan with nothing to change only offers to keep Primary's reply.
  const canApply = !busy && (hasItems ? count > 0 : Boolean(plan.reply))

  const apply = async () => {
    if (!canApply) return
    setBusy(true)
    setError(null)
    try {
      await onApply(body)
    } catch (err) {
      setError(friendlyError(err, 'Could not apply the plan.'))
    } finally {
      setBusy(false)
    }
  }

  // A validated plan names agents by id, or new specialists by name.
  const assigneeLabel = (agent: string) => {
    const source = taskSource(plan, { agent, task: '' }, ctx)
    if (source.kind === 'create') return `${plan.create[source.index].name} (new)`
    return names.of(source.kind === 'unknown' ? agent : source.agentId)
  }

  const blockedNote = (reason: string | null) => reason && <span className="plan__blocked">{reason}</span>

  return (
    <section className="plan" aria-label="Team plan">
      <div className="plan__head">
        <span className="plan__title">{leadName}</span>
        <span className={`pill${hasItems ? ' pill--lead' : ''}`}>{hasItems ? 'Plan · awaiting your approval' : 'Not saved yet'}</span>
      </div>

      {plan.reply && <div className="plan__reply">{plan.reply}</div>}

      {plan.add.length > 0 && (
        <div className="plan__section">
          <p className="plan__section__title">Add to the team</p>
          {plan.add.map((a) => {
            const agent = names.byId.get(a.agentId)
            const blocked = addBlock(a, ctx)
            const on = !blocked && selection.add.includes(a.agentId)
            return (
              <label className={`skillrow${on ? ' skillrow--on' : ''}${blocked ? ' skillrow--blocked' : ''}`} key={a.agentId}>
                <input
                  type="checkbox"
                  checked={on}
                  disabled={blocked !== null || busy}
                  onChange={() => setSelection((s) => toggleAdd(s, a.agentId))}
                />
                <span className="skillrow__text">
                  <span className="skillrow__name">
                    {names.of(a.agentId)}
                    {agent?.role && <span className="plan__role">{agent.role}</span>}
                  </span>
                  {a.reason && <span className="skillrow__desc">{a.reason}</span>}
                  {blockedNote(blocked)}
                </span>
              </label>
            )
          })}
        </div>
      )}

      {plan.create.length > 0 && (
        <div className="plan__section">
          <p className="plan__section__title">Create project specialists</p>
          {plan.create.map((c, i) => {
            const blocked = createBlock(c, ctx)
            const on = !blocked && selection.create.includes(i)
            const skills = c.skillIds.map((id) => skillNames.get(id) ?? id)
            return (
              <div className="plan__item" key={i}>
                <label className={`skillrow${on ? ' skillrow--on' : ''}${blocked ? ' skillrow--blocked' : ''}`}>
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={blocked !== null || busy}
                    onChange={() => setSelection((s) => toggleCreate(s, i))}
                  />
                  <span className="skillrow__text">
                    <span className="skillrow__name">
                      {c.name}
                      {c.role && <span className="plan__role">{c.role}</span>}
                      <span className="pill pill--project">new</span>
                    </span>
                    {c.reason && <span className="skillrow__desc">{c.reason}</span>}
                    {skills.length > 0 && <span className="plan__skills">Skills: {skills.join(', ')}</span>}
                    {blockedNote(blocked)}
                  </span>
                </label>
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
            const blocked = taskBlock(plan, selection, i, ctx)
            const on = !blocked && selection.tasks.includes(i)
            return (
              <label className={`skillrow${on ? ' skillrow--on' : ''}${blocked ? ' skillrow--blocked' : ''}`} key={i}>
                <input
                  type="checkbox"
                  checked={on}
                  disabled={blocked !== null || busy}
                  onChange={() => setSelection((s) => toggleTask(s, i))}
                />
                <span className="skillrow__text">
                  <span className="skillrow__name">{assigneeLabel(t.agent)}</span>
                  <span className="skillrow__desc plan__task">{t.task}</span>
                  {blockedNote(blocked)}
                </span>
              </label>
            )
          })}
        </div>
      )}

      {plan.warnings.length > 0 && (
        <ul className="plan__warnings">
          {plan.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}

      <div className="plan__foot">
        <p className="plan__hint">
          {!hasItems
            ? plan.reply
              ? 'No team changes or tasks. Keep the reply in the chat, or dismiss it.'
              : `${leadName} proposed nothing for this prompt.`
            : count === 0
              ? 'Nothing selected. Tick what to accept, or cancel the plan.'
              : 'Nothing changes until you apply.'}
        </p>
        {error && (
          <p className="field__err plan__err" role="alert">
            {error}
          </p>
        )}
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>
          {hasItems ? 'Cancel' : 'Dismiss'}
        </button>
        {(hasItems || plan.reply) && (
          <button type="button" className="btn btn--primary" onClick={() => void apply()} disabled={!canApply}>
            {busy && <span className="spinner" aria-hidden="true" />}
            {busy ? 'Applying…' : hasItems ? `Apply (${count})` : 'Keep reply'}
          </button>
        )}
      </div>
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
      <div className="task__body">
        <MentionText text={message.text} mentions={message.mentions} names={names} />
      </div>
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
  // A fresh instance per project: no state (pending plans, in-flight responses) carries over.
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
  // D-O11: the composer's '@' picker — the '@' word under the caret, the
  // highlighted candidate, and the ids picked so far (sent as `mentions`).
  const [mentionAt, setMentionAt] = useState<{ start: number; query: string } | null>(null)
  const [mentionIndex, setMentionIndex] = useState(0)
  const [pickedMentions, setPickedMentions] = useState<string[]>([])
  /** The prompt Primary is planning for, while POST team-plan is in flight. */
  const [planning, setPlanning] = useState<string | null>(null)
  const [planError, setPlanError] = useState<{ messageId: string; message: string } | null>(null)
  /** Plans waiting for Apply or Cancel, by the prompt they answer. Page state only (D-P1). */
  const [plans, setPlans] = useState<Map<string, PendingPlan>>(() => new Map())
  /** "Ask Primary to build a team" with no prompt yet: the composer asks for one. */
  const [askHint, setAskHint] = useState(false)

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
  const planSeq = useRef(0)
  const composerRef = useRef<HTMLTextAreaElement>(null)

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
        // thread stays readable and polling retries with backoff. A project
        // deleted meanwhile drops the thread: "Project not found", no polling.
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
  const take = useCallback((res: Partial<ProjectUpdate>) => {
    if (!alive.current) return
    applied.current = ++ticket.current
    const changed = res.messages
    if (res.project) {
      const next = res.project
      setProject((prev) => newerProject(prev, next))
    }
    if (changed) setMessages((prev) => mergeMessages(prev ?? [], changed))
  }, [])

  /** After a failed action: a 404 or 409 means the page is stale (a deleted project then shows "Project not found"). */
  const resyncOn = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && resyncAfter(err.status)) void refresh()
    },
    [refresh],
  )

  const polling = messages !== undefined && needsPolling(messages, syncError !== null)

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
  // D-O11: the '@' picker's candidates (the pick handler is below, near send).
  const mentionOptions = useMemo(
    () => (mentionAt ? mentionCandidates(primary, project?.teamAgentIds ?? [], agents ?? [], mentionAt.query) : []),
    [mentionAt, primary, project, agents],
  )

  const members = useMemo(() => memberIds(project?.teamAgentIds ?? [], primary?.id), [project, primary])
  const candidates = useMemo(() => addCandidates(agents ?? [], project?.teamAgentIds ?? []), [agents, project])
  const planCtx = useMemo<PlanContext>(
    () => ({ teamAgentIds: project?.teamAgentIds ?? [], primaryId: primary?.id, agents: agents ?? [] }),
    [project, primary, agents],
  )
  const latest = useMemo(() => latestPrompt(messages ?? []), [messages])
  const unanswered = useMemo(() => latestUnansweredPrompt(messages ?? []), [messages])
  const progress = useMemo(() => taskProgress(messages ?? []), [messages])
  // Where each pending plan, planning indicator or plan error shows.
  const anchors = useMemo(() => {
    const ids = [...plans.keys()]
    if (planning && !plans.has(planning)) ids.push(planning)
    if (planError && !ids.includes(planError.messageId)) ids.push(planError.messageId)
    return planAnchors(messages ?? [], ids)
  }, [messages, plans, planning, planError])

  // Stick to the bottom as messages arrive, unless the user scrolled up to read.
  const threadRef = useRef<HTMLElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const lastTop = useRef(0)
  const onScroll = () => {
    const el = threadRef.current
    if (!el) return
    stick.current = stickAfterScroll(stick.current, el, lastTop.current)
    lastTop.current = el.scrollTop
  }
  const count = messages?.length ?? 0
  useEffect(() => {
    if (stick.current) endRef.current?.scrollIntoView({ block: 'end' })
  }, [count, planning, planError, plans])

  /** Ask Primary to plan a prompt; the answer becomes a pending card (nothing is stored). */
  const requestPlan = useCallback(
    async (messageId: string) => {
      if (busy.current.planning) return
      busy.current.planning = true
      setPlanning(messageId)
      setPlanError(null)
      setAskHint(false)
      stick.current = true
      try {
        const result = await api.requestTeamPlan(id, { messageId })
        // The card checks the plan against the team and the library: bring
        // both up to date before it shows (refresh never rejects).
        await refresh()
        if (!alive.current) return
        const answers = result.replyTo ?? messageId
        const seq = ++planSeq.current
        setPlans((prev) => new Map(prev).set(answers, { messageId: answers, plan: result.plan, seq }))
      } catch (err) {
        if (!alive.current) return
        resyncOn(err)
        setPlanError({ messageId, message: friendlyError(err, 'Primary could not plan this.') })
      } finally {
        busy.current.planning = false
        if (alive.current) setPlanning(null)
      }
    },
    [id, refresh, resyncOn],
  )

  const dropPlan = (messageId: string, seq: number) => {
    // Only the card that was answered: asking again meanwhile replaces it with a newer one.
    setPlans((prev) => {
      if (prev.get(messageId)?.seq !== seq) return prev
      const next = new Map(prev)
      next.delete(messageId)
      return next
    })
  }

  const applyPlan = async (pending: PendingPlan, body: ApplyBody) => {
    let update: ProjectUpdate
    try {
      update = await api.applyTeamPlan(id, body)
    } catch (err) {
      resyncOn(err)
      throw err
    }
    stick.current = true
    take(update)
    dropPlan(pending.messageId, pending.seq)
    // New specialists join the library: refetch it for names and the team strip.
    void refresh()
  }

  const retryTask = async (messageId: string) => {
    try {
      take(await api.retryProjectTask(id, messageId))
    } catch (err) {
      resyncOn(err)
      throw err
    }
  }

  const send = async () => {
    const text = draft.trim()
    if (!text || !primary || busy.current.sending || busy.current.planning) return
    // D-O11: send the picked ids whose @Name is still in the text; tagging
    // team members (and not Primary) queues one direct task each.
    const mentions = pickedMentions.filter((pid) => {
      const name = byId.get(pid)?.name
      return name !== undefined && text.includes(`@${name}`)
    })
    busy.current.sending = true
    setSending(true)
    setSendError(null)
    stick.current = true
    try {
      const update = await api.postProjectMessage(id, {
        author: 'user',
        text,
        ...(mentions.length > 0 ? { mentions } : {}),
      })
      take(update)
      setDraft('')
      setPickedMentions([])
      const mine = update.messages.find((m) => m.author === 'user' && m.kind === 'message')
      if (mine) void requestPlan(mine.id)
    } catch (err) {
      if (alive.current) {
        resyncOn(err)
        setSendError(friendlyError(err, 'Could not send the message.'))
      }
    } finally {
      busy.current.sending = false
      if (alive.current) setSending(false)
    }
  }

  /** "Ask Primary to build a team": plan the latest prompt, or ask for one. */
  const askPrimary = () => {
    if (latest) {
      void requestPlan(latest.id)
      return
    }
    setAskHint(true)
    composerRef.current?.focus()
  }

  // Team edits build on the server's current team and library, not this
  // page's copy, so a stale cache neither drops valid ids nor undoes edits
  // made elsewhere; ids of agents deleted since are dropped (PATCH rejects them).
  const saveTeam = async (change: { add?: string[]; remove?: string }) => {
    try {
      const [fresh, roster] = await Promise.all([api.getProject(id), api.listAgents()])
      const teamAgentIds = nextTeam(fresh.teamAgentIds, change, roster.map((a) => a.id))
      take({ project: await api.updateProject(id, { teamAgentIds }) })
    } catch (err) {
      resyncOn(err)
      throw err
    }
    void refresh()
  }

  const removeMember = async () => {
    if (!removeTarget || removing) return
    setRemoving(true)
    setRemoveError(null)
    try {
      await saveTeam({ remove: removeTarget })
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
  const canAsk = Boolean(primary) && !sending && planning === null

  // D-O11: the pick handler replaces the '@word' under the caret with '@Name '.
  const acceptMention = (a: Agent) => {
    if (!mentionAt) return
    const before = draft.slice(0, mentionAt.start)
    const after = draft.slice(mentionAt.start + 1 + mentionAt.query.length)
    const insert = `@${a.name} `
    setDraft(before + insert + after)
    setPickedMentions((prev) => (prev.includes(a.id) ? prev : [...prev, a.id]))
    setMentionAt(null)
    const caret = before.length + insert.length
    requestAnimationFrame(() => {
      composerRef.current?.focus()
      composerRef.current?.setSelectionRange(caret, caret)
    })
  }
  const sendButtonLabel = sendLabel(pickedMentions, primary?.id, (mid) => byId.get(mid)?.name)
  const teamEmpty = Boolean(project) && members.length === 0
  const working = progress.running + progress.queued > 0

  /** What shows after a prompt's last message: planning, the error, the pending card. */
  const renderPlanSlot = (promptId: string) => {
    const pending = plans.get(promptId)
    return (
      <div className="chat__turn" key={`plan-${promptId}`}>
        {pending && (
          <PlanCard
            key={pending.seq}
            pending={pending}
            leadName={primaryName}
            names={names}
            ctx={planCtx}
            skillNames={skillNames}
            onApply={(body) => applyPlan(pending, body)}
            onCancel={() => dropPlan(pending.messageId, pending.seq)}
          />
        )}
        {planning === promptId && <TypingBubble label={`${primaryName} is planning`} speaker={`${primaryName} is planning…`} />}
        {planning !== promptId && planError?.messageId === promptId && (
          <Bubble kind="error" speaker={primaryName}>
            <div className="bubble__body">{planError.message}</div>
            <button type="button" className="chat__retry" onClick={() => void requestPlan(promptId)} disabled={!canAsk}>
              Retry
            </button>
          </Bubble>
        )}
      </div>
    )
  }

  const renderMessage = (m: ProjectMessage, index: number) => {
    const divider =
      index > 0 && isUserPrompt(m) ? (
        <div className="chat__ts">
          <span>{turnTime(m.createdAt)}</span>
        </div>
      ) : null

    let body: ReactNode
    if (m.kind === 'team-update' || m.kind === 'progress') {
      body = (
        <p className="chat__system" role="status">
          <MentionText text={m.text} mentions={m.mentions} names={names} />
        </p>
      )
    } else if (m.kind === 'task-assignment') {
      body = <TaskAssignment message={m} names={names} onRetry={() => retryTask(m.id)} />
    } else if (m.author === 'user') {
      body = (
        <Bubble kind="user">
          <div className="bubble__body">
            <MentionText text={m.text} mentions={m.mentions} names={names} />
          </div>
        </Bubble>
      )
    } else {
      // Primary's applied reply, a task result, or any other agent message.
      const result = isTaskResult(m)
      const failed = isFailedResult(m)
      body = (
        <Bubble kind={failed ? 'error' : 'assistant'} speaker={names.of(m.author)}>
          <div className="bubble__body">
            <MentionText text={m.text} mentions={m.mentions} names={names} />
          </div>
          {result && <div className="bubble__meta">{failed ? 'Task failed' : 'Task result'}</div>}
        </Bubble>
      )
    }

    // A prompt Primary never answered (or whose plan was cancelled or lost to a reload).
    const nudge =
      unanswered?.id === m.id && !plans.has(m.id) && planning === null && planError?.messageId !== m.id && primary ? (
        <div className="chat__nudge">
          <span>{primaryName} has not answered this yet.</span>
          <button type="button" className="chat__retry chat__retry--accent" onClick={() => void requestPlan(m.id)} disabled={!canAsk}>
            Ask {primaryName}
          </button>
        </div>
      ) : null

    return [
      <div className="chat__turn" key={m.id}>
        {divider}
        {body}
        {nudge}
      </div>,
      ...(anchors.get(m.id) ?? []).map(renderPlanSlot),
    ]
  }

  const composerHint = planning !== null
    ? `${primaryName} is planning…`
    : working
      ? `Working: ${describeProgress(progress)}`
      : askHint
        ? `Describe what to build or accomplish; ${primaryName} proposes a team for it.`
        : 'Enter to send · Shift+Enter for a new line'

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
          {teamEmpty && primary && <span className="teamstrip__hint">No members yet.</span>}
          {project && primary && (teamEmpty || latest) && (
            <button
              type="button"
              className={`btn teamstrip__ask${teamEmpty ? ' btn--primary' : ' btn--ghost'}`}
              onClick={askPrimary}
              disabled={!canAsk}
              title={latest ? `Ask ${primaryName} to plan your latest prompt again` : `Describe the project and ${primaryName} proposes a team`}
            >
              {planning !== null && <span className="spinner" aria-hidden="true" />}
              {teamEmpty ? `Ask ${primaryName} to build a team` : `Ask ${primaryName}`}
            </button>
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
            messages.flatMap(renderMessage)
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
            {mentionAt && primary ? (
              <MentionPicker
                options={mentionOptions}
                index={Math.min(mentionIndex, Math.max(mentionOptions.length - 1, 0))}
                onPick={(a) => acceptMention(a)}
              />
            ) : null}
            <textarea
              ref={composerRef}
              className="textarea"
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value)
                setMentionAt(mentionQuery(e.target.value, e.target.selectionStart ?? e.target.value.length))
                setMentionIndex(0)
              }}
              onClick={(e) => setMentionAt(mentionQuery(draft, e.currentTarget.selectionStart ?? 0))}
              onKeyDown={(e) => {
                if (mentionAt && mentionOptions.length > 0) {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault()
                    setMentionIndex((i) => (i + 1) % mentionOptions.length)
                    return
                  }
                  if (e.key === 'ArrowUp') {
                    e.preventDefault()
                    setMentionIndex((i) => (i - 1 + mentionOptions.length) % mentionOptions.length)
                    return
                  }
                  if (e.key === 'Enter' || e.key === 'Tab') {
                    e.preventDefault()
                    acceptMention(mentionOptions[Math.min(mentionIndex, mentionOptions.length - 1)])
                    return
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    setMentionAt(null)
                    return
                  }
                }
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
                {sending ? 'Sending…' : planning !== null ? 'Planning…' : sendButtonLabel}
              </button>
            </div>
          </div>
          {sendError ? (
            <p className="field__err" role="alert">
              {sendError}
            </p>
          ) : (
            <p className="chat__composer__hint">{composerHint}</p>
          )}
        </div>
      </div>

      <AddAgentsDialog
        open={addOpen}
        candidates={candidates}
        projectId={id}
        onClose={() => setAddOpen(false)}
        onAdd={(ids) => saveTeam({ add: ids })}
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
