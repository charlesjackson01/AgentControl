import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from './app.js'
import { NOTES_MIGRATION, NOTES_RETIRED } from './archive.js'
import { MAX_MEMORY_PER_SCOPE, MEMORY_HEADER } from './memory.js'
import { createStore } from './store.js'
import type { Agent, MemoryItem } from './shared/types.js'

/** BE-4: per-bot memory (CRUD, limits, scope, prompt, tools), PATCH agent, and notes-to-memory-v1. */

let dir = ''
let store: ReturnType<typeof createStore>
let app: ReturnType<typeof buildApp>

beforeEach(() => {
  vi.stubEnv('AGENTCONTROL_SECRET', 'memory-test-secret')
  vi.stubEnv('AGENTCONTROL_AUTH_TOKEN', '')
  dir = mkdtempSync(join(tmpdir(), 'agentcontrol-memory-'))
  store = createStore(join(dir, 'store.json'))
  app = buildApp(store)
})

afterEach(async () => {
  await app.close()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

const inject = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as object | undefined })

async function makeAgent(name: string): Promise<Agent> {
  const res = await inject('POST', '/api/agents', { name, endpointId: 'ep_local_llama', modelId: 'llama-3-8b' })
  expect(res.statusCode).toBe(201)
  return res.json() as Agent
}

type Listed = { items: MemoryItem[]; total: number; promptTokens: number }

function mockChatSequence(responses: unknown[]) {
  const mock = vi.fn(async (_url: string, _init?: { body?: string }) => ({
    ok: true,
    status: 200,
    json: async () => responses.shift() ?? { choices: [{ index: 0, message: { role: 'assistant', content: 'done' } }] },
  }))
  vi.stubGlobal('fetch', mock)
  return mock
}
const toolCall = (name: string, args: unknown) => ({
  choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }],
})
const content = (text: string) => ({ choices: [{ index: 0, message: { role: 'assistant', content: text } }] })
const body = (mock: ReturnType<typeof mockChatSequence>, i: number) =>
  JSON.parse(mock.mock.calls[i]?.[1]?.body ?? '{}') as { messages: { role: string; content: string }[]; tools?: { function: { name: string } }[] }

