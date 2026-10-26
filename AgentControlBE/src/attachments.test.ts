import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from './app.js'
import { formatSize } from './attachments.js'
import { groupIdle } from './groups.js'
import type { Agent, AgentRun, Attachment, ChatMessage, ConversationSummary, Endpoint, FileEntry, FileListing } from './shared/types.js'
import { createStore, type WorkspaceStore } from './store.js'

let dir = ''
let app: FastifyInstance
let store: WorkspaceStore
let endpointId = ''
let primary: Agent
let helper: Agent

const inject = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as object | undefined, headers: { 'content-type': 'application/json' } })
const upload = (conversationId: string, name: string, body: string | Buffer) =>
  app.inject({ method: 'PUT', url: `/api/conversations/${conversationId}/uploads?name=${encodeURIComponent(name)}`, payload: body, headers: { 'content-type': 'application/octet-stream' } })
const ok = (content: string) => ({ ok: true, status: 200, json: async () => ({ choices: [{ index: 0, message: { role: 'assistant', content } }] }), text: async () => '' })

async function makeBot(name: string): Promise<Agent> {
  const res = await inject('POST', '/api/agents', { name, description: '', instructions: '', modelId: 'test-model', endpointId, skillIds: [] })
  expect(res.statusCode).toBe(201)
  return res.json() as Agent
}
async function dmOf(agent: Agent): Promise<ConversationSummary> {
  const list = (await inject('GET', '/api/conversations')).json() as ConversationSummary[]
  return list.find((c) => c.kind === 'dm' && c.agentId === agent.id)!
}
/** Records every prompt the upstream sees. */
function upstream(reply = 'Got it.') {
  const bodies: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (_u: unknown, init: { body?: string }) => { bodies.push(init.body ?? ''); return ok(reply) }))
  return bodies
}

beforeEach(async () => {
  process.env.AGENTCONTROL_SECRET = 'test-secret'
  dir = mkdtempSync(join(tmpdir(), 'agentcontrol-attach-'))
  store = createStore(join(dir, 'store.json'))
  app = buildApp(store)
  const ep = await inject('POST', '/api/endpoints', { kind: 'openai-compatible', name: 'E', baseUrl: 'http://127.0.0.1:9', defaultModel: 'test-model', contextWindow: 32768 })
  endpointId = (ep.json() as Endpoint).id
  primary = await makeBot('Primary')
  helper = await makeBot('Helper')
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await app.close()
  rmSync(dir, { recursive: true, force: true })
  delete process.env.AGENTCONTROL_SECRET
})

describe('uploads', () => {
  it("a DM upload lands in the bot's shared/ and renames on a clash", async () => {
    const dm = await dmOf(helper)
    const first = await upload(dm.id, 'report.pdf', Buffer.alloc(1900, 1))
    expect(first.statusCode).toBe(201)
    expect(first.json()).toEqual({ root: 'agent', path: 'shared/report.pdf', name: 'report.pdf', size: 1900, mime: 'application/pdf' })
    expect(readFileSync(join(dir, 'bots', helper.slug, 'shared', 'report.pdf')).length).toBe(1900)
    expect((await upload(dm.id, 'report.pdf', 'b')).json()).toMatchObject({ path: 'shared/report (2).pdf', name: 'report (2).pdf' })
    expect((await upload(dm.id, 'report.pdf', 'c')).json()).toMatchObject({ path: 'shared/report (3).pdf' })
    expect((await upload(dm.id, 'README', 'd')).json()).toMatchObject({ path: 'shared/README' })
    expect((await upload(dm.id, 'README', 'e')).json()).toMatchObject({ path: 'shared/README (2)' })
  })

  it('a group upload lands in the group shared/, added by the user', async () => {
    const g = (await inject('POST', '/api/groups', { name: 'Harbor team', memberAgentIds: [helper.id] })).json() as ConversationSummary
    const res = await upload(g.id, 'pier.md', 'pier')
    expect(res.statusCode).toBe(201)
    expect(res.json()).toEqual({ root: 'group', path: 'shared/pier.md', name: 'pier.md', size: 4, mime: 'text/markdown' })
    expect(readFileSync(join(dir, 'groups', 'harbor-team', 'shared', 'pier.md'), 'utf8')).toBe('pier')
    const shared = (await inject('GET', `/api/groups/${g.id}/files/shared`)).json() as { entries: FileEntry[] }
    expect(shared.entries).toEqual([expect.objectContaining({ path: 'shared/pier.md', addedBy: 'user', sharedInConversationId: g.id, sharedAt: expect.any(String) })])
  })

  it('rejects names that are paths, and unknown conversations', async () => {
    const dm = await dmOf(helper)
    for (const name of ['', '../x.md', 'a/b.md', '..', 'a\\b']) {
      expect((await upload(dm.id, name, 'x')).statusCode).toBe(400)
    }
    expect((await upload('conv-nope', 'a.md', 'x')).statusCode).toBe(404)
  })

  it('marks shared files with sharedAt and the conversation, and keeps it through a move; other files have none', async () => {
    const dm = await dmOf(helper)
    await upload(dm.id, 'a.md', 'a')
    await app.inject({ method: 'PUT', url: `/api/agents/${helper.id}/files/content?path=shared/plain.md`, payload: 'p', headers: { 'content-type': 'text/plain' } })
    const shared = (await inject('GET', `/api/agents/${helper.id}/files/shared`)).json() as { entries: FileEntry[] }
    const byPath = Object.fromEntries(shared.entries.map((e) => [e.path, e]))
    expect(byPath['shared/a.md']).toMatchObject({ sharedInConversationId: dm.id, sharedAt: expect.any(String) })
    expect(byPath['shared/plain.md']).not.toHaveProperty('sharedAt')
    const listing = (await inject('GET', `/api/agents/${helper.id}/files?path=shared`)).json() as FileListing
    expect(listing.entries.find((e) => e.path === 'shared/a.md')).toMatchObject({ sharedInConversationId: dm.id })
    const moved = await inject('PATCH', `/api/agents/${helper.id}/files`, { from: 'shared/a.md', to: 'shared/kept/a.md' })
    expect(moved.json()).toMatchObject({ path: 'shared/kept/a.md', sharedInConversationId: dm.id })
    await inject('DELETE', `/api/agents/${helper.id}/files?path=shared/kept`)
    await upload(dm.id, 'b.md', 'b')
    const after = (await inject('GET', `/api/agents/${helper.id}/files/shared`)).json() as { entries: FileEntry[] }
    expect(after.entries.filter((e) => e.sharedAt).map((e) => e.path)).toEqual(['shared/b.md'])
    // The records live beside the folder, never in it: 2 shared files plus BOT.md and memory/MEMORY.md.
    expect(listing.totalFiles).toBe(4)
    expect(existsSync(join(dir, 'bots', `${helper.slug}.shared.json`))).toBe(true)
  })
})

