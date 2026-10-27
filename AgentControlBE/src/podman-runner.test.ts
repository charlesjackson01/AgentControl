import { describe, expect, it, vi } from 'vitest'
import type { BotEnvService } from './bot-env.js'
import type { CommandRunner } from './command-runner.js'
import { createContainerRunner, LIMITS_UNENFORCED_MESSAGE, parseCgroupEvents, TAIL_BYTES, type ContainerRunnerDeps } from './podman-runner.js'
import type { ResolvedRuntime } from './runtime-probe.js'
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
    expect(s.botEnv.ensure).toHaveBeenCalledWith(agent, { start: true })
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
