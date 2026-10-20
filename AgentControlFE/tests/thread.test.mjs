import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { clockTime, dayLabel, readReceipt, threadItems } from '../src/lib/thread.ts'

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
  it('a time under every bubble; "Read" only on the latest user message', () => {
    const items = threadItems(messages, { now, lastReadAt: at(19, 21, 42) }).filter((i) => i.type === 'message')
    assert.deepEqual(items.map((i) => i.meta), ['6:10 PM', '6:10 PM', '9:41 PM', '9:42 PM', 'Read 9:42 PM', '9:43 PM'])
  })
  it('no receipt before lastReadAt reaches the message, or when never read', () => {
    assert.equal(threadItems(messages, { now, lastReadAt: at(19, 21, 0) })[6].meta, '9:42 PM')
    assert.equal(threadItems(messages, { now, lastReadAt: null })[6].meta, '9:42 PM')
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
    assert.equal(readReceipt(at(19, 21, 0), at(19, 20, 0)), undefined)
    assert.equal(clockTime('bad'), '')
  })
})
