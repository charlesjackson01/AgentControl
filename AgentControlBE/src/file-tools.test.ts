import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from './app.js'
import { createFileService } from './file-service.js'
import type { Agent, AgentRun, Endpoint, FileListing } from './shared/types.js'
import { createStore, type WorkspaceStore } from './store.js'
import { executeToolCall } from './tools.js'
import { FILE_TOOL_NAMES } from './tools/files.js'
import type { RunActivity, ToolContext } from './tools/types.js'

let dir = ''
let app: FastifyInstance
let store: WorkspaceStore
let endpointId = ''

const inject = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as object | undefined, headers: { 'content-type': 'application/json' } })

async function makeBot(name: string): Promise<Agent> {
  const res = await inject('POST', '/api/agents', { name, description: '', instructions: '', modelId: 'test-model', endpointId, skillIds: [] })
  expect(res.statusCode).toBe(201)
  return res.json() as Agent
}
const root = (a: Agent) => join(dir, 'bots', a.slug)

function ctxFor(agent: Agent, group?: { slug: string }): ToolContext & { activity: RunActivity } {
  return {
    store, agentId: agent.id, runId: 'run_test', input: '', allowed: new Set<string>(FILE_TOOL_NAMES),
    now: () => new Date(), timeZone: 'UTC', writes: { count: 0 },
    files: createFileService(store, agent, group),
    activity: { steps: [], filesChanged: [] },
  } as ToolContext & { activity: RunActivity }
}
const call = (ctx: ToolContext, name: string, args: Record<string, unknown>) =>
  executeToolCall({ id: 'c1', name, arguments: JSON.stringify(args) }, ctx)

beforeEach(async () => {
  process.env.AGENTCONTROL_SECRET = 'test-secret'
  dir = mkdtempSync(join(tmpdir(), 'agentcontrol-filetools-'))
  store = createStore(join(dir, 'store.json'))
  app = buildApp(store)
  const ep = await inject('POST', '/api/endpoints', { kind: 'openai-compatible', name: 'E', baseUrl: 'http://127.0.0.1:9', defaultModel: 'test-model', contextWindow: 32768 })
  endpointId = (ep.json() as Endpoint).id
})
afterEach(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  await app.close()
  rmSync(dir, { recursive: true, force: true })
  delete process.env.AGENTCONTROL_SECRET
})

describe('file tools: isolation and zones', () => {
  it("a bot sees only its own folder, never another bot's", async () => {
    const a = await makeBot('Alpha')
    const b = await makeBot('Beta')
    writeFileSync(join(root(b), 'shared', 'secret.md'), 'beta only')
    writeFileSync(join(root(a), 'shared', 'mine.md'), 'alpha')
    const ctx = ctxFor(a)
    const listed = await call(ctx, 'list_files', { path: 'shared/' })
    expect(listed.ok).toBe(true)
    expect(listed.content).toContain('shared/mine.md')
    expect(listed.content).not.toContain('secret.md')
    for (const path of ['shared/secret.md', `../${b.slug}/shared/secret.md`, `/bots/${b.slug}/shared/secret.md`]) {
      const read = await call(ctx, 'read_file', { path })
      expect(read.ok).toBe(false)
      expect(read.content).not.toContain('beta only')
    }
    const hits = await call(ctx, 'search_files', { query: 'beta' })
    expect(hits.content).not.toContain('secret.md')
  })

  it('refuses group: paths without a group in the run', async () => {
    const a = await makeBot('Alpha')
    const out = await call(ctxFor(a), 'list_files', { path: 'group:shared/' })
    expect(out.ok).toBe(false)
    expect(out.content).toContain('no group in this conversation')
  })

  it("reads and writes group:shared/ in a group run, and nothing else of the group's", async () => {
    const a = await makeBot('Alpha')
    mkdirSync(join(dir, 'groups', 'crew', 'shared'), { recursive: true })
    mkdirSync(join(dir, 'groups', 'crew', 'private'), { recursive: true })
    const ctx = ctxFor(a, { slug: 'crew' })
    expect((await call(ctx, 'write_file', { path: 'group:shared/plan.md', content: 'hi' })).ok).toBe(true)
    expect(readFileSync(join(dir, 'groups', 'crew', 'shared', 'plan.md'), 'utf8')).toBe('hi')
    expect((await call(ctx, 'list_files', { path: 'group:private/' })).ok).toBe(false)
    expect((await call(ctx, 'list_files', {})).content).toContain('group:shared')
  })

  it.each([['shared/x.md'], ['memory/MEMORY.md'], ['BOT.md'], ['workspace']])('refuses writes to %j', async (path) => {
    const a = await makeBot('Alpha')
    const out = await call(ctxFor(a), 'write_file', { path, content: 'x', mode: 'overwrite' })
    expect(out.ok).toBe(false)
    expect(out.content).toContain('You can only write inside workspace/')
  })

  it('never sends an absolute server path', async () => {
    const a = await makeBot('Alpha')
    const ctx = ctxFor(a)
    for (const [name, args] of [['list_files', {}], ['read_file', { path: 'workspace/nope.md' }], ['write_file', { path: 'workspace/a.md', content: 'x' }], ['list_files', { path: '/etc' }]] as const) {
      const out = await call(ctx, name, args as Record<string, unknown>)
      expect(out.content).not.toContain(dir)
    }
  })
})