describe('memory routes', () => {
  it('creates, lists, edits and deletes, and regenerates memory/MEMORY.md', async () => {
    const a = await makeAgent('Writer')
    const created = await inject('POST', `/api/agents/${a.id}/memory`, { text: '  Prefers short answers.  ' })
    expect(created.statusCode).toBe(201)
    const item = created.json() as MemoryItem
    expect(item).toMatchObject({ text: 'Prefers short answers.', category: 'other', scope: { kind: 'agent', agentId: a.id }, source: { kind: 'user' } })
    const file = join(dir, 'bots', a.slug, 'memory', 'MEMORY.md')
    expect(readFileSync(file, 'utf8')).toContain('Prefers short answers.')

    const edited = await inject('PATCH', `/api/agents/${a.id}/memory/${item.id}`, { text: 'Likes bullet lists.', category: 'preferences' })
    expect(edited.statusCode).toBe(200)
    expect(edited.json()).toMatchObject({ id: item.id, text: 'Likes bullet lists.', category: 'preferences' })
    expect(readFileSync(file, 'utf8')).toContain('Likes bullet lists.')
    expect(readFileSync(file, 'utf8')).not.toContain('Prefers short answers.')

    const listed = (await inject('GET', `/api/agents/${a.id}/memory`)).json() as Listed
    expect(listed.total).toBe(1)
    expect(listed.promptTokens).toBeGreaterThan(0)

    expect((await inject('DELETE', `/api/agents/${a.id}/memory/${item.id}`)).statusCode).toBe(204)
    expect((await inject('DELETE', `/api/agents/${a.id}/memory/${item.id}`)).statusCode).toBe(404)
    expect(((await inject('GET', `/api/agents/${a.id}/memory`)).json() as Listed).total).toBe(0)
    expect(readFileSync(file, 'utf8')).not.toContain('Likes bullet lists.')
  })

  it('validates text and category, and returns the existing item for a duplicate', async () => {
    const a = await makeAgent('Writer')
    expect((await inject('POST', `/api/agents/${a.id}/memory`, { text: '   ' })).statusCode).toBe(400)
    expect((await inject('POST', `/api/agents/${a.id}/memory`, { text: 'x'.repeat(501) })).statusCode).toBe(400)
    expect((await inject('POST', `/api/agents/${a.id}/memory`, { text: 'ok', category: 'secret' })).statusCode).toBe(400)
    expect((await inject('POST', '/api/agents/nope/memory', { text: 'ok' })).statusCode).toBe(404)
    const first = (await inject('POST', `/api/agents/${a.id}/memory`, { text: 'Lives in Austin.', category: 'about-you' })).json() as MemoryItem
    const dup = await inject('POST', `/api/agents/${a.id}/memory`, { text: 'lives in austin.' })
    expect((dup.json() as MemoryItem).id).toBe(first.id)
    expect(store.memories).toHaveLength(1)
    const err = (await inject('PATCH', `/api/agents/${a.id}/memory/${first.id}`, { category: 'bad' })).json() as Record<string, unknown>
    expect(err).toMatchObject({ statusCode: 400, error: 'Request Error' })
  })

  it('caps a scope at 200 items with 409, and pages with limit up to 200', async () => {
    const a = await makeAgent('Writer')
    for (let i = 0; i < MAX_MEMORY_PER_SCOPE; i++) {
      expect((await inject('POST', `/api/agents/${a.id}/memory`, { text: `fact ${i}` })).statusCode).toBe(201)
    }
    const full = await inject('POST', `/api/agents/${a.id}/memory`, { text: 'one more' })
    expect(full.statusCode).toBe(409)
    expect(full.json()).toMatchObject({ statusCode: 409, error: 'Request Error' })

    const def = (await inject('GET', `/api/agents/${a.id}/memory`)).json() as Listed
    expect(def.items).toHaveLength(50)
    expect(def.total).toBe(200)
    expect(def.items[0]?.text).toBe('fact 199') // newest first
    const all = (await inject('GET', `/api/agents/${a.id}/memory?limit=200`)).json() as Listed
    expect(all.items).toHaveLength(200)
    expect((await inject('GET', `/api/agents/${a.id}/memory?limit=201`)).statusCode).toBe(400)
    expect((await inject('GET', `/api/agents/${a.id}/memory?limit=0`)).statusCode).toBe(400)
    const page = (await inject('GET', `/api/agents/${a.id}/memory?limit=10&offset=195`)).json() as Listed
    expect(page.items.map((m) => m.text)).toEqual(['fact 4', 'fact 3', 'fact 2', 'fact 1', 'fact 0'])
    const q = (await inject('GET', `/api/agents/${a.id}/memory?q=fact%2019&limit=200`)).json() as Listed
    expect(q.items.every((m) => m.text.includes('fact 19'))).toBe(true)
  })

  it('keeps each bot\'s memory separate and drops it when the bot is deleted', async () => {
    const a = await makeAgent('Writer')
    const b = await makeAgent('Coder')
    const item = (await inject('POST', `/api/agents/${a.id}/memory`, { text: 'Only for Writer.' })).json() as MemoryItem
    expect(((await inject('GET', `/api/agents/${b.id}/memory`)).json() as Listed).total).toBe(0)
    expect((await inject('PATCH', `/api/agents/${b.id}/memory/${item.id}`, { text: 'hijack' })).statusCode).toBe(404)
    expect((await inject('DELETE', `/api/agents/${b.id}/memory/${item.id}`)).statusCode).toBe(404)
    await inject('POST', `/api/agents/${b.id}/memory`, { text: 'Only for Coder.' })
    // Writer is the primary bot (created first), so delete Coder.
    expect((await inject('DELETE', `/api/agents/${b.id}`)).statusCode).toBeLessThan(300)
    expect(store.memories.map((m) => m.text)).toEqual(['Only for Writer.'])
  })
})

