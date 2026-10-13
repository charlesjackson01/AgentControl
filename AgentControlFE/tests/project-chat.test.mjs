import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  PLAN_STATUS_LABELS,
  POLL_MAX_MS,
  POLL_MS,
  TASK_STATUS_LABELS,
  addCandidates,
  applyBody,
  describeProgress,
  failedResultIds,
  initialSelection,
  isTaskBlocked,
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
} from '../src/lib/project-chat.ts'

const msg = (id, createdAt, overrides = {}) => ({ id, projectId: 'p1', author: 'user', text: id, kind: 'message', createdAt, ...overrides })
const T = (n) => `2026-10-12T10:00:0${n}.000Z`

describe('thread order and freshness', () => {
  it('reads oldest first; within one timestamp a plan precedes its team update and tasks', () => {
    const list = [
      msg('task-b', T(2), { kind: 'task-assignment' }),
      msg('update', T(2), { kind: 'team-update' }),
      msg('result', T(3), { kind: 'task-result' }),
      msg('prompt', T(0)),
      msg('task-a', T(2), { kind: 'task-assignment' }),
      msg('plan', T(2), { kind: 'team-plan' }),
    ]
    assert.deepEqual(sortMessages(list).map((m) => m.id), ['prompt', 'plan', 'update', 'task-b', 'task-a', 'result'])
    // The input is not mutated.
    assert.equal(list[0].id, 'task-b')
  })

  it('adds new messages and replaces held ones only with a copy at least as new', () => {
    const queued = msg('t1', T(1), { kind: 'task-assignment', taskStatus: 'queued' })
    const running = { ...queued, taskStatus: 'running', updatedAt: T(4) }
    const done = { ...queued, taskStatus: 'done', updatedAt: T(6) }
    const prompt = msg('m0', T(0))

    const merged = mergeMessages([prompt, running], [queued, msg('m2', T(5))])
    assert.deepEqual(merged.map((m) => [m.id, m.taskStatus]), [['m0', undefined], ['t1', 'running'], ['m2', undefined]])
    assert.equal(mergeMessages(merged, [done])[1].taskStatus, 'done')
    // Same id twice never duplicates.
    assert.equal(mergeMessages([prompt], [prompt, prompt]).length, 1)
  })

  it('keeps the newer project copy', () => {
    const old = { id: 'p1', name: 'A', updatedAt: T(1), teamAgentIds: [] }
    const fresh = { ...old, updatedAt: T(2), teamAgentIds: ['a1'] }
    assert.equal(newerProject(undefined, old), old)
    assert.equal(newerProject(fresh, old), fresh)
    assert.equal(newerProject(old, fresh), fresh)
    assert.equal(newerProject({ ...fresh, id: 'other' }, old), old)
  })
})

