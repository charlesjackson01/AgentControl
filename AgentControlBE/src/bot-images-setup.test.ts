/**
 * BE-P2-19: missing or outdated shared bot images (botvm, botvm-browser) are a setup step, built
 * only from POST /api/vm/setup/bot-images (never on start), then the firewall helper; a run that meets a
 * missing image fails with image_missing and the same pointer. A fake podman CLI only.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from './app.js'
import type { CommandResult, CommandRunner } from './command-runner.js'
import { PERMISSION_CSRF_HEADER, type VmHostInfo } from './shared/types.js'
import type { RuntimeProbe } from './runtime-probe.js'
import { createStore } from './store.js'
import { imageMissingText } from './vm-images.js'
import {
  BOT_IMAGES_STEP_ID, FIREWALL_STEP_ID, MACHINE_NAME, botImagesBuildingText, botImagesStepText, createVmHostService,
} from './vm-host.js'

const GIB = 1024 ** 3
const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' })
const err = (stderr: string, code = 1): CommandResult => ({ code, stdout: '', stderr })
const BOTVM = 'localhost/agentcontrol/botvm:2.0.0'
const BROWSER = 'localhost/agentcontrol/botvm-browser:2.0.0'
const FW = 'localhost/agentcontrol/egressd-nft:2.0.0'

/** Images present by ref; `old` lists tags of other versions per repo (an update). */
function fakePodman(o: { have?: string[]; old?: Record<string, string[]>; failBuild?: string; machine?: 'running' | 'stopped' } = {}) {
  const calls: string[] = []
  let release: (() => void) | null = null
  const gate = new Promise<void>((r) => (release = r))
  const have = new Set(o.have ?? [])
  const exec: CommandRunner = async (cmd, args) => {
    const line = [...args].join(' ')
    calls.push(`${cmd} ${line}`)
    if (cmd !== 'podman') return err(`${cmd}: not found`, 127)
    const rest = line.replace(`--connection ${MACHINE_NAME} `, '')
    if (rest === '--version') return ok('podman version 5.4.0\n')
    if (rest === 'info --format json') return ok(JSON.stringify({ host: { security: { rootless: true } }, store: { graphDriverName: 'overlay' } }))
    if (rest === 'machine info --format json') return ok(JSON.stringify({ Host: { VMType: 'libkrun' } }))
    if (rest === `machine inspect ${MACHINE_NAME}`) return ok(JSON.stringify([{ Name: MACHINE_NAME, State: o.machine ?? 'running', Resources: { CPUs: 4, Memory: 6144, DiskSize: 60 } }]))
    if (rest.startsWith(`machine ssh ${MACHINE_NAME} df`)) return ok(`Used\n${10 * GIB}\n`)
    const ex = /^image exists (\S+)$/.exec(rest)
    if (ex) return have.has(ex[1]!) ? ok() : err('', 1)
    const ls = /^image ls --format \{\{\.Tag\}\} (\S+)$/.exec(rest)
    if (ls) return ok([...(o.old?.[ls[1]!] ?? []), ...[...have].filter((r) => r.startsWith(`${ls[1]}:`)).map((r) => r.split(':').at(-1))].join('\n'))
    const b = /^build -t (\S+)/.exec(rest)
    if (b) {
      await gate
      if (o.failBuild) return err(`STEP 9/18: RUN curl …\n${o.failBuild}\n`)
      have.add(b[1]!)
      return ok()
    }
    return err(`unexpected podman ${line}`, 2)
  }
  return { exec, calls, have, release: () => release?.() }
}

function svc(cli: ReturnType<typeof fakePodman>, o: { browser?: boolean; platform?: NodeJS.Platform } = {}) {
  return createVmHostService({
    exec: cli.exec,
    platform: o.platform ?? 'linux',
    totalMemBytes: () => 16 * GIB,
    freeBytes: async () => 500 * GIB,
    hostDiskPath: () => '/fake/home',
    cacheMs: 0,
    firewall: { image: FW, baseImage: BOTVM, buildArgv: () => ['build', '-t', FW, 'vm/images/egressd-nft'] },
    botImages: {
      images: () => [{ kind: 'botvm', ref: BOTVM }, ...(o.browser ? [{ kind: 'botvm-browser' as const, ref: BROWSER }] : [])],
      buildArgv: (kind) => ['build', '-t', kind === 'botvm' ? BOTVM : BROWSER, `vm/images/${kind}`],
    },
  })
}
const step = (info: VmHostInfo, id = BOT_IMAGES_STEP_ID) => info.setupSteps.find((x) => x.id === id)

