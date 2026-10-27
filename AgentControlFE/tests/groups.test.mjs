import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  GROUP_START_GRACE_MS, IDLE_POLL, MAX_GROUP_BOTS, addableBots, afterCursor, createGroupBody, createGroupError, groupFileCard,
  groupHeaderLine, groupPanelSub, groupTab, insertMention, isLocked, memberRule, membersCount, mentionCandidates, mentionIds,
  mentionMatches, mentionParts, mentionQuery, nextPoll, orderedMembers, pickerInitial, readMuted, seenBy, serverSkipped, skippedMentions, typingAfterSend,
  suggestName, systemLineText, togglePick, typingLabel, withGroupTab, withMembers, withoutMember, writeMuted,
} from '../src/lib/groups.ts'
import { renderMentions } from '../src/lib/mention-render.ts'
import { renderMarkdown } from '../src/lib/markdown-render.ts'
import { countUnread } from '../src/lib/conversations.ts'
import { fileContentPath, filesApi, zoneBadge, zoneOfPath } from '../src/lib/files.ts'
import { memoryApi } from '../src/lib/memory.ts'

const agents = [
  { id: 'p', name: 'Primary', isPrimary: true, role: 'Team Lead' },
  { id: 'r', name: 'Researcher' },
  { id: 's', name: 'Summarizer' },
  { id: 'w', name: 'Web Writer' },
  { id: 'ww', name: 'Web' },
]
const group = { name: 'Harbor team', slug: 'harbor-team', leadAgentId: 'p', memberAgentIds: ['p', 'r', 's'] }
const msg = (o) => ({ id: o.id ?? Math.random().toString(36).slice(2), role: 'assistant', content: '', createdAt: '2026-10-26T01:00:00Z', ...o })

describe('create flow (GAP-G4)', () => {
  it('starts with Primary picked and keeps it locked', () => {
    const start = pickerInitial(agents)
    assert.deepEqual(start, ['p'])
    assert.equal(isLocked('p', agents), true)
    assert.equal(isLocked('r', agents), false)
    assert.deepEqual(togglePick(start, 'p', agents), ['p'], 'unticking the lead does nothing')
    const two = togglePick(start, 'r', agents)
    assert.deepEqual(two, ['p', 'r'])
    assert.deepEqual(togglePick(two, 'r', agents), ['p'])
  })
  it('caps at 8 bots', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ id: `b${i}`, name: `Bot ${i}` }))
    const all = [agents[0], ...many]
    let sel = pickerInitial(all)
    for (const b of many) sel = togglePick(sel, b.id, all)
    assert.equal(sel.length, MAX_GROUP_BOTS)
  })
  it('validates like the BE and sends Primary first', () => {
    assert.equal(createGroupError('Team', ['p'], agents), 'Pick at least one more bot.')
    assert.equal(createGroupError('  ', ['p', 'r'], agents), 'Name the group.')
    assert.match(createGroupError('x'.repeat(61), ['p', 'r'], agents), /under 60/)
    assert.equal(createGroupError('Team', ['r'], agents.slice(1)), 'Create a Team Lead bot before starting a group.')
    assert.equal(createGroupError('Team', ['p', 'r'], agents), null)
    assert.deepEqual(createGroupBody('  Harbor   team ', ['r', 'p', 'r', 'gone'], agents), { name: 'Harbor team', memberAgentIds: ['p', 'r'] })
  })
  it('suggests a name from the picked bots', () => {
    assert.equal(suggestName(['p'], agents), '')
    assert.equal(suggestName(['p', 'r', 's'], agents), 'Researcher & Summarizer')
    assert.equal(suggestName(['p', 'r', 's', 'w'], agents), 'Researcher, Summarizer +1')
  })
})

