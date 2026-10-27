/**
 * BE-P2-8 @vm: the runtime/limits probe and the container runner against a real engine.
 * Opt-in: AC_VM_TESTS=1. Needs localhost/agentcontrol/botvm:<BOTVM_VERSION> in that engine's store.
 *
 * Engine selection (so the limit tests can run where limits ARE enforced, e.g. rootful):
 *   AC_VM_ENGINE   program + prefix args, default "podman" (e.g. "sudo -n podman")
 *   PODMAN_ARGS    global args, e.g. "--root /x/root --runroot /x/runroot"
 *   AC_VM_GVISOR   global gVisor mode for the run tests: auto (default) | force_on | force_off
 *   AC_VM_RUNSC=0  don't probe runsc at all
 *
 * The limit tests (memory.max/pids.max, OOM at 5 GB, fork bomb) skip with the probe's reason when
 * the runtime in use can't enforce limits (rootless crun/runsc on cgroupfs). Everything runs with
 * --network none; everything created is removed at the end.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execCommandRunner } from './command-runner.js'
import { createBotEnvService, type BotEnvService, type EngineRef } from './bot-env.js'
import { createContainerRunner, OUTPUT_CAP_BYTES, type ContainerRunner } from './podman-runner.js'
import { createRuntimeProbe, LIMITS_NOT_ENFORCED, PROBE_LABEL, resolveRuntime, type ResolvedRuntime, type RuntimeProbeResult } from './runtime-probe.js'
import type { RunScriptRequest } from './runner.js'
import { defaultAgentVm } from './vm-defaults.js'
import { VM_LIMITS, type Agent, type GlobalRuntimeMode } from './shared/types.js'
import { sharedImageRef } from './vm-images.js'

const SLUG = 'be8vmtest'
const enginePrefix = (process.env.AC_VM_ENGINE ?? 'podman').split(/\s+/).filter(Boolean)
const podmanArgs = (process.env.PODMAN_ARGS ?? '').split(/\s+/).filter(Boolean)
const command = enginePrefix[0] ?? 'podman'
const cli: 'podman' | 'docker' = enginePrefix[enginePrefix.length - 1] === 'docker' ? 'docker' : 'podman'
const ENGINE: EngineRef = {
  cli,
  ...(command !== cli ? { command } : {}),
  globalArgs: [...enginePrefix.slice(1), ...podmanArgs],
}
const globalMode = (process.env.AC_VM_GVISOR ?? 'auto') as GlobalRuntimeMode

const pm = (...args: string[]): string | null => {
  try {
    return execFileSync(command, [...ENGINE.globalArgs, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 }).trim()
  } catch {
    return null
  }
}
const engineReady = process.env.AC_VM_TESTS === '1' && pm('image', 'inspect', '--format', '{{.Id}}', sharedImageRef('botvm')) !== null

function cleanup(): void {
  pm('rm', '--force', `ac-bot-${SLUG}`)
  pm('volume', 'rm', '--force', `ac-tools-${SLUG}`, `ac-opt-${SLUG}`)
  for (const id of (pm('ps', '-a', '--filter', `label=${PROBE_LABEL}=1`, '--format', '{{.ID}}') ?? '').split('\n').filter(Boolean)) pm('rm', '--force', id)
  for (const ref of (pm('image', 'ls', '--format', '{{.Repository}}:{{.Tag}}', '--filter', `reference=localhost/ac-bot-${SLUG}`) ?? '').split('\n').filter(Boolean)) pm('rmi', ref)
}

describe.skipIf(!engineReady)('@vm runtime probe + container runner', () => {
  let dir = ''
  let probe: RuntimeProbeResult
  let rt: ResolvedRuntime
  let botEnv: BotEnvService
  let runner: ContainerRunner
  const agent = { id: 'ag_be8vm', slug: SLUG, name: 'BE8 VM test', internetPolicy: 'ask', vm: { ...defaultAgentVm(), env: [{ name: 'BE8', value: 'yes' }] } } as unknown as Agent
  const run = (argv: string[], over: Partial<RunScriptRequest> = {}) =>
    runner.run({ agentId: agent.id, context: { kind: 'dm' }, argv, cwd: 'workspace', timeoutSec: 120, network: 'off', ...over })
  const py = (code: string, over: Partial<RunScriptRequest> = {}) => run(['python3', '-c', code], over)
  const limitsSkip = (skip: (note?: string) => void) => {
    if (!rt.limitsEnforced) skip(`${rt.effective ?? 'runtime'}: ${rt.limitsReason ?? LIMITS_NOT_ENFORCED}`)
  }

  beforeAll(async () => {
    cleanup()
    dir = mkdtempSync(join(tmpdir(), 'ac-be8-vm-'))
    for (const sub of ['workspace', 'shared', 'memory']) mkdirSync(join(dir, sub))
    writeFileSync(join(dir, 'shared', 'input.txt'), 'read me\n')
    writeFileSync(join(dir, 'memory', 'BOT.md'), '# secret profile\n')
    for (const p of [dir, join(dir, 'workspace'), join(dir, 'shared')]) chmodSync(p, 0o777)
    chmodSync(join(dir, 'shared', 'input.txt'), 0o644)

    const p = createRuntimeProbe({ exec: execCommandRunner, engine: async () => ENGINE, tryRunsc: process.env.AC_VM_RUNSC !== '0' })
    probe = await p.refresh()
    rt = resolveRuntime(globalMode, 'inherit', probe, agent.name)
    console.log(`[be8 probe] ${JSON.stringify({ standard: probe.standard, runsc: probe.runsc, runscFlags: probe.runscFlags, compatible: probe.compatible, checks: probe.checks, versions: probe.versions })}`)
    console.log(`[be8 resolved] ${JSON.stringify(rt)}`)

    botEnv = createBotEnvService({
      exec: execCommandRunner,
      engine: async () => ENGINE,
      mounts: () => [
        { source: join(dir, 'workspace'), target: '/bot/workspace', readonly: false },
        { source: join(dir, 'shared'), target: '/bot/shared', readonly: true },
      ],
      saveVm: () => true,
      runtime: () => (rt.effective === 'runsc' ? 'runsc' : null),
      runtimeFlags: () => (rt.effective === 'runsc' ? (rt.flags ?? []) : []),
      enforceLimits: () => probe.standard?.limitsAccepted ?? true,
      activeRuns: (id) => runner.activeRuns(id),
    })
    runner = createContainerRunner({ botEnv, engine: async () => ENGINE, getAgent: () => agent, runtime: () => rt, idleStopMs: 1 })
  }, 240_000)
  afterAll(() => {
    cleanup()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }, 120_000)

  it('probe: standard runtime starts offline as uid 1000; the limits verdict and runsc result are consistent', () => {
    expect(probe.standard?.checks.find((c) => c.id === 'start')?.status).toBe('pass')
    expect(probe.standard?.checks.find((c) => c.id === 'network')?.status).toBe('pass')
    expect(probe.standard?.checks.find((c) => c.id === 'exec')?.status).toBe('pass')
    const lim = probe.standard!.checks.find((c) => c.id === 'cgroup_limits')!
    expect(lim.status).toBe(probe.standard!.limitsEnforced ? 'pass' : 'fail')
    if (!probe.standard!.limitsEnforced) expect(lim.message!.startsWith(LIMITS_NOT_ENFORCED)).toBe(true)
    if (probe.runsc.installed) {
      expect(probe.checks).not.toBeNull()
      // gVisor that only starts with ignore-cgroups can never be compatible.
      if (probe.runscFlags.includes('--runtime-flag=ignore-cgroups')) expect(probe.compatible).toBe(false)
      if (!probe.compatible) expect(rt.effective === 'runsc').toBe(false)
    }
    expect(JSON.stringify(probe)).not.toContain('network=host')
    expect(pm('ps', '-a', '--filter', `label=${PROBE_LABEL}=1`, '--format', '{{.ID}}')).toBe('')
  })

  it('exit codes, stdout/stderr, env, uid 1000, no network', async () => {
    const okRun = await run(['sh', '-c', 'echo "$BE8 $(id -u)"; echo oops >&2; cat /proc/net/dev | tail -n +3 | cut -d: -f1 | tr -d " "'], { runId: 'run_be8' })
    expect(okRun).toMatchObject({ status: 'ok', outcome: 'succeeded', exitCode: 0, stderr: 'oops\n', runtime: rt.effective })
    expect(okRun.stdout.split('\n').filter(Boolean)).toEqual(['yes 1000', 'lo'])
    expect(await run(['sh', '-c', 'exit 3'])).toMatchObject({ status: 'error', outcome: 'failed', exitCode: 3, error: 'The script exited with code 3.' })
    const raised = await py('raise SystemExit("boom")')
    expect(raised).toMatchObject({ exitCode: 1 })
    expect(raised.stderr).toContain('boom')
    expect((await run(['printenv', 'AC_RUN_ID'], { runId: 'run_xyz' })).stdout.trim()).toBe('run_xyz')
  }, 180_000)

  it('timeout stops the run (and the container); the next run starts it again', async () => {
    const t0 = Date.now()
    const r = await run(['sleep', '60'], { timeoutSec: 2 })
    expect(r).toMatchObject({ outcome: 'timed_out', error: 'The script ran past its 2 s time limit and was stopped.' })
    expect(Date.now() - t0).toBeLessThan(30_000)
    expect((await run(['true'])).outcome).toBe('succeeded')
  }, 120_000)

  it('stopRuns stops a running script', async () => {
    const p = run(['sleep', '60'])
    await new Promise((r) => setTimeout(r, 1500))
    runner.stopRuns(agent.id)
    expect(await p).toMatchObject({ outcome: 'stopped' })
  }, 120_000)

  it('300 MB of output is cut at 200 MB and the run stopped', async () => {
    let seen = 0
    const r = await py('import sys\nb = b"x" * 1048576\nfor _ in range(300): sys.stdout.buffer.write(b)', { onOutput: (_s, c) => (seen += c.length) })
    expect(r).toMatchObject({ outcome: 'failed', outputTruncated: true, outputBytes: OUTPUT_CAP_BYTES })
    expect(seen).toBe(OUTPUT_CAP_BYTES)
    expect(r.stdout.length).toBe(64 * 1024)
    expect(r.error).toMatch(/more than 200 MB of output/)
  }, 180_000)

  it('read-only mounts and root fs give EROFS; workspace writes reach the host', async () => {
    const shared = await run(['sh', '-c', 'cat /bot/shared/input.txt; echo x > /bot/shared/new.txt'])
    expect(shared.stdout).toBe('read me\n')
    expect(shared.exitCode).not.toBe(0)
    expect(shared.stderr).toMatch(/Read-only file system/)
    const usr = await py('open("/usr/be8", "w")')
    expect(usr.stderr).toMatch(/Read-only file system/)
    expect(existsSync(join(dir, 'shared', 'new.txt'))).toBe(false)
    expect((await run(['sh', '-c', 'echo hi > /bot/workspace/out.txt'])).outcome).toBe('succeeded')
    expect(readFileSync(join(dir, 'workspace', 'out.txt'), 'utf8')).toBe('hi\n')
  }, 120_000)

  it('/bot has no memory and no BOT.md anywhere', async () => {
    const r = await run(['sh', '-c', 'ls -A /bot; test -e /bot/memory && echo HAS_MEMORY; find / -xdev -name BOT.md 2>/dev/null; true'])
    const lines = r.stdout.split('\n').filter(Boolean)
    // groups/ and skills/ are empty mount points baked into the image.
    for (const l of lines) expect(['groups', 'shared', 'skills', 'workspace']).toContain(l)
    expect(lines).toContain('workspace')
    expect(r.stdout).not.toMatch(/memory|HAS_MEMORY|BOT\.md/)
  }, 60_000)

  it('limits: memory.max is 4 GB and pids.max 256 inside the container', async (ctx) => {
    limitsSkip(ctx.skip)
    const r = await run(['sh', '-c', 'cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/pids.max'])
    expect(r.stdout.split('\n').filter(Boolean)).toEqual([String(VM_LIMITS.memoryMb * 1024 * 1024), String(VM_LIMITS.pids)])
  }, 60_000)

  it('limits: a 5 GB allocation is OOM-killed with a clear status', async (ctx) => {
    limitsSkip(ctx.skip)
    const r = await py('b = bytearray(5 * 1024 ** 3)\nfor i in range(0, len(b), 4096): b[i] = 1\nprint("survived")')
    expect(r.stdout).not.toContain('survived')
    expect(r.outcome).toBe('failed')
    expect(r.oomKilled === true || r.exitCode === 137).toBe(true)
    expect(r.error).toMatch(/memory/)
  }, 180_000)

  it('limits: a fork bomb stops at the 256-process limit with a clear status', async (ctx) => {
    limitsSkip(ctx.skip)
    const r = await py([
      'import os, sys, time',
      'n = 0',
      'try:',
      '    for i in range(2000):',
      '        if os.fork() == 0:',
      '            time.sleep(5)',
      '            os._exit(0)',
      '        n += 1',
      'except OSError:',
      '    print(n)',
      '    sys.exit(1)',
      'print(n)',
    ].join('\n'))
    expect(Number(r.stdout.trim())).toBeLessThan(VM_LIMITS.pids)
    expect(r).toMatchObject({ outcome: 'failed', pidsLimited: true })
    expect(r.error).toMatch(/256-process limit/)
  }, 180_000)

  it('idle sweep stops the container (not removes it)', async () => {
    expect((await run(['true'])).outcome).toBe('succeeded')
    await new Promise((r) => setTimeout(r, 20))
    await runner.idleSweep()
    expect(pm('container', 'inspect', '--format', '{{.State.Status}}', `ac-bot-${SLUG}`)).toMatch(/exited|stopped/)
  }, 120_000)
})
