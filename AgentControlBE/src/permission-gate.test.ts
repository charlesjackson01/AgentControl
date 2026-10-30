import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PROXY_UNAVAILABLE } from './egress-service.js'
import { internetNeverText } from './http.js'
import {
  createPermissionGate, hostsProblem, INTERNET_DENIED_TEXT, MODEL_INTERNET_DENIED, MODEL_PERMISSION_TIMEOUT, modelInternetNever,
  parsePermissionQuery, PERMISSION_TIMEOUT_TEXT, permissionContent, type PermissionGate, type PermissionGateDeps,
} from './permission-gate.js'
import {
  createRunService, HOST_BLOCKED_TEXT, networkOffText, RESTART_QUEUED_TEXT, STOPPED_QUEUED_TEXT, type RunService, type RunServiceDeps, type ToolBuildSpec,
} from './run-service.js'
import { fakeRunner, until, type FakeRunner } from './run-service.fake.js'
import { VM_INSTALL_EXPECTED_HOSTS, type Agent, type ChatMessage, type Conversation, type LiveEvent, type PermissionRequest } from './shared/types.js'

/** BE-P2-14: PermissionGate with RunService and a fake runner (no Podman, no proxy). */

let dir = ''
let runner: FakeRunner
let agents: Agent[]
let conversations: Conversation[]
let messages: ChatMessage[]
let events: LiveEvent[]
let proxyUp: boolean
let alwaysSet: string[]
let clock: number
let ids = 0
let n = 0
let gate: PermissionGate
let svc: RunService

const agent = (id: string, internetPolicy: Agent['internetPolicy'] = 'ask'): Agent =>
  ({ id, slug: id, name: `Bot ${id}`, internetPolicy, vm: { image: { generation: 2, base: 'base' }, packages: ['jq'], permissions: { browser: false } } } as unknown as Agent)
const dm = (agentId: string): Conversation => ({ id: `dm-${agentId}`, kind: 'dm', agentId, createdAt: '', updatedAt: '', lastReadAt: null } as unknown as Conversation)

function makeGate(extra: Partial<PermissionGateDeps> = {}): PermissionGate {
  return createPermissionGate({
    dataDir: () => dir,
    getAgent: (id) => agents.find((a) => a.id === id),
    conversations: () => conversations,
    messages: () => messages,
    save: () => {},
    setAlways: (id) => {
      alwaysSet.push(id)
      agents = agents.map((a) => (a.id === id ? { ...a, internetPolicy: 'always' } : a))
    },
    proxyAvailable: async () => proxyUp,
    publish: (e) => events.push(e),
    now: () => new Date(clock),
    newId: () => `perm_${String(++ids).padStart(4, '0')}`,
    ...extra,
  })
}
function make(g: PermissionGate, extra: Partial<RunServiceDeps> = {}): RunService {
  return createRunService({
    gate: g,
    runner,
    getAgent: (id) => agents.find((a) => a.id === id),
    conversations: () => conversations,
    messages: () => messages,
    save: () => {},
    root: () => join(dir, 'runs'),
    concurrency: () => 2,
    freeBytes: () => null,
    publish: (e) => events.push(e),
    newRunId: () => `run_${String(++n).padStart(4, '0')}`,
    flushMs: 20,
    ...extra,
  })
}
const start = (agentId = 'a1', extra: Record<string, unknown> = {}) =>
  svc.start({ agentId, conversationId: `dm-${agentId}`, context: { kind: 'dm' }, argv: ['python', 'scripts/fetch.py'], network: 'on', why: 'get the data', ...extra })
