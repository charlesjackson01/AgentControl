import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStore } from '../store.js'
import { builtinTools, executeToolCall, type ToolContext } from '../tools.js'
import { MAX_NOTE_CHARS, MAX_NOTE_WRITES, MAX_NOTES } from './notes.js'

let dir: string
let ctx: ToolContext
const call = (name: string, args: object = {}) => executeToolCall({ id: 'call', name, arguments: JSON.stringify(args) }, ctx)

beforeEach(() => {
  vi.stubEnv('AGENTCONTROL_SECRET', 'notes-test-secret')
  dir = mkdtempSync(join(tmpdir(), 'notes-tools-'))
  const store = createStore(join(dir, 'store.json'))
  store.agents.push({ id: 'author', name: 'Author', role: '', description: '', instructions: '',
    modelId: 'm', endpointId: 'ep_local_llama', skillIds: [], isPrimary: true,
    status: 'idle', createdAt: '', lastRunAt: null, runCount: 0 })
  store.agents.push({ ...store.agents[0]!, id: 'other', isPrimary: false })
  ctx = { store, agentId: 'author', runId: 'run1', input: 'Exact_input with underscores',
    allowed: new Set(builtinTools.keys()), now: () => new Date('2026-10-11T12:00:00Z'),
    timeZone: 'UTC', writes: { count: 0 } }
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }) })

describe('shared notes', () => {
  it('persists input references and provenance across restart; reads by title and searches tags', async () => {
    expect((await call('save_note', { title: 'Decision', tags: 'api, release' })).ok).toBe(true)
    const reloaded = createStore(join(dir, 'store.json'))
    expect(reloaded.notes[0]).toMatchObject({ title: 'Decision', body: ctx.input, tags: ['api', 'release'], authorAgentId: 'author', runId: 'run1' })
    const read = JSON.parse((await call('read_note', { note: 'decision' })).content)
    expect(read.body).toBe(ctx.input)
    expect(read.untrusted).toBe(true)
    const result = JSON.parse((await call('list_notes', { query: 'underscores', tag: 'API', limit: '5' })).content)
    expect(result.total).toBe(1)
    expect(result.notes[0]).not.toHaveProperty('body')
  })

  it('only lets the author replace; another agent can append without changing ownership', async () => {
    await call('save_note', { title: 'Decision', body: 'First' })
    ctx.agentId = 'other'
    ctx.runId = 'run2'
    expect((await call('save_note', { mode: 'replace', note: 'Decision', body: 'Override' })).ok).toBe(false)
    expect((await call('save_note', { mode: 'append', note: 'Decision', body: 'Second', title: 'Hijack' })).ok).toBe(false)
    expect((await call('save_note', { mode: 'append', note: 'Decision', body: 'Second' })).ok).toBe(true)
    expect(ctx.store.notes[0]).toMatchObject({ body: 'First\n\nSecond', authorAgentId: 'author', updatedByAgentId: 'other', runId: 'run2' })
    ctx.agentId = 'author'
    expect((await call('save_note', { mode: 'replace', note: 'Decision', body: 'Final' })).ok).toBe(true)
    expect(ctx.store.notes[0]?.body).toBe('Final')
  })

  it('refuses hidden writes and note reference access without read_note permission', async () => {
    await call('save_note', { title: 'Original', body: 'Secret plan' })
    ctx.allowed = new Set(['save_note'])
    expect((await call('save_note', { title: 'Copy', body: '@note:Original' })).ok).toBe(false)
    ctx.allowed = new Set(['read_note'])
    expect((await call('save_note', { title: 'Hidden', body: 'No' })).ok).toBe(false)
    expect(ctx.store.notes).toHaveLength(1)
  })

  it('rolls back failed creates and replacements without consuming write allowance', async () => {
    await call('save_note', { title: 'Decision', body: 'Before' })
    const previous = ctx.store.notes
    vi.spyOn(ctx.store, 'save').mockReturnValue(false)
    expect((await call('save_note', { title: 'Unsaved', body: 'No' })).ok).toBe(false)
    expect(ctx.store.notes).toBe(previous)
    expect((await call('save_note', { mode: 'replace', note: 'Decision', body: 'After' })).ok).toBe(false)
    expect(ctx.store.notes).toBe(previous)
    expect(ctx.writes.count).toBe(1)
    expect(createStore(join(dir, 'store.json')).notes[0]?.body).toBe('Before')
  })

  it('enforces write, size, uniqueness and workspace count limits', async () => {
    expect((await call('save_note', { title: 'Blank', body: '  ' })).ok).toBe(false)
    expect((await call('save_note', { title: 'Large', body: 'x'.repeat(MAX_NOTE_CHARS + 1) })).ok).toBe(false)
    await call('save_note', { title: 'Decision', body: 'x'.repeat(MAX_NOTE_CHARS) })
    expect((await call('save_note', { title: ' decision ', body: 'Duplicate' })).ok).toBe(false)
    expect((await call('save_note', { mode: 'append', note: 'Decision', body: 'More' })).ok).toBe(false)
    for (let i = 1; i < MAX_NOTE_WRITES; i++) expect((await call('save_note', { title: `N${i}`, body: 'ok' })).ok).toBe(true)
    expect((await call('save_note', { title: 'Too many', body: 'no' })).ok).toBe(false)
    ctx.writes.count = 0
    ctx.store.notes = Array.from({ length: MAX_NOTES }, (_, i) => ({ ...ctx.store.notes[0]!, id: `n${i}`, title: `Note${i}` }))
    expect((await call('save_note', { title: 'Full', body: 'no' })).ok).toBe(false)
  })

  it('redacts secrets from reads without changing stored bodies', async () => {
    const key = 'sk-test_1234567890abcdefgh'
    ctx.store.endpointKeys.ep_local_llama = key
    await call('save_note', { title: 'Sensitive', body: key })
    const read = await call('read_note', { note: 'Sensitive' })
    expect(read.content).not.toContain(key)
    expect(read.content).toContain('[redacted]')
    expect(ctx.store.notes[0]?.body).toBe(key)
  })

  it('redacts JSON-escaped secrets and short configured auth tokens', async () => {
    const key = 'secret"with\\slash\nand-newline'
    ctx.store.endpointKeys.ep_local_llama = key
    vi.stubEnv('AGENTCONTROL_AUTH_TOKEN', 'tiny')
    await call('save_note', { title: 'Sensitive', body: `${key} tiny` })
    const read = JSON.parse((await call('read_note', { note: 'Sensitive' })).content)
    expect(read.body).toBe('[redacted] [redacted]')
  })

  it('keeps the previous disk snapshot when the vault cannot save', async () => {
    await call('save_note', { title: 'Decision', body: 'Before' })
    const path = join(dir, 'store.json')
    const saved = readFileSync(path, 'utf8')
    rmSync(join(dir, 'vault.enc'))
    mkdirSync(join(dir, 'vault.enc'))
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect((await call('save_note', { mode: 'replace', note: 'Decision', body: 'After' })).ok).toBe(false)
    expect(ctx.store.notes[0]?.body).toBe('Before')
    expect(readFileSync(path, 'utf8')).toBe(saved)
    expect(log).toHaveBeenCalled()
  })

  it('caps recovery messages even when the available tool list is large', async () => {
    ctx.allowed = new Set(Array.from({ length: 200 }, (_, i) => `long_tool_name_${i}`))
    const outcome = await call('unknown_tool')
    expect(outcome.ok).toBe(false)
    expect(outcome.content.length).toBeLessThanOrEqual(3500)
    expect(outcome.content).toContain('Unknown tool')
  })
})
