import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  POLL_MAX_MS,
  POLL_MS,
  TASK_STATUS_LABELS,
  addBlock,
  addCandidates,
  applyBody,
  createBlock,
  describeProgress,
  initialSelection,
  isDirectMessage,
  isFailedResult,
  isTaskBlocked,
  isTaskResult,
  latestPrompt,
  latestUnansweredPrompt,
  memberIds,
  mergeMessages,
  needsPolling,
  newerProject,
  nextTeam,
  planAnchors,
  planHasItems,
  pollDelay,
  resyncAfter,
  selectedCount,
  STICK_PX,
  sortMessages,
  stickAfterScroll,
  taskBlock,
  taskProgress,
  taskSource,
  toggleAdd,
  toggleCreate,
  toggleTask,
} from '../src/lib/project-chat.ts'

// Contract (src/lib/types.ts): message kinds are 'message' | 'team-update' |
// 'task-assignment' | 'progress'. POST team-plan returns {plan, replyTo?} and
// writes nothing; POST team-plan/apply takes {plan, replyTo?, add?, create?,
// tasks?} and writes Primary's reply, the team update and the tasks (all with
// replyTo); a task's result is the assignee's 'message' with taskId and
// taskStatus. Task statuses: queued, running, done, failed, cancelled. A user
// message whose `mentions` tag team members and not Primary goes to them as
// tasks (D-O11), not to Primary's plan.

const msg = (id, createdAt, overrides = {}) => ({ id, projectId: 'p1', author: 'user', text: id, kind: 'message', createdAt, ...overrides })
const T = (n) => `2026-10-12T10:00:0${n}.000Z`

describe('thread order and freshness', () => {
  it('reads oldest first; within one timestamp reply → team update → tasks → results → progress', () => {
    const list = [
      msg('task-b', T(2), { kind: 'task-assignment' }),
      msg('progress', T(2), { kind: 'progress', author: 'lead' }),
      msg('result', T(2), { author: 'a1', taskId: 'task-a', taskStatus: 'done' }),
      msg('update', T(2), { kind: 'team-update', author: 'lead' }),
      msg('prompt', T(0)),
      msg('task-a', T(2), { kind: 'task-assignment' }),
      msg('reply', T(2), { author: 'lead', replyTo: 'prompt' }),
    ]
    assert.deepEqual(sortMessages(list).map((m) => m.id), ['prompt', 'reply', 'update', 'task-b', 'task-a', 'result', 'progress'])
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

  it('does not count a message sent straight to tagged team members as a prompt for Primary (D-O11)', () => {
    const prompt = msg('m1', T(0))
    const direct = msg('m2', T(1), { mentions: ['ana', 'ben'] })
    const askLead = msg('m3', T(2), { mentions: ['ana', 'lead'] })
    assert.equal(isDirectMessage(direct, 'lead'), true)
    assert.equal(isDirectMessage(askLead, 'lead'), false)
    assert.equal(isDirectMessage(prompt, 'lead'), false)
    assert.equal(isDirectMessage(msg('m4', T(0), { mentions: [] }), 'lead'), false)
    // Only user messages: an agent's tags are hand-off requests, not direct messages.
    assert.equal(isDirectMessage(msg('r', T(1), { author: 'ana', mentions: ['ben'] }), 'lead'), false)
    // With no Team Lead every tag is a member.
    assert.equal(isDirectMessage(direct, undefined), true)

    assert.equal(latestPrompt([prompt, direct], 'lead'), prompt)
    assert.equal(latestUnansweredPrompt([prompt, direct], 'lead'), prompt)
    assert.equal(latestPrompt([direct], 'lead'), null)
    assert.equal(latestUnansweredPrompt([direct], 'lead'), null)
    // Tagging Primary (alone or with members) is a prompt as before.
    assert.equal(latestUnansweredPrompt([prompt, direct, askLead], 'lead'), askLead)
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

  it('polls while a task is queued or running', () => {
    assert.equal(needsPolling([], false), false)
    assert.equal(needsPolling([task('done'), task('failed'), msg('m', T(0))], false), false)
    assert.equal(needsPolling([task('done'), task('queued')], false), true)
    assert.equal(needsPolling([task('running')], false), true)
    // A plain message that merely carries a status field is not a task.
    assert.equal(needsPolling([msg('m', T(0), { taskStatus: 'queued' })], false), false)
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
    assert.equal(describeProgress(taskProgress([task('failed'), task('cancelled')])), '2 tasks · 1 failed · 1 cancelled')
    assert.equal(describeProgress(taskProgress([])), '')
  })

  it('does not poll for cancelled tasks', () => {
    assert.equal(needsPolling([task('cancelled'), task('done')], false), false)
  })

  it('labels every task status', () => {
    assert.deepEqual(Object.keys(TASK_STATUS_LABELS), ['queued', 'running', 'done', 'failed', 'cancelled'])
    assert.equal(TASK_STATUS_LABELS.cancelled, 'Cancelled')
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
})
