import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from './app.js'
import { MAX_SEARCH_FILES, MAX_SEARCH_MESSAGES, snippetAround } from './search.js'
import type { Agent, ChatMessage, ConversationSummary, Endpoint, SearchResults } from './shared/types.js'
import { createStore, type WorkspaceStore } from './store.js'

let dir = ''
let app: FastifyInstance
let store: WorkspaceStore
let endpointId = ''
let primary: Agent
let scout: Agent
let dmId = ''
let group: ConversationSummary

const inject = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as object | undefined, headers: { 'content-type': 'application/json' } })
const find = async (q: string, extra = '') => {
  const res = await inject('GET', `/api/search?q=${encodeURIComponent(q)}${extra}`)
  return { status: res.statusCode, body: res.json() as SearchResults & { message?: string } }
}
let seq = 0
function say(conversationId: string, content: string, over: Partial<ChatMessage> = {}): ChatMessage {
  seq++
  const m: ChatMessage = { id: `m${seq}`, conversationId, role: 'assistant', content, createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, seq)).toISOString(), ...over }
  store.chatMessages.push(m)
  return m
}
function put(path: string, body = 'x', mtime?: Date) {
  const full = join(dir, path)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, body)
  if (mtime) utimesSync(full, mtime, mtime)
}
async function makeBot(name: string): Promise<Agent> {
  const res = await inject('POST', '/api/agents', { name, description: '', instructions: '', modelId: 'test-model', endpointId, skillIds: [] })
  expect(res.statusCode).toBe(201)
  return res.json() as Agent
}

beforeEach(async () => {
  process.env.AGENTCONTROL_SECRET = 'test-secret'
  dir = mkdtempSync(join(tmpdir(), 'agentcontrol-search-'))
  store = createStore(join(dir, 'store.json'))
  app = buildApp(store)
  const ep = await inject('POST', '/api/endpoints', { kind: 'openai-compatible', name: 'E', baseUrl: 'http://127.0.0.1:9', defaultModel: 'test-model', contextWindow: 32768 })
  endpointId = (ep.json() as Endpoint).id
  primary = await makeBot('Primary')
  scout = await makeBot('Harbor Scout')
  const list = (await inject('GET', '/api/conversations')).json() as ConversationSummary[]
  dmId = list.find((c) => c.kind === 'dm' && c.agentId === scout.id)!.id
  group = (await inject('POST', '/api/groups', { name: 'Harbor team', memberAgentIds: [scout.id] })).json() as ConversationSummary
})
afterEach(async () => {
  await app.close()
  rmSync(dir, { recursive: true, force: true })
  delete process.env.AGENTCONTROL_SECRET
})

