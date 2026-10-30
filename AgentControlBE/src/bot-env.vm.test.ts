/**
 * BE-P2-4 @vm: BotEnvService against a real engine. Opt-in: AC_VM_TESTS=1 (PODMAN_ARGS may point at a
 * throwaway --root/--runroot). Needs localhost/agentcontrol/botvm:<BOTVM_VERSION> already built.
 * Runs offline (--network none everywhere); everything it creates is removed at the end.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execCommandRunner } from './command-runner.js'
import { createBotEnvService, type BotEnvService } from './bot-env.js'
import { defaultAgentVm } from './vm-defaults.js'
import type { Agent } from './shared/types.js'
import { BOTVM_VERSION, sharedImageRef } from './vm-images.js'

const SLUG = 'be4vmtest'
const UPGRADE = `${BOTVM_VERSION}-be4test`
const podmanArgs = (process.env.PODMAN_ARGS ?? '').split(/\s+/).filter(Boolean)
const engine = (() => {
  try {
    execFileSync('podman', [...podmanArgs, 'image', 'exists', sharedImageRef('botvm')], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()
const pm = (...args: string[]) => {
  try {
    return execFileSync('podman', [...podmanArgs, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch {
    return null
  }
}
function cleanup(): void {
  pm('rm', '--force', `ac-bot-${SLUG}`)
  pm('volume', 'rm', '--force', `ac-tools-${SLUG}`, `ac-opt-${SLUG}`)
  for (const ref of (pm('image', 'ls', '--format', '{{.Repository}}:{{.Tag}}', '--filter', `reference=localhost/ac-bot-${SLUG}`) ?? '').split('\n').filter(Boolean)) pm('rmi', ref)
  pm('untag', sharedImageRef('botvm'), sharedImageRef('botvm', UPGRADE))
}

const WHEEL = `import zipfile
z = zipfile.ZipFile('/tmp/be4pkg-1.0-py3-none-any.whl', 'w')
z.writestr('be4pkg/__init__.py', 'VALUE = 42\\n')
z.writestr('be4pkg-1.0.dist-info/METADATA', 'Metadata-Version: 2.1\\nName: be4pkg\\nVersion: 1.0\\n')
z.writestr('be4pkg-1.0.dist-info/WHEEL', 'Wheel-Version: 1.0\\nGenerator: be4\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n')
z.writestr('be4pkg-1.0.dist-info/RECORD', '')
z.close()`

describe.skipIf(process.env.AC_VM_TESTS !== '1' || !engine)('@vm BotEnvService', () => {
  let dir = ''
  let version: string = BOTVM_VERSION
  let svc: BotEnvService
  const agent = { id: 'ag_be4vm', slug: SLUG, name: 'BE4 VM test', internetPolicy: 'ask', vm: { ...defaultAgentVm(), env: [{ name: 'BE4_GREETING', value: 'hello world=1' }, { name: 'PATH_APPEND', value: '/bot/workspace/bin' }] } } as unknown as Agent
  const run = (argv: string[]) => svc.exec(agent, argv, { timeoutMs: 120_000 })
  const importWorks = async () => (await run(['python3', '-c', 'import be4pkg; print(be4pkg.VALUE)'])).stdout.trim() === '42'
  const containerImage = () => pm('container', 'inspect', '--format', '{{.Image}}', `ac-bot-${SLUG}`)
  const imageId = (ref: string) => pm('image', 'inspect', '--format', '{{.Id}}', ref)

  beforeAll(() => {
    cleanup()
    pm('tag', sharedImageRef('botvm'), sharedImageRef('botvm', UPGRADE))
    dir = mkdtempSync(join(tmpdir(), 'ac-be4-vm-'))
    for (const sub of ['workspace', 'shared']) mkdirSync(join(dir, sub))
    for (const p of [dir, join(dir, 'workspace'), join(dir, 'shared')]) chmodSync(p, 0o755)
    svc = createBotEnvService({
      exec: execCommandRunner,
      engine: async () => ({ cli: 'podman', globalArgs: podmanArgs }),
      baseVersion: () => version,
      mounts: () => [
        { source: join(dir, 'workspace'), target: '/bot/workspace', readonly: false },
        { source: join(dir, 'shared'), target: '/bot/shared', readonly: true },
      ],
      saveVm: () => true,
      buildNetwork: () => 'none',
    })
  })
  afterAll(() => {
    cleanup()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('container: uid 1000, read-only root, no network, env injected (PATH_APPEND, no host env)', async () => {
    await svc.start(agent)
    expect((await run(['id', '-u'])).stdout.trim()).toBe('1000')
    expect((await run(['touch', '/usr/be4'])).code).not.toBe(0)
    expect((await run(['touch', '/tmp/ok'])).code).toBe(0)
    expect((await run(['ls', '/sys/class/net'])).stdout.trim().split(/\s+/)).toEqual(['lo'])
    expect((await run(['printenv', 'BE4_GREETING'])).stdout.trim()).toBe('hello world=1')
    expect((await run(['printenv', 'PATH'])).stdout.trim()).toMatch(/^\/home\/bot\/\.local\/bin:.*:\/bot\/workspace\/bin$/)
    expect((await run(['printenv', 'HOME'])).stdout.trim()).toBe('/home/bot')
    expect((await run(['printenv', 'AGENTCONTROL_SECRET'])).code).not.toBe(0)
    expect((await run(['printenv', 'HTTP_PROXY'])).code).not.toBe(0)
  }, 120_000)

  it('pip install --user in run 1 survives stop, recreate on a new layer, base upgrade and rollback', async () => {
    expect((await run(['python3', '-c', WHEEL])).code).toBe(0)
    const pip = await run(['python3', '-m', 'pip', 'install', '--user', '--no-index', '--disable-pip-version-check', '/tmp/be4pkg-1.0-py3-none-any.whl'])
    expect(pip.code, pip.stderr).toBe(0)
    expect(await importWorks()).toBe(true)
    await svc.refreshTools(agent)
    expect(agent.vm.tools?.pip).toContain('be4pkg==1.0')

    // Stop + new generation → container recreated on gen 1; volumes kept.
    await svc.stop(agent)
    const gen0 = containerImage()
    await svc.rebuild(agent)
    expect(agent.vm.image).toMatchObject({ generation: 1, previous: 0 })
    await svc.start(agent)
    expect(containerImage()).toBe(imageId(`localhost/ac-bot-${SLUG}:1`))
    expect(containerImage()).not.toBe(gen0)
    expect(await importWorks()).toBe(true)

    // Base upgrade: the layer is rebuilt FROM the new base on the next ensure; volumes kept.
    version = UPGRADE
    await svc.ensure(agent, { start: true })
    expect(agent.vm.image).toMatchObject({ generation: 2, previous: 1 })
    expect(pm('image', 'inspect', '--format', '{{index .Labels "io.agentcontrol.from"}}', `localhost/ac-bot-${SLUG}:2`)).toBe(sharedImageRef('botvm', UPGRADE))
    expect(containerImage()).toBe(imageId(`localhost/ac-bot-${SLUG}:2`))
    expect(await importWorks()).toBe(true)

    // Rollback restores generation 1 (container on it, gen 2 removed); tools still there.
    await svc.rollback(agent)
    expect(agent.vm.image.generation).toBe(1)
    expect(containerImage()).toBe(imageId(`localhost/ac-bot-${SLUG}:1`))
    expect(imageId(`localhost/ac-bot-${SLUG}:2`)).toBeNull()
    expect(await importWorks()).toBe(true)
  }, 600_000)

  it('reset wipes tools and layers, keeps env; fresh stopped container on the base', async () => {
    await svc.reset(agent)
    expect(agent.vm.image).toEqual({ generation: 0, base: 'base' })
    expect(agent.vm.tools).toBeUndefined()
    expect(pm('container', 'inspect', '--format', '{{.State.Status}}', `ac-bot-${SLUG}`)).not.toBe('running')
    expect(pm('image', 'ls', '-q', '--filter', `reference=localhost/ac-bot-${SLUG}`)).toBe('')
    await svc.start(agent)
    expect(await importWorks()).toBe(false)
    expect((await run(['printenv', 'BE4_GREETING'])).stdout.trim()).toBe('hello world=1')
  }, 300_000)

  it.skip('vm_install apt package persists across recreate — needs a build network; M1 builds run with --network none (GAP)', () => {})
})
