import { describe, expect, it, vi } from 'vitest'
import type { BotEnvService } from './bot-env.js'
import type { CommandRunner } from './command-runner.js'
import { createContainerRunner, GVISOR_UNAVAILABLE_REASON, LIMITS_UNENFORCED_MESSAGE, MOUNTS_UNUSABLE_MESSAGE, parseCgroupEvents, PERSONAL_QUOTA_REASON, TAIL_BYTES, type ContainerRunnerDeps } from './podman-runner.js'
import { resolveRuntime, type ResolvedRuntime, type RuntimeProbeResult } from './runtime-probe.js'
import type { RunScriptRequest } from './runner.js'
import type { StreamRunner } from './stream-runner.js'
import { defaultAgentVm } from './vm-defaults.js'
import type { Agent } from './shared/types.js'

const agent = { id: 'ag1', slug: 'analyst', name: 'Analyst', vm: { ...defaultAgentVm(), env: [{ name: 'FOO', value: 'bar' }] } } as unknown as Agent
const crun: ResolvedRuntime = { effective: 'crun', status: 'incompatible_fallback', mode: 'inherit', globalMode: 'auto', limitsEnforced: true }

interface Script {
  chunks?: { stream: 'stdout' | 'stderr'; data: string | Buffer }[]
  code?: number
  /** Never exits on its own (until kill). */
  hang?: boolean
  spawnError?: string
}
function setup(o: { scripts?: Script[]; events?: string[]; runtime?: ResolvedRuntime; engine?: ContainerRunnerDeps['engine']; deps?: Partial<ContainerRunnerDeps> } = {}) {
  const scripts = [...(o.scripts ?? [{ code: 0 }])]
  const events = [...(o.events ?? [])]
  const streamed: string[][] = []
  const commands: string[][] = []
  const stream: StreamRunner = (cmd, args, opts) => {
    streamed.push([cmd, ...args])
    const s = scripts.shift() ?? { code: 0 }
    let resolve!: (v: { code: number; spawnError?: string }) => void
    const done = new Promise<{ code: number; spawnError?: string }>((r) => (resolve = r))
    setImmediate(() => {
      for (const c of s.chunks ?? []) (c.stream === 'stdout' ? opts.onStdout : opts.onStderr)(Buffer.isBuffer(c.data) ? c.data : Buffer.from(c.data))
      if (!s.hang) setImmediate(() => resolve({ code: s.code ?? 0, ...(s.spawnError ? { spawnError: s.spawnError } : {}) }))
    })
    return { done, kill: () => resolve({ code: 137 }) }
  }
  const exec: CommandRunner = async (cmd, args) => {
    commands.push([cmd, ...args])
    return { code: 0, stdout: '', stderr: '' }
  }
  const botEnv = {
    ensure: vi.fn(async () => agent.vm),
    stop: vi.fn(async () => {}),
    exec: vi.fn(async () => ({ code: 0, stdout: events.shift() ?? '', stderr: '' })),
  } as unknown as BotEnvService & { ensure: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }
  let t = Date.parse('2026-10-27T18:00:00Z')
  const runner = createContainerRunner({
    botEnv,
    engine: o.engine ?? (async () => ({ cli: 'podman', globalArgs: ['--root', '/r'] })),
    getAgent: (id) => (id === agent.id ? agent : undefined),
    runtime: () => o.runtime ?? crun,
    stream,
    exec,
    now: () => new Date(t),
    env: {},
    sleep: async () => {},
    ...o.deps,
  })
  return { runner, streamed, commands, botEnv, advance: (ms: number) => (t += ms), now: () => t }
}
const req = (over: Partial<RunScriptRequest> = {}): RunScriptRequest => ({ agentId: 'ag1', context: { kind: 'dm' }, argv: ['python3', 'main.py'], cwd: 'workspace', timeoutSec: 60, network: 'off', ...over })
const EV = (oom: number, pids: number) => `== memory.events\nlow 0\nhigh 0\nmax 3\noom 1\noom_kill ${oom}\n== pids.events\nmax ${pids}\n`

