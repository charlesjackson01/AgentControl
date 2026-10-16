import type { Agent, Project, ProjectMessage, TaskStatus, TeamPlan, TeamPlanAdd, TeamPlanApply, TeamPlanCreate, TeamPlanTask } from './types'

/* ==========================================================================
   Project chat helpers (pure, no React; covered by tests/project-chat.test.mjs).
   The page owns fetching; these decide ordering, freshness, where a pending
   plan shows, the plan confirm card's selection (D-P1) and when to poll.

   A team plan lives only in the page until the user applies it: POST
   team-plan writes nothing, POST team-plan/apply writes Primary's reply, the
   team update and the task assignments (each with replyTo = the prompt).
   ========================================================================== */

/** Poll cadence while a task is queued/running or a refresh failed. */
export const POLL_MS = 1500

/** Longest wait between polls after repeated failures. */
export const POLL_MAX_MS = 12_000

/** A task's result: an agent's message that answers a task-assignment. */
export function isTaskResult(m: ProjectMessage): boolean {
  return m.kind === 'message' && m.author !== 'user' && Boolean(m.taskId)
}

/** A result that reports a failed attempt (it records its own outcome). */
export function isFailedResult(m: ProjectMessage): boolean {
  return isTaskResult(m) && m.taskStatus === 'failed'
}

/** Within one timestamp: Primary's reply, the team update, the tasks, then task results. */
function rank(m: ProjectMessage): number {
  if (m.kind === 'team-update') return 1
  if (m.kind === 'task-assignment') return 2
  return isTaskResult(m) ? 3 : 0
}

/** Oldest first; ties keep reply → team-update → task → result, then the given order. */
export function sortMessages(messages: readonly ProjectMessage[]): ProjectMessage[] {
  return [...messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || rank(a) - rank(b))
}

/** Version of a record: the BE sets updatedAt whenever it changes a task or a project. */
function stamp(record: { createdAt: string; updatedAt?: string }): string {
  return record.updatedAt ?? record.createdAt
}

/**
 * Fold changed messages (a route response) into the thread: new ids join it,
 * known ids are replaced unless the copy already held is newer — so a slow
 * response never rolls a task status back.
 */
export function mergeMessages(current: readonly ProjectMessage[], incoming: readonly ProjectMessage[]): ProjectMessage[] {
  const byId = new Map(current.map((m) => [m.id, m]))
  for (const m of incoming) {
    const held = byId.get(m.id)
    if (!held || stamp(m) >= stamp(held)) byId.set(m.id, m)
  }
  return sortMessages([...byId.values()])
}

/** The fresher of two copies of the same project (by updatedAt). */
export function newerProject(held: Project | undefined, incoming: Project): Project {
  return held && held.id === incoming.id && held.updatedAt > incoming.updatedAt ? held : incoming
}

/* -- Prompts and where plans show ------------------------------------------ */

/** A prompt the user typed (the only message POST team-plan answers). */
export function isUserPrompt(m: ProjectMessage): boolean {
  return m.kind === 'message' && m.author === 'user'
}

/** The newest user prompt, or null when the user has not written yet. */
export function latestPrompt(messages: readonly ProjectMessage[]): ProjectMessage | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) if (isUserPrompt(messages[i])) return messages[i]
  return null
}

/**
 * The newest user prompt while no applied plan answers it (Primary was never
 * asked, the request failed, the plan was cancelled, or the page reloaded
 * before Apply: plans are not stored); null otherwise.
 */
export function latestUnansweredPrompt(messages: readonly ProjectMessage[]): ProjectMessage | null {
  const latest = latestPrompt(messages)
  if (!latest) return null
  return messages.some((m) => m.replyTo === latest.id) ? null : latest
}

/**
 * Where each prompt's pending plan (or planning indicator, or error) shows:
 * after the last message that belongs to the prompt — the prompt itself, what
 * an earlier apply wrote for it (replyTo), and its tasks' results. Keyed by
 * that anchor message id, prompts in the given order; a prompt no longer in
 * the thread is left out.
 */
