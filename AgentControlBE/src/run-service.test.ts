import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NETWORK_UNAVAILABLE } from './podman-runner.js'
import {
  createRunService, LOW_DISK_TEXT, MODEL_TAIL_BYTES, RESTART_QUEUED_TEXT, RESTART_RUNNING_TEXT, RUN_FREE_FLOOR_BYTES,
  STOPPED_QUEUED_TEXT, tailUtf8, type RunService, type RunServiceDeps, type ToolBuildSpec,
} from './run-service.js'
import { fakeRunner, until, type FakeRunner } from './run-service.fake.js'
import type { Agent, ChatMessage, Conversation, HostContact, LiveEvent, ScriptRunUndo } from './shared/types.js'

/** BE-P2-12: RunService with a fake runner (no Podman). */

const GB = 1024 ** 3
let dir = ''
let runner: FakeRunner
let agents: Agent[]
let conversations: Conversation[]
let messages: ChatMessage[]
let events: LiveEvent[]
let free: number | null
let concurrency: number
let saves = 0
let n = 0
let svc: RunService

const agent = (id: string): Agent => ({ id, slug: id, name: id } as unknown as Agent)
const dm = (agentId: string): Conversation => ({ id: `dm-${agentId}`, kind: 'dm', agentId, createdAt: '', updatedAt: '', lastReadAt: null } as unknown as Conversation)

function make(extra: Partial<RunServiceDeps> = {}): RunService {
  return createRunService({
    runner,
    getAgent: (id) => agents.find((a) => a.id === id),
    conversations: () => conversations,
    messages: () => messages,
    save: () => {
      saves++
    },
    root: () => join(dir, 'runs'),
    concurrency: () => concurrency,
    freeBytes: () => free,
    publish: (e) => events.push(e),
    newRunId: () => `run_${String(++n).padStart(4, '0')}`,
    flushMs: 20,
    ...extra,
  })
}
const start = (agentId = 'a1', extra: Record<string, unknown> = {}) =>
  svc.start({ agentId, conversationId: `dm-${agentId}`, context: { kind: 'dm' }, argv: ['python', 'scripts/report.py'], ...extra })
async function rejects(p: Promise<unknown>): Promise<{ statusCode: number; reason?: string; message: string }> {
  try {
    await p
  } catch (err) {
    return err as { statusCode: number; reason?: string; message: string }
  }
  throw new Error('expected a rejection')
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentcontrol-be12-'))
  runner = fakeRunner()
  agents = [agent('a1'), agent('a2'), agent('a3')]
  conversations = agents.map((a) => dm(a.id))
  messages = []
  events = []
  free = 100 * GB
  concurrency = 1
  saves = 0
  n = 0
  svc = make()
})
afterEach(async () => {
  for (let i = 0; i < 100 && svc.activeCount(); i++) {
    for (const p of [...runner.pending]) p.end()
    await new Promise((r) => setTimeout(r, 2))
  }
  await svc.idle()
  rmSync(dir, { recursive: true, force: true })
})

describe('lifecycle', () => {
  it('queues, runs, streams to the log and record, and ends with a card and events', async () => {
    const run = await start()
    expect(run.id).toBe('run_0001')
    await until(() => runner.pending.length === 1)
    expect(svc.get(run.id)!.status).toBe('running')
    const req = runner.pending[0]!.req
    expect(req).toMatchObject({ agentId: 'a1', runId: run.id, cwd: 'workspace', network: 'off', timeoutSec: 600 })
    runner.pending[0]!.out('stdout', 'hello ')
    runner.pending[0]!.out('stdout', 'world\n')
    runner.pending[0]!.out('stderr', 'warn\n')
    await until(() => events.some((e) => e.type === 'run.output'))
    const outs = events.filter((e) => e.type === 'run.output')
    // Coalesced: both stdout chunks in one event.
    expect(outs.filter((e) => e.type === 'run.output' && e.stream === 'stdout')).toEqual([
      expect.objectContaining({ runId: run.id, conversationId: 'dm-a1', chunk: 'hello world\n' }),
    ])
    runner.pending[0]!.end({ exitCode: 0, filesChanged: [{ path: 'out.txt', change: 'added', root: 'agent' } as never], snapshot: { id: run.id, driver: 'copy', retainedBytes: 10 } })
    const done = await svc.wait(run.id)
    expect(done).toMatchObject({ status: 'succeeded', exitCode: 0, stdoutTail: 'hello world\n', stderrTail: 'warn\n', outputBytes: 17, runtime: 'runsc', undo: { state: 'available' } })
    expect(done.startedAt && done.endedAt).toBeTruthy()
    expect(done.filesChanged).toHaveLength(1)
    // Persisted record and full logs.
    const rec = JSON.parse(readFileSync(join(dir, 'runs', 'a1', `${run.id}.json`), 'utf8'))
    expect(rec.status).toBe('succeeded')
    expect(readFileSync(svc.outputPath(run.id, 'stdout'), 'utf8')).toBe('hello world\n')
    expect(readFileSync(svc.outputPath(run.id, 'stderr'), 'utf8')).toBe('warn\n')
    // One chat card, updated in place.
    const cards = messages.filter((m) => m.kind === 'run')
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ conversationId: 'dm-a1', scriptRunId: run.id, authorAgentId: 'a1', scriptRun: { status: 'succeeded', scriptName: 'report.py', files: { added: 1, modified: 0, deleted: 0 } } })
    expect(done.messageId).toBe(cards[0]!.id)
    expect(saves).toBeGreaterThan(0)
    const statuses = events.filter((e) => e.type === 'run.updated').map((e) => (e.type === 'run.updated' ? e.run.status : ''))
    expect(statuses[0]).toBe('queued')
    expect(statuses).toContain('running')
    expect(statuses.at(-1)).toBe('succeeded')
  })

  it('maps failed, timed_out and runner errors', async () => {
    const a = await start('a1')
    await until(() => runner.pending.length === 1)
    runner.pending[0]!.end({ status: 'error', outcome: 'failed', exitCode: 2, error: 'The script exited with code 2.' })
    expect(await svc.wait(a.id)).toMatchObject({ status: 'failed', exitCode: 2, error: 'The script exited with code 2.', undo: { state: 'unavailable' } })
    const b = await start('a1')
    await until(() => runner.pending.length === 1)
    runner.pending[0]!.end({ status: 'error', outcome: 'timed_out', exitCode: undefined, error: 'The script ran past its time limit.' })
    expect(await svc.wait(b.id)).toMatchObject({ status: 'timed_out', error: 'The script ran past its time limit.' })
    // A runner without outcome: status decides.
    const c = await start('a1')
    await until(() => runner.pending.length === 1)
    runner.pending[0]!.end({ status: 'error', outcome: undefined, exitCode: 1 })
    expect((await svc.wait(c.id)).status).toBe('failed')
  })

  it('stops a running run (abort) and a queued one, and refuses an ended one', async () => {
    const a = await start('a1')
    const b = await start('a2')
    await until(() => runner.pending.length === 1)
    expect(svc.get(b.id)!.status).toBe('queued')
    const sq = await svc.stop(b.id)
    expect(sq).toMatchObject({ status: 'stopped', error: STOPPED_QUEUED_TEXT })
    expect(runner.requests.map((r) => r.runId)).toEqual([a.id])
    const sr = await svc.stop(a.id)
    expect(sr.status).toBe('stopped')
    const err = await rejects(svc.stop(a.id))
    expect(err).toMatchObject({ statusCode: 409, reason: 'not_active' })
    expect((await rejects(svc.stop('run_nope'))).statusCode).toBe(404)
  })

  it('stopAgent ends the bot\'s queued and running runs only', async () => {
    concurrency = 1
    const a = await start('a1')
    const b = await start('a1')
    const c = await start('a2')
    await until(() => runner.pending.length === 1)
    expect(await svc.stopAgent('a1')).toBe(2)
    await until(() => runner.pending.length === 1 && runner.pending[0]!.req.agentId === 'a2')
    expect((await svc.wait(a.id)).status).toBe('stopped')
    expect((await svc.wait(b.id)).status).toBe('stopped')
    expect(svc.get(c.id)!.status).toBe('running')
  })
})

