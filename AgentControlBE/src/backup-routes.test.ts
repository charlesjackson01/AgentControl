/**
 * BE-P2-18: /api/vm/backups*, /api/vm/export and /api/agents/:id/export through the app, on a temp
 * data copy with a fake engine, fake host, fake clock and fake free space (no Podman, no live data).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from './app.js'
import { readZip } from './backup-archive.js'
import { createBotEnvService } from './bot-env.js'
import { botMounts, storeSaveVm } from './bot-env-routes.js'
import { fakeEngine } from './bot-env.fake.js'
import { EGRESS_VIA } from './egressd.js'
import { fakeRunner } from './run-service.fake.js'
import { downEgress } from './egress-service.fake.js'
import type { EgressService } from './egress-service.js'
import { internetNeverBuildText } from './http.js'
import { PROXY_UNAVAILABLE } from './egress-service.js'

/** An egress proxy that is up (no engine behind it; the fake runner never connects). */
function upEgress(): EgressService {
  return { ...downEgress(), available: async () => ({ ok: true }), grant: async () => ({ id: 'g', url: 'http://g:s@127.0.0.1:1' }) as never, revoke: async () => [] }
}
import type { RuntimeProbe } from './runtime-probe.js'
import { PERMISSION_CSRF_HEADER, UNDO_MACHINE_RESTORED_TEXT, type Agent, type BackupInfo, type BackupRestoreResult, type ScriptRun, type VmHostInfo, type VmInfo } from './shared/types.js'
import { FILES_MISMATCH_TEXT, MARKER_FILE, storageFor } from './storage/index.js'
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
let free: number | null = null
let clock = new Date(2026, 10, 6, 10, 0, 0)
let engineCalls: string[][] = []

async function boot(o: { runner?: boolean; egress?: 'up' | 'down' } = {}): Promise<void> {
  if (app) await app.close()
  store = createStore(join(dir, 'store.json'))
  const vmHost: VmHostService = { hostInfo: async () => host, ensureMachine: async () => host, grow: async () => host }
  const engine = fakeEngine()
  const botEnv = createBotEnvService({
    exec: async (cmd, args, o) => {
      engineCalls.push([cmd, ...args])
      return engine.exec(cmd, args, o)
    },
    engine: async () => ({ cli: 'podman', globalArgs: [] }),
    mounts: (a) => botMounts(store, a),
    saveVm: storeSaveVm(store),
    activeRuns: () => 0,
  })
  app = buildApp(store, { vmHost, botEnv, runtimeProbe: probe, ...(o.runner ? { vmRunner: fakeRunner() } : {}), ...(o.egress ? { egress: o.egress === 'up' ? upEgress() : downEgress() } : {}), backups: { freeBytes: () => free, now: () => new Date(clock) } })
}

const inject = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app!.inject({ method, url, payload: payload as object | undefined, headers: { 'content-type': 'application/json', ...headers } })
const putText = (url: string, body: string) => app!.inject({ method: 'PUT', url, payload: body, headers: { 'content-type': 'text/plain' } })
const confirm = { [PERMISSION_CSRF_HEADER]: '1' }
const botDir = (bot: Agent) => join(dir, 'bots', bot.slug)
const backups = () => (app as unknown as { vmBackups: { idle(): Promise<void> } }).vmBackups

async function makeBot(name: string): Promise<Agent> {
  const res = await inject('POST', '/api/agents', { name, endpointId: 'ep_local_llama', modelId: 'llama-3-8b' })
  expect(res.statusCode).toBe(201)
  const bot = res.json() as Agent
  expect((await putText(`/api/agents/${bot.id}/files/content?path=workspace/a.txt`, `hi from ${name}`)).statusCode).toBe(201)
  return bot
}

async function backUp(body?: unknown): Promise<BackupInfo> {
  const res = await inject('POST', '/api/vm/backups', body)
  expect(res.statusCode).toBe(202)
  await backups().idle()
  return ((await inject('GET', '/api/vm/backups')).json() as BackupInfo[]).find((b) => b.id === (res.json() as BackupInfo).id)!
}

