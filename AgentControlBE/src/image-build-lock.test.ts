/**
 * BE-P2-19: the bot-images setup step (VmHostService.buildBotImages) and the browser add-on's own
 * botvm-browser download take turns on one ImageBuildLock: never two image builds at once, in
 * either order. A fake engine (one image store shared by both, builds held until released) and a
 * fake clock (each build takes 10 ticks of it) only.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createBrowserAddon, type BrowserAddonDeps } from './browser-addon.js'
import type { CommandResult, CommandRunner } from './command-runner.js'
import { createImageBuildLock } from './image-build-lock.js'
import type { Agent, ScriptRun } from './shared/types.js'
import { defaultAgentVm } from './vm-defaults.js'
import { BOT_IMAGES_STEP_ID, botImagesBuildingText, createVmHostService } from './vm-host.js'
import { imageBuildArgv, sharedImageRef } from './vm-images.js'

const GIB = 1024 ** 3
const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' })
const no = (stderr = ''): CommandResult => ({ code: 1, stdout: '', stderr })
const BOTVM = sharedImageRef('botvm')
const BROWSER = sharedImageRef('botvm-browser')
const until = async (f: () => boolean, ms = 3000) => {
  const t0 = Date.now()
  while (!f()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 2))
  }
}

/** One image store for both; `podman build` is held until release(ref); the clock moves 10 per build. */
function fakeEngine(have: string[] = []) {
  const images = new Set(have)
  let clock = 0
  let active = 0
  let maxActive = 0
  const log: string[] = []
  const spans: { ref: string; from: number; to: number }[] = []
  const held = new Map<string, () => void>()
  const exec: CommandRunner = async (_cmd, args) => {
    const a = [...args]
    if (a[0] === '--version') return ok('podman version 5.4.0\n')
    if (a[0] === 'info') return ok(JSON.stringify({ host: { security: { rootless: true } }, store: { graphDriverName: 'overlay' } }))
    if (a[0] === 'image' && a[1] === 'exists') return images.has(a[2]!) ? ok() : no()
    if (a[0] === 'image' && a[1] === 'inspect') return images.has(a.at(-1)!) ? ok('sha256:x') : no('image not known')
    if (a[0] === 'image' && a[1] === 'ls') return ok('')
    if (a[0] === 'build') {
      const ref = a[a.indexOf('--tag') + 1]!
      active += 1
      maxActive = Math.max(maxActive, active)
      const from = clock
      log.push(`start ${ref}`)
      await new Promise<void>((r) => held.set(ref, r))
      clock += 10
      images.add(ref)
      active -= 1
      spans.push({ ref, from, to: clock })
      log.push(`end ${ref}`)
      return ok('STEP 4/4: COMMIT\n')
    }
    return no(`unexpected ${a.join(' ')}`)
  }
  return {
    exec, images, log, spans,
    max: () => maxActive,
    holding: (ref: string) => held.has(ref),
    release: async (ref: string) => {
      await until(() => held.has(ref))
      const r = held.get(ref)!
      held.delete(ref)
      r()
    },
  }
}

function hostOf(eng: ReturnType<typeof fakeEngine>, lock: ReturnType<typeof createImageBuildLock>) {
  return createVmHostService({
    exec: eng.exec,
    platform: 'linux',
    totalMemBytes: () => 16 * GIB,
    freeBytes: async () => 500 * GIB,
    hostDiskPath: () => '/fake/home',
    cacheMs: 0,
    imageLock: lock,
    botImages: {
      images: () => [{ kind: 'botvm', ref: BOTVM }, { kind: 'botvm-browser', ref: BROWSER }],
      buildArgv: (kind) => imageBuildArgv(kind),
    },
  })
}

function addonOf(eng: ReturnType<typeof fakeEngine>, lock: ReturnType<typeof createImageBuildLock>, dir: string) {
  const agent = {
    id: 'agt_1', name: 'Analyst', slug: 'analyst', description: '', instructions: '', modelId: 'm', endpointId: 'e', isPrimary: false, role: '',
    skillIds: [], internetPolicy: 'ask', memoryLearn: true, vm: defaultAgentVm(), status: 'idle', createdAt: '', lastRunAt: null, runCount: 0,
  } as unknown as Agent
  agent.vm.permissions.browser = true
  const deps: BrowserAddonDeps = {
    dataDir: () => dir,
    getAgent: (id) => (id === agent.id ? agent : undefined),
    agents: () => [agent],
    saveBrowser: () => {},
    engine: async () => ({ cli: 'podman', globalArgs: [] }),
    exec: eng.exec,
    freeBytes: async () => 100 * GIB,
    startBuild: async (a) => ({ id: 'run_1', agentId: a.id, status: 'running' }) as ScriptRun,
    waitRun: async (id) => ({ id, status: 'succeeded' }) as ScriptRun,
    stopRun: async () => {},
    activeBuildRunId: () => null,
    busy: () => 0,
    recreate: async () => {},
    chromiumCheck: async () => ({ ok: true, version: '131.0.6778.33' }),
    publish: () => {},
    vmChanged: () => {},
    imageLock: lock,
    idlePollMs: 2,
    tickMs: 5,
  }
  return createBrowserAddon(deps)
}