describe('file tools: read, search, write', () => {
  it('pages long text with a next hint and returns details only for binary files', async () => {
    const a = await makeBot('Alpha')
    writeFileSync(join(root(a), 'workspace', 'long.txt'), 'a'.repeat(9000) + 'END')
    writeFileSync(join(root(a), 'workspace', 'pic.bin'), Buffer.from([0x89, 0x50, 0x00, 0x01]))
    const ctx = ctxFor(a)
    const first = await call(ctx, 'read_file', { path: 'workspace/long.txt' })
    expect(first.content).toContain('chars 1-')
    expect(first.content).toContain('Next: read_file {"path":"workspace/long.txt","offset":')
    const offset = Number(/"offset":(\d+)/.exec(first.content)![1])
    const second = await call(ctx, 'read_file', { path: 'workspace/long.txt', offset })
    expect(second.content).toContain('the end.')
    expect(second.content.endsWith('END')).toBe(true)
    const bin = await call(ctx, 'read_file', { path: 'workspace/pic.bin' })
    expect(bin.ok).toBe(true)
    expect(JSON.parse(bin.content)).toMatchObject({ path: 'workspace/pic.bin', size: 4, binary: true })
  })

  it('searches names and text, reporting line numbers', async () => {
    const a = await makeBot('Alpha')
    writeFileSync(join(root(a), 'shared', 'invoice-q3.md'), 'nothing here')
    writeFileSync(join(root(a), 'workspace', 'notes.md'), 'line one\nthe invoice is late\n')
    const out = JSON.parse((await call(ctxFor(a), 'search_files', { query: 'invoice' })).content) as { hits: { path: string; match: string; line?: number }[] }
    expect(out.hits).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'shared/invoice-q3.md', match: 'name' }),
      expect.objectContaining({ path: 'workspace/notes.md', match: 'text', line: 2 }),
    ]))
  })

  it('create never clobbers, overwrite replaces, append adds', async () => {
    const a = await makeBot('Alpha')
    const ctx = ctxFor(a)
    const file = join(root(a), 'workspace', 'log.md')
    expect((await call(ctx, 'write_file', { path: 'workspace/log.md', content: 'one' })).ok).toBe(true)
    const again = await call(ctx, 'write_file', { path: 'workspace/log.md', content: 'two', mode: 'create' })
    expect(again.ok).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe('one')
    expect((await call(ctx, 'write_file', { path: 'workspace/log.md', content: 'two', mode: 'overwrite' })).ok).toBe(true)
    expect((await call(ctx, 'write_file', { path: 'workspace/log.md', content: '+3', mode: 'append' })).ok).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe('two+3')
    expect(ctx.activity.filesChanged).toEqual([{ path: 'workspace/log.md', change: 'added', bytes: 5, modifiedAt: expect.any(String) }])
    expect((await call(ctx, 'make_folder', { path: 'workspace/drafts' })).ok).toBe(true)
    expect(existsSync(join(root(a), 'workspace', 'drafts'))).toBe(true)
  })

  it('refuses to read or write through a symlink', async () => {
    const a = await makeBot('Alpha')
    writeFileSync(join(dir, 'outside.txt'), 'outside')
    symlinkSync(join(dir, 'outside.txt'), join(root(a), 'workspace', 'link.txt'))
    const ctx = ctxFor(a)
    const read = await call(ctx, 'read_file', { path: 'workspace/link.txt' })
    expect(read.ok).toBe(false)
    expect(read.content).not.toContain('outside')
    expect((await call(ctx, 'write_file', { path: 'workspace/link.txt', content: 'x', mode: 'append' })).ok).toBe(false)
    expect((await call(ctx, 'write_file', { path: 'workspace/link.txt', content: 'x', mode: 'overwrite' })).ok).toBe(false)
    expect(readFileSync(join(dir, 'outside.txt'), 'utf8')).toBe('outside')
  })
})

