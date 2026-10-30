import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { connectLiveEvents, createSseParser, readLiveFrame, retryDelay } from '../src/lib/live-events.ts'
import { fakeEventsFetch, frame, run, summary, tick, until } from './live-fixtures.mjs'

const parseAll = (chunks) => {
  const frames = []
  const retries = []
  const comments = []
  const p = createSseParser({ frame: (f) => frames.push(f), retry: (ms) => retries.push(ms), comment: (c) => comments.push(c) })
  for (const c of chunks) p.push(c)
  return { frames, retries, comments, lastId: p.lastEventId() }
}

describe('SSE parser', () => {
  it('reads id/event/data frames, the retry line and ping comments', () => {
    const r = parseAll(['retry: 3000\n\n: ping\n\nid: 7\nevent: run.output\ndata: {"a":1}\n\n'])
    assert.deepEqual(r.frames, [{ id: '7', event: 'run.output', data: '{"a":1}' }])
    assert.deepEqual(r.retries, [3000])
    assert.deepEqual(r.comments, ['ping'])
    assert.equal(r.lastId, '7')
  })
  it('handles frames split across chunks, CRLF and lone CR line ends', () => {
    const r = parseAll(['id: 1\r', '\nevent: vm.up', 'dated\r\ndata: x\r\r', 'id: 2\ndata: y\n', '\n'])
    assert.deepEqual(r.frames, [{ id: '1', event: 'vm.updated', data: 'x' }, { id: '2', event: 'message', data: 'y' }])
  })
  it('joins multi-line data, keeps the last id on later frames, and dispatches a bare event: reset', () => {
    const r = parseAll(['id: 5\ndata: a\ndata: b\n\nevent: reset\n\n'])
    assert.deepEqual(r.frames, [{ id: '5', event: 'message', data: 'a\nb' }, { id: '5', event: 'reset', data: '' }])
  })
  it('reads BE-P2-12 frames: retry first, pings between events, data with no space after the colon', () => {
    const r = parseAll(['retry: 3000\n\n', ': ping\n', '\nid: 12\nevent: run.output\ndata:{"x":', '1}\n\n: ping\n\n'])
    assert.deepEqual(r.frames, [{ id: '12', event: 'run.output', data: '{"x":1}' }])
    assert.deepEqual(r.comments, ['ping', 'ping'])
  })
  it('ignores a non-numeric retry and an empty frame', () => {
    const r = parseAll(['retry: soon\n\n\n\n'])
    assert.deepEqual(r.frames, [])
    assert.deepEqual(r.retries, [])
  })
})

describe('readLiveFrame', () => {
  const ev = { type: 'run.updated', conversationId: 'c1', run: run('r1'), messageId: 'm1', summary: summary() }
  it('accepts each contract event type', () => {
    assert.deepEqual(readLiveFrame({ id: '1', event: 'run.updated', data: JSON.stringify(ev) }), { kind: 'event', id: '1', event: ev })
    const out = { type: 'run.output', conversationId: 'c1', runId: 'r1', stream: 'stderr', chunk: 'oops\n' }
    assert.equal(readLiveFrame({ event: 'run.output', data: JSON.stringify(out) }).kind, 'event')
    assert.equal(readLiveFrame({ event: 'vm.updated', data: JSON.stringify({ type: 'vm.updated', agentId: 'a1', vm: {} }) }).kind, 'event')
    assert.equal(readLiveFrame({ event: 'permission.requested', data: JSON.stringify({ conversationId: 'c1', request: { id: 'p1', runId: 'r1', status: 'pending' } }) }).event.type, 'permission.requested')
  })
  it('reads reset, and drops unknown, malformed and mismatched frames', () => {
    assert.deepEqual(readLiveFrame({ id: '9', event: 'reset', data: '{}' }), { kind: 'reset', id: '9' })
    assert.equal(readLiveFrame({ event: 'run.deleted', data: '{}' }), null)
    assert.equal(readLiveFrame({ event: 'run.updated', data: 'not json' }), null)
    assert.equal(readLiveFrame({ event: 'run.updated', data: JSON.stringify({ ...ev, type: 'vm.updated' }) }), null)
    assert.equal(readLiveFrame({ event: 'run.updated', data: JSON.stringify({ ...ev, summary: undefined }) }), null)
    assert.equal(readLiveFrame({ event: 'run.output', data: JSON.stringify({ runId: 'r1', stream: 'both', chunk: '' }) }), null)
  })
})

describe('retryDelay', () => {
  it('doubles per failure up to the ceiling', () => {
    assert.deepEqual([0, 1, 2, 3, 20].map((n) => retryDelay(3000, n, 30_000)), [3000, 6000, 12_000, 24_000, 30_000])
  })
})