describe('queue', () => {
  it('Mac/Windows (1 at a time): the 2nd run is queued with 1 ahead, shown on its card', async () => {
    concurrency = 1
    const a = await start('a1')
    const b = await start('a2')
    expect(b.status).toBe('queued')
    expect(b.queuePosition).toBe(1)
    await until(() => runner.pending.length === 1)
    expect(svc.get(b.id)).toMatchObject({ status: 'queued', queuePosition: 1 })
    const card = messages.find((m) => m.scriptRunId === b.id)!
    expect(card.scriptRun).toMatchObject({ status: 'queued', queuePosition: 1 })
    expect(card.content).toMatch(/queued/i)
    expect(svc.waiting('a2')).toBe(1)
    expect(svc.activeCount()).toBe(2)
    const c = await start('a3')
    expect(c.queuePosition).toBe(2)
    runner.pending[0]!.end()
    await svc.wait(a.id)
    await until(() => runner.pending.length === 1 && runner.pending[0]!.req.runId === b.id)
    expect(svc.get(b.id)!.status).toBe('running')
    expect(svc.get(b.id)!.queuePosition).toBeUndefined()
    expect(svc.get(c.id)!.queuePosition).toBe(1)
  })

  it('Linux formula (e.g. 2 at a time): two bots run together; one bot still runs one at a time', async () => {
    concurrency = 2
    const a = await start('a1')
    const b = await start('a2')
    await until(() => runner.pending.length === 2)
    expect(svc.get(a.id)!.status).toBe('running')
    expect(svc.get(b.id)!.status).toBe('running')
    const c = await start('a3')
    expect(c.queuePosition).toBe(2)
    const d = await start('a1')
    runner.pending.find((p) => p.req.runId === b.id)!.end()
    // a3's run takes the free slot; a1's 2nd waits for a1's 1st.
    await until(() => runner.pending.some((p) => p.req.runId === c.id))
    expect(svc.get(d.id)!.status).toBe('queued')
    runner.pending.find((p) => p.req.runId === a.id)!.end()
    await until(() => runner.pending.some((p) => p.req.runId === d.id))
  })
})