describe('quota, trash and listing (BE-3)', () => {
  it('counts trash toward usage and prunes the oldest trash batch to make room', async () => {
    vi.stubEnv('AGENTCONTROL_BOT_QUOTA_BYTES', '3000')
    const a = await makeBot('Alpha')
    const base = (await inject('GET', `/api/agents/${a.id}/files`)).json() as FileListing
    const trash = join(dir, 'archive', 'trash', a.slug)
    mkdirSync(join(trash, '2026-01-01T00-00-00Z', 'workspace'), { recursive: true })
    mkdirSync(join(trash, '2026-02-01T00-00-00Z', 'workspace'), { recursive: true })
    writeFileSync(join(trash, '2026-01-01T00-00-00Z', 'workspace', 'old.md'), 'o'.repeat(1000))
    writeFileSync(join(trash, '2026-02-01T00-00-00Z', 'workspace', 'newer.md'), 'n'.repeat(500))
    const listed = (await inject('GET', `/api/agents/${a.id}/files`)).json() as FileListing
    expect(listed.usage.trashBytes).toBe(1500)
    expect(listed.usage.bytes).toBe(base.usage.bytes + 1500)
    const room = 3000 - base.usage.bytes - 1500
    const out = await call(ctxFor(a), 'write_file', { path: 'workspace/big.md', content: 'b'.repeat(room + 10) })
    expect(out.ok).toBe(true)
    expect(existsSync(join(trash, '2026-01-01T00-00-00Z'))).toBe(false)
    expect(existsSync(join(trash, '2026-02-01T00-00-00Z'))).toBe(true)
    const tooBig = await call(ctxFor(a), 'write_file', { path: 'workspace/huge.md', content: 'h'.repeat(3000) })
    expect(tooBig.ok).toBe(false)
    expect(tooBig.content).toContain('limit')
  })

  it('reports totalFiles across the whole bot folder, excluding trash', async () => {
    const a = await makeBot('Alpha')
    const before = ((await inject('GET', `/api/agents/${a.id}/files`)).json() as FileListing).totalFiles
    mkdirSync(join(root(a), 'workspace', 'deep', 'er'), { recursive: true })
    writeFileSync(join(root(a), 'workspace', 'deep', 'er', 'a.md'), 'a')
    writeFileSync(join(root(a), 'shared', 'b.md'), 'b')
    mkdirSync(join(dir, 'archive', 'trash', a.slug, 'x'), { recursive: true })
    writeFileSync(join(dir, 'archive', 'trash', a.slug, 'x', 'gone.md'), 'g')
    const listing = (await inject('GET', `/api/agents/${a.id}/files`)).json() as FileListing
    expect(listing.totalFiles).toBe(before + 2)
  })

  it('404s a missing path with the new wording', async () => {
    const a = await makeBot('Alpha')
    const res = await inject('GET', `/api/agents/${a.id}/files?path=${encodeURIComponent('workspace/nope')}`)
    expect(res.statusCode).toBe(404)
    expect((res.json() as { message: string }).message).toBe('Nothing at "workspace/nope" in this bot\'s files.')
  })
})

describe('run activity (BE-3)', () => {
  it('puts file steps and filesChanged (with bytes and modifiedAt) on the run and the DM reply', async () => {
    const a = await makeBot('Alpha')
    const responses: unknown[] = [
      { choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'workspace/summary.md', content: '# Hi' }) } }] } }] },
      { choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: '', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'workspace/summary.md' }) } }] } }] },
      { choices: [{ index: 0, message: { role: 'assistant', content: 'Saved it.' } }] },
    ]
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => responses.shift() })))
    const run = (await inject('POST', `/api/agents/${a.id}/runs`, { input: 'Write a summary.' })).json() as AgentRun
    expect(run.status).toBe('succeeded')
    const expected = {
      steps: [
        { tool: 'write_file', summary: 'Created workspace/summary.md', ok: true, path: 'workspace/summary.md' },
        { tool: 'read_file', summary: 'Read workspace/summary.md', ok: true, path: 'workspace/summary.md' },
      ],
      filesChanged: [{ path: 'workspace/summary.md', change: 'added', bytes: 4, modifiedAt: expect.any(String) }],
    }
    expect(run.activity).toEqual(expected)
    const reply = store.chatMessages.find((m) => m.runId === run.id && m.role === 'assistant')
    expect(reply?.activity).toEqual({ skills: [], ...expected })
  })
})