describe('connectLiveEvents', () => {
  const ev1 = { type: 'run.output', conversationId: 'c1', runId: 'r1', stream: 'stdout', chunk: 'a' }
  const ev2 = { ...ev1, chunk: 'b' }

  it('delivers events, then reconnects with Last-Event-ID and reports the reconnect', async () => {
    const f = fakeEventsFetch([{ frames: ['retry: 1\n\n', frame('41', ev1)] }, { frames: [frame('42', ev2)], end: false }])
    const seen = []
    const opens = []
    const statuses = []
    const c = connectLiveEvents({
      url: '/api/events', fetch: f.fetch, headers: { Authorization: 'Bearer t' }, retryMs: 50,
      onEvent: (e, id) => seen.push([id, e.chunk]), onReset: () => seen.push('reset'), onOpen: (i) => opens.push(i.reconnect), onStatus: (s) => statuses.push(s),
    })
    await until(() => seen.length === 2)
    c.close()
    assert.deepEqual(seen, [['41', 'a'], ['42', 'b']])
    assert.deepEqual(opens, [false, true])
    assert.equal(f.calls[0].headers['Last-Event-ID'], undefined)
    assert.equal(f.calls[0].headers.Accept, 'text/event-stream')
    assert.equal(f.calls[0].headers.Authorization, 'Bearer t')
    assert.equal(f.calls[1].headers['Last-Event-ID'], '41')
    assert.equal(c.lastEventId(), '42')
    await until(() => statuses.at(-1) === 'closed')
    assert.deepEqual(statuses.slice(0, 3), ['connecting', 'open', 'reconnecting'])
  })

  it('sends the auth header on every reconnect and never puts a token in the URL', async () => {
    const f = fakeEventsFetch([{ throws: true }, { frames: [frame('1', ev1)] }, { frames: [frame('2', ev2)], end: false }])
    const seen = []
    const c = connectLiveEvents({ url: '/api/events', fetch: f.fetch, headers: { Authorization: 'Bearer t' }, retryMs: 1, onEvent: (e, id) => seen.push(id), onReset: () => {} })
    await until(() => seen.length === 2)
    c.close()
    assert.equal(f.calls.length, 3)
    for (const call of f.calls) {
      assert.equal(call.headers.Authorization, 'Bearer t')
      assert.ok(!/token|bearer/i.test(call.url ?? ''), call.url)
    }
    assert.equal(f.calls[2].headers['Last-Event-ID'], '1')
  })

  it('calls onReset for event: reset', async () => {
    const f = fakeEventsFetch([{ frames: ['id: 3\nevent: reset\ndata: {}\n\n'], end: false }])
    let resets = 0
    const c = connectLiveEvents({ url: '/e', fetch: f.fetch, onEvent: () => {}, onReset: () => (resets += 1) })
    await until(() => resets === 1)
    c.close()
    assert.equal(c.lastEventId(), '3')
  })

  it('records the BE-P2-12 reset frame id (e0e1dde: id before event) and reconnects with it, so it does not reset again', async () => {
    const f = fakeEventsFetch([{ frames: ['retry: 1\n\n', 'id: 1500\nevent: reset\ndata: {}\n\n'] }, { frames: [frame('1501', ev1)], end: false }])
    const seen = []
    const c = connectLiveEvents({ url: '/e', fetch: f.fetch, lastEventId: '12', retryMs: 1, onEvent: (e, id) => seen.push(id), onReset: () => seen.push('reset') })
    await until(() => seen.length === 2)
    c.close()
    assert.deepEqual(seen, ['reset', '1501'])
    assert.equal(f.calls[0].headers['Last-Event-ID'], '12')
    assert.equal(f.calls[1].headers['Last-Event-ID'], '1500')
    assert.equal(c.lastEventId(), '1501')
  })

  it('starts from a given lastEventId, retries after errors and non-2xx answers', async () => {
    const f = fakeEventsFetch([{ throws: true }, { status: 503 }, { frames: [frame('8', ev1)], end: false }])
    const seen = []
    const c = connectLiveEvents({ url: '/e', fetch: f.fetch, lastEventId: '5', retryMs: 1, onEvent: (e, id) => seen.push(id), onReset: () => {} })
    await until(() => seen.length === 1)
    c.close()
    assert.equal(f.calls.length, 3)
    assert.ok(f.calls.every((call) => call.headers['Last-Event-ID'] === '5'))
  })

  it('drops a silent stream after idleMs and reconnects', async () => {
    const f = fakeEventsFetch([{ frames: [frame('1', ev1)], end: false }, { frames: [frame('2', ev2)], end: false }])
    const seen = []
    const c = connectLiveEvents({ url: '/e', fetch: f.fetch, idleMs: 30, retryMs: 1, onEvent: (e, id) => seen.push(id), onReset: () => {} })
    await until(() => seen.length === 2)
    c.close()
    assert.equal(f.calls[1].headers['Last-Event-ID'], '1')
  })

  it('close stops reconnecting', async () => {
    const f = fakeEventsFetch([])
    const c = connectLiveEvents({ url: '/e', fetch: f.fetch, retryMs: 1, onEvent: () => {}, onReset: () => {} })
    await until(() => f.calls.length === 1)
    c.close()
    await tick(20)
    assert.equal(f.calls.length, 1)
  })
})