beforeEach(async () => {
  vi.stubEnv('AGENTCONTROL_SECRET', 'be18-test-secret')
  vi.stubEnv('AGENTCONTROL_AUTH_TOKEN', '')
  dir = mkdtempSync(join(tmpdir(), 'agentcontrol-be18-'))
  free = null
  clock = new Date(2026, 10, 6, 10, 0, 0)
  engineCalls = []
  await boot()
})
afterEach(async () => {
  if (app) await app.close()
  app = null
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

describe('POST/GET /api/vm/backups', () => {
  it('202 in_progress, then the list (newest first), vm.updated progress, and VmInfo.storage.lastBackupAt', async () => {
    const a = await makeBot('Analyst')
    const w = await makeBot('Writer')
    expect(((await inject('GET', '/api/vm/backups')).json())).toEqual([])
    const events: { agentId: string; backup?: BackupInfo }[] = []
    app!.liveEvents.subscribe((e) => {
      if (e.event.type === 'vm.updated') events.push({ agentId: e.event.agentId, backup: e.event.backup })
    })
    const res = await inject('POST', '/api/vm/backups')
    expect(res.statusCode).toBe(202)
    const started = res.json() as BackupInfo
    expect(started.agentIds.sort()).toEqual([a.id, w.id].sort())
    expect(started).toMatchObject({ status: 'in_progress', trigger: 'manual', progress: { done: 0, total: 2 }, path: join(dir, 'backups', started.id) })
    await backups().idle()
    const list = (await inject('GET', '/api/vm/backups')).json() as BackupInfo[]
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: started.id, status: 'complete' })
    expect(list[0]!.agentIds.sort()).toEqual([a.id, w.id].sort())
    expect(existsSync(join(dir, 'backups', started.id, `${a.slug}.tar.zst`))).toBe(true)
    const vm = (await inject('GET', `/api/agents/${a.id}/vm`)).json() as VmInfo
    expect(vm.storage.lastBackupAt).toBe(started.createdAt)
    await vi.waitFor(() => expect(events.some((e) => e.agentId === a.id && e.backup?.status === 'complete')).toBe(true))
    expect(events.some((e) => e.backup?.status === 'in_progress')).toBe(true)
    // Only the bots asked for; newest first.
    clock = new Date(clock.getTime() + 60_000)
    const one = await backUp({ agentIds: [w.id] })
    expect(one.agentIds).toEqual([w.id])
    expect(((await inject('GET', '/api/vm/backups')).json() as BackupInfo[]).map((b) => b.id)).toEqual([one.id, started.id])
  })

  it('400 for a bad body or unknown bot, 409 backup_in_progress, 507 low_disk (the approved 5xx reason)', async () => {
    expect((await inject('POST', '/api/vm/backups')).json()).toMatchObject({ statusCode: 400, reason: 'no_bots', message: 'There are no bots to back up yet.' })
    const a = await makeBot('Analyst')
    expect((await inject('POST', '/api/vm/backups', [1])).statusCode).toBe(400)
    expect((await inject('POST', '/api/vm/backups', { agentIds: 'x' })).json()).toMatchObject({ statusCode: 400, message: '"agentIds" must be a list of bot ids, e.g. ["agent_1"].' })
    expect((await inject('POST', '/api/vm/backups', { trigger: 'nightly' })).json()).toMatchObject({ statusCode: 400, message: '"trigger" can\'t be set here.' })
    expect((await inject('POST', '/api/vm/backups', { agentIds: ['nope'] })).json()).toMatchObject({ statusCode: 400, message: 'No bot with id "nope".' })
    expect((await inject('POST', '/api/vm/backups')).statusCode).toBe(202)
    const busy = await inject('POST', '/api/vm/backups', { agentIds: [a.id] })
    expect(busy.statusCode).toBe(409)
    expect(busy.json()).toEqual({ statusCode: 409, error: 'Request Error', reason: 'backup_in_progress', message: 'A backup or restore is already running. Try again when it finishes.' })
    await backups().idle()
    free = 10
    const low = await inject('POST', '/api/vm/backups')
    expect(low.statusCode).toBe(507)
    expect(low.json()).toEqual({ statusCode: 507, error: 'Internal Server Error', reason: 'low_disk', message: expect.stringMatching(/^Not enough free disk space for a backup: .* Free some space, then try again\.$/) })
  })

  it('403 user_only from the bot side on every backup and export route', async () => {
    const a = await makeBot('Analyst')
    for (const [method, url] of [['GET', '/api/vm/backups'], ['POST', '/api/vm/backups'], ['POST', '/api/vm/backups/x/restore'], ['GET', '/api/vm/export'], ['GET', `/api/agents/${a.id}/export`]] as const) {
      const res = await app!.inject({ method, url, remoteAddress: '127.0.0.1', headers: { via: EGRESS_VIA, ...confirm }, ...(method === 'POST' ? { payload: { confirm: true } } : {}) })
      expect([url, res.statusCode]).toEqual([url, 403])
      expect(res.json()).toMatchObject({ reason: 'user_only' })
    }
  })
})