describe('failed runs and steps (BE-3 review)', () => {
  const toolCall = (id: string, name: string, args: unknown) => ({ ok: true, status: 200, json: async () => ({ choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }), text: async () => '' })
  const reply = (content: string) => ({ ok: true, status: 200, json: async () => ({ choices: [{ index: 0, message: { role: 'assistant', content } }] }), text: async () => '' })
  const err = (status: number, body: string) => ({ ok: false, status, json: async () => ({}), text: async () => body })
  const PEG = '{"error":{"code":500,"message":"Failed to parse input: output that does not match the expected peg-native format"}}'
  function script(responses: unknown[]) {
    const mock = vi.fn(async () => responses.shift() ?? reply('done'))
    vi.stubGlobal('fetch', mock)
    return mock
  }
  const dmReply = (run: AgentRun) => store.chatMessages.find((m) => m.runId === run.id && m.role === 'assistant')

  it("words a failed step as Couldn't …", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const a = await makeBot('Alpha')
    script([toolCall('c1', 'write_file', { path: 'memory/x.md', content: 'x' }), reply('ok')])
    const run = (await inject('POST', `/api/agents/${a.id}/runs`, { input: 'go' })).json() as AgentRun
    expect(run.activity?.steps).toEqual([{ tool: 'write_file', summary: "Couldn't write memory/x.md", ok: false, path: 'memory/x.md' }])
    expect(run.activity?.filesChanged).toEqual([])
    expect(run.filesChanged).toEqual([])
  })

  it('keeps activity.filesChanged on a failed run and its DM reply', async () => {
    const a = await makeBot('Alpha')
    script([toolCall('c1', 'write_file', { path: 'workspace/notes/todo.md', content: '- a' }), err(503, 'busy')])
    const run = (await inject('POST', `/api/agents/${a.id}/runs`, { input: 'go' })).json() as AgentRun
    expect(run.status).toBe('failed')
    const changed = [{ path: 'workspace/notes/todo.md', change: 'added', bytes: 3, modifiedAt: expect.any(String) }]
    expect(run.activity?.filesChanged).toEqual(changed)
    expect(run.filesChanged).toEqual(changed)
    expect(dmReply(run)?.activity?.filesChanged).toEqual(changed)
    const listed = (await inject('GET', `/api/agents/${a.id}/runs`)).json() as AgentRun[]
    expect(listed[0]?.filesChanged).toEqual(changed)
  })

  it('retries a malformed-tool-call 500 once, then carries on', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const a = await makeBot('Alpha')
    const mock = script([err(500, PEG), toolCall('c1', 'list_files', {}), reply('Here you go.')])
    const run = (await inject('POST', `/api/agents/${a.id}/runs`, { input: 'go' })).json() as AgentRun
    expect(run.status).toBe('succeeded')
    expect(run.output).toBe('Here you go.')
    expect(mock).toHaveBeenCalledTimes(3)
    expect(warn.mock.calls.some((c) => String(c[0]).includes('retrying once'))).toBe(true)
  })

  it('retries only once per run, and never other 5xx errors', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const a = await makeBot('Alpha')
    const twice = script([err(500, PEG), err(500, PEG)])
    const run = (await inject('POST', `/api/agents/${a.id}/runs`, { input: 'go' })).json() as AgentRun
    expect(run.status).toBe('failed')
    expect(run.error).toContain('peg-native')
    expect(twice).toHaveBeenCalledTimes(2)
    const other = script([err(500, 'Internal Server Error')])
    expect(((await inject('POST', `/api/agents/${a.id}/runs`, { input: 'go' })).json() as AgentRun).status).toBe('failed')
    expect(other).toHaveBeenCalledTimes(1)
  })
})
