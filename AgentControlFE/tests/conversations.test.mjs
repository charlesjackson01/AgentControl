import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  countUnread, hiddenCount, markReadLocally, mergeMessages, olderCursor, previewText, primaryConversation,
  relativeTime, sortConversations, totalUnread, unreadLabel, upsertConversation, visibleConversations,
} from '../src/lib/conversations.ts'

const agents = [
  { id: 'p', name: 'Primary', isPrimary: true },
  { id: 'a', name: 'Alice', isPrimary: false, pinned: true },
  { id: 'b', name: 'Bob', isPrimary: false },
  { id: 'c', name: 'Cy', isPrimary: false },
  { id: 'h', name: 'Hidden', isPrimary: false, hidden: true },
]
const conv = (id, agentId, updatedAt = '2026-10-01T00:00:00Z', extra = {}) => ({
  id, kind: 'dm', agentId, createdAt: '2026-10-01T00:00:00Z', updatedAt, lastReadAt: null, lastMessage: null, unreadCount: 0, ...extra,
})
const msg = (id, createdAt, role = 'assistant') => ({ id, conversationId: 'x', role, content: id, createdAt })

describe('sorting and visibility', () => {
  const list = [
    conv('cb', 'b', '2026-10-16T10:00:00Z'),
    conv('cc', 'c', '2026-10-16T12:00:00Z'),
    conv('ca', 'a'),
    conv('cp', 'p'),
    conv('ch', 'h', '2026-10-16T13:00:00Z'),
    conv('gone', 'zzz'),
  ]
  it('Primary first, then pinned, then newest updatedAt', () => {
    assert.deepEqual(sortConversations(visibleConversations(list, agents), agents).map((c) => c.id), ['cp', 'ca', 'cc', 'cb'])
  })
  it('hidden and orphaned DMs drop out unless showHidden', () => {
    assert.ok(!visibleConversations(list, agents).some((c) => c.id === 'ch' || c.id === 'gone'))
    assert.ok(visibleConversations(list, agents, true).some((c) => c.id === 'ch'))
    assert.ok(!visibleConversations(list, agents, true).some((c) => c.id === 'gone'))
    assert.equal(hiddenCount(list, agents), 1)
  })
  it('primaryConversation', () => {
    assert.equal(primaryConversation(list, agents)?.id, 'cp')
    assert.equal(primaryConversation(list, []), undefined)
  })
})

describe('previewText', () => {
  it('empty', () => {
    assert.equal(previewText(null), 'No messages yet')
    assert.equal(previewText(undefined), 'No messages yet')
  })
  it('prefixes You for the user and collapses whitespace', () => {
    assert.equal(previewText({ role: 'user', content: ' hi\n\n there ' }), 'You: hi there')
    assert.equal(previewText({ role: 'assistant', content: 'done' }), 'done')
  })
  it('clips with an ellipsis', () => {
    const out = previewText({ role: 'assistant', content: 'x'.repeat(200) }, 10)
    assert.equal(Array.from(out).length, 10)
    assert.ok(out.endsWith('…'))
  })
})

describe('relativeTime', () => {
  const now = new Date(2026, 9, 16, 14, 0, 0)
  const ago = (ms) => new Date(now.getTime() - ms).toISOString()
  it('minutes and hours today', () => {
    assert.equal(relativeTime(ago(10_000), now), 'now')
    assert.equal(relativeTime(ago(5 * 60_000), now), '5m')
    assert.equal(relativeTime(ago(3 * 3_600_000), now), '3h')
  })
  it('yesterday, weekday, date, other year, invalid', () => {
    assert.equal(relativeTime(new Date(2026, 9, 15, 23, 0).toISOString(), now), 'Yesterday')
    assert.equal(relativeTime(new Date(2026, 9, 12, 9, 0).toISOString(), now), 'Mon')
    assert.equal(relativeTime(new Date(2026, 9, 3, 9, 0).toISOString(), now), 'Oct 3')
    assert.equal(relativeTime(new Date(2025, 9, 3, 9, 0).toISOString(), now), 'Oct 3, 2025')
    assert.equal(relativeTime('nope', now), '')
  })
})

describe('unread math', () => {
  it('labels and totals', () => {
    assert.equal(unreadLabel(0), '')
    assert.equal(unreadLabel(7), '7')
    assert.equal(unreadLabel(150), '99+')
    assert.equal(totalUnread([{ unreadCount: 2 }, { unreadCount: -1 }, { unreadCount: 3 }]), 5)
  })
  it('markReadLocally zeros one row, keeps identity when unchanged', () => {
    const list = [conv('x', 'b', undefined, { unreadCount: 4 }), conv('y', 'c')]
    const next = markReadLocally(list, 'x', '2026-10-16T00:00:00Z')
    assert.equal(next[0].unreadCount, 0)
    assert.equal(next[0].lastReadAt, '2026-10-16T00:00:00Z')
    assert.equal(list[0].unreadCount, 4)
    assert.equal(markReadLocally(list, 'y'), list)
    assert.equal(markReadLocally(list, 'missing'), list)
  })
  it('countUnread mirrors the BE (assistant only, null = all)', () => {
    const ms = [msg('1', '2026-10-16T01:00:00Z'), msg('2', '2026-10-16T02:00:00Z', 'user'), msg('3', '2026-10-16T03:00:00Z')]
    assert.equal(countUnread(ms, '2026-10-16T01:30:00Z'), 1)
    assert.equal(countUnread(ms, null), 2)
  })
  it('upsert replaces or appends', () => {
    const list = [conv('x', 'b', undefined, { unreadCount: 1 })]
    assert.equal(upsertConversation(list, conv('x', 'b'))[0].unreadCount, 0)
    assert.equal(upsertConversation(list, conv('z', 'c')).length, 2)
  })
})

describe('messages', () => {
  it('merge dedupes by id and sorts oldest first; older cursor', () => {
    const a = [msg('2', '2026-10-16T02:00:00Z'), msg('1', '2026-10-16T01:00:00Z')]
    const b = [{ ...msg('2', '2026-10-16T02:00:00Z'), content: 'edited' }, msg('3', '2026-10-16T03:00:00Z')]
    const out = mergeMessages(a, b)
    assert.deepEqual(out.map((m) => m.id), ['1', '2', '3'])
    assert.equal(out[1].content, 'edited')
    assert.equal(olderCursor(out), '2026-10-16T01:00:00Z')
    assert.equal(olderCursor([]), undefined)
  })
})