describe('prompts, polling and progress', () => {
  it('finds the newest user prompt only while no plan answers it', () => {
    const prompt1 = msg('m1', T(0))
    const prompt2 = msg('m2', T(2))
    const agentMsg = msg('a', T(3), { author: 'agent-1' })
    assert.equal(latestUnansweredPrompt([]), null)
    assert.equal(latestUnansweredPrompt([prompt1, prompt2, agentMsg]), prompt2)
    assert.equal(latestUnansweredPrompt([prompt1, prompt2, msg('p', T(4), { kind: 'team-plan', replyTo: 'm2' })]), null)
    // An answered older prompt does not hide the newer unanswered one.
    assert.equal(latestUnansweredPrompt([prompt1, msg('p', T(1), { kind: 'team-plan', replyTo: 'm1' }), prompt2]), prompt2)
  })

  it('polls while a plan is in flight or a task is queued or running', () => {
    const task = (taskStatus) => msg(`t-${taskStatus}`, T(1), { kind: 'task-assignment', taskStatus })
    assert.equal(needsPolling([], false), false)
    assert.equal(needsPolling([], true), true)
    assert.equal(needsPolling([task('done'), task('failed'), msg('m', T(0))], false), false)
    assert.equal(needsPolling([task('done'), task('queued')], false), true)
    assert.equal(needsPolling([task('running')], false), true)
    // A plain message that merely carries a status field is not a task.
    assert.equal(needsPolling([msg('m', T(0), { taskStatus: 'queued' })], false), false)
  })

  it('marks only the latest result of a task that is failed now', () => {
    const list = [
      msg('t1', T(1), { kind: 'task-assignment', taskStatus: 'failed' }),
      msg('t2', T(1), { kind: 'task-assignment', taskStatus: 'done' }),
      msg('r1-old', T(2), { kind: 'task-result', taskId: 't1' }),
      msg('r2', T(3), { kind: 'task-result', taskId: 't2' }),
      msg('r1-new', T(4), { kind: 'task-result', taskId: 't1' }),
      msg('orphan', T(5), { kind: 'task-result' }),
    ]
    assert.deepEqual([...failedResultIds(list)], ['r1-new'])
    // After a retry the task is queued again: no result reads as a failure.
    assert.deepEqual([...failedResultIds(list.map((m) => (m.id === 't1' ? { ...m, taskStatus: 'queued' } : m)))], [])
  })

  it('trusts the outcome a result records, over the task status now', () => {
    const list = [
      msg('t1', T(1), { kind: 'task-assignment', taskStatus: 'done' }),
      msg('r1-failed', T(2), { kind: 'task-result', taskId: 't1', taskStatus: 'failed' }),
      msg('r1-done', T(3), { kind: 'task-result', taskId: 't1', taskStatus: 'done' }),
    ]
    // The retried task is done now, yet its first attempt still reads as a failure.
    assert.deepEqual([...failedResultIds(list)], ['r1-failed'])
  })

  it('backs off on failures within the bound', () => {
    assert.equal(pollDelay(0), POLL_MS)
    assert.equal(pollDelay(-3), POLL_MS)
    assert.equal(pollDelay(1), POLL_MS * 2)
    assert.equal(pollDelay(3), POLL_MS * 8)
    assert.equal(pollDelay(50), POLL_MAX_MS)
  })

  it('summarizes a plan’s task statuses', () => {
    const tasks = [
      msg('t1', T(1), { kind: 'task-assignment', planId: 'plan', taskStatus: 'done' }),
      msg('t2', T(1), { kind: 'task-assignment', planId: 'plan', taskStatus: 'running' }),
      msg('t3', T(1), { kind: 'task-assignment', planId: 'plan', taskStatus: 'queued' }),
      msg('t4', T(1), { kind: 'task-assignment', planId: 'other', taskStatus: 'failed' }),
      msg('r1', T(2), { kind: 'task-result', planId: 'plan' }),
    ]
    const progress = planProgress(tasks, 'plan')
    assert.deepEqual(progress, { queued: 1, running: 1, done: 1, failed: 0, total: 3 })
    assert.equal(describeProgress(progress), '3 tasks · 1 running · 1 queued · 1 done')
    assert.equal(describeProgress(planProgress(tasks, 'other')), '1 task · 1 failed')
    assert.equal(describeProgress(planProgress(tasks, 'none')), '')
  })

  it('labels every task and plan status', () => {
    assert.deepEqual(Object.keys(TASK_STATUS_LABELS), ['queued', 'running', 'done', 'failed'])
    assert.deepEqual(Object.keys(PLAN_STATUS_LABELS), ['pending', 'applied', 'cancelled'])
    for (const label of [...Object.values(TASK_STATUS_LABELS), ...Object.values(PLAN_STATUS_LABELS)]) assert.ok(label)
  })
})

describe('team strip', () => {
  const agents = [
    { id: 'lead', name: 'Lead', isPrimary: true },
    { id: 'a1', name: 'Writer', isPrimary: false },
    { id: 'a2', name: 'Tester', isPrimary: false, projectId: 'p1' },
  ]
  it('shows Primary on its own and members once', () => {
    assert.deepEqual(memberIds(['a1', 'lead', 'a1', 'gone'], 'lead'), ['a1', 'gone'])
    assert.deepEqual(memberIds(['a1'], undefined), ['a1'])
  })
  it('offers library agents not on the team, never Primary', () => {
    assert.deepEqual(addCandidates(agents, ['a1']).map((a) => a.id), ['a2'])
    assert.deepEqual(addCandidates(agents, []).map((a) => a.id), ['a1', 'a2'])
    assert.deepEqual(addCandidates(agents, ['a1', 'a2']), [])
  })
})