describe('parseCgroupEvents', () => {
  it('reads oom_kill from memory.events and max from pids.events (not memory max)', () => {
    expect(parseCgroupEvents(EV(2, 5))).toEqual({ oomKill: 2, pidsMax: 5 })
    expect(parseCgroupEvents('== memory.events\n== pids.events\n')).toEqual({ oomKill: null, pidsMax: null })
  })
})

describe('createContainerRunner', () => {
  it('blocks runs when limits are not enforced (or not confirmed), unless AC_ALLOW_UNLIMITED_RUNS=1', async () => {
    const unlimited: ResolvedRuntime = { ...crun, limitsEnforced: false, limitsReason: "limits can't be enforced" }
    for (const runtime of [unlimited, { ...crun, limitsEnforced: undefined }]) {
      for (const env of [{}, { AC_ALLOW_UNLIMITED_RUNS: '0' }, { AC_ALLOW_UNLIMITED_RUNS: 'true' }]) {
        const { runner, streamed, botEnv } = setup({ runtime, deps: { env } })
        const r = await runner.run(req())
        expect(r).toMatchObject({ status: 'error', outcome: 'failed', reason: 'limits_unenforced', error: LIMITS_UNENFORCED_MESSAGE, runtime: 'crun' })
        expect(LIMITS_UNENFORCED_MESSAGE).toBe("This computer can't limit bot scripts safely, so scripts can't run here.")
        expect(streamed).toEqual([])
        expect(botEnv.ensure).not.toHaveBeenCalled()
        expect(runner.activeRuns('ag1')).toBe(0)
      }
    }
    const { runner, streamed } = setup({ runtime: unlimited, deps: { env: { AC_ALLOW_UNLIMITED_RUNS: '1' } } })
    const r = await runner.run(req())
    expect(r).toMatchObject({ outcome: 'succeeded', exitCode: 0 })
    expect(r.reason).toBeUndefined()
    expect(streamed).toHaveLength(1)
  })

  it('BE-P2-5: blocks runs when no uid mapping passed the bind_mount check, unless AC_ALLOW_UNLIMITED_RUNS=1', async () => {
    expect(MOUNTS_UNUSABLE_MESSAGE).toBe("This computer can't give bot scripts safe access to their files, so scripts can't run here.")
    for (const env of [{}, { AC_ALLOW_UNLIMITED_RUNS: '0' }, { AC_ALLOW_UNLIMITED_RUNS: 'yes' }]) {
      const seen: string[] = []
      const { runner, streamed, botEnv } = setup({ deps: { env, mountsUsable: (a) => { seen.push(a.id); return false } } })
      const r = await runner.run(req())
      expect(r).toMatchObject({ status: 'error', outcome: 'failed', reason: 'mounts_unusable', error: MOUNTS_UNUSABLE_MESSAGE, runtime: 'crun' })
      expect(seen).toEqual(['ag1'])
      expect(streamed).toEqual([])
      expect(botEnv.ensure).not.toHaveBeenCalled()
      expect(runner.activeRuns('ag1')).toBe(0)
    }
    // The same test-only override lifts it.
    const o = setup({ deps: { env: { AC_ALLOW_UNLIMITED_RUNS: '1' }, mountsUsable: () => false } })
    expect(await o.runner.run(req())).toMatchObject({ outcome: 'succeeded', exitCode: 0 })
    // Usable mounts (or no check wired) run normally.
    expect((await setup({ deps: { mountsUsable: () => true } }).runner.run(req())).outcome).toBe('succeeded')
    expect((await setup().runner.run(req())).outcome).toBe('succeeded')
    // Both blocked: limits_unenforced is reported first.
    const both = setup({ runtime: { ...crun, limitsEnforced: false }, deps: { mountsUsable: () => false } })
    expect((await both.runner.run(req())).reason).toBe('limits_unenforced')
  })

  it('BE-P2-5: the mounts override is read from process.env by default', async () => {
    const saved = process.env.AC_ALLOW_UNLIMITED_RUNS
    try {
      delete process.env.AC_ALLOW_UNLIMITED_RUNS
      expect((await setup({ deps: { env: undefined, mountsUsable: () => false } }).runner.run(req())).reason).toBe('mounts_unusable')
      process.env.AC_ALLOW_UNLIMITED_RUNS = '1'
      expect((await setup({ deps: { env: undefined, mountsUsable: () => false } }).runner.run(req())).outcome).toBe('succeeded')
    } finally {
      if (saved === undefined) delete process.env.AC_ALLOW_UNLIMITED_RUNS
      else process.env.AC_ALLOW_UNLIMITED_RUNS = saved
    }
  })

  it('the override is read from process.env by default and is off when unset', async () => {
    const saved = process.env.AC_ALLOW_UNLIMITED_RUNS
    try {
      delete process.env.AC_ALLOW_UNLIMITED_RUNS
      const unlimited: ResolvedRuntime = { ...crun, limitsEnforced: false }
      const a = setup({ runtime: unlimited, deps: { env: undefined } })
      expect((await a.runner.run(req())).reason).toBe('limits_unenforced')
      process.env.AC_ALLOW_UNLIMITED_RUNS = '1'
      const b = setup({ runtime: unlimited, deps: { env: undefined } })
      expect((await b.runner.run(req())).outcome).toBe('succeeded')
    } finally {
      if (saved === undefined) delete process.env.AC_ALLOW_UNLIMITED_RUNS
      else process.env.AC_ALLOW_UNLIMITED_RUNS = saved
    }
  })

  it('runs with exec in the started container: global args, workdir, env, AC_RUN_ID; tails and bytes', async () => {
    const s = setup({ scripts: [{ chunks: [{ stream: 'stdout', data: 'hello\n' }, { stream: 'stderr', data: 'warn\n' }], code: 0 }] })
    const chunks: string[] = []
    const r = await s.runner.run(req({ runId: 'run_1', onOutput: (w, c) => chunks.push(`${w}:${c.toString()}`) }))
    expect(r).toMatchObject({ status: 'ok', outcome: 'succeeded', exitCode: 0, stdout: 'hello\n', stderr: 'warn\n', outputBytes: 11, runtime: 'crun' })
    expect(chunks).toEqual(['stdout:hello\n', 'stderr:warn\n'])
    expect(s.botEnv.ensure).toHaveBeenCalledWith(agent, { start: true, forRun: true })
    const argv = s.streamed[0]!
    expect(argv.slice(0, 4)).toEqual(['podman', '--root', '/r', 'exec'])
    expect(argv.join(' ')).toContain('--user 1000:1000 --workdir /bot/workspace')
    expect(argv).toContain('FOO=bar')
    expect(argv).toContain('AC_RUN_ID=run_1')
    expect(argv.slice(-3)).toEqual(['ac-bot-analyst', 'python3', 'main.py'])
  })

  it('groups/<slug> cwd works; anything else is refused before the engine', async () => {
    const s = setup()
    await s.runner.run(req({ cwd: 'groups/team-a/sub' }))
    expect(s.streamed[0]!.join(' ')).toContain('--workdir /bot/groups/team-a/sub')
    for (const cwd of ['../x', '/etc', 'memory', 'workspace/../../etc', 'skills']) {
      const r = await s.runner.run(req({ cwd }))
      expect(r).toMatchObject({ status: 'error', outcome: 'failed' })
      expect(r.error).toMatch(/workspace or groups/)
    }
    expect(s.streamed).toHaveLength(1)
  })

  it('network on, required_unavailable, unknown bot and empty argv fail with plain messages and no engine call', async () => {
    const s = setup({ runtime: { effective: null, status: 'required_unavailable', reason: 'gVisor is required for Analyst but isn\'t available (x). Turn off Force on or fix gVisor.', mode: 'force_on', globalMode: 'auto' } })
    expect((await s.runner.run(req({ network: 'on' }))).error).toBe('Internet access isn\'t available yet.')
    expect((await s.runner.run(req())).error).toMatch(/^gVisor is required for Analyst/)
    expect((await s.runner.run(req({ agentId: 'nope' }))).error).toBe('Bot not found.')
    expect((await s.runner.run(req({ argv: [] }))).status).toBe('error')
    expect(s.streamed).toHaveLength(0)
  })

  it('runsc flags go before exec as global args (podman only)', async () => {
    const rt: ResolvedRuntime = { effective: 'runsc', status: 'active', mode: 'inherit', globalMode: 'auto', limitsEnforced: true, flags: ['--runtime-flag=ignore-cgroups'] }
    const s = setup({ runtime: rt })
    await s.runner.run(req())
    expect(s.streamed[0]!.slice(0, 5)).toEqual(['podman', '--root', '/r', '--runtime-flag=ignore-cgroups', 'exec'])
    const d = setup({ runtime: rt, engine: async () => ({ cli: 'docker', globalArgs: [] }) })
    await d.runner.run(req())
    expect(d.streamed[0]!.slice(0, 2)).toEqual(['docker', 'exec'])
  })

  it('engine command override (e.g. sudo -n podman) is used for exec and stop', async () => {
    const s = setup({ engine: async () => ({ cli: 'podman', command: 'sudo', globalArgs: ['-n', 'podman', '--root', '/x'] }) })
    await s.runner.run(req())
    expect(s.streamed[0]!.slice(0, 6)).toEqual(['sudo', '-n', 'podman', '--root', '/x', 'exec'])
  })

  it('non-zero exit, OOM (memory.events), process limit (pids.events) and bare 137', async () => {
    const s = setup({
      scripts: [{ code: 3 }, { code: 137 }, { code: 1 }, { code: 137 }],
      events: [EV(0, 0), EV(0, 0), EV(0, 0), EV(1, 0), EV(1, 0), EV(1, 4), EV(1, 4), EV(1, 4)],
    })
    expect(await s.runner.run(req())).toMatchObject({ status: 'error', outcome: 'failed', exitCode: 3, error: 'The script exited with code 3.' })
    expect(await s.runner.run(req())).toMatchObject({ exitCode: 137, oomKilled: true, error: 'The script ran out of memory (the 4 GB limit) and was stopped.' })
    expect(await s.runner.run(req())).toMatchObject({ exitCode: 1, pidsLimited: true, error: 'The script hit the 256-process limit (exit code 1).' })
    expect((await s.runner.run(req())).error).toMatch(/exit code 137\), most likely because it ran out of memory/)
  })

  it('process limit still saturated after the run: retries the read, then counts it as the limit and stops the container', async () => {
    const full = { code: 126, stdout: '', stderr: 'crun: fork: Resource temporarily unavailable' }
    const other = { code: 125, stdout: '', stderr: 'Error: no such container' }
    const cases: { after: { code: number; stdout: string; stderr: string }[]; limited: boolean }[] = [
      { after: [full, full, full, full], limited: true },
      { after: [full, { code: 0, stdout: EV(0, 2), stderr: '' }], limited: true },
      { after: [other, other, other, other], limited: false },
    ]
    for (const c of cases) {
      const waits: number[] = []
      const s = setup({ scripts: [{ code: 1 }], deps: { sleep: async (ms) => void waits.push(ms) } })
      const replies = [{ code: 0, stdout: EV(0, 0), stderr: '' }, ...c.after]
      ;(s.botEnv.exec as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => replies.shift() ?? other)
      const r = await s.runner.run(req())
      expect(r.pidsLimited ?? false).toBe(c.limited)
      expect(r.error).toBe(c.limited ? 'The script hit the 256-process limit (exit code 1).' : 'The script exited with code 1.')
      expect(s.botEnv.stop).toHaveBeenCalledTimes(c.limited ? 1 : 0)
      expect(waits).toEqual(c.limited ? [500, 1000, 2000].slice(0, c.after.length - 1) : [])
    }
  })

  it('timeout stops the container and reports timed_out', async () => {
    const s = setup({ scripts: [{ hang: true, chunks: [{ stream: 'stdout', data: 'tick\n' }] }] })
    const r = await s.runner.run(req({ timeoutSec: 1 }))
    expect(r).toMatchObject({ status: 'error', outcome: 'timed_out', stdout: 'tick\n', error: 'The script ran past its 1 s time limit and was stopped.' })
    expect(s.commands).toEqual([['podman', '--root', '/r', 'stop', '--time', '2', 'ac-bot-analyst']])
  })

  it('output over the cap is cut at the cap, the run stopped and marked truncated', async () => {
    const s = setup({ deps: { outputCapBytes: 1000 }, scripts: [{ hang: true, chunks: [{ stream: 'stdout', data: 'a'.repeat(600) }, { stream: 'stderr', data: 'b'.repeat(600) }, { stream: 'stdout', data: 'c'.repeat(600) }] }] })
    let seen = 0
    const r = await s.runner.run(req({ onOutput: (_w, c) => (seen += c.length) }))
    expect(r).toMatchObject({ outcome: 'failed', outputBytes: 1000, outputTruncated: true })
    expect(r.error).toMatch(/more than 0 MB|more than \d+ MB of output/)
    expect(seen).toBe(1000)
    expect(r.stdout).toBe('a'.repeat(600))
    expect(r.stderr).toBe('b'.repeat(400))
    expect(s.commands[0]).toContain('stop')
  })

  it('keeps only the last 64 KB of each stream', async () => {
    const big = Buffer.alloc(TAIL_BYTES + 5000, 'x')
    const s = setup({ scripts: [{ chunks: [{ stream: 'stdout', data: 'HEAD' }, { stream: 'stdout', data: big }, { stream: 'stdout', data: 'END' }], code: 0 }] })
    const r = await s.runner.run(req())
    expect(r.stdout.length).toBe(TAIL_BYTES)
    expect(r.stdout.endsWith('END')).toBe(true)
    expect(r.outputBytes).toBe(big.length + 7)
  })

  it('one run at a time per bot; stopRuns stops the running one and the queued ones; abort signal stops', async () => {
    const s = setup({ scripts: [{ hang: true }, { hang: true }] })
    const first = s.runner.run(req())
    const second = s.runner.run(req())
    expect(s.runner.activeRuns('ag1')).toBe(2)
    await new Promise((r) => setTimeout(r, 20))
    expect(s.streamed).toHaveLength(1)
    s.runner.stopRuns('ag1')
    expect(await first).toMatchObject({ outcome: 'stopped', error: 'The run was stopped.' })
    expect(await second).toMatchObject({ outcome: 'stopped' })
    expect(s.streamed).toHaveLength(1)
    expect(s.runner.activeRuns('ag1')).toBe(0)

    const ac = new AbortController()
    const third = s.runner.run(req({ signal: ac.signal }))
    await new Promise((r) => setTimeout(r, 20))
    ac.abort()
    expect(await third).toMatchObject({ outcome: 'stopped' })
  })

  it('a VM that fails to start fails the run with the reason', async () => {
    const s = setup()
    s.botEnv.ensure.mockRejectedValueOnce(new Error('The bot image isn\'t built yet.'))
    expect((await s.runner.run(req())).error).toBe('The bot\'s VM couldn\'t start: The bot image isn\'t built yet.')
  })

  it('idle: stopped after 10 min without runs; idleStopAt shown; not while running', async () => {
    const s = setup()
    expect(s.runner.idleStopAt('ag1')).toBeUndefined()
    await s.runner.run(req())
    expect(s.runner.idleStopAt('ag1')).toBe(new Date(s.now() + 10 * 60 * 1000).toISOString())
    s.advance(9 * 60 * 1000)
    await s.runner.idleSweep()
    expect(s.botEnv.stop).not.toHaveBeenCalled()
    s.advance(60 * 1000)
    await s.runner.idleSweep()
    expect(s.botEnv.stop).toHaveBeenCalledTimes(1)
    expect(s.runner.idleStopAt('ag1')).toBeUndefined()
    const stopTimer = s.runner.startIdleTimer()
    stopTimer()
  })

  it('available() follows the engine; spawn errors are reported', async () => {
    expect(await setup({ engine: async () => null }).runner.available()).toBe(false)
    expect((await setup({ engine: async () => null }).runner.run(req())).error).toMatch(/Podman isn't installed/)
    const s = setup({ scripts: [{ code: 127, spawnError: 'podman: not found' }] })
    expect(await s.runner.available()).toBe(true)
    expect((await s.runner.run(req())).error).toBe('Couldn\'t run the engine: podman: not found')
  })
})