export function planAnchors(messages: readonly ProjectMessage[], promptIds: readonly string[]): Map<string, string[]> {
  const wanted = new Set(promptIds)
  const last = new Map<string, string>()
  const taskPrompt = new Map<string, string>()
  for (const m of messages) {
    let owner: string | undefined
    if (wanted.has(m.id)) owner = m.id
    else if (m.replyTo && wanted.has(m.replyTo)) owner = m.replyTo
    else if (m.taskId) owner = taskPrompt.get(m.taskId)
    if (m.kind === 'task-assignment' && m.replyTo && wanted.has(m.replyTo)) taskPrompt.set(m.id, m.replyTo)
    // Replies count only after their prompt (a prompt missing from the thread anchors nothing).
    if (owner && (owner === m.id || last.has(owner))) last.set(owner, m.id)
  }
  const anchors = new Map<string, string[]>()
  for (const promptId of wanted) {
    const anchor = last.get(promptId)
    if (anchor) anchors.set(anchor, [...(anchors.get(anchor) ?? []), promptId])
  }
  return anchors
}

/** Within this many pixels of the end, the thread counts as at the bottom. */
export const STICK_PX = 120

/**
 * Whether the thread keeps following new messages after a scroll event. Near
 * the bottom it sticks; it lets go only when the reader scrolls up. A smooth
 * scroll on its way down passes through positions far from the bottom, and
 * those must not let go (a prompt sent right after the page loads would then
 * scroll out of view).
 */
export function stickAfterScroll(
  stuck: boolean,
  el: { scrollTop: number; scrollHeight: number; clientHeight: number },
  lastTop: number,
): boolean {
  if (el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX) return true
  return el.scrollTop < lastTop ? false : stuck
}

/* -- Polling and progress ---------------------------------------------------- */

/** Derived UI state for one task-assignment (Part 3). Waiting/on-hold are never stored. */
export type TaskState =
  | { kind: 'ready'; reason?: string }
  | { kind: 'running' }
  | { kind: 'done' }
  | { kind: 'failed' }
  | { kind: 'cancelled' }
  | { kind: 'waiting'; reason: string }
  | { kind: 'onHold'; reason: string }
  | { kind: 'paused'; reason: string }

function assignmentById(messages: readonly ProjectMessage[], id: string): ProjectMessage | undefined {
  return messages.find((m) => m.id === id && m.kind === 'task-assignment')
}

/**
 * Ready / waiting / on hold / paused for a queued task, or the stored status
 * once it has left the queue. Reasons name the blocking label when known.
 */
export function taskState(task: ProjectMessage, messages: readonly ProjectMessage[], paused = false): TaskState {
  if (task.kind !== 'task-assignment') return { kind: 'ready' }
  const status = task.taskStatus
  if (status === 'running') return { kind: 'running' }
  if (status === 'done') return { kind: 'done' }
  if (status === 'failed') return { kind: 'failed' }
  if (status === 'cancelled') return { kind: 'cancelled' }
  if (status !== 'queued') return { kind: 'ready' }

  if (paused) return { kind: 'paused', reason: 'Paused' }

  const inputs = task.inputs ?? []
  if (inputs.length === 0) return { kind: 'ready' }

  const blockers: { label: string; status: TaskStatus | undefined }[] = []
  for (const id of inputs) {
    const src = assignmentById(messages, id)
    if (!src || src.taskStatus !== 'done') {
      blockers.push({ label: src?.label ?? id.slice(0, 8), status: src?.taskStatus })
    }
  }
  if (blockers.length === 0) return { kind: 'ready' }

  const failed = blockers.filter((b) => b.status === 'failed' || b.status === 'cancelled')
  if (failed.length > 0) {
    const names = failed.map((b) => b.label).join(', ')
    return { kind: 'onHold', reason: `On hold: needs ${names}` }
  }
  const names = blockers.map((b) => b.label).join(', ')
  return { kind: 'waiting', reason: `Waiting for ${names}` }
}