async function rejects(p: Promise<unknown> | (() => unknown)): Promise<{ statusCode: number; reason?: string; message: string; request?: PermissionRequest }> {
  try {
    await (typeof p === 'function' ? p() : p)
  } catch (err) {
    return err as { statusCode: number; reason?: string; message: string }
  }
  throw new Error('expected a rejection')
}
const pending = () => gate.list().requests
const card = (requestId: string) => messages.find((m) => m.kind === 'permission' && m.permissionRequestId === requestId)
const runCard = (runId: string) => messages.find((m) => m.kind === 'run' && m.scriptRunId === runId)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentcontrol-be14-'))
  runner = fakeRunner()
  agents = [agent('a1'), agent('a2')]
  conversations = agents.map((a) => dm(a.id))
  messages = []
  events = []
  proxyUp = true
  alwaysSet = []
  clock = Date.parse('2026-10-30T12:00:00.000Z')
  ids = 0
  n = 0
  gate = makeGate()
  svc = make(gate)
})
afterEach(async () => {
  for (const id of ['a1', 'a2']) await svc.stopAgent(id).catch(() => 0)
  for (let i = 0; i < 100 && svc.activeCount(); i++) {
    for (const p of [...runner.pending]) p.end()
    await new Promise((r) => setTimeout(r, 2))
  }
  await svc.idle()
  gate.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('Ask: waiting_permission and the card', () => {
  it('a run with network on waits for a persisted internet request (hosts, why, script, expiresAt); nothing runs yet', async () => {
    const run = await start('a1', { hosts: ['api.example.com'] })
    expect(run).toMatchObject({ status: 'waiting_permission', waitingFor: 'permission', network: 'on' })
    expect(runner.requests).toHaveLength(0)
    const [r] = pending()
    expect(r).toMatchObject({
      id: 'perm_0001', runId: run.id, agentId: 'a1', conversationId: 'dm-a1', type: 'internet', status: 'pending',
      hosts: ['api.example.com'], why: 'get the data', scriptName: 'fetch.py', runKind: 'script',
      createdAt: '2026-10-30T12:00:00.000Z', expiresAt: '2026-10-30T12:10:00.000Z',
    })
    expect(svc.get(run.id)).toMatchObject({ waitingOnRequestId: r!.id, permissions: [{ type: 'internet', decision: 'pending', requestId: r!.id }] })
    expect(card(r!.id)).toMatchObject({ conversationId: 'dm-a1', authorAgentId: 'a1', content: 'Bot a1 wants to use the internet' })
    expect(runCard(run.id)!.scriptRun).toMatchObject({ status: 'waiting_permission', waitingFor: 'permission', network: 'on' })
    expect(events.some((e) => e.type === 'permission.requested' && e.request.id === r!.id)).toBe(true)
    const saved = JSON.parse(readFileSync(join(dir, 'permissions', 'requests.json'), 'utf8')) as { requests: PermissionRequest[] }
    expect(saved.requests.map((x) => x.id)).toEqual([r!.id])
  })

  it('allow_once: the run gets the internet once (internetGranted), the next run asks again', async () => {
    const run = await start('a1')
    const [r] = pending()
    const answered = await gate.answer(r!.id, 'allow_once')
    expect(answered).toMatchObject({ status: 'allowed_once', resolvedBy: 'user' })
    await until(() => runner.pending.length === 1)
    expect(runner.pending[0]!.req).toMatchObject({ runId: run.id, network: 'on', internetGranted: true })
    expect(svc.get(run.id)!.permissions).toEqual([{ type: 'internet', decision: 'allow_once', requestId: r!.id, source: 'card' }])
    expect(svc.get(run.id)!.waitingFor).toBeUndefined()
    expect(card(r!.id)!.content).toBe('Internet allowed once')
    runner.pending[0]!.end()
    expect((await svc.wait(run.id)).status).toBe('succeeded')
    const again = await start('a1')
    expect(again.status).toBe('waiting_permission')
    expect(pending()).toHaveLength(1)
  })

  it('deny: the run ends denied permission_denied (no record of a start); the model is told the user declined', async () => {
    const run = await start('a1')
    await gate.answer(pending()[0]!.id, 'deny')
    const done = await svc.wait(run.id)
    expect(done).toMatchObject({ status: 'denied', reason: 'permission_denied', error: INTERNET_DENIED_TEXT })
    expect(done.startedAt).toBeUndefined()
    expect(runner.requests).toHaveLength(0)
    expect(svc.modelResult(done)).toMatchObject({ status: 'denied', error: MODEL_INTERNET_DENIED, reason: 'permission_denied' })
    expect(runCard(run.id)!.scriptRun).toMatchObject({ status: 'denied', reason: 'permission_denied', error: INTERNET_DENIED_TEXT })
    // "Full output" of a run that never started: empty logs (the route answers 200 with no text).
    expect(readFileSync(svc.outputPath(run.id, 'stdout'), 'utf8')).toBe('')
    expect(readFileSync(svc.outputPath(run.id, 'stderr'), 'utf8')).toBe('')
  })

  it('always: sets only this bot to Always; the runs that waited on the card go on, later ones are not asked', async () => {
    const a = await start('a1')
    const b = await start('a1')
    const other = await start('a2')
    const reqs = pending()
    expect(reqs).toHaveLength(2) // one card per bot; a1's second run waits on the first card
    const r1 = reqs.find((r) => r.agentId === 'a1')!
    expect(svc.get(b.id)).toMatchObject({ status: 'waiting_permission', waitingOnRequestId: r1.id })
    await gate.answer(r1.id, 'always')
    expect(alwaysSet).toEqual(['a1'])
    // One run per bot at a time: a, then b (both granted, no new card).
    await until(() => runner.pending.length === 1)
    expect(runner.pending[0]!.req).toMatchObject({ runId: a.id, internetGranted: true })
    expect(svc.get(b.id)!.status).toBe('queued')
    expect(pending().filter((r) => r.agentId === 'a1')).toEqual([])
    runner.pending[0]!.end()
    await until(() => runner.pending.length === 1 && runner.pending[0]!.req.runId === b.id)
    expect(runner.pending[0]!.req.internetGranted).toBe(true)
    expect(svc.get(a.id)!.permissions[0]).toMatchObject({ decision: 'always', source: 'card' })
    expect(svc.get(b.id)!.permissions[0]).toMatchObject({ decision: 'always', source: 'policy' })
    expect(svc.get(other.id)!.status).toBe('waiting_permission')
    const c = await start('a1')
    expect(c.status).toBe('queued')
    expect(gate.get(r1.id)).toMatchObject({ status: 'always', resolvedBy: 'user' })
  })

  it('a failed Always save: 500 with no reason, the request stays pending', async () => {
    gate = makeGate({ setAlways: () => { throw new Error('disk full') } })
    svc = make(gate)
    await start('a1')
    const e = await rejects(gate.answer(pending()[0]!.id, 'always'))
    expect(e.statusCode).toBe(500)
    expect(e.reason).toBeUndefined()
    expect(pending()[0]!.status).toBe('pending')
  })

  it('timeout after expiresAt: denied permission_timeout, the card says it expired', async () => {
    gate = makeGate({ timeoutMs: 40 })
    svc = make(gate)
    const run = await start('a1')
    const r = pending()[0]!
    const done = await svc.wait(run.id)
    expect(done).toMatchObject({ status: 'denied', reason: 'permission_timeout', error: PERMISSION_TIMEOUT_TEXT })
    expect(svc.modelResult(done).error).toBe(MODEL_PERMISSION_TIMEOUT)
    expect(gate.get(r.id)).toMatchObject({ status: 'timeout' })
    expect(gate.get(r.id)!.resolvedBy).toBeUndefined()
    expect(card(r.id)!.content).toBe('Internet request expired')
  })

  it('a denied card re-asks for the next run that waited on it (oldest first)', async () => {
    const a = await start('a1')
    const b = await start('a1')
    const first = pending()[0]!
    await gate.answer(first.id, 'deny')
    expect((await svc.wait(a.id)).status).toBe('denied')
    await until(() => pending().length === 1)
    const next = pending()[0]!
    expect(next).toMatchObject({ runId: b.id, status: 'pending' })
    expect(next.id).not.toBe(first.id)
    expect(svc.get(b.id)).toMatchObject({ status: 'waiting_permission', waitingOnRequestId: next.id })
  })

  it('Stop while waiting: the run ends stopped, the request denied run_stopped', async () => {
    const run = await start('a1')
    const r = pending()[0]!
    const stopped = await svc.stop(run.id)
    expect(stopped).toMatchObject({ status: 'stopped', error: STOPPED_QUEUED_TEXT })
    expect(gate.get(r.id)).toMatchObject({ status: 'denied', closedBy: 'run_stopped' })
    expect(card(r.id)!.content).toBe('Internet request closed (run stopped)')
    expect(await rejects(gate.answer(r.id, 'allow_once'))).toMatchObject({ statusCode: 409, reason: 'already_resolved', request: { id: r.id, status: 'denied' } })
  })
})

describe('admit without a card', () => {
  it('Never: denied internet_never with the bot-named text, no request; the model gets its own text', async () => {
    agents = [agent('a1', 'never')]
    const run = await start('a1')
    expect(run).toMatchObject({ status: 'denied', reason: 'internet_never', error: internetNeverText('Bot a1') })
    expect(pending()).toEqual([])
    expect(svc.modelResult(run).error).toBe(modelInternetNever('Bot a1'))
  })
  it('Always: queued and granted with source policy, no card', async () => {
    agents = [agent('a1', 'always')]
    const run = await start('a1')
    await until(() => runner.pending.length === 1)
    expect(runner.pending[0]!.req.internetGranted).toBe(true)
    expect(svc.get(run.id)!.permissions).toEqual([{ type: 'internet', decision: 'always', source: 'policy' }])
    expect(pending()).toEqual([])
  })
  it('Ask with the proxy down: a recorded run ended failed proxy_unavailable (run card), no permission card', async () => {
    proxyUp = false
    const run = await start('a1')
    expect(run).toMatchObject({ status: 'failed', reason: 'proxy_unavailable', error: PROXY_UNAVAILABLE, network: 'on' })
    expect(svc.get(run.id)).toMatchObject({ status: 'failed', reason: 'proxy_unavailable', error: PROXY_UNAVAILABLE })
    expect(svc.list('a1').runs.map((r) => [r.id, r.status])).toEqual([[run.id, 'failed']])
    expect(runCard(run.id)!.scriptRun).toMatchObject({ status: 'failed', reason: 'proxy_unavailable' })
    expect(pending()).toEqual([])
    expect(messages.filter((m) => m.kind === 'permission')).toEqual([])
    expect(runner.requests).toHaveLength(0)
    expect(svc.modelResult(run).error).toBe(PROXY_UNAVAILABLE)
    expect(readFileSync(svc.outputPath(run.id, 'stdout'), 'utf8')).toBe('')
  })
  it('network off needs no gate decision', async () => {
    const run = await start('a1', { network: 'off' })
    expect(run.status).toBe('queued')
    expect(pending()).toEqual([])
  })
})

describe('settings and bot changes while a request is pending', () => {
  it('→ Never: the request ends denied policy_changed and its runs denied internet_never', async () => {
    const a = await start('a1')
    const b = await start('a1')
    const r = pending()[0]!
    agents = agents.map((x) => (x.id === 'a1' ? { ...x, internetPolicy: 'never' } : x))
    await gate.settingsChanged('a1', { internetPolicy: 'ask', browser: false })
    expect(gate.get(r.id)).toMatchObject({ status: 'denied', closedBy: 'policy_changed' })
    expect(gate.get(r.id)!.resolvedBy).toBeUndefined()
    for (const id of [a.id, b.id]) expect(await svc.wait(id)).toMatchObject({ status: 'denied', reason: 'internet_never', error: internetNeverText('Bot a1') })
    expect(pending()).toEqual([])
  })
  it('→ Always: the request ends always with no resolvedBy; the run goes on', async () => {
    const a = await start('a1')
    const r = pending()[0]!
    agents = agents.map((x) => (x.id === 'a1' ? { ...x, internetPolicy: 'always' } : x))
    await gate.settingsChanged('a1', { internetPolicy: 'ask', browser: false })
    expect(gate.get(r.id)).toMatchObject({ status: 'always' })
    expect(gate.get(r.id)!.resolvedBy).toBeUndefined()
    await until(() => runner.pending.length === 1)
    expect(runner.pending[0]!.req).toMatchObject({ runId: a.id, internetGranted: true })
    expect(svc.get(a.id)!.permissions[0]).toMatchObject({ decision: 'always', source: 'policy' })
  })
  it('bot deleted: the request ends denied run_ended, its runs stop, nothing is asked again', async () => {
    const a = await start('a1')
    const b = await start('a1')
    const r = pending()[0]!
    gate.agentDeleted('a1')
    await svc.stopAgent('a1')
    expect(gate.get(r.id)).toMatchObject({ status: 'denied', closedBy: 'run_ended' })
    for (const id of [a.id, b.id]) expect(svc.get(id)!.status).toBe('stopped')
    await new Promise((res) => setTimeout(res, 20))
    expect(gate.list({ status: 'all' }).requests).toHaveLength(1)
  })
})

describe('restart', () => {
  it('runs left waiting_permission end failed RESTART_QUEUED_TEXT; pending requests close (run_ended, or timeout when past expiresAt)', async () => {
    const a = await start('a1')
    const b = await start('a2')
    const [ra, rb] = [pending().find((r) => r.agentId === 'a1')!, pending().find((r) => r.agentId === 'a2')!]
    // Make a2's request already expired in the file.
    const file = join(dir, 'permissions', 'requests.json')
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { requests: PermissionRequest[] }
    saved.requests.find((r) => r.id === rb.id)!.expiresAt = '2026-10-30T11:00:00.000Z'
    writeFileSync(file, JSON.stringify(saved))
    gate.close()
    const old = runner
    runner = fakeRunner()
    gate = makeGate()
    svc = make(gate)
    expect(await svc.recover()).toBe(2)
    expect(gate.recover()).toBe(2)
    for (const id of [a.id, b.id]) expect(svc.get(id)).toMatchObject({ status: 'failed', error: RESTART_QUEUED_TEXT })
    expect(svc.get(a.id)!.waitingFor).toBeUndefined()
    expect(gate.get(ra.id)).toMatchObject({ status: 'denied', closedBy: 'run_ended' })
    expect(gate.get(rb.id)).toMatchObject({ status: 'timeout' })
    expect(gate.recover()).toBe(0)
    for (const p of [...old.pending]) p.end()
  })
})

describe('list / get / answer errors', () => {
  it('list: pending by default, newest first, with now; status=all with limit and before', async () => {
    agents = [agent('a1'), agent('a2'), agent('a3')]
    conversations = agents.map((a) => dm(a.id))
    for (const id of ['a1', 'a2', 'a3']) {
      await start(id)
      clock += 1000
    }
    await gate.answer(pending().find((r) => r.agentId === 'a1')!.id, 'deny')
    const l = gate.list()
    expect(l.now).toBe(new Date(clock).toISOString())
    expect(l.requests.map((r) => r.agentId)).toEqual(['a3', 'a2'])
    expect(gate.list({ status: 'all' }).requests.map((r) => r.agentId)).toEqual(['a3', 'a2', 'a1'])
    expect(gate.list({ status: 'all', limit: 1 }).requests.map((r) => r.agentId)).toEqual(['a3'])
    const before = gate.list({ status: 'all', limit: 1 }).requests[0]!.createdAt
    expect(gate.list({ status: 'all', before }).requests.map((r) => r.agentId)).toEqual(['a2', 'a1'])
    expect(gate.list({ agentId: 'a2' }).requests).toHaveLength(1)
    expect(gate.list({ conversationId: 'dm-a3' }).requests).toHaveLength(1)
    for (const id of ['a3']) await svc.stopAgent(id)
  })
  it('parsePermissionQuery: 400 on a bad status, limit (default 50, max 200) or before', () => {
    expect(parsePermissionQuery({})).toEqual({})
    expect(parsePermissionQuery({ status: 'all', limit: '200', before: '2026-10-30T12:00:00Z', agentId: 'a1' })).toEqual({ status: 'all', limit: 200, before: '2026-10-30T12:00:00.000Z', agentId: 'a1' })
    for (const q of [{ status: 'open' }, { limit: '0' }, { limit: '201' }, { limit: '5x' }, { before: 'yesterday' }]) {
      expect(() => parsePermissionQuery(q)).toThrow(expect.objectContaining({ statusCode: 400 }) as never)
    }
  })
  it('answer: 404 not_found, 400 bad_decision (enable is a browser answer), 409 already_resolved with the request', async () => {
    expect(await rejects(gate.answer('perm_nope', 'deny'))).toMatchObject({ statusCode: 404, reason: 'not_found' })
    await start('a1')
    const r = pending()[0]!
    for (const d of ['enable', 'yes', undefined, 3]) expect(await rejects(gate.answer(r.id, d))).toMatchObject({ statusCode: 400, reason: 'bad_decision' })
    await gate.answer(r.id, 'deny')
    const e = await rejects(gate.answer(r.id, 'deny'))
    expect(e).toMatchObject({ statusCode: 409, reason: 'already_resolved', request: { id: r.id, status: 'denied', resolvedBy: 'user' } })
  })
  it('hostsProblem: a list of up to 10 host names / IPs', () => {
    expect(hostsProblem(undefined)).toBeNull()
    expect(hostsProblem(['api.example.com', '1.2.3.4'])).toBeNull()
    expect(hostsProblem('api.example.com')).toMatch(/list/)
    expect(hostsProblem(['http://x.com/a'])).toMatch(/host names/)
    expect(hostsProblem(Array.from({ length: 11 }, (_, i) => `h${i}.example.com`))).toMatch(/max 10/)
  })
  it('permissionContent texts', () => {
    const base = { id: 'p', runId: 'r', agentId: 'a', conversationId: 'c', type: 'internet', createdAt: '', expiresAt: '', runKind: 'tool_build' } as unknown as PermissionRequest
    expect(permissionContent({ ...base, status: 'allowed_once' }, 'Bot')).toBe('Internet allowed for the tool build')
    expect(permissionContent({ ...base, status: 'always' }, 'Bot')).toBe('Internet always allowed for Bot')
    expect(permissionContent({ ...base, status: 'denied', closedBy: 'policy_changed' }, 'Bot')).toBe('Internet request closed (set to Never for Bot)')
  })
})

describe('vm_install under Ask (tool build)', () => {
  const spec = (over: Partial<ToolBuildSpec> = {}): ToolBuildSpec => ({
    agentId: 'a1', conversationId: 'dm-a1', context: { kind: 'dm' }, via: 'vm_install', startedBy: 'bot', argv: ['vm_install', 'ffmpeg'],
    packages: ['jq', 'ffmpeg'], added: ['ffmpeg'], network: 'on', permissions: [], why: 'audio', waitForRuns: true,
    build: async () => ({ generation: 3 }), ...over,
  })
  it('waits for an internet card with the expected hosts and holds the build lock; allow_once starts the build', async () => {
    let started = false
    const run = await svc.startToolBuild(spec({ build: async () => { started = true; return { generation: 3 } } }))
    expect(run).toMatchObject({ kind: 'tool_build', status: 'waiting_permission', waitingFor: 'permission' })
    expect(svc.buildActive('a1')).toBe(true)
    const r = pending()[0]!
    expect(r).toMatchObject({ runKind: 'tool_build', why: 'audio', hosts: [...VM_INSTALL_EXPECTED_HOSTS] })
    expect(r.scriptName).toBeUndefined()
    // A run started meanwhile queues behind the build.
    expect(await rejects(svc.startToolBuild(spec()))).toMatchObject({ statusCode: 409, reason: 'build_active' })
    await gate.answer(r.id, 'allow_once')
    expect(await svc.wait(run.id)).toMatchObject({ status: 'succeeded' })
    expect(started).toBe(true)
    expect(svc.get(run.id)!.permissions[0]).toMatchObject({ decision: 'allow_once', requestId: r.id })
    expect(card(r.id)!.content).toBe('Internet allowed for the tool build')
    expect(svc.buildActive('a1')).toBe(false)
  })
  it('deny ends the build denied without building; the lock is released', async () => {
    let started = false
    const run = await svc.startToolBuild(spec({ build: async () => { started = true; return { generation: 3 } } }))
    await gate.answer(pending()[0]!.id, 'deny')
    expect(await svc.wait(run.id)).toMatchObject({ status: 'denied', reason: 'permission_denied' })
    expect(started).toBe(false)
    expect(svc.buildActive('a1')).toBe(false)
  })
})

describe('network_off and host_blocked reasons', () => {
  it('an offline run failing to connect: network_off with the bot-named hint', async () => {
    const run = await start('a1', { network: 'off' })
    await until(() => runner.pending.length === 1)
    runner.pending[0]!.end({ status: 'error', outcome: 'failed', exitCode: 1, stderr: 'curl: (6) Could not resolve host: x (Temporary failure in name resolution)\n' })
    expect(await svc.wait(run.id)).toMatchObject({ status: 'failed', reason: 'network_off', error: networkOffText('Bot a1') })
  })
  it('an offline run failing for another reason has no network reason', async () => {
    const run = await start('a1', { network: 'off' })
    await until(() => runner.pending.length === 1)
    runner.pending[0]!.end({ status: 'error', outcome: 'failed', exitCode: 1, stderr: 'KeyError: x\n' })
    expect((await svc.wait(run.id)).reason).toBeUndefined()
  })
  it('a failed online run whose proxy blocked a host: host_blocked, first blocked reason; on the card with hostsContacted', async () => {
    agents = [agent('a1', 'always')]
    const run = await start('a1')
    await until(() => runner.pending.length === 1)
    runner.pending[0]!.end({
      status: 'error', outcome: 'failed', exitCode: 7,
      hostsContacted: [{ host: '192.168.1.5', count: 1, blocked: true, reason: 'home_network' }, { host: 'pypi.org', count: 2, blocked: false }],
    })
    const done = await svc.wait(run.id)
    expect(done).toMatchObject({ status: 'failed', reason: 'host_blocked', error: HOST_BLOCKED_TEXT.home_network })
    expect(runCard(run.id)!.scriptRun).toMatchObject({ reason: 'host_blocked', internet: 'always', hostsContacted: [{ host: '192.168.1.5', blocked: true }, { host: 'pypi.org' }] })
  })
  it('a succeeded online run with a blocked host keeps succeeded and no reason', async () => {
    agents = [agent('a1', 'always')]
    const run = await start('a1')
    await until(() => runner.pending.length === 1)
    runner.pending[0]!.end({ hostsContacted: [{ host: '10.0.0.1', count: 1, blocked: true, reason: 'home_network' }] })
    const done = await svc.wait(run.id)
    expect(done.status).toBe('succeeded')
    expect(done.reason).toBeUndefined()
  })
})

describe('persistence', () => {
  it('requests survive a new gate (pending kept until recover)', async () => {
    await start('a1')
    const r = pending()[0]!
    const g2 = makeGate()
    expect(g2.get(r.id)).toMatchObject({ id: r.id, status: 'pending' })
    expect(existsSync(join(dir, 'permissions', 'requests.json'))).toBe(true)
    g2.close()
  })
  it('an unreadable file is logged and starts empty', () => {
    mkdirSync(join(dir, 'permissions'), { recursive: true })
    writeFileSync(join(dir, 'permissions', 'requests.json'), '{nope')
    const logs: string[] = []
    const g = makeGate({ log: (m) => logs.push(m) })
    expect(g.list().requests).toEqual([])
    expect(logs.some((m) => m.includes("couldn't read"))).toBe(true)
    g.close()
  })
})