describe('memory in runs', () => {
  it('puts the bot\'s memory in the system prompt, offers recall, and saves via remember', async () => {
    const a = await makeAgent('Writer')
    await inject('POST', `/api/agents/${a.id}/memory`, { text: 'Prefers short answers.', category: 'preferences' })
    const b = await makeAgent('Coder')
    await inject('POST', `/api/agents/${b.id}/memory`, { text: 'Coder-only fact.' })

    const mock = mockChatSequence([toolCall('remember', { text: 'Works at Meta.', category: 'work' }), content('noted')])
    const run = await inject('POST', `/api/agents/${a.id}/runs`, { input: 'I work at Meta' })
    expect(run.statusCode).toBe(200)
    const first = body(mock, 0)
    const system = first.messages[0]?.content ?? ''
    expect(system).toContain(MEMORY_HEADER.trim())
    expect(system).toContain('- [preferences] Prefers short answers.')
    expect(system).not.toContain('Coder-only fact.')
    expect(first.tools?.map((t) => t.function.name)).toEqual(expect.arrayContaining(['remember', 'recall']))

    const saved = store.memories.find((m) => m.text === 'Works at Meta.')
    expect(saved).toMatchObject({ category: 'work', scope: { kind: 'agent', agentId: a.id }, source: { kind: 'chat', agentId: a.id } })
  })

  it('does not offer remember when memory learning is off', async () => {
    const a = await makeAgent('Writer')
    expect((await inject('PATCH', `/api/agents/${a.id}`, { memoryLearn: false })).statusCode).toBe(200)
    const mock = mockChatSequence([content('ok')])
    await inject('POST', `/api/agents/${a.id}/runs`, { input: 'hi' })
    expect(body(mock, 0).tools?.map((t) => t.function.name) ?? []).not.toContain('remember')
  })
})

describe('prompt budget with memory', () => {
  it('counts a saved bot\'s memory block and recall, matching its run', async () => {
    const a = await makeAgent('Writer')
    expect((await inject('PATCH', `/api/agents/${a.id}`, { skillIds: [] })).statusCode).toBe(200)
    await inject('POST', `/api/agents/${a.id}/memory`, { text: 'Prefers short answers.', category: 'preferences' })
    const draft = (await inject('POST', '/api/prompt-budget', { endpointId: 'ep_local_llama' })).json() as { toolNames: string[]; estimatedTokens: number }
    const saved = (await inject('POST', '/api/prompt-budget', { endpointId: 'ep_local_llama', agentId: a.id })).json() as { toolNames: string[]; estimatedTokens: number }
    expect(draft.toolNames).toEqual(['remember'])
    expect(saved.toolNames).toEqual(['remember', 'recall'])
    expect(saved.estimatedTokens).toBeGreaterThan(draft.estimatedTokens)

    const mock = mockChatSequence([content('ok')])
    const run = (await inject('POST', `/api/agents/${a.id}/runs`, { input: 'x' })).json() as { systemPrompt?: string }
    expect(body(mock, 0).tools?.map((t) => t.function.name)).toEqual(saved.toolNames)
    expect(run.systemPrompt).toContain('Prefers short answers.')

    const off = (await inject('POST', '/api/prompt-budget', { endpointId: 'ep_local_llama', agentId: a.id, memoryLearn: false })).json() as { toolNames: string[] }
    expect(off.toolNames).toEqual(['recall'])
    expect((await inject('POST', '/api/prompt-budget', { endpointId: 'ep_local_llama', agentId: 'nope' })).statusCode).toBe(404)
    expect((await inject('POST', '/api/prompt-budget', { endpointId: 'ep_local_llama', agentId: 7 })).statusCode).toBe(400)
  })
})

describe('PATCH /api/agents/:id', () => {
  it('updates any subset of fields with the PUT rules and returns the full agent', async () => {
    const a = await makeAgent('Writer')
    const res = await inject('PATCH', `/api/agents/${a.id}`, { description: 'Drafts docs.' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ id: a.id, name: 'Writer', description: 'Drafts docs.', modelId: 'llama-3-8b', slug: a.slug })
    expect((await inject('PATCH', `/api/agents/${a.id}`, { name: '' })).statusCode).toBe(400)
    expect((await inject('PATCH', `/api/agents/${a.id}`, [1])).statusCode).toBe(400)
    expect((await inject('PATCH', `/api/agents/${a.id}`, { memoryLearn: 'yes' })).statusCode).toBe(400)
    expect((await inject('PATCH', '/api/agents/nope', { name: 'x' })).statusCode).toBe(404)
    expect(store.agents.find((x) => x.id === a.id)?.name).toBe('Writer')
  })

  it('rejects wrong-typed fields with 400 instead of coercing them, and leaves the agent untouched', async () => {
    const a = await makeAgent('Writer')
    await inject('PATCH', `/api/agents/${a.id}`, { role: 'Drafts docs', skillIds: ['nope/nope'] })
    const before = structuredClone(store.agents.find((x) => x.id === a.id))
    const bad: Record<string, unknown>[] = [
      { skillIds: 'x' }, { skillIds: [1] }, { skillIds: null }, { role: 123 }, { role: null },
      { name: 5 }, { description: [] }, { instructions: {} }, { modelId: 1 }, { endpointId: false },
      { isPrimary: 'yes' }, { temperature: '1' }, { pinned: 'no' }, { rules: 'one' }, { internetPolicy: 1 },
    ]
    for (const patch of bad) {
      const res = await inject('PATCH', `/api/agents/${a.id}`, patch)
      expect(res.statusCode, JSON.stringify(patch)).toBe(400)
      expect(res.json()).toMatchObject({ statusCode: 400, error: 'Request Error' })
    }
    expect(store.agents.find((x) => x.id === a.id)).toEqual(before)
    // Unknown skill ids are still stored (decided earlier); null clears temperature.
    expect((await inject('PATCH', `/api/agents/${a.id}`, { temperature: 0.5 })).json()).toMatchObject({ temperature: 0.5, role: 'Drafts docs', skillIds: ['nope/nope'] })
    expect((await inject('PATCH', `/api/agents/${a.id}`, { temperature: null })).statusCode).toBe(200)
  })
})