/** True when a queued task can start now (all inputs done, project not paused). */
export function isReadyTask(task: ProjectMessage, messages: readonly ProjectMessage[], paused = false): boolean {
  return taskState(task, messages, paused).kind === 'ready' && task.taskStatus === 'queued'
}

/**
 * Poll while a task is running, or while a ready task is queued (project not
 * paused), and while the last refresh failed (with backoff) so "Updates paused"
 * recovers on its own. Held/waiting tasks alone must not poll forever (Part 3).
 */
export function needsPolling(
  messages: readonly ProjectMessage[],
  syncFailed: boolean,
  paused = false,
): boolean {
  if (syncFailed) return true
  if (messages.some((m) => m.kind === 'task-assignment' && m.taskStatus === 'running')) return true
  if (paused) return false
  return messages.some(
    (m) => m.kind === 'task-assignment' && m.taskStatus === 'queued' && isReadyTask(m, messages, false),
  )
}

/**
 * Tasks that list `taskId` in `inputs`, plus their transitive dependents
 * (orchestration Part 2 cancel confirm). Order is discovery order.
 */
export function descendants(taskId: string, messages: readonly ProjectMessage[]): ProjectMessage[] {
  const open = new Set([taskId])
  const found: ProjectMessage[] = []
  let grew = true
  while (grew) {
    grew = false
    for (const m of messages) {
      if (m.kind !== 'task-assignment' || !m.inputs?.length) continue
      if (found.some((f) => f.id === m.id) || open.has(m.id)) continue
      if (!m.inputs.some((id) => open.has(id))) continue
      found.push(m)
      open.add(m.id)
      grew = true
    }
  }
  return found
}

/** WorkBar line: "1 running · 1 queued" or "Paused · 2 queued". */
export function workBarLabel(progress: TaskProgress, paused: boolean): string {
  if (paused) {
    const waiting = progress.queued + progress.running
    if (waiting === 0) return 'Paused'
    return `Paused · ${waiting} ${waiting === 1 ? 'task' : 'tasks'} waiting`
  }
  const parts: string[] = []
  if (progress.running > 0) parts.push(`${progress.running} running`)
  if (progress.queued > 0) parts.push(`${progress.queued} queued`)
  if (progress.failed > 0) parts.push(`${progress.failed} failed`)
  if (progress.cancelled > 0) parts.push(`${progress.cancelled} cancelled`)
  return parts.join(' · ')
}

/** Delay before the next poll: POLL_MS, doubling per consecutive failure up to POLL_MAX_MS. */
export function pollDelay(failures: number): number {
  return Math.min(POLL_MS * 2 ** Math.min(Math.max(failures, 0), 4), POLL_MAX_MS)
}

/**
 * After a failed send, plan, apply or retry: refetch when the server says the
 * page is out of date — 404 (the project or record is gone; a deleted project
 * then shows "Project not found") or 409 (state changed, e.g. no Team Lead, a
 * name taken, a task no longer failed).
 */
export function resyncAfter(status: number | undefined): boolean {
  return status === 404 || status === 409
}

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

export type TaskProgress = Record<TaskStatus, number> & { total: number }

/** Task counts across the project's assignments. */
export function taskProgress(messages: readonly ProjectMessage[]): TaskProgress {
  const counts: TaskProgress = { queued: 0, running: 0, done: 0, failed: 0, cancelled: 0, total: 0 }
  for (const m of messages) {
    if (m.kind !== 'task-assignment') continue
    counts.total += 1
    if (m.taskStatus && m.taskStatus in counts) counts[m.taskStatus] += 1
  }
  return counts
}

/** "3 tasks · 1 running · 1 queued · 1 done"; empty when there are none. */
export function describeProgress(progress: TaskProgress): string {
  if (progress.total === 0) return ''
  const parts = [`${progress.total} ${progress.total === 1 ? 'task' : 'tasks'}`]
  for (const status of ['running', 'queued', 'done', 'failed', 'cancelled'] as const) {
    if (progress[status] > 0) parts.push(`${progress[status]} ${TASK_STATUS_LABELS[status].toLowerCase()}`)
  }
  return parts.join(' · ')
}