describe('BE-P2-19: bot images setup step', () => {
  it('after an update (another version is there): the step says AgentControl was updated and to run setup', async () => {
    const cli = fakePodman({ have: [FW], old: { 'localhost/agentcontrol/botvm': ['1.0.1'] } })
    const info = await svc(cli).hostInfo(true)
    expect(step(info)).toEqual({ id: BOT_IMAGES_STEP_ID, text: botImagesStepText([BOTVM], true), done: false })
    expect(step(info)!.text).toBe('AgentControl was updated and needs to rebuild its bot images (agentcontrol/botvm). Run setup in Settings › VMs to rebuild them.')
  })

  it('first install (no version at all): a plain build step; with a browser bot both images are listed', async () => {
    const cli = fakePodman()
    expect(step(await svc(cli).hostInfo(true))!.text).toBe('Build the bot images (agentcontrol/botvm), so bots can run scripts.')
    expect(step(await svc(cli, { browser: true }).hostInfo(true))!.text).toBe('Build the bot images (agentcontrol/botvm and agentcontrol/botvm-browser), so bots can run scripts.')
  })

  it('all built (and the firewall helper): no steps at all', async () => {
    const cli = fakePodman({ have: [BOTVM, BROWSER, FW] })
    expect((await svc(cli, { browser: true }).hostInfo(true)).setupSteps).toEqual([])
  })

  it('builds in order in the background (botvm, then browser), then the firewall helper; the step shows progress, then goes away', async () => {
    const cli = fakePodman({ old: { 'localhost/agentcontrol/botvm': ['1.0.1'], 'localhost/agentcontrol/botvm-browser': ['1.0.1'] } })
    const s = svc(cli, { browser: true })
    const info = await s.buildBotImages!()
    expect(step(info)).toEqual({ id: BOT_IMAGES_STEP_ID, text: botImagesBuildingText([BOTVM, BROWSER], true), done: false })
    expect(step(info)!.text).toBe('Rebuilding the bot images (agentcontrol/botvm and agentcontrol/botvm-browser). Scripts can run again when this is done…')
    await expect(s.buildBotImages!()).rejects.toMatchObject({ statusCode: 409, reason: 'setup_busy' })
    cli.release()
    await s.botImagesIdle!()
    await s.firewallIdle!()
    expect(cli.calls.filter((c) => c.startsWith('podman build')).map((c) => c.split(' ')[3])).toEqual([BOTVM, BROWSER, FW])
    expect((await s.hostInfo(true)).setupSteps).toEqual([])
  })

  it('a failed build shows its last line and how to retry; the firewall helper is not attempted', async () => {
    const cli = fakePodman({ failBuild: 'Error: network unreachable' })
    const s = svc(cli)
    await s.buildBotImages!()
    cli.release()
    await s.botImagesIdle!()
    const st = step(await s.hostInfo(true))!
    expect(st.done).toBe(false)
    expect(st.text).toBe("The bot images (agentcontrol/botvm) couldn't be built: Error: network unreachable. Try again with Run setup in Settings › VMs, or run npm run vm:images.")
    expect(cli.calls.filter((c) => c.startsWith('podman build'))).toHaveLength(1)
  })

  it('nothing missing: no image build, but a pending firewall helper is still set up', async () => {
    const cli = fakePodman({ have: [BOTVM] })
    const s = svc(cli)
    await s.buildBotImages!()
    cli.release()
    await new Promise((r) => setTimeout(r, 0))
    await s.firewallIdle!()
    expect(cli.calls.filter((c) => c.startsWith('podman build')).map((c) => c.split(' ')[3])).toEqual([FW])
  })

  it('the firewall setup without botvm answers image_missing with the same pointer', async () => {
    const cli = fakePodman()
    await expect(svc(cli).buildFirewall!()).rejects.toMatchObject({ statusCode: 409, reason: 'image_missing', message: imageMissingText(BOTVM) })
    expect(imageMissingText(BOTVM)).toBe(
      "AgentControl needs to rebuild its bot images: localhost/agentcontrol/botvm:2.0.0 isn't built yet (this happens after an update). Open Settings › VMs and run setup to rebuild them.",
    )
  })

  it('Mac: only while our machine runs, through its connection', async () => {
    const stopped = fakePodman({ machine: 'stopped' })
    expect(step(await svc(stopped, { platform: 'darwin' }).hostInfo(true))).toBeUndefined()
    await expect(svc(stopped, { platform: 'darwin' }).buildBotImages!()).rejects.toMatchObject({ statusCode: 409, reason: 'machine_stopped' })
    const running = fakePodman()
    expect(step(await svc(running, { platform: 'darwin' }).hostInfo(true))?.done).toBe(false)
    expect(running.calls).toContain(`podman --connection ${MACHINE_NAME} image exists ${BOTVM}`)
  })

  it('the step comes before the firewall step', async () => {
    const info = await svc(fakePodman()).hostInfo(true)
    const ids = info.setupSteps.map((x) => x.id)
    expect(ids.indexOf(BOT_IMAGES_STEP_ID)).toBeLessThan(ids.indexOf(FIREWALL_STEP_ID))
  })
})

