// FE-P2-1 acceptance: "events update the stores" (reducer level; end to end in live-controller.test.mjs).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  OUTPUT_TAIL_CHARS, VM_RUNS_MAX, fileCounts, initialLiveState, isActiveStatus, liveReducer, mergeRun, pendingPermissions,
  resyncPlan, runOutput, runSummaryFor, runSummaryRow, scriptName, statusRank, summaryFromRun, upsertRunRow,
} from '../src/lib/live-store.ts'
import { permission, run, summary, vm } from './live-fixtures.mjs'

const apply = (state, ...actions) => actions.reduce(liveReducer, state)
const event = (e) => ({ type: 'event', event: e })
const updated = (r, extra = {}) => event({ type: 'run.updated', conversationId: r.conversationId, run: r, messageId: r.messageId, summary: summary({ status: r.status }), ...extra })

describe('status helpers', () => {
  it('active statuses and lifecycle order', () => {
    assert.deepEqual(['queued', 'waiting_permission', 'running', 'succeeded', 'failed', 'undone'].map(isActiveStatus), [true, true, true, false, false, false])
    assert.ok(statusRank('queued') < statusRank('running') && statusRank('running') < statusRank('timed_out') && statusRank('stopped') < statusRank('undone'))
  })
  it('mergeRun keeps the later lifecycle step', () => {
    const done = run('r1', { status: 'succeeded' })
    assert.equal(mergeRun(done, run('r1', { status: 'running' })), done)
    const later = run('r1', { status: 'succeeded', undo: { state: 'unavailable', reason: 'expired' } })
    assert.equal(mergeRun(done, later), later)
    assert.equal(mergeRun(undefined, done), done)
  })
  it('names, counts and summaries', () => {
    assert.equal(scriptName({ argv: ['python3', 'scripts/clean.py'] }), 'clean.py')
    assert.equal(scriptName({ argv: ['./build.sh'] }), 'build.sh')
    assert.equal(scriptName({ argv: [] }), 'script')
    assert.deepEqual(fileCounts([{ path: 'a', change: 'added' }, { path: 'b', change: 'deleted' }, { path: 'c', change: 'deleted' }]), { added: 1, modified: 0, deleted: 2 })
    const r = run('r1', { status: 'queued', queuePosition: 2 })
    assert.deepEqual(summaryFromRun(r, summary({ name: 'CSV cleaner' })), { status: 'queued', kind: 'script', name: 'CSV cleaner', files: { added: 0, modified: 0, deleted: 0 }, undo: { state: 'available' }, queuePosition: 2 })
    assert.equal(summaryFromRun(r).name, 'clean.py')
  })
})

describe('run.updated', () => {
  it('stores the run, the card summary by messageId and the output tails', () => {
    const r = run('r1', { stdoutTail: 'hello\n' })
    const s = apply(initialLiveState, updated(r, { summary: summary({ name: 'CSV cleaner' }) }))
    assert.equal(s.runs.r1, r)
    assert.equal(s.summaries['m-r1'].name, 'CSV cleaner')
    assert.deepEqual(runOutput(s, 'r1'), { stdout: 'hello\n', stderr: '' })
    assert.equal(runSummaryFor(s, { id: 'm-r1', scriptRun: summary({ name: 'stale' }) }).name, 'CSV cleaner')
    assert.equal(runSummaryFor(s, { id: 'other', scriptRun: summary({ name: 'own' }) }).name, 'own')
  })
  it('an out-of-order older event does not undo a finished run', () => {
    const s = apply(initialLiveState, updated(run('r1', { status: 'succeeded', exitCode: 0 })), updated(run('r1', { status: 'running' })))
    assert.equal(s.runs.r1.status, 'succeeded')
    assert.equal(s.summaries['m-r1'].status, 'succeeded')
  })
  it('updates the row in a held VM history, newest first, capped', () => {
    const old = runSummaryRow(run('r0', { status: 'succeeded', queuedAt: '2026-10-27T09:00:00.000Z' }))
    let s = apply(initialLiveState, { type: 'vm', vm: vm('a1', { runs: [old] }) }, updated(run('r1')))
    assert.deepEqual(s.vms.a1.runs.map((x) => [x.id, x.status]), [['r1', 'running'], ['r0', 'succeeded']])
    s = apply(s, updated(run('r1', { status: 'failed', exitCode: 2, filesChanged: [{ path: 'x', change: 'added' }] })))
    assert.deepEqual(s.vms.a1.runs.map((x) => [x.id, x.status, x.filesChangedCount]), [['r1', 'failed', 1], ['r0', 'succeeded', 0]])
    // Another bot's VM isn't touched.
    assert.equal(apply(s, updated(run('r9', { agentId: 'a2' }))).vms.a2, undefined)
    const many = Array.from({ length: VM_RUNS_MAX }, (_, i) => runSummaryRow(run(`o${i}`, { queuedAt: `2026-10-01T00:00:${String(i).padStart(2, '0')}.000Z` })))
    assert.equal(upsertRunRow(many, runSummaryRow(run('new'))).length, VM_RUNS_MAX)
    assert.equal(upsertRunRow(many, runSummaryRow(run('new')))[0].id, 'new')
  })
})