/* -- Team strip ----------------------------------------------------------- */

/** Team members shown as chips: the project's team without Primary (the lead is shown on its own), deduplicated. */
export function memberIds(teamAgentIds: readonly string[], primaryId: string | undefined): string[] {
  return [...new Set(teamAgentIds)].filter((id) => id !== primaryId)
}

/** Library agents the "Add agent" picker offers: not on the team and not Primary. */
export function addCandidates(agents: readonly Agent[], teamAgentIds: readonly string[]): Agent[] {
  const team = new Set(teamAgentIds)
  return agents.filter((a) => !a.isPrimary && !team.has(a.id))
}

/**
 * The team after an edit, built on the server's current team and library (the
 * page fetches both first): deduplicated, the removed id gone, new ids
 * appended, and ids of agents no longer in the library dropped (PATCH rejects
 * unknown ids).
 */
export function nextTeam(
  current: readonly string[],
  change: { add?: readonly string[]; remove?: string },
  libraryIds: readonly string[],
): string[] {
  const known = new Set(libraryIds)
  return [...new Set([...current, ...(change.add ?? [])])].filter((id) => id !== change.remove && known.has(id))
}

/* -- Plan confirm card (D-P1) ---------------------------------------------- */

/** What the user accepts: agent ids from plan.add, indexes into plan.create and plan.tasks. */
export type PlanSelection = {
  add: string[]
  create: number[]
  tasks: number[]
}

/**
 * What the card checks a plan against, as fresh as the page has it (it
 * refetches when a plan arrives): the team, Primary, and the library. The BE
 * validates the submitted plan again on apply; this keeps the count and the
 * body to what it will accept.
 */
export type PlanContext = {
  teamAgentIds: readonly string[]
  primaryId: string | undefined
  agents: readonly Pick<Agent, 'id' | 'name'>[]
}

const norm = (s: string): string => s.trim().toLowerCase()

/** True when the plan proposes anything to confirm (team changes or tasks). */
export function planHasItems(plan: TeamPlan): boolean {
  return plan.add.length > 0 || plan.create.length > 0 || plan.tasks.length > 0
}

/** Everything starts accepted; the user unticks what they do not want. */
export function initialSelection(plan: TeamPlan): PlanSelection {
  return {
    add: [...new Set(plan.add.map((a) => a.agentId))],
    create: plan.create.map((_, i) => i),
    tasks: plan.tasks.map((_, i) => i),
  }
}

function toggle<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value]
}

export function toggleAdd(selection: PlanSelection, agentId: string): PlanSelection {
  return { ...selection, add: toggle(selection.add, agentId) }
}

export function toggleCreate(selection: PlanSelection, index: number): PlanSelection {
  return { ...selection, create: toggle(selection.create, index) }
}

export function toggleTask(selection: PlanSelection, index: number): PlanSelection {
  return { ...selection, tasks: toggle(selection.tasks, index) }
}

/** Why a proposed addition cannot apply now, or null. */
export function addBlock(entry: TeamPlanAdd, ctx: PlanContext): string | null {
  if (!ctx.agents.some((a) => a.id === entry.agentId)) return 'No longer in the library.'
  if (entry.agentId === ctx.primaryId) return 'Already leads the team.'
  if (ctx.teamAgentIds.includes(entry.agentId)) return 'Already on the team.'
  return null
}

/** Why a proposed specialist cannot be created now (its name was taken since), or null. */
export function createBlock(entry: TeamPlanCreate, ctx: PlanContext): string | null {
  const name = norm(entry.name)
  return ctx.agents.some((a) => norm(a.name) === name) ? `An agent named "${entry.name.trim()}" exists now.` : null
}

/**
 * Who a plan task is for: an agent already available (Primary or a team
 * member), a library agent the plan adds, a specialist the plan creates
 * (matched by name, ignoring case and surrounding spaces), or nobody the
 * plan or team knows.
 */
