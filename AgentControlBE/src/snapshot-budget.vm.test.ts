/**
 * BE-P2-10 @vm: budgets and eviction around real container runs, the personal-limit block, and
 * BotEnvService.measure (du of the tools volumes in a running container, image layer size).
 * Opt-in: AC_VM_TESTS=1, same engine variables as podman-runner.vm.test.ts (AC_VM_ENGINE,
 * PODMAN_ARGS). Needs localhost/agentcontrol/botvm:<BOTVM_VERSION> in that engine's store.
 * Budgets are scaled down (KB instead of GB) so the runs stay small. Everything runs with
 * --network none; everything created is removed.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execCommandRunner } from './command-runner.js'
import { createBotEnvService, type BotEnvService, type EngineRef } from './bot-env.js'
import { createPersonalUsage, PERSONAL_QUOTA_REASON } from './personal-usage.js'
import { ALLOW_UNLIMITED_RUNS_ENV, createContainerRunner, type ContainerRunner } from './podman-runner.js'
import { createRuntimeProbe, PROBE_LABEL, resolveRuntime, type ResolvedRuntime, type RuntimeProbeResult } from './runtime-probe.js'
import type { RunScriptRequest } from './runner.js'
import { createSnapshotService, type SnapshotService, type SnapshotZone } from './snapshot.js'
import { createSnapshotBudget, type BudgetLimits, type SnapshotBudget } from './snapshot-budget.js'
import { defaultAgentVm } from './vm-defaults.js'
import type { Agent } from './shared/types.js'
import { sharedImageRef } from './vm-images.js'

const SLUG = 'be10vmtest'
const KB = 1024
const enginePrefix = (process.env.AC_VM_ENGINE ?? 'podman').split(/\s+/).filter(Boolean)
const podmanArgs = (process.env.PODMAN_ARGS ?? '').split(/\s+/).filter(Boolean)
const command = enginePrefix[0] ?? 'podman'
const cli: 'podman' | 'docker' = enginePrefix[enginePrefix.length - 1] === 'docker' ? 'docker' : 'podman'
const ENGINE: EngineRef = { cli, ...(command !== cli ? { command } : {}), globalArgs: [...enginePrefix.slice(1), ...podmanArgs] }

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
}

describe.skipIf(!engineReady)('@vm BE-P2-10 budgets and eviction', () => {
  let dir = ''
  let probe: RuntimeProbeResult
  let rt: ResolvedRuntime
  let botEnv: BotEnvService
  let runner: ContainerRunner
  let snaps: SnapshotService
  let budget: SnapshotBudget
  let limits: BudgetLimits = { perBotBytes: 100 * KB, globalBytes: 1024 * KB, freeFloorBytes: 0 }
  let quota = 10 * 1024 ** 3
  const savedOverride = process.env[ALLOW_UNLIMITED_RUNS_ENV]
  const agent = { id: 'ag_be10vm', slug: SLUG, name: 'Analyst', internetPolicy: 'ask', vm: defaultAgentVm() } as unknown as Agent
  const ws = () => join(dir, 'workspace')
  const py = (code: string, over: Partial<RunScriptRequest> = {}) =>
    runner.run({ agentId: agent.id, context: { kind: 'dm' }, argv: ['python3', '-c', code], cwd: 'workspace', timeoutSec: 120, network: 'off', ...over })

  beforeAll(async () => {
    cleanup()
    dir = mkdtempSync(join(tmpdir(), 'ac-be10-vm-'))
    for (const sub of ['workspace', 'shared']) mkdirSync(join(dir, sub))
    const p = createRuntimeProbe({ exec: execCommandRunner, engine: async () => ENGINE, bindDir: () => dir, tryRunsc: process.env.AC_VM_RUNSC !== '0' })
    probe = await p.refresh()
    rt = resolveRuntime('auto', 'inherit', probe, agent.name)
    if (!rt.limitsEnforced) process.env[ALLOW_UNLIMITED_RUNS_ENV] = '1'
    const zones: SnapshotZone[] = [{ key: 'workspace', dir: ws(), target: '/bot/workspace', root: 'agent', prefix: 'workspace' }]
    snaps = createSnapshotService({ root: () => join(dir, 'snapshots'), driver: () => probe.snapshotDriver, zones: () => zones, log: (m) => console.log(`[be10 snaps] ${m}`) })
    botEnv = createBotEnvService({
      exec: execCommandRunner,
      engine: async () => ENGINE,
      mounts: (a) => snaps.mountsFor(a, [
        { source: ws(), target: '/bot/workspace', readonly: false },
        { source: join(dir, 'shared'), target: '/bot/shared', readonly: true },
      ]),
      uidMapping: () => (cli === 'docker' ? null : ((rt.effective === 'runsc' ? probe.uidMapping : probe.standard?.uidMapping) ?? 'keep-id')),
      allowedMounts: () => ({ slug: SLUG, workspace: ws(), inputs: join(dir, 'shared'), groups: {}, botRoot: dir, overlayRoot: join(dir, 'snapshots', SLUG, '.overlay') }),
      saveVm: () => true,
      runtime: () => (rt.effective === 'runsc' ? 'runsc' : null),
      runtimeFlags: () => (rt.effective === 'runsc' ? (rt.flags ?? []) : []),
      enforceLimits: () => probe.standard?.limitsAccepted ?? true,
      activeRuns: (id) => runner.activeRuns(id),
    })
    budget = createSnapshotBudget({ snapshots: snaps, limits: () => limits, freeBytes: () => null, busy: () => runner.activeRuns(agent.id) > 0, log: (m) => console.log(`[be10 budget] ${m}`) })
    const personal = createPersonalUsage({
      folder: () => ({ workspace: 0, inputs: 0, memory: 0 }),
      engine: (a) => botEnv.measure!(a),
      quotaBytes: () => quota,
      ttlMs: 0,
    })
    runner = createContainerRunner({
      botEnv, engine: async () => ENGINE, getAgent: () => agent, runtime: () => rt, snapshots: snaps,
      personal: (a) => personal.check(a),
      afterSnapshot: (slug, runId) => budget.afterRun(slug, runId),
      log: (m) => console.log(`[be10 runner] ${m}`),
    })
  }, 240_000)
  afterAll(() => {
    if (savedOverride === undefined) delete process.env[ALLOW_UNLIMITED_RUNS_ENV]
    else process.env[ALLOW_UNLIMITED_RUNS_ENV] = savedOverride
    cleanup()
    if (dir) pm('unshare', 'rm', '-rf', dir)
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  }, 120_000)

  it('measure: du of /home/bot and /opt/bot in the running container; layer 0 on the shared base', async () => {
    await botEnv.start(agent)
    const e = await botEnv.exec(agent, ['sh', '-c', 'head -c 2097152 /dev/zero > /home/bot/two-mb.bin'])
    expect(e.code).toBe(0)
    const m = await botEnv.measure!(agent)
    expect(m.tools).toBeGreaterThanOrEqual(2 * 1024 * 1024)
    expect(typeof m.opt).toBe('number')
    expect(m.imageLayer).toBe(0)
    await botEnv.exec(agent, ['rm', '-f', '/home/bot/two-mb.bin'])
  }, 240_000)

  it('over the personal limit, the run is blocked with personal_quota and the exact message; nothing runs', async () => {
    quota = 1024 * 1024 // 1 MB: the tools volume alone is over it after this write
    await botEnv.exec(agent, ['sh', '-c', 'head -c 2097152 /dev/zero > /home/bot/two-mb.bin'])
    const r = await py("open('blocked.txt','w').write('x')", { runId: 'be10-blocked' })
    expect(r.reason).toBe(PERSONAL_QUOTA_REASON)
    expect(r.error).toMatch(/^Analyst's files and tools use \d+(\.\d)? of 0\.1 GB\. Free space in Files or remove tools in Settings › VM\.$/)
    expect(existsSync(join(ws(), 'blocked.txt'))).toBe(false)
    await botEnv.exec(agent, ['rm', '-f', '/home/bot/two-mb.bin'])
    quota = 10 * 1024 ** 3
  }, 240_000)

  it('a run retaining more than 2× the per-bot budget is dropped at once (too_large)', async () => {
    writeFileSync(join(ws(), 'big.bin'), Buffer.alloc(300 * KB, 1))
    const r = await py("open('big.bin','wb').write(b'small')", { runId: 'be10-big' })
    expect(r.snapshot?.id).toBe('be10-big')
    expect(r.undo).toMatchObject({ state: 'unavailable', reason: 'too_large' })
    expect(r.undo?.changedBytes).toBeGreaterThanOrEqual(300 * KB)
    expect(snaps.undoSource(SLUG, 'be10-big')).toBeNull()
  }, 240_000)

  it('per-bot overflow evicts the oldest runs after a real run, never the newest', async () => {
    limits = { perBotBytes: 100 * KB, globalBytes: 1024 * KB, freeFloorBytes: 0 }
    for (let i = 1; i <= 5; i++) {
      writeFileSync(join(ws(), `f${i}.bin`), Buffer.alloc(30 * KB, i))
      const r = await py(`open('f${i}.bin','wb').write(b'x')`, { runId: `be10-run-${i}` })
      expect(r.undo?.state).toBe('available')
    }
    const kept = snaps.list(SLUG).filter((m) => !m.undo).map((m) => m.runId).sort()
    expect(kept).toContain('be10-run-5')
    expect(kept).not.toContain('be10-run-1')
    for (const m of snaps.list(SLUG)) if (m.undo) expect(m.undo.reason).toBeTruthy()
    expect(budget.usage(SLUG).bytes).toBeLessThanOrEqual(100 * KB)
  }, 600_000)
})