describe('header and Members (06a, 06b)', () => {
  it('header line, panel subline, rules', () => {
    assert.deepEqual(groupHeaderLine(group, agents), { lead: '★ Led by Primary', members: 'You, Researcher, Summarizer' })
    assert.deepEqual(groupPanelSub(group, agents), { text: 'Group chat · led by Primary · you + 3 bots · shared folder ', folder: 'groups/harbor-team/' })
    assert.equal(memberRule('p', group, agents), 'Answers first, hands tasks out')
    assert.equal(memberRule('r', group, agents), 'When Primary or you @mention it')
    assert.equal(membersCount(group), '3 of 8')
  })
  it('lead lock: the lead is listed first and cannot be removed', () => {
    assert.deepEqual(orderedMembers({ leadAgentId: 'p', memberAgentIds: ['r', 'p', 's'] }), ['p', 'r', 's'])
    assert.equal(withoutMember(group, 'p'), null)
    assert.deepEqual(withoutMember(group, 'r'), ['p', 's'])
    assert.deepEqual(withMembers(group, ['w', 'r']), ['p', 'r', 's', 'w'])
    assert.deepEqual(addableBots(group, agents).map((a) => a.id), ['w', 'ww'])
  })
  it('panel tabs share the bot panel URL keys', () => {
    const p = (s) => new URLSearchParams(s)
    assert.equal(groupTab(p('panel=settings')), 'members')
    assert.equal(groupTab(p('panel=settings&tab=memory')), 'memory')
    assert.equal(groupTab(p('panel=files&path=shared')), 'files')
    assert.equal(groupTab(p('panel=settings&tab=profile')), 'members')
    assert.equal(withGroupTab(p('panel=files&path=shared/x'), 'settings').toString(), 'panel=settings&tab=settings')
    assert.equal(withGroupTab(p('panel=settings&tab=memory'), 'members').toString(), 'panel=settings')
  })
  it('mute is stored locally and survives junk', () => {
    const store = new Map()
    const s = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }
    assert.deepEqual([...readMuted(s)], [])
    writeMuted(s, new Set(['g1']))
    assert.deepEqual([...readMuted(s)], ['g1'])
    store.set('agentcontrol.groups.muted', '{bad')
    assert.deepEqual([...readMuted(s)], [])
    assert.deepEqual([...readMuted(null)], [])
  })
})

describe('mentions', () => {
  const cands = mentionCandidates({ ...group, memberAgentIds: ['p', 'r', 's', 'w', 'ww'] }, agents)
  it('candidates exclude the lead', () => {
    assert.deepEqual(cands.map((c) => c.id), ['r', 's', 'w', 'ww'])
  })
  it('matches the longest name at a word boundary, case-insensitive', () => {
    assert.deepEqual(mentionParts('ask @web writer and @Web, not @Webby or @Primary', cands), [
      { text: 'ask ' },
      { text: '@web writer', mention: 'w' },
      { text: ' and ' },
      { text: '@Web', mention: 'ww' },
      { text: ', not @Webby or @Primary' },
    ])
    assert.deepEqual(mentionIds('@Summarizer then @researcher then @Summarizer', cands), ['s', 'r'])
    assert.deepEqual(mentionParts('mail me@Researcher.com', cands).length, 3, 'BE treats it as a mention too')
  })
  it('autocomplete query, matches and insert', () => {
    assert.deepEqual(mentionQuery('hi @Res', 7), { start: 3, query: 'Res' })
    assert.deepEqual(mentionQuery('hi @', 4), { start: 3, query: '' })
    assert.equal(mentionQuery('a@b', 3), null)
    assert.equal(mentionQuery('hi @ x', 6), null)
    assert.deepEqual(mentionMatches('we', cands).map((c) => c.id), ['w', 'ww'])
    assert.deepEqual(mentionMatches('iter', cands).map((c) => c.id), ['w'])
    assert.deepEqual(insertMention('hi @Res there', 3, 7, 'Researcher'), { draft: 'hi @Researcher there', caret: 15 })
  })
  it('renders span.cf-mention (and leaves plain text alone)', () => {
    const html = renderToStaticMarkup(h('p', null, renderMentions('ask @Researcher now', cands)))
    assert.equal(html, '<p>ask <span class="cf-mention" data-agent="r">@Researcher</span> now</p>')
    assert.equal(renderMentions('no tags', cands), 'no tags')
  })
  it('Markdown passes text through the renderer, not code', () => {
    const md = renderMarkdown('**@Summarizer** and `@Summarizer`', (t, k) => renderMentions(t, cands, k))
    const html = renderToStaticMarkup(h('div', null, md))
    assert.match(html, /<strong><span class="cf-mention" data-agent="s">@Summarizer<\/span><\/strong>/)
    assert.match(html, /<code class="cf-md__code">@Summarizer<\/code>/)
  })
})

