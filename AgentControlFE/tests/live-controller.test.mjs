// FE-P2-1 acceptance, end to end with a fake /api/events fetch and a fake REST client:
//   "events update the stores; reconnect re-fetches active runs and pending requests".
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createLiveController } from '../src/lib/live-controller.ts'
import { pendingPermissions, runOutput, runSummaryFor } from '../src/lib/live-store.ts'
import { fakeEventsFetch, frame, permission, run, summary, tick, until, vm } from './live-fixtures.mjs'

function fakeClient(runs = {}, vms = {}, pending = () => ({ requests: [] })) {
  const calls = { runs: [], vms: [], pending: 0 }
  return {
    calls,
    client: {
      getRun: async (id) => {
        calls.runs.push(id)
        if (!runs[id]) throw Object.assign(new Error('Not found'), { status: 404 })
        return runs[id]
      },
      getVm: async (id) => {
        calls.vms.push(id)
        return vms[id]
      },
      listPendingPermissions: async () => {
        calls.pending += 1
        return pending()
      },
    },
  }
}

const runUpdated = (r, s) => ({ type: 'run.updated', conversationId: 'c1', run: r, messageId: r.messageId, summary: summary(s) })

describe('live controller', () => {
  it('events update the stores (runs, card summaries, output, VM info, permissions) and notify subscribers', async () => {
    const f = fakeEventsFetch([{
      frames: [
        frame('1', { type: 'vm.updated', agentId: 'a1', vm: vm('a1', { state: 'running' }) }),
        frame('2', runUpdated(run('r1'), { name: 'CSV cleaner' })),
        frame('3', { type: 'run.output', conversationId: 'c1', runId: 'r1', stream: 'stdout', chunk: 'row 1\n' }),
        frame('4', { type: 'permission.requested', conversationId: 'c1', request: permission('p1') }),
        ': ping\n\n',
      ],
      end: false,
    }])
    const { client } = fakeClient()
    const live = createLiveController({ client, connection: { url: '/api/events', fetch: f.fetch } })
    let notified = 0
    live.subscribe(() => (notified += 1))
    live.start()
    await until(() => Object.keys(live.getState().permissions).length === 1)
    live.stop()
    const s = live.getState()
    assert.equal(s.runs.r1.status, 'running')
    assert.equal(runSummaryFor(s, { id: 'm-r1' }).name, 'CSV cleaner')
    assert.equal(runOutput(s, 'r1').stdout, 'row 1\n')
    assert.equal(s.vms.a1.state, 'running')
    // The held VM's history picks up the run from run.updated.
    assert.equal(s.vms.a1.runs[0].id, 'r1')
    assert.deepEqual(pendingPermissions(s, 'c1').map((p) => p.id), ['p1'])
    assert.ok(notified >= 5)
  })

  it('reconnect re-fetches active runs, pending requests (list route) and held VMs, resuming with Last-Event-ID', async () => {
    // First stream: r1 running, r2 done, two pending requests; then the stream drops.
    // While disconnected r1 finished, p1 was answered and p2 arrived; no events for any of it.
    const f = fakeEventsFetch([
      {
        frames: [
          frame('10', runUpdated(run('r1'))),
          frame('11', runUpdated(run('r2', { status: 'succeeded' }), { status: 'succeeded' })),
          frame('12', { type: 'permission.requested', conversationId: 'c1', request: permission('p1', { runId: 'r3' }) }),
          frame('13', { type: 'vm.updated', agentId: 'a1', vm: vm('a1') }),
        ],
      },
      { frames: [], end: false },
    ])
    const fresh = {
      r1: run('r1', { status: 'succeeded', exitCode: 0, stdoutTail: 'done\n', filesChanged: [{ path: 'workspace/out.csv', change: 'added' }] }),
    }
    let connected = 0
    // The first open sees p1 pending; after the reconnect p1 is answered and p2 is new.
    const pending = () => (connected++ === 0 ? { requests: [permission('p1', { runId: 'r3' })] } : { requests: [permission('p2', { runId: 'r4' })] })
    const { client, calls } = fakeClient(fresh, { a1: vm('a1', { state: 'stopped' }) }, pending)
    const live = createLiveController({ client, connection: { url: '/api/events', fetch: f.fetch, retryMs: 1 } })
    live.start()
    await until(() => f.calls.length === 2 && live.getState().permissions.p2 && live.getState().vms.a1.state === 'stopped')
    await live.resync()
    live.stop()
    const s = live.getState()
    assert.equal(f.calls[1].headers['Last-Event-ID'], '13')
    // Only the active run is fetched: not the finished one, and not the runs behind requests.
    assert.ok(calls.runs.includes('r1'))
    assert.ok(!calls.runs.includes('r2') && !calls.runs.includes('r3'))
    assert.ok(calls.vms.includes('a1'))
    assert.ok(calls.pending >= 2, 'the pending list is fetched on every open')
    assert.equal(s.runs.r1.status, 'succeeded')
    assert.deepEqual(runSummaryFor(s, { id: 'm-r1' }).files, { added: 1, modified: 0, deleted: 0 })
    assert.equal(runOutput(s, 'r1').stdout, 'done\n')
    assert.deepEqual(pendingPermissions(s).map((p) => p.id), ['p2'])
  })

  it('a failing pending list (an M1 BE without the route) keeps what we hold', async () => {
    const { client } = fakeClient({}, {}, () => {
      throw Object.assign(new Error('Not found'), { status: 404 })
    })
    const live = createLiveController({ client, connection: { url: '/e', fetch: fakeEventsFetch([]).fetch } })
    live.dispatch({ type: 'event', event: { type: 'permission.requested', conversationId: 'c1', request: permission('p1') } })
    await live.resync()
    assert.deepEqual(pendingPermissions(live.getState()).map((p) => p.id), ['p1'])
  })

  it('event: reset bumps `resets` and re-fetches active runs and tracked ones', async () => {
    const f = fakeEventsFetch([{ frames: [frame('1', runUpdated(run('r1'))), 'event: reset\ndata: {}\n\n'], end: false }])
    const { client, calls } = fakeClient({ r1: run('r1', { status: 'stopped' }), r7: run('r7', { status: 'queued', queuePosition: 0 }) })
    const live = createLiveController({ client, connection: { url: '/api/events', fetch: f.fetch } })
    live.trackRuns(['r7'])
    live.start()
    await until(() => live.getState().resets === 1 && live.getState().runs.r1?.status === 'stopped' && live.getState().runs.r7)
    await live.resync()
    live.stop()
    assert.ok(calls.runs.filter((id) => id === 'r1').length >= 1)
    assert.equal(live.getState().runs.r7.queuePosition, 0)
  })

  it('overlapping resyncs collapse into one extra pass; a failed fetch keeps the old copy', async () => {
    const { client, calls } = fakeClient({})
    const live = createLiveController({ client, connection: { url: '/e', fetch: fakeEventsFetch([]).fetch } })
    live.dispatch({ type: 'run', run: run('gone') })
    const a = live.resync()
    const b = live.resync()
    live.resync()
    await Promise.all([a, b])
    assert.equal(calls.runs.length, 2)
    assert.equal(live.getState().runs.gone.status, 'running')
  })

  it('loadRun / loadVm fill the store; a stop and start resumes from the last event id', async () => {
    const f = fakeEventsFetch([{ frames: [frame('5', runUpdated(run('r1')))], end: false }, { frames: [], end: false }])
    const { client } = fakeClient({ r2: run('r2', { status: 'succeeded' }) }, { a2: vm('a2') })
    const live = createLiveController({ client, connection: { url: '/e', fetch: f.fetch } })
    assert.equal((await live.loadRun('r2')).id, 'r2')
    assert.equal(await live.loadRun('missing'), undefined)
    assert.equal((await live.loadVm('a2')).agentId, 'a2')
    live.start()
    await until(() => live.getState().runs.r1)
    live.stop()
    await tick(5)
    live.start()
    await until(() => f.calls.length === 2)
    live.stop()
    assert.equal(f.calls[1].headers['Last-Event-ID'], '5')
    assert.ok(live.getState().runs.r2 && live.getState().vms.a2)
  })
})
