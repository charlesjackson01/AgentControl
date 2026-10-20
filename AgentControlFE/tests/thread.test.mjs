import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { clockTime, dayLabel, firstReplyAfter, latestUserIndex, noteTyping, readAtFor, readReceipt, threadItems, typingSeenFor } from '../src/lib/thread.ts'

const at = (d, h, m) => new Date(2026, 9, d, h, m).toISOString()
const m = (id, createdAt, role = 'assistant', extra = {}) => ({ id, conversationId: 'c', role, content: id, createdAt, ...extra })
const now = new Date(2026, 9, 19, 22, 0)

describe('thread layout', () => {
  const messages = [
    m('u1', at(18, 18, 10), 'user'),
    m('a1', at(18, 18, 10)),
    m('u2', at(19, 21, 41), 'user'),
    m('a2', at(19, 21, 42)),
    m('u3', at(19, 21, 42), 'user'),
    m('a3', at(19, 21, 43)),
  ]
  it('a day separator wherever the day changes', () => {
    const items = threadItems(messages, { now })
    assert.deepEqual(items.filter((i) => i.type === 'day').map((i) => i.label), ['Yesterday', 'Today'])
    assert.equal(items[0].type, 'day')
    assert.equal(items.length, messages.length + 2)
  })
  it('a time under every bubble; "Read <first reply time>" only on the latest user message', () => {
    const items = threadItems(messages, { now }).filter((i) => i.type === 'message')
    assert.deepEqual(items.map((i) => i.meta), ['6:10 PM', '6:10 PM', '9:41 PM', '9:42 PM', 'Read 9:43 PM', '9:43 PM'])
  })
  it('no reply yet: the typing time held for that message, else no label', () => {
    const waiting = messages.slice(0, 5)
    assert.equal(threadItems(waiting, { now, typingSeen: { messageId: 'u3', at: at(19, 21, 44) } })[6].meta, 'Read 9:44 PM')
    assert.equal(threadItems(waiting, { now })[6].meta, '9:42 PM')
    // A typing time held for an older message doesn't carry over to a new one.
    assert.equal(threadItems(waiting, { now, typingSeen: { messageId: 'u2', at: at(19, 21, 41) } })[6].meta, '9:42 PM')
  })
  it('a reply wins over a held typing time', () => {
    assert.equal(threadItems(messages, { now, typingSeen: { messageId: 'u3', at: at(19, 21, 50) } })[6].meta, 'Read 9:43 PM')
  })
  it('keeps the input index for Retry lookups', () => {
    const items = threadItems(messages, { now }).filter((i) => i.type === 'message')
    assert.deepEqual(items.map((i) => i.index), [0, 1, 2, 3, 4, 5])
  })
  it('empty thread -> no items', () => {
    assert.deepEqual(threadItems([], { now }), [])
  })
})

describe('thread formatters', () => {
  it('day labels', () => {
    assert.equal(dayLabel(at(19, 1, 0), now), 'Today')
    assert.equal(dayLabel(at(18, 23, 0), now), 'Yesterday')
    assert.equal(dayLabel(at(15, 9, 0), now), 'Thursday')
    assert.equal(dayLabel(at(3, 9, 0), now), 'Oct 3')
    assert.equal(dayLabel(new Date(2025, 9, 3).toISOString(), now), 'Oct 3, 2025')
  })
  it('receipts name the read day when it differs', () => {
    assert.equal(readReceipt(at(18, 21, 0), at(19, 9, 5)), 'Read Oct 19, 9:05 AM')
    assert.equal(readReceipt(at(19, 21, 0), null), undefined)
    assert.equal(clockTime('bad'), '')
  })
})

describe('read time sources', () => {
  const list = [m('u1', at(19, 9, 0), 'user'), m('a1', at(19, 9, 1)), m('sys', at(19, 9, 2), 'assistant', { kind: 'system' }), m('u2', at(19, 9, 3), 'user')]
  it('latest user message and the first reply after it (system lines skipped)', () => {
    assert.equal(latestUserIndex(list), 3)
    assert.equal(latestUserIndex([m('a', at(19, 9, 0))]), -1)
    assert.equal(firstReplyAfter(list, 0), at(19, 9, 1))
    assert.equal(firstReplyAfter(list, 1), undefined)
  })
  it('readAtFor: reply, else held typing time for that message, else nothing', () => {
    assert.equal(readAtFor(list.slice(0, 2)), at(19, 9, 1))
    assert.equal(readAtFor(list), undefined)
    assert.equal(readAtFor(list, { messageId: 'u2', at: at(19, 9, 4) }), at(19, 9, 4))
    assert.equal(readAtFor(list, { messageId: 'u1', at: at(19, 9, 4) }), undefined)
    assert.equal(readAtFor([]), undefined)
  })
  it('typingSeenFor binds the held time to the latest user message only if typing began after it', () => {
    assert.deepEqual(typingSeenFor(list, at(19, 9, 4)), { messageId: 'u2', at: at(19, 9, 4) })
    assert.equal(typingSeenFor(list, at(19, 9, 2)), null)
    assert.equal(typingSeenFor(list, undefined), null)
    assert.equal(typingSeenFor([], at(19, 9, 4)), null)
  })
  it('noteTyping reports only newly started typing runs', () => {
    const t = 'T'
    const first = noteTyping([{ id: 'a', typingAgentId: 'x' }, { id: 'b', typingAgentId: null }], new Set(), t)
    assert.deepEqual([[...first.typing], first.started], [['a'], ['a']])
    const again = noteTyping([{ id: 'a', typingAgentId: 'x' }, { id: 'b', typingAgentId: 'y' }], first.typing, t)
    assert.deepEqual(again.started, ['b'])
    const stopped = noteTyping([{ id: 'a' }], again.typing, t)
    assert.deepEqual([[...stopped.typing], stopped.started], [[], []])
    assert.deepEqual(noteTyping([{ id: 'a', typingAgentId: 'x' }], stopped.typing, t).started, ['a'])
  })
})
