/**
 * BE-P2-20: the VM tab (BE-P2-4) and the bot's file routes (BE-P2-6) use one
 * files check — the volume marker plus the bot's workspace folder — and show
 * the same message, so they always agree. Runs are refused the same way.
 * Temp data dirs only (copies), a fake engine and host: no Podman.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from './app.js'
import { createBotEnvService } from './bot-env.js'
import { botMounts, storeSaveVm } from './bot-env-routes.js'
import { fakeEngine } from './bot-env.fake.js'
import { createFileService } from './file-service.js'
import { botFilesMissingMessage } from './files.js'
import type { RuntimeProbe } from './runtime-probe.js'
import type { Agent, ConversationSummary, VmHostInfo, VmInfo } from './shared/types.js'
import { FILES_MISMATCH_TEXT, FILES_MISSING_TEXT, MARKER_FILE } from './storage/index.js'
import { createStore, type WorkspaceStore } from './store.js'
import type { VmHostService } from './vm-host.js'

const host: VmHostInfo = {
  engine: 'podman', version: '5.4.0', provider: 'native', os: 'linux', machine: null,
  storage: { driver: 'overlay', backend: 'local', volumeState: 'ok' }, concurrency: 2, setupSteps: [],
}
const probe: RuntimeProbe = {
  current: () => null,
  refresh: async () => { throw new Error('not used') },
  ensureFresh: async () => { throw new Error('not used') },
  restore: async () => null,
  startTimer: () => () => {},
}

let dir = ''
let app: FastifyInstance | null = null
let store: WorkspaceStore

async function boot(): Promise<void> {
  if (app) await app.close()
  store = createStore(join(dir, 'store.json'))
  const vmHost: VmHostService = { hostInfo: async () => host, ensureMachine: async () => host, grow: async () => host }
  const engine = fakeEngine()
  const botEnv = createBotEnvService({
    exec: engine.exec,
    engine: async () => ({ cli: 'podman', globalArgs: [] }),
    mounts: (a) => botMounts(store, a),
    saveVm: storeSaveVm(store),
    activeRuns: () => 0,
  })
  app = buildApp(store, { vmHost, botEnv, runtimeProbe: probe })
}

const inject = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
  app!.inject({ method, url, payload: payload as object | undefined, headers: { 'content-type': 'application/json' } })
const putText = (url: string, body: string) => app!.inject({ method: 'PUT', url, payload: body, headers: { 'content-type': 'text/plain' } })
const marker = () => join(dir, MARKER_FILE)
const workspace = (bot: Agent) => join(dir, 'bots', bot.slug, 'workspace')
const stored = (bot: Agent) => store.agents.find((a) => a.id === bot.id)!

async function makeBot(name: string): Promise<Agent> {
  const res = await inject('POST', '/api/agents', { name, endpointId: 'ep_local_llama', modelId: 'llama-3-8b' })
  expect(res.statusCode).toBe(201)
  const bot = res.json() as Agent
  expect((await putText(`/api/agents/${bot.id}/files/content?path=workspace/a.txt`, 'hi')).statusCode).toBe(201)
  return bot
}

/** VM tab, vm/start|stop|reset, every bot file route, uploads, file tools and runs: all files_missing with `message`. */
async function expectAllMissing(bot: Agent, message: string): Promise<void> {
  const vm = (await inject('GET', `/api/agents/${bot.id}/vm`)).json() as VmInfo
  expect(vm.state).toBe('files_missing')
  expect(vm.stateMessage).toBe(message)
  expect(botFilesMissingMessage(store, stored(bot))).toBe(message)

  const refused = [
    ['vm/start', await inject('POST', `/api/agents/${bot.id}/vm/start`)],
    ['vm/stop', await inject('POST', `/api/agents/${bot.id}/vm/stop`)],
    ['vm/reset', await inject('POST', `/api/agents/${bot.id}/vm/reset`, { confirm: true })],
    ['files', await inject('GET', `/api/agents/${bot.id}/files`)],
    ['files/shared', await inject('GET', `/api/agents/${bot.id}/files/shared`)],
    ['read', await inject('GET', `/api/agents/${bot.id}/files/content?path=workspace/a.txt`)],
    ['write', await putText(`/api/agents/${bot.id}/files/content?path=workspace/b.txt`, 'x')],
    ['folder', await inject('POST', `/api/agents/${bot.id}/files/folders`, { path: 'workspace/new' })],
    ['move', await inject('PATCH', `/api/agents/${bot.id}/files`, { from: 'workspace/a.txt', to: 'workspace/c.txt' })],
    ['trash', await inject('DELETE', `/api/agents/${bot.id}/files?path=workspace/a.txt`)],
  ] as const
  for (const [what, res] of refused) {
    expect({ what, status: res.statusCode }).toEqual({ what, status: 409 })
    expect(res.json()).toMatchObject({ reason: 'files_missing', message })
  }

  const dm = ((await inject('GET', '/api/conversations')).json() as ConversationSummary[]).find((c) => c.kind === 'dm' && c.agentId === bot.id)!
  const upload = await app!.inject({ method: 'PUT', url: `/api/conversations/${dm.id}/uploads?name=x.txt`, payload: 'x', headers: { 'content-type': 'application/octet-stream' } })
  expect(upload.statusCode).toBe(409)
  expect(upload.json()).toMatchObject({ reason: 'files_missing', message })

  const tools = createFileService(store, stored(bot))
  expect(() => tools.read('workspace/a.txt')).toThrow(message)

  const runs = (app as unknown as { vmRuns: { start(i: object): Promise<unknown> } }).vmRuns
  await expect(runs.start({ agentId: bot.id, conversationId: dm.id, context: { kind: 'dm' }, argv: ['true'] }))
    .rejects.toMatchObject({ statusCode: 409, reason: 'files_missing', message })
}

