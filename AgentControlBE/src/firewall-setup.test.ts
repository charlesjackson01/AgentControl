/**
 * BE-P2-18 (M2 gap 1): the egressd-nft firewall helper image is a first-run setup step. A fake
 * podman CLI only (no real engine); the route goes through the app with an injected host service.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildApp } from './app.js'
import type { CommandResult, CommandRunner } from './command-runner.js'
import { PERMISSION_CSRF_HEADER, type VmHostInfo } from './shared/types.js'
import { createStore } from './store.js'
import { FIREWALL_STEP_BUILDING_TEXT, FIREWALL_STEP_ID, FIREWALL_STEP_TEXT, MACHINE_NAME, createVmHostService } from './vm-host.js'

const GIB = 1024 ** 3
const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' })
const err = (stderr: string, code = 1): CommandResult => ({ code, stdout: '', stderr })
const FW = 'localhost/agentcontrol/egressd-nft:test'
const BASE = 'localhost/agentcontrol/botvm:test'

function fakePodman(o: { fw?: boolean; base?: boolean; failBuild?: string; machine?: 'running' | 'stopped' } = {}) {
  const calls: string[] = []
  let release: (() => void) | null = null
  const gate = new Promise<void>((r) => (release = r))
  const state = { fw: o.fw ?? false, base: o.base ?? true }
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
    if (rest === `image exists ${FW}`) return state.fw ? ok() : err('', 1)
    if (rest === `image exists ${BASE}`) return state.base ? ok() : err('', 1)
    if (rest.startsWith('build ')) {
      await gate
      if (o.failBuild) return err(`STEP 2/3: RUN apk add nftables\n${o.failBuild}\n`)
      state.fw = true
      return ok()
    }
    return err(`unexpected podman ${line}`, 2)
  }
  return { exec, calls, state, release: () => release?.() }
}

function svc(cli: ReturnType<typeof fakePodman>, platform: NodeJS.Platform = 'linux') {
  return createVmHostService({
    exec: cli.exec,
    platform,
    totalMemBytes: () => 16 * GIB,
    freeBytes: async () => 500 * GIB,
    hostDiskPath: () => '/fake/home',
    cacheMs: 0,
    firewall: { image: FW, baseImage: BASE, buildArgv: () => ['build', '-t', FW, '--build-arg', `BASE=${BASE}`, 'vm/images/egressd-nft'] },
  })
}

describe('firewall helper setup step (gap 1)', () => {
  it('missing on Linux: one open step; built: no steps', async () => {
    const cli = fakePodman()
    const s = svc(cli)
    const info = await s.hostInfo(true)
    expect(info.setupSteps.filter((x) => !x.done)).toEqual([{ id: FIREWALL_STEP_ID, text: FIREWALL_STEP_TEXT, done: false }])
    cli.state.fw = true
    expect((await s.hostInfo(true)).setupSteps).toEqual([])
  })

  it('builds in the background; the step shows progress, then goes away', async () => {
    const cli = fakePodman()
    const s = svc(cli)
    const info = await s.buildFirewall!()
    expect(info.setupSteps.find((x) => x.id === FIREWALL_STEP_ID)).toEqual({ id: FIREWALL_STEP_ID, text: FIREWALL_STEP_BUILDING_TEXT, done: false })
    await expect(s.buildFirewall!()).rejects.toMatchObject({ statusCode: 409, reason: 'setup_busy' })
    cli.release()
    await s.firewallIdle!()
    expect((await s.hostInfo(true)).setupSteps).toEqual([])
    expect(cli.calls.filter((c) => c.startsWith('podman build'))).toHaveLength(1)
    // Already built: nothing to do.
    await s.buildFirewall!()
    expect(cli.calls.filter((c) => c.startsWith('podman build'))).toHaveLength(1)
  })

  it('a failed build shows its last line and the manual command; a retry clears it', async () => {
    const cli = fakePodman({ failBuild: 'Error: network unreachable' })
    const s = svc(cli)
    await s.buildFirewall!()
    cli.release()
    await s.firewallIdle!()
    const step = (await s.hostInfo(true)).setupSteps.find((x) => x.id === FIREWALL_STEP_ID)!
    expect(step.done).toBe(false)
    expect(step.text).toContain('Error: network unreachable.')
    expect(step.text).toContain('vm/build-images.sh --only egressd-nft')
  })

  it('needs the bot image first (its FROM): 409 image_missing, no build', async () => {
    const cli = fakePodman({ base: false })
    await expect(svc(cli).buildFirewall!()).rejects.toMatchObject({ statusCode: 409, reason: 'image_missing' })
    expect(cli.calls.some((c) => c.startsWith('podman build'))).toBe(false)
  })

  it('Mac: checked through our machine only while it runs', async () => {
    const stopped = fakePodman({ machine: 'stopped' })
    const st = await svc(stopped, 'darwin').hostInfo(true)
    expect(st.setupSteps.some((x) => x.id === FIREWALL_STEP_ID)).toBe(false)
    await expect(svc(stopped, 'darwin').buildFirewall!()).rejects.toMatchObject({ statusCode: 409, reason: 'machine_stopped' })
    const running = fakePodman()
    const info = await svc(running, 'darwin').hostInfo(true)
    expect(info.setupSteps.find((x) => x.id === FIREWALL_STEP_ID)?.done).toBe(false)
    expect(running.calls).toContain(`podman --connection ${MACHINE_NAME} image exists ${FW}`)
  })
})

describe('POST /api/vm/setup/firewall-image', () => {
  let dir = ''
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = ''
  })

  it('needs the confirm header; then 202 with the host info', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ac-fw-'))
    const cli = fakePodman()
    const vmHost = svc(cli)
    const app = await buildApp(createStore(join(dir, 'store.json')), { vmHost, backups: { root: join(dir, 'backups'), nightlyMs: false } })
    try {
      const no = await app.inject({ method: 'POST', url: '/api/vm/setup/firewall-image', remoteAddress: '127.0.0.1' })
      expect(no.statusCode).toBe(403)
      expect(no.json()).toMatchObject({ reason: 'confirm_required' })
      const res = await app.inject({ method: 'POST', url: '/api/vm/setup/firewall-image', remoteAddress: '127.0.0.1', headers: { [PERMISSION_CSRF_HEADER]: '1' } })
      expect(res.statusCode).toBe(202)
      expect((res.json() as VmHostInfo).setupSteps.find((x) => x.id === FIREWALL_STEP_ID)?.text).toBe(FIREWALL_STEP_BUILDING_TEXT)
      cli.release()
      await vmHost.firewallIdle!()
    } finally {
      await app.close()
    }
  })
})