describe('blocks', () => {
  it('under 3 GB free refuses the run (409 low_disk), and nothing is recorded', async () => {
    free = RUN_FREE_FLOOR_BYTES - 1
    const err = await rejects(start())
    expect(err).toMatchObject({ statusCode: 409, reason: 'low_disk', message: LOW_DISK_TEXT })
    expect(svc.list('a1').runs).toHaveLength(0)
    expect(runner.requests).toHaveLength(0)
    free = RUN_FREE_FLOOR_BYTES
    await start()
    await until(() => runner.pending.length === 1)
  })

  it('unknown free space allows the run', async () => {
    free = null
    await start()
    await until(() => runner.pending.length === 1)
  })

  it('space dropping under 3 GB while queued fails the run at its turn (reason low_disk)', async () => {
    const a = await start('a1')
    const b = await start('a2')
    await until(() => runner.pending.length === 1)
    free = 2 * GB
    runner.pending[0]!.end()
    await svc.wait(a.id)
    const done = await svc.wait(b.id)
    expect(done).toMatchObject({ status: 'failed', reason: 'low_disk', error: LOW_DISK_TEXT })
    expect(runner.requests).toHaveLength(1)
  })

  it.each(['limits_unenforced', 'mounts_unusable', 'personal_quota', 'snapshot_failed', 'gvisor_unavailable'])('runner check %s → 409 with the reason', async (reason) => {
    runner.refuse = { status: 'error', outcome: 'failed', reason, error: `blocked: ${reason}`, durationMs: 0, stdout: '', stderr: '', filesChanged: [] }
    const err = await rejects(start())
    expect(err).toMatchObject({ statusCode: 409, reason, message: `blocked: ${reason}` })
  })

  it('a block found at run time fails the run with the reason', async () => {
    const a = await start()
    await until(() => runner.pending.length === 1)
    runner.pending[0]!.end({ status: 'error', outcome: 'failed', reason: 'snapshot_failed', error: "Undo couldn't be prepared." })
    expect(await svc.wait(a.id)).toMatchObject({ status: 'failed', reason: 'snapshot_failed' })
  })

  it('the personal 10 GB limit → 409 personal_quota', async () => {
    svc = make({ personal: async () => ({ blocked: 'Over 10 GB.' }) })
    expect(await rejects(start())).toMatchObject({ statusCode: 409, reason: 'personal_quota', message: 'Over 10 GB.' })
  })

  it('network on (M1) is a failed record the model is told about, not an error', async () => {
    runner.refuse = { status: 'error', outcome: 'failed', error: NETWORK_UNAVAILABLE, durationMs: 0, stdout: '', stderr: NETWORK_UNAVAILABLE, filesChanged: [] }
    const run = await start('a1', { network: 'on' })
    expect(run).toMatchObject({ status: 'failed', error: NETWORK_UNAVAILABLE, network: 'on' })
    expect(svc.get(run.id)!.status).toBe('failed')
    expect(messages.find((m) => m.scriptRunId === run.id)!.scriptRun!.status).toBe('failed')
  })

  it('bad input: 400 for argv/cwd and a chat mismatch, 404 for an unknown bot or chat', async () => {
    runner.refuse = { status: 'error', outcome: 'failed', error: 'Give the command to run.', durationMs: 0, stdout: '', stderr: '', filesChanged: [] }
    expect((await rejects(start())).statusCode).toBe(400)
    runner.refuse = null
    expect((await rejects(start('nope'))).statusCode).toBe(404)
    expect((await rejects(svc.start({ agentId: 'a1', conversationId: 'dm-zzz', context: { kind: 'dm' }, argv: ['ls'] }))).statusCode).toBe(404)
    expect((await rejects(svc.start({ agentId: 'a1', conversationId: 'dm-a2', context: { kind: 'dm' }, argv: ['ls'] }))).statusCode).toBe(400)
  })
})

describe('output', () => {
  it('the model gets the last 8 KB per stream; the log keeps everything', async () => {
    const run = await start()
    await until(() => runner.pending.length === 1)
    const big = Array.from({ length: 2000 }, (_, i) => `line ${i} ✓\n`).join('')
    runner.pending[0]!.out('stdout', big)
    runner.pending[0]!.end({ outputTruncated: false })
    const done = await svc.wait(run.id)
    const m = svc.modelResult(done)
    expect(Buffer.byteLength(m.stdout)).toBeLessThanOrEqual(MODEL_TAIL_BYTES)
    expect(big.endsWith(m.stdout)).toBe(true)
    expect(m.stdout.endsWith('line 1999 ✓\n')).toBe(true)
    expect(readFileSync(svc.outputPath(run.id, 'stdout'), 'utf8')).toBe(big)
    expect(svc.bytes('a1', run.id)).toBe(Buffer.byteLength(big))
  })

  it('tailUtf8 never splits a character', () => {
    expect(tailUtf8('ab✓✓', 4)).toBe('✓')
    expect(tailUtf8('abc', 10)).toBe('abc')
  })

  it('an evicted log is 410 log_evicted; an unknown run 404', async () => {
    const run = await start()
    await until(() => runner.pending.length === 1)
    runner.pending[0]!.end()
    await svc.wait(run.id)
    svc.remove('a1', run.id)
    expect(existsSync(join(dir, 'runs', 'a1', `${run.id}.stdout.log`))).toBe(false)
    let err: unknown
    try {
      svc.outputPath(run.id, 'stdout')
    } catch (e) {
      err = e
    }
    expect(err).toMatchObject({ statusCode: 410, reason: 'log_evicted' })
    expect(() => svc.outputPath('run_nope', 'stdout')).toThrow()
  })
})