/** A bot whose files are there: the VM tab isn't files_missing and its file routes answer. */
async function expectFine(bot: Agent): Promise<void> {
  const vm = (await inject('GET', `/api/agents/${bot.id}/vm`)).json() as VmInfo
  expect(vm.state).not.toBe('files_missing')
  expect(vm.stateMessage).toBeUndefined()
  expect(botFilesMissingMessage(store, stored(bot))).toBeNull()
  expect((await inject('GET', `/api/agents/${bot.id}/files`)).statusCode).toBe(200)
  expect((await inject('GET', `/api/agents/${bot.id}/files/content?path=workspace/a.txt`)).statusCode).toBe(200)
}

beforeEach(async () => {
  vi.stubEnv('AGENTCONTROL_SECRET', 'be20-test-secret')
  vi.stubEnv('AGENTCONTROL_AUTH_TOKEN', '')
  dir = mkdtempSync(join(tmpdir(), 'agentcontrol-be20-'))
  await boot()
})
afterEach(async () => {
  if (app) await app.close()
  app = null
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

describe('files_missing: one check for the VM tab, file routes and runs', () => {
  it('uses BE-P2-6\'s wording, not the old VM text', () => {
    expect(FILES_MISSING_TEXT).toBe("AgentControl can't find the bots' files, so files and runs are paused to keep anything from being overwritten. Chats still work.")
  })

  it('healthy bot: both sides agree it is fine', async () => {
    await expectFine(await makeBot('Ada'))
  })

  it('missing marker only (workspace still there): VM tab and file routes both files_missing, same message', async () => {
    const bot = await makeBot('Ada')
    unlinkSync(marker())
    await boot()
    expect(existsSync(workspace(bot))).toBe(true)
    await expectAllMissing(bot, FILES_MISSING_TEXT)
    // nothing re-initialized
    expect(existsSync(marker())).toBe(false)
    expect(readFileSync(join(workspace(bot), 'a.txt'), 'utf8')).toBe('hi')
  })

  it('missing workspace only (marker fine): both files_missing, same message; not re-created, even by a restart', async () => {
    const bot = await makeBot('Ada')
    const other = await makeBot('Bea')
    rmSync(workspace(bot), { recursive: true, force: true })
    await expectAllMissing(bot, FILES_MISSING_TEXT)
    expect(existsSync(workspace(bot))).toBe(false)
    // only that bot: the other one is fine on both sides
    await expectFine(other)
    // a restart doesn't quietly re-create it either
    await boot()
    expect(existsSync(workspace(bot))).toBe(false)
    await expectAllMissing(bot, FILES_MISSING_TEXT)
    // the rest of its folder is left as it was
    expect(existsSync(join(dir, 'bots', bot.slug, 'BOT.md'))).toBe(true)
  })

  it('whole bot folder gone (marker fine): files_missing on both sides, not re-created while running', async () => {
    const bot = await makeBot('Ada')
    rmSync(join(dir, 'bots', bot.slug), { recursive: true, force: true })
    await expectAllMissing(bot, FILES_MISSING_TEXT)
    expect(existsSync(join(dir, 'bots', bot.slug))).toBe(false)
  })

  it('marker and workspace both missing: both files_missing, same message', async () => {
    const bot = await makeBot('Ada')
    unlinkSync(marker())
    rmSync(workspace(bot), { recursive: true, force: true })
    await boot()
    await expectAllMissing(bot, FILES_MISSING_TEXT)
    expect(existsSync(marker())).toBe(false)
    expect(existsSync(workspace(bot))).toBe(false)
  })

  it('marker from another setup: both sides show the mismatch message', async () => {
    const bot = await makeBot('Ada')
    writeFileSync(marker(), 'vol_someone-else\n')
    await boot()
    await expectAllMissing(bot, FILES_MISMATCH_TEXT)
  })

  it('a workspace that comes back (restored by hand) is fine on both sides again', async () => {
    const bot = await makeBot('Ada')
    const saved = readFileSync(join(workspace(bot), 'a.txt'))
    rmSync(workspace(bot), { recursive: true, force: true })
    await expectAllMissing(bot, FILES_MISSING_TEXT)
    mkdirSync(workspace(bot))
    writeFileSync(join(workspace(bot), 'a.txt'), saved)
    await expectFine(bot)
  })

  it('a new bot gets its folder, so it starts fine', async () => {
    const res = await inject('POST', '/api/agents', { name: 'Cal', endpointId: 'ep_local_llama', modelId: 'llama-3-8b' })
    const bot = res.json() as Agent
    expect(existsSync(workspace(bot))).toBe(true)
    const vm = (await inject('GET', `/api/agents/${bot.id}/vm`)).json() as VmInfo
    expect(vm.state).not.toBe('files_missing')
    expect((await inject('GET', `/api/agents/${bot.id}/files`)).statusCode).toBe(200)
  })
})
