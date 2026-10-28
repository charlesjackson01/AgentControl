/**
 * BE-P2-7 @vm (gVisor job): the RuntimeProbe and gVisor resolution against a real engine.
 * Opt-in: AC_VM_TESTS=1. Needs localhost/agentcontrol/botvm:<BOTVM_VERSION> in that engine's store
 * (and botvm-browser for the Chromium check, else that test skips). runsc must be installed for the
 * gVisor rows (else they skip with the reason). Engine selection as in podman-runner.vm.test.ts
 * (AC_VM_ENGINE, PODMAN_ARGS). Everything runs with --network none and is removed at the end.
 *
 * "auto → Active" needs a host where runsc passes every check; where it doesn't (e.g. rootless
 * runsc that only starts with ignore-cgroups, so limits fail), it skips with the failing check.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execCommandRunner } from './command-runner.js'
import { createBotEnvService, type EngineRef } from './bot-env.js'
import { createRuntimeProbe, forceOnMessage, PROBE_BUDGET_MS, PROBE_LABEL, registerProbeRoutes, resolveRuntime, type RuntimeProbeResult } from './runtime-probe.js'
import { defaultAgentVm } from './vm-defaults.js'
import type { Agent } from './shared/types.js'
import { sharedImageRef } from './vm-images.js'

const SLUG = 'be7vmtest'
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
const browserReady = engineReady && pm('image', 'inspect', '--format', '{{.Id}}', sharedImageRef('botvm-browser')) !== null

function cleanup(): void {
  pm('rm', '--force', `ac-bot-${SLUG}`)
  pm('volume', 'rm', '--force', `ac-tools-${SLUG}`, `ac-opt-${SLUG}`)
  for (const id of (pm('ps', '-a', '--filter', `label=${PROBE_LABEL}=1`, '--format', '{{.ID}}') ?? '').split('\n').filter(Boolean)) pm('rm', '--force', id)
}
const summary = (r: RuntimeProbeResult) => ({
  compatible: r.compatible, runsc: r.runsc, runscFlags: r.runscFlags, uidMapping: r.uidMapping, features: r.features, durationMs: r.durationMs,
  checks: r.checks?.map((c) => [c.id, c.status, c.message?.slice(0, 160)]), std: r.standard?.checks.map((c) => [c.id, c.status]),
})

describe.skipIf(!engineReady)('@vm BE-P2-7 RuntimeProbe + gVisor resolution', () => {
  let dir = ''
  let probe: RuntimeProbeResult
  const features = browserReady ? (['chromium'] as const) : ([] as const)

  beforeAll(async () => {
    cleanup()
    dir = mkdtempSync(join(tmpdir(), 'ac-be7-vm-'))
    probe = await createRuntimeProbe({ exec: execCommandRunner, engine: async () => ENGINE, bindDir: () => dir, features: () => features }).refresh()
    console.log(`[be7 probe] ${JSON.stringify(summary(probe))}`)
  }, 300_000)
  afterAll(() => {
    cleanup()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }, 120_000)

  it('checks come in plan order; the probe reports its feature set and duration', () => {
    const order: string[] = ['start', 'bind_mount', 'snapshot_mount', 'network', 'cgroup_limits', 'exec', 'chromium']
    const ids: string[] = probe.standard!.checks.map((c) => c.id)
    expect(ids).toEqual(order.filter((id) => ids.includes(id)))
    expect(probe.features).toEqual([...features])
    expect(probe.durationMs).toBeGreaterThan(0)
    if (probe.durationMs! > PROBE_BUDGET_MS) console.log(`[be7] probe took ${probe.durationMs} ms (over the ${PROBE_BUDGET_MS} ms budget)`)
  })

  it('auto → gVisor Active (runsc passes every check)', ({ skip }) => {
    if (!probe.runsc.installed) skip('runsc is not installed on this host')
    const failing = probe.checks?.find((c) => c.status === 'fail')
    if (!probe.compatible) skip(`runsc is installed but incompatible here: ${failing?.id}: ${failing?.message ?? ''}`)
    expect(resolveRuntime('auto', 'inherit', probe, 'Analyst')).toMatchObject({ effective: 'runsc', status: 'active', limitsEnforced: true, checkedAt: probe.checkedAt })
  })

  it('auto here resolves to what the probe says (Active, or the fallback with the failing check)', () => {
    const r = resolveRuntime('auto', 'inherit', probe, 'Analyst')
    if (!probe.runsc.installed) return void expect(r).toMatchObject({ status: 'not_installed', effective: probe.standard?.runtime ?? 'crun' })
    if (probe.compatible) return void expect(r.status).toBe('active')
    const failing = probe.checks!.find((c) => c.status === 'fail')!
    expect(r).toMatchObject({ status: 'incompatible_fallback', effective: probe.standard?.runtime ?? 'crun', failedCheck: failing.id, checkedAt: probe.checkedAt })
    expect(r.reason).toBeTruthy()
  })

  it('break the idmap check (runsc gets idmap only) → Incompatible fallback with the bind-mount reason', async ({ skip }) => {
    if (cli === 'docker') skip('Docker has no idmap/keep-id choice')
    if (!probe.runsc.installed) skip('runsc is not installed on this host')
    const broken = await createRuntimeProbe({
      exec: execCommandRunner, engine: async () => ENGINE, bindDir: () => dir,
      // Force idmap on runsc: where idmap mounts don't work, the bind_mount check fails.
      uidMappings: (rt) => (rt === 'runsc' ? ['idmap'] : ['idmap', 'keep-id']),
    }).refresh()
    console.log(`[be7 broken] ${JSON.stringify(summary(broken))}`)
    const bind = broken.checks?.find((c) => c.id === 'bind_mount')
    if (bind?.status === 'pass') skip('idmapped mounts work with runsc here, so idmap can\'t be broken this way')
    expect(bind).toMatchObject({ status: 'fail' })
    expect(bind!.message).toContain('idmap failed')
    expect(broken.compatible).toBe(false)
    const r = resolveRuntime('auto', 'inherit', broken, 'Analyst')
    expect(r).toMatchObject({ effective: broken.standard?.runtime ?? 'crun', status: 'incompatible_fallback', failedCheck: 'bind_mount', reason: bind!.message })
    expect(resolveRuntime('auto', 'force_on', broken, 'Analyst')).toMatchObject({
      effective: null, status: 'required_unavailable', reason: forceOnMessage('Analyst', 'bind-mount ownership check failed'),
    })
  }, 300_000)

  it('Re-check (POST /api/vm/probe) updates checkedAt', async () => {
    const app = Fastify()
    const p = createRuntimeProbe({ exec: execCommandRunner, engine: async () => ENGINE, bindDir: () => dir, tryRunsc: false })
    registerProbeRoutes(app, p)
    try {
      const first = await app.inject({ method: 'POST', url: '/api/vm/probe', headers: { 'x-agentcontrol-confirm': '1' } })
      expect(first.statusCode).toBe(200)
      const before = first.json().checkedAt as string
      await new Promise((r) => setTimeout(r, 1100))
      const again = await app.inject({ method: 'POST', url: '/api/vm/probe', headers: { 'x-agentcontrol-confirm': '1' } })
      expect(again.statusCode).toBe(200)
      const after = again.json().checkedAt as string
      expect(Date.parse(after)).toBeGreaterThan(Date.parse(before))
      expect((await app.inject({ method: 'GET', url: '/api/vm/probe' })).json().checkedAt).toBe(after)
      expect(resolveRuntime('force_off', 'inherit', p.current(), 'A').checkedAt).toBe(after)
    } finally {
      await app.close()
    }
  }, 300_000)

  it('Chromium check (botvm-browser): launches and screenshots about:blank on the standard runtime', ({ skip }) => {
    if (!browserReady) skip(`${sharedImageRef('botvm-browser')} is not in this engine's store`)
    expect(probe.standard!.checks.find((c) => c.id === 'chromium')).toMatchObject({ status: 'pass', message: expect.stringMatching(/^Chromium .*about:blank$/) })
    const onRunsc = probe.checks?.find((c) => c.id === 'chromium')
    console.log(`[be7 chromium] std pass; runsc: ${onRunsc ? `${onRunsc.status} ${onRunsc.message ?? ''}` : 'not run'}`)
    if (probe.checks?.find((c) => c.id === 'start')?.status === 'pass') expect(onRunsc?.status).toMatch(/pass|fail/)
  })

  it('a runtime change recreates the bot container (volumes kept), even for the bot\'s own run', async ({ skip }) => {
    if (cli === 'docker') skip('Podman only here')
    if (!probe.runsc.installed || probe.checks?.find((c) => c.id === 'start')?.status !== 'pass') skip('runsc is not installed or does not start here')
    for (const sub of ['workspace', 'shared']) mkdirSync(join(dir, 'bot', sub), { recursive: true })
    let runtime: 'runsc' | null = null
    const runs = 1
    const agent = { id: 'ag_be7vm', slug: SLUG, name: 'BE7 VM test', internetPolicy: 'ask', vm: { ...defaultAgentVm() } } as unknown as Agent
    const botEnv = createBotEnvService({
      exec: execCommandRunner,
      engine: async () => ENGINE,
      mounts: () => [
        { source: join(dir, 'bot', 'workspace'), target: '/bot/workspace', readonly: false },
        { source: join(dir, 'bot', 'shared'), target: '/bot/shared', readonly: true },
      ],
      uidMapping: () => 'keep-id',
      allowedMounts: () => ({ slug: SLUG, workspace: join(dir, 'bot', 'workspace'), inputs: join(dir, 'bot', 'shared'), groups: {}, botRoot: join(dir, 'bot') }),
      saveVm: () => true,
      runtime: () => runtime,
      runtimeFlags: () => (runtime ? probe.runscFlags : []),
      enforceLimits: () => probe.standard?.limitsAccepted ?? true,
      activeRuns: () => runs,
    })
    const ociRuntime = () => pm('container', 'inspect', '--format', '{{.OCIRuntime}}', `ac-bot-${SLUG}`)
    // A file in the ac-tools volume (/home/bot) must survive both recreates.
    const marker = (flags: string[] = []) => pm(...flags, 'exec', '--user', '1000:1000', `ac-bot-${SLUG}`, 'cat', '/home/bot/be7-marker')
    await botEnv.ensure(agent, { start: true, forRun: true })
    expect(ociRuntime()).toBe('crun')
    const firstId = pm('container', 'inspect', '--format', '{{.Id}}', `ac-bot-${SLUG}`)
    expect(pm('exec', '--user', '1000:1000', `ac-bot-${SLUG}`, 'sh', '-c', 'echo kept > /home/bot/be7-marker && echo ok')).toBe('ok')
    runtime = 'runsc'
    // Not the run itself (e.g. the VM tab's start): a running container with a run is kept.
    await botEnv.ensure(agent, { start: true })
    expect(pm('container', 'inspect', '--format', '{{.Id}}', `ac-bot-${SLUG}`)).toBe(firstId)
    await botEnv.ensure(agent, { start: true, forRun: true })
    expect(ociRuntime()).toBe('runsc')
    expect(pm('container', 'inspect', '--format', '{{.State.Running}}', `ac-bot-${SLUG}`)).toBe('true')
    expect(marker(probe.runscFlags)).toBe('kept')
    expect(pm(...probe.runscFlags, 'exec', `ac-bot-${SLUG}`, 'id', '-u')).toBe('1000')
    runtime = null
    await botEnv.ensure(agent, { start: true, forRun: true })
    expect(ociRuntime()).toBe('crun')
    expect(marker()).toBe('kept')
    await botEnv.stop(agent)
    expect(pm('container', 'inspect', '--format', '{{.State.Running}}', `ac-bot-${SLUG}`)).toBe('false')
  }, 300_000)
})
