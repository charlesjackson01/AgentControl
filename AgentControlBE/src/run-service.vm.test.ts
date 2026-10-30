/**
 * BE-P2-12 @vm: RunService over the real container runner (streamed logs, the queue, stop).
 * Opt-in: AC_VM_TESTS=1, same engine variables as undo.vm.test.ts (AC_VM_ENGINE, PODMAN_ARGS).
 * Needs localhost/agentcontrol/botvm:<BOTVM_VERSION> in that engine's store. Runs use
 * --network none; everything created is removed.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execCommandRunner } from './command-runner.js'
import { createBotEnvService, type EngineRef } from './bot-env.js'
import { ALLOW_UNLIMITED_RUNS_ENV, createContainerRunner, type ContainerRunner } from './podman-runner.js'
import { createRunService, MODEL_TAIL_BYTES, type RunService } from './run-service.js'
import { createRuntimeProbe, PROBE_LABEL, resolveRuntime, type ResolvedRuntime, type RuntimeProbeResult } from './runtime-probe.js'
import { newRunId } from './snapshot.js'
import { defaultAgentVm } from './vm-defaults.js'
import type { Agent, ChatMessage, Conversation } from './shared/types.js'
import { sharedImageRef } from './vm-images.js'

const SLUG = 'be12vmtest'
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

describe.skipIf(!engineReady)('@vm BE-P2-12 RunService', () => {
  let vol = ''
  let probe: RuntimeProbeResult
  let rt: ResolvedRuntime
  let runner: ContainerRunner
  let svc: RunService
  let concurrency = 1
  const messages: ChatMessage[] = []
  const savedOverride = process.env[ALLOW_UNLIMITED_RUNS_ENV]
  const agent = { id: 'ag_be12vm', slug: SLUG, name: 'BE12 VM test', internetPolicy: 'ask', vm: defaultAgentVm() } as unknown as Agent
  const conv = { id: 'dm-be12', kind: 'dm', agentId: agent.id, createdAt: '', updatedAt: '', lastReadAt: null } as unknown as Conversation
  const ws = () => join(vol, 'bots', SLUG, 'workspace')
  const py = (code: string, timeoutSec = 120) =>
    svc.start({ agentId: agent.id, conversationId: conv.id, context: { kind: 'dm' }, argv: ['python3', '-c', code], timeoutSec })

  beforeAll(async () => {
    cleanup()
    vol = mkdtempSync(join(tmpdir(), 'ac-be12-vm-'))
    mkdirSync(ws(), { recursive: true })
    mkdirSync(join(vol, 'bots', SLUG, 'shared'), { recursive: true })
    probe = await createRuntimeProbe({ exec: execCommandRunner, engine: async () => ENGINE, bindDir: () => vol, tryRunsc: process.env.AC_VM_RUNSC !== '0' }).refresh()
    rt = resolveRuntime('auto', 'inherit', probe, agent.name)
    if (!rt.limitsEnforced) process.env[ALLOW_UNLIMITED_RUNS_ENV] = '1'
    const botEnv = createBotEnvService({
      exec: execCommandRunner,
      engine: async () => ENGINE,
      mounts: () => [
        { source: ws(), target: '/bot/workspace', readonly: false },
        { source: join(vol, 'bots', SLUG, 'shared'), target: '/bot/shared', readonly: true },
      ],
      uidMapping: () => (cli === 'docker' ? null : ((rt.effective === 'runsc' ? probe.uidMapping : probe.standard?.uidMapping) ?? 'keep-id')),
      allowedMounts: () => ({ slug: SLUG, workspace: ws(), inputs: join(vol, 'bots', SLUG, 'shared'), groups: {}, botRoot: join(vol, 'bots', SLUG), overlayRoot: join(vol, 'snapshots', SLUG, '.overlay') }),
      saveVm: () => true,
      runtime: () => (rt.effective === 'runsc' ? 'runsc' : null),
      runtimeFlags: () => (rt.effective === 'runsc' ? (rt.flags ?? []) : []),
      enforceLimits: () => probe.standard?.limitsAccepted ?? true,
      activeRuns: (id) => runner.activeRuns(id),
    })
    runner = createContainerRunner({ botEnv, engine: async () => ENGINE, getAgent: () => agent, runtime: () => rt })
    svc = createRunService({
      runner,
      getAgent: (id) => (id === agent.id ? agent : undefined),
      conversations: () => [conv],
      messages: () => messages,
      save: () => {},
      root: () => join(vol, 'runs'),
      concurrency: () => concurrency,
      freeBytes: () => null,
      newRunId,
      log: (m) => console.log(`[be12 runs] ${m}`),
    })
  }, 240_000)
  afterAll(() => {
    if (savedOverride === undefined) delete process.env[ALLOW_UNLIMITED_RUNS_ENV]
    else process.env[ALLOW_UNLIMITED_RUNS_ENV] = savedOverride
    cleanup()
    if (vol) pm('unshare', 'rm', '-rf', vol)
    if (vol && existsSync(vol)) rmSync(vol, { recursive: true, force: true })
  }, 120_000)

  it('a real run streams its full log; the record and the model get tails', async () => {
    const r = await py("import sys\nfor i in range(3000): print('line', i)\nprint('err!', file=sys.stderr)")
    const done = await svc.wait(r.id)
    expect(done).toMatchObject({ status: 'succeeded', exitCode: 0 })
    const log = readFileSync(svc.outputPath(r.id, 'stdout'), 'utf8')
    expect(log.split('\n').filter(Boolean)).toHaveLength(3000)
    const m = svc.modelResult(done)
    expect(Buffer.byteLength(m.stdout)).toBeLessThanOrEqual(MODEL_TAIL_BYTES)
    expect(m.stdout.trimEnd().endsWith('line 2999')).toBe(true)
    expect(m.stderr).toContain('err!')
    expect(messages.find((x) => x.scriptRunId === r.id)!.scriptRun!.status).toBe('succeeded')
  }, 240_000)

  it('one bot runs one at a time; stop ends a running run and a queued one', async () => {
    concurrency = 2
    const a = await py('import time\ntime.sleep(60)')
    const b = await py("print('never')")
    expect(svc.get(b.id)!.status).toBe('queued')
    const t0 = Date.now()
    while (svc.get(a.id)!.status !== 'running' && Date.now() - t0 < 60_000) await new Promise((x) => setTimeout(x, 100))
    expect((await svc.stop(b.id)).status).toBe('stopped')
    const sa = await svc.stop(a.id)
    expect(sa.status).toBe('stopped')
    expect(Date.now() - t0).toBeLessThan(60_000)
  }, 240_000)

  it('a run past its time limit is timed_out', async () => {
    const r = await py('import time\ntime.sleep(30)', 2)
    expect((await svc.wait(r.id)).status).toBe('timed_out')
  }, 240_000)
})