describe('BE-P2-7: force_on never falls back to crun', () => {
  // The standard runtime is fine here (limits enforced, mounts usable), so a quiet fallback would run.
  const stdOk: NonNullable<RuntimeProbeResult['standard']> = {
    runtime: 'crun', version: 'crun 1.21', limitsEnforced: true, limitsAccepted: true, uidMapping: 'keep-id',
    checks: [{ id: 'start', status: 'pass' }, { id: 'bind_mount', status: 'pass' }, { id: 'cgroup_limits', status: 'pass' }],
  }
  const base: RuntimeProbeResult = {
    runsc: { installed: true, version: '0.0~20240729.0' }, compatible: false, uidMapping: 'keep-id', snapshotDriver: null,
    checkedAt: '2026-10-28T15:00:00.000Z', versions: { engine: '5.4.2', runsc: '0.0~20240729.0', image: 'abc' }, standard: stdOk, runscFlags: [],
    checks: [{ id: 'start', status: 'pass' }, { id: 'bind_mount', status: 'pass' }, { id: 'cgroup_limits', status: 'fail', message: "limits can't be enforced (x)" }],
  }
  const cases: [string, RuntimeProbeResult | null, string][] = [
    ['the probe failed', base, "gVisor is required for Analyst but isn't available (limits can't be enforced). Turn off Force on or fix gVisor."],
    ['runsc is missing', { ...base, runsc: { installed: false }, checks: null }, "gVisor is required for Analyst but isn't available (it isn't installed). Turn off Force on or fix gVisor."],
    ['there is no probe result yet', null, "gVisor is required for Analyst but isn't available (the runtime check hasn't run yet). Turn off Force on or fix gVisor."],
  ]
  for (const [what, probe, message] of cases) {
    for (const [globalMode, botMode] of [['auto', 'force_on'], ['force_on', 'inherit']] as const) {
      it(`${what} (global ${globalMode}, bot ${botMode}): the run fails with gvisor_unavailable and nothing reaches the engine, even with the override`, async () => {
        const rt = resolveRuntime(globalMode, botMode, probe, 'Analyst')
        expect(rt).toMatchObject({ effective: null, status: 'required_unavailable', reason: message })
        for (const env of [{}, { AC_ALLOW_UNLIMITED_RUNS: '1' }]) {
          const s = setup({ runtime: rt, deps: { env, mountsUsable: () => true } })
          const r = await s.runner.run(req())
          expect(r).toEqual(expect.objectContaining({ status: 'error', outcome: 'failed', reason: GVISOR_UNAVAILABLE_REASON, error: message, runtime: null }))
          expect(s.botEnv.ensure).not.toHaveBeenCalled()
          expect(s.streamed).toEqual([])
          expect(s.commands).toEqual([])
        }
      })
    }
    it(`${what}: auto (inherit) falls back to crun instead`, () => {
      const rt = resolveRuntime('auto', 'inherit', probe, 'Analyst')
      if (probe) expect(rt).toMatchObject({ effective: 'crun', limitsEnforced: true })
      else expect(rt).toMatchObject({ effective: null, status: 'not_installed' })
      expect(rt.status).not.toBe('required_unavailable')
    })
  }

  it('a run queued behind a running one re-resolves the runtime at its turn', async () => {
    let rt: ResolvedRuntime = crun
    const s = setup({ scripts: [{ hang: true }, { code: 0 }], deps: { runtime: () => rt } })
    const ac = new AbortController()
    const first = s.runner.run(req({ signal: ac.signal }))
    const second = s.runner.run(req())
    await vi.waitFor(() => expect(s.streamed).toHaveLength(1))
    // Force on is set (no probe result yet) while the first run is running and the second waits.
    rt = resolveRuntime('auto', 'force_on', null, 'Analyst')
    ac.abort()
    expect((await first).outcome).toBe('stopped')
    expect(await second).toMatchObject({ outcome: 'failed', reason: GVISOR_UNAVAILABLE_REASON, runtime: null })
    expect(s.botEnv.ensure).toHaveBeenCalledTimes(1)
    expect(s.streamed).toHaveLength(1)
  })
})

