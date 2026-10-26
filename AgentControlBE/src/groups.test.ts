import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from './app.js'
import { groupIdle } from './groups.js'
import type { Agent, AgentRun, ChatMessage, ConversationSummary, Endpoint, FileEntry, FileListing } from './shared/types.js'
import { createStore, type WorkspaceStore } from './store.js'

let dir = ''
let app: FastifyInstance
let store: WorkspaceStore
let endpointId = ''

const inject = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as object | undefined, headers: { 'content-type': 'application/json' } })
const upload = (url: string, body: string) =>
  app.inject({ method: 'PUT', url, payload: body, headers: { 'content-type': 'application/octet-stream' } })

async function makeBot(name: string, role = ''): Promise<Agent> {
  const res = await inject('POST', '/api/agents', { name, role, description: '', instructions: '', modelId: 'test-model', endpointId, skillIds: [] })
  expect(res.statusCode).toBe(201)
  return res.json() as Agent
}

const ok = (content: string) => ({ ok: true, status: 200, json: async () => ({ choices: [{ index: 0, message: { role: 'assistant', content } }] }), text: async () => '' })
const toolCall = (name: string, args: unknown) => ({ ok: true, status: 200, json: async () => ({ choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }), text: async () => '' })
const err = (status: number, body: string) => ({ ok: false, status, json: async () => ({}), text: async () => body })

/** Upstream mock: each bot (named by "You are <name>," in the prompt) answers from its own queue. */
function bots(scripts: Record<string, unknown[]>) {
  const prompts: Record<string, string[]> = {}
  const mock = vi.fn(async (_url: unknown, init: { body?: string }) => {
    const body = JSON.parse(init.body ?? '{}') as { messages: { role: string; content: string }[] }
    const last = [...body.messages].reverse().find((m) => m.role === 'user')?.content ?? ''
    const name = /You are (.+?), in the group chat/.exec(last)?.[1] ?? '?'
    ;(prompts[name] ??= []).push(last)
    return scripts[name]?.shift() ?? ok(`${name} done`)
  })
  vi.stubGlobal('fetch', mock)
  return { mock, prompts }
}

let primary: Agent
let researcher: Agent
let summarizer: Agent

async function makeGroup(name = 'Harbor team', members = [researcher.id, summarizer.id]): Promise<ConversationSummary> {
  const res = await inject('POST', '/api/groups', { name, memberAgentIds: members })
  expect(res.statusCode).toBe(201)
  return res.json() as ConversationSummary
}
const groupOf = (c: ConversationSummary) => c as ConversationSummary & { kind: 'group'; slug: string; memberAgentIds: string[]; leadAgentId: string }

async function send(id: string, content: string): Promise<{ status: number; body: { conversation: ConversationSummary; messages: ChatMessage[] } }> {
  const res = await inject('POST', `/api/conversations/${id}/messages`, { content })
  const out = { status: res.statusCode, body: res.json() as { conversation: ConversationSummary; messages: ChatMessage[] } }
  await groupIdle(id)
  return out
}
const groupMessages = (id: string) => store.chatMessages.filter((m) => m.conversationId === id).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
const replies = (id: string) => groupMessages(id).filter((m) => m.role === 'assistant' && m.kind !== 'system')

beforeEach(async () => {
  process.env.AGENTCONTROL_SECRET = 'test-secret'
  dir = mkdtempSync(join(tmpdir(), 'agentcontrol-groups-'))
  store = createStore(join(dir, 'store.json'))
  app = buildApp(store)
  const ep = await inject('POST', '/api/endpoints', { kind: 'openai-compatible', name: 'E', baseUrl: 'http://127.0.0.1:9', defaultModel: 'test-model', contextWindow: 32768 })
  endpointId = (ep.json() as Endpoint).id
  primary = await makeBot('Primary', 'Team Lead')
  researcher = await makeBot('Researcher', 'Deep research')
  summarizer = await makeBot('Summarizer', 'Condenses long text')
  expect(primary.isPrimary).toBe(true)
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  await app.close()
  rmSync(dir, { recursive: true, force: true })
  delete process.env.AGENTCONTROL_SECRET
})

