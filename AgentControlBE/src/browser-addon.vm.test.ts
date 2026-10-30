/**
 * BE-P2-15 @vm: turning the browser on and off for a bot with the real engine. Opt-in:
 * AC_VM_TESTS=1, same engine variables as run-service.vm.test.ts (AC_VM_ENGINE, PODMAN_ARGS).
 * Needs localhost/agentcontrol/botvm and botvm-browser (<BOTVM_VERSION>) in that engine's store; the
 * shared images are never built or removed here (the "download" is reused). The bot has no packages,
 * so its builds run with --network none. The bot's container, volumes and images are removed afterwards.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildApp } from './app.js'
import { botMountAllowList, botMounts, storeSaveVm } from './bot-env-routes.js'
import { createBotEnvService, type EngineRef } from './bot-env.js'
import { execCommandRunner } from './command-runner.js'
import { botRoot } from './files.js'
import { ALLOW_UNLIMITED_RUNS_ENV, createContainerRunner, type ContainerRunner } from './podman-runner.js'
import { createRuntimeProbe, PROBE_LABEL, resolveRuntime, type ResolvedRuntime, type RuntimeProbe, type RuntimeProbeResult } from './runtime-probe.js'
import type { Agent, BrowserAddonInfo, ScriptRun, VmHostInfo, VmInfo } from './shared/types.js'
import { createStore } from './store.js'
import { PROXY_UNAVAILABLE, type EgressService } from './egress-service.js'
import { botImageRef, sharedImageRef } from './vm-images.js'

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
const has = (ref: string) => pm('image', 'inspect', '--format', '{{.Id}}', ref) !== null
const engineReady = process.env.AC_VM_TESTS === '1' && has(sharedImageRef('botvm')) && has(sharedImageRef('botvm-browser'))

// The first bot is the primary, whose slug is "primary".
const SLUG = 'primary'
function cleanup(): void {
  pm('rm', '--force', `ac-bot-${SLUG}`)
  pm('volume', 'rm', '--force', `ac-tools-${SLUG}`, `ac-opt-${SLUG}`)
  for (const id of (pm('ps', '-a', '--filter', `label=${PROBE_LABEL}=1`, '--format', '{{.ID}}') ?? '').split('\n').filter(Boolean)) pm('rm', '--force', id)
  for (let g = 1; g <= 4; g++) if (has(botImageRef(SLUG, g))) pm('rmi', botImageRef(SLUG, g))
}

const noProxy = {
  available: async () => ({ ok: false, message: PROXY_UNAVAILABLE }),
  networkFor: (slug: string) => `ac-none-${slug}`,
  grant: async () => { throw new Error('no proxy in this test') },
  revoke: async () => [],
  hosts: async () => [],
  removeNetwork: async () => {},
  shutdown: async () => {},
  connectCheck: async () => ({ status: 'fail' as const, message: 'no proxy in this test' }),
  userOnlyCidrs: () => [],
  refreshSubnets: async () => {},
} as unknown as EgressService

describe.skipIf(!engineReady)('@vm BE-P2-15 browser add-on', () => {
  let dir = ''
  let store: ReturnType<typeof createStore>
  let app: ReturnType<typeof buildApp>
  let probe: RuntimeProbeResult
  let runner: ContainerRunner
  let bot: Agent
  const savedOverride = process.env[ALLOW_UNLIMITED_RUNS_ENV]
  const rt = (agent: Agent): ResolvedRuntime => resolveRuntime('auto', agent.vm.gvisor, probe, agent.name)

  beforeAll(async () => {
    cleanup()
    vi.stubEnv('AGENTCONTROL_SECRET', 'be15-vm-test-secret')
    vi.stubEnv('AGENTCONTROL_AUTH_TOKEN', '')
    dir = mkdtempSync(join(tmpdir(), 'ac-be15-vm-'))
    store = createStore(join(dir, 'store.json'))
    const probeBind = join(dir, 'probe')
    mkdirSync(probeBind, { recursive: true })
    const realProbe = createRuntimeProbe({ exec: execCommandRunner, engine: async () => ENGINE, bindDir: () => probeBind, tryRunsc: process.env.AC_VM_RUNSC !== '0' })
    probe = await realProbe.refresh()
    const runtimeProbe: RuntimeProbe = { ...realProbe, current: () => probe, refresh: async () => probe, ensureFresh: async () => probe }
    if (!rt({ name: 'x', vm: { gvisor: 'inherit' } } as Agent).limitsEnforced) process.env[ALLOW_UNLIMITED_RUNS_ENV] = '1'
    const mapping = (agent: Agent) => (cli === 'docker' ? null : ((rt(agent).effective === 'runsc' ? probe.uidMapping : probe.standard?.uidMapping) ?? 'keep-id'))
    const botEnv = createBotEnvService({
      exec: execCommandRunner,
      engine: async () => ENGINE,
      mounts: (agent) => botMounts(store, agent),
      allowedMounts: (agent) => botMountAllowList(store, agent),
      uidMapping: mapping,
      saveVm: storeSaveVm(store),
      runtime: (agent) => (rt(agent).effective === 'runsc' ? 'runsc' : null),
      runtimeFlags: (agent) => (rt(agent).effective === 'runsc' ? (rt(agent).flags ?? []) : []),
      enforceLimits: () => probe.standard?.limitsAccepted ?? true,
      activeRuns: (id) => runner.activeRuns(id),
    })
    runner = createContainerRunner({ botEnv, engine: async () => ENGINE, getAgent: (id) => store.agents.find((a) => a.id === id), runtime: rt })
    const host = {
      engine: cli, version: 'test', provider: 'native', os: 'linux', machine: null,
      storage: { driver: null, backend: 'local', volumeState: 'ok' }, concurrency: 2, setupSteps: [],
    } as unknown as VmHostInfo
    app = buildApp(store, {
      vmHost: { hostInfo: async () => host, ensureMachine: async () => host, grow: async () => host },
      botEnv, runtimeProbe, vmRunner: runner, vmEngine: ENGINE, vmFreeBytes: () => null, egress: noProxy, browserIdlePollMs: 100,
    })
    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/api/agents', payload: { name: 'Be15vmbot', endpointId: 'ep_local_llama', modelId: 'llama-3-8b' } })
    expect(res.statusCode).toBe(201)
    bot = res.json() as Agent
    expect(bot.slug).toBe(SLUG)
    for (const sub of ['workspace', 'shared']) mkdirSync(join(botRoot(store, bot), sub), { recursive: true })
  }, 300_000)

  afterAll(async () => {
    await app?.vmBrowser.idle().catch(() => {})
    await app?.vmRuns.idle().catch(() => {})
    await app?.close()
    vi.unstubAllEnvs()
    if (savedOverride === undefined) delete process.env[ALLOW_UNLIMITED_RUNS_ENV]
    else process.env[ALLOW_UNLIMITED_RUNS_ENV] = savedOverride
    cleanup()
    if (dir) pm('unshare', 'rm', '-rf', dir)
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  }, 300_000)

  const vmOf = async () => (await app.inject({ method: 'GET', url: `/api/agents/${bot.id}/vm` })).json() as VmInfo

  it('on: the download is reused, a tool_build onto the browser base, the real Chromium check → ready; off: back onto the base', async () => {
    expect(((await app.inject({ method: 'GET', url: '/api/vm/browser' })).json() as BrowserAddonInfo).state).toBe('ready')
    const on = await app.inject({ method: 'PATCH', url: `/api/agents/${bot.id}/vm`, payload: { permissions: { browser: true } } })
    expect(on.statusCode).toBe(200)
    await app.vmBrowser.idle()
    const vm = await vmOf()
    expect(vm.browser).toMatchObject({ state: 'ready', setup: { download: { reused: true }, check: { status: 'pass' } } })
    expect(vm.browser!.chromium!.version).toMatch(/^\d+\./)
    expect(vm.permissions).toMatchObject({ browser: true, browserState: 'ready' })
    expect(vm.image).toMatchObject({ generation: 1, base: 'browser' })
    const run = (await app.inject({ method: 'GET', url: `/api/runs/${vm.browser!.setup!.rebuild.runId}` })).json() as ScriptRun
    expect(run).toMatchObject({ kind: 'tool_build', status: 'succeeded', build: { via: 'browser', base: 'browser' } })
    expect(pm('image', 'inspect', '--format', '{{index .Labels "io.agentcontrol.from"}}', botImageRef(SLUG, 1))).toBe(sharedImageRef('botvm-browser'))
    // In use: DELETE refuses (and the shared image stays).
    const del = await app.inject({ method: 'DELETE', url: '/api/vm/browser', headers: { 'x-agentcontrol-confirm': '1' } })
    expect(del.statusCode).toBe(409)
    expect(del.json()).toMatchObject({ reason: 'browser_in_use' })

    const off = await app.inject({ method: 'PATCH', url: `/api/agents/${bot.id}/vm`, payload: { permissions: { browser: false } } })
    expect(off.statusCode).toBe(200)
    await app.vmBrowser.idle()
    const after = await vmOf()
    expect(after.image).toMatchObject({ generation: 2, base: 'base' })
    expect(after.browser?.state).toBe('off')
    expect(pm('image', 'inspect', '--format', '{{index .Labels "io.agentcontrol.from"}}', botImageRef(SLUG, 2))).toBe(sharedImageRef('botvm'))
    expect(((await app.inject({ method: 'GET', url: '/api/vm/browser' })).json() as BrowserAddonInfo).usedBy).toEqual([])
    expect(has(sharedImageRef('botvm-browser'))).toBe(true)
  }, 600_000)
})