describe('run.output', () => {
  const out = (stream, chunk) => event({ type: 'run.output', conversationId: 'c1', runId: 'r1', stream, chunk })
  it('appends chunks per stream on top of the run tail', () => {
    const s = apply(initialLiveState, updated(run('r1', { stdoutTail: 'a' })), out('stdout', 'b'), out('stderr', 'warn'), out('stdout', 'c'))
    assert.deepEqual(runOutput(s, 'r1'), { stdout: 'abc', stderr: 'warn' })
  })
  it('works before the run is known, and keeps only the last 64 KB', () => {
    const big = 'x'.repeat(OUTPUT_TAIL_CHARS)
    const s = apply(initialLiveState, out('stdout', big), out('stdout', 'END'))
    assert.equal(s.output.r1.stdout.length, OUTPUT_TAIL_CHARS)
    assert.ok(s.output.r1.stdout.endsWith('END'))
  })
  it("an ended run's tails replace the live buffer; an active copy with a shorter tail does not", () => {
    let s = apply(initialLiveState, updated(run('r1')), out('stdout', 'abc'))
    s = apply(s, { type: 'run', run: run('r1', { stdoutTail: 'a' }) })
    assert.equal(s.output.r1.stdout, 'abc')
    s = apply(s, updated(run('r1', { status: 'succeeded', stdoutTail: 'abcd' })))
    assert.equal(s.output.r1.stdout, 'abcd')
  })
})

describe('vm and permission events', () => {
  it('vm.updated replaces the bot VM info', () => {
    const s = apply(initialLiveState, event({ type: 'vm.updated', agentId: 'a1', vm: vm('a1', { state: 'stopped' }) }))
    assert.equal(s.vms.a1.state, 'stopped')
  })
  it('permission requested → pending list; resolved → out of it; a late requested does not reopen', () => {
    const req = permission('p1')
    let s = apply(initialLiveState, event({ type: 'permission.requested', conversationId: 'c1', request: req }))
    assert.deepEqual(pendingPermissions(s, 'c1').map((p) => p.id), ['p1'])
    assert.deepEqual(pendingPermissions(s, 'other'), [])
    s = apply(s, event({ type: 'permission.resolved', conversationId: 'c1', request: { ...req, status: 'denied' } }))
    s = apply(s, event({ type: 'permission.requested', conversationId: 'c1', request: req }))
    assert.equal(s.permissions.p1.status, 'denied')
    assert.deepEqual(pendingPermissions(s), [])
  })
  it("a fetched run settles its pending requests from the run's decisions", () => {
    let s = apply(initialLiveState, event({ type: 'permission.requested', conversationId: 'c1', request: permission('p1') }))
    s = apply(s, { type: 'run', run: run('r1', { status: 'running', permissions: [{ requestId: 'p1', type: 'internet', decision: 'allow_once' }] }) })
    assert.equal(s.permissions.p1.status, 'allowed_once')
  })
})

describe('connection, reset and resyncPlan', () => {
  it('tracks connection status and counts resets', () => {
    const s = apply(initialLiveState, { type: 'connection', status: 'open' }, { type: 'reset' }, { type: 'reset' })
    assert.equal(s.connection, 'open')
    assert.equal(s.resets, 2)
    assert.equal(liveReducer(s, { type: 'connection', status: 'open' }), s)
  })
  it('re-fetches active runs, runs behind pending requests, tracked ids and every held VM', () => {
    const s = apply(
      initialLiveState,
      updated(run('done', { status: 'succeeded' })),
      updated(run('q', { status: 'queued' })),
      updated(run('w', { status: 'waiting_permission' })),
      event({ type: 'permission.requested', conversationId: 'c1', request: permission('p1', { runId: 'unseen' }) }),
      { type: 'vm', vm: vm('a1') },
      { type: 'vm', vm: vm('a2') },
    )
    assert.deepEqual(resyncPlan(s, ['tracked', 'done']), { runIds: ['q', 'tracked', 'unseen', 'w'], agentIds: ['a1', 'a2'] })
    assert.deepEqual(resyncPlan(initialLiveState), { runIds: [], agentIds: [] })
  })
})