describe('groups: CRUD', () => {
  it('creates a group led by Primary, with its folder and a system line', async () => {
    const g = groupOf(await makeGroup())
    expect(g).toMatchObject({ kind: 'group', name: 'Harbor team', slug: 'harbor-team', leadAgentId: primary.id, memoryLearn: true, typingAgentId: null, unreadCount: 0 })
    expect(g.memberAgentIds).toEqual([primary.id, researcher.id, summarizer.id])
    expect(g).not.toHaveProperty('archivedAt')
    const root = join(dir, 'groups', 'harbor-team')
    expect(existsSync(join(root, 'shared'))).toBe(true)
    expect(readFileSync(join(root, 'memory', 'MEMORY.md'), 'utf8')).toContain('What Harbor team remembers')
    expect(readFileSync(join(root, 'GROUP.md'), 'utf8')).toContain('- Primary (leads the group): Team Lead')
    expect(g.lastMessage).toMatchObject({ kind: 'system', content: 'You created "Harbor team" and added Primary, Researcher and Summarizer.' })
    expect((await inject('GET', `/api/groups/${g.id}`)).json()).toMatchObject({ id: g.id, kind: 'group' })
    const list = (await inject('GET', '/api/conversations')).json() as ConversationSummary[]
    expect(list.filter((c) => c.kind === 'group').map((c) => c.id)).toEqual([g.id])
    expect(list.filter((c) => c.kind === 'dm')).toHaveLength(3)
  })

  it('adds Primary automatically, gives a second group with the same name its own folder', async () => {
    const a = groupOf(await makeGroup('Crew', [researcher.id]))
    const b = groupOf(await makeGroup('Crew', [summarizer.id, summarizer.id]))
    expect(a.memberAgentIds).toEqual([primary.id, researcher.id])
    expect(b.memberAgentIds).toEqual([primary.id, summarizer.id])
    expect([a.slug, b.slug]).toEqual(['crew', 'crew-2'])
  })

  it('rejects bad names, unknown bots and the wrong number of members', async () => {
    expect((await inject('POST', '/api/groups', { name: '', memberAgentIds: [researcher.id] })).statusCode).toBe(400)
    expect((await inject('POST', '/api/groups', { name: 'x'.repeat(61), memberAgentIds: [researcher.id] })).statusCode).toBe(400)
    expect((await inject('POST', '/api/groups', { name: 'Solo', memberAgentIds: [] })).statusCode).toBe(400)
    expect((await inject('POST', '/api/groups', { name: 'Solo', memberAgentIds: [primary.id] })).statusCode).toBe(400)
    expect((await inject('POST', '/api/groups', { name: 'Ghost', memberAgentIds: ['agt_nope'] })).statusCode).toBe(400)
    const many: string[] = []
    for (let i = 0; i < 8; i += 1) many.push((await makeBot(`Bot ${i}`)).id)
    const res = await inject('POST', '/api/groups', { name: 'Big', memberAgentIds: many })
    expect(res.statusCode).toBe(400)
    expect(res.json().message).toContain('at most 8')
    expect((await inject('POST', '/api/groups', { name: 'Full', memberAgentIds: many.slice(0, 7) })).statusCode).toBe(201)
  })

  it('PATCH renames, changes members with system lines, and never drops Primary', async () => {
    const g = await makeGroup()
    const res = await inject('PATCH', `/api/groups/${g.id}`, { name: 'Pier crew', memberAgentIds: [primary.id, researcher.id], memoryLearn: false })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ name: 'Pier crew', memberAgentIds: [primary.id, researcher.id], memoryLearn: false })
    expect(groupMessages(g.id).filter((m) => m.kind === 'system').map((m) => m.content).slice(1)).toEqual(['You renamed the group "Pier crew".', 'You removed Summarizer.'])
    await inject('PATCH', `/api/groups/${g.id}`, { memberAgentIds: [primary.id, researcher.id, summarizer.id] })
    expect(groupMessages(g.id).at(-1)?.content).toBe('You added Summarizer.')
    const drop = await inject('PATCH', `/api/groups/${g.id}`, { memberAgentIds: [researcher.id, summarizer.id] })
    expect(drop.statusCode).toBe(400)
    expect(drop.json().message).toContain("can't be removed")
    // System lines never count as unread.
    expect(((await inject('GET', `/api/groups/${g.id}`)).json() as ConversationSummary).unreadCount).toBe(0)
  })

  it('DELETE archives the conversation and moves the folder (with who-added records) to data/archive/groups/', async () => {
    const g = groupOf(await makeGroup())
    await upload(`/api/groups/${g.id}/files/content?path=shared/a.md`, 'a')
    expect((await inject('DELETE', `/api/groups/${g.id}`)).statusCode).toBe(204)
    expect(existsSync(join(dir, 'groups', 'harbor-team'))).toBe(false)
    expect(existsSync(join(dir, 'groups', 'harbor-team.added-by.json'))).toBe(false)
    const [archived] = readdirSync(join(dir, 'archive', 'groups'))
    expect(archived).toMatch(/^harbor-team-/)
    expect(readFileSync(join(dir, 'archive', 'groups', archived!, 'shared', 'a.md'), 'utf8')).toBe('a')
    expect(existsSync(join(dir, 'archive', 'groups', archived!, '.added-by.json'))).toBe(true)
    expect((await inject('GET', `/api/groups/${g.id}`)).statusCode).toBe(404)
    expect((await inject('GET', `/api/conversations/${g.id}/messages`)).statusCode).toBe(404)
    expect(((await inject('GET', '/api/conversations')).json() as ConversationSummary[]).some((c) => c.id === g.id)).toBe(false)
    // Kept in the store, and the name is free again.
    expect(store.conversations.some((c) => c.id === g.id)).toBe(true)
    expect(groupOf(await makeGroup()).slug).toBe('harbor-team')
  })

  it('keeps groups across a restart', async () => {
    const g = await makeGroup()
    const again = createStore(join(dir, 'store.json'))
    const loaded = again.conversations.find((c) => c.id === g.id)
    expect(loaded).toMatchObject({ kind: 'group', slug: 'harbor-team', leadAgentId: primary.id, memberAgentIds: [primary.id, researcher.id, summarizer.id] })
    expect(again.chatMessages.filter((m) => m.conversationId === g.id)).toHaveLength(1)
  })
})