export type TaskSource =
  | { kind: 'agent'; agentId: string }
  | { kind: 'add'; agentId: string }
  | { kind: 'create'; index: number }
  | { kind: 'unknown' }

export function taskSource(plan: TeamPlan, task: TeamPlanTask, ctx: PlanContext): TaskSource {
  if (task.agent === ctx.primaryId || ctx.teamAgentIds.includes(task.agent)) return { kind: 'agent', agentId: task.agent }
  if (plan.add.some((a) => a.agentId === task.agent)) return { kind: 'add', agentId: task.agent }
  // By name, in the order the BE resolves it on apply: the lead and the team,
  // then agents the plan adds, then a specialist the plan creates.
  const name = norm(task.agent)
  const member = ctx.agents.find(
    (a) => (a.id === ctx.primaryId || ctx.teamAgentIds.includes(a.id)) && norm(a.name) === name,
  )
  if (member) return { kind: 'agent', agentId: member.id }
  const added = ctx.agents.find((a) => plan.add.some((x) => x.agentId === a.id) && norm(a.name) === name)
  if (added) return { kind: 'add', agentId: added.id }
  const index = plan.create.findIndex((c) => norm(c.name) === name)
  if (index >= 0) return { kind: 'create', index }
  return { kind: 'unknown' }
}

/**
 * Why a task would be dropped on apply, or null when it can run: its agent
 * must be Primary, on the team, an accepted addition that still exists, or an
 * accepted specialist whose name is still free.
 */
export function taskBlock(plan: TeamPlan, selection: PlanSelection, index: number, ctx: PlanContext): string | null {
  const task = plan.tasks[index]
  if (!task) return 'Not part of this plan.'
  const source = taskSource(plan, task, ctx)
  const gone = 'Skipped: its agent is no longer in the library.'
  const notJoining = 'Skipped: its agent is not joining the team.'
  if (source.kind === 'agent') return ctx.agents.some((a) => a.id === source.agentId) ? null : gone
  if (source.kind === 'add') {
    const entry = plan.add.find((a) => a.agentId === source.agentId)
    if (!entry || addBlock(entry, ctx)) return gone
    return selection.add.includes(source.agentId) ? null : notJoining
  }
  if (source.kind === 'create') {
    if (createBlock(plan.create[source.index], ctx)) return 'Skipped: its new specialist cannot be created.'
    return selection.create.includes(source.index) ? null : notJoining
  }
  return 'Skipped: its agent is not on the team or in this plan.'
}

export function isTaskBlocked(plan: TeamPlan, selection: PlanSelection, index: number, ctx: PlanContext): boolean {
  return taskBlock(plan, selection, index, ctx) !== null
}

/** An apply body with every list explicit (an omitted list would accept everything). */
export type ApplyBody = TeamPlanApply & { add: string[]; create: number[]; tasks: number[] }

/**
 * Body for POST /api/projects/:id/team-plan/apply: the plan as Primary sent
 * it, the prompt it answers, and the accepted entries in plan order, without
 * duplicates, out-of-range entries, or anything blocked (the BE would drop or
 * refuse it, so it is neither sent nor counted).
 */
export function applyBody(plan: TeamPlan, selection: PlanSelection, ctx: PlanContext, replyTo?: string): ApplyBody {
  const add: string[] = []
  for (const a of plan.add) {
    if (!add.includes(a.agentId) && selection.add.includes(a.agentId) && !addBlock(a, ctx)) add.push(a.agentId)
  }
  const create = plan.create.map((_, i) => i).filter((i) => selection.create.includes(i) && !createBlock(plan.create[i], ctx))
  const tasks = plan.tasks.map((_, i) => i).filter((i) => selection.tasks.includes(i) && !taskBlock(plan, selection, i, ctx))
  return { plan, ...(replyTo ? { replyTo } : {}), add, create, tasks }
}

/** How many entries an apply body accepts (Apply is disabled at zero when the plan has items). */
export function selectedCount(body: ApplyBody): number {
  return body.add.length + body.create.length + body.tasks.length
}

/* -- D-O11 mentions -------------------------------------------------------- */