describe('GET /api/search', () => {
  it('matches bots, groups, messages and files case-insensitively', async () => {
    say(dmId, 'The PIER survey is due Friday.', { authorAgentId: scout.id })
    say(group.id, 'nothing here')
    const user = say(group.id, 'can we move the pier meeting?', { role: 'user' })
    put(`bots/${scout.slug}/workspace/notes/Pier-plan.md`)
    put('groups/harbor-team/shared/pier.pdf')
    put(`bots/${scout.slug}/shared/other.txt`)

    const harbor = await find('HARBOR')
    expect(harbor.status).toBe(200)
    expect(harbor.body.agents).toEqual([{ id: scout.id, name: 'Harbor Scout' }])
    expect(harbor.body.groups).toEqual([{ id: group.id, name: 'Harbor team' }])

    const pier = (await find('pier')).body
    expect(pier.agents).toEqual([])
    // Newest first; the user's message has no author.
    expect(pier.messages).toEqual([
      { conversationId: group.id, messageId: user.id, snippet: 'can we move the pier meeting?', createdAt: user.createdAt },
      expect.objectContaining({ conversationId: dmId, authorAgentId: scout.id, snippet: 'The PIER survey is due Friday.' }),
    ])
    expect(pier.files.map((f) => [f.root, f.ownerId, f.path, f.name]).sort()).toEqual([
      ['agent', scout.id, 'workspace/notes/Pier-plan.md', 'Pier-plan.md'],
      ['group', group.id, 'shared/pier.pdf', 'pier.pdf'],
    ])
    expect(pier.files[0]!.modifiedAt).toEqual(expect.any(String))
  })

  it('matches folder names in a path, skips system lines, generated files, symlinks and archived groups', async () => {
    put(`bots/${scout.slug}/shared/reports/q3.csv`)
    put(`bots/${scout.slug}/memory/MEMORY.md`, 'report')
    symlinkSync('/etc/hostname', join(dir, 'bots', scout.slug, 'shared', 'report-link'))
    const found = (await find('report')).body
    expect(found.files.map((f) => f.path)).toEqual(['shared/reports/q3.csv'])
    // The "You created Harbor team…" system line is not a message hit.
    expect((await find('created')).body.messages).toEqual([])

    const doomed = (await inject('POST', '/api/groups', { name: 'Old dock', memberAgentIds: [scout.id] })).json() as ConversationSummary
    say(doomed.id, 'dock notes')
    put('groups/old-dock/shared/dock.md')
    expect((await find('dock')).body.messages).toHaveLength(1)
    expect((await inject('DELETE', `/api/groups/${doomed.id}`)).statusCode).toBeLessThan(300)
    expect(await find('dock').then((r) => r.body)).toEqual({ agents: [], groups: [], messages: [], files: [] })
  })

  it('a 1-character q returns results; empty or whitespace q is 400', async () => {
    say(dmId, 'x marks the spot')
    const one = await find('x')
    expect(one.status).toBe(200)
    expect(one.body.messages).toHaveLength(1)
    expect((await find('')).status).toBe(400)
    expect((await find('   ')).status).toBe(400)
    expect((await inject('GET', '/api/search')).statusCode).toBe(400)
  })

  it('limit caps each list (default 20); a bad limit is 400', async () => {
    for (let i = 0; i < 25; i++) say(dmId, `buoy ${i}`)
    expect((await find('buoy')).body.messages).toHaveLength(20)
    const three = (await find('buoy', '&limit=3')).body.messages
    expect(three.map((m) => m.snippet)).toEqual(['buoy 24', 'buoy 23', 'buoy 22'])
    expect((await find('buoy', '&limit=0')).status).toBe(400)
    expect((await find('buoy', '&limit=51')).status).toBe(400)
    expect((await find('buoy', '&limit=two')).status).toBe(400)
  })

  it(`only the newest ${MAX_SEARCH_MESSAGES} messages are searched`, async () => {
    say(dmId, 'the anchor is lost')
    // The group's "You created…" line is newer than these, so it takes one of the slots.
    for (let i = 0; i < MAX_SEARCH_MESSAGES - 1; i++) say(dmId, 'filler')
    expect((await find('anchor')).body.messages).toEqual([])
    store.chatMessages.splice(store.chatMessages.findIndex((m) => m.content === 'filler'), 1)
    expect((await find('anchor')).body.messages).toHaveLength(1)
  })

  it(`stops after walking ${MAX_SEARCH_FILES} files`, async () => {
    // shared/ is walked before workspace/ in the same bot.
    const shared = join(dir, 'bots', scout.slug, 'shared')
    mkdirSync(shared, { recursive: true })
    for (let i = 0; i < MAX_SEARCH_FILES; i++) writeFileSync(join(shared, `a${String(i).padStart(5, '0')}.txt`), '')
    put(`bots/${scout.slug}/workspace/zebra.txt`)
    expect((await find('zebra')).body.files).toEqual([])
    rmSync(join(shared, 'a00000.txt'))
    expect((await find('zebra')).body.files).toHaveLength(1)
  })

  it('files come back newest first', async () => {
    put(`bots/${scout.slug}/shared/rope-old.txt`, 'x', new Date('2026-01-01T00:00:00Z'))
    put(`bots/${scout.slug}/workspace/rope-new.txt`, 'x', new Date('2026-06-01T00:00:00Z'))
    expect((await find('rope')).body.files.map((f) => f.name)).toEqual(['rope-new.txt', 'rope-old.txt'])
  })
})

describe('snippetAround', () => {
  it('keeps ~120 chars around the match with ellipses and collapsed whitespace', () => {
    const text = `${'a'.repeat(200)} NEEDLE\n\n${'b'.repeat(200)}`
    const s = snippetAround(text, text.indexOf('NEEDLE'), 6)
    expect(s.startsWith('…')).toBe(true)
    expect(s.endsWith('…')).toBe(true)
    expect(s).toContain('NEEDLE b')
    expect(s.length).toBeLessThanOrEqual(122)
    expect(snippetAround('short one', 0, 5)).toBe('short one')
    const atEnd = `${'c'.repeat(300)}END`
    expect(snippetAround(atEnd, 300, 3)).toBe(`…${'c'.repeat(117)}END`)
  })
})

describe('first messages page', () => {
  it('returns the same summary as ?after= (unread count and typing)', async () => {
    say(dmId, 'hello')
    const res = (await inject('GET', `/api/conversations/${dmId}/messages`)).json() as { conversation: ConversationSummary }
    expect(res.conversation).toMatchObject({ id: dmId, unreadCount: 1, typingAgentId: null })
    expect(res.conversation.lastMessage?.content).toBe('hello')
  })
})