describe('groups: the lead invariant', () => {
  it('moves the lead to the new Primary, who joins the group', async () => {
    const g = await makeGroup('Crew', [researcher.id])
    const res = await inject('PUT', `/api/agents/${summarizer.id}`, { ...summarizer, isPrimary: true })
    expect(res.statusCode).toBe(200)
    const after = groupOf((await inject('GET', `/api/groups/${g.id}`)).json() as ConversationSummary)
    expect(after.leadAgentId).toBe(summarizer.id)
    expect(after.memberAgentIds).toEqual([summarizer.id, primary.id, researcher.id])
  })

  it('a deleted bot leaves its groups', async () => {
    const g = await makeGroup()
    expect((await inject('DELETE', `/api/agents/${researcher.id}`)).statusCode).toBe(204)
    const after = groupOf((await inject('GET', `/api/groups/${g.id}`)).json() as ConversationSummary)
    expect(after.memberAgentIds).toEqual([primary.id, summarizer.id])
    expect(groupMessages(g.id).at(-1)?.content).toBe('Researcher was deleted and left the group.')
  })
})

describe('groups: sending and replies', () => {
  it('answers 202 with the user message, then the lead delegates and wraps up (06a)', async () => {
    const { prompts } = bots({
      Primary: [ok("I'll split this: @Researcher find the 2019 pier figures, then @Summarizer turn them into 3 bullets."), ok("That's everything.")],
      Researcher: [ok('The 2019 proposal put the pier at 240 ft.')],
      Summarizer: [ok('- The pier grows')],
    })
    const g = await makeGroup()
    const sent = await send(g.id, 'What did the 2019 proposal say about the pier?')
    expect(sent.status).toBe(202)
    expect(sent.body.conversation.typingAgentId).toBe(primary.id)
    expect(sent.body.messages).toHaveLength(1)
    expect(sent.body.messages[0]).toMatchObject({ role: 'user', content: 'What did the 2019 proposal say about the pier?' })
    expect(sent.body.conversation.id).toBe(g.id)
    const out = replies(g.id)
    expect(out.map((m) => m.authorAgentId)).toEqual([primary.id, researcher.id, summarizer.id, primary.id])
    expect(out.some((m) => m.skippedAgentIds)).toBe(false)
    expect(out.map((m) => m.content)).toEqual([
      "I'll split this: @Researcher find the 2019 pier figures, then @Summarizer turn them into 3 bullets.",
      'The 2019 proposal put the pier at 240 ft.', '- The pier grows', "That's everything.",
    ])
    // The lead's prompt lists the members and their roles; members see the transcript so far.
    expect(prompts.Primary![0]).toContain('- Researcher: Deep research')
    expect(prompts.Primary![0]).toContain('You lead this group')
    expect(prompts.Summarizer![0]).toContain('Researcher: The 2019 proposal put the pier at 240 ft.')
    // Runs are group runs: never in a DM, never in the bot's own run list.
    for (const m of out) expect(store.runs.find((r) => r.id === m.runId)?.groupId).toBe(g.id)
    expect(store.chatMessages.some((m) => m.conversationId !== g.id && out.some((o) => o.runId === m.runId))).toBe(false)
    expect((await inject('GET', `/api/agents/${researcher.id}/runs`)).json()).toEqual([])
    const summary = (await inject('GET', `/api/groups/${g.id}`)).json() as ConversationSummary
    expect(summary).toMatchObject({ typingAgentId: null, unreadCount: 4 })
  })

  it('accepts the text alias, and a lead that answers alone gets one reply', async () => {
    bots({ Primary: [ok('Done.')] })
    const g = await makeGroup()
    const res = await inject('POST', `/api/conversations/${g.id}/messages`, { text: 'hi' })
    expect(res.statusCode).toBe(202)
    await groupIdle(g.id)
    expect(replies(g.id).map((m) => m.content)).toEqual(['Done.'])
  })

  it('sets typingAgentId while a bot is writing', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const seen: (string | null)[] = []
    vi.stubGlobal('fetch', vi.fn(async () => { await gate; return ok('ok') }))
    const g = await makeGroup()
    await inject('POST', `/api/conversations/${g.id}/messages`, { content: 'hi' })
    await vi.waitFor(async () => {
      seen.push(((await inject('GET', `/api/groups/${g.id}`)).json() as ConversationSummary).typingAgentId)
      expect(seen.at(-1)).toBe(primary.id)
    })
    release()
    await groupIdle(g.id)
    expect(((await inject('GET', `/api/groups/${g.id}`)).json() as ConversationSummary).typingAgentId).toBeNull()
  })

  it('follows @mentions from the user too, deduped, without the lead wrap-up', async () => {
    bots({ Primary: [ok('Sure.')] })
    const g = await makeGroup()
    await send(g.id, '@Researcher and @Summarizer, and @Researcher again')
    expect(replies(g.id).map((m) => m.authorAgentId)).toEqual([primary.id, researcher.id, summarizer.id])
  })

  it('caps a turn at 4 bot replies, lead included, and goes one hop only', async () => {
    const extra = [await makeBot('Ana'), await makeBot('Ben'), await makeBot('Cy')]
    bots({
      Primary: [ok('@Researcher @Summarizer @Ana @Ben @Cy go'), ok('wrap')],
      Researcher: [ok('@Cy you take it')],
    })
    const g = await makeGroup('Big', [researcher.id, summarizer.id, ...extra.map((a) => a.id)])
    await send(g.id, 'go')
    const out = replies(g.id)
    expect(out.map((m) => m.authorAgentId)).toEqual([primary.id, researcher.id, summarizer.id, primary.id])
    // The lead's reply names who the cap left out, in mention order; it survives a restart.
    expect(out[0]!.skippedAgentIds).toEqual(extra.map((a) => a.id))
    expect(out.slice(1).some((m) => m.skippedAgentIds)).toBe(false)
    const again = createStore(join(dir, 'store.json'))
    expect(again.chatMessages.find((m) => m.id === out[0]!.id)?.skippedAgentIds).toEqual(extra.map((a) => a.id))
  })

  it('a failed reply becomes an error message and the queue goes on', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    bots({
      Primary: [ok('@Researcher then @Summarizer'), ok('wrap')],
      Researcher: [err(500, 'boom')],
      Summarizer: [ok('bullets')],
    })
    const g = await makeGroup()
    await send(g.id, 'go')
    const out = replies(g.id)
    expect(out.map((m) => [m.authorAgentId, m.error ?? false])).toEqual([
      [primary.id, false], [researcher.id, true], [summarizer.id, false], [primary.id, false],
    ])
    expect(out[1]!.content).toContain('Upstream responded 500')
  })

  it('runs turns one at a time, in send order', async () => {
    bots({ Primary: [ok('first'), ok('second')] })
    const g = await makeGroup()
    await inject('POST', `/api/conversations/${g.id}/messages`, { content: 'one' })
    await inject('POST', `/api/conversations/${g.id}/messages`, { content: 'two' })
    await groupIdle(g.id)
    await groupIdle(g.id)
    expect(groupMessages(g.id).filter((m) => m.kind !== 'system').map((m) => m.content)).toEqual(['one', 'first', 'two', 'second'])
  })

  it('leaves DMs synchronous', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok('dm reply')))
    const list = (await inject('GET', '/api/conversations')).json() as ConversationSummary[]
    const dm = list.find((c) => c.kind === 'dm' && c.agentId === researcher.id)!
    const res = await inject('POST', `/api/conversations/${dm.id}/messages`, { content: 'hi' })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { messages: ChatMessage[] }).messages.map((m) => m.content)).toEqual(['hi', 'dm reply'])
  })
})

