import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CHAT_LIST_KEY, agentDmPath, agentStatusLine, chatListUnread, isAgentTyping, chatSections, conversationTitle, groupAvatarIds,
  homeTarget, listTime, previewLine, readChatListOpen, shellShortcut, switcherOrder, switcherSections, writeChatListOpen,
} from '../src/lib/shell.ts'

const agents = [
  { id: 'p', name: 'Primary', isPrimary: true, role: 'Team Lead', skillIds: ['a', 'b', 'c'], status: 'idle' },
  { id: 'cr', name: 'Code Reviewer', isPrimary: false, role: 'Reviews diffs', skillIds: ['a'], status: 'idle' },
  { id: 's', name: 'Summarizer', isPrimary: false, role: '', skillIds: [], status: 'running' },
  { id: 'r', name: 'Researcher', isPrimary: false, role: 'Deep research', skillIds: ['x', 'y'], pinned: true },
  { id: 'h', name: 'Hidden', isPrimary: false, hidden: true },
]
const msg = (createdAt, extra = {}) => ({ id: `m-${createdAt}`, conversationId: 'x', role: 'assistant', content: 'hi', createdAt, ...extra })
const dm = (id, agentId, extra = {}) => ({ id, kind: 'dm', agentId, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', lastReadAt: null, lastMessage: null, unreadCount: 0, ...extra })
const group = (id, name, extra = {}) => ({
  id, kind: 'group', name, slug: name.toLowerCase(), memberAgentIds: ['p', 'r', 's'], leadAgentId: 'p', memoryLearn: true,
  createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', lastReadAt: null, lastMessage: null, unreadCount: 0, ...extra,
})

function memStorage(init = {}) {
  const m = new Map(Object.entries(init))
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), map: m }
}

describe('home redirect', () => {
  it('goes to the newest conversation that has a message', () => {
    const list = [
      dm('cp', 'p', { lastMessage: msg('2026-10-18T10:00:00Z'), updatedAt: '2026-10-18T10:00:00Z' }),
      dm('ccr', 'cr', { lastMessage: msg('2026-10-19T09:00:00Z'), updatedAt: '2026-10-19T09:00:00Z' }),
      dm('cs', 's', { updatedAt: '2026-10-19T23:00:00Z' }), // empty, just created: never wins
      group('g1', 'Harbor', { lastMessage: msg('2026-10-19T08:00:00Z'), updatedAt: '2026-10-19T08:00:00Z' }),
    ]
    assert.deepEqual(homeTarget(list, agents), { kind: 'chat', id: 'ccr' })
  })
  it('a group can be the newest chat', () => {
    const list = [dm('cp', 'p', { lastMessage: msg('2026-10-18T10:00:00Z') }), group('g1', 'Harbor', { lastMessage: msg('2026-10-19T08:00:00Z') })]
    assert.deepEqual(homeTarget(list, agents), { kind: 'chat', id: 'g1' })
  })
  it("falls back to Primary's DM when no chat has messages", () => {
    const list = [dm('cs', 's', { updatedAt: '2026-10-19T23:00:00Z' }), dm('cp', 'p')]
    assert.deepEqual(homeTarget(list, agents), { kind: 'chat', id: 'cp' })
  })
  it("ignores a hidden bot's chat", () => {
    const list = [dm('ch', 'h', { lastMessage: msg('2026-10-19T23:00:00Z') }), dm('cp', 'p')]
    assert.deepEqual(homeTarget(list, agents), { kind: 'chat', id: 'cp' })
  })
  it('first-run setup with no bots; empty with bots but no chats', () => {
    assert.deepEqual(homeTarget([], []), { kind: 'setup' })
    assert.deepEqual(homeTarget([], agents), { kind: 'empty' })
  })
  it('without a Primary DM, any visible chat', () => {
    assert.deepEqual(homeTarget([dm('cs', 's')], agents), { kind: 'chat', id: 'cs' })
  })
  it('/agents/:id maps to that bot’s DM', () => {
    const list = [dm('cp', 'p'), dm('cr1', 'cr'), group('g1', 'G')]
    assert.equal(agentDmPath('cr', list), '/c/cr1')
    assert.equal(agentDmPath('nope', list), null)
  })
})