describe('sending with attachments', () => {
  it('a DM run is told about the attachment, and the message carries it', async () => {
    const bodies = upstream()
    const dm = await dmOf(helper)
    const att = (await upload(dm.id, 'report.pdf', Buffer.alloc(1887437, 1))).json() as Attachment
    const res = await inject('POST', `/api/conversations/${dm.id}/messages`, { content: 'Summarize this.', attachments: [att] })
    expect(res.statusCode).toBe(200)
    const out = res.json() as { messages: ChatMessage[]; run: AgentRun }
    expect(out.messages[0]).toMatchObject({ role: 'user', content: 'Summarize this.', attachments: [att] })
    expect(bodies.join('\n')).toContain('User attached: shared/report.pdf (1.8 MB)')
    expect(store.runs.find((r) => r.id === out.run.id)?.input).toContain('User attached: shared/report.pdf (1.8 MB)')
    // Persisted with the message.
    const again = createStore(join(dir, 'store.json'))
    expect(again.chatMessages.find((m) => m.id === out.messages[0]!.id)?.attachments).toEqual([att])
  })

  it('accepts attachments with no text', async () => {
    const bodies = upstream()
    const dm = await dmOf(helper)
    const att = (await upload(dm.id, 'a.md', 'a')).json() as Attachment
    const res = await inject('POST', `/api/conversations/${dm.id}/messages`, { attachments: [att] })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { messages: ChatMessage[] }).messages[0]).toMatchObject({ content: '', attachments: [att] })
    expect(bodies.join('\n')).toContain('User attached: shared/a.md (1 B)')
  })

  it('refuses an attachment from another conversation, a plain shared file, or a deleted upload', async () => {
    upstream()
    const mine = await dmOf(helper)
    const other = await dmOf(primary)
    const foreign = (await upload(other.id, 'x.md', 'x')).json() as Attachment
    const send = (attachments: unknown) => inject('POST', `/api/conversations/${mine.id}/messages`, { content: 'hi', attachments })
    const res = await send([foreign])
    expect(res.statusCode).toBe(400)
    expect(res.json().message).toContain("wasn't uploaded to this conversation")
    // Same path in this bot's folder, but never uploaded here.
    await app.inject({ method: 'PUT', url: `/api/agents/${helper.id}/files/content?path=shared/x.md`, payload: 'p', headers: { 'content-type': 'text/plain' } })
    expect((await send([{ ...foreign }])).statusCode).toBe(400)
    expect((await send([{ root: 'group', path: 'shared/x.md', name: 'x.md', size: 1, mime: 'text/markdown' }])).statusCode).toBe(400)
    expect((await send('nope')).statusCode).toBe(400)
    const gone = (await upload(mine.id, 'gone.md', 'g')).json() as Attachment
    await inject('DELETE', `/api/agents/${helper.id}/files?path=shared/gone.md`)
    expect((await send([gone])).statusCode).toBe(400)
    expect(store.chatMessages.filter((m) => m.conversationId === mine.id)).toHaveLength(0)
  })

  it('a group message carries its attachments and every reply is told about them as group: paths', async () => {
    const bodies = upstream('Read it.')
    const g = (await inject('POST', '/api/groups', { name: 'Harbor team', memberAgentIds: [helper.id] })).json() as ConversationSummary
    const att = (await upload(g.id, 'pier.md', 'pier')).json() as Attachment
    const res = await inject('POST', `/api/conversations/${g.id}/messages`, { content: '@Helper read this', attachments: [att] })
    expect(res.statusCode).toBe(202)
    expect((res.json() as { messages: ChatMessage[] }).messages[0]).toMatchObject({ content: '@Helper read this', attachments: [att] })
    await groupIdle(g.id)
    expect(bodies.length).toBeGreaterThanOrEqual(2)
    for (const b of bodies) expect(b).toContain('User attached: group:shared/pier.md (4 B)')
    // A DM upload can't be attached in the group.
    const dmAtt = (await upload((await dmOf(helper)).id, 'mine.md', 'm')).json() as Attachment
    expect((await inject('POST', `/api/conversations/${g.id}/messages`, { content: 'x', attachments: [dmAtt] })).statusCode).toBe(400)
  })

  it('formats sizes the way the prompt shows them', () => {
    expect([formatSize(0), formatSize(1023), formatSize(3 * 1024), formatSize(1887437)]).toEqual(['0 B', '1023 B', '3 KB', '1.8 MB'])
  })
})