describe('records', () => {
  it('lists newest first in pages of up to 50 with hasMore and before=', async () => {
    const ids: string[] = []
    for (let i = 0; i < 3; i++) {
      const r = await start()
      await until(() => runner.pending.length === 1)
      runner.pending[0]!.end()
      await svc.wait(r.id)
      ids.push(r.id)
    }
    const p1 = svc.list('a1', { limit: 2 })
    expect(p1.runs.map((r) => r.id)).toEqual([ids[2], ids[1]])
    expect(p1.hasMore).toBe(true)
    expect(p1.runs[0]).toMatchObject({ status: 'succeeded', filesChangedCount: 0, files: { added: 0, modified: 0, deleted: 0 }, network: 'off' })
    const p2 = svc.list('a1', { limit: 2, before: ids[1] })
    expect(p2).toEqual({ runs: [expect.objectContaining({ id: ids[0] })], hasMore: false })
    expect(svc.list('a1', { limit: 500 }).runs).toHaveLength(3)
    expect(() => svc.list('a1', { before: 'run_nope' })).toThrow()
    expect(svc.list('a2').runs).toEqual([])
  })

  it('records survive a restart; runs left active are failed by recover()', async () => {
    const done = await start('a1')
    await until(() => runner.pending.length === 1)
    runner.pending[0]!.end()
    await svc.wait(done.id)
    const running = await start('a1')
    const queued = await start('a2')
    await until(() => runner.pending.length === 1)
    // "Restart": a new service on the same folder (the old runner's run never ends).
    const old = runner
    runner = fakeRunner()
    const recovered: string[] = []
    svc = make({
      recoverSnapshot: async (a) => {
        recovered.push(a.id)
        return a.id === 'a1' ? { runId: running.id, filesChanged: [{ path: 'x', change: 'modified', root: 'agent' } as never], snapshot: { id: running.id, driver: 'copy', retainedBytes: 1 }, undo: { state: 'available' } } : null
      },
    })
    expect(svc.get(done.id)!.status).toBe('succeeded')
    expect(await svc.recover()).toBe(2)
    expect(recovered.sort()).toEqual(['a1', 'a2'])
    expect(svc.get(running.id)).toMatchObject({ status: 'failed', error: RESTART_RUNNING_TEXT, undo: { state: 'available' } })
    expect(svc.get(running.id)!.filesChanged).toHaveLength(1)
    expect(svc.get(queued.id)).toMatchObject({ status: 'failed', error: RESTART_QUEUED_TEXT })
    expect(svc.get(queued.id)!.queuePosition).toBeUndefined()
    expect(await svc.recover()).toBe(0)
    for (const p of [...old.pending]) p.end()
  })

  it('overlays the current undo state (evicted snapshots) on get and list', async () => {
    let state: ScriptRunUndo = { state: 'available' }
    svc = make({ undoState: () => state })
    const r = await start()
    await until(() => runner.pending.length === 1)
    runner.pending[0]!.end({ snapshot: { id: 'run_0001', driver: 'copy', retainedBytes: 1 } })
    await svc.wait(r.id)
    state = { state: 'unavailable', reason: 'evicted' as never }
    expect(svc.get(r.id)!.undo).toMatchObject({ state: 'unavailable' })
    expect(svc.list('a1').runs[0]!.undo).toMatchObject({ state: 'unavailable' })
  })

  it('undo records the undo run and marks the original undone', async () => {
    svc = make({
      undoApply: async (_a, runId) => ({
        runId, undo: { state: 'done', undoRunId: 'run_u1' }, undoRunId: 'run_u1', snapshot: { id: 'run_u1', driver: 'copy', retainedBytes: 2 },
        filesChanged: [{ path: 'a', change: 'deleted', root: 'agent' } as never], undoRunUndo: { state: 'available' }, skipped: [],
      }),
    })
    const r = await start()
    await until(() => runner.pending.length === 1)
    runner.pending[0]!.end({ snapshot: { id: r.id, driver: 'copy', retainedBytes: 1 } })
    await svc.wait(r.id)
    const res = await svc.undo(r.id)
    expect(res.run).toMatchObject({ status: 'undone', undo: { state: 'done', undoRunId: 'run_u1' } })
    expect(res.undoRun).toMatchObject({ id: 'run_u1', kind: 'undo', undoOfRunId: r.id, status: 'succeeded' })
    expect(svc.list('a1').runs.map((x) => x.id)).toContain('run_u1')
    const card = messages.find((m) => m.scriptRunId === 'run_u1')!
    expect(card.scriptRun).toMatchObject({ kind: 'undo', undoOfName: 'report.py' })
  })

  it('a partial undo still records its undo run (failed)', async () => {
    svc = make({
      undoApply: async () => {
        throw Object.assign(new Error('Undo stopped partway.'), { undoRun: { undoRunId: 'run_u2', snapshot: null, filesChanged: [], undo: { state: 'unavailable' } } })
      },
    })
    const r = await start()
    await until(() => runner.pending.length === 1)
    runner.pending[0]!.end({ snapshot: { id: r.id, driver: 'copy', retainedBytes: 1 } })
    await svc.wait(r.id)
    await expect(svc.undo(r.id)).rejects.toThrow('partway')
    expect(svc.get('run_u2')).toMatchObject({ kind: 'undo', status: 'failed', error: 'Undo stopped partway.' })
  })
})

describe('record pruning (same rule as logs)', () => {
  const DAY = 24 * 3600 * 1000
  async function runAt(agentId: string, end: Record<string, unknown> = {}) {
    const r = await start(agentId)
    await until(() => runner.pending.some((p) => p.req.runId === r.id))
    runner.pending.find((p) => p.req.runId === r.id)!.end(end as never)
    await svc.wait(r.id)
    return r.id
  }
  const has = (id: string, ext: string) => existsSync(join(dir, 'runs', 'a1', `${id}.${ext}`))

  it('removes records and logs past the last 20 runs and 7 days, keeping snapshot and linked runs', async () => {
    let clock = Date.now() - 8 * DAY
    const undo: Record<string, ScriptRunUndo> = {
      run_0002: { state: 'available' },
      run_0003: { state: 'unavailable', reason: 'evicted' as never },
      run_0004: { state: 'done', undoRunId: 'run_0001' },
    }
    svc = make({ now: () => new Date((clock += 1000)), undoState: (_slug, id) => undo[id] ?? null })
    const snap = (id: string) => ({ snapshot: { id, driver: 'copy', retainedBytes: 1 } })
    const ids: string[] = []
    for (let i = 1; i <= 26; i++) {
      const id = `run_${String(i).padStart(4, '0')}`
      ids.push(await runAt('a1', id === 'run_0002' || id === 'run_0003' ? snap(id) : id === 'run_0004' ? { ...snap(id), undo: undo.run_0004 } : {}))
    }
    expect(ids.every((id) => has(id, 'json'))).toBe(true)
    // Today: the 27th run makes runs 1–7 fall outside the last 20; all are 8 days old.
    clock = Date.now()
    await runAt('a1')
    expect(has('run_0002', 'json')).toBe(true) // its snapshot is kept (undo available)
    expect(has('run_0004', 'json')).toBe(true) // snapshot kept (undone; undo of the undo needs it)
    expect(has('run_0001', 'json')).toBe(true) // run_0004's undo run
    for (const id of ['run_0003', 'run_0005', 'run_0006', 'run_0007']) {
      expect(has(id, 'json')).toBe(false)
      expect(has(id, 'stdout.log')).toBe(false)
      expect(svc.get(id)).toBeNull()
    }
    expect(has('run_0001', 'stdout.log')).toBe(false) // a kept record's log still follows the log rule
    expect(has('run_0008', 'json')).toBe(true) // 20th newest
    const listed = svc.list('a1').runs.map((r) => r.id)
    expect(listed).toHaveLength(23)
    expect(listed).not.toContain('run_0005')
  })

  it('keeps every record under 7 days old, even past the last 20', async () => {
    let clock = Date.now() - 3 * DAY
    svc = make({ now: () => new Date((clock += 1000)) })
    for (let i = 0; i < 24; i++) await runAt('a1')
    clock = Date.now()
    await runAt('a1')
    expect(svc.list('a1').runs).toHaveLength(25)
    expect(has('run_0001', 'json')).toBe(true)
    expect(has('run_0001', 'stdout.log')).toBe(true)
  })

  it('recover() prunes old records of bots that no longer run', async () => {
    let clock = Date.now() - 9 * DAY
    svc = make({ now: () => new Date((clock += 1000)) })
    for (let i = 0; i < 22; i++) await runAt('a1')
    clock = Date.now()
    await svc.idle()
    svc = make({ now: () => new Date(clock) })
    await svc.recover()
    expect(svc.list('a1').runs).toHaveLength(20)
    expect(has('run_0001', 'json')).toBe(false)
  })
})