describe('notes retirement', () => {
  it('answers /api/notes with 410', async () => {
    for (const url of ['/api/notes', '/api/notes/note_1']) {
      const res = await inject('GET', url)
      expect(res.statusCode).toBe(410)
      expect(res.json()).toEqual({ statusCode: 410, error: 'Request Error', message: NOTES_RETIRED })
    }
  })

  it('migrates every note into its author\'s memory, archiving them and writing long ones to a file', async () => {
    const path = join(dir, 'legacy', 'store.json')
    const ag = (id: string, name: string) => ({
      id, name, description: '', instructions: '', modelId: 'llama-3-8b', endpointId: 'ep_local_llama',
      role: '', skillIds: [], status: 'idle', createdAt: '2026-01-01T00:00:00.000Z', lastRunAt: null, runCount: 0,
    })
    const note = (id: string, title: string, b: string, author: string) => ({
      id, title, body: b, tags: [], authorAgentId: author, updatedByAgentId: author, runId: null,
      createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z',
    })
    const notes = [note('n1', 'Short', 'b', 'agt_a'), note('n2', 'Long', 'y'.repeat(900), 'agt_a'), note('n3', 'Other', 'c', 'agt_b')]
    rmSync(join(dir, 'legacy'), { recursive: true, force: true })
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(dir, 'legacy'), { recursive: true })
    writeFileSync(path, JSON.stringify({ agents: [ag('agt_a', 'Alpha'), ag('agt_b', 'Beta')], runs: [], notes, meta: { migrations: [], seededSkillIds: [] } }))

    const migrated = createStore(path)
    expect(migrated.notes ?? []).toHaveLength(0)
    expect(migrated.memories).toHaveLength(notes.length)
    expect(migrated.meta.migrations).toContain(NOTES_MIGRATION)
    const alpha = migrated.memories.filter((m) => m.scope.kind === 'agent' && m.scope.agentId === 'agt_a')
    expect(alpha.map((m) => m.text)).toContain('Short: b')
    const long = alpha.find((m) => m.text.startsWith('Long: '))!
    expect(long.text.length).toBeLessThanOrEqual(500)
    expect(long.text).toContain('(full note: workspace/notes/')
    expect(migrated.memories.every((m) => m.category === 'work')).toBe(true)

    const archive = readdirSync(join(dir, 'legacy', 'archive')).filter((f) => f.startsWith('notes-'))
    expect(archive).toHaveLength(1)
    const archived = JSON.parse(readFileSync(join(dir, 'legacy', 'archive', archive[0]!), 'utf8')) as { notes: unknown[] }
    expect(archived.notes).toHaveLength(notes.length)
    const slug = migrated.agents.find((x) => x.id === 'agt_a')!.slug
    const notesDir = join(dir, 'legacy', 'bots', slug, 'workspace', 'notes')
    expect(existsSync(notesDir)).toBe(true)
    const full = readdirSync(notesDir).map((f) => readFileSync(join(notesDir, f), 'utf8')).join('\n')
    expect(full).toContain('y'.repeat(900))

    // Idempotent on reboot.
    expect(createStore(path).memories).toHaveLength(notes.length)
  })
})
