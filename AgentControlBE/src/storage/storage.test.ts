/**
 * BE-P2-6: StorageBackend (LocalFs + WslFs over acfs) and the volume marker.
 * Everything runs on temp dirs.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../app.js'
import type { Agent, ConversationSummary, Endpoint } from '../shared/types.js'
import { createFileService } from '../file-service.js'
import { createStore, type WorkspaceStore } from '../store.js'
import { handleAcfs, parseAcfsRequest } from './acfs.js'
import { fileOpsSuite } from './file-ops-suite.js'
import {
  LocalFs, MARKER_FILE, WslFs, checkVolume, filesMissing, inProcessTransport, podmanTransport, storageFor, useStorage, volPath,
} from './index.js'

const temps: string[] = []
const tempDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'agentcontrol-storage-'))
  temps.push(d)
  return d
}
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

fileOpsSuite('LocalFs', () => {
  const hostRoot = tempDir()
  return { fs: new LocalFs(hostRoot), hostRoot }
})

fileOpsSuite('WslFs (acfs over JSON, in-process)', () => {
  const hostRoot = tempDir()
  return { fs: new WslFs(inProcessTransport(new LocalFs(hostRoot))), hostRoot }
})

describe('volume paths', () => {
  it('refuses anything that could leave the volume', () => {
    expect(volPath('bots', 'ada')).toBe('bots/ada')
    for (const bad of [['..'], ['bots', ''], ['.'], ['a\\b'], ['a\0b']]) expect(() => volPath(...bad)).toThrow()
  })
})

describe('acfs protocol', () => {
  it('validates requests and carries errors with their status and code', () => {
    expect(() => parseAcfsRequest({ op: 'rm -rf' })).toThrow(/Unknown acfs op/)
    expect(() => parseAcfsRequest({ op: 'read', root: 'bots/a', parts: [1] })).toThrow()
    expect(() => parseAcfsRequest({ op: 'write', root: 'bots/a', parts: [], body: '', mode: 'x' })).toThrow()
    const fs = new LocalFs(tempDir())
    fs.ensureDir('bots/a')
    fs.write('bots/a', ['x'], Buffer.from('1'), 'create')
    const res = handleAcfs(fs, parseAcfsRequest({ op: 'write', root: 'bots/a', parts: ['x'], body: '', mode: 'create' }))
    expect(res).toMatchObject({ ok: false, error: { code: 'EEXIST' } })
  })

  it('podmanTransport runs `podman exec -i ac-storaged acfs` and maps failures plainly', () => {
    const calls: { cmd: string; args: string[]; input: string }[] = []
    const ok = podmanTransport({
      podman: 'podman-x',
      spawnSyncFn: (cmd, args, opts) => {
        calls.push({ cmd, args, input: opts.input })
        return { stdout: JSON.stringify({ ok: true, result: true }), stderr: '', status: 0, signal: null, pid: 1, output: [] }
      },
    })
    expect(new WslFs(ok).existsAt('bots/a')).toBe(true)
    expect(calls).toEqual([{ cmd: 'podman-x', args: ['exec', '-i', 'ac-storaged', 'acfs'], input: '{"op":"existsAt","vol":"bots/a"}' }])
    const down = podmanTransport({
      spawnSyncFn: () => ({ error: new Error('ENOENT'), stdout: '', stderr: '', status: null, signal: null, pid: 0, output: [] }),
    })
    expect(() => new WslFs(down).existsAt('bots/a')).toThrow(/files helper could not be reached/)
    const garbled = podmanTransport({ spawnSyncFn: () => ({ stdout: 'nope', stderr: '', status: 0, signal: null, pid: 1, output: [] }) })
    expect(() => new WslFs(garbled).readMarker()).toThrow(/unreadable answer/)
  })

  it('WslFs has no host paths', () => {
    expect(new WslFs(inProcessTransport(new LocalFs(tempDir()))).hostPath('bots/a')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Volume marker + files_missing, through the app.

const ok = (content: string) => ({ ok: true, status: 200, json: async () => ({ choices: [{ index: 0, message: { role: 'assistant', content } }] }), text: async () => '' })

describe('volume marker', () => {
  let dir = ''
  let app: FastifyInstance | null = null
  let store: WorkspaceStore
  const warnings: string[] = []

  const inject = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
    app!.inject({ method, url, payload: payload as object | undefined, headers: { 'content-type': 'application/json' } })

  const boot = async (): Promise<void> => {
    if (app) await app.close()
    store = createStore(join(dir, 'store.json'))
    app = buildApp(store)
  }
  const marker = () => join(dir, MARKER_FILE)
  const savedId = () => (JSON.parse(readFileSync(join(dir, 'store.json'), 'utf8')) as { settings: { vm?: { volumeId?: string } } }).settings.vm?.volumeId

  beforeEach(async () => {
    process.env.AGENTCONTROL_SECRET = 'test-secret'
    dir = tempDir()
    warnings.length = 0
    await boot()
  })
  afterEach(async () => {
    vi.unstubAllGlobals()
    if (app) await app.close()
    app = null
    delete process.env.AGENTCONTROL_SECRET
  })

  async function makeBot(name: string): Promise<Agent> {
    const ep = await inject('POST', '/api/endpoints', { kind: 'openai-compatible', name: 'E', baseUrl: 'http://127.0.0.1:9', defaultModel: 'test-model', contextWindow: 32768 })
    const res = await inject('POST', '/api/agents', { name, description: '', instructions: '', modelId: 'test-model', endpointId: (ep.json() as Endpoint).id, skillIds: [] })
    expect(res.statusCode).toBe(201)
    return res.json() as Agent
  }

  it('first start writes the marker and saves the id; a restart is ok', async () => {
    const id = readFileSync(marker(), 'utf8').trim()
    expect(id).toMatch(/^vol_[0-9a-f-]{36}$/)
    expect(store.settings.vm?.volumeId).toBe(id)
    expect(savedId()).toBe(id)
    await boot()
    expect(storageFor(store).volume).toBe('ok')
    expect(readFileSync(marker(), 'utf8').trim()).toBe(id)
    // the server-only id is not served
    expect(JSON.stringify((await inject('GET', '/api/settings')).json())).not.toContain(id)
  })

  it('an existing marker without a saved id is adopted (crash between marker and save)', async () => {
    await app!.close()
    app = null
    rmSync(join(dir, 'store.json'))
    writeFileSync(marker(), 'vol_adopted\n')
    await boot()
    expect(storageFor(store).volume).toBe('ok')
    expect(savedId()).toBe('vol_adopted')
  })

  it('a missing marker is files_missing: file routes 409, chats work, nothing re-initialized', async () => {
    const bot = await makeBot('Ada')
    const put = await app!.inject({ method: 'PUT', url: `/api/agents/${bot.id}/files/content?path=workspace/a.txt`, payload: 'hi', headers: { 'content-type': 'text/plain' } })
    expect(put.statusCode).toBe(201)
    const id = savedId()
    unlinkSync(marker())
    await boot()
    expect(storageFor(store).volume).toBe('missing')
    expect(filesMissing(store)).toBe(true)

    for (const res of [
      await inject('GET', `/api/agents/${bot.id}/files`),
      await inject('GET', `/api/agents/${bot.id}/files/content?path=workspace/a.txt`),
      await app!.inject({ method: 'PUT', url: `/api/agents/${bot.id}/files/content?path=workspace/b.txt`, payload: 'x', headers: { 'content-type': 'text/plain' } }),
      await inject('POST', `/api/agents/${bot.id}/files/folders`, { path: 'workspace/new' }),
      await inject('PATCH', `/api/agents/${bot.id}/files`, { from: 'workspace/a.txt', to: 'workspace/c.txt' }),
      await inject('DELETE', `/api/agents/${bot.id}/files?path=workspace/a.txt`),
    ]) {
      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ reason: 'files_missing', message: expect.stringMatching(/can't find the bots' files.*Chats still work/) })
    }
    const list = (await inject('GET', '/api/conversations')).json() as ConversationSummary[]
    const dm = list.find((c) => c.kind === 'dm' && c.agentId === bot.id)!
    const upload = await app!.inject({ method: 'PUT', url: `/api/conversations/${dm.id}/uploads?name=x.txt`, payload: 'x', headers: { 'content-type': 'application/octet-stream' } })
    expect(upload.statusCode).toBe(409)
    expect(upload.json()).toMatchObject({ reason: 'files_missing' })

    // the bots' file tools explain it plainly instead of touching anything
    const tools = createFileService(store, store.agents.find((a) => a.id === bot.id)!)
    expect(() => tools.read('workspace/a.txt')).toThrow(/can't find the bots' files/)
    expect(() => tools.write('workspace/z.txt', 'z', 'create')).toThrow(/can't find the bots' files/)

    // chats still work, and so do new bots and groups (their folders wait)
    vi.stubGlobal('fetch', vi.fn(async () => ok('Still here.')))
    const sent = await inject('POST', `/api/conversations/${dm.id}/messages`, { content: 'hello?' })
    expect(sent.statusCode).toBeLessThan(300)
    const other = await makeBot('Bea')
    expect(existsSync(join(dir, 'bots', other.slug))).toBe(false)
    const group = await inject('POST', '/api/groups', { name: 'Crew', memberAgentIds: [bot.id, other.id] })
    expect(group.statusCode).toBe(201)
    expect(existsSync(join(dir, 'groups', 'crew'))).toBe(false)

    // never re-initialized: no new marker, same saved id, the old file untouched
    expect(existsSync(marker())).toBe(false)
    expect(savedId()).toBe(id)
    expect(readFileSync(join(dir, 'bots', bot.slug, 'workspace', 'a.txt'), 'utf8')).toBe('hi')
    await boot()
    expect(storageFor(store).volume).toBe('missing')
    expect(existsSync(marker())).toBe(false)
  })

  it('a marker from another volume is a mismatch (files_missing) and is left alone', async () => {
    const bot = await makeBot('Ada')
    writeFileSync(marker(), 'vol_someone-else\n')
    await boot()
    expect(storageFor(store).volume).toBe('mismatch')
    const res = await inject('GET', `/api/agents/${bot.id}/files`)
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ reason: 'files_missing', message: expect.stringMatching(/different AgentControl setup/) })
    expect(readFileSync(marker(), 'utf8')).toBe('vol_someone-else\n')
    expect(savedId()).not.toBe('vol_someone-else')
    // putting the right marker back fixes it on the next start
    writeFileSync(marker(), `${savedId()}\n`)
    await boot()
    expect(storageFor(store).volume).toBe('ok')
    expect((await inject('GET', `/api/agents/${bot.id}/files`)).statusCode).toBe(200)
  })

  it('checkVolume with an unwritable volume reports missing instead of running without a marker', () => {
    const s = createStore(join(tempDir(), 'store.json'))
    const blocked = join(tempDir(), 'file-not-dir')
    writeFileSync(blocked, '')
    useStorage(s, new LocalFs(blocked))
    const logs: string[] = []
    expect(checkVolume(s, (m) => logs.push(m))).toBe('missing')
    expect(s.settings.vm?.volumeId).toBeUndefined()
    expect(logs.join('\n')).toMatch(/could not write the volume marker/)
  })
})