describe('POST /api/vm/backups/:id/restore', () => {
  it('needs confirm:true (400) and the confirm header (403); 404 unknown id', async () => {
    const a = await makeBot('Analyst')
    const b = await backUp()
    for (const body of [undefined, {}, { confirm: 'yes' }, { confirm: false }]) {
      const res = await inject('POST', `/api/vm/backups/${b.id}/restore`, body, confirm)
      expect(res.statusCode).toBe(400)
      expect(res.json()).toMatchObject({ reason: 'confirm_required' })
    }
    const noHeader = await inject('POST', `/api/vm/backups/${b.id}/restore`, { confirm: true })
    expect(noHeader.json()).toMatchObject({ statusCode: 403, reason: 'confirm_required', message: 'Restoring a backup needs the x-agentcontrol-confirm: 1 header.' })
    const missing = await inject('POST', '/api/vm/backups/2020-01-01T00-00-00Z/restore', { confirm: true }, confirm)
    expect(missing.json()).toMatchObject({ statusCode: 404, reason: 'not_found' })
    expect((await inject('POST', `/api/vm/backups/${b.id}/restore`, { confirm: true, agentIds: ['nope'] }, confirm)).statusCode).toBe(400)
    void a
  })

  it('restores the files, stops the bot\'s computer first, marks old snapshots machine_restored', async () => {
    const a = await makeBot('Analyst')
    const w = await makeBot('Writer')
    // A kept undo snapshot from before the backup.
    const snapDir = join(dir, 'snapshots', a.slug, 'r1old')
    mkdirSync(snapDir, { recursive: true })
    writeFileSync(join(snapDir, 'meta.json'), JSON.stringify({ runId: 'r1old', slug: a.slug, startedAt: '2026-11-05T00:00:00.000Z', endedAt: '2026-11-05T00:01:00.000Z', retainedBytes: 0, undo: { state: 'available' } }))
    const b = await backUp()
    writeFileSync(join(botDir(a), 'workspace', 'a.txt'), 'changed after the backup')
    writeFileSync(join(botDir(a), 'workspace', 'later.txt'), 'added after the backup')
    writeFileSync(join(botDir(w), 'workspace', 'a.txt'), 'writer changed')
    engineCalls = []
    const res = await inject('POST', `/api/vm/backups/${b.id}/restore`, { confirm: true, agentIds: [a.id] }, confirm)
    expect(res.statusCode).toBe(200)
    expect(res.json() as BackupRestoreResult).toEqual({ backupId: b.id, agents: [{ agentId: a.id, files: 3, tools: 'not_needed', toolResults: (['apt', 'pip', 'npm', 'opt'] as const).map((kind) => ({ kind, status: 'not_needed', items: [] })) }] }) // workspace/a.txt, memory/MEMORY.md, BOT.md
    expect(readFileSync(join(botDir(a), 'workspace', 'a.txt'), 'utf8')).toBe('hi from Analyst')
    expect(existsSync(join(botDir(a), 'workspace', 'later.txt'))).toBe(false)
    expect(readFileSync(join(botDir(w), 'workspace', 'a.txt'), 'utf8')).toBe('writer changed')
    // The fake engine was asked about the bot's container (stop checks its state first).
    expect(engineCalls.some((c) => c.includes(`ac-bot-${a.slug}`))).toBe(true)
    const meta = JSON.parse(readFileSync(join(snapDir, 'meta.json'), 'utf8'))
    expect(meta.undo).toMatchObject({ state: 'unavailable', reason: 'machine_restored' })
    expect(UNDO_MACHINE_RESTORED_TEXT).toBe("This bot's computer was restored from a backup, so this run can't be undone.")
  })

  it('tools come back from the manifest: packages saved, a rebuild started (or the reason it couldn\'t)', async () => {
    const a = await makeBot('Analyst')
    store.agents = store.agents.map((x) => (x.id === a.id ? { ...x, internetPolicy: 'never', vm: { ...x.vm, packages: ['jq'] } } : x))
    store.save()
    const b = await backUp()
    // Reset cleared the packages (M1 reset); the restore brings the list back.
    store.agents = store.agents.map((x) => (x.id === a.id ? { ...x, vm: { ...x.vm, packages: [] } } : x))
    store.save()
    const res = await inject('POST', `/api/vm/backups/${b.id}/restore`, { confirm: true }, confirm)
    expect(res.statusCode).toBe(200)
    const out = (res.json() as BackupRestoreResult).agents[0]!
    expect(out).toMatchObject({ agentId: a.id, tools: 'failed' })
    // Internet is Never for this bot, so the online tool build couldn't start: the plain 409 text.
    expect(out.toolsMessage).toBe("Internet is set to Never for Analyst, so this build didn't start. Change it in Settings › VM.")
    expect(store.agents.find((x) => x.id === a.id)!.vm.packages).toEqual(['jq'])
  })

  it('pip and npm come back through install runs in the bot\'s DM, opt is named; the manifest is the one stored at backup time', async () => {
    await boot({ runner: true, egress: 'up' })
    const a = await makeBot('Analyst')
    const tools = { pip: ['requests==2.32.3'], npm: ['cowsay@1.6.0'], optBin: ['mytool'], updatedAt: '2026-11-06T09:00:00.000Z' }
    store.agents = store.agents.map((x) => (x.id === a.id ? { ...x, internetPolicy: 'always', vm: { ...x.vm, tools } } : x))
    store.save()
    const b = await backUp()
    // A reset since: the tools volumes (and vm.tools) are gone.
    store.agents = store.agents.map((x) => (x.id === a.id ? { ...x, vm: { ...x.vm, tools: undefined } } : x))
    store.save()
    const res = await inject('POST', `/api/vm/backups/${b.id}/restore`, { confirm: true }, confirm)
    expect(res.statusCode).toBe(200)
    const out = (res.json() as BackupRestoreResult).agents[0]!
    expect(out.toolResults.map((r) => [r.kind, r.items])).toEqual([['apt', []], ['pip', tools.pip], ['npm', tools.npm], ['opt', tools.optBin]])
    expect(out.toolResults[3]).toMatchObject({ status: 'not_restorable' })
    for (const r of out.toolResults.slice(1, 3)) {
      expect(r, JSON.stringify(r)).toMatchObject({ status: 'started' })
      expect(r.runId).toBeTruthy()
      const run = (await inject('GET', `/api/runs/${r.runId}`)).json() as ScriptRun
      expect(run).toMatchObject({ agentId: a.id, kind: 'script', network: 'on' })
      expect(run.argv.slice(0, 3)).toEqual(r.kind === 'pip' ? ['python3', '-m', 'pip'] : ['npm', 'install', '-g'])
      expect(run.argv.at(-1)).toBe(r.items[0])
    }
  })

  describe('the restore click is a one-time internet grant for its own pip/npm runs, like Rebuild', () => {
    const tools = { pip: ['requests==2.32.3'], npm: ['cowsay@1.6.0'], optBin: [], updatedAt: '2026-11-06T09:00:00.000Z' }
    async function restoreWith(policy: Agent['internetPolicy'], egress: 'up' | 'down') {
      await boot({ runner: true, egress })
      const a = await makeBot('Analyst')
      store.agents = store.agents.map((x) => (x.id === a.id ? { ...x, internetPolicy: policy, vm: { ...x.vm, tools } } : x))
      store.save()
      const b = await backUp()
      store.agents = store.agents.map((x) => (x.id === a.id ? { ...x, vm: { ...x.vm, tools: undefined } } : x))
      store.save()
      const res = await inject('POST', `/api/vm/backups/${b.id}/restore`, { confirm: true }, confirm)
      expect(res.statusCode).toBe(200)
      return { a, out: (res.json() as BackupRestoreResult).agents[0]! }
    }
    const runsOf = (agentId: string) => (app as unknown as { vmRuns: { list(id: string, o: { limit: number }): { runs: unknown[] } } }).vmRuns.list(agentId, { limit: 50 }).runs
    const pending = () => (app as unknown as { vmPermissions: { list(): { requests: { status: string; runId?: string }[] } } }).vmPermissions.list().requests.filter((r) => r.status === 'pending')

    it('Ask: both runs carry allow_once/rebuild and raise no card; a later run still asks', async () => {
      const { a, out } = await restoreWith('ask', 'up')
      const [, pip, npm] = out.toolResults
      expect(pip).toMatchObject({ kind: 'pip', status: 'started' })
      expect(npm).toMatchObject({ kind: 'npm', status: 'started' })
      let conversationId = ''
      for (const r of [pip!, npm!]) {
        const run = (await inject('GET', `/api/runs/${r.runId}`)).json() as ScriptRun
        conversationId = run.conversationId
        expect(run.status).not.toBe('waiting_permission')
        expect(run.permissions).toEqual([{ type: 'internet', decision: 'allow_once', source: 'rebuild' }])
      }
      expect(pending()).toEqual([])
      // The grant is on those two runs only: the bot's next online run asks as usual.
      const later = await (app as unknown as { vmRuns: { start(i: object): Promise<ScriptRun> } }).vmRuns.start({
        agentId: a.id, conversationId, context: { kind: 'dm' }, argv: ['python3', '-m', 'pip', 'install', '--user', 'numpy==2.1.0'], network: 'on',
      })
      expect(later.status).toBe('waiting_permission')
      expect(later.permissions.some((p) => p.type === 'internet' && p.source === 'rebuild')).toBe(false)
      expect(pending().map((r) => r.runId)).toEqual([later.id])
      expect(store.agents.find((x) => x.id === a.id)!.internetPolicy).toBe('ask')
    })

    it('Never: refused like Rebuild (its 409 text, no run recorded, no card)', async () => {
      const { a, out } = await restoreWith('never', 'up')
      const text = internetNeverBuildText('Analyst')
      expect(out.toolResults[1]).toEqual({ kind: 'pip', status: 'failed', items: tools.pip, message: text })
      expect(out.toolResults[2]).toEqual({ kind: 'npm', status: 'failed', items: tools.npm, message: text })
      expect(out).toMatchObject({ tools: 'failed', toolsMessage: `${text} ${text}` })
      expect(runsOf(a.id)).toEqual([])
      expect(pending()).toEqual([])
    })

    it('proxy down: refused like Rebuild (proxy_unavailable text, no run recorded)', async () => {
      const { a, out } = await restoreWith('ask', 'down')
      expect(out.toolResults[1]).toMatchObject({ status: 'failed', message: PROXY_UNAVAILABLE })
      expect(out.toolResults[1]!.runId).toBeUndefined()
      expect(runsOf(a.id)).toEqual([])
    })
  })

  it('a missing volume marker: restore brings the files and the marker back; a mismatched one refuses', async () => {
    const a = await makeBot('Analyst')
    const b = await backUp()
    rmSync(join(botDir(a), 'workspace'), { recursive: true })
    unlinkSync(join(dir, MARKER_FILE))
    await boot()
    expect(storageFor(store).volume).toBe('missing')
    const res = await inject('POST', `/api/vm/backups/${b.id}/restore`, { confirm: true }, confirm)
    expect(res.statusCode).toBe(200)
    expect(storageFor(store).volume).toBe('ok')
    expect(readFileSync(join(dir, MARKER_FILE), 'utf8').trim()).toBe(store.settings.vm!.volumeId)
    expect(((await inject('GET', `/api/agents/${a.id}/vm`)).json() as VmInfo).state).not.toBe('files_missing')
    writeFileSync(join(dir, MARKER_FILE), 'vol_someone_else')
    await boot()
    const mismatch = await inject('POST', `/api/vm/backups/${b.id}/restore`, { confirm: true }, confirm)
    expect(mismatch.json()).toMatchObject({ statusCode: 409, reason: 'files_missing', message: FILES_MISMATCH_TEXT })
  })
})