describe('poll start/stop (gaps of 20 s+ between replies)', () => {
  const t0 = 1_000_000
  it('keeps polling through the start grace, then gives up if nobody typed', () => {
    const s = { sentAt: t0, sawTyping: false }
    assert.equal(nextPoll(s, { typingAgentId: null }, t0 + 1500).poll, true)
    assert.equal(nextPoll(s, { typingAgentId: null }, t0 + GROUP_START_GRACE_MS + 1).poll, false)
  })
  it('never times out while someone types, and stops once typing clears', () => {
    let s = { sentAt: t0, sawTyping: false }
    let r = nextPoll(s, { typingAgentId: 'p' }, t0 + 1500)
    assert.equal(r.poll, true)
    s = r.state
    for (const t of [30_000, 60_000, 120_000]) {
      r = nextPoll(s, { typingAgentId: 'r' }, t0 + t)
      assert.equal(r.poll, true)
      s = r.state
    }
    r = nextPoll(s, { typingAgentId: null }, t0 + 121_500)
    assert.deepEqual(r, { state: IDLE_POLL, poll: false })
  })
  it('a poll started from the sidebar typing signal stops when typing clears', () => {
    const r = nextPoll({ sentAt: null, sawTyping: true }, { typingAgentId: null }, t0)
    assert.equal(r.poll, false)
    assert.equal(nextPoll(IDLE_POLL, { typingAgentId: null }, t0).poll, false)
  })
  it('typing label shows elapsed seconds past 10 s', () => {
    assert.equal(typingLabel('Researcher', t0, t0 + 4000), 'Researcher is typing…')
    assert.equal(typingLabel('Researcher', t0, t0 + 25_400), 'Researcher is typing… · 25s')
    assert.equal(typingLabel('Researcher', null, t0), 'Researcher is typing…')
  })
  it('BE-5 d5e5a99: the 202 typingAgentId shows the lead typing right away', () => {
    assert.equal(typingAfterSend({ typingAgentId: 'p' }), 'p')
    assert.equal(typingAfterSend({ typingAgentId: null }), null)
    assert.equal(typingAfterSend({ typingAgentId: '' }), null)
    assert.equal(typingAfterSend({}), null)
    assert.equal(typingAfterSend(undefined), null)
    // With typing from the 202 the poll counts it as seen, so it stops when typing clears.
    const t0 = 1_000_000
    const s = { sentAt: t0, sawTyping: Boolean(typingAfterSend({ typingAgentId: 'p' })) }
    assert.equal(nextPoll(s, { typingAgentId: null }, t0 + 1500).poll, false)
  })
  it('afterCursor is the newest id', () => {
    assert.equal(afterCursor([{ id: 'a' }, { id: 'b' }]), 'b')
    assert.equal(afterCursor([]), undefined)
  })
})

