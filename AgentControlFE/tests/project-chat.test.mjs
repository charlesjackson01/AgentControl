import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  POLL_MAX_MS,
  POLL_MS,
  TASK_STATUS_LABELS,
  addBlock,
  addCandidates,
  activeWorkRound,
  applyBody,
  createBlock,
  descendants,
  describeProgress,
  formatUsedMeta,
  initialSelection,
  isFailedResult,
  isTaskBlocked,
  isTaskResult,
  latestPrompt,
  latestRound,
  latestUnansweredPrompt,
  memberIds,
  mentionCandidates,
  mentionParts,
  mentionQuery,
  mergeMessages,
  isReadyTask,
  needsPolling,
  newerProject,
  nextTeam,
  parsePlanTaskRef,
  planAnchors,
  planAssigneeHosted,
  planCallBudget,
  planCallFooter,
  planHasItems,
  planTaskChip,
  planTaskChipLabel,
  planTaskLabel,
  pollDelay,
  resyncAfter,
  reviewDue,
  roundDividers,
  roundOf,
  selectedCount,
  sendLabel,
  STICK_PX,
  sortMessages,
  stickAfterScroll,
  taskBlock,
  taskProgress,
  taskSource,
  taskState,
  taskStateReason,
  toggleAdd,
  toggleCreate,
  toggleTask,
  workBarLabel,
} from '../src/lib/project-chat.ts'

// Contract (src/lib/types.ts): message kinds are 'message' | 'team-update' |
// 'task-assignment'. POST team-plan returns {plan, replyTo?} and writes
// nothing; POST team-plan/apply takes {plan, replyTo?, add?, create?, tasks?}
// and writes Primary's reply, the team update and the tasks (all with replyTo);
// a task's result is the assignee's 'message' with taskId and taskStatus.

const msg = (id, createdAt, overrides = {}) => ({ id, projectId: 'p1', author: 'user', text: id, kind: 'message', createdAt, ...overrides })
const T = (n) => `2026-10-12T10:00:0${n}.000Z`