describe('POST /api/vm/setup/bot-images', () => {
  let dir = ''
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = ''
  })

  it('needs the confirm header; then 202 with the host info', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ac-imgs-'))
    const cli = fakePodman({ have: [FW], old: { 'localhost/agentcontrol/botvm': ['1.0.1'] } })
    const vmHost = svc(cli)
    const app = await buildApp(createStore(join(dir, 'store.json')), { vmHost, backups: { root: join(dir, 'backups'), nightlyMs: false } })
    try {
      const no = await app.inject({ method: 'POST', url: '/api/vm/setup/bot-images', remoteAddress: '127.0.0.1' })
      expect(no.statusCode).toBe(403)
      expect(no.json()).toMatchObject({ reason: 'confirm_required' })
      const res = await app.inject({ method: 'POST', url: '/api/vm/setup/bot-images', remoteAddress: '127.0.0.1', headers: { [PERMISSION_CSRF_HEADER]: '1' } })
      expect(res.statusCode).toBe(202)
      expect(step(res.json() as VmHostInfo)?.text).toBe(botImagesBuildingText([BOTVM], true))
      cli.release()
      await vmHost.botImagesIdle!()
      expect(step(await vmHost.hostInfo(true))).toBeUndefined()
    } finally {
      await app.close()
    }
  })
})

describe('BE-P2-19: server start', () => {
  let dir = ''
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = ''
  })

  it('never builds the bot images on start (the step stays until Run setup); the firewall helper start is as before', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ac-imgs-start-'))
    const cli = fakePodman({ have: [FW], old: { 'localhost/agentcontrol/botvm': ['1.0.1'] } })
    const vmHost = svc(cli)
    const botImages = vi.spyOn(vmHost, 'buildBotImages')
    const firewall = vi.spyOn(vmHost, 'buildFirewall')
    const probe: RuntimeProbe = {
      current: () => null,
      refresh: async () => { throw new Error('no probe in this test') },
      ensureFresh: async () => { throw new Error('no probe in this test') },
      restore: async () => null,
      startTimer: () => () => {},
    }
    const app = await buildApp(createStore(join(dir, 'store.json')), { vmHost, runtimeProbe: probe, probeOnStart: true, backups: { root: join(dir, 'backups'), nightlyMs: false } })
    try {
      await app.ready()
      await new Promise((r) => setTimeout(r, 20))
      expect(botImages).not.toHaveBeenCalled()
      expect(firewall).toHaveBeenCalledTimes(1)
      expect(cli.calls.some((c) => c.startsWith('podman build'))).toBe(false)
      expect(step(await vmHost.hostInfo(true))).toMatchObject({ done: false, text: botImagesStepText([BOTVM], true) })
    } finally {
      await app.close()
    }
  })
})