describe('bot slot before machine slot', () => {
  it("a bot busy with an undo doesn't hold the machine: another bot's run starts", async () => {
    concurrency = 1
    let release!: () => void
    const held = runner.exclusive('a1', () => new Promise<void>((r) => (release = r)))
    const a = await start('a1')
    // a1's slot is taken (undo): its run waits without a machine slot, 1 ahead.
    expect(svc.get(a.id)).toMatchObject({ status: 'queued', queuePosition: 1 })
    const b = await start('a2')
    await until(() => runner.pending.some((p) => p.req.runId === b.id))
    expect(svc.get(b.id)!.status).toBe('running')
    expect(runner.requests.some((r) => r.runId === a.id)).toBe(false)
    expect(svc.get(a.id)!.queuePosition).toBe(2) // a2's run + the undo
    release()
    await held
    // The undo is done; a1's run now waits for the machine slot (a2's run).
    await until(() => svc.get(a.id)!.queuePosition === 1)
    expect(svc.get(a.id)!.status).toBe('queued')
    runner.pending.find((p) => p.req.runId === b.id)!.end()
    await until(() => runner.pending.some((p) => p.req.runId === a.id))
    expect(svc.get(a.id)!.status).toBe('running')
    expect(svc.get(a.id)!.queuePosition).toBeUndefined()
  })
})