describe('chat list persistence', () => {
  it('defaults to open, reads 1/0, ignores junk', () => {
    assert.equal(readChatListOpen(memStorage()), true)
    assert.equal(readChatListOpen(memStorage(), false), false)
    assert.equal(readChatListOpen(memStorage({ [CHAT_LIST_KEY]: '0' })), false)
    assert.equal(readChatListOpen(memStorage({ [CHAT_LIST_KEY]: '1' }), false), true)
    assert.equal(readChatListOpen(memStorage({ [CHAT_LIST_KEY]: 'yes' })), true)
    assert.equal(readChatListOpen(null), true)
  })
  it('round-trips and survives a throwing storage', () => {
    const s = memStorage()
    writeChatListOpen(s, false)
    assert.equal(s.map.get(CHAT_LIST_KEY), '0')
    assert.equal(readChatListOpen(s), false)
    writeChatListOpen(s, true)
    assert.equal(readChatListOpen(s), true)
    const broken = { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') } }
    assert.doesNotThrow(() => writeChatListOpen(broken, true))
    assert.equal(readChatListOpen(broken, false), false)
  })
})

describe('keyboard shortcuts', () => {
  it('⌘\\ / Ctrl+\\ toggles the list; ⌘K / Ctrl+K opens search', () => {
    assert.equal(shellShortcut({ key: '\\', metaKey: true }), 'toggle-list')
    assert.equal(shellShortcut({ key: '\\', ctrlKey: true }), 'toggle-list')
    assert.equal(shellShortcut({ key: 'k', metaKey: true }), 'search')
    assert.equal(shellShortcut({ key: 'K', ctrlKey: true }), 'search')
  })
  it('ignores plain keys, Alt combos and ⇧⌘K', () => {
    assert.equal(shellShortcut({ key: 'k' }), null)
    assert.equal(shellShortcut({ key: '\\' }), null)
    assert.equal(shellShortcut({ key: 'k', metaKey: true, altKey: true }), null)
    assert.equal(shellShortcut({ key: 'K', metaKey: true, shiftKey: true }), null)
  })
})

describe('unread badge sum', () => {
  it('sums visible DMs and groups, skips hidden bots and junk counts', () => {
    const list = [dm('cp', 'p', { unreadCount: 2 }), dm('cs', 's', { unreadCount: 0 }), dm('ch', 'h', { unreadCount: 7 }), group('g', 'G', { unreadCount: 3 }), dm('x', 'cr', { unreadCount: -1 })]
    assert.equal(chatListUnread(list, agents), 5)
    assert.equal(chatListUnread([], agents), 0)
  })
})

describe('chat list sections', () => {
  const list = [
    dm('cs', 's', { updatedAt: '2026-10-19T10:00:00Z' }),
    dm('ccr', 'cr', { updatedAt: '2026-10-19T12:00:00Z' }),
    dm('cr', 'r'),
    dm('cp', 'p'),
    dm('ch', 'h'),
    group('g-old', 'AgentControl dev', { updatedAt: '2026-10-16T10:00:00Z' }),
    group('g-new', 'Harbor team', { updatedAt: '2026-10-19T20:00:00Z' }),
  ]
  it('bots: Primary, pinned, newest; groups: newest first', () => {
    const { bots, groups } = chatSections(list, agents)
    assert.deepEqual(bots.map((c) => c.id), ['cp', 'cr', 'ccr', 'cs'])
    assert.deepEqual(groups.map((c) => c.id), ['g-new', 'g-old'])
  })
  it('showHidden adds hidden bots', () => {
    assert.ok(chatSections(list, agents, { showHidden: true }).bots.some((c) => c.id === 'ch'))
  })
  it('query filters by name or role, case-insensitively, in both sections', () => {
    assert.deepEqual(chatSections(list, agents, { query: 'RE' }).bots.map((c) => c.id), ['cr', 'ccr'])
    assert.deepEqual(chatSections(list, agents, { query: 'deep' }).bots.map((c) => c.id), ['cr'])
    assert.deepEqual(chatSections(list, agents, { query: 'harbor' }).groups.map((c) => c.id), ['g-new'])
  })
  it('titles', () => {
    assert.equal(conversationTitle(dm('cp', 'p'), agents), 'Primary')
    assert.equal(conversationTitle(group('g', 'Harbor team'), agents), 'Harbor team')
    assert.equal(conversationTitle(dm('z', 'zz'), agents), 'Unknown bot')
  })
})

describe('bot switcher list', () => {
  const now = new Date(2026, 9, 19, 22, 0)
  const list = [
    dm('cp', 'p', { lastMessage: msg(new Date(2026, 9, 19, 21, 43).toISOString()) }),
    dm('ccr', 'cr', { unreadCount: 2, lastMessage: msg(new Date(2026, 9, 19, 21, 20).toISOString()) }),
    dm('cs', 's', { lastMessage: msg(new Date(2026, 9, 18, 12, 0).toISOString()) }),
    group('g', 'Harbor team', { unreadCount: 3 }),
  ]
  const sections = switcherSections(list, agents, { currentId: 'cp', now })
  it('bots show "role · N skills", the current chat, unread and time', () => {
    const [p, cr, s] = sections.bots
    assert.deepEqual([p.title, p.subtitle, p.current, p.isPrimary], ['Primary', 'Team Lead · 3 skills', true, true])
    assert.deepEqual([cr.subtitle, cr.unread, cr.current], ['Reviews diffs · 1 skill', 2, false])
    assert.deepEqual([s.subtitle, s.time], ['Bot · 0 skills', 'Yesterday'])
  })
  it('groups show "You + N bots"', () => {
    assert.deepEqual(sections.groups.map((g) => [g.title, g.subtitle, g.unread]), [['Harbor team', 'You + 3 bots', 3]])
  })
  it('flat order for arrow keys is bots then groups', () => {
    assert.deepEqual(switcherOrder(sections).map((i) => i.id), ['cp', 'ccr', 'cs', 'g'])
  })
  it('filters with the query', () => {
    const f = switcherSections(list, agents, { query: 'harb', now })
    assert.deepEqual([f.bots.length, f.groups.length], [0, 1])
  })
})

describe('small formatters', () => {
  it('group avatars: other members first, then the lead, max two', () => {
    assert.deepEqual(groupAvatarIds({ memberAgentIds: ['p', 'r', 's'], leadAgentId: 'p' }), ['r', 's'])
    assert.deepEqual(groupAvatarIds({ memberAgentIds: ['p', 'cr'], leadAgentId: 'p' }), ['cr', 'p'])
    assert.deepEqual(groupAvatarIds({}), [])
  })
  it('group previews name the author; DMs do not', () => {
    const last = msg('2026-10-19T10:00:00Z', { content: 'I saved it', authorAgentId: 'r' })
    assert.equal(previewLine(group('g', 'G', { lastMessage: last }), agents), 'Researcher: I saved it')
    assert.equal(previewLine(dm('d', 'r', { lastMessage: last }), agents), 'I saved it')
    assert.equal(previewLine(group('g', 'G', { lastMessage: { ...last, role: 'user' } }), agents), 'You: I saved it')
  })
  it('list times', () => {
    const now = new Date(2026, 9, 19, 22, 0)
    assert.equal(listTime(new Date(2026, 9, 19, 21, 43).toISOString(), now), '9:43 PM')
    assert.equal(listTime(new Date(2026, 9, 18, 9, 0).toISOString(), now), 'Yesterday')
    assert.equal(listTime(new Date(2026, 9, 16, 9, 0).toISOString(), now), 'Fri')
    assert.equal(listTime(new Date(2026, 9, 2, 9, 0).toISOString(), now), 'Oct 2')
    assert.equal(listTime(new Date(2025, 9, 2, 9, 0).toISOString(), now), 'Oct 2, 2025')
    assert.equal(listTime('nope', now), '')
  })
  it('header status line: role · model, or "typing…"; never a faked presence', () => {
    assert.equal(agentStatusLine({ role: 'Team Lead', modelId: 'qwen3-32b' }), 'Team Lead · qwen3-32b')
    assert.equal(agentStatusLine({ role: 'Team Lead', modelId: 'qwen3-32b' }, { typing: true }), 'Team Lead · typing…')
    assert.equal(agentStatusLine({ role: '', modelId: 'm' }), 'm')
    assert.equal(agentStatusLine({ role: '  ', modelId: '' }, { typing: true }), 'typing…')
    assert.equal(agentStatusLine({ role: '', modelId: '' }), '')
    for (const status of ['idle', 'running', 'queued', 'error']) {
      assert.doesNotMatch(agentStatusLine({ role: 'R', modelId: 'm', status }), /online/)
    }
  })
  it('typing only when typingAgentId is this bot', () => {
    assert.equal(isAgentTyping({ typingAgentId: 'p' }, 'p'), true)
    assert.equal(isAgentTyping({ typingAgentId: 'cr' }, 'p'), false)
    assert.equal(isAgentTyping({ typingAgentId: null }, 'p'), false)
    assert.equal(isAgentTyping({}, 'p'), false)
    assert.equal(isAgentTyping(undefined, 'p'), false)
    assert.equal(isAgentTyping({ typingAgentId: 'p' }, undefined), false)
  })
})