describe('plan selection and the apply body (D-P1)', () => {
  const plan = {
    reply: 'Here is the plan.',
    add: [
      { agentId: 'lib-1', reason: 'Writes docs' },
      { agentId: 'lib-2', reason: 'Reviews' },
    ],
    create: [
      { name: 'API Designer', role: 'Designer', instructions: 'Design.', skillIds: [], reason: 'Missing' },
      { name: 'Tester', role: 'QA', instructions: 'Test.', skillIds: ['s1'], reason: 'Missing' },
    ],
    tasks: [
      { agent: 'lib-1', task: 'Write the README' },
      { agent: ' api designer ', task: 'Draft the API' },
      { agent: 'Tester', task: 'Write tests' },
      { agent: 'member-1', task: 'Keep going' },
      { agent: 'lead', task: 'Coordinate' },
    ],
    warnings: [],
  }
  const available = ['member-1', 'lead']

  it('knows whether a plan has anything to show', () => {
    assert.equal(planHasItems(plan), true)
    assert.equal(planHasItems({ ...plan, add: [], create: [], tasks: [] }), false)
    assert.equal(planHasItems({ ...plan, add: [], create: [], tasks: [plan.tasks[3]] }), true)
  })

  it('starts with everything accepted and sends explicit lists', () => {
    const selection = initialSelection(plan)
    assert.deepEqual(selection, { add: ['lib-1', 'lib-2'], create: [0, 1], tasks: [0, 1, 2, 3, 4] })
    const body = applyBody(plan, selection, available)
    assert.deepEqual(body, { add: ['lib-1', 'lib-2'], create: [0, 1], tasks: [0, 1, 2, 3, 4] })
    assert.equal(selectedCount(body), 9)
  })

  it('resolves task assignees: available agents, added agents, created specialists by name', () => {
    assert.deepEqual(taskSource(plan, plan.tasks[0], available), { kind: 'add', agentId: 'lib-1' })
    assert.deepEqual(taskSource(plan, plan.tasks[1], available), { kind: 'create', index: 0 })
    assert.deepEqual(taskSource(plan, plan.tasks[2], available), { kind: 'create', index: 1 })
    assert.deepEqual(taskSource(plan, plan.tasks[3], available), { kind: 'agent', agentId: 'member-1' })
    assert.deepEqual(taskSource(plan, plan.tasks[4], available), { kind: 'agent', agentId: 'lead' })
    // Already on the team: no team change needed even if the plan also adds it.
    assert.deepEqual(taskSource(plan, plan.tasks[0], ['lib-1']), { kind: 'agent', agentId: 'lib-1' })
  })

  it('drops tasks whose agent the user did not accept, in plan order without duplicates', () => {
    let selection = initialSelection(plan)
    selection = toggleCreate(selection, 1) // no Tester
    selection = toggleAdd(selection, 'lib-1') // no lib-1
    selection = toggleTask(selection, 1) // untick Draft the API
    selection = toggleTask(selection, 1) // ...and tick it again (now last in the list)
    assert.equal(isTaskBlocked(plan, selection, 0, available), true)
    assert.equal(isTaskBlocked(plan, selection, 1, available), false)
    assert.equal(isTaskBlocked(plan, selection, 2, available), true)
    assert.equal(isTaskBlocked(plan, selection, 3, available), false)
    assert.equal(isTaskBlocked(plan, selection, 99, available), true)
    assert.deepEqual(applyBody(plan, selection, available), { add: ['lib-2'], create: [0], tasks: [1, 3, 4] })
  })

  it('ignores out-of-range or duplicate selections and counts nothing when all is unticked', () => {
    const body = applyBody(plan, { add: ['lib-2', 'ghost', 'lib-2'], create: [5, 1, 1], tasks: [7, 2] }, available)
    assert.deepEqual(body, { add: ['lib-2'], create: [1], tasks: [2] })
    const none = applyBody(plan, { add: [], create: [], tasks: [] }, available)
    assert.deepEqual(none, { add: [], create: [], tasks: [] })
    assert.equal(selectedCount(none), 0)
  })

  it('toggles without mutating the previous selection', () => {
    const selection = initialSelection(plan)
    const next = toggleTask(selection, 0)
    assert.deepEqual(selection.tasks, [0, 1, 2, 3, 4])
    assert.deepEqual(next.tasks, [1, 2, 3, 4])
    assert.equal(next.add, selection.add)
  })
})