const disjoint = (spans: { from: number; to: number }[]) =>
  [...spans].sort((a, b) => a.from - b.from).every((s, i, all) => i === 0 || all[i - 1]!.to <= s.from)

describe('createImageBuildLock', () => {
  it('runs holders one at a time in arrival order; later ones see waited, a throw still releases', async () => {
    const lock = createImageBuildLock()
    const order: string[] = []
    let openA!: () => void
    const a = lock.run(async (waited) => {
      order.push(`a ${waited}`)
      await new Promise<void>((r) => (openA = r))
      order.push('a end')
      throw new Error('a failed')
    })
    const b = lock.run(async (waited) => void order.push(`b ${waited}`))
    const c = lock.run(async (waited) => void order.push(`c ${waited}`))
    await until(() => order.length === 1)
    expect(lock.busy()).toBe(true)
    openA()
    await expect(a).rejects.toThrow('a failed')
    await Promise.all([b, c])
    expect(order).toEqual(['a false', 'a end', 'b true', 'c true'])
    expect(lock.busy()).toBe(false)
    await lock.run(async (waited) => expect(waited).toBe(false))
  })
})

describe('BE-P2-19: the bot-images build and the browser add-on download take turns', () => {
  let dir = ''
  let close: (() => void) | null = null
  afterEach(() => {
    close?.()
    close = null
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = ''
  })

  it('Run setup first: the add-on download waits, then finds botvm-browser built and builds nothing', async () => {
    dir = mkdtempSync(join(process.env.TMPDIR ?? '.', 'ac-imglock-'))
    const eng = fakeEngine()
    const lock = createImageBuildLock()
    const host = hostOf(eng, lock)
    const addon = addonOf(eng, lock, dir)
    close = () => addon.close()

    await host.buildBotImages!()
    await until(() => eng.holding(BOTVM))
    addon.changed('agt_1', true)
    await until(() => addon.sharedState().state === 'downloading')
    // The add-on is waiting on the lock: still only the botvm build.
    await new Promise((r) => setTimeout(r, 20))
    expect(eng.log).toEqual([`start ${BOTVM}`])

    await eng.release(BOTVM)
    await eng.release(BROWSER)
    await host.botImagesIdle!()
    await addon.idle()

    expect(eng.log).toEqual([`start ${BOTVM}`, `end ${BOTVM}`, `start ${BROWSER}`, `end ${BROWSER}`])
    expect(eng.max()).toBe(1)
    expect(disjoint(eng.spans)).toBe(true)
    expect(addon.sharedState()).toEqual({ state: 'ready' })
    expect(addon.botInfo('agt_1')?.state).toBe('ready')
    expect((await host.hostInfo(true)).setupSteps.find((s) => s.id === BOT_IMAGES_STEP_ID)).toBeUndefined()
  })

  it('add-on download first: Run setup shows Building and waits, then builds only what is still missing', async () => {
    dir = mkdtempSync(join(process.env.TMPDIR ?? '.', 'ac-imglock-'))
    const eng = fakeEngine()
    const lock = createImageBuildLock()
    const host = hostOf(eng, lock)
    const addon = addonOf(eng, lock, dir)
    close = () => addon.close()

    addon.changed('agt_1', true)
    await until(() => eng.holding(BROWSER))
    const info = await host.buildBotImages!()
    expect(info.setupSteps.find((s) => s.id === BOT_IMAGES_STEP_ID)?.text).toBe(botImagesBuildingText([BOTVM, BROWSER], false))
    await new Promise((r) => setTimeout(r, 20))
    expect(eng.log).toEqual([`start ${BROWSER}`])

    await eng.release(BROWSER)
    await eng.release(BOTVM)
    await host.botImagesIdle!()
    await addon.idle()

    expect(eng.log).toEqual([`start ${BROWSER}`, `end ${BROWSER}`, `start ${BOTVM}`, `end ${BOTVM}`])
    expect(eng.max()).toBe(1)
    expect(disjoint(eng.spans)).toBe(true)
    expect(eng.spans.map((s) => [s.ref, s.from, s.to])).toEqual([[BROWSER, 0, 10], [BOTVM, 10, 20]])
    expect((await host.hostInfo(true)).setupSteps.find((s) => s.id === BOT_IMAGES_STEP_ID)).toBeUndefined()
  })
})
