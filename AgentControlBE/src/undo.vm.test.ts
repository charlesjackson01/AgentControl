/**
 * BE-P2-11 @vm: undo around real container runs (whichever snapshot driver the probe picks).
 * Opt-in: AC_VM_TESTS=1, same engine variables as snapshot.vm.test.ts (AC_VM_ENGINE,
 * PODMAN_ARGS). Needs localhost/agentcontrol/botvm:<BOTVM_VERSION> in that engine's store.
 * Everything runs with --network none; everything created is removed.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execCommandRunner } from './command-runner.js'
import { createBotEnvService, type BotEnvService, type EngineRef } from './bot-env.js'
import { ALLOW_UNLIMITED_RUNS_ENV, createContainerRunner, type ContainerRunner } from './podman-runner.js'
import { createRuntimeProbe, PROBE_LABEL, resolveRuntime, type ResolvedRuntime, type RuntimeProbeResult } from './runtime-probe.js'
import type { RunScriptRequest } from './runner.js'
import { createSnapshotService, newRunId, type SnapshotService, type SnapshotZone } from './snapshot.js'
import { LocalFs } from './storage/index.js'
import { createUndoService, type UndoService } from './undo.js'
import { defaultAgentVm } from './vm-defaults.js'
import type { Agent } from './shared/types.js'
import { sharedImageRef } from './vm-images.js'

const SLUG = 'be11vmtest'
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

const caught = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (x) {
    return x as Error & { statusCode?: number; reason?: string; conflicts?: unknown[] }
  }
  throw new Error('expected an error')
}

describe.skipIf(!engineReady)('@vm BE-P2-11 undo', () => {
  let vol = ''
  let probe: RuntimeProbeResult
  let rt: ResolvedRuntime
  let botEnv: BotEnvService
  let runner: ContainerRunner
  let snaps: SnapshotService
  let undo: UndoService
  let zones: SnapshotZone[]
  const savedOverride = process.env[ALLOW_UNLIMITED_RUNS_ENV]
  const agent = { id: 'ag_be11vm', slug: SLUG, name: 'BE11 VM test', internetPolicy: 'ask', vm: defaultAgentVm() } as unknown as Agent
  const ws = () => join(vol, 'bots', SLUG, 'workspace')
  const py = (code: string, over: Partial<RunScriptRequest> = {}) =>
    runner.run({ agentId: agent.id, context: { kind: 'dm' }, argv: ['python3', '-c', code], cwd: 'workspace', timeoutSec: 120, network: 'off', runId: newRunId(), ...over })
  const seed = () => {
    rmSync(ws(), { recursive: true, force: true })
    mkdirSync(join(ws(), 'sub'), { recursive: true })
    writeFileSync(join(ws(), 'a.txt'), 'alpha\n')
    chmodSync(join(ws(), 'a.txt'), 0o750)
    writeFileSync(join(ws(), 'b.txt'), 'bravo\n')
    writeFileSync(join(ws(), 'sub', 'c.txt'), 'charlie\n')
  }

  beforeAll(async () => {
    cleanup()
    vol = mkdtempSync(join(tmpdir(), 'ac-be11-vm-'))
    mkdirSync(join(vol, 'bots', SLUG, 'workspace'), { recursive: true })
    mkdirSync(join(vol, 'bots', SLUG, 'shared'), { recursive: true })
    const p = createRuntimeProbe({ exec: execCommandRunner, engine: async () => ENGINE, bindDir: () => vol, tryRunsc: process.env.AC_VM_RUNSC !== '0' })
    probe = await p.refresh()
    rt = resolveRuntime('auto', 'inherit', probe, agent.name)
    console.log(`[be11 probe] driver=${probe.snapshotDriver}`)
    if (!rt.limitsEnforced) process.env[ALLOW_UNLIMITED_RUNS_ENV] = '1'
    zones = [{ key: 'workspace', dir: ws(), target: '/bot/workspace', root: 'agent', prefix: 'workspace' }]
    snaps = createSnapshotService({ root: () => join(vol, 'snapshots'), driver: () => probe.snapshotDriver, zones: () => zones, log: (m) => console.log(`[be11 snaps] ${m}`) })
    botEnv = createBotEnvService({
      exec: execCommandRunner,
      engine: async () => ENGINE,
      mounts: (a) => snaps.mountsFor(a, [
        { source: ws(), target: '/bot/workspace', readonly: false },
        { source: join(vol, 'bots', SLUG, 'shared'), target: '/bot/shared', readonly: true },
      ]),
      uidMapping: () => (cli === 'docker' ? null : ((rt.effective === 'runsc' ? probe.uidMapping : probe.standard?.uidMapping) ?? 'keep-id')),
      allowedMounts: () => ({ slug: SLUG, workspace: ws(), inputs: join(vol, 'bots', SLUG, 'shared'), groups: {}, botRoot: join(vol, 'bots', SLUG), overlayRoot: join(vol, 'snapshots', SLUG, '.overlay') }),
      saveVm: () => true,
      runtime: () => (rt.effective === 'runsc' ? 'runsc' : null),
      runtimeFlags: () => (rt.effective === 'runsc' ? (rt.flags ?? []) : []),
      enforceLimits: () => probe.standard?.limitsAccepted ?? true,
      activeRuns: (id) => runner.activeRuns(id),
    })
    runner = createContainerRunner({ botEnv, engine: async () => ENGINE, getAgent: () => agent, runtime: () => rt, snapshots: snaps, log: (m) => console.log(`[be11 runner] ${m}`) })
    const fs = new LocalFs(vol)
    undo = createUndoService({
      snapshots: snaps,
      storage: () => fs,
      zone: (_a, info) => (info.key === 'workspace' ? { zone: zones[0]!, vol: `bots/${SLUG}`, sub: ['workspace'] } : null),
      volOf: (p) => {
        const rel = relative(vol, p)
        return rel && !rel.startsWith('..') ? rel.split(sep).join('/') : null
      },
      activeRuns: (id) => runner.activeRuns(id),
      exclusive: (id, fn) => runner.exclusive(id, fn),
      stopBot: (a) => botEnv.stop(a),
      newRunId,
      log: (m) => console.log(`[be11 undo] ${m}`),
    })
  }, 240_000)
  afterAll(() => {
    if (savedOverride === undefined) delete process.env[ALLOW_UNLIMITED_RUNS_ENV]
    else process.env[ALLOW_UNLIMITED_RUNS_ENV] = savedOverride
    cleanup()
    if (vol) pm('unshare', 'rm', '-rf', vol)
    if (vol && existsSync(vol)) rmSync(vol, { recursive: true, force: true })
  }, 120_000)

  it('a real run is undone: exact bytes and mode, added removed, deleted back; the container sees it; undo of undo', async () => {
    seed()
    const r = await py("import os\nopen('a.txt','w').write('changed by a real run\\n')\nos.chmod('a.txt', 0o600)\nopen('new.txt','w').write('new\\n')\nos.remove('b.txt')")
    expect(r.outcome).toBe('succeeded')
    const runId = r.snapshot!.id
    const prev = undo.preview(agent, runId)
    expect(prev.conflicts).toEqual([])
    expect(prev.changes.map((c) => `${c.action} ${c.path}`).sort()).toEqual(['delete workspace/new.txt', 'restore workspace/a.txt', 'restore workspace/b.txt'])
    const res = await undo.apply(agent, runId)
    expect(readFileSync(join(ws(), 'a.txt'), 'utf8')).toBe('alpha\n')
    expect(statSync(join(ws(), 'a.txt')).mode & 0o777).toBe(0o750)
    expect(readFileSync(join(ws(), 'b.txt'), 'utf8')).toBe('bravo\n')
    expect(existsSync(join(ws(), 'new.txt'))).toBe(false)
    const seen = await py("import os\nprint(open('a.txt').read().strip(), oct(os.stat('a.txt').st_mode & 0o777), os.path.exists('new.txt'), open('b.txt').read().strip())")
    expect(seen.stdout.trim()).toBe('alpha 0o750 False bravo')
    expect(snaps.read(SLUG, runId)!.undo).toMatchObject({ state: 'done', undoRunId: res.undoRunId })
    await undo.apply(agent, res.undoRunId)
    expect(readFileSync(join(ws(), 'a.txt'), 'utf8')).toBe('changed by a real run\n')
    expect(existsSync(join(ws(), 'b.txt'))).toBe(false)
  }, 240_000)

  it('a later run\'s change: 409 conflicts with the list, then force', async () => {
    seed()
    const r1 = await py("open('a.txt','w').write('run one\\n')")
    await py("open('a.txt','w').write('run two, longer\\n')")
    const err = await caught(undo.apply(agent, r1.snapshot!.id))
    expect(err).toMatchObject({ statusCode: 409, reason: 'conflicts', conflicts: [{ path: 'workspace/a.txt', root: 'agent' }] })
    await undo.apply(agent, r1.snapshot!.id, { force: true })
    expect(readFileSync(join(ws(), 'a.txt'), 'utf8')).toBe('alpha\n')
  }, 240_000)

  it('blocked while the bot has an active run (409 run_active)', async () => {
    seed()
    const r1 = await py("open('a.txt','w').write('run one\\n')")
    const long = py('import time\ntime.sleep(60)')
    await new Promise((r) => setTimeout(r, 1500))
    expect(await caught(undo.apply(agent, r1.snapshot!.id))).toMatchObject({ statusCode: 409, reason: 'run_active' })
    runner.stopRuns(agent.id)
    await long
    await undo.apply(agent, r1.snapshot!.id)
    expect(readFileSync(join(ws(), 'a.txt'), 'utf8')).toBe('alpha\n')
  }, 240_000)
})
