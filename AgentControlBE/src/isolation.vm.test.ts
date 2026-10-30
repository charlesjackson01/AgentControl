/**
 * BE-P2-5 @vm: bot file access (uid mapping) and bot↔bot isolation against a real engine.
 * Opt-in: AC_VM_TESTS=1. Needs localhost/agentcontrol/botvm:<BOTVM_VERSION> in that engine's store.
 * Engine selection as in podman-runner.vm.test.ts (AC_VM_ENGINE, PODMAN_ARGS, AC_VM_RUNSC=0).
 *
 * Three bots A, B, C run at the same time; A and B are in group g1, C isn't. Covered:
 * - the real probe's bind_mount check and the uid mapping it picks (idmap first, else keep-id)
 * - uid 1000 can modify, create, mkdir, rename and delete in /bot/workspace and /bot/groups/g1,
 *   and the host files stay owned by the server user (this process)
 * - EROFS on /bot/shared, /bot/skills and the root fs
 * - A can't see B's workspace, tools volume, env, processes or network; C has no group folder
 * - a mount of another bot's folder is refused before the engine is called
 * Not covered yet: snapshot mounts (BE-9); distinct host uids per bot (idmap only, skipped under keep-id).
 *
 * The @vm files run one at a time (vitest.config.ts) because they share the engine's probe containers.
 *
 * Runs are blocked where limits can't be enforced (rootless here). This file sets the test-only
 * AC_ALLOW_UNLIMITED_RUNS=1 itself, only in that case, and restores it afterwards.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execCommandRunner } from './command-runner.js'
import { createBotEnvService, type BotEnvService, type EngineRef } from './bot-env.js'
import { ALLOW_UNLIMITED_RUNS_ENV, createContainerRunner, type ContainerRunner } from './podman-runner.js'
import { createRuntimeProbe, PROBE_LABEL, resolveRuntime, type ResolvedRuntime, type RuntimeProbeResult } from './runtime-probe.js'
import type { RunScriptRequest } from './runner.js'
import { defaultAgentVm } from './vm-defaults.js'
import type { Agent, GlobalRuntimeMode } from './shared/types.js'
import { sharedImageRef } from './vm-images.js'
import type { BotMount, MountAllowList, UidMapping } from './isolation.js'

const SLUGS = ['be5a', 'be5b', 'be5c'] as const
type Slug = (typeof SLUGS)[number]
const INTRUDER = 'be5x'
const enginePrefix = (process.env.AC_VM_ENGINE ?? 'podman').split(/\s+/).filter(Boolean)
const podmanArgs = (process.env.PODMAN_ARGS ?? '').split(/\s+/).filter(Boolean)
const command = enginePrefix[0] ?? 'podman'
const cli: 'podman' | 'docker' = enginePrefix[enginePrefix.length - 1] === 'docker' ? 'docker' : 'podman'
const ENGINE: EngineRef = { cli, ...(command !== cli ? { command } : {}), globalArgs: [...enginePrefix.slice(1), ...podmanArgs] }
const globalMode = (process.env.AC_VM_GVISOR ?? 'auto') as GlobalRuntimeMode

const pm = (...args: string[]): string | null => {
  try {
    return execFileSync(command, [...ENGINE.globalArgs, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch {
    return null
  }
}
const engineReady = process.env.AC_VM_TESTS === '1' && pm('image', 'inspect', '--format', '{{.Id}}', sharedImageRef('botvm')) !== null

function cleanup(): void {
  for (const s of [...SLUGS, INTRUDER]) {
    pm('rm', '--force', `ac-bot-${s}`)
    pm('volume', 'rm', '--force', `ac-tools-${s}`, `ac-opt-${s}`)
  }
  for (const id of (pm('ps', '-a', '--filter', `label=${PROBE_LABEL}=1`, '--format', '{{.ID}}') ?? '').split('\n').filter(Boolean)) pm('rm', '--force', id)
}

describe.skipIf(!engineReady)('@vm BE-P2-5 bot folders and bot↔bot isolation', () => {
  let root = ''
  let probe: RuntimeProbeResult
  let rt: ResolvedRuntime
  let mapping: UidMapping | null = null
  let botEnv: BotEnvService
  let runner: ContainerRunner
  const savedOverride = process.env[ALLOW_UNLIMITED_RUNS_ENV]
  const me = { uid: process.getuid?.() ?? -1, gid: process.getgid?.() ?? -1 }
  const agents = Object.fromEntries(
    SLUGS.map((s) => [s, { id: `ag_${s}`, slug: s, name: s.toUpperCase(), internetPolicy: 'ask', vm: { ...defaultAgentVm(), env: [{ name: 'BOT_SECRET', value: `secret-${s}` }] } } as unknown as Agent]),
  ) as Record<Slug, Agent>
  const groupsOf = (s: string): string[] => (s === 'be5a' || s === 'be5b' ? ['g1'] : [])
  const p = (...x: string[]) => join(root, ...x)
  const allow = (s: string): MountAllowList => ({
    slug: s, workspace: p('bots', s, 'workspace'), inputs: p('bots', s, 'shared'), skills: p('skills', s),
    groups: Object.fromEntries(groupsOf(s).map((g) => [g, p('groups', g, 'shared')])), botRoot: p('bots', s), groupsRoot: p('groups'),
  })
  const mountsOf = (s: string): BotMount[] => [
    { source: p('bots', s, 'workspace'), target: '/bot/workspace', readonly: false },
    { source: p('bots', s, 'shared'), target: '/bot/shared', readonly: true },
    { source: p('skills', s), target: '/bot/skills', readonly: true },
    ...groupsOf(s).map((g) => ({ source: p('groups', g, 'shared'), target: `/bot/groups/${g}`, readonly: false })),
  ]
  const run = (s: Slug, argv: string[], over: Partial<RunScriptRequest> = {}) =>
    runner.run({ agentId: agents[s].id, context: { kind: 'dm' }, argv, cwd: 'workspace', timeoutSec: 120, network: 'off', ...over })
  const sh = (s: Slug, script: string) => run(s, ['sh', '-c', script])
  const owner = (f: string) => { const st = statSync(f); return { uid: st.uid, gid: st.gid } }

  beforeAll(async () => {
    cleanup()
    root = mkdtempSync(join(tmpdir(), 'ac-be5-vm-'))
    for (const s of SLUGS) {
      for (const d of ['workspace', 'shared', 'memory']) mkdirSync(p('bots', s, d), { recursive: true })
      mkdirSync(p('skills', s), { recursive: true })
      writeFileSync(p('bots', s, 'shared', 'input.txt'), `input of ${s}\n`)
      writeFileSync(p('skills', s, 'SKILL.md'), `skill of ${s}\n`)
      writeFileSync(p('bots', s, 'workspace', 'host.txt'), `host file of ${s}\n`)
    }
    mkdirSync(p('groups', 'g1', 'shared'), { recursive: true })
    writeFileSync(p('groups', 'g1', 'shared', 'notes.txt'), 'group notes\n')

    probe = await createRuntimeProbe({ exec: execCommandRunner, engine: async () => ENGINE, bindDir: () => root, tryRunsc: process.env.AC_VM_RUNSC !== '0' }).refresh()
    rt = resolveRuntime(globalMode, 'inherit', probe, 'BE5')
    mapping = cli === 'docker' ? null : ((rt.effective === 'runsc' ? probe.uidMapping : probe.standard?.uidMapping) ?? 'keep-id')
    console.log(`[be5 probe] ${JSON.stringify({ standard: probe.standard, uidMapping: probe.uidMapping, runsc: probe.runsc, checks: probe.checks })}`)
    console.log(`[be5 resolved] ${JSON.stringify({ runtime: rt.effective, mapping })}`)
    if (!rt.limitsEnforced) process.env[ALLOW_UNLIMITED_RUNS_ENV] = '1'

    botEnv = createBotEnvService({
      exec: execCommandRunner,
      engine: async () => ENGINE,
      mounts: (a) => mountsOf(a.slug),
      allowedMounts: (a) => allow(a.slug),
      uidMapping: () => mapping,
      saveVm: () => true,
      runtime: () => (rt.effective === 'runsc' ? 'runsc' : null),
      runtimeFlags: () => (rt.effective === 'runsc' ? (rt.flags ?? []) : []),
      enforceLimits: () => probe.standard?.limitsAccepted ?? true,
      activeRuns: (id) => runner.activeRuns(id),
    })
    runner = createContainerRunner({
      botEnv, engine: async () => ENGINE, getAgent: (id) => Object.values(agents).find((a) => a.id === id), runtime: () => rt,
      log: (m) => console.log(`[be5 runner] ${m}`),
    })
  }, 300_000)
  afterAll(() => {
    if (savedOverride === undefined) delete process.env[ALLOW_UNLIMITED_RUNS_ENV]
    else process.env[ALLOW_UNLIMITED_RUNS_ENV] = savedOverride
    cleanup()
    if (root) rmSync(root, { recursive: true, force: true })
  }, 120_000)

  it('probe: bind_mount passes for real, records the mapping, and leaves nothing behind', () => {
    const check = probe.standard?.checks.find((c) => c.id === 'bind_mount')
    expect(check?.status, check?.message).toBe('pass')
    expect(['idmap', 'keep-id']).toContain(probe.standard?.uidMapping)
    if (probe.standard?.uidMapping === 'keep-id') expect(check?.message).toMatch(/^keep-id: .*\(idmap failed: /)
    if (probe.runsc.installed && probe.checks?.find((c) => c.id === 'start')?.status === 'pass') {
      expect(probe.checks.find((c) => c.id === 'bind_mount')?.status).toBe('pass')
      expect(probe.uidMapping).not.toBeNull()
    }
    expect(readdirSync(root).filter((f) => f.startsWith('.ac-bind-probe-'))).toEqual([])
    expect(pm('ps', '-a', '--filter', `label=${PROBE_LABEL}=1`, '--format', '{{.ID}}')).toBe('')
  })

  it('workspace: uid 1000 modifies, creates, mkdirs, renames and deletes; host files stay the server user\'s', async () => {
    const r = await sh('be5a', [
      'set -e', 'test "$(id -u)" = 1000', 'cd /bot/workspace',
      'echo bot >> host.txt', 'echo new > a.txt', 'mkdir -p d/e', 'mv a.txt d/e/b.txt', 'echo keep > d/kept.txt',
      'echo gone > gone.txt', 'rm gone.txt', 'mv d dir2', 'rm -r dir2/e',
    ].join('\n'))
    expect(r.outcome, r.stderr).toBe('succeeded')
    const ws = p('bots', 'be5a', 'workspace')
    expect(readFileSync(join(ws, 'host.txt'), 'utf8')).toBe('host file of be5a\nbot\n')
    expect(readdirSync(ws).sort()).toEqual(['dir2', 'host.txt'])
    expect(readdirSync(join(ws, 'dir2'))).toEqual(['kept.txt'])
    for (const f of ['host.txt', 'dir2', 'dir2/kept.txt']) expect(owner(join(ws, f)), f).toEqual(me)
    // The host (server) can still change and remove what the bot made.
    rmSync(join(ws, 'dir2'), { recursive: true })
  }, 180_000)

  it('group folder: A and B both write, rename and delete there; host ownership unchanged; C has no group folder', async () => {
    const g = p('groups', 'g1', 'shared')
    const a = await sh('be5a', 'set -e; cd /bot/groups/g1; echo A >> notes.txt; echo a > from-a.txt; mkdir sub; mv from-a.txt sub/a.txt')
    expect(a.outcome, a.stderr).toBe('succeeded')
    const b = await sh('be5b', 'set -e; cd /bot/groups/g1; cat sub/a.txt; echo B >> notes.txt; rm sub/a.txt; echo b > sub/b.txt')
    expect(b.outcome, b.stderr).toBe('succeeded')
    expect(b.stdout).toBe('a\n')
    expect(readFileSync(join(g, 'notes.txt'), 'utf8')).toBe('group notes\nA\nB\n')
    expect(readdirSync(join(g, 'sub'))).toEqual(['b.txt'])
    for (const f of ['notes.txt', 'sub', 'sub/b.txt']) expect(owner(join(g, f)), f).toEqual(me)
    const c = await sh('be5c', 'ls -A /bot/groups; test -e /bot/groups/g1 && echo HAS_G1; true')
    expect(c.stdout).not.toContain('g1')
  }, 180_000)

  it('read-only mounts and the root fs give EROFS; nothing reaches the host', async () => {
    const r = await run('be5a', ['python3', '-c', [
      'import errno',
      'print(open("/bot/shared/input.txt").read().strip()); print(open("/bot/skills/SKILL.md").read().strip())',
      'for f in ["/bot/shared/x.txt", "/bot/shared/input.txt", "/bot/skills/x.txt", "/usr/x.txt"]:',
      '  try:',
      '    open(f, "a").write("x"); print(f, "WRITABLE")',
      '  except OSError as e:',
      '    print(f, errno.errorcode[e.errno])',
    ].join('\n')])
    expect(r.stdout.split('\n').filter(Boolean)).toEqual([
      'input of be5a', 'skill of be5a',
      '/bot/shared/x.txt EROFS', '/bot/shared/input.txt EROFS', '/bot/skills/x.txt EROFS', '/usr/x.txt EROFS',
    ])
    expect(readFileSync(p('bots', 'be5a', 'shared', 'input.txt'), 'utf8')).toBe('input of be5a\n')
    expect(existsSync(p('bots', 'be5a', 'shared', 'x.txt'))).toBe(false)
    expect(existsSync(p('skills', 'be5a', 'x.txt'))).toBe(false)
  }, 120_000)

  it('3 bots at once: none sees another\'s workspace, tools volume, env, processes or network', async () => {
    // Each bot leaves a marker in its tools volume (~) and workspace, then all three run together:
    // a long sleep with a unique argument plus a look around for the others.
    for (const s of SLUGS) expect((await sh(s, `echo ${s} > ~/marker; echo ${s} > /bot/workspace/marker`)).outcome).toBe('succeeded')
    const look = (s: Slug, secs: string) => sh(s, [
      `sleep ${secs} & sleep 3`,
      'echo "home=$(cat ~/marker) ws=$(cat /bot/workspace/marker) env=$BOT_SECRET"',
      'echo "procs=$(cat /proc/[0-9]*/cmdline 2>/dev/null | tr "\\0" " " | grep -o "sleep 4[0-9]\\.[0-9]" | sort -u | tr "\\n" ",")"',
      'echo "net=$(ls /sys/class/net | tr "\\n" ",")"',
      'echo "bots=$(ls /bot | tr "\\n" ",") seen=$(find / -path /proc -prune -o -name marker -print 2>/dev/null | sort | tr "\\n" ",")"',
      'kill %1 2>/dev/null; true',
    ].join('\n'))
    const t0 = Date.now()
    const [a, b, c] = await Promise.all([look('be5a', '41.1'), look('be5b', '42.2'), look('be5c', '43.3')])
    const took = Date.now() - t0
    // Each run holds 3 s; run one after another they would take 9 s or more.
    expect(took).toBeLessThan(9000)
    console.log(`[be5 parallel] ${took} ms\n${a.stdout}${b.stdout}${c.stdout}`)
    for (const [s, r, secs] of [['be5a', a, '41.1'], ['be5b', b, '42.2'], ['be5c', c, '43.3']] as const) {
      expect(r.outcome, r.stderr).toBe('succeeded')
      const lines = r.stdout.split('\n')
      expect(lines[0]).toBe(`home=${s} ws=${s} env=secret-${s}`)
      expect(lines[1]).toBe(`procs=sleep ${secs},`)
      expect(lines[2]).toBe('net=lo,')
      expect(lines[3]).toBe('bots=groups,shared,skills,workspace, seen=/bot/workspace/marker,/home/bot/marker,')
    }
    // The host sees three separate markers in three separate folders.
    for (const s of SLUGS) expect(readFileSync(p('bots', s, 'workspace', 'marker'), 'utf8')).toBe(`${s}\n`)
    // Three running containers with separate network namespaces.
    const ns = SLUGS.map((s) => pm('container', 'inspect', '--format', '{{.NetworkSettings.SandboxKey}}|{{.HostConfig.NetworkMode}}', `ac-bot-${s}`))
    for (const n of ns) expect(n?.split('|')[1]).toBe('none')
  }, 300_000)

  it('mounting another bot\'s folder throws before the engine is called', async () => {
    const intruder = { ...agents.be5a, id: 'ag_be5x', slug: INTRUDER } as Agent
    const calls: string[][] = []
    const svc = createBotEnvService({
      exec: async (cmd, args, o) => { calls.push([...args]); return execCommandRunner(cmd, args, o) },
      engine: async () => ENGINE,
      mounts: () => [{ source: p('bots', 'be5b', 'workspace'), target: '/bot/workspace', readonly: false }],
      allowedMounts: () => allow(INTRUDER),
      uidMapping: () => mapping,
      saveVm: () => true,
    })
    await expect(svc.ensure(intruder, { start: true })).rejects.toMatchObject({ reason: 'mount_refused' })
    expect(calls).toEqual([])
    expect(pm('container', 'exists', `ac-bot-${INTRUDER}`)).toBeNull()
    expect(pm('volume', 'exists', `ac-tools-${INTRUDER}`)).toBeNull()
  }, 60_000)

  it('distinct host uids per bot (idmap only)', async (ctx) => {
    if (mapping !== 'idmap') return ctx.skip(`uid mapping is ${mapping}: bots share the server user's uid on the host (no idmapped mounts here)`)
    // Under idmap each bot's container gets its own subuid range, but files it writes still map to the
    // server user through the idmapped mount; only the in-container uid ranges differ.
    const ranges = await Promise.all(SLUGS.map(async (s) => (await sh(s, 'cat /proc/self/uid_map')).stdout.trim()))
    expect(new Set(ranges).size).toBe(SLUGS.length)
  }, 120_000)
})