describe('groups: lead typing on send and skippedAgentIds (BE-10)', () => {
  it('the 202 send already shows the lead typing, cleared once the turn ends', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    vi.stubGlobal('fetch', vi.fn(async () => { await gate; return ok('ok') }))
    const g = await makeGroup()
    const res = await inject('POST', `/api/conversations/${g.id}/messages`, { content: 'hi' })
    expect(res.statusCode).toBe(202)
    expect((res.json() as { conversation: ConversationSummary }).conversation.typingAgentId).toBe(primary.id)
    release()
    await groupIdle(g.id)
    expect(((await inject('GET', `/api/groups/${g.id}`)).json() as ConversationSummary).typingAgentId).toBeNull()
  })

  it("lists the bots the cap left out in the lead's mention order, not member order", async () => {
    const extra = [await makeBot('Ana'), await makeBot('Ben'), await makeBot('Cy')]
    const [ana, ben, cy] = extra
    bots({ Primary: [ok('@Cy @Ben @Ana @Summarizer @Researcher go'), ok('wrap')] })
    const g = await makeGroup('Big', [researcher.id, summarizer.id, ...extra.map((a) => a.id)])
    await send(g.id, 'go')
    const out = replies(g.id)
    // 4 replies: lead, two members, lead wrap-up; the rest are skipped in the order the lead named them.
    expect(out.map((m) => m.authorAgentId)).toEqual([primary.id, cy!.id, ben!.id, primary.id])
    expect(out[0]!.skippedAgentIds).toEqual([ana!.id, summarizer.id, researcher.id])
    const page = (await inject('GET', `/api/conversations/${g.id}/messages`)).json() as { messages: ChatMessage[] }
    expect(page.messages.find((m) => m.id === out[0]!.id)?.skippedAgentIds).toEqual([ana!.id, summarizer.id, researcher.id])
  })

  it('leaves skippedAgentIds out entirely when nobody was skipped', async () => {
    bots({ Primary: [ok('@Researcher take this'), ok('wrap')], Researcher: [ok('done')] })
    const g = await makeGroup()
    await send(g.id, 'go')
    const page = (await inject('GET', `/api/conversations/${g.id}/messages`)).json() as { messages: ChatMessage[] }
    const assistant = page.messages.filter((m) => m.role === 'assistant')
    expect(assistant.length).toBeGreaterThan(0)
    expect(assistant.every((m) => !('skippedAgentIds' in m))).toBe(true)
    expect(store.chatMessages.every((m) => !('skippedAgentIds' in m))).toBe(true)
  })
})