/**
 * Composer picker candidates: Primary and the team, filtered by the text the
 * user typed after '@' (case-insensitive substring on the name).
 */
export function mentionCandidates(
  primary: Agent | undefined,
  teamAgentIds: readonly string[],
  agents: readonly Agent[],
  query: string,
): Agent[] {
  const team = new Set(teamAgentIds)
  const pool: Agent[] = []
  if (primary) pool.push(primary)
  for (const a of agents) if (team.has(a.id) && a.id !== primary?.id) pool.push(a)
  const q = query.trim().toLowerCase()
  if (!q) return pool
  return pool.filter((a) => a.name.toLowerCase().includes(q))
}

/**
 * The '@' query for the picker from the current draft and caret: the word
 * the caret sits in, when it starts with '@'. Null when no picker should show.
 */
export function mentionQuery(draft: string, caret: number): { start: number; query: string } | null {
  const before = draft.slice(0, caret)
  const at = before.lastIndexOf('@')
  if (at === -1) return null
  const gap = before.slice(at + 1)
  // The gap must still be a word in progress: no whitespace or punctuation.
  if (/[\s@]/.test(gap)) return null
  return { start: at, query: gap }
}

/**
 * Text split into plain parts and @Name chips for one message: chips come
 * from the BE's `mentions` (agent ids) matched against the text by name.
 * A name is matched case-insensitively, longest first, at word boundaries;
 * unmatched mention ids are ignored (the agent may have been renamed).
 */
export type TextPart = { kind: 'text'; text: string } | { kind: 'mention'; id: string; name: string }

export function mentionParts(text: string, mentions: readonly string[] | undefined, nameOf: (id: string) => string | undefined): TextPart[] {
  if (!mentions || mentions.length === 0) return [{ kind: 'text', text }]
  const names: { id: string; name: string }[] = []
  for (const id of mentions) {
    const name = nameOf(id)
    if (name) names.push({ id, name })
  }
  if (names.length === 0) return [{ kind: 'text', text }]
  names.sort((a, b) => b.name.length - a.name.length)

  const parts: TextPart[] = []
  const pushText = (t: string) => {
    if (!t) return
    const last = parts[parts.length - 1]
    if (last && last.kind === 'text') last.text += t
    else parts.push({ kind: 'text', text: t })
  }

  const lower = text.toLowerCase()
  let i = 0
  while (i < text.length) {
    // Earliest match wins; names are sorted longest-first so a tie at the
    // same position picks the longer name.
    let hit: { at: number; id: string; end: number } | null = null
    for (const m of names) {
      const needle = `@${m.name.toLowerCase()}`
      let at = lower.indexOf(needle, i)
      while (at !== -1) {
        const end = at + needle.length
        const next = text[end]
        // A name ends at a word boundary; the '@' must start a word too.
        const prev = text[at - 1]
        const boundaryOk = (end >= text.length || !/[\p{L}\p{N}_]/u.test(next ?? '')) && (at === 0 || !/[\p{L}\p{N}_]/u.test(prev ?? ''))
        if (boundaryOk) {
          if (!hit || at < hit.at) hit = { at, id: m.id, end }
          break
        }
        at = lower.indexOf(needle, at + 1)
      }
    }
    if (!hit) {
      pushText(text.slice(i))
      break
    }
    pushText(text.slice(i, hit.at))
    parts.push({ kind: 'mention', id: hit.id, name: text.slice(hit.at + 1, hit.end) })
    i = hit.end
  }
  return parts
}

/** The send button's label: who the picked @tags address (D-O11). */
export function sendLabel(picked: readonly string[], primaryId: string | undefined, nameOf: (id: string) => string | undefined): string {
  const team = picked.filter((id) => id !== primaryId)
  if (team.length > 0) return `Send to ${team.map((id) => `@${nameOf(id) ?? '?'}`).join(', ')}`
  if (picked.length > 0) return `Ask @${(primaryId && nameOf(primaryId)) ?? 'Primary'}`
  return 'Send'
}
