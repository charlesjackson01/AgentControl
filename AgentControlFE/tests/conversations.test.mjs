import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  conversationTitle, countUnread, hiddenCount, lastActivity, markReadLocally, mergeMessages, olderCursor,
  previewText, primaryConversation, relativeTime, sortConversations, totalUnread, unreadLabel,
  upsertConversation, visibleConversations,
} from '../src/lib/conversations.ts'
import { normalizeMessagePage } from '../src/lib/api-pages.ts'

const agents = [
  { id: 'p', name: 'Primary', isPrimary: true },
  { id: 'a', name: 'Alice', isPrimary: false, pinned: true },
  { id: 'b', name: 'Bob', isPrimary: false },
  { id: 'h', name: 'Hidden', isPrimary: false, hidden: true },
]
const conv = (id, extra) => ({ id, kind: 'dm', createdAt: '2026-10-01T00:00:00Z', unreadCount: 0, ...extra })
const msg = (id, createdAt, author = 'p') => ({ id, conversationId: 'c', author, text: id, createdAt })

describe('sorting and visibility', () => {
  const list = [
    conv('cb', { agentId: 'b', lastMessage: { author: 'b', text: 'x', createdAt: '2026-10-16T10:00:00Z' } }),
    conv('proj', { kind: 'project', projectId: 'x', lastMessage: { author: 'user', text: 'y', createdAt: '2026-10-16T12:00:00Z' } }),
    conv('ca', { agentId: 'a' }),
    conv('cp', { agentId: 'p' }),
    conv('ch', { agentId: 'h' }),
    conv('gone', { agentId: 'zzz' }),
  ]
  it('Primary first, then pinned, then by last activity', () => {
    assert.deepEqual(sortConversations(list, agents).map((c) => c.id).slice(0, 4), ['cp', 'ca', 'proj', 'cb'])
  })
  it('hides hidden + orphaned DMs unless showHidden', () => {
    assert.deepEqual(visibleConversations(list, agents).map((c) => c.id).sort(), ['ca', 'cb', 'cp', 'proj'])
    assert.ok(visibleConversations(list, agents, true).some((c) => c.id === 'ch'))
    assert.equal(hiddenCount(list, agents), 1)
  })
  it('finds Primary DM and titles', () => {
    assert.equal(primaryConversation(list, agents)?.id, 'cp')
    assert.equal(primaryConversation(list, []), undefined)
    assert.equal(conversationTitle(list[2], agents), 'Alice')
    assert.equal(conversationTitle(list[1], agents, [{ id: 'x', name: 'Launch' }]), 'Launch')
    assert.equal(conversationTitle(list[1], agents), 'Project chat')
  })
  it('lastActivity falls back to createdAt', () => assert.equal(lastActivity(list[2]), '2026-10-01T00:00:00Z'))
})

describe('previewText', () => {
  it('empty conversation', () => assert.equal(previewText(undefined), 'No messages yet'))
  it('prefixes You and collapses whitespace', () =>
    assert.equal(previewText({ author: 'user', text: ' hi\n\n there ', createdAt: '' }), 'You: hi there'))
  it('names speakers in project chats only', () => {
    const last = { author: 'a', text: 'done', createdAt: '' }
    assert.equal(previewText(last, { kind: 'project', agents }), 'Alice: done')
    assert.equal(previewText(last, { kind: 'dm', agents }), 'done')
  })
  it('clips with an ellipsis', () => {
    const out = previewText({ author: 'b', text: 'x'.repeat(200), createdAt: '' }, { kind: 'dm', max: 10 })
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
  it('labels', () => {
    assert.equal(unreadLabel(0), '')
    assert.equal(unreadLabel(7), '7')
    assert.equal(unreadLabel(150), '99+')
  })
  it('total ignores negatives', () => assert.equal(totalUnread([{ unreadCount: 2 }, { unreadCount: -1 }, { unreadCount: 3 }]), 5))
  it('markReadLocally zeros one row and keeps identity when unchanged', () => {
    const list = [conv('x', { unreadCount: 4 }), conv('y', { unreadCount: 0 })]
    const next = markReadLocally(list, 'x', '2026-10-16T00:00:00Z')
    assert.equal(next[0].unreadCount, 0)
    assert.equal(next[0].lastReadAt, '2026-10-16T00:00:00Z')
    assert.equal(list[0].unreadCount, 4)
    assert.equal(markReadLocally(list, 'y'), list)
    assert.equal(markReadLocally(list, 'missing'), list)
  })
  it('countUnread skips the user and read messages', () => {
    const ms = [msg('1', '2026-10-16T01:00:00Z'), msg('2', '2026-10-16T02:00:00Z', 'user'), msg('3', '2026-10-16T03:00:00Z')]
    assert.equal(countUnread(ms, '2026-10-16T01:30:00Z'), 1)
    assert.equal(countUnread(ms, undefined), 2)
  })
  it('upsert replaces or appends', () => {
    const list = [conv('x', { unreadCount: 1 })]
    assert.equal(upsertConversation(list, conv('x', { unreadCount: 0 }))[0].unreadCount, 0)
    assert.equal(upsertConversation(list, conv('z')).length, 2)
  })
})

describe('messages', () => {
  it('merge dedupes by id and sorts oldest first', () => {
    const a = [msg('2', '2026-10-16T02:00:00Z'), msg('1', '2026-10-16T01:00:00Z')]
    const b = [{ ...msg('2', '2026-10-16T02:00:00Z'), text: 'edited' }, msg('3', '2026-10-16T03:00:00Z')]
    const out = mergeMessages(a, b)
    assert.deepEqual(out.map((m) => m.id), ['1', '2', '3'])
    assert.equal(out[1].text, 'edited')
    assert.equal(olderCursor(out), '2026-10-16T01:00:00Z')
    assert.equal(olderCursor([]), undefined)
  })
  it('normalizes both page shapes', () => {
    const arr = [msg('2', '2026-10-16T02:00:00Z'), msg('1', '2026-10-16T01:00:00Z')]
    assert.deepEqual(normalizeMessagePage(arr, 2).messages.map((m) => m.id), ['1', '2'])
    assert.equal(normalizeMessagePage(arr, 2).hasMore, true)
    assert.equal(normalizeMessagePage(arr, 50).hasMore, false)
    assert.equal(normalizeMessagePage({ messages: arr, hasMore: false }, 2).hasMore, false)
  })
})