describe('groups: polling with after=', () => {
  it('returns messages after a message id, a page at a time', async () => {
    bots({ Primary: [ok('@Researcher'), ok('wrap')] })
    const g = await makeGroup()
    const sent = await send(g.id, 'go')
    const userId = sent.body.messages[0]!.id
    const all = (await inject('GET', `/api/conversations/${g.id}/messages?after=${userId}`)).json() as { messages: ChatMessage[]; hasMore: boolean; conversation: ConversationSummary }
    expect(all.messages.map((m) => m.authorAgentId)).toEqual([primary.id, researcher.id, primary.id])
    expect(all.hasMore).toBe(false)
    expect(all.conversation.typingAgentId).toBeNull()
    const page = (await inject('GET', `/api/conversations/${g.id}/messages?after=${userId}&limit=2`)).json() as { messages: ChatMessage[]; hasMore: boolean }
    expect(page.messages).toHaveLength(2)
    expect(page.hasMore).toBe(true)
    const rest = (await inject('GET', `/api/conversations/${g.id}/messages?after=${page.messages[1]!.id}`)).json() as { messages: ChatMessage[] }
    expect(rest.messages.map((m) => m.content)).toEqual(['wrap'])
    expect((await inject('GET', `/api/conversations/${g.id}/messages?after=msg-nope`)).statusCode).toBe(400)
    expect((await inject('GET', `/api/conversations/${g.id}/messages?after=${userId}&before=2030-01-01T00:00:00Z`)).statusCode).toBe(400)
  })
})