describe('export', () => {
  it('GET /api/agents/:id/export: a zip of that bot only; 404 unknown; 409 files_missing', async () => {
    const a = await makeBot('Analyst')
    await makeBot('Writer')
    const res = await inject('GET', `/api/agents/${a.id}/export`)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('application/zip')
    expect(res.headers['content-disposition']).toMatch(new RegExp(`^attachment; filename="agentcontrol-${a.slug}-\\d{4}-\\d{2}-\\d{2}\\.zip"$`))
    const zip = readZip(res.rawPayload)
    const names = [...zip.keys()]
    expect(names.every((n) => n.startsWith(`${a.slug}/`))).toBe(true)
    expect(names).toEqual(expect.arrayContaining([`${a.slug}/workspace/a.txt`, `${a.slug}/BOT.md`, `${a.slug}/manifest.json`]))
    expect(zip.get(`${a.slug}/workspace/a.txt`)!.toString()).toBe('hi from Analyst')
    expect((await inject('GET', '/api/agents/nope/export')).statusCode).toBe(404)
    rmSync(join(botDir(a), 'workspace'), { recursive: true })
    expect((await inject('GET', `/api/agents/${a.id}/export`)).json()).toMatchObject({ statusCode: 409, reason: 'files_missing' })
  })

  it('GET /api/vm/export: every bot plus the index; no snapshots, backups or store', async () => {
    const a = await makeBot('Analyst')
    const w = await makeBot('Writer')
    await backUp()
    const res = await inject('GET', '/api/vm/export')
    expect(res.statusCode).toBe(200)
    const zip = readZip(res.rawPayload)
    const names = [...zip.keys()]
    expect(names).toEqual(expect.arrayContaining([`bots/${a.slug}/workspace/a.txt`, `bots/${w.slug}/workspace/a.txt`, 'agentcontrol-export.json']))
    expect(names.some((n) => /snapshots|backups|store\.json|vault/.test(n))).toBe(false)
  })
})
