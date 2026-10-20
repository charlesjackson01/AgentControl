import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from './app.js'
import { assertWritable, guardedPath, parseClientPath } from './files.js'
import type { Agent, Endpoint, FileEntry, FileListing } from './shared/types.js'
import { createStore, type WorkspaceStore } from './store.js'

let dir = ''
let app: FastifyInstance
let store: WorkspaceStore
let endpointId = ''

const json = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as object | undefined, headers: { 'content-type': 'application/json' } })
const put = (url: string, body: string | Buffer, type = 'application/octet-stream') =>
  app.inject({ method: 'PUT', url, payload: body, headers: { 'content-type': type } })
const q = encodeURIComponent

async function makeBot(name: string): Promise<Agent> {
  const res = await json('POST', '/api/agents', { name, description: 'Harbor work', instructions: 'Be brief.', modelId: 'test-model', endpointId, skillIds: ['core/summarization'], rules: ['Cite sources.'] })
  expect(res.statusCode).toBe(201)
  return res.json() as Agent
}
const root = (a: Agent) => join(dir, 'bots', a.slug)

beforeEach(async () => {
  process.env.AGENTCONTROL_SECRET = 'test-secret'
  dir = mkdtempSync(join(tmpdir(), 'agentcontrol-files-'))
  store = createStore(join(dir, 'store.json'))
  app = buildApp(store)
  const ep = await json('POST', '/api/endpoints', { kind: 'openai-compatible', name: 'E', baseUrl: 'http://127.0.0.1:9', defaultModel: 'test-model', contextWindow: 8192 })
  endpointId = (ep.json() as Endpoint).id
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await app.close()
  rmSync(dir, { recursive: true, force: true })
  delete process.env.AGENTCONTROL_SECRET
})

describe('path guard', () => {
  it.each([
    ['/etc/passwd'], ['C:/x'], ['shared/../../x'], ['..'], ['shared/./a'], ['shared//a'], ['shared\\a'], ['shared/a\0b'], ['shared/\u0007'], ['x'.repeat(1025)],
  ])('rejects %j with 400', (p) => {
    expect(() => parseClientPath(p)).toThrowError(expect.objectContaining({ statusCode: 400 }))
  })

  it.each([
    ['', []], ['/', []], ['shared', ['shared']], ['shared/', ['shared']], ['workspace/briefs/a b.md', ['workspace', 'briefs', 'a b.md']], ['shared/…naïve.txt', ['shared', '…naïve.txt']],
  ])('accepts %j', (p, parts) => {
    expect(parseClientPath(p)).toEqual(parts)
  })

  it.each([[['shared']], [['workspace']], [['memory', 'MEMORY.md']], [['BOT.md']], [['skills', 'x']], [[]]])('refuses writes to %j with 403', (parts) => {
    expect(() => assertWritable(parts)).toThrowError(expect.objectContaining({ statusCode: 403 }))
  })

  it('refuses any symlink segment, even one pointing inside the root', () => {
    const r = join(dir, 'guard')
    mkdirSync(join(r, 'shared', 'real'), { recursive: true })
    symlinkSync(join(r, 'shared', 'real'), join(r, 'shared', 'inside'))
    symlinkSync('/etc', join(r, 'shared', 'out'))
    expect(guardedPath(r, ['shared', 'real', 'new.txt'])).toBe(join(r, 'shared', 'real', 'new.txt'))
    for (const parts of [['shared', 'inside', 'a'], ['shared', 'out', 'passwd'], ['shared', 'out']]) {
      expect(() => guardedPath(r, parts)).toThrowError(expect.objectContaining({ statusCode: 400 }))
    }
  })
})