describe('turns: Seen by, the 4-reply cap, system lines', () => {
  const user = msg({ id: 'u', role: 'user', content: 'Ask @Researcher and @Summarizer and @Web Writer and @Web', createdAt: '2026-10-26T01:24:00Z' })
  const cands = [...agents]
  const g = { ...group, memberAgentIds: ['p', 'r', 's', 'w', 'ww'] }
  it('Seen by counts distinct repliers, then the typer', () => {
    assert.equal(seenBy([user]), null)
    assert.deepEqual(seenBy([user], 'p', '2026-10-26T01:24:05Z'), { ids: ['p'], at: '2026-10-26T01:24:05Z' })
    const lead = msg({ id: 'l', authorAgentId: 'p', createdAt: '2026-10-26T01:24:30Z' })
    assert.deepEqual(seenBy([user, lead], 'r'), { ids: ['p', 'r'], at: '2026-10-26T01:24:30Z' })
  })
  it('reports mentions past the cap (user-only mentions: room 3)', () => {
    const lead = msg({ authorAgentId: 'p', content: 'On it.' })
    assert.deepEqual(skippedMentions([user, lead], g, cands), ['ww'])
  })
  it('lead mentions use a wrap-up slot (room 2) and are merged, deduped', () => {
    const lead = msg({ authorAgentId: 'p', content: '@Researcher go' })
    assert.deepEqual(skippedMentions([user, lead], g, cands), ['w', 'ww'])
    const errLead = msg({ authorAgentId: 'p', content: '@Researcher go', error: true })
    assert.deepEqual(skippedMentions([user, errLead], g, cands), ['ww'])
  })
  it('BE-5 d5e5a99: the lead reply\'s skippedAgentIds wins over the FE calculation', () => {
    // The FE alone would say ['ww']; the server's list is used as given, in its order.
    const lead = msg({ authorAgentId: 'p', content: 'On it.', skippedAgentIds: ['w', 'ww'] })
    assert.deepEqual(skippedMentions([user, lead], g, cands), ['w', 'ww'])
    const one = msg({ authorAgentId: 'p', content: '@Researcher go', skippedAgentIds: ['ww'] })
    assert.deepEqual(skippedMentions([user, one], g, cands), ['ww'])
  })
  it('skippedAgentIds: an empty list means nobody was skipped; missing falls back to the calculation', () => {
    assert.deepEqual(skippedMentions([user, msg({ authorAgentId: 'p', content: 'On it.', skippedAgentIds: [] })], g, cands), [])
    assert.deepEqual(skippedMentions([user, msg({ authorAgentId: 'p', content: 'On it.' })], g, cands), ['ww'])
    const quiet = msg({ id: 'q', role: 'user', content: 'Hello team' })
    assert.deepEqual(skippedMentions([quiet, msg({ authorAgentId: 'p', content: 'Hi' })], g, cands), [])
  })
  it('serverSkipped keeps strings once, and is null when the field is absent or malformed', () => {
    assert.equal(serverSkipped({}), null)
    assert.equal(serverSkipped({ skippedAgentIds: 'w' }), null)
    assert.deepEqual(serverSkipped({ skippedAgentIds: ['w', 3, '', 'w', 'ww'] }), ['w', 'ww'])
  })
  it('only the lead reply\'s field counts (a member reply carrying one is ignored)', () => {
    const lead = msg({ id: 'l2', authorAgentId: 'p', content: 'On it.', createdAt: '2026-10-26T01:24:10Z' })
    const member = msg({ id: 'm2', authorAgentId: 'r', content: 'Done', skippedAgentIds: ['s'], createdAt: '2026-10-26T01:24:20Z' })
    assert.deepEqual(skippedMentions([user, lead, member], g, cands), ['ww'])
  })
  it('system line takes the day label', () => {
    assert.equal(systemLineText('You created “Harbor team” and added Primary, Researcher and Summarizer.', 'Today', '8:20 PM'), 'Today · You created “Harbor team” and added Primary, Researcher and Summarizer · 8:20 PM')
    assert.equal(systemLineText('You added Web.', null, '9:00 PM'), 'You added Web · 9:00 PM')
  })
  it('system lines never count as unread', () => {
    const ms = [msg({ kind: 'system', createdAt: '2026-10-26T02:00:00Z' }), msg({ createdAt: '2026-10-26T02:00:01Z' })]
    assert.equal(countUnread(ms, '2026-10-26T01:00:00Z'), 1)
  })
})

