/**
 * BE-P2-9 @vm: the snapshot_mount probe and overlay snapshots around real container runs.
 * Opt-in: AC_VM_TESTS=1, same engine variables as podman-runner.vm.test.ts (AC_VM_ENGINE,
 * PODMAN_ARGS). Needs localhost/agentcontrol/botvm:<BOTVM_VERSION> in that engine's store.
 * The overlay tests skip when the probe picks another driver (reflink host, Docker, or overlay
 * mounts not working). Everything runs with --network none; everything created is removed.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execCommandRunner } from './command-runner.js'
import { createBotEnvService, type BotEnvService, type EngineRef } from './bot-env.js'
import { ALLOW_UNLIMITED_RUNS_ENV, createContainerRunner, type ContainerRunner } from './podman-runner.js'
import { createRuntimeProbe, PROBE_LABEL, resolveRuntime, type ResolvedRuntime, type RuntimeProbeResult } from './runtime-probe.js'
import type { RunScriptRequest } from './runner.js'
import { createSnapshotService, type SnapshotService, type SnapshotZone, type UndoSourceEntry } from './snapshot.js'
import { defaultAgentVm } from './vm-defaults.js'
import type { Agent } from './shared/types.js'
import { sharedImageRef } from './vm-images.js'

const SLUG = 'be9vmtest'
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

describe.skipIf(!engineReady)('@vm BE-P2-9 snapshots', () => {
  let dir = ''
  let probe: RuntimeProbeResult
  let rt: ResolvedRuntime
  let botEnv: BotEnvService
  let runner: ContainerRunner
  let snaps: SnapshotService
  let zones: SnapshotZone[]
  const savedOverride = process.env[ALLOW_UNLIMITED_RUNS_ENV]
  const agent = { id: 'ag_be9vm', slug: SLUG, name: 'BE9 VM test', internetPolicy: 'ask', vm: defaultAgentVm() } as unknown as Agent
  const ws = () => join(dir, 'workspace')
  const py = (code: string, over: Partial<RunScriptRequest> = {}) =>
    runner.run({ agentId: agent.id, context: { kind: 'dm' }, argv: ['python3', '-c', code], cwd: 'workspace', timeoutSec: 120, network: 'off', ...over })
  const overlaySkip = (skip: (note?: string) => void) => {
    if (probe.snapshotDriver !== 'overlay') skip(`the probe picked ${probe.snapshotDriver ?? 'no driver'}`)
  }
  const undo = (entries: UndoSourceEntry[]) => {
    for (const u of entries) {
      const to = join(ws(), u.rel)
      rmSync(to, { recursive: true, force: true })
      if (u.original?.kind === 'file') copyFileSync(u.original.file, to)
      if (u.original?.kind === 'symlink') symlinkSync(u.original.target, to)
    }
  }
  const seed = () => {
    rmSync(ws(), { recursive: true, force: true })
    mkdirSync(join(ws(), 'sub'), { recursive: true })
    writeFileSync(join(ws(), 'a.txt'), 'alpha\n')
    writeFileSync(join(ws(), 'b.txt'), 'bravo\n')
    writeFileSync(join(ws(), 'sub', 'c.txt'), 'charlie\n')
  }
  const tree = () => {
    const out: Record<string, string> = {}
    const walk = (rel: string) => {
      for (const n of (pm('unshare', 'ls', '-A', join(ws(), rel)) ?? '').split('\n').filter(Boolean)) {
        const p = rel ? `${rel}/${n}` : n
        try {
          out[p] = readFileSync(join(ws(), p), 'utf8')
        } catch {
          walk(p)
        }
      }
    }
    walk('')
    return out
  }

  beforeAll(async () => {
    cleanup()
    dir = mkdtempSync(join(tmpdir(), 'ac-be9-vm-'))
    for (const sub of ['workspace', 'shared']) mkdirSync(join(dir, sub))
    const p = createRuntimeProbe({ exec: execCommandRunner, engine: async () => ENGINE, bindDir: () => dir, tryRunsc: process.env.AC_VM_RUNSC !== '0' })
    probe = await p.refresh()
    rt = resolveRuntime('auto', 'inherit', probe, agent.name)
    console.log(`[be9 probe] driver=${probe.snapshotDriver} std=${JSON.stringify(probe.standard?.checks.find((c) => c.id === 'snapshot_mount'))} runsc=${JSON.stringify(probe.checks?.find((c) => c.id === 'snapshot_mount') ?? null)}`)
    if (!rt.limitsEnforced) process.env[ALLOW_UNLIMITED_RUNS_ENV] = '1'
    zones = [{ key: 'workspace', dir: ws(), target: '/bot/workspace', root: 'agent', prefix: 'workspace' }]
    snaps = createSnapshotService({ root: () => join(dir, 'snapshots'), driver: () => probe.snapshotDriver, zones: () => zones, log: (m) => console.log(`[be9 snaps] ${m}`) })
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
    runner = createContainerRunner({ botEnv, engine: async () => ENGINE, getAgent: () => agent, runtime: () => rt, snapshots: snaps, log: (m) => console.log(`[be9 runner] ${m}`) })
  }, 240_000)
  afterAll(() => {
    if (savedOverride === undefined) delete process.env[ALLOW_UNLIMITED_RUNS_ENV]
    else process.env[ALLOW_UNLIMITED_RUNS_ENV] = savedOverride
    cleanup()
    // Overlay work folders are owned by a subuid with mode 000: remove inside the user namespace.
    if (dir) pm('unshare', 'rm', '-rf', dir)
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  }, 120_000)

  it('probe: snapshot_mount is real and picks a driver (overlay on rootless Podman without reflink); no probe leftovers', () => {
    const c = probe.standard?.checks.find((x) => x.id === 'snapshot_mount')
    expect(c?.status).toBe('pass')
    expect(['reflink', 'overlay', 'copy']).toContain(probe.snapshotDriver)
    if (cli === 'podman' && !c?.message?.startsWith('reflink')) expect(probe.snapshotDriver).toBe('overlay')
    expect(pm('ps', '-a', '--filter', `label=${PROBE_LABEL}=1`, '--format', '{{.ID}}')).toBe('')
    expect((pm('unshare', 'ls', '-A', dir) ?? '').split('\n').filter((n) => n.startsWith('.ac-snap-probe-'))).toEqual([])
  })

  it('overlay: a run\'s add/modify/delete/rename goes to the upper layer, is committed after the run, and undoes', async ({ skip }) => {
    overlaySkip(skip)
    seed()
    const before = tree()
    const r = await py("import os\nopen('a.txt','a').write('more\\n')\nopen('new.txt','w').write('new\\n')\nos.remove('b.txt')\nos.rename('sub/c.txt','sub/d.txt')", { runId: 'be9-run-1' })
    expect(r).toMatchObject({ outcome: 'succeeded', snapshot: { id: 'be9-run-1', driver: 'overlay', retainedBytes: 'alpha\n'.length + 'bravo\n'.length + 'charlie\n'.length } })
    expect(r.filesChanged.map((c) => [c.path, c.change]).sort()).toEqual([
      ['workspace/a.txt', 'modified'], ['workspace/b.txt', 'deleted'], ['workspace/new.txt', 'added'], ['workspace/sub/c.txt', 'deleted'], ['workspace/sub/d.txt', 'added'],
    ])
    expect(readFileSync(join(ws(), 'a.txt'), 'utf8')).toBe('alpha\nmore\n')
    expect(existsSync(join(ws(), 'b.txt'))).toBe(false)
    undo(snaps.undoSource(SLUG, 'be9-run-1')!)
    expect(tree()).toEqual(before)
  }, 240_000)

  it('overlay: a timed-out run\'s partial writes are committed and undoable', async ({ skip }) => {
    overlaySkip(skip)
    seed()
    const before = tree()
    const r = await py("import os, time\nopen('a.txt','w').write('half')\nos.remove('b.txt')\nopen('partial.tmp','w').write('p')\ntime.sleep(60)", { runId: 'be9-timeout', timeoutSec: 4 })
    expect(r.outcome).toBe('timed_out')
    expect(r.snapshot?.id).toBe('be9-timeout')
    expect(r.filesChanged.map((c) => [c.path, c.change]).sort()).toEqual([['workspace/a.txt', 'modified'], ['workspace/b.txt', 'deleted'], ['workspace/partial.tmp', 'added']])
    expect(readFileSync(join(ws(), 'a.txt'), 'utf8')).toBe('half')
    undo(snaps.undoSource(SLUG, 'be9-timeout')!)
    expect(tree()).toEqual(before)
  }, 240_000)

  it('overlay: a stopped run and a failed run are committed too', async ({ skip }) => {
    overlaySkip(skip)
    seed()
    const p = py("import time\nopen('stopped.txt','w').write('s')\ntime.sleep(60)", { runId: 'be9-stopped' })
    await new Promise((r) => setTimeout(r, 2500))
    runner.stopRuns(agent.id)
    const r = await p
    expect(r.outcome).toBe('stopped')
    expect(r.filesChanged.map((c) => c.path)).toEqual(['workspace/stopped.txt'])
    const f = await py("open('failed.txt','w').write('f')\nraise SystemExit(3)", { runId: 'be9-failed' })
    expect(f.outcome).toBe('failed')
    expect(f.filesChanged.map((c) => c.path)).toEqual(['workspace/failed.txt'])
    expect(readFileSync(join(ws(), 'failed.txt'), 'utf8')).toBe('f')
  }, 240_000)

  it('overlay: writes made by an exec between runs are committed into the next run', async ({ skip }) => {
    overlaySkip(skip)
    seed()
    // The overlay driver stops the container after every run, so start it for the exec.
    await botEnv.start(agent)
    const e = await botEnv.exec(agent, ['sh', '-c', 'echo idle > /bot/workspace/idle.txt'])
    expect(e.code).toBe(0)
    expect(existsSync(join(ws(), 'idle.txt'))).toBe(false) // still in the upper layer
    const r = await py('pass', { runId: 'be9-after-idle' })
    expect(r.filesChanged.map((c) => c.path)).toEqual(['workspace/idle.txt'])
    expect(readFileSync(join(ws(), 'idle.txt'), 'utf8')).toBe('idle\n')
  }, 240_000)
})
