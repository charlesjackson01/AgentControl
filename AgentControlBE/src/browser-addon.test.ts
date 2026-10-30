import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from './app.js'
import { createBotEnvService } from './bot-env.js'
import { botMounts, storeSaveVm } from './bot-env-routes.js'
import { err, fakeEngine, ok } from './bot-env.fake.js'
import {
  BROWSER_DOWNLOAD_BYTES,
  BROWSER_INTERNET_NEVER_TEXT,
  checkCause,
  createBrowserAddon,
  downloadCause,
  freeGbText,
  lowDiskProblem,
  NOTHING_TO_RETRY_TEXT,
  type BrowserAddonDeps,
  type ChromiumCheck,
} from './browser-addon.js'
import type { CommandResult, CommandRunner } from './command-runner.js'
import { buildStoppedText, LOW_DISK_TEXT, RUN_FREE_FLOOR_BYTES } from './run-service.js'
import type { Agent, BrowserAddonInfo, LiveEvent, PermissionRequest, ScriptRun, VmHostInfo, VmInfo } from './shared/types.js'
import { createStore } from './store.js'
import { defaultAgentVm } from './vm-defaults.js'
import type { VmHostService } from './vm-host.js'
import { baseImageFor, botImageRef, sharedImageRef } from './vm-images.js'