describe('BE-P2-22: runs wait for a tool build', () => {
  /** A build the test ends; `gen` is the bot's generation the fake build leaves. */
  function pendingBuild(agentId: string, o: { fail?: boolean } = {}) {
    let end!: () => void
    const done = new Promise<void>((r) => (end = r))
    const build = async () => {
      await done
      if (o.fail) throw Object.assign(new Error('E: Unable to locate package nope'), { statusCode: 502, reason: 'build_failed' })
      const a = agents.find((x) => x.id === agentId)! as unknown as { vm: { image: { generation: number } } }
      a.vm.image.generation++
      return { generation: a.vm.image.generation, log: 'built\n' }
    }
    return { end, build }
  }
  /** The generation each run saw when the runner got it (the runner reads the bot then). */
  function generationsAtRun(): Map<string, number> {
    const seen = new Map<string, number>()
    const run = runner.run.bind(runner)
    runner.run = (req) => {
      seen.set(req.runId!, (agents.find((a) => a.id === req.agentId) as unknown as { vm: { image: { generation: number } } }).vm.image.generation)
      return run(req)
    }
    return seen
  }
  beforeEach(() => {
    for (const a of agents) (a as unknown as { vm: unknown }).vm = { image: { generation: 0 } }
  })

  it('a run queued during a build starts after it, on the new generation; the record comes first', async () => {
    const seen = generationsAtRun()
    const b = pendingBuild('a1')
    const built = svc.toolBuild('a1', 'rebuild', b.build)
    expect(svc.buildActive('a1')).toBe(true)
    const r = await start('a1')
    // The build counts as 1 ahead.
    expect(r).toMatchObject({ status: 'queued', queuedReason: 'tool_build', queuePosition: 1 })
    const card = messages.find((m) => m.scriptRunId === r.id)!
    expect(card.scriptRun).toMatchObject({ queuedReason: 'tool_build', queuePosition: 1 })
    await new Promise((res) => setTimeout(res, 20))
    expect(runner.requests).toHaveLength(0)
    b.end()
    const rec = await built
    expect(rec).toMatchObject({ kind: 'tool_build', status: 'succeeded' })
    await until(() => runner.pending.length === 1)
    expect(seen.get(r.id)).toBe(1)
    expect(svc.buildActive('a1')).toBe(false)
    expect(svc.get(r.id)!.queuedReason).toBeUndefined()
    // Events: the build's record before the run's start.
    const order = events.filter((e) => e.type === 'run.updated').map((e) => (e.type === 'run.updated' ? `${e.run.id}:${e.run.status}` : ''))
    expect(order.indexOf(`${rec.id}:succeeded`)).toBeGreaterThanOrEqual(0)
    expect(order.indexOf(`${rec.id}:succeeded`)).toBeLessThan(order.indexOf(`${r.id}:running`))
    runner.pending[0]!.end()
    await svc.wait(r.id)
  })

  it('a failed build: the run still starts, on the previous generation', async () => {
    const seen = generationsAtRun()
    const b = pendingBuild('a1', { fail: true })
    const built = svc.toolBuild('a1', 'rebuild', b.build)
    const r = await start('a1')
    expect(r.queuedReason).toBe('tool_build')
    b.end()
    await expect(built).rejects.toMatchObject({ statusCode: 502 })
    await until(() => runner.pending.length === 1)
    expect(seen.get(r.id)).toBe(0)
    expect(svc.list('a1').runs.find((x) => x.kind === 'tool_build')).toMatchObject({ status: 'failed' })
    runner.pending[0]!.end()
    await svc.wait(r.id)
  })

  it('a 4xx from the build releases the lock too', async () => {
    const e = Object.assign(new Error('nope'), { statusCode: 409, reason: 'internet_unavailable' })
    let fail!: () => void
    const built = svc.toolBuild('a1', 'rebuild', () => new Promise((_, rej) => (fail = () => rej(e))))
    const r = await start('a1')
    fail()
    await expect(built).rejects.toBe(e)
    await until(() => runner.pending.length === 1)
    expect(runner.pending[0]!.req.runId).toBe(r.id)
  })

  it('rollback or a second build during a build → 409 build_active before run_active', async () => {
    const b = pendingBuild('a1')
    const built = svc.toolBuild('a1', 'rebuild', b.build)
    await start('a1')
    const err = await rejects(svc.toolBuild('a1', 'rollback', async () => ({ generation: 0, log: '' })))
    expect(err).toMatchObject({ statusCode: 409, reason: 'build_active', message: "Wait for the bot's tools to finish building first." })
    b.end()
    await built
    await until(() => runner.pending.length === 1)
    expect(await rejects(svc.toolBuild('a1', 'rollback', async () => ({ generation: 0, log: '' })))).toMatchObject({ statusCode: 409, reason: 'run_active' })
  })

  it("queuePosition: runs running now + queued ahead + the bot's build; queuedReason follows the build", async () => {
    const b = pendingBuild('a1')
    const built = svc.toolBuild('a1', 'rebuild', b.build)
    const other = await start('a2')
    await until(() => runner.pending.length === 1)
    const r1 = await start('a1')
    const r2 = await start('a1')
    const o3 = await start('a3')
    // r1: a2 running + its build; r2: + r1; a3 (no build): a2 running + r1 + r2.
    expect(svc.get(r1.id)).toMatchObject({ queuePosition: 2, queuedReason: 'tool_build' })
    expect(svc.get(r2.id)).toMatchObject({ queuePosition: 3, queuedReason: 'tool_build' })
    expect(svc.get(o3.id)).toMatchObject({ queuePosition: 3, queuedReason: 'slot' })
    expect(svc.list('a3').runs[0]).toMatchObject({ queuePosition: 3, queuedReason: 'slot' })
    b.end()
    await built
    // Build done: r1 and r2 now wait for the machine slot (1 at a time).
    await until(() => svc.get(r1.id)!.queuedReason === 'slot')
    expect(svc.get(r1.id)!.queuePosition).toBe(1)
    expect(svc.get(r2.id)).toMatchObject({ queuePosition: 2, queuedReason: 'slot' })
    const last = events.filter((e) => e.type === 'run.updated' && e.run.id === r1.id).at(-1)
    expect(last?.type === 'run.updated' && last.summary).toMatchObject({ queuedReason: 'slot', queuePosition: 1 })
    expect(svc.get(other.id)!.status).toBe('running')
  })

  it('withToolBuild (vm_install) holds the lock with no run_active check; nested holds count', async () => {
    const seen = generationsAtRun()
    let endA!: () => void
    let endB!: () => void
    const r0 = await start('a1')
    await until(() => runner.pending.length === 1)
    const a = svc.withToolBuild('a1', () => new Promise<string>((res) => (endA = () => res('a'))))
    const b = svc.withToolBuild('a1', () => new Promise<string>((res) => (endB = () => res('b'))))
    const r1 = await start('a1')
    expect(svc.get(r1.id)).toMatchObject({ queuedReason: 'tool_build', queuePosition: 2 })
    expect(await rejects(svc.toolBuild('a1', 'rebuild', async () => ({ generation: 1, log: '' })))).toMatchObject({ reason: 'build_active' })
    runner.pending[0]!.end()
    await svc.wait(r0.id)
    endA()
    expect(await a).toBe('a')
    await new Promise((res) => setTimeout(res, 20))
    expect(svc.get(r1.id)!.status).toBe('queued')
    ;(agents[0] as unknown as { vm: { image: { generation: number } } }).vm.image.generation = 4
    endB()
    expect(await b).toBe('b')
    await until(() => runner.pending.length === 1)
    expect(seen.get(r1.id)).toBe(4)
    expect(svc.buildActive('a1')).toBe(false)
  })

  it('a run launching when a vm_install starts goes back to wait for it', async () => {
    // start's floor check answers at once; the launch's waits until the vm_install has the lock.
    let calls = 0
    let release!: () => void
    const gateFree = new Promise<void>((r) => (release = r))
    svc = make({ freeBytes: async () => (++calls > 1 ? (await gateFree, free) : free) })
    const run = await start('a1')
    await until(() => calls === 2)
    expect(svc.get(run.id)!.status).toBe('queued')
    let end!: () => void
    const held = svc.withToolBuild('a1', () => new Promise<void>((res) => (end = res)))
    release()
    await new Promise((res) => setTimeout(res, 20))
    expect(runner.requests).toHaveLength(0)
    expect(svc.get(run.id)).toMatchObject({ status: 'queued', queuedReason: 'tool_build', queuePosition: 1 })
    end()
    await held
    await until(() => runner.pending.length === 1)
    expect(runner.pending[0]!.req.runId).toBe(run.id)
  })
})

