// BE-10 (085be14): the first messages page carries the conversation summary.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pageSummary, upsertConversation, markReadLocally } from '../src/lib/conversations.ts'
import { noteTyping, noteTypingFor, typingSeenFor } from '../src/lib/thread.ts'

const dm = { id: 'c1', kind: 'dm', agentId: 'a1', createdAt: '2026-10-26T10:00:00.000Z', updatedAt: '2026-10-26T10:05:00.000Z', lastReadAt: null }
const msg = { id: 'm1', conversationId: 'c1', role: 'user', content: 'hello', createdAt: '2026-10-26T10:05:00.000Z' }

test('pageSummary: BE-10 first page summary is used as-is', () => {
  const s = { ...dm, lastMessage: msg, unreadCount: 1, typingAgentId: null }
  assert.equal(pageSummary(s), s)
})

test('pageSummary: a typing DM keeps its typingAgentId', () => {
  assert.equal(pageSummary({ ...dm, lastMessage: null, unreadCount: 0, typingAgentId: 'a1' })?.typingAgentId, 'a1')
})

test('pageSummary: a group summary (no archivedAt) is accepted', () => {
  const g = { id: 'g1', kind: 'group', name: 'Harbor', slug: 'harbor', memberAgentIds: ['p', 'r'], leadAgentId: 'p', memoryLearn: true, createdAt: dm.createdAt, updatedAt: dm.updatedAt, lastReadAt: null, lastMessage: null, unreadCount: 2, typingAgentId: 'p' }
  assert.equal(pageSummary(g)?.unreadCount, 2)
})

test('pageSummary: older servers send a plain Conversation on the first page -> null (fallback to the sidebar poll)', () => {
  assert.equal(pageSummary(dm), null)
  assert.equal(pageSummary({ ...dm, unreadCount: 3 }), null, 'no lastMessage key: not a summary')
  assert.equal(pageSummary({ ...dm, lastMessage: null }), null, 'no unreadCount: not a summary')
})

test('pageSummary: pre-BE-5 summary without typingAgentId is still a summary', () => {
  assert.equal(pageSummary({ ...dm, lastMessage: null, unreadCount: 0 })?.id, 'c1')
})

test('pageSummary: rejects junk', () => {
  for (const v of [null, undefined, 'x', 3, [], {}, { id: 1, unreadCount: 0, lastMessage: null }, { ...dm, kind: 'project', lastMessage: null, unreadCount: 0 }, { ...dm, lastMessage: null, unreadCount: '1' }, { ...dm, lastMessage: null, unreadCount: Number.NaN }, { ...dm, lastMessage: null, unreadCount: 0, typingAgentId: 7 }])
    assert.equal(pageSummary(v), null, JSON.stringify(v))
})

test('first-page summary adds a chat the sidebar has not listed yet, and replaces a stale row', () => {
  const s = { ...dm, lastMessage: msg, unreadCount: 1, typingAgentId: 'a1' }
  assert.deepEqual(upsertConversation([], s), [s])
  const stale = { ...dm, lastMessage: null, unreadCount: 0, typingAgentId: null }
  const other = { ...dm, id: 'c2', lastMessage: null, unreadCount: 4, typingAgentId: null }
  const next = upsertConversation([stale, other], s)
  assert.equal(next[0], s)
  assert.equal(next[1], other)
  // Opening marks it read right after.
  assert.equal(markReadLocally(next, 'c1', '2026-10-26T10:06:00.000Z')[0].unreadCount, 0)
})

test('noteTypingFor: starts the typing clock for one conversation only', () => {
  const r = noteTypingFor({ id: 'c1', typingAgentId: 'a1' }, new Set(['c9']), 'T1')
  assert.deepEqual([...r.typing].sort(), ['c1', 'c9'])
  assert.deepEqual(r.started, ['c1'])
  assert.equal(r.at, 'T1')
})

test('noteTypingFor: already typing -> not restarted; stopped -> dropped', () => {
  assert.deepEqual(noteTypingFor({ id: 'c1', typingAgentId: 'a1' }, new Set(['c1']), 'T2').started, [])
  const r = noteTypingFor({ id: 'c1', typingAgentId: null }, new Set(['c1', 'c9']), 'T3')
  assert.deepEqual([...r.typing], ['c9'])
  assert.deepEqual(r.started, [])
  assert.deepEqual(noteTypingFor({ id: 'c1' }, new Set(), 'T4').started, [], 'missing field = not typing')
})

test('noteTypingFor agrees with noteTyping for the same conversation', () => {
  const list = [{ id: 'c1', typingAgentId: 'a1' }, { id: 'c2', typingAgentId: null }]
  const all = noteTyping(list, new Set(['c2']), 'T')
  const one = noteTypingFor(list[0], noteTypingFor(list[1], new Set(['c2']), 'T').typing, 'T')
  assert.deepEqual([...one.typing].sort(), [...all.typing].sort())
  assert.deepEqual(one.started, all.started)
})

test('typing seen from the first page shows "Read" for the latest user message', () => {
  const r = noteTypingFor({ id: 'c1', typingAgentId: 'a1' }, new Set(), '2026-10-26T10:05:01.000Z')
  assert.deepEqual(typingSeenFor([msg], r.at), { messageId: 'm1', at: '2026-10-26T10:05:01.000Z' })
})
