/**
 * BE-P2-17 @vm: the new routes over the app's own botEnv, runner, snapshots and undo with a real
 * engine (BuildAppOptions.vmEngine). Opt-in: AC_VM_TESTS=1, same engine variables as
 * run-service.vm.test.ts (AC_VM_ENGINE, PODMAN_ARGS). Needs localhost/agentcontrol/botvm:<BOTVM_VERSION>
 * in that engine's store. Runs and tool builds use --network none; the bot's container, volumes and
 * image layers are removed afterwards.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildApp } from './app.js'
import type { EngineRef } from './bot-env.js'
import { execCommandRunner } from './command-runner.js'
import { botRoot } from './files.js'
import { ensureDm } from './conversations.js'
import { ALLOW_UNLIMITED_RUNS_ENV } from './podman-runner.js'
import { createRuntimeProbe, PROBE_LABEL, resolveRuntime, type RuntimeProbe, type RuntimeProbeResult } from './runtime-probe.js'
import type { Agent, ScriptRun, UndoPreview, VmHostInfo } from './shared/types.js'
import { LocalFs, storageFor } from './storage/index.js'
import { createStore } from './store.js'
import { sharedImageRef } from './vm-images.js'

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

// The first bot in a fresh store is the primary (slug "primary").
const SLUG = 'primary'
function cleanup(): void {
  pm('rm', '--force', `ac-bot-${SLUG}`)
  pm('volume', 'rm', '--force', `ac-tools-${SLUG}`, `ac-opt-${SLUG}`)
  for (const ref of (pm('image', 'ls', '--filter', `reference=localhost/ac-bot-${SLUG}`, '--format', '{{.Repository}}:{{.Tag}}') ?? '').split('\n').filter(Boolean)) pm('rmi', '--force', ref)
  for (const id of (pm('ps', '-a', '--filter', `label=${PROBE_LABEL}=1`, '--format', '{{.ID}}') ?? '').split('\n').filter(Boolean)) pm('rm', '--force', id)
}

describe.skipIf(!engineReady)('@vm BE-P2-17 routes', () => {
  let dir = ''
  let store: ReturnType<typeof createStore>
  let app: ReturnType<typeof buildApp>
  let probe: RuntimeProbeResult
  let bot: Agent
  const savedOverride = process.env[ALLOW_UNLIMITED_RUNS_ENV]
  const inject = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) => app.inject({ method, url, payload: payload as object | undefined })
  const ws = () => join(botRoot(store, bot), 'workspace')
  const py = async (code: string) => {
    const r = await app.vmRuns.start({ agentId: bot.id, conversationId: ensureDm(store, bot.id).id, context: { kind: 'dm' }, argv: ['python3', '-c', code], timeoutSec: 120 })
    const done = await app.vmRuns.wait(r.id)
    expect(done.status, done.error).toBe('succeeded')
    return done
  }

  beforeAll(async () => {
    cleanup()
    vi.stubEnv('AGENTCONTROL_SECRET', 'be17-vm-test-secret')
    vi.stubEnv('AGENTCONTROL_AUTH_TOKEN', '')
    dir = mkdtempSync(join(tmpdir(), 'ac-be17-vm-'))
    store = createStore(join(dir, 'store.json'))
    const backend = storageFor(store).backend
    if (!(backend instanceof LocalFs)) throw new Error('expected LocalFs')
    const realProbe = createRuntimeProbe({ exec: execCommandRunner, engine: async () => ENGINE, bindDir: () => backend.volumeRoot, tryRunsc: process.env.AC_VM_RUNSC !== '0' })
    probe = await realProbe.refresh()
    console.log(`[be17 probe] driver=${probe.snapshotDriver}`)
    const runtimeProbe: RuntimeProbe = { ...realProbe, current: () => probe, refresh: async () => probe, ensureFresh: async () => probe }
    if (!resolveRuntime('auto', 'inherit', probe, 'x').limitsEnforced) process.env[ALLOW_UNLIMITED_RUNS_ENV] = '1'
    const host = {
      engine: cli, version: 'test', provider: 'native', os: 'linux', machine: null,
      storage: { driver: null, backend: 'local', volumeState: 'ok' }, concurrency: 2, setupSteps: [],
    } as unknown as VmHostInfo
    app = buildApp(store, {
      vmHost: { hostInfo: async () => host, ensureMachine: async () => host, grow: async () => host },
      runtimeProbe, vmEngine: ENGINE, vmFreeBytes: () => null,
    })
    await app.ready()
    const res = await inject('POST', '/api/agents', { name: 'Be17vmbot', endpointId: 'ep_local_llama', modelId: 'llama-3-8b' })
    expect(res.statusCode).toBe(201)
    bot = res.json() as Agent
    expect(bot.slug).toBe(SLUG)
    for (const sub of ['workspace', 'shared']) mkdirSync(join(botRoot(store, bot), sub), { recursive: true })
  }, 300_000)

  afterAll(async () => {
    await app?.vmRuns.idle().catch(() => {})
    await app?.close()
    vi.unstubAllEnvs()
    if (savedOverride === undefined) delete process.env[ALLOW_UNLIMITED_RUNS_ENV]
    else process.env[ALLOW_UNLIMITED_RUNS_ENV] = savedOverride
    cleanup()
    if (dir) pm('unshare', 'rm', '-rf', dir)
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  }, 120_000)

  it('rebuild builds generation 1 offline (a real image, the container runs on it); rollback goes back to 0', async () => {
    await py("print('warm')")
    const res = await inject('POST', `/api/agents/${bot.id}/vm/tools/rebuild`)
    expect(res.statusCode, res.body).toBe(200)
    const run = res.json() as ScriptRun
    expect(run).toMatchObject({ kind: 'tool_build', status: 'succeeded', argv: ['rebuild'] })
    expect(pm('image', 'inspect', '--format', '{{.Id}}', `localhost/ac-bot-${SLUG}:1`)).not.toBeNull()
    expect(store.agents.find((a) => a.id === bot.id)!.vm.image.generation).toBe(1)
    expect((await inject('GET', `/api/runs/${run.id}/output?stream=stdout`)).body.length).toBeGreaterThan(0)
    // The next run recreates the container on generation 1.
    await py("print('on gen 1')")
    const img = pm('container', 'inspect', '--format', '{{.ImageName}}', `ac-bot-${SLUG}`)
    expect(img).toContain(`ac-bot-${SLUG}:1`)
    const tools = (await inject('GET', `/api/agents/${bot.id}/vm/tools`)).json()
    expect(tools).toMatchObject({ canRollback: true })

    const back = await inject('POST', `/api/agents/${bot.id}/vm/tools/rollback`)
    expect(back.statusCode, back.body).toBe(200)
    expect(back.json()).toMatchObject({ kind: 'tool_build', status: 'succeeded', argv: ['rollback'] })
    expect(store.agents.find((a) => a.id === bot.id)!.vm.image.generation).toBe(0)
    expect(pm('image', 'inspect', '--format', '{{.Id}}', `localhost/ac-bot-${SLUG}:1`)).toBeNull()
    expect((await inject('POST', `/api/agents/${bot.id}/vm/tools/rollback`)).json()).toMatchObject({ reason: 'no_previous_generation' })
    await py("print('back on base')")
  }, 600_000)

  it('BE-P2-22: a run started during a real offline rebuild waits ("after tool build") and runs on the new generation', async () => {
    const until = async (cond: () => boolean, ms = 60_000) => {
      const t0 = Date.now()
      while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 5))
      expect(cond()).toBe(true)
    }
    await py("print('warm')")
    const gen0 = store.agents.find((a) => a.id === bot.id)!.vm.image.generation
    const rebuild = inject('POST', `/api/agents/${bot.id}/vm/tools/rebuild`)
    await until(() => app.vmRuns.buildActive(bot.id))
    const r = await app.vmRuns.start({ agentId: bot.id, conversationId: ensureDm(store, bot.id).id, context: { kind: 'dm' }, argv: ['python3', '-c', "print('after the build')"], timeoutSec: 120 })
    expect(r).toMatchObject({ status: 'queued', queuedReason: 'tool_build', queuePosition: 1 })
    // Rollback, rebuild and reset wait for the build too.
    for (const [url, body] of [['vm/tools/rollback', undefined], ['vm/tools/rebuild', undefined], ['vm/reset', { confirm: true }]] as const) {
      const res = await inject('POST', `/api/agents/${bot.id}/${url}`, body)
      expect(res.statusCode, `${url}: ${res.body}`).toBe(409)
      expect(res.json()).toMatchObject({ reason: 'build_active' })
    }
    const res = await rebuild
    expect(res.statusCode, res.body).toBe(200)
    const gen1 = store.agents.find((a) => a.id === bot.id)!.vm.image.generation
    expect(gen1).toBe(gen0 + 1)
    const done = await app.vmRuns.wait(r.id)
    expect(done.status, done.error).toBe('succeeded')
    expect(done.stdoutTail).toBe('after the build\n')
    expect(done.queuedReason).toBeUndefined()
    expect(Date.parse(done.startedAt!)).toBeGreaterThanOrEqual(Date.parse((res.json() as ScriptRun).endedAt!))
    expect(pm('container', 'inspect', '--format', '{{.ImageName}}', `ac-bot-${SLUG}`)).toContain(`ac-bot-${SLUG}:${gen1}`)
    // Back to where it was (the next tests don't depend on the generation).
    const back = await inject('POST', `/api/agents/${bot.id}/vm/tools/rollback`)
    expect(back.statusCode, back.body).toBe(200)
    expect(store.agents.find((a) => a.id === bot.id)!.vm.image.generation).toBe(gen0)
  }, 600_000)

  it('undo over HTTP: preview, 409 conflicts with the list, force, then already undone', async () => {
    if (!probe.snapshotDriver) {
      console.log('[be17] no snapshot driver on this host: undo routes not exercised')
      return
    }
    writeFileSync(join(ws(), 'a.txt'), 'alpha\n')
    const r1 = await py("open('a.txt','w').write('run one\\n')\nopen('new.txt','w').write('new\\n')")
    const prev = await inject('GET', `/api/runs/${r1.id}/undo/preview`)
    expect(prev.statusCode, prev.body).toBe(200)
    const p = prev.json() as UndoPreview
    expect(p.conflicts).toEqual([])
    expect(p.changes.map((c) => `${c.action} ${c.path}`).sort()).toEqual(['delete workspace/new.txt', 'restore workspace/a.txt'])

    await py("open('a.txt','w').write('run two, longer\\n')")
    const conflict = await inject('POST', `/api/runs/${r1.id}/undo`, {})
    expect(conflict.statusCode).toBe(409)
    expect(conflict.json()).toMatchObject({ reason: 'conflicts', conflicts: [{ path: 'workspace/a.txt', root: 'agent' }] })
    expect((await inject('GET', `/api/runs/${r1.id}/undo/preview`)).json().conflicts).toHaveLength(1)

    const done = await inject('POST', `/api/runs/${r1.id}/undo`, { force: true })
    expect(done.statusCode, done.body).toBe(200)
    const body = done.json() as { run: ScriptRun; undoRun: ScriptRun }
    expect(body.run).toMatchObject({ id: r1.id, status: 'undone' })
    expect(body.undoRun).toMatchObject({ kind: 'undo', undoOfRunId: r1.id, status: 'succeeded' })
    expect(readFileSync(join(ws(), 'a.txt'), 'utf8')).toBe('alpha\n')
    expect(existsSync(join(ws(), 'new.txt'))).toBe(false)
    const again = await inject('POST', `/api/runs/${r1.id}/undo`, { force: true })
    expect(again.statusCode).toBe(409)
    expect(again.json()).toMatchObject({ reason: 'already_undone' })
  }, 600_000)

  it('PATCH /api/vm/settings budget: enforce runs against the real snapshots', async () => {
    const res = await inject('PATCH', '/api/vm/settings', { snapshotBudget: { perBotMb: 256, globalMb: 1024 } })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().snapshotBudget).toMatchObject({ perBotMb: 256, globalMb: 1024 })
    const vm = (await inject('GET', `/api/agents/${bot.id}/vm`)).json()
    expect(vm.usage.snapshots.budgetBytes).toBe(256 * 1024 * 1024)
  }, 120_000)
})
