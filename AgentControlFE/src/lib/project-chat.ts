import type {
  Agent,
  PlanStatus,
  Project,
  ProjectMessage,
  ProjectMessageKind,
  TaskStatus,
  TeamPlan,
  TeamPlanApply,
  TeamPlanTask,
} from './types'

/* ==========================================================================
   Project chat helpers (pure, no React; covered by tests/project-chat.test.mjs).
   The page owns fetching; these decide ordering, freshness, the plan confirm
   card's selection (D-P1) and when to poll.
   ========================================================================== */

/** Poll cadence while a plan request or a task is in flight. */
export const POLL_MS = 1500

/** Longest wait between polls after repeated failures. */
export const POLL_MAX_MS = 12_000

/** Within one timestamp, a plan reads before the team change and tasks it caused. */
const KIND_ORDER: Record<ProjectMessageKind, number> = {
  message: 0,
  'team-plan': 1,
  'team-update': 2,
  'task-assignment': 3,
  'task-result': 4,
}

/** Oldest first; ties keep the plan → team-update → task order, then the given order. */
export function sortMessages(messages: readonly ProjectMessage[]): ProjectMessage[] {
  return [...messages].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || (KIND_ORDER[a.kind] ?? 0) - (KIND_ORDER[b.kind] ?? 0),
  )
}

/** Version of a record: the BE sets updatedAt whenever it changes a plan, a task or a project. */
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

/** A prompt the user typed (the only kind POST team-plan accepts). */
export function isUserPrompt(m: ProjectMessage): boolean {
  return m.kind === 'message' && m.author === 'user'
}

/**
 * The newest user prompt when no plan answers it yet (e.g. the plan request
 * failed, or the page reloaded mid-request); null otherwise.
 */
export function latestUnansweredPrompt(messages: readonly ProjectMessage[]): ProjectMessage | null {
  let latest: ProjectMessage | null = null
  for (const m of messages) if (isUserPrompt(m)) latest = m
  if (!latest) return null
  const id = latest.id
  return messages.some((m) => m.kind === 'team-plan' && m.replyTo === id) ? null : latest
}

/**
 * Results to show as failures. A result records its own outcome
 * (taskStatus); for results saved before it did, the latest result of each
 * task that is failed right now (a retried task's older result reads as history).
 */
export function failedResultIds(messages: readonly ProjectMessage[]): Set<string> {
  const ids = new Set<string>()
  const failed = new Set<string>()
  for (const m of messages) if (m.kind === 'task-assignment' && m.taskStatus === 'failed') failed.add(m.id)
  const latest = new Map<string, ProjectMessage>()
  for (const m of messages) {
    if (m.kind !== 'task-result') continue
    if (m.taskStatus) {
      if (m.taskStatus === 'failed') ids.add(m.id)
      continue
    }
    if (!m.taskId || !failed.has(m.taskId)) continue
    const held = latest.get(m.taskId)
    if (!held || m.createdAt >= held.createdAt) latest.set(m.taskId, m)
  }
  for (const m of latest.values()) ids.add(m.id)
  return ids
}

/** Poll while Primary is planning or any task is queued or running. */
export function needsPolling(messages: readonly ProjectMessage[], planInFlight: boolean): boolean {
  return (
    planInFlight ||
    messages.some((m) => m.kind === 'task-assignment' && (m.taskStatus === 'queued' || m.taskStatus === 'running'))
  )
}

/** Delay before the next poll: POLL_MS, doubling per consecutive failure up to POLL_MAX_MS. */
export function pollDelay(failures: number): number {
  return Math.min(POLL_MS * 2 ** Math.min(Math.max(failures, 0), 4), POLL_MAX_MS)
}

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
}

export const PLAN_STATUS_LABELS: Record<PlanStatus, string> = {
  pending: 'Awaiting your approval',
  applied: 'Applied',
  cancelled: 'Cancelled',
}

/** Task counts for one plan's assignments, for the applied card's summary line. */
export function planProgress(messages: readonly ProjectMessage[], planId: string): Record<TaskStatus, number> & { total: number } {
  const counts = { queued: 0, running: 0, done: 0, failed: 0, total: 0 }
  for (const m of messages) {
    if (m.kind !== 'task-assignment' || m.planId !== planId) continue
    counts.total += 1
    if (m.taskStatus && m.taskStatus in counts) counts[m.taskStatus] += 1
  }
  return counts
}

/** "3 tasks · 1 done · 1 running"; empty when the plan assigned nothing. */
export function describeProgress(progress: Record<TaskStatus, number> & { total: number }): string {
  if (progress.total === 0) return ''
  const parts = [`${progress.total} ${progress.total === 1 ? 'task' : 'tasks'}`]
  for (const status of ['running', 'queued', 'done', 'failed'] as const) {
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

/* -- Plan confirm card (D-P1) ---------------------------------------------- */

/** What the user accepts: agent ids from plan.add, indexes into plan.create and plan.tasks. */
export type PlanSelection = {
  add: string[]
  create: number[]
  tasks: number[]
}

/** True when the plan proposes anything to confirm or show (team changes or tasks). */
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

/**
 * Who a plan task is for: a library agent the plan adds, a specialist the
 * plan creates (matched by name, ignoring case and surrounding spaces), or an
 * agent that is already available (team member, Primary, or an id the BE
 * resolves).
 */
export type TaskSource = { kind: 'add'; agentId: string } | { kind: 'create'; index: number } | { kind: 'agent'; agentId: string }

export function taskSource(plan: TeamPlan, task: TeamPlanTask, availableIds: readonly string[] = []): TaskSource {
  if (availableIds.includes(task.agent)) return { kind: 'agent', agentId: task.agent }
  if (plan.add.some((a) => a.agentId === task.agent)) return { kind: 'add', agentId: task.agent }
  const name = task.agent.trim().toLowerCase()
  const index = plan.create.findIndex((c) => c.name.trim().toLowerCase() === name)
  if (index >= 0) return { kind: 'create', index }
  return { kind: 'agent', agentId: task.agent }
}

/**
 * A task cannot run when its assignee depends on a team change the user
 * unticked (the BE drops such tasks on apply). `availableIds` are agents that
 * need no change: the current team and Primary.
 */
export function isTaskBlocked(plan: TeamPlan, selection: PlanSelection, index: number, availableIds: readonly string[] = []): boolean {
  const task = plan.tasks[index]
  if (!task) return true
  const source = taskSource(plan, task, availableIds)
  if (source.kind === 'add') return !selection.add.includes(source.agentId)
  if (source.kind === 'create') return !selection.create.includes(source.index)
  return false
}

/**
 * Body for POST /plans/:messageId/apply. Every list is explicit (an omitted
 * list would accept everything), in plan order, without duplicates or
 * out-of-range entries, and without tasks the selection blocks.
 */
export function applyBody(plan: TeamPlan, selection: PlanSelection, availableIds: readonly string[] = []): Required<TeamPlanApply> {
  const add = [...new Set(plan.add.map((a) => a.agentId))].filter((id) => selection.add.includes(id))
  const create = plan.create.map((_, i) => i).filter((i) => selection.create.includes(i))
  const tasks = plan.tasks
    .map((_, i) => i)
    .filter((i) => selection.tasks.includes(i) && !isTaskBlocked(plan, selection, i, availableIds))
  return { add, create, tasks }
}

/** How many entries an apply body accepts (Apply is disabled at zero). */
export function selectedCount(body: Required<TeamPlanApply>): number {
  return body.add.length + body.create.length + body.tasks.length
}