describe('BE-P2-21: live tool-build records', () => {
  const vagent = (id: string, generation = 2): Agent =>
    ({ id, slug: id, name: 'Analyst', vm: { image: { generation, base: 'base' }, packages: ['jq'] } } as unknown as Agent)
  type Ctl = Parameters<ToolBuildSpec['build']>[0]
  /** A build that waits for finish()/fail() or its signal (a Stop throws `stopped`, like BotEnv). */
  function held() {
    let ctl!: Ctl
    let finish!: (r: { generation: number; log?: string; hosts?: HostContact[] }) => void
    let failWith!: (e: Error) => void
    const started = { yes: false }
    const build = (c: Ctl) =>
      new Promise<{ generation: number; log?: string; hosts?: HostContact[] }>((res, rej) => {
        ctl = c
        started.yes = true
        finish = res
        failWith = rej
        c.signal.addEventListener('abort', () => rej(Object.assign(new Error('The tool build was stopped.'), { stopped: true })), { once: true })
      })
    return { build, started, ctl: () => ctl, finish: (r: { generation: number; log?: string; hosts?: HostContact[] }) => finish(r), fail: (e: Error) => failWith(e) }
  }
  const spec = (over: Partial<ToolBuildSpec> = {}): ToolBuildSpec => ({
    agentId: 'a1', conversationId: 'dm-a1', context: { kind: 'dm' }, via: 'rebuild', startedBy: 'user', argv: ['rebuild'],
    packages: ['jq'], added: [], network: 'on', permissions: [{ type: 'internet', decision: 'allow_once', source: 'rebuild' }],
    waitForRuns: false, build: async () => ({ generation: 3 }), ...over,
  })
  const card = (runId: string) => messages.find((m) => m.kind === 'run' && m.scriptRunId === runId)
  beforeEach(() => {
    agents = [vagent('a1'), vagent('a2')]
  })
  afterEach(async () => {
    // A held build that a failing test left behind.
    for (const id of ['a1', 'a2']) await svc.stopAgent(id).catch(() => 0)
  })

  it('a running build: live progress and hosts (throttled), activeBuild, then succeeded with its card', async () => {
    const changedFor: string[] = []
    svc = make({ onRunsChanged: (id) => changedFor.push(id) })
    const h = held()
    const run = await svc.startToolBuild(spec({ build: h.build }))
    expect(run).toMatchObject({ kind: 'tool_build', network: 'on', build: { generation: 3, fromGeneration: 2, packages: ['jq'], via: 'rebuild', startedBy: 'user' } })
    await until(() => h.started.yes)
    expect(svc.get(run.id)!.status).toBe('running')
    expect(svc.activeBuild('a1')).toMatchObject({ runId: run.id, status: 'running', internet: 'once', hosts: [], build: { generation: 3 } })
    expect(svc.activeBuild('a2')).toBeNull()
    expect(svc.buildActive('a1')).toBe(true)
    const before = events.filter((e) => e.type === 'run.updated').length
    for (let i = 1; i <= 5; i++) h.ctl().onProgress({ step: i, steps: 6, label: `step ${i}` })
    h.ctl().onHosts([{ host: 'deb.debian.org', count: 2, blocked: false }, { host: 'bad.example', count: 1, blocked: true }])
    h.ctl().onOutput('stdout', 'Setting up jq\n')
    await until(() => events.filter((e) => e.type === 'run.updated').length > before)
    await new Promise((r) => setTimeout(r, 50))
    // One update for the burst (BUILD_UPDATE_MS), with the latest progress.
    const ups = events.filter((e) => e.type === 'run.updated').slice(before)
    expect(ups).toHaveLength(1)
    const last = ups[0]!
    expect(last.type === 'run.updated' && last.run.build?.progress).toEqual({ step: 5, steps: 6, label: 'step 5' })
    expect(svc.activeBuild('a1')!.hosts).toEqual(['deb.debian.org'])
    expect(card(run.id)!.content).toBe("Building Analyst's tools (version 3)")
    expect(card(run.id)!.scriptRun).toMatchObject({ name: 'Rebuild tools', status: 'running', internet: 'once', network: 'on', build: { progress: { step: 5 } } })
    expect(card(run.id)!.scriptRun!.hostsContacted!.map((x) => x.host)).toEqual(['bad.example', 'deb.debian.org'])
    expect(changedFor.filter((x) => x === 'a1').length).toBeGreaterThanOrEqual(2)
    h.finish({ generation: 3, hosts: [{ host: 'deb.debian.org', count: 4, blocked: false }] })
    const done = await svc.wait(run.id)
    expect(done).toMatchObject({ status: 'succeeded', exitCode: 0, build: { generation: 3 } })
    expect(done.build!.progress).toBeUndefined()
    expect(done.hostsContacted).toEqual([{ host: 'deb.debian.org', count: 4, blocked: false }])
    expect(readFileSync(svc.outputPath(run.id, 'stdout'), 'utf8')).toBe('Setting up jq\n')
    expect(card(run.id)!.content).toBe("Built Analyst's tools (version 3)")
    expect(svc.activeBuild('a1')).toBeNull()
    expect(svc.buildActive('a1')).toBe(false)
    expect(svc.list('a1').runs[0]).toMatchObject({ id: run.id, internet: 'once', hosts: ['deb.debian.org'], build: { generation: 3 } })
  })

  it('Stop: a running build ends stopped (build_stopped, current version kept); a 2nd Stop → 409 not_active', async () => {
    const h = held()
    const run = await svc.startToolBuild(spec({ build: h.build }))
    await until(() => h.started.yes)
    const stopped = await svc.stop(run.id)
    expect(stopped).toMatchObject({ status: 'stopped', reason: 'build_stopped', error: 'Stopped. Analyst keeps its current tools (version 2).' })
    expect(card(run.id)!.content).toBe('Tool build (stopped)')
    expect(card(run.id)!.scriptRun).toMatchObject({ status: 'stopped', reason: 'build_stopped', error: stopped.error })
    expect(await rejects(svc.stop(run.id))).toMatchObject({ statusCode: 409, reason: 'not_active' })
    expect(svc.activeBuild('a1')).toBeNull()
  })

  it('vm_install-style build waits for the bot\'s run (queued, slot), holds runs started after it; Stop while queued ends it at once', async () => {
    const r1 = await start('a1')
    await until(() => runner.pending.length === 1)
    // A user Rebuild refuses while a run is going.
    expect(await rejects(svc.startToolBuild(spec()))).toMatchObject({ statusCode: 409, reason: 'run_active' })
    const h = held()
    const b = await svc.startToolBuild(spec({ via: 'vm_install', startedBy: 'bot', argv: ['vm_install', 'jq'], waitForRuns: true, permissions: [{ type: 'internet', decision: 'always', source: 'policy' }], build: h.build }))
    expect(b).toMatchObject({ status: 'queued', queuedReason: 'slot', queuePosition: 1 })
    expect(svc.activeBuild('a1')).toMatchObject({ runId: b.id, status: 'queued', internet: 'always' })
    expect(card(b.id)!.scriptRun).toMatchObject({ status: 'queued', queuedReason: 'slot', queuePosition: 1 })
    // build_active before run_active.
    expect(await rejects(svc.startToolBuild(spec()))).toMatchObject({ statusCode: 409, reason: 'build_active', message: "Wait for the bot's tools to finish building first." })
    const r2 = await start('a1')
    expect(r2).toMatchObject({ status: 'queued', queuedReason: 'tool_build' })
    expect(card(r2.id)!.scriptRun!.afterBuild).toEqual({ runId: b.id, generation: 3 })
    const s = await svc.stop(b.id)
    expect(s).toMatchObject({ status: 'stopped', reason: 'build_stopped' })
    expect(h.started.yes).toBe(false)
    expect(svc.activeBuild('a1')).toBeNull()
    runner.pending[0]!.end()
    await svc.wait(r1.id)
    await until(() => runner.pending.length === 1 && runner.pending[0]!.req.runId === r2.id)
    runner.pending[0]!.end()
    await svc.wait(r2.id)
  })

  it('the queued build starts when the run ends; the next run waits for it and starts after', async () => {
    const r1 = await start('a1')
    await until(() => runner.pending.length === 1)
    const h = held()
    const b = await svc.startToolBuild(spec({ waitForRuns: true, build: h.build }))
    const r2 = await start('a1')
    runner.pending[0]!.end()
    await svc.wait(r1.id)
    await until(() => h.started.yes)
    expect(svc.get(b.id)).toMatchObject({ status: 'running' })
    expect(svc.get(b.id)!.queuedReason).toBeUndefined()
    expect(svc.get(r2.id)).toMatchObject({ status: 'queued', queuedReason: 'tool_build' })
    h.finish({ generation: 3 })
    await svc.wait(b.id)
    await until(() => runner.pending.length === 1 && runner.pending[0]!.req.runId === r2.id)
    runner.pending[0]!.end()
    await svc.wait(r2.id)
  })

  it('failed, proxy_unavailable and timed_out endings; 4xx prechecks leave no record', async () => {
    let r = await svc.startToolBuild(spec({ build: async () => { throw Object.assign(new Error('E: Unable to locate package nope'), { buildLog: 'E: Unable to locate package nope' }) } }))
    r = await svc.wait(r.id)
    expect(r).toMatchObject({ status: 'failed', reason: 'build_failed', error: 'The build failed, so Analyst keeps its current tools (version 2). Nothing else changed.' })
    expect(readFileSync(svc.outputPath(r.id, 'stdout'), 'utf8')).toContain('Unable to locate')
    r = await svc.startToolBuild(spec({ build: async () => { throw Object.assign(new Error('proxy down'), { statusCode: 409, reason: 'proxy_unavailable' }) } }))
    expect(await svc.wait(r.id)).toMatchObject({ status: 'failed', reason: 'proxy_unavailable', error: 'proxy down' })

    svc = make({ toolBuildTimeoutMs: 20 })
    const h = held()
    r = await svc.startToolBuild(spec({ build: h.build }))
    const t = await svc.wait(r.id)
    expect(t).toMatchObject({ status: 'timed_out', error: 'The build took longer than 20 minutes, so Analyst keeps its current tools (version 2).' })
    expect(t.reason).toBeUndefined()

    const n0 = svc.list('a1', { limit: 500 }).runs.length
    expect(await rejects(svc.startToolBuild(spec({ precheck: () => { const e = Object.assign(new Error('Set internet to Ask or Always to install packages.'), { statusCode: 409, reason: 'internet_never' }); throw e } })))).toMatchObject({ reason: 'internet_never' })
    free = 1
    expect(await rejects(svc.startToolBuild(spec()))).toMatchObject({ statusCode: 409, reason: 'low_disk' })
    expect(await rejects(svc.startToolBuild(spec({ agentId: 'nope' })))).toMatchObject({ statusCode: 404 })
    expect(svc.list('a1', { limit: 500 }).runs).toHaveLength(n0)
  })

  it('a restart fails a build left running (RESTART text, no progress) and the one left queued', async () => {
    const r1 = await start('a1')
    await until(() => runner.pending.length === 1)
    const queuedBuild = await svc.startToolBuild(spec({ waitForRuns: true, build: held().build }))
    const h = held()
    const running = await svc.startToolBuild(spec({ agentId: 'a2', conversationId: 'dm-a2', build: h.build }))
    await until(() => h.started.yes)
    h.ctl().onProgress({ step: 1, steps: 3, label: 'apt-get update' })
    await until(() => svc.get(running.id)!.build?.progress !== undefined)
    // flush the record
    await new Promise((r) => setTimeout(r, 1100))
    const old = runner
    runner = fakeRunner()
    svc = make()
    expect(await svc.recover()).toBe(3)
    expect(svc.get(running.id)).toMatchObject({ status: 'failed', error: RESTART_RUNNING_TEXT, build: { generation: 3, fromGeneration: 2 } })
    expect(svc.get(running.id)!.build!.progress).toBeUndefined()
    expect(svc.get(queuedBuild.id)).toMatchObject({ status: 'failed', error: RESTART_QUEUED_TEXT })
    expect(svc.get(queuedBuild.id)!.queuedReason).toBeUndefined()
    expect(svc.get(r1.id)!.status).toBe('failed')
    expect(svc.activeBuild('a1')).toBeNull()
    for (const p of [...old.pending]) p.end()
  })
})