describe('BE-P2-9: undo snapshots around runs', () => {
  const fakeSnaps = (o: { driver?: 'overlay' | 'copy' | null; beginFails?: boolean; finishFails?: boolean } = {}) => {
    const order: string[] = []
    const svc = {
      driver: () => (o.driver === undefined ? 'overlay' : o.driver),
      needsStop: () => o.driver === undefined || o.driver === 'overlay',
      begin: vi.fn(async (_a: Agent, runId: string) => {
        order.push(`begin ${runId}`)
        if (o.beginFails) throw new Error('disk full')
        return { runId } as never
      }),
      finish: vi.fn(async (h: { runId: string }) => {
        order.push(`finish ${h.runId}`)
        if (o.finishFails) throw new Error('EIO')
        return { snapshot: { id: h.runId, driver: o.driver ?? 'overlay', retainedBytes: 12 }, filesChanged: [{ path: 'workspace/a.txt', change: 'modified' as const, root: 'agent' as const }], meta: {} as never }
      }),
    }
    return { svc: svc as unknown as NonNullable<ContainerRunnerDeps['snapshots']>, order, raw: svc }
  }

  it('overlay: stop, begin, run, stop, finish; the result carries the snapshot and filesChanged', async () => {
    const s = fakeSnaps()
    const { runner, botEnv, streamed } = setup({ deps: { snapshots: s.svc } })
    const order = s.order
    botEnv.stop.mockImplementation(async () => void order.push('stop'))
    botEnv.ensure.mockImplementation(async () => (order.push('ensure'), agent.vm))
    const r = await runner.run(req({ runId: 'run-42' }))
    expect(r).toMatchObject({ status: 'ok', snapshot: { id: 'run-42', driver: 'overlay', retainedBytes: 12 }, filesChanged: [{ path: 'workspace/a.txt', change: 'modified' }] })
    expect(order).toEqual(['stop', 'begin run-42', 'ensure', 'stop', 'finish run-42'])
    expect(streamed).toHaveLength(1)
  })

  it('timed out, failed and stopped runs are all finished (committed and undoable)', async () => {
    for (const script of [{ hang: true }, { code: 3 }]) {
      const s = fakeSnaps()
      const { runner } = setup({ scripts: [script], deps: { snapshots: s.svc } })
      const r = await runner.run(req({ timeoutSec: 1 }))
      expect(r.status).toBe('error')
      expect(s.raw.finish).toHaveBeenCalledTimes(1)
      expect(r.snapshot?.retainedBytes).toBe(12)
    }
    const s = fakeSnaps()
    const { runner } = setup({ scripts: [{ hang: true }], deps: { snapshots: s.svc } })
    const p = runner.run(req({ timeoutSec: 600 }))
    await new Promise((r) => setTimeout(r, 20))
    await runner.stopRuns('ag1')
    const r = await p
    expect(r.status).toBe('error')
    expect(s.raw.finish).toHaveBeenCalledTimes(1)
    expect(r.filesChanged).toHaveLength(1)
  })

  it('a snapshot that can\'t be taken refuses the run (snapshot_failed), nothing started', async () => {
    const s = fakeSnaps({ beginFails: true })
    const { runner, streamed } = setup({ deps: { snapshots: s.svc } })
    const r = await runner.run(req())
    expect(r).toMatchObject({ status: 'error', reason: 'snapshot_failed', snapshot: null })
    expect(r.error).toContain('disk full')
    expect(streamed).toEqual([])
    expect(s.raw.finish).not.toHaveBeenCalled()
  })

  it('finish failing: the run result stands, snapshot null and no files listed (left pending for the next run)', async () => {
    const s = fakeSnaps({ finishFails: true })
    const { runner } = setup({ deps: { snapshots: s.svc } })
    const r = await runner.run(req())
    expect(r).toMatchObject({ status: 'ok', snapshot: null, filesChanged: [] })
  })

  it('copy driver: no container stops; no driver: snapshot null, nothing called; a bad run id gets a fresh one', async () => {
    const c = fakeSnaps({ driver: 'copy' })
    const a = setup({ deps: { snapshots: c.svc } })
    await a.runner.run(req({ runId: '../x' }))
    expect(a.botEnv.stop).not.toHaveBeenCalled()
    expect(c.order[0]).toMatch(/^begin [A-Za-z0-9][A-Za-z0-9_-]+$/)
    expect(c.order[0]).not.toContain('..')
    const n = fakeSnaps({ driver: null })
    const b = setup({ deps: { snapshots: n.svc } })
    const r = await b.runner.run(req())
    expect(r.snapshot).toBeNull()
    expect(n.raw.begin).not.toHaveBeenCalled()
  })
})