describe('bot folder lifecycle', () => {
  it('creates the tree on bot create, with generated BOT.md and memory/MEMORY.md', async () => {
    const bot = await makeBot('Harbor')
    expect(readdirSync(root(bot)).sort()).toEqual(['BOT.md', 'memory', 'shared', 'workspace'])
    const md = readFileSync(join(root(bot), 'BOT.md'), 'utf8')
    expect(md).toContain('# Harbor')
    expect(md).toContain('Be brief.')
    expect(md).toContain('- Cite sources.')
    expect(readFileSync(join(root(bot), 'memory', 'MEMORY.md'), 'utf8')).toContain('(nothing yet)')
  })

  it('creates folders for existing bots on boot, and they survive a restart', async () => {
    const bot = await makeBot('Harbor')
    await put(`/api/agents/${bot.id}/files/content?path=${q('workspace/briefs/a.md')}`, 'hello')
    rmSync(join(root(bot), 'shared'), { recursive: true })
    await app.close()
    app = buildApp(createStore(join(dir, 'store.json')))
    expect(existsSync(join(root(bot), 'shared'))).toBe(true)
    const read = await app.inject({ method: 'GET', url: `/api/agents/${bot.id}/files/content?path=${q('workspace/briefs/a.md')}` })
    expect(read.body).toBe('hello')
  })

  it('moves a deleted bot\'s folder to data/archive/bots/<slug>-<ts>/ and never removes it', async () => {
    await makeBot('Lead')
    const bot = await makeBot('Harbor')
    await put(`/api/agents/${bot.id}/files/content?path=${q('shared/x.txt')}`, 'keep me')
    expect((await json('DELETE', `/api/agents/${bot.id}`)).statusCode).toBe(204)
    expect(existsSync(root(bot))).toBe(false)
    const archived = readdirSync(join(dir, 'archive', 'bots'))
    expect(archived).toHaveLength(1)
    expect(archived[0]).toMatch(/^harbor-\d{4}-\d\d-\d\dT[\d-]+Z$/)
    expect(readFileSync(join(dir, 'archive', 'bots', archived[0]!, 'shared', 'x.txt'), 'utf8')).toBe('keep me')
  })
})