describe('thread order and freshness', () => {
  it('reads oldest first; within one timestamp reply → team update → tasks → results', () => {
    const list = [
      msg('task-b', T(2), { kind: 'task-assignment' }),
      msg('result', T(2), { author: 'a1', taskId: 'task-a', taskStatus: 'done' }),
      msg('update', T(2), { kind: 'team-update', author: 'lead' }),
      msg('prompt', T(0)),
      msg('task-a', T(2), { kind: 'task-assignment' }),
      msg('reply', T(2), { author: 'lead', replyTo: 'prompt' }),
    ]
    assert.deepEqual(sortMessages(list).map((m) => m.id), ['prompt', 'reply', 'update', 'task-b', 'task-a', 'result'])
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

  it('tells task results (and failed attempts) from other agent messages', () => {
    assert.equal(isTaskResult(msg('r', T(1), { author: 'a1', taskId: 't1', taskStatus: 'done' })), true)
    assert.equal(isFailedResult(msg('r', T(1), { author: 'a1', taskId: 't1', taskStatus: 'failed' })), true)
    assert.equal(isFailedResult(msg('r', T(1), { author: 'a1', taskId: 't1', taskStatus: 'done' })), false)
    // Primary's applied reply and the task row itself are not results.
    assert.equal(isTaskResult(msg('reply', T(1), { author: 'lead', replyTo: 'm1' })), false)
    assert.equal(isFailedResult(msg('t1', T(1), { kind: 'task-assignment', taskId: 'x', taskStatus: 'failed' })), false)
  })
})

describe('prompts and where pending plans show', () => {
  it('finds the newest user prompt, and it is unanswered until an apply writes a reply to it', () => {
    const prompt1 = msg('m1', T(0))
    const prompt2 = msg('m2', T(2))
    const agentMsg = msg('a', T(3), { author: 'agent-1' })
    assert.equal(latestPrompt([]), null)
    assert.equal(latestPrompt([prompt1, prompt2, agentMsg]), prompt2)
    assert.equal(latestUnansweredPrompt([]), null)
    assert.equal(latestUnansweredPrompt([prompt1, prompt2, agentMsg]), prompt2)
    // Anything an apply wrote for the prompt answers it: Primary's reply, the team update, a task.
    for (const kind of ['message', 'team-update', 'task-assignment']) {
      assert.equal(latestUnansweredPrompt([prompt1, prompt2, msg('x', T(4), { kind, author: 'lead', replyTo: 'm2' })]), null)
    }
    // An answered older prompt does not hide the newer unanswered one.
    assert.equal(latestUnansweredPrompt([prompt1, msg('r', T(1), { author: 'lead', replyTo: 'm1' }), prompt2]), prompt2)
  })

  it('anchors a plan after the last message that belongs to its prompt', () => {
    const thread = [
      msg('m1', T(0)),
      msg('reply1', T(1), { author: 'lead', replyTo: 'm1' }),
      msg('task1', T(2), { kind: 'task-assignment', author: 'lead', assigneeId: 'a1', replyTo: 'm1' }),
      msg('m2', T(3)),
      msg('result1', T(4), { author: 'a1', taskId: 'task1', taskStatus: 'done' }),
      msg('m3', T(5)),
    ]
    // Unanswered prompts anchor on themselves; an answered one after its last result.
    assert.deepEqual([...planAnchors(thread, ['m2', 'm3'])], [['m2', ['m2']], ['m3', ['m3']]])
    assert.deepEqual([...planAnchors(thread, ['m1'])], [['result1', ['m1']]])
    // A prompt not in the thread anchors nothing; a reply before its prompt does not count.
    assert.deepEqual([...planAnchors(thread, ['gone'])], [])
    const odd = [msg('early', T(0), { author: 'lead', replyTo: 'm9' }), msg('m9', T(1))]
    assert.deepEqual([...planAnchors(odd, ['m9'])], [['m9', ['m9']]])
  })
})

describe('polling, progress and resync', () => {
  const task = (taskStatus) => msg(`t-${taskStatus}`, T(1), { kind: 'task-assignment', taskStatus })

  it('polls while a ready task is queued or a task is running', () => {
    assert.equal(needsPolling([], false), false)
    assert.equal(needsPolling([task('done'), task('failed'), msg('m', T(0))], false), false)
    assert.equal(needsPolling([task('done'), task('queued')], false), true)
    assert.equal(needsPolling([task('running')], false), true)
    // A plain message that merely carries a status field is not a task.
    assert.equal(needsPolling([msg('m', T(0), { taskStatus: 'queued' })], false), false)
  })

  it('does not poll queued tasks while the project is paused, but still polls a running one', () => {
    assert.equal(needsPolling([task('queued')], false, true), false)
    assert.equal(needsPolling([task('running'), task('queued')], false, true), true)
    assert.equal(needsPolling([task('queued')], true, true), true)
  })

  it('does not poll forever when only held or waiting tasks remain', () => {
    const t1 = msg('t1', T(1), { kind: 'task-assignment', taskStatus: 'failed', label: 't1' })
    const t2 = msg('t2', T(2), { kind: 'task-assignment', taskStatus: 'queued', label: 't2', inputs: ['t1'] })
    const t3 = msg('t3', T(3), { kind: 'task-assignment', taskStatus: 'queued', label: 't3', inputs: ['missing'] })
    assert.equal(needsPolling([t1, t2], false), false)
    assert.equal(needsPolling([t3], false), false)
    assert.equal(taskState(t2, [t1, t2]).kind, 'onHold')
    assert.equal(taskState(t3, [t3]).kind, 'waiting')
    assert.equal(isReadyTask(t2, [t1, t2]), false)
  })

  it('taskState: ready when inputs are done; waiting/onHold/paused otherwise', () => {
    const t1 = msg('t1', T(1), { kind: 'task-assignment', taskStatus: 'done', label: 't1' })
    const t2 = msg('t2', T(2), { kind: 'task-assignment', taskStatus: 'queued', label: 't2', inputs: ['t1'] })
    const tWait = msg('tw', T(3), { kind: 'task-assignment', taskStatus: 'queued', label: 't3', inputs: ['t1'] })
    const t1q = msg('t1q', T(1), { kind: 'task-assignment', taskStatus: 'queued', label: 't1' })
    assert.equal(taskState(t2, [t1, t2]).kind, 'ready')
    assert.equal(taskState(tWait, [t1q, tWait]).kind, 'waiting')
    assert.match(taskState(tWait, [t1q, tWait]).reason ?? '', /Waiting for t1/)
    assert.equal(taskStateReason(taskState(tWait, [t1q, tWait])), 'Waiting for t1')
    assert.equal(taskState(t2, [t1, t2], true).kind, 'paused')
    assert.equal(taskStateReason(taskState(t2, [t1, t2], true)), 'Paused')
    const hold = taskState(
      msg('th', T(2), { kind: 'task-assignment', taskStatus: 'queued', label: 't2', inputs: ['msg_t1'] }),
      [msg('msg_t1', T(1), { kind: 'task-assignment', taskStatus: 'failed', label: 't1' })],
    )
    assert.equal(hold.kind, 'onHold')
    assert.match(taskStateReason(hold) ?? '', /On hold: needs t1/)
    assert.equal(taskStateReason(taskState(msg('tr', T(0), { kind: 'task-assignment', taskStatus: 'running' }), [])), undefined)
    assert.equal(taskState(msg('tr', T(0), { kind: 'task-assignment', taskStatus: 'running' }), []).kind, 'running')
  })

  it('lists transitive dependents for cancel confirm', () => {
    const t1 = msg('t1', T(1), { kind: 'task-assignment', taskStatus: 'queued' })
    const t2 = msg('t2', T(2), { kind: 'task-assignment', taskStatus: 'queued', inputs: ['t1'] })
    const t3 = msg('t3', T(3), { kind: 'task-assignment', taskStatus: 'queued', inputs: ['t2'] })
    const other = msg('tx', T(4), { kind: 'task-assignment', taskStatus: 'queued', inputs: ['gone'] })
    assert.deepEqual(
      descendants('t1', [t1, t2, t3, other]).map((m) => m.id),
      ['t2', 't3'],
    )
    assert.deepEqual(descendants('t3', [t1, t2, t3]), [])
  })

  it('labels the work bar for active and paused projects', () => {
    const progress = { queued: 1, running: 1, done: 0, failed: 0, cancelled: 0, total: 2 }
    assert.equal(workBarLabel(progress, false), '1 running · 1 queued')
    assert.equal(workBarLabel(progress, true), 'Paused · 2 tasks waiting')
    assert.equal(workBarLabel({ queued: 0, running: 0, done: 1, failed: 0, cancelled: 0, total: 1 }, true), 'Paused')
  })

  it('keeps polling while a refresh is failing, even when idle (no "Updates paused" forever)', () => {
    assert.equal(needsPolling([], true), true)
    assert.equal(needsPolling([task('done')], true), true)
  })

  it('backs off on failures within the bound', () => {
    assert.equal(pollDelay(0), POLL_MS)
    assert.equal(pollDelay(-3), POLL_MS)
    assert.equal(pollDelay(1), POLL_MS * 2)
    assert.equal(pollDelay(3), POLL_MS * 8)
    assert.equal(pollDelay(50), POLL_MAX_MS)
  })

  it('refetches after a 404 (project deleted: "Project not found") or a 409, not after other errors', () => {
    assert.equal(resyncAfter(404), true)
    assert.equal(resyncAfter(409), true)
    for (const status of [400, 413, 500, 502, undefined]) assert.equal(resyncAfter(status), false)
  })

  it('follows new messages until the reader scrolls up, not when a smooth scroll passes through', () => {
    const at = (scrollTop) => ({ scrollTop, scrollHeight: 2000, clientHeight: 500 })
    // Near the bottom: stick, whatever came before.
    assert.equal(stickAfterScroll(false, at(1500 - STICK_PX + 1), 0), true)
    // A smooth scroll on its way down (scrollTop rising, still far away) keeps the current state.
    assert.equal(stickAfterScroll(true, at(400), 100), true)
    assert.equal(stickAfterScroll(false, at(400), 100), false)
    // The reader scrolls up, away from the bottom: let go.
    assert.equal(stickAfterScroll(true, at(900), 1500), false)
  })

  it('summarizes task statuses across the project', () => {
    const tasks = [
      msg('t1', T(1), { kind: 'task-assignment', taskStatus: 'done' }),
      msg('t2', T(1), { kind: 'task-assignment', taskStatus: 'running' }),
      msg('t3', T(1), { kind: 'task-assignment', taskStatus: 'queued' }),
      msg('r1', T(2), { author: 'a1', taskId: 't1', taskStatus: 'done' }),
    ]
    const progress = taskProgress(tasks)
    assert.deepEqual(progress, { queued: 1, running: 1, done: 1, failed: 0, cancelled: 0, total: 3 })
    assert.equal(describeProgress(progress), '3 tasks · 1 running · 1 queued · 1 done')
    assert.equal(describeProgress(taskProgress([task('failed')])), '1 task · 1 failed')
    assert.equal(describeProgress(taskProgress([])), '')
  })

  it('labels every task status', () => {
    assert.deepEqual(Object.keys(TASK_STATUS_LABELS), ['queued', 'running', 'done', 'failed', 'cancelled'])
    for (const label of Object.values(TASK_STATUS_LABELS)) assert.ok(label)
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
  it('builds a team edit on the server’s current team and library', () => {
    const library = ['a1', 'a2', 'a3', 'fresh']
    // An agent created and added elsewhere ("fresh") survives an edit made from a stale page.
    assert.deepEqual(nextTeam(['a1', 'fresh'], { remove: 'a1' }, library), ['fresh'])
    assert.deepEqual(nextTeam(['a1', 'fresh'], { add: ['a3', 'a1'] }, library), ['a1', 'fresh', 'a3'])
    // Ids of agents deleted since are dropped (PATCH rejects unknown ids).
    assert.deepEqual(nextTeam(['a1', 'deleted'], { add: ['ghost'] }, library), ['a1'])
    assert.deepEqual(nextTeam([], {}, []), [])
  })
})

describe('plan confirm card and the apply body (D-P1)', () => {
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
  const ctx = {
    teamAgentIds: ['member-1'],
    primaryId: 'lead',
    agents: [
      { id: 'lead', name: 'Atlas' },
      { id: 'member-1', name: 'Member' },
      { id: 'lib-1', name: 'Docs Writer' },
      { id: 'lib-2', name: 'Reviewer' },
    ],
  }

  it('knows whether a plan has anything to confirm', () => {
    assert.equal(planHasItems(plan), true)
    assert.equal(planHasItems({ ...plan, add: [], create: [], tasks: [] }), false)
    assert.equal(planHasItems({ ...plan, add: [], create: [], tasks: [plan.tasks[3]] }), true)
  })

  it('starts with everything accepted and sends the plan, the prompt and explicit lists', () => {
    const selection = initialSelection(plan)
    assert.deepEqual(selection, { add: ['lib-1', 'lib-2'], create: [0, 1], tasks: [0, 1, 2, 3, 4] })
    const body = applyBody(plan, selection, ctx, 'm1')
    assert.equal(body.plan, plan)
    assert.equal(body.replyTo, 'm1')
    assert.deepEqual([body.add, body.create, body.tasks], [['lib-1', 'lib-2'], [0, 1], [0, 1, 2, 3, 4]])
    assert.equal(selectedCount(body), 9)
    // Without a prompt the body has no replyTo at all.
    assert.equal('replyTo' in applyBody(plan, selection, ctx), false)
  })

  it('resolves task assignees: available agents, added agents, created specialists by name', () => {
    assert.deepEqual(taskSource(plan, plan.tasks[0], ctx), { kind: 'add', agentId: 'lib-1' })
    assert.deepEqual(taskSource(plan, plan.tasks[1], ctx), { kind: 'create', index: 0 })
    assert.deepEqual(taskSource(plan, plan.tasks[2], ctx), { kind: 'create', index: 1 })
    assert.deepEqual(taskSource(plan, plan.tasks[3], ctx), { kind: 'agent', agentId: 'member-1' })
    assert.deepEqual(taskSource(plan, plan.tasks[4], ctx), { kind: 'agent', agentId: 'lead' })
    assert.deepEqual(taskSource(plan, { agent: 'agt_ghost', task: 'x' }, ctx), { kind: 'unknown' })
    // Already on the team: no team change needed even if the plan also adds it.
    assert.deepEqual(taskSource(plan, plan.tasks[0], { ...ctx, teamAgentIds: ['lib-1'] }), { kind: 'agent', agentId: 'lib-1' })
  })

  it('resolves a task by name the way the BE does, before a planned specialist of that name', () => {
    // The plan creates "QA Tester", but an agent of that name joined the team meanwhile:
    // the BE gives the task to the member, so the card must not block it.
    const named = {
      reply: '', add: [], warnings: [],
      create: [{ name: 'QA Tester', role: 'QA', instructions: 'Test.', skillIds: [], reason: '' }],
      tasks: [{ agent: 'qa tester', task: 'Test it' }],
    }
    const now = { ...ctx, teamAgentIds: ['member-1', 'qa-1'], agents: [...ctx.agents, { id: 'qa-1', name: 'QA Tester' }] }
    assert.deepEqual(taskSource(named, named.tasks[0], now), { kind: 'agent', agentId: 'qa-1' })
    assert.equal(createBlock(named.create[0], now), 'An agent named "QA Tester" exists now.')
    assert.equal(taskBlock(named, initialSelection(named), 0, now), null)
    // Library agents the plan adds are found by name too.
    const byName = { ...plan, tasks: [{ agent: 'docs writer', task: 'Write docs' }] }
    assert.deepEqual(taskSource(byName, byName.tasks[0], ctx), { kind: 'add', agentId: 'lib-1' })
  })

  it('drops tasks whose agent the user did not accept, in plan order without duplicates', () => {
    let selection = initialSelection(plan)
    selection = toggleCreate(selection, 1) // no Tester
    selection = toggleAdd(selection, 'lib-1') // no lib-1
    selection = toggleTask(selection, 1) // untick Draft the API
    selection = toggleTask(selection, 1) // ...and tick it again (now last in the list)
    assert.equal(isTaskBlocked(plan, selection, 0, ctx), true)
    assert.equal(isTaskBlocked(plan, selection, 1, ctx), false)
    assert.equal(isTaskBlocked(plan, selection, 2, ctx), true)
    assert.equal(isTaskBlocked(plan, selection, 3, ctx), false)
    assert.equal(isTaskBlocked(plan, selection, 99, ctx), true)
    assert.equal(taskBlock(plan, selection, 0, ctx), 'Skipped: its agent is not joining the team.')
    const body = applyBody(plan, selection, ctx, 'm1')
    assert.deepEqual([body.add, body.create, body.tasks], [['lib-2'], [0], [1, 3, 4]])
    assert.equal(selectedCount(body), 5)
  })

  it('blocks rows the BE would drop or refuse, and leaves them out of the body and the count', () => {
    // Since the plan arrived: lib-1 was deleted, lib-2 joined the team by hand,
    // member-1 left the team, and someone created an agent named "tester".
    const stale = {
      teamAgentIds: ['lib-2'],
      primaryId: 'lead',
      agents: [
        { id: 'lead', name: 'Atlas' },
        { id: 'member-1', name: 'Member' },
        { id: 'lib-2', name: 'Reviewer' },
        { id: 'x', name: ' tester ' },
      ],
    }
    assert.equal(addBlock(plan.add[0], stale), 'No longer in the library.')
    assert.equal(addBlock(plan.add[1], stale), 'Already on the team.')
    assert.equal(addBlock({ agentId: 'lead', reason: '' }, stale), 'Already leads the team.')
    assert.equal(createBlock(plan.create[0], stale), null)
    assert.equal(createBlock(plan.create[1], stale), 'An agent named "Tester" exists now.')

    const selection = initialSelection(plan)
    assert.equal(taskBlock(plan, selection, 0, stale), 'Skipped: its agent is no longer in the library.')
    assert.equal(taskBlock(plan, selection, 2, stale), 'Skipped: its new specialist cannot be created.')
    // member-1 left the team: no longer an assignee the BE accepts.
    assert.equal(taskBlock(plan, selection, 3, stale), 'Skipped: its agent is not on the team or in this plan.')
    assert.equal(taskBlock(plan, selection, 4, stale), null)

    const body = applyBody(plan, selection, stale, 'm1')
    assert.deepEqual([body.add, body.create, body.tasks], [[], [0], [1, 4]])
    assert.equal(selectedCount(body), 3)

    // A team member deleted from the library cannot take a task either.
    const removed = { ...ctx, agents: ctx.agents.filter((a) => a.id !== 'member-1') }
    assert.equal(taskBlock(plan, selection, 3, removed), 'Skipped: its agent is no longer in the library.')
  })

  it('ignores out-of-range or duplicate selections and counts nothing when all is unticked', () => {
    const body = applyBody(plan, { add: ['lib-2', 'ghost', 'lib-2'], create: [5, 1, 1], tasks: [7, 2] }, ctx)
    assert.deepEqual([body.add, body.create, body.tasks], [['lib-2'], [1], [2]])
    const none = applyBody(plan, { add: [], create: [], tasks: [] }, ctx)
    assert.deepEqual([none.add, none.create, none.tasks], [[], [], []])
    assert.equal(selectedCount(none), 0)
    // A plan that proposes the same agent twice sends it once.
    const twice = { ...plan, add: [plan.add[1], plan.add[1]] }
    assert.deepEqual(applyBody(twice, initialSelection(twice), ctx).add, ['lib-2'])
  })

  it('toggles without mutating the previous selection', () => {
    const selection = initialSelection(plan)
    const next = toggleTask(selection, 0)
    assert.deepEqual(selection.tasks, [0, 1, 2, 3, 4])
    assert.deepEqual(next.tasks, [1, 2, 3, 4])
    assert.equal(next.add, selection.add)
  })

  it('greys out dependents when a tN input is unticked (Skipped: needs t1)', () => {
    const handoff = {
      reply: 'Ana drafts; Copy Editor edits.',
      add: [],
      create: [{ name: 'Copy Editor', role: 'Editor', instructions: 'Edit.', skillIds: [], reason: '' }],
      tasks: [
        { agent: 'member-1', task: 'Draft the post' },
        { agent: 'Copy Editor', task: 'Edit the draft', inputs: ['t1'] },
        { agent: 'lead', task: 'Publish', inputs: ['T2'] },
      ],
      warnings: [],
    }
    let selection = initialSelection(handoff)
    assert.equal(taskBlock(handoff, selection, 1, ctx), null)
    assert.equal(taskBlock(handoff, selection, 2, ctx), null)
    selection = toggleTask(selection, 0) // untick t1
    assert.equal(taskBlock(handoff, selection, 1, ctx), 'Skipped: needs t1')
    // t3 needs t2; t2 is still selected but blocked by t1 → chain drops
    assert.equal(taskBlock(handoff, selection, 2, ctx), 'Skipped: needs t2')
    const body = applyBody(handoff, selection, ctx)
    assert.deepEqual(body.tasks, [])
    // Re-tick t1: dependents apply again
    selection = toggleTask(selection, 0)
    assert.equal(taskBlock(handoff, selection, 1, ctx), null)
    assert.deepEqual(applyBody(handoff, selection, ctx).tasks, [0, 1, 2])
  })
})

describe('orchestration Part 5 review rounds', () => {
  const assignment = (id, replyTo, overrides = {}) =>
    msg(id, T(1), { kind: 'task-assignment', replyTo, taskStatus: 'done', assigneeId: 'ana', ...overrides })

  it('roundOf treats absent round as 1', () => {
    assert.equal(roundOf(assignment('t1', 'p1')), 1)
    assert.equal(roundOf(assignment('t2', 'p1', { round: 2 })), 2)
    assert.equal(roundOf(assignment('t3', 'p1', { round: 0 })), 1)
  })

  it('reviewDue when the latest round is settled and the request is open', () => {
    const open = [
      msg('p1', T(0)),
      assignment('t1', 'p1', { taskStatus: 'done', round: 1 }),
      assignment('t2', 'p1', { taskStatus: 'done', round: 1, createdAt: T(2) }),
    ]
    assert.equal(reviewDue(open, 'p1', 'lead'), true)
    assert.equal(latestRound(open, 'p1'), 1)

    const running = [...open, assignment('t3', 'p1', { taskStatus: 'running', round: 2, createdAt: T(3) })]
    assert.equal(reviewDue(running, 'p1', 'lead'), false)
    assert.equal(latestRound(running, 'p1'), 2)

    const closed = [
      ...open,
      msg('reply', T(3), { author: 'lead', replyTo: 'p1', verdict: 'done' }),
    ]
    assert.equal(reviewDue(closed, 'p1', 'lead'), false)
  })

  it('applyBody sends round when reviewing', () => {
    const plan = { reply: 'Next.', add: [], create: [], tasks: [{ agent: 'ana', task: 'Edit' }], warnings: [], verdict: 'continue' }
    const ctx = { teamAgentIds: ['ana'], primaryId: 'lead', agents: [{ id: 'ana', name: 'Ana' }, { id: 'lead', name: 'Lead' }] }
    const body = applyBody(plan, initialSelection(plan), ctx, 'p1', 2)
    assert.equal(body.round, 2)
    assert.equal(body.replyTo, 'p1')
    assert.deepEqual(body.tasks, [0])
    // First plan: omit round.
    assert.equal(applyBody(plan, initialSelection(plan), ctx, 'p1').round, undefined)
  })

  it('roundDividers and workBarLabel show Round N', () => {
    const list = [
      msg('p1', T(0)),
      assignment('t1', 'p1', { round: 1 }),
      assignment('t2', 'p1', { round: 2, createdAt: T(2), taskStatus: 'queued' }),
      assignment('t3', 'p1', { round: 2, createdAt: T(3), taskStatus: 'queued' }),
    ]
    const divs = roundDividers(list)
    assert.equal(divs.get('t2'), 2)
    assert.equal(divs.has('t3'), false)
    assert.equal(activeWorkRound(list), 2)
    assert.equal(workBarLabel({ queued: 1, running: 1, done: 0, failed: 0, cancelled: 0, total: 2 }, false, 2), 'Round 2 · 1 running · 1 queued')
    assert.equal(workBarLabel({ queued: 0, running: 0, done: 0, failed: 0, cancelled: 0, total: 0 }, true, 1), 'Round 1 · Paused')
  })
})

describe('orchestration Part 4 hand-off UI helpers', () => {
  const ctx = {
    teamAgentIds: ['ana', 'hosted'],
    primaryId: 'lead',
    agents: [
      { id: 'lead', name: 'Atlas', endpointId: 'ep-local' },
      { id: 'ana', name: 'Ana', endpointId: 'ep-local' },
      { id: 'hosted', name: 'Remote Writer', endpointId: 'ep-or' },
    ],
    hostedEndpointIds: ['ep-or'],
  }
  const plan = {
    reply: '',
    add: [],
    create: [{ name: 'Copy Editor', role: 'Editor', instructions: 'Edit.', skillIds: [], reason: '' }],
    tasks: [
      { agent: 'ana', task: 'Draft the post' },
      { agent: 'Copy Editor', task: 'Edit the draft', inputs: ['t1'] },
      { agent: 'hosted', task: 'Polish remotely', inputs: ['t2'] },
    ],
    warnings: [],
  }

  it('parses tN refs and labels tasks t1…tn', () => {
    assert.equal(parsePlanTaskRef('t1'), 1)
    assert.equal(parsePlanTaskRef('T2'), 2)
    assert.equal(parsePlanTaskRef(3), 3)
    assert.equal(parsePlanTaskRef('r1'), undefined)
    assert.equal(planTaskLabel(0), 't1')
    assert.equal(planTaskLabel(4), 't5')
  })

  it('estimates model calls as tasks × 5 for the plan footer', () => {
    assert.equal(planCallBudget(0), 0)
    assert.equal(planCallBudget(3), 15)
    assert.equal(planCallBudget(1), 5)
    assert.equal(planCallFooter(3), '3 tasks · one at a time · up to 15 model calls')
    assert.equal(planCallFooter(1), '1 task · one at a time · up to 5 model calls')
  })

  it('builds hand-off chip labels with @tags and uses', () => {
    assert.equal(planTaskChipLabel(plan, 0, ctx), 't1 @Ana: Draft the post')
    assert.equal(planTaskChipLabel(plan, 1, ctx), 't2 @Copy Editor: Edit the draft · uses @Ana (t1)')
    const chip = planTaskChip(plan, 1, ctx)
    assert.equal(chip.label, 't2')
    assert.equal(chip.assignee, 'Copy Editor')
    assert.deepEqual(chip.uses, [{ label: 't1', name: 'Ana', agentId: 'ana' }])
    assert.equal(chip.hosted, false)
    // Create entries inherit Primary's endpoint; lead is local → not hosted
    assert.equal(planAssigneeHosted(plan, plan.tasks[1], ctx), false)
    // Library agent on OpenRouter
    assert.equal(planAssigneeHosted(plan, plan.tasks[2], ctx), true)
    assert.match(planTaskChipLabel(plan, 2, ctx), /uses @Copy Editor \(t2\)/)
  })

  it('formats Used meta from result used[] and task labels', () => {
    const assignments = [
      msg('msg_t1', T(1), {
        kind: 'task-assignment',
        taskStatus: 'done',
        label: 't1',
        assigneeId: 'ana',
      }),
    ]
    const lines = formatUsedMeta(
      [{ taskId: 'msg_t1', chars: 6200, sentChars: 1800 }],
      assignments,
      (id) => (id === 'ana' ? 'Ana' : undefined),
    )
    assert.deepEqual(lines, ["Used @Ana's t1 (cut to 1,800 of 6,200 characters)"])
    assert.deepEqual(formatUsedMeta(undefined, assignments, () => 'Ana'), [])
    assert.deepEqual(formatUsedMeta([], assignments, () => 'Ana'), [])
    // Missing assignment: fall back to a short id, no @Name
    assert.deepEqual(
      formatUsedMeta([{ taskId: 'msg_gone', chars: 10, sentChars: 10 }], [], () => undefined),
      ['Used msg_gone (cut to 10 of 10 characters)'],
    )
  })
})

describe('D-O11 mentions', () => {
  const agents = [
    { id: 'lead', name: 'Atlas', isPrimary: true },
    { id: 'a1', name: 'Ana', isPrimary: false },
    { id: 'a2', name: 'Copy Editor', isPrimary: false },
    { id: 'gone', name: 'Removed', isPrimary: false },
  ]
  const byId = new Map(agents.map((a) => [a.id, a]))
  const nameOf = (id) => byId.get(id)?.name

  it('finds the @ word the caret sits in', () => {
    assert.deepEqual(mentionQuery('ask @an', 7), { start: 4, query: 'an' })
    assert.deepEqual(mentionQuery('@', 1), { start: 0, query: '' })
    // the caret is past the word, or the gap has a space: no picker
    assert.equal(mentionQuery('ask @ana now', 12), null)
    assert.equal(mentionQuery('mail me at 5', 11), null)
  })

  it('offers Primary then the team, filtered by the query', () => {
    const pool = mentionCandidates(agents[0], ['a1', 'a2', 'gone'], agents, '')
    assert.deepEqual(pool.map((a) => a.id), ['lead', 'a1', 'a2', 'gone'])
    assert.deepEqual(mentionCandidates(agents[0], ['a1', 'a2'], agents, 'co').map((a) => a.id), ['a2'])
    assert.deepEqual(mentionCandidates(agents[0], ['a1'], agents, 'zz'), [])
    // no Primary: team only
    assert.deepEqual(mentionCandidates(undefined, ['a1'], agents, '').map((a) => a.id), ['a1'])
  })

  it('splits text into plain parts and @Name chips', () => {
    const parts = mentionParts('send it to @Ana then @Copy Editor please', ['a1', 'a2'], nameOf)
    assert.deepEqual(parts, [
      { kind: 'text', text: 'send it to ' },
      { kind: 'mention', id: 'a1', name: 'Ana' },
      { kind: 'text', text: ' then ' },
      { kind: 'mention', id: 'a2', name: 'Copy Editor' },
      { kind: 'text', text: ' please' },
    ])
  })

  it('matches names case-insensitively at word boundaries, longest first', () => {
    assert.deepEqual(mentionParts('@ANA finished', ['a1'], nameOf), [
      { kind: 'mention', id: 'a1', name: 'ANA' },
      { kind: 'text', text: ' finished' },
    ])
    // a name inside a longer word is not a mention
    assert.deepEqual(mentionParts('the banana split', ['a1'], nameOf), [{ kind: 'text', text: 'the banana split' }])
    // the longer name wins where both could match
    const two = mentionParts('@Ana Smith rocks', ['a1'], (id) => (id === 'a1' ? 'Ana Smith' : nameOf(id)))
    assert.deepEqual(two[0], { kind: 'mention', id: 'a1', name: 'Ana Smith' })
  })

  it('leaves text alone when there is nothing to chip', () => {
    assert.deepEqual(mentionParts('plain text', undefined, nameOf), [{ kind: 'text', text: 'plain text' }])
    // an unknown id (renamed agent) is ignored
    assert.deepEqual(mentionParts('hi @Ana', ['a1', 'ghost'], nameOf), [
      { kind: 'text', text: 'hi ' },
      { kind: 'mention', id: 'a1', name: 'Ana' },
    ])
  })

  it('labels the send button with who the tags address', () => {
    assert.equal(sendLabel([], 'lead', nameOf), 'Send')
    assert.equal(sendLabel(['lead'], 'lead', nameOf), 'Ask @Atlas')
    assert.equal(sendLabel(['a1'], 'lead', nameOf), 'Send to @Ana')
    assert.equal(sendLabel(['a1', 'a2'], 'lead', nameOf), 'Send to @Ana, @Copy Editor')
    // picked ids that no longer name an agent still label
    assert.equal(sendLabel(['gone2'], 'lead', nameOf), 'Send to @?')
    // no Primary set
    assert.equal(sendLabel(['lead'], undefined, nameOf), 'Send to @Atlas')
  })
})
