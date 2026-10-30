import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NETWORK_UNAVAILABLE } from './podman-runner.js'
import {
  createRunService, LOW_DISK_TEXT, MODEL_TAIL_BYTES, RESTART_QUEUED_TEXT, RESTART_RUNNING_TEXT, RUN_FREE_FLOOR_BYTES,
  STOPPED_QUEUED_TEXT, tailUtf8, type RunService, type RunServiceDeps,
} from './run-service.js'
import { fakeRunner, until, type FakeRunner } from './run-service.fake.js'
import type { Agent, ChatMessage, Conversation, LiveEvent, ScriptRunUndo } from './shared/types.js'

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
