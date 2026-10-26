import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MEMORY_SCOPE_LIMIT, dropMemory, memoryApi, memoryFooter, memorySourceLine, memoryView, upsertMemory, validateMemoryText } from '../src/lib/memory.ts'

const item = (id, category, text, updatedAt, source = { kind: 'user' }) => ({
  id, scope: { kind: 'agent', agentId: 'p' }, text, category, source, createdAt: updatedAt, updatedAt,
})
const items = [
  item('m1', 'about-you', 'Charles builds AgentControl and lives in Central time.', '2026-10-12T10:00:00'),
  item('m2', 'preferences', 'Prefers short answers and drafts saved as files.', '2026-10-19T09:00:00', { kind: 'chat', conversationId: 'c', runId: 'r', agentId: 'p' }),
  item('m3', 'work', 'Lindmere harbor brief is due Thursday.', '2026-10-19T08:00:00', { kind: 'chat', conversationId: 'c', runId: 'r', agentId: 'p' }),
  item('m4', 'work', 'The llama.cpp server runs on port 8791.', '2026-10-18T08:00:00'),
]

function fakeRequest(routes) {
  const calls = []
  const request = async (path, init = {}) => {
    calls.push({ path, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined })
    const r = routes(path, init.method ?? 'GET')
    if (r instanceof Error) throw r
    return r
  }
  return { request, calls }
}
const err = (status, message) => Object.assign(new Error(message), { status })

describe('memory API (BE-4 contract)', () => {
  it('list asks for the whole scope (200) and normalizes', async () => {
    const { request, calls } = fakeRequest(() => ({ items, total: 4, promptTokens: 120 }))
    const r = await memoryApi(request).list('a b')
    assert.equal(calls[0].path, `/api/agents/a%20b/memory?limit=${MEMORY_SCOPE_LIMIT}`)
    assert.equal(r.status, 'ok')
    assert.equal(r.page.total, 4)
    assert.equal(r.page.promptTokens, 120)
  })
  it('a missing route (pre BE-4) is "unavailable", not an error', async () => {
    const { request } = fakeRequest(() => err(404, 'Route GET:/api/agents/p/memory?limit=200 not found'))
    assert.deepEqual(await memoryApi(request).list('p'), { status: 'unavailable' })
  })
  it('a real failure is an error with the message', async () => {
    const { request } = fakeRequest(() => err(404, 'No agent with id "p"'))
    assert.deepEqual(await memoryApi(request).list('p'), { status: 'error', message: 'No agent with id "p"' })
  })
  it('create / update / delete hit the contract routes', async () => {
    const { request, calls } = fakeRequest((path, method) => (method === 'DELETE' ? null : item('m9', 'work', 'x', '2026-10-19T00:00:00')))
    const api = memoryApi(request)
    await api.create('p', { text: 'x', category: 'work' })
    await api.update('p', 'm 9', { text: 'y' })
    await api.remove('p', 'm9')
    assert.deepEqual(calls.map((c) => [c.method, c.path, c.body]), [
      ['POST', '/api/agents/p/memory', { text: 'x', category: 'work' }],
      ['PATCH', '/api/agents/p/memory/m%209', { text: 'y' }],
      ['DELETE', '/api/agents/p/memory/m9', undefined],
    ])
  })
})

describe('memory view (03b)', () => {
  it('chips: All + non-empty categories with counts', () => {
    const v = memoryView(items, { query: '', category: 'all' })
    assert.deepEqual(v.chips.map((c) => `${c.label} ${c.count}`), ['All 4', 'About you 1', 'Preferences 1', 'Work 2'])
    assert.deepEqual(v.shown.map((m) => m.id), ['m2', 'm3', 'm4', 'm1'], 'newest first')
  })
  it('category + search filter', () => {
    assert.deepEqual(memoryView(items, { query: '', category: 'work' }).shown.map((m) => m.id), ['m3', 'm4'])
    assert.deepEqual(memoryView(items, { query: 'PORT', category: 'all' }).shown.map((m) => m.id), ['m4'])
    assert.deepEqual(memoryView(items, { query: 'port', category: 'preferences' }).shown, [])
  })
  it('an emptied selected category keeps its chip', () => {
    assert.ok(memoryView([], { query: '', category: 'other' }).chips.some((c) => c.id === 'other'))
  })
  it('source line', () => {
    const now = new Date('2026-10-19T12:00:00')
    assert.equal(memorySourceLine(items[0], now), 'You told me · Oct 12')
    assert.equal(memorySourceLine(items[1], now), 'Learned in chat · Today')
    assert.equal(memorySourceLine(items[3], now), 'You told me · Yesterday')
  })
  it('validation: 1-500 chars after trim', () => {
    assert.match(validateMemoryText('   '), /Write something/)
    assert.equal(validateMemoryText(' ok '), null)
    assert.equal(validateMemoryText('a'.repeat(500)), null)
    assert.match(validateMemoryText('a'.repeat(501)), /under 500/)
  })
  it('local CRUD helpers', () => {
    const n = item('m5', 'other', 'new', '2026-10-20T00:00:00')
    assert.deepEqual(upsertMemory(items, n).map((m) => m.id), ['m5', 'm1', 'm2', 'm3', 'm4'])
    const edited = { ...items[1], text: 'edited' }
    assert.equal(upsertMemory(items, edited)[1].text, 'edited')
    assert.equal(upsertMemory(items, edited).length, 4)
    assert.deepEqual(dropMemory(items, 'm2').map((m) => m.id), ['m1', 'm3', 'm4'])
  })
})

describe('memory: BE-4 totals, tokens and the 200-item 409', () => {
  it('footer: "Showing X of total" (03b) plus prompt tokens (GAP-M1)', () => {
    assert.equal(memoryFooter(6, 12, 0), 'Showing 6 of 12 · Group chats keep their own memory, separate from this')
    assert.equal(memoryFooter(3, 3, 1234), 'Showing 3 of 3 · Group chats keep their own memory, separate from this · ≈1,234 tokens in the prompt')
  })
  it('list asks for limit=200 (the scope cap) and keeps total and promptTokens', async () => {
    const calls = []
    const api = memoryApi(async (path) => (calls.push(path), { items: [{ id: 'm1' }], total: 1, promptTokens: 21 }))
    assert.deepEqual(await api.list('agt 1'), { status: 'ok', page: { items: [{ id: 'm1' }], total: 1, promptTokens: 21 } })
    assert.deepEqual(calls, ['/api/agents/agt%201/memory?limit=200'])
    assert.equal(MEMORY_SCOPE_LIMIT, 200)
  })
  it('a 409 at 200 items rejects with the server message for the editor', async () => {
    const full = Object.assign(new Error('Memory is full (200 items). Delete something first.'), { status: 409 })
    const api = memoryApi(async () => { throw full })
    await assert.rejects(api.create('a', { text: 'x', category: 'other' }), { status: 409, message: 'Memory is full (200 items). Delete something first.' })
  })
})
