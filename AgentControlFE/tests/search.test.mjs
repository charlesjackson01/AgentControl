import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  fetchSearch, fileTarget, highlight, moveActive, normalizeResults, paletteOrder, paletteSections, searchPath, shouldSearch,
} from '../src/lib/search.ts'

const agents = [
  { id: 'p', name: 'Primary', isPrimary: true, role: 'Team Lead' },
  { id: 'r', name: 'Researcher', isPrimary: false, role: 'Deep research' },
  { id: 's', name: 'Summarizer', isPrimary: false, role: '' },
  { id: 'h', name: 'Hidden Helper', isPrimary: false, hidden: true },
]
const base = { createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', lastReadAt: null, lastMessage: null, unreadCount: 0 }
const conversations = [
  { ...base, id: 'cp', kind: 'dm', agentId: 'p' },
  { ...base, id: 'cr', kind: 'dm', agentId: 'r' },
  { ...base, id: 'cs', kind: 'dm', agentId: 's' },
  { ...base, id: 'ch', kind: 'dm', agentId: 'h' },
  { ...base, id: 'g1', kind: 'group', name: 'Harbor team', memberAgentIds: ['p', 'r', 's'], leadAgentId: 'p' },
]
const now = new Date('2026-10-19T22:00:00')
const ctx = { conversationId: 'cp', isGroup: false }
const results = {
  agents: [],
  groups: [],
  messages: [
    { conversationId: 'g1', messageId: 'm1', snippet: 'The 2019 proposal put the pier at 240 ft…', authorAgentId: 'r', createdAt: '2026-10-19T20:29:00' },
    { conversationId: 'cp', messageId: 'm2', snippet: 'The plan gives the pier as 240 m', authorAgentId: 'p', createdAt: '2026-10-19T21:12:00' },
  ],
  files: [
    { root: 'agent', ownerId: 'p', path: 'shared/lindmere-pier-sketch.png', name: 'lindmere-pier-sketch.png', modifiedAt: '2026-10-19T20:00:00Z' },
    { root: 'group', ownerId: 'g1', path: 'pier-2019-excerpt.md', name: 'pier-2019-excerpt.md', modifiedAt: '2026-10-19T20:00:00Z' },
    { root: 'agent', ownerId: 'gone', path: 'x.md', name: 'x.md', modifiedAt: '2026-10-19T20:00:00Z' },
  ],
}
const sections = (q, remote) => paletteSections(q, { conversations, agents, remote, ctx, now })

describe('palette: server search', () => {
  it('searches any non-empty text (BE-10 answers 1 char); not command mode', () => {
    assert.equal(shouldSearch('p'), true)
    assert.equal(shouldSearch('  '), false)
    assert.equal(shouldSearch(' pi '), true)
    assert.equal(shouldSearch('/new'), false)
    assert.equal(searchPath(' pier '), '/api/search?q=pier&limit=20')
  })
  it('404/405/501 mean no search route (pre BE-10); other errors are failures', async () => {
    const fail = (status) => async () => { throw Object.assign(new Error('nope'), { status }) }
    assert.deepEqual(await fetchSearch('pier', fail(404)), { status: 'unavailable' })
    assert.deepEqual(await fetchSearch('pier', fail(501)), { status: 'unavailable' })
    assert.deepEqual(await fetchSearch('pier', fail(500)), { status: 'error', query: 'pier', message: 'nope' })
  })
  it('ok results are normalized; it calls the BE-10 path', async () => {
    let asked
    const r = await fetchSearch('pier', async (path) => { asked = path; return { messages: results.messages } })
    assert.equal(asked, '/api/search?q=pier&limit=20')
    assert.equal(r.status, 'ok')
    assert.deepEqual(r.results.files, [])
    assert.equal(r.results.messages.length, 2)
    assert.deepEqual(normalizeResults(null), { agents: [], groups: [], messages: [], files: [] })
  })
})

describe('palette: sections (02b)', () => {
  it('Messages, Files, Bots & groups, Commands in that order', () => {
    const s = sections('pier', { status: 'ok', query: 'pier', results })
    assert.deepEqual(paletteOrder(s).map((i) => i.type), ['message', 'message', 'file', 'file', 'file'])
    const [m1, m2] = s.messages
    assert.equal(m1.authorName, 'Researcher')
    assert.equal(m1.chatTitle, 'Harbor team')
    assert.equal(m1.to, '/c/g1?m=m1')
    assert.deepEqual(m1.memberAgentIds, ['p', 'r', 's'])
    assert.equal(m2.authorName, null, 'a DM message needs no author prefix')
    assert.equal(m2.chatTitle, 'Primary')
    assert.equal(s.files[0].ownerTitle, "Primary's files")
    assert.equal(s.files[0].image, true)
    assert.equal(s.files[1].ownerTitle, "Harbor team's shared folder")
    assert.equal(s.files[1].to, '/c/g1?panel=files&path=pier-2019-excerpt.md')
    assert.equal(s.files[2].to, null, 'unknown owner has nowhere to open')
  })
  it('stale server results are not shown for a newer query; shows loading instead', () => {
    const s = sections('pie', { status: 'ok', query: 'pier', results })
    assert.equal(s.messages.length, 0)
    assert.equal(s.remoteLoading, true)
  })
  it('without BE-10 bots, groups and commands still match locally', () => {
    const s = sections('re', { status: 'unavailable' })
    assert.equal(s.remoteUnavailable, true)
    assert.equal(s.remoteLoading, false)
    assert.deepEqual(s.chats.map((i) => i.title), ['Researcher'])
    assert.deepEqual(s.commands.map((i) => i.command.name), [])
    const h = sections('har', { status: 'unavailable' })
    assert.deepEqual(h.chats.map((i) => [i.title, i.to, i.subtitle]), [['Harbor team', '/c/g1', 'Group · 3 bots']])
  })
  it('finds hidden bots too (the palette searches everything)', () => {
    assert.deepEqual(sections('helper', { status: 'unavailable' }).chats.map((i) => i.title), ['Hidden Helper'])
  })
  it('empty query: recent chats and every command', () => {
    const s = sections('', { status: 'idle' })
    assert.equal(s.chats[0].title, 'Primary')
    assert.equal(s.commands.length, 7)
    assert.equal(s.remoteLoading, false)
  })
  it('"/" is command mode: only commands, with live/disabled state for this chat', () => {
    const s = sections('/s', { status: 'ok', query: '/s', results })
    assert.deepEqual(paletteOrder(s).map((i) => i.type), ['command', 'command', 'command', 'command'])
    const byName = Object.fromEntries(s.commands.map((i) => [i.command.name, i.reason]))
    assert.equal(byName.settings, null)
    assert.equal(byName.skills, null, 'FE-3: /skills runs in a DM')
    assert.equal(byName.files, null, 'FE-4: /files runs in a DM')
    assert.equal(byName.vm, null, 'FE-P2-5: /vm runs in a DM')
  })
  it('a server error for this query is surfaced', () => {
    const s = sections('pier', { status: 'error', query: 'pier', message: 'boom' })
    assert.equal(s.remoteError, 'boom')
    assert.equal(s.remoteLoading, false)
  })
})

describe('palette: keyboard + highlight', () => {
  it('moveActive wraps both ways', () => {
    assert.equal(moveActive(0, 1, 3), 1)
    assert.equal(moveActive(2, 1, 3), 0)
    assert.equal(moveActive(0, -1, 3), 2)
    assert.equal(moveActive(9, -1, 3), 1, 'clamps a stale index first')
    assert.equal(moveActive(0, 1, 0), -1)
  })
  it('highlight marks every case-insensitive match', () => {
    assert.deepEqual(highlight('Pier and pier', 'pier'), [
      { text: 'Pier', match: true }, { text: ' and ', match: false }, { text: 'pier', match: true },
    ])
    assert.deepEqual(highlight('abc', ''), [{ text: 'abc', match: false }])
    assert.deepEqual(highlight('abc', 'z'), [{ text: 'abc', match: false }])
  })
  it('fileTarget: agent files open in that bot DM', () => {
    assert.equal(fileTarget(results.files[0], conversations), '/c/cp?panel=files&path=shared%2Flindmere-pier-sketch.png')
  })
})