const GB = 1024 ** 3
const until = async (f: () => boolean, ms = 3000) => {
  const t0 = Date.now()
  while (!f()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('BE-P2-15 texts', () => {
  it('low disk: download size, plus the run floor, or only the floor when reused (GB rounded down)', () => {
    expect(freeGbText(0.69 * GB)).toBe('0.6 GB')
    expect(lowDiskProblem(0.6 * GB, false)?.message).toBe('The download needs about 1.3 GB and this computer has 0.6 GB free. Free some space, then try again.')
    expect(lowDiskProblem(3.5 * GB, false)?.message).toBe('The download needs about 1.3 GB, plus 3 GB kept free for runs, and this computer has 3.5 GB free.')
    expect(lowDiskProblem(3.5 * GB, false)).toMatchObject({ neededBytes: BROWSER_DOWNLOAD_BYTES + RUN_FREE_FLOOR_BYTES, freeBytes: 3.5 * GB })
    expect(lowDiskProblem(10 * GB, false)).toBeNull()
    expect(lowDiskProblem(3.5 * GB, true)).toBeNull()
    expect(lowDiskProblem(2 * GB, true)?.message).toBe(LOW_DISK_TEXT)
    expect(lowDiskProblem(null, false)).toBeNull()
  })
  it('download and check causes', () => {
    expect(downloadCause({ code: 1, stdout: '', stderr: 'curl: (56) Recv failure: Connection reset by peer' })).toMatchObject({ cause: 'connection reset' })
    expect(downloadCause({ code: 124, stdout: '', stderr: '' }).cause).toBe('timed out')
    expect(downloadCause({ code: 1, stdout: '', stderr: 'write /var: no space left on device' }).cause).toBe('out of disk space')
    expect(checkCause('error while loading shared libraries: libnss3.so: cannot open shared object file: No such file')).toEqual({ cause: 'missing shared library', detail: 'libnss3.so missing' })
  })
})

// ---------- the add-on with fake deps ----------
function agentOf(over: Partial<Agent> = {}): Agent {
  return {
    id: 'agt_1', name: 'Analyst', slug: 'analyst', description: '', instructions: '', modelId: 'm', endpointId: 'e', isPrimary: false, role: '',
    skillIds: [], internetPolicy: 'ask', memoryLearn: true, vm: defaultAgentVm(), status: 'idle', createdAt: '', lastRunAt: null, runCount: 0,
    ...over,
  } as Agent
}

function harness(o: { present?: boolean; buildResult?: CommandResult; free?: number | null; check?: ChromiumCheck; buildEnd?: Partial<ScriptRun>; dir?: string } = {}) {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), 'agentcontrol-be15-'))
  let present = o.present ?? false
  const agents: Agent[] = [agentOf()]
  const events: LiveEvent[] = []
  const calls: string[][] = []
  const builds: { base: string; id: string }[] = []
  const stopped: string[] = []
  const gate = { ready: [] as string[], failed: [] as [string, string][], setups: [] as unknown[] }
  let busy = 0
  let release: ((r: ScriptRun) => void) | null = null
  const hold = { build: false }
  const exec: CommandRunner = async (_cmd, args, opts) => {
    calls.push([...args])
    if (args[0] === 'image' && args[1] === 'inspect') return present ? ok('sha256:x') : err('image not known')
    if (args[0] === 'build') {
      opts?.onOutput?.('stdout', 'STEP 1/4: FROM x\nSTEP 2/4: RUN y\n')
      const r = o.buildResult ?? ok('STEP 4/4: COMMIT\n')
      if (r.code === 0) present = true
      return r
    }
    if (args[0] === 'rmi') {
      present = false
      return ok()
    }
    return err('unexpected')
  }
  const deps: BrowserAddonDeps = {
    dataDir: () => dir,
    getAgent: (id) => agents.find((a) => a.id === id),
    agents: () => agents,
    saveBrowser: (id, on) => {
      const a = agents.find((x) => x.id === id)!
      a.vm = { ...a.vm, permissions: { ...a.vm.permissions, browser: on } }
    },
    engine: async () => ({ cli: 'podman', globalArgs: [] }),
    exec,
    freeBytes: async () => (o.free === undefined ? 100 * GB : o.free),
    startBuild: async (agent, base) => {
      const id = `run_${builds.length + 1}`
      builds.push({ base, id })
      return { id, agentId: agent.id, status: 'running' } as ScriptRun
    },
    waitRun: async (runId) => {
      if (stopped.includes(runId)) return { id: runId, status: 'stopped', error: buildStoppedText('Analyst', 0) } as ScriptRun
      if (hold.build) return new Promise<ScriptRun>((r) => (release = r))
      const b = builds.find((x) => x.id === runId)
      const end = { id: runId, status: 'succeeded', ...o.buildEnd } as ScriptRun
      if (end.status === 'succeeded' && b) {
        const a = agents[0]!
        a.vm = { ...a.vm, image: { ...a.vm.image, generation: a.vm.image.generation + 1, base: b.base as 'base' | 'browser' } }
      }
      return end
    },
    stopRun: async (runId) => {
      stopped.push(runId)
      release?.({ id: runId, status: 'stopped', error: buildStoppedText('Analyst', 0) } as ScriptRun)
    },
    activeBuildRunId: () => null,
    busy: () => busy,
    recreate: async () => {},
    chromiumCheck: async () => o.check ?? { ok: true, version: '131.0.6778.33' },
    gate: {
      browserReady: async (id) => void gate.ready.push(id),
      browserFailed: (id, reason) => void gate.failed.push([id, reason]),
      updateSetup: (rid, setup, e) => void gate.setups.push({ rid, setup, e }),
    },
    publish: (e) => void events.push(e),
    vmChanged: () => {},
    idlePollMs: 5,
    tickMs: 5,
  }
  const addon = createBrowserAddon(deps)
  return {
    addon, agents, events, calls, builds, stopped, gate, hold, dir, release: (r: ScriptRun) => release?.(r),
    setBusy: (n: number) => (busy = n),
    setPresent: (v: boolean) => (present = v),
    setBuild: (r: CommandResult) => (o.buildResult = r),
    setFree: (n: number | null | undefined) => (o.free = n),
    cleanup: () => { addon.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

describe('createBrowserAddon', () => {
  let h: ReturnType<typeof harness>
  afterEach(() => h?.cleanup())

  it('turn on: download (shared build of botvm-browser), tool build onto the browser base, check → ready; the gate releases the runs', async () => {
    h = harness()
    h.agents[0]!.vm.permissions.browser = true
    h.addon.changed('agt_1', true)
    expect(h.addon.status('agt_1')).toEqual({ state: 'pending' })
    await h.addon.idle()
    const info = h.addon.botInfo('agt_1')!
    expect(info).toMatchObject({
      state: 'ready',
      chromium: { version: '131.0.6778.33' },
      setup: { turnedOnBy: 'user', download: { totalBytes: BROWSER_DOWNLOAD_BYTES, bytes: BROWSER_DOWNLOAD_BYTES }, rebuild: { runId: 'run_1' }, check: { status: 'pass' } },
    })
    expect(info.setup!.download.startedAt).toBeTruthy()
    expect(info.setup!.readyAt).toBeTruthy()
    expect(h.builds).toEqual([{ base: 'browser', id: 'run_1' }])
    expect(h.calls.find((c) => c[0] === 'build')).toEqual(expect.arrayContaining(['--tag', sharedImageRef('botvm-browser')]))
    expect(h.gate.ready).toEqual(['agt_1'])
    expect(h.addon.status('agt_1')).toEqual({ state: 'ready' })
    const last = h.events.filter((e) => e.type === 'browser.updated').pop() as { browser: BrowserAddonInfo }
    expect(last.browser).toMatchObject({ state: 'ready', usedBy: ['agt_1'], totalBytes: BROWSER_DOWNLOAD_BYTES })
    expect(await h.addon.info()).toMatchObject({ state: 'ready', usedBy: ['agt_1'] })
    expect(h.addon.sharedState()).toEqual({ state: 'ready' })
  })

  it('download already there: reused, no download', async () => {
    h = harness({ present: true })
    h.agents[0]!.vm.permissions.browser = true
    h.addon.changed('agt_1', true)
    await h.addon.idle()
    expect(h.addon.botInfo('agt_1')).toMatchObject({ state: 'ready', setup: { download: { reused: true } } })
    expect(h.calls.some((c) => c[0] === 'build')).toBe(false)
  })

  it('download fails: download_failed (MB + cause), browser_unavailable; retry {} downloads again and the bot carries on', async () => {
    h = harness({ buildResult: { code: 1, stdout: '', stderr: 'curl: (56) Recv failure: Connection reset by peer' } })
    h.agents[0]!.vm.permissions.browser = true
    h.addon.changed('agt_1', true)
    await h.addon.idle()
    const info = h.addon.botInfo('agt_1')!
    expect(info.state).toBe('error')
    expect(info.error).toMatchObject({ reason: 'download_failed', cause: 'connection reset' })
    expect(info.error!.message).toMatch(/^The Chromium download stopped at \d+ MB \(connection reset\)\.$/)
    expect(h.gate.failed).toEqual([['agt_1', 'browser_unavailable']])
    expect(h.addon.status('agt_1')).toEqual({ state: 'failed', reason: 'browser_unavailable' })
    expect((await h.addon.info())).toMatchObject({ state: 'error', error: { reason: 'download_failed' } })
    // Retry {} with the network back: one more download, and the bot carries on to ready.
    h.setBuild(ok('STEP 4/4: COMMIT\n'))
    const r = await h.addon.retry()
    expect(r.state).toBe('downloading')
    expect(r).not.toHaveProperty('error')
    await h.addon.idle()
    expect(h.calls.filter((c) => c[0] === 'build')).toHaveLength(2)
    expect(h.addon.botInfo('agt_1')?.state).toBe('ready')
    expect(h.gate.ready).toEqual(['agt_1'])
    await expect(h.addon.retry()).rejects.toMatchObject({ reason: 'nothing_to_retry' })
  })

  it('retry {agentId} after a failed download: the reply is the fresh state (downloading), never the stale error', async () => {
    h = harness({ buildResult: { code: 1, stdout: '', stderr: 'curl: (56) Recv failure: Connection reset by peer' } })
    h.agents[0]!.vm.permissions.browser = true
    h.addon.changed('agt_1', true)
    await h.addon.idle()
    expect(await h.addon.info()).toMatchObject({ state: 'error', error: { reason: 'download_failed' } })
    h.setBuild(ok('STEP 4/4: COMMIT\n'))
    const r = await h.addon.retry('agt_1')
    expect(r.state).toBe('downloading')
    expect(r).not.toHaveProperty('error')
    expect(r).toMatchObject({ totalBytes: BROWSER_DOWNLOAD_BYTES, usedBy: ['agt_1'] })
    expect(Object.keys(r).sort()).toEqual(expect.arrayContaining(['state', 'totalBytes', 'usedBy']))
    expect(h.addon.botInfo('agt_1')).toMatchObject({ state: 'setting_up', setup: { download: { totalBytes: BROWSER_DOWNLOAD_BYTES } } })
    expect(h.addon.botInfo('agt_1')).not.toHaveProperty('error')
    await h.addon.idle()
    // One more download (shared with the setup, not two), then the bot carries on to ready.
    expect(h.calls.filter((c) => c[0] === 'build')).toHaveLength(2)
    expect(h.addon.botInfo('agt_1')).toMatchObject({ state: 'ready', setup: { download: { bytes: BROWSER_DOWNLOAD_BYTES } } })
    expect(h.addon.botInfo('agt_1')!.setup!.download.endedAt).toBeTruthy()
    expect(await h.addon.info()).toMatchObject({ state: 'ready', usedBy: ['agt_1'] })
  })

  it('retry {agentId} that fails the disk check answers 409 low_disk and starts no download', async () => {
    h = harness({ buildResult: { code: 1, stdout: '', stderr: 'curl: (56) Recv failure: Connection reset by peer' } })
    h.agents[0]!.vm.permissions.browser = true
    h.addon.changed('agt_1', true)
    await h.addon.idle()
    const builds = h.calls.filter((c) => c[0] === 'build').length
    h.setFree(0.6 * GB)
    await expect(h.addon.retry('agt_1')).rejects.toMatchObject({ statusCode: 409, reason: 'low_disk' })
    expect(h.calls.filter((c) => c[0] === 'build')).toHaveLength(builds)
    expect(await h.addon.info()).toMatchObject({ state: 'error' })
  })

  it('retry {}: 409 nothing_to_retry without a failed download; {agentId} unknown → 404', async () => {
    h = harness()
    await expect(h.addon.retry()).rejects.toMatchObject({ statusCode: 409, reason: 'nothing_to_retry', message: NOTHING_TO_RETRY_TEXT })
    await expect(h.addon.retry('agt_nope')).rejects.toMatchObject({ statusCode: 404 })
    await expect(h.addon.retry('agt_1')).rejects.toMatchObject({ statusCode: 409, reason: 'nothing_to_retry' })
  })

  it('build stopped: build_failed with the stopped text; the bot keeps its tools', async () => {
    h = harness({ present: true, buildEnd: { status: 'stopped', error: buildStoppedText('Analyst', 0) } })
    h.agents[0]!.vm.permissions.browser = true
    h.addon.changed('agt_1', true)
    await h.addon.idle()
    expect(h.addon.botInfo('agt_1')).toMatchObject({ state: 'error', error: { reason: 'build_failed', message: 'Stopped. Analyst keeps its current tools (version 0).' } })
    expect(h.gate.failed).toEqual([['agt_1', 'browser_unavailable']])
    expect(h.agents[0]!.vm.image).toMatchObject({ generation: 0, base: 'base' })
  })

  it('chromium check fails: chromium_check_failed with cause + detail; retry {agentId} re-checks', async () => {
    h = harness({ present: true, check: { ok: false, error: 'error while loading shared libraries: libnss3.so: cannot open shared object file' } })
    h.agents[0]!.vm.permissions.browser = true
    h.addon.changed('agt_1', true)
    await h.addon.idle()
    expect(h.addon.botInfo('agt_1')).toMatchObject({
      state: 'error',
      error: { reason: 'chromium_check_failed', message: "Chromium was installed but didn't start (missing shared library).", cause: 'missing shared library', detail: 'libnss3.so missing' },
      setup: { check: { status: 'fail' } },
    })
    expect(h.gate.failed).toEqual([['agt_1', 'chromium_check_failed']])
    expect(h.addon.status('agt_1')).toEqual({ state: 'failed', reason: 'chromium_check_failed' })
    const r = await h.addon.retry('agt_1')
    expect(r).toMatchObject({ state: 'ready', usedBy: ['agt_1'] })
    expect(h.addon.botInfo('agt_1')?.state).toBe('setting_up')
    await h.addon.idle()
    // The image is already on the browser base: no second build, only the check again.
    expect(h.builds).toHaveLength(1)
    expect(h.addon.botInfo('agt_1')?.state).toBe('error')
  })

  it('waiting_idle until the current run ends, then the check', async () => {
    h = harness({ present: true })
    h.setBusy(1)
    h.agents[0]!.vm.permissions.browser = true
    h.addon.changed('agt_1', true)
    await until(() => h.addon.botInfo('agt_1')?.state === 'waiting_idle')
    expect(h.gate.ready).toEqual([])
    h.setBusy(0)
    await h.addon.idle()
    expect(h.addon.botInfo('agt_1')?.state).toBe('ready')
  })

  it('low disk at setup (card enable): low_disk error with needed/free', async () => {
    h = harness({ free: 0.6 * GB })
    h.addon.enable('agt_1', { id: 'perm_1', runId: 'run_9', agentId: 'agt_1', type: 'browser' } as PermissionRequest)
    await h.addon.idle()
    expect(h.agents[0]!.vm.permissions.browser).toBe(true)
    expect(h.addon.botInfo('agt_1')).toMatchObject({ state: 'error', error: { reason: 'low_disk', freeBytes: 0.6 * GB }, setup: { requestId: 'perm_1', runId: 'run_9' } })
    expect(h.gate.failed).toEqual([['agt_1', 'browser_unavailable']])
    expect(h.gate.setups.length).toBeGreaterThan(0)
  })

  it('card enable under Never with packages: build_failed with the internet_never text (no build)', async () => {
    h = harness({ present: true })
    h.agents[0]!.internetPolicy = 'never'
    h.agents[0]!.vm = { ...h.agents[0]!.vm, packages: ['jq'] }
    h.addon.enable('agt_1', { id: 'perm_1', agentId: 'agt_1', type: 'browser' } as PermissionRequest)
    await h.addon.idle()
    expect(h.addon.botInfo('agt_1')).toMatchObject({ state: 'error', error: { reason: 'build_failed', message: BROWSER_INTERNET_NEVER_TEXT } })
    expect(h.builds).toHaveLength(0)
  })

  it('checkChange: 409 internet_never (Never + packages, on and off) and 409 low_disk', async () => {
    h = harness({ free: 3.5 * GB })
    const a = agentOf({ internetPolicy: 'never', vm: { ...defaultAgentVm(), packages: ['jq'] } })
    await expect(h.addon.checkChange(a, true)).rejects.toMatchObject({ statusCode: 409, reason: 'internet_never', message: BROWSER_INTERNET_NEVER_TEXT })
    const on = agentOf({ internetPolicy: 'never', vm: { ...defaultAgentVm(), packages: ['jq'], permissions: { browser: true } } })
    await expect(h.addon.checkChange(on, false)).rejects.toMatchObject({ statusCode: 409, reason: 'internet_never' })
    await expect(h.addon.checkChange(agentOf(), true)).rejects.toMatchObject({
      statusCode: 409, reason: 'low_disk', message: 'The download needs about 1.3 GB, plus 3 GB kept free for runs, and this computer has 3.5 GB free.',
    })
    // Already downloaded: only the 3 GB floor.
    h.setPresent(true)
    await expect(h.addon.checkChange(agentOf(), true)).resolves.toBeUndefined()
    // Never without packages is fine (the build is offline).
    await expect(h.addon.checkChange(agentOf({ internetPolicy: 'never' }), true)).resolves.toBeUndefined()
  })

  it('turn off during the setup cancels it (the build is stopped); turn off when ready rebuilds onto the base when idle', async () => {
    h = harness({ present: true })
    h.hold.build = true
    h.agents[0]!.vm.permissions.browser = true
    h.addon.changed('agt_1', true)
    await until(() => h.addon.botInfo('agt_1')?.state === 'rebuilding' && h.builds.length === 1)
    await new Promise((r) => setTimeout(r, 10))
    h.agents[0]!.vm.permissions.browser = false
    h.hold.build = false
    h.addon.changed('agt_1', false)
    await h.addon.idle()
    expect(h.stopped).toEqual(['run_1'])
    expect(h.addon.botInfo('agt_1')?.state).toBe('off')
    expect(h.agents[0]!.vm.image.base).toBe('base')
    expect(h.gate.ready).toEqual([])

    // On again (ready), then off: one rebuild onto 'base'.
    h.agents[0]!.vm.permissions.browser = true
    h.addon.changed('agt_1', true)
    await h.addon.idle()
    expect(h.agents[0]!.vm.image.base).toBe('browser')
    h.setBusy(1)
    h.agents[0]!.vm.permissions.browser = false
    h.addon.changed('agt_1', false)
    await new Promise((r) => setTimeout(r, 30))
    expect((await h.addon.info()).usedBy).toEqual(['agt_1'])
    h.setBusy(0)
    await h.addon.idle()
    expect(h.builds.map((b) => b.base)).toEqual(['browser', 'browser', 'base'])
    expect(h.agents[0]!.vm.image.base).toBe('base')
    expect((await h.addon.info()).usedBy).toEqual([])
  })

  it('remove: 409 browser_in_use (names) while a bot uses it, browser_busy while downloading, then absent', async () => {
    h = harness({ present: true })
    h.agents[0]!.vm.permissions.browser = true
    await expect(h.addon.remove()).rejects.toMatchObject({ statusCode: 409, reason: 'browser_in_use', message: 'Turn off the browser for every bot first (used by Analyst).' })
    h.agents[0]!.vm.permissions.browser = false
    expect(await h.addon.remove()).toMatchObject({ state: 'absent', usedBy: [] })
    expect(h.calls.some((c) => c[0] === 'rmi' && c[1] === sharedImageRef('botvm-browser'))).toBe(true)
  })

  it('a restart resumes an interrupted setup (state.json); a deleted bot is forgotten', async () => {
    const h1 = harness({ present: true })
    h1.hold.build = true
    h1.agents[0]!.vm.permissions.browser = true
    h1.addon.changed('agt_1', true)
    await until(() => h1.builds.length === 1)
    h1.addon.close()
    h = harness({ present: true, dir: h1.dir })
    h.agents[0]!.vm.permissions.browser = true
    expect(h.addon.botInfo('agt_1')?.state).toBe('rebuilding')
    h.addon.recover()
    await h.addon.idle()
    expect(h.addon.botInfo('agt_1')?.state).toBe('ready')
    h.addon.agentDeleted('agt_1')
    expect(h.addon.botInfo('agt_1')).toBeUndefined()
  })
})


// ---------- the routes, through buildApp with the fake engine ----------
describe('BE-P2-15 routes', () => {
  let dir = ''
  let store: ReturnType<typeof createStore>
  let app: ReturnType<typeof buildApp>
  let engine: ReturnType<typeof fakeEngine>
  let free: number | null = 100 * GB
  let downloadFails = false
  const host: VmHostInfo = {
    engine: 'podman', version: '5.4.0', provider: 'native', os: 'linux', machine: null,
    storage: { driver: 'overlay', backend: 'local', volumeState: 'ok' }, concurrency: 2, setupSteps: [],
  }
  beforeEach(() => {
    vi.stubEnv('AGENTCONTROL_SECRET', 'be15-test-secret')
    vi.stubEnv('AGENTCONTROL_AUTH_TOKEN', '')
    dir = mkdtempSync(join(tmpdir(), 'agentcontrol-be15r-'))
    store = createStore(join(dir, 'store.json'))
    engine = fakeEngine()
    free = 100 * GB
    downloadFails = false
    const vmHost: VmHostService = { hostInfo: async () => host, ensureMachine: async () => host, grow: async () => host }
    const botEnv = createBotEnvService({
      exec: engine.exec,
      engine: async () => ({ cli: 'podman', globalArgs: [] }),
      mounts: (a) => botMounts(store, a),
      saveVm: storeSaveVm(store),
      activeRuns: () => 0,
    })
    // The add-on's own calls: the shared build of botvm-browser and the Chromium check; the rest is the fake engine.
    const browserExec: CommandRunner = async (cmd, args, opts) => {
      if (args[0] === 'build' && args.includes(sharedImageRef('botvm-browser'))) {
        opts?.onOutput?.('stdout', 'STEP 1/3: FROM x\nSTEP 2/3: RUN npx playwright install chromium\n')
        if (downloadFails) return err('curl: (56) Recv failure: Connection reset by peer', 1)
        engine.images.set(sharedImageRef('botvm-browser'), { id: 'b'.repeat(64), labels: {} })
        engine.images.set(baseImageFor('browser'), { id: 'b'.repeat(64), labels: {} })
        return ok('STEP 3/3: COMMIT\n')
      }
      if (args[0] === 'image' && args[1] === 'inspect' && args[2] === '--format') {
        const img = engine.images.get(args[args.length - 1]!)
        if (!img) return err('Error: image not known')
        const label = /index \.Labels "([^"]+)"/.exec(args[3]!)
        return ok(label ? (img.labels[label[1]!] ?? '') : img.id)
      }
      if (args[0] === 'run' && args.some((x) => x.startsWith('ac-probe-chromium-'))) {
        return ok('AC_CHROMIUM {"png": true, "bytes": 1234, "version": "131.0.6778.33"}\n')
      }
      return engine.exec(cmd, args, opts)
    }
    app = buildApp(store, {
      vmHost, botEnv, browserExec, browserIdlePollMs: 5, vmFreeBytes: () => free,
      runtimeProbe: { current: () => null, refresh: async () => null as never, ensureFresh: async () => null as never, restore: async () => null, startTimer: () => () => {} },
    })
  })
  afterEach(async () => {
    await app.vmBrowser.idle()
    await app.close()
    vi.unstubAllEnvs()
    rmSync(dir, { recursive: true, force: true })
  })
  const inject = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, headers?: Record<string, string>) =>
    app.inject({ method, url, payload: payload as object | undefined, ...(headers ? { headers } : {}) })
  async function makeAgent(extra: Record<string, unknown> = {}) {
    const res = await inject('POST', '/api/agents', { name: 'Analyst', endpointId: 'ep_local_llama', modelId: 'llama-3-8b', ...extra })
    return res
  }
  const stored = (id: string) => store.agents.find((a) => a.id === id)!

  it('GET /api/vm/browser: absent, 1.3 GB, nobody', async () => {
    const res = await inject('GET', '/api/vm/browser')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ state: 'absent', totalBytes: BROWSER_DOWNLOAD_BYTES, usedBy: [] })
  })

  it('DELETE needs the confirm header (403); retry: 409 nothing_to_retry, 404 for an unknown bot, 400 for a bad body', async () => {
    const del = await inject('DELETE', '/api/vm/browser')
    expect(del.statusCode).toBe(403)
    expect(del.json()).toMatchObject({ reason: 'confirm_required' })
    expect((await inject('DELETE', '/api/vm/browser', undefined, { 'x-agentcontrol-confirm': '1' })).json()).toMatchObject({ state: 'absent' })
    const r = await inject('POST', '/api/vm/browser/retry', {})
    expect(r.statusCode).toBe(409)
    expect(r.json()).toMatchObject({ reason: 'nothing_to_retry', message: NOTHING_TO_RETRY_TEXT })
    expect((await inject('POST', '/api/vm/browser/retry', { agentId: 'agt_nope' })).statusCode).toBe(404)
    expect((await inject('POST', '/api/vm/browser/retry', { agentId: 5 })).statusCode).toBe(400)
  })

  it('PATCH permissions.browser:true with low disk: 409 low_disk, nothing saved; a non-boolean is 400', async () => {
    const a = (await makeAgent()).json() as Agent
    free = 3.5 * GB
    const res = await inject('PATCH', `/api/agents/${a.id}/vm`, { permissions: { browser: true } })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ reason: 'low_disk', message: 'The download needs about 1.3 GB, plus 3 GB kept free for runs, and this computer has 3.5 GB free.' })
    expect(stored(a.id).vm.permissions.browser).toBe(false)
    expect((await inject('PATCH', `/api/agents/${a.id}/vm`, { permissions: { browser: 'yes' } })).statusCode).toBe(400)
  })

  it('PATCH browser:true under Never with packages: 409 internet_never', async () => {
    const a = (await makeAgent()).json() as Agent
    store.agents = store.agents.map((x) => (x.id === a.id ? { ...x, internetPolicy: 'never', vm: { ...x.vm, packages: ['jq'] } } : x))
    const res = await inject('PATCH', `/api/agents/${a.id}/vm`, { permissions: { browser: true } })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ reason: 'internet_never', message: BROWSER_INTERNET_NEVER_TEXT })
  })

  it('POST /api/agents browser:true with low disk: 409 and no bot; browser:"x" is 400', async () => {
    free = 0.6 * GB
    const res = await makeAgent({ browser: true })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ reason: 'low_disk' })
    expect(store.agents.filter((x) => x.name === 'Analyst')).toHaveLength(0)
    expect((await makeAgent({ browser: 'x' })).statusCode).toBe(400)
    expect(store.agents.filter((x) => x.name === 'Analyst')).toHaveLength(0)
  })

  it('turn on (PATCH): download, tool_build via browser onto the browser base, check → ready; off rebuilds onto the base; then DELETE', async () => {
    const a = (await makeAgent()).json() as Agent
    const on = await inject('PATCH', `/api/agents/${a.id}/vm`, { permissions: { browser: true } })
    expect(on.statusCode).toBe(200)
    await app.vmBrowser.idle()
    const vm = (await inject('GET', `/api/agents/${a.id}/vm`)).json() as VmInfo
    expect(vm.permissions).toMatchObject({ browser: true, browserState: 'ready' })
    expect(vm.browser).toMatchObject({ state: 'ready', chromium: { version: '131.0.6778.33' }, setup: { check: { status: 'pass' } } })
    expect(stored(a.id).vm.image).toMatchObject({ generation: 1, base: 'browser' })
    const build = (await inject('GET', `/api/runs/${vm.browser!.setup!.rebuild.runId}`)).json() as ScriptRun
    expect(build).toMatchObject({ kind: 'tool_build', status: 'succeeded', build: { via: 'browser', base: 'browser' } })
    expect((await inject('GET', '/api/vm/browser')).json()).toMatchObject({ state: 'ready', usedBy: [a.id] })
    // In use: DELETE refuses with the names.
    const busy = await inject('DELETE', '/api/vm/browser', undefined, { 'x-agentcontrol-confirm': '1' })
    expect(busy.statusCode).toBe(409)
    expect(busy.json()).toMatchObject({ reason: 'browser_in_use', message: 'Turn off the browser for every bot first (used by Analyst).' })
    // Off: back onto the base (generation 2).
    expect((await inject('PATCH', `/api/agents/${a.id}/vm`, { permissions: { browser: false } })).statusCode).toBe(200)
    await app.vmBrowser.idle()
    expect(stored(a.id).vm.image).toMatchObject({ generation: 2, base: 'base' })
    expect((await inject('GET', `/api/agents/${a.id}/vm`)).json()).toMatchObject({ permissions: { browser: false }, browser: { state: 'off' } })
    // Generation 1 (on the browser base) goes with the download.
    const del = await inject('DELETE', '/api/vm/browser', undefined, { 'x-agentcontrol-confirm': '1' })
    expect(del.statusCode).toBe(200)
    expect(del.json()).toMatchObject({ state: 'absent', usedBy: [] })
    expect(engine.images.has(sharedImageRef('botvm-browser'))).toBe(false)
    expect(stored(a.id).vm.image.previous).toBe(1)
    expect(engine.images.has(botImageRef(stored(a.id).slug, 1))).toBe(false)
    expect(engine.images.has(botImageRef(stored(a.id).slug, 2))).toBe(true)
  })

  it('POST /api/agents browser:true starts the setup; a failed download shows on GET and retry {} recovers', async () => {
    downloadFails = true
    const res = await makeAgent({ browser: true })
    expect(res.statusCode).toBe(201)
    const a = res.json() as Agent
    expect(stored(a.id).vm.permissions.browser).toBe(true)
    await app.vmBrowser.idle()
    expect((await inject('GET', '/api/vm/browser')).json()).toMatchObject({ state: 'error', error: { reason: 'download_failed', cause: 'connection reset' } })
    expect((await inject('GET', `/api/agents/${a.id}/vm`)).json()).toMatchObject({ browser: { state: 'error', error: { reason: 'download_failed' } } })
    downloadFails = false
    const retry = await inject('POST', '/api/vm/browser/retry', {})
    expect(retry.statusCode).toBe(200)
    // The reply is the fresh state, not the failed snapshot from before the retry.
    expect(retry.json()).toMatchObject({ state: 'downloading', totalBytes: BROWSER_DOWNLOAD_BYTES, usedBy: [a.id] })
    expect(retry.json()).not.toHaveProperty('error')
    await app.vmBrowser.idle()
    expect((await inject('GET', `/api/agents/${a.id}/vm`)).json()).toMatchObject({ permissions: { browserState: 'ready' }, browser: { state: 'ready' } })
  })

  it('POST /api/vm/browser/retry {agentId} after a failed download: 200 with the fresh state (downloading), never the stale error', async () => {
    downloadFails = true
    const a = (await makeAgent({ browser: true })).json() as Agent
    await app.vmBrowser.idle()
    expect((await inject('GET', '/api/vm/browser')).json()).toMatchObject({ state: 'error', error: { reason: 'download_failed' } })
    downloadFails = false
    const retry = await inject('POST', '/api/vm/browser/retry', { agentId: a.id })
    expect(retry.statusCode).toBe(200)
    const body = retry.json() as BrowserAddonInfo
    expect(body).toMatchObject({ state: 'downloading', totalBytes: BROWSER_DOWNLOAD_BYTES, usedBy: [a.id] })
    expect(body).not.toHaveProperty('error')
    expect(body.state).not.toBe('error')
    // The bot ends ready (the fake download can finish before the GET, so no setting_up check here).
    await app.vmBrowser.idle()
    expect((await inject('GET', '/api/vm/browser')).json()).toMatchObject({ state: 'ready', usedBy: [a.id] })
    expect((await inject('GET', `/api/agents/${a.id}/vm`)).json()).toMatchObject({ permissions: { browserState: 'ready' }, browser: { state: 'ready' } })
    expect(engine.images.has(sharedImageRef('botvm-browser'))).toBe(true)
    // Nothing left to retry: the error answers are unchanged.
    const again = await inject('POST', '/api/vm/browser/retry', { agentId: a.id })
    expect(again.statusCode).toBe(409)
    expect(again.json()).toMatchObject({ reason: 'nothing_to_retry', message: NOTHING_TO_RETRY_TEXT })
  })
})