describe('Files API', () => {
  let bot: Agent
  const base = () => `/api/agents/${bot.id}/files`
  beforeEach(async () => { bot = await makeBot('Primary') })

  it('lists the root one level deep, with zones, the bots/<slug>/ root and usage', async () => {
    const res = await json('GET', base())
    expect(res.statusCode).toBe(200)
    const listing = res.json() as FileListing
    expect(listing.root).toBe('bots/primary/')
    expect(listing.path).toBe('')
    expect(listing.entries.map((e) => [e.path, e.kind, e.zone])).toEqual([
      ['memory', 'dir', 'memory'], ['shared', 'dir', 'shared'], ['skills', 'dir', 'skills'], ['workspace', 'dir', 'workspace'], ['BOT.md', 'file', 'meta'],
    ])
    expect(listing.usage.quotaBytes).toBe(500 * 1024 * 1024)
    expect(listing.usage.bytes).toBeGreaterThan(0)
    expect(res.body).not.toContain(dir)
  })

  it('serves skills/ as a read-only virtual listing of enabled skills', async () => {
    const listing = (await json('GET', `${base()}?path=skills`)).json() as FileListing
    expect(listing.entries.map((e) => e.path)).toEqual(['skills/core'])
    const core = (await json('GET', `${base()}?path=skills/core/summarization`)).json() as FileListing
    expect(core.entries.map((e) => [e.name, e.zone])).toEqual([['SKILL.md', 'skills']])
    const md = await json('GET', `${base()}/content?path=skills/core/summarization/SKILL.md`)
    expect(md.statusCode).toBe(200)
    expect(md.body).toBe(store.skills.find((s) => s.id === 'core/summarization')!.content)
    expect(existsSync(join(root(bot), 'skills'))).toBe(false)
    expect((await put(`${base()}/content?path=skills/core/x.md`, 'x')).statusCode).toBe(403)
    expect((await json('GET', `${base()}?path=skills/core/code-review`)).statusCode).toBe(404)
  })

  it('PUT writes shared/ and workspace/ files, 409s on an existing one unless overwrite=1', async () => {
    const first = await put(`${base()}/content?path=${q('shared/photos/pier.png')}`, Buffer.from([1, 2, 3]), 'image/png')
    expect(first.statusCode).toBe(201)
    expect(first.json()).toMatchObject({ path: 'shared/photos/pier.png', name: 'pier.png', kind: 'file', size: 3, mime: 'image/png', zone: 'shared' })
    expect((await put(`${base()}/content?path=${q('shared/photos/pier.png')}`, 'again')).statusCode).toBe(409)
    const over = await put(`${base()}/content?path=${q('shared/photos/pier.png')}&overwrite=1`, 'again')
    expect(over.statusCode).toBe(201)
    expect((over.json() as FileEntry).size).toBe(5)
    expect((await put(`${base()}/content?path=${q('workspace/todo.md')}`, '# todo', 'text/markdown')).statusCode).toBe(201)
    expect((await put(`${base()}/content?path=BOT.md&overwrite=1`, 'x')).statusCode).toBe(403)
    expect((await put(`${base()}/content?path=memory/MEMORY.md&overwrite=1`, 'x')).statusCode).toBe(403)
    expect((await put(`${base()}/content?path=shared`, 'x')).statusCode).toBe(403)
    expect((await put(`${base()}/content`, 'x')).statusCode).toBe(400)
  })

  it('GET content returns bytes with the right type, and a download disposition', async () => {
    await put(`${base()}/content?path=${q('workspace/notes été.txt')}`, 'héllo')
    const inline = await json('GET', `${base()}/content?path=${q('workspace/notes été.txt')}`)
    expect(inline.statusCode).toBe(200)
    expect(inline.headers['content-type']).toBe('text/plain; charset=utf-8')
    expect(inline.headers['x-content-type-options']).toBe('nosniff')
    expect(String(inline.headers['content-security-policy'])).toContain('sandbox')
    expect(inline.body).toBe('héllo')
    const dl = await json('GET', `${base()}/content?path=${q('workspace/notes été.txt')}&download=1`)
    expect(dl.headers['content-disposition']).toBe(`attachment; filename="notes _t_.txt"; filename*=UTF-8''${q('notes été.txt')}`)
    expect(inline.headers['content-disposition']).toMatch(/^inline; /)
    expect((await json('GET', `${base()}/content?path=workspace/missing.txt`)).statusCode).toBe(404)
    expect((await json('GET', `${base()}/content?path=workspace`)).statusCode).toBe(400)
  })

  it('GET /files/shared lists every shared file flat, newest first', async () => {
    await put(`${base()}/content?path=shared/a.txt`, 'a')
    await put(`${base()}/content?path=${q('shared/site-photos/b.png')}`, 'b')
    await new Promise((r) => setTimeout(r, 15))
    await put(`${base()}/content?path=shared/c.pdf`, 'c')
    const res = await json('GET', `${base()}/shared`)
    const paths = (res.json() as { entries: FileEntry[] }).entries.map((e) => e.path)
    expect(paths[0]).toBe('shared/c.pdf')
    expect(paths.sort()).toEqual(['shared/a.txt', 'shared/c.pdf', 'shared/site-photos/b.png'])
  })

  it('POST folders creates a folder (201), 409 when it exists, 403 outside the writable zones', async () => {
    const res = await json('POST', `${base()}/folders`, { path: 'workspace/drafts' })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ path: 'workspace/drafts', kind: 'dir', size: 0, zone: 'workspace' })
    expect((await json('POST', `${base()}/folders`, { path: 'workspace/drafts' })).statusCode).toBe(409)
    expect((await json('POST', `${base()}/folders`, { path: 'memory/x' })).statusCode).toBe(403)
    expect((await json('POST', `${base()}/folders`, { path: '../x' })).statusCode).toBe(400)
    expect((await json('POST', `${base()}/folders`, {})).statusCode).toBe(400)
  })

  it('PATCH renames and moves inside shared/ and workspace/', async () => {
    await put(`${base()}/content?path=shared/a.txt`, 'a')
    await put(`${base()}/content?path=shared/b.txt`, 'b')
    const moved = await json('PATCH', base(), { from: 'shared/a.txt', to: 'workspace/in/a2.txt' })
    expect(moved.statusCode).toBe(200)
    expect(moved.json()).toMatchObject({ path: 'workspace/in/a2.txt', zone: 'workspace' })
    expect(readFileSync(join(root(bot), 'workspace', 'in', 'a2.txt'), 'utf8')).toBe('a')
    expect((await json('PATCH', base(), { from: 'shared/b.txt', to: 'workspace/in/a2.txt' })).statusCode).toBe(409)
    expect((await json('PATCH', base(), { from: 'shared/nope.txt', to: 'shared/x.txt' })).statusCode).toBe(404)
    expect((await json('PATCH', base(), { from: 'BOT.md', to: 'shared/BOT.md' })).statusCode).toBe(403)
    expect((await json('PATCH', base(), { from: 'shared/b.txt', to: 'memory/b.txt' })).statusCode).toBe(403)
    expect((await json('PATCH', base(), { from: 'workspace', to: 'shared/w' })).statusCode).toBe(403)
    expect((await json('PATCH', base(), { from: 'workspace/in', to: 'workspace/in/deeper' })).statusCode).toBe(400)
  })

  it('DELETE moves the file to data/archive/trash/<slug>/ (204)', async () => {
    await put(`${base()}/content?path=${q('workspace/briefs/x.md')}`, 'x')
    const res = await json('DELETE', `${base()}?path=${q('workspace/briefs/x.md')}`)
    expect(res.statusCode).toBe(204)
    expect(existsSync(join(root(bot), 'workspace', 'briefs', 'x.md'))).toBe(false)
    const trash = join(dir, 'archive', 'trash', 'primary')
    const [stamp] = readdirSync(trash)
    expect(readFileSync(join(trash, stamp!, 'workspace', 'briefs', 'x.md'), 'utf8')).toBe('x')
    expect((await json('DELETE', `${base()}?path=workspace/briefs/x.md`)).statusCode).toBe(404)
    expect((await json('DELETE', `${base()}?path=workspace`)).statusCode).toBe(403)
    expect((await json('DELETE', `${base()}?path=BOT.md`)).statusCode).toBe(403)
  })

  it('every traversal and symlink attack returns 400 or 403 on every route', async () => {
    symlinkSync('/etc', join(root(bot), 'shared', 'etc'))
    writeFileSync(join(dir, 'secret.txt'), 'secret')
    symlinkSync(join(dir, 'secret.txt'), join(root(bot), 'workspace', 'secret.txt'))
    const bad = ['../store.json', '../../store.json', '/etc/passwd', 'shared/../../../store.json', 'shared\\..\\x', 'shared/etc/passwd', 'workspace/secret.txt', 'shared/%00x', 'shared/etc']
    for (const raw of bad) {
      const p = raw === 'shared/%00x' ? raw : q(raw)
      const codes = [
        (await json('GET', `${base()}?path=${p}`)).statusCode,
        (await json('GET', `${base()}/content?path=${p}`)).statusCode,
        (await put(`${base()}/content?path=${p}&overwrite=1`, 'pwn')).statusCode,
        (await json('DELETE', `${base()}?path=${p}`)).statusCode,
        (await json('PATCH', base(), { from: decodeURIComponent(p), to: 'shared/stolen' })).statusCode,
        (await json('PATCH', base(), { from: 'shared', to: decodeURIComponent(p) })).statusCode,
      ]
      for (const c of codes) expect([400, 403], `${raw}: ${codes.join(',')}`).toContain(c)
    }
    expect(readFileSync(join(dir, 'secret.txt'), 'utf8')).toBe('secret')
    const listing = (await json('GET', `${base()}?path=shared`)).json() as FileListing
    expect(listing.entries.map((e) => e.name)).not.toContain('etc')
    expect((await json('GET', `${base()}/shared`)).body).not.toContain('etc')
  })

  it('returns 413 when a write would pass the bot quota', async () => {
    vi.stubEnv('AGENTCONTROL_BOT_QUOTA_BYTES', String(4096))
    expect((await put(`${base()}/content?path=shared/a.bin`, Buffer.alloc(1024))).statusCode).toBe(201)
    const over = await put(`${base()}/content?path=shared/b.bin`, Buffer.alloc(4096))
    expect(over.statusCode).toBe(413)
    expect(existsSync(join(root(bot), 'shared', 'b.bin'))).toBe(false)
    // Overwriting counts only the difference.
    expect((await put(`${base()}/content?path=shared/a.bin&overwrite=1`, Buffer.alloc(1500))).statusCode).toBe(201)
    expect(((await json('GET', base())).json() as FileListing).usage.quotaBytes).toBe(4096)
  })

  it('caps one upload at 25 MiB', async () => {
    const res = await put(`${base()}/content?path=shared/big.bin`, Buffer.alloc(25 * 1024 * 1024 + 1))
    expect(res.statusCode).toBe(413)
  })

  it('404s for an unknown bot and an unknown top-level name', async () => {
    expect((await json('GET', '/api/agents/agt_nope/files')).statusCode).toBe(404)
    expect((await json('GET', `${base()}?path=other`)).statusCode).toBe(404)
  })
})