describe('group files and memory owners', () => {
  it('file cards: root group (BE 3a70c34) vs the author’s folder; no "group:" prefix', () => {
    assert.deepEqual(groupFileCard({ path: 'shared/pier.md', root: 'group', groupId: 'g1', groupName: 'Pier' }, 'Researcher', '3 KB', undefined, 'g1'), { inGroup: true, path: 'shared/pier.md', groupId: 'g1', meta: 'Group folder · added by Researcher · 3 KB' })
    assert.deepEqual(groupFileCard({ path: 'shared/pier.md', root: 'group' }, 'Researcher', '3 KB', undefined, 'g1'), { inGroup: true, path: 'shared/pier.md', groupId: 'g1', meta: 'Group folder · added by Researcher · 3 KB' })
    assert.deepEqual(groupFileCard({ path: 'workspace/out.csv' }, 'Researcher', null), { inGroup: false, path: 'workspace/out.csv', meta: "Researcher's folder · workspace" })
    assert.deepEqual(groupFileCard({ path: 'workspace/out.csv', root: 'agent' }, 'Researcher', null), { inGroup: false, path: 'workspace/out.csv', meta: "Researcher's folder · workspace" })
    // a path that happens to start with "group:" is just a path now
    assert.deepEqual(groupFileCard({ path: 'group:shared/pier.md' }, 'Researcher', null).inGroup, false)
  })
  it('file cards: a file in another group names that group and opens there', () => {
    const c = groupFileCard({ path: 'shared/q3.md', root: 'group', groupId: 'g2', groupName: 'Q3 report' }, 'Researcher', '1 KB', 'added', 'g1')
    assert.deepEqual(c, { inGroup: true, path: 'shared/q3.md', groupId: 'g2', meta: 'Q3 report folder · added by Researcher · 1 KB' })
  })
  it("file cards: a Phase 2 'deleted' file says so instead of 'added by'", () => {
    assert.deepEqual(groupFileCard({ path: 'shared/pier.md', root: 'group', groupId: 'g1' }, 'Researcher', '3 KB', 'deleted', 'g1'), { inGroup: true, path: 'shared/pier.md', groupId: 'g1', meta: 'Group folder · deleted by Researcher' })
    assert.deepEqual(groupFileCard({ path: 'workspace/out.csv' }, 'Researcher', '1 KB', 'deleted'), { inGroup: false, path: 'workspace/out.csv', meta: "Researcher's folder · workspace · deleted" })
    assert.equal(groupFileCard({ path: 'workspace/out.csv' }, 'Researcher', '1 KB', 'modified').meta, "Researcher's folder · workspace · 1 KB")
  })
  it('routes to /api/groups/:id', async () => {
    const calls = []
    const req = async (path, init) => (calls.push([path, init?.method ?? 'GET']), { entries: [], items: [], total: 0 })
    await filesApi(req, async () => ({ ok: true, status: 200, body: {} }), () => null).list({ groupId: 'g 1' }, 'shared')
    await filesApi(req, async () => ({ ok: true, status: 200, body: {} }), () => null).list('bot', '')
    await memoryApi(req).list({ groupId: 'g1' })
    assert.equal(calls[0][0], '/api/groups/g%201/files?path=shared')
    assert.equal(calls[1][0], '/api/agents/bot/files?path=')
    assert.match(calls[2][0], /^\/api\/groups\/g1\/memory/)
    assert.equal(fileContentPath({ groupId: 'g1' }, 'shared/a.md'), '/api/groups/g1/files/content?path=shared%2Fa.md')
  })
  it('GROUP.md is managed meta; shared/ is where scripts write', () => {
    assert.equal(zoneOfPath('GROUP.md'), 'meta')
    assert.deepEqual(zoneBadge({ path: 'shared' }, true), { label: 'scripts write', tone: 'green' })
    assert.deepEqual(zoneBadge({ path: 'GROUP.md' }, true), { label: 'managed', tone: 'neutral' })
    assert.equal(zoneBadge({ path: 'workspace' }, true), null)
  })
})