describe('groups: files and memory', () => {
  it('serves the group folder with the BE-2 shapes; only shared/ is writable', async () => {
    const g = groupOf(await makeGroup())
    const top = (await inject('GET', `/api/groups/${g.id}/files`)).json() as FileListing
    expect(top.root).toBe('groups/harbor-team/')
    expect(top.entries.map((e) => e.path)).toEqual(['memory', 'shared', 'GROUP.md'])
    expect(JSON.stringify(top)).not.toContain(dir)
    const put = await upload(`/api/groups/${g.id}/files/content?path=shared/notes/a.md`, 'hello')
    expect(put.statusCode).toBe(201)
    expect(put.json()).toMatchObject({ path: 'shared/notes/a.md', addedBy: 'user', zone: 'shared' })
    expect((await upload(`/api/groups/${g.id}/files/content?path=shared/notes/a.md`, 'x')).statusCode).toBe(409)
    expect((await upload(`/api/groups/${g.id}/files/content?path=GROUP.md`, 'x')).statusCode).toBe(403)
    expect((await upload(`/api/groups/${g.id}/files/content?path=memory/x.md`, 'x')).statusCode).toBe(403)
    const content = await inject('GET', `/api/groups/${g.id}/files/content?path=shared/notes/a.md`)
    expect(content.body).toBe('hello')
    expect(content.headers['content-security-policy']).toContain('sandbox')
    expect((await inject('POST', `/api/groups/${g.id}/files/folders`, { path: 'shared/drafts' })).statusCode).toBe(201)
    const moved = await inject('PATCH', `/api/groups/${g.id}/files`, { from: 'shared/notes', to: 'shared/kept' })
    expect(moved.statusCode).toBe(200)
    const shared = (await inject('GET', `/api/groups/${g.id}/files/shared`)).json() as { entries: FileEntry[] }
    expect(shared.entries).toEqual([expect.objectContaining({ path: 'shared/kept/a.md', addedBy: 'user' })])
    expect((await inject('DELETE', `/api/groups/${g.id}/files?path=shared/kept/a.md`)).statusCode).toBe(204)
    expect(existsSync(join(dir, 'groups', 'harbor-team', 'shared', 'kept', 'a.md'))).toBe(false)
    expect(readdirSync(join(dir, 'archive', 'trash', 'groups', 'harbor-team'))).toHaveLength(1)
    const missing = await inject('DELETE', `/api/groups/${g.id}/files?path=shared/kept/a.md`)
    expect(missing.statusCode).toBe(404)
    expect(missing.json().message).toBe('Nothing at "shared/kept/a.md" in this group\'s files.')
    expect((await inject('GET', `/api/groups/${g.id}/files?path=../../bots`)).statusCode).toBe(400)
  })

  it("records the bot that wrote a group:shared/ file, and a member's reply shows the change", async () => {
    bots({
      Primary: [ok('@Researcher')],
      Researcher: [toolCall('write_file', { path: 'group:shared/pier-2019-excerpt.md', content: 'pier' }), ok('Saved it to the group folder.')],
    })
    const g = await makeGroup()
    await send(g.id, 'go')
    const out = replies(g.id)
    expect(out[1]!.activity?.filesChanged).toEqual([expect.objectContaining({ path: 'group:shared/pier-2019-excerpt.md', change: 'added' })])
    const shared = (await inject('GET', `/api/groups/${g.id}/files/shared`)).json() as { entries: FileEntry[] }
    expect(shared.entries).toEqual([expect.objectContaining({ path: 'shared/pier-2019-excerpt.md', addedBy: researcher.id })])
  })

  it("a bot outside the group never reaches the group's files or memory", async () => {
    const outsider = await makeBot('Outsider')
    const g = await makeGroup()
    await upload(`/api/groups/${g.id}/files/content?path=shared/secret.md`, 'members only')
    await inject('POST', `/api/groups/${g.id}/memory`, { text: 'Brief is due Thursday', category: 'other' })
    const responses = [toolCall('read_file', { path: 'group:shared/secret.md' }), ok('nothing')]
    const mock = vi.fn(async () => responses.shift() ?? ok('done'))
    vi.stubGlobal('fetch', mock)
    const run = (await inject('POST', `/api/agents/${outsider.id}/runs`, { input: 'read the group file' })).json() as AgentRun
    expect(run.activity?.steps?.[0]).toMatchObject({ ok: false })
    const sentBodies = mock.mock.calls.map((c) => String((c as unknown[])[1] && ((c as unknown[])[1] as { body: string }).body))
    expect(sentBodies.join('\n')).not.toContain('members only')
    expect(sentBodies.join('\n')).not.toContain('Brief is due Thursday')
    // Member DMs don't see the group's memory either; group runs do.
    const own = (await inject('GET', `/api/agents/${researcher.id}/memory`)).json() as { items?: unknown[] } | unknown[]
    expect(JSON.stringify(own)).not.toContain('Brief is due Thursday')
    const seen: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_u: unknown, init: { body?: string }) => { seen.push(init.body ?? ''); return ok('ok') }))
    await send(g.id, 'when is the brief due?')
    expect(seen.join('\n')).toContain('Brief is due Thursday')
  })

  it('has its own memory routes, and MEMORY.md follows them', async () => {
    const g = groupOf(await makeGroup())
    const added = await inject('POST', `/api/groups/${g.id}/memory`, { text: 'Brief is due Thursday', category: 'other' })
    expect(added.statusCode).toBe(201)
    const list = (await inject('GET', `/api/groups/${g.id}/memory`)).json()
    expect(JSON.stringify(list)).toContain('Brief is due Thursday')
    await inject('GET', `/api/groups/${g.id}/files`)
    expect(readFileSync(join(dir, 'groups', 'harbor-team', 'memory', 'MEMORY.md'), 'utf8')).toContain('Brief is due Thursday')
    expect((await inject('GET', '/api/groups/conv-nope/memory')).statusCode).toBe(404)
  })
})