describe('BE-P2-10: personal limit and snapshot eviction', () => {
  const MSG = 'Analyst\'s files and tools use 10.2 of 10 GB. Free space in Files or remove tools in Settings › VM.'
  const snaps = () => ({
    driver: () => 'copy',
    needsStop: () => false,
    begin: vi.fn(async (_a: Agent, runId: string) => ({ runId }) as never),
    finish: vi.fn(async (h: { runId: string }) => ({ snapshot: { id: h.runId, driver: 'copy' as const, retainedBytes: 5 }, filesChanged: [], meta: {} as never })),
  }) as unknown as NonNullable<ContainerRunnerDeps['snapshots']>

  it('over the personal limit: blocked with personal_quota and the exact message, nothing started', async () => {
    const s = snaps()
    const { runner, streamed, botEnv } = setup({ deps: { personal: async () => ({ blocked: MSG }), snapshots: s } })
    const r = await runner.run(req())
    expect(r).toMatchObject({ status: 'error', reason: PERSONAL_QUOTA_REASON, error: MSG })
    expect(PERSONAL_QUOTA_REASON).toBe('personal_quota')
    expect(streamed).toEqual([])
    expect(botEnv.ensure).not.toHaveBeenCalled()
    expect((s as unknown as { begin: ReturnType<typeof vi.fn> }).begin).not.toHaveBeenCalled()
  })

  it('under the limit, or the measurement failing: the run goes ahead', async () => {
    for (const personal of [async () => ({ blocked: null }), async () => { throw new Error('du failed') }]) {
      const logs: string[] = []
      const { runner, streamed } = setup({ deps: { personal, log: (m) => void logs.push(m) } })
      expect((await runner.run(req())).status).toBe('ok')
      expect(streamed).toHaveLength(1)
    }
  })

  it('the limits block is checked before the personal limit', async () => {
    const personal = vi.fn(async () => ({ blocked: MSG }))
    const { runner } = setup({ runtime: { ...crun, limitsEnforced: false }, deps: { personal } })
    const r = await runner.run(req())
    expect(r.reason).toBe('limits_unenforced')
    expect(personal).not.toHaveBeenCalled()
  })

  it('after the snapshot: eviction runs and the run\'s undo state comes back', async () => {
    const afterSnapshot = vi.fn(() => ({ state: 'unavailable' as const, reason: 'too_large' as const, changedBytes: 5 * 1024 ** 3, at: 'x' }))
    const { runner } = setup({ deps: { snapshots: snaps(), afterSnapshot } })
    const r = await runner.run(req({ runId: 'run-7' }))
    expect(afterSnapshot).toHaveBeenCalledWith('analyst', 'run-7')
    expect(r.undo).toMatchObject({ state: 'unavailable', reason: 'too_large' })
    expect(r.snapshot?.id).toBe('run-7')
  })

  it('eviction throwing doesn\'t fail the run; no snapshot: no eviction, no undo', async () => {
    const boom = vi.fn(() => { throw new Error('EIO') })
    const a = setup({ deps: { snapshots: snaps(), afterSnapshot: boom, log: () => {} } })
    const r = await a.runner.run(req())
    expect(r.status).toBe('ok')
    expect(r.undo).toBeUndefined()
    const none = vi.fn(() => null)
    const b = setup({ deps: { afterSnapshot: none } })
    const r2 = await b.runner.run(req())
    expect(none).not.toHaveBeenCalled()
    expect(r2.undo).toBeUndefined()
  })
})
