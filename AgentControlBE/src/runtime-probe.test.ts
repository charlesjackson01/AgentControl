import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import type { CommandResult, CommandRunner } from './command-runner.js'
import {
  createRuntimeProbe,
  judgeLimits,
  LIMITS_NOT_ENFORCED,
  parseProbeOutput,
  PROBE_LIMITS,
  probeRunArgv,
  registerProbeRoutes,
  resolveRuntime,
  RUNSC_FLAG_VARIANTS,
  type ProbeFacts,
  type RuntimeProbeResult,
} from './runtime-probe.js'

const facts = (over: Partial<ProbeFacts> = {}): ProbeFacts => ({
  uid: 1000, memoryMax: 'max', pidsMax: 'max', netifs: ['lo'], python: '3.11.2', node: 'v20.1.0', allocExit: 0, forked: PROBE_LIMITS.forks, ...over,
})
const ENFORCED = facts({ memoryMax: String(64 * 1024 * 1024), pidsMax: '32', allocExit: -9, forked: 28 })
const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' })
const bad = (stderr: string, code = 126): CommandResult => ({ code, stdout: '', stderr })
const probeOut = (f: ProbeFacts) => ok(`noise\nAC_PROBE ${JSON.stringify(f)}\n`)

interface FakeOpts {
  std?: () => CommandResult
  runsc?: (flags: string[]) => CommandResult
  runscVersion?: CommandResult
  imageId?: () => string
}
function fakeEngine(o: FakeOpts = {}) {
  const calls: { cmd: string; args: string[] }[] = []
  const exec: CommandRunner = async (cmd, args) => {
    const a = [...args]
    calls.push({ cmd, args: a })
    if (cmd === 'runsc') return o.runscVersion ?? ok('runsc version 0.0~20240729.0\nspec: 1.1.0\n')
    if (a.includes('version')) return ok('5.4.2\n')
    if (a.includes('info')) return ok('crun|crun version 1.21\ncommit: x\n')
    const verb = a[0] === '--root' ? a.slice(2) : a
    if (verb[0] === 'image' && verb[1] === 'inspect') return ok(`sha256:${o.imageId?.() ?? 'abcdef0123456789'}\n`)
    if (a.includes('rm')) return ok()
    const runAt = a.indexOf('run')
    if (runAt >= 0) {
      const flags = a.slice(0, runAt).filter((x) => x.startsWith('--runtime-flag'))
      if (a.includes('--runtime')) return o.runsc ? o.runsc(flags) : bad('unknown runtime runsc', 125)
      return o.std ? o.std() : probeOut(facts())
    }
    return bad(`unexpected ${a.join(' ')}`, 1)
  }
  return { exec, calls }
}
const engine = async () => ({ cli: 'podman' as const, globalArgs: ['--root', '/tmp/r'] })

describe('probe parsing and judging', () => {
  it('parses the AC_PROBE line and ignores junk', () => {
    expect(parseProbeOutput('x\nAC_PROBE {"uid":1000,"memoryMax":"max","pidsMax":null,"netifs":["lo"],"allocExit":-9,"forked":12}')).toMatchObject({ uid: 1000, memoryMax: 'max', pidsMax: null, allocExit: -9, forked: 12 })
    expect(parseProbeOutput('nothing here')).toBeNull()
    expect(parseProbeOutput('AC_PROBE {broken')).toBeNull()
  })
  it('limits count as enforced only when the allocation is killed AND forks are capped', () => {
    expect(judgeLimits(ENFORCED).enforced).toBe(true)
    const none = judgeLimits(facts())
    expect(none.enforced).toBe(false)
    expect(none.message.startsWith(LIMITS_NOT_ENFORCED)).toBe(true)
    expect(none.message).toContain('memory.max reads "max"')
    expect(none.message).toContain('192 MB allocation under a 64 MB limit succeeded')
    expect(judgeLimits(facts({ allocExit: -9 })).enforced).toBe(false)
    expect(judgeLimits(facts({ forked: 10 })).enforced).toBe(false)
    expect(judgeLimits(facts({ memoryMax: null, pidsMax: null })).message).toContain('nothing (no file)')
  })
  it('the probe container is hardened, offline and limited; never host networking', () => {
    const argv = probeRunArgv({ name: 'ac-probe-x', image: 'img', runtime: 'runsc', limits: true })
    expect(argv.join(' ')).toContain('--network none')
    expect(argv.join(' ')).not.toMatch(/host/)
    for (const f of ['--read-only', '--rm', '--memory', '--pids-limit', '--cap-drop']) expect(argv).toContain(f)
    expect(argv.slice(argv.indexOf('--runtime'), argv.indexOf('--runtime') + 2)).toEqual(['--runtime', 'runsc'])
    expect(probeRunArgv({ name: 'n', image: 'i', runtime: null, limits: false })).not.toContain('--memory')
  })
})

describe('createRuntimeProbe', () => {
  it('this box: crun accepts but does not enforce limits; runsc only starts with ignore-cgroups → incompatible', async () => {
    const f = fakeEngine({
      runsc: (flags) =>
        flags.includes('--runtime-flag=ignore-cgroups')
          ? probeOut(facts({ memoryMax: null, pidsMax: null }))
          : bad('cannot set up cgroup for root: open cgroup.subtree_control: permission denied'),
    })
    const p = createRuntimeProbe({ exec: f.exec, engine, image: () => 'img', now: () => new Date('2026-10-27T18:00:00Z') })
    const r = await p.refresh()
    expect(r.standard).toMatchObject({ runtime: 'crun', version: 'crun version 1.21', limitsEnforced: false, limitsAccepted: true })
    expect(r.standard?.checks.find((c) => c.id === 'cgroup_limits')?.message?.startsWith(LIMITS_NOT_ENFORCED)).toBe(true)
    expect(r.runsc).toEqual({ installed: true, version: '0.0~20240729.0' })
    expect(r.compatible).toBe(false)
    expect(r.runscFlags).toEqual(['--runtime-flag=ignore-cgroups', '--runtime-flag=network=none'])
    expect(r.checks?.map((c) => [c.id, c.status])).toEqual([
      ['start', 'pass'], ['network', 'pass'], ['cgroup_limits', 'fail'], ['exec', 'pass'],
      ['bind_mount', 'skipped'], ['snapshot_mount', 'skipped'], ['chromium', 'skipped'],
    ])
    expect(r.versions).toEqual({ engine: '5.4.2', runsc: '0.0~20240729.0', image: 'abcdef012345' })
    // All three runsc variants were tried, flags as global args before `run`; failures cleaned up by name.
    const runs = f.calls.filter((c) => c.args.includes('run'))
    expect(runs).toHaveLength(1 + RUNSC_FLAG_VARIANTS.length)
    for (const c of runs) {
      expect(c.args.slice(0, 2)).toEqual(['--root', '/tmp/r'])
      expect(c.args.join(' ')).not.toContain('network=host')
    }
    expect(f.calls.filter((c) => c.args.includes('rm')).length).toBe(2)
    expect(p.current()).toBe(r)
    // Resolution: auto → crun fallback, reason = limits can't be enforced, limits flagged.
    expect(resolveRuntime('auto', 'inherit', r, 'Analyst')).toMatchObject({
      effective: 'crun', status: 'incompatible_fallback', reason: LIMITS_NOT_ENFORCED, limitsEnforced: false,
    })
  })

  it('where limits are enforced, runsc passes and is active', async () => {
    const f = fakeEngine({ std: () => probeOut(ENFORCED), runsc: () => probeOut(ENFORCED) })
    const r = await createRuntimeProbe({ exec: f.exec, engine, image: () => 'img' }).refresh()
    expect(r.standard?.limitsEnforced).toBe(true)
    expect(r.compatible).toBe(true)
    expect(r.runscFlags).toEqual([])
    expect(resolveRuntime('auto', 'inherit', r, 'Analyst')).toEqual({ effective: 'runsc', status: 'active', limitsEnforced: true, mode: 'inherit', globalMode: 'auto', checkedAt: r.checkedAt })
  })

  it('runsc not installed: checks null, standard still probed', async () => {
    const f = fakeEngine({ runscVersion: bad('runsc: not found', 127), std: () => probeOut(ENFORCED) })
    const r = await createRuntimeProbe({ exec: f.exec, engine, image: () => 'img' }).refresh()
    expect(r.runsc).toEqual({ installed: false })
    expect(r.checks).toBeNull()
    expect(r.compatible).toBe(false)
    expect(f.calls.filter((c) => c.args.includes('--runtime'))).toHaveLength(0)
    expect(resolveRuntime('auto', 'inherit', r, 'A')).toMatchObject({ effective: 'crun', status: 'not_installed', limitsEnforced: true })
  })

  it('a failed start is reported with its last line', async () => {
    const f = fakeEngine({ std: () => bad('Error: image not known', 125), runsc: () => bad('Error: image not known', 125) })
    const r = await createRuntimeProbe({ exec: f.exec, engine, image: () => 'img' }).refresh()
    expect(r.standard?.checks).toEqual([expect.objectContaining({ id: 'start', status: 'fail', message: 'The test container didn\'t start: Error: image not known' })])
    expect(r.checks?.[0]).toMatchObject({ id: 'start', status: 'fail' })
  })

  it('engine refusing the limit flags → retried without, limitsAccepted false', async () => {
    let n = 0
    const f = fakeEngine({ std: () => (++n === 1 ? bad('Error: resource limits are not supported and ignored on cgroups V1 rootless systems', 125) : probeOut(facts())) })
    const r = await createRuntimeProbe({ exec: f.exec, engine, image: () => 'img', tryRunsc: false }).refresh()
    expect(r.standard).toMatchObject({ limitsAccepted: false, limitsEnforced: false })
    expect(f.calls.filter((c) => c.args.includes('run'))[1]?.args).not.toContain('--memory')
  })

  it('no engine → empty result', async () => {
    const r = await createRuntimeProbe({ exec: fakeEngine().exec, engine: async () => null }).refresh()
    expect(r).toMatchObject({ runsc: { installed: false }, checks: null, standard: null, versions: { engine: null } })
  })

  it('single flight, and ensureFresh re-probes only when stale or the key changed', async () => {
    let image = 'aaaaaaaaaaaaaaaa'
    let t = Date.parse('2026-10-27T18:00:00Z')
    const f = fakeEngine({ imageId: () => image })
    const p = createRuntimeProbe({ exec: f.exec, engine, image: () => 'img', now: () => new Date(t) })
    const runs = () => f.calls.filter((c) => c.args.includes('run') && !c.args.includes('--runtime')).length
    const [a, b] = await Promise.all([p.refresh(), p.refresh()])
    expect(a).toBe(b)
    expect(runs()).toBe(1)
    await p.ensureFresh()
    expect(runs()).toBe(1)
    image = 'bbbbbbbbbbbbbbbb'
    await p.ensureFresh()
    expect(runs()).toBe(2)
    t += 25 * 60 * 60 * 1000
    await p.ensureFresh()
    expect(runs()).toBe(3)
  })
})

describe('resolveRuntime (plan §4 table)', () => {
  const base: RuntimeProbeResult = {
    runsc: { installed: true, version: 'v' }, checks: [{ id: 'start', status: 'pass' }], compatible: true, uidMapping: null, snapshotDriver: null,
    checkedAt: '2026-10-27T18:00:00.000Z', versions: { engine: '5', runsc: 'v', image: 'i' },
    standard: { runtime: 'crun', version: '1.21', limitsEnforced: true, limitsAccepted: true, checks: [] }, runscFlags: [],
  }
  const failed: RuntimeProbeResult = { ...base, compatible: false, checks: [{ id: 'bind_mount', status: 'fail', message: 'bind-mount ownership check failed' }] }
  const missing: RuntimeProbeResult = { ...base, runsc: { installed: false }, checks: null, compatible: false }

  it.each([
    ['auto', 'inherit', base, 'runsc', 'active'],
    ['auto', 'inherit', missing, 'crun', 'not_installed'],
    ['auto', 'inherit', failed, 'crun', 'incompatible_fallback'],
    ['force_on', 'inherit', base, 'runsc', 'active'],
    ['auto', 'force_on', missing, null, 'required_unavailable'],
    ['force_on', 'inherit', failed, null, 'required_unavailable'],
    ['force_off', 'inherit', base, 'crun', 'forced_off'],
    ['auto', 'force_off', base, 'crun', 'forced_off'],
    ['force_off', 'force_on', base, 'runsc', 'active'],
  ] as const)('%s / bot %s', (g, b, probe, effective, status) => {
    expect(resolveRuntime(g, b, probe, 'Analyst')).toMatchObject({ effective, status, mode: b, globalMode: g })
  })
  it('force_on with a failed check gives the exact plan message', () => {
    expect(resolveRuntime('auto', 'force_on', failed, 'Analyst').reason).toBe(
      'gVisor is required for Analyst but isn\'t available (bind-mount ownership check failed). Turn off Force on or fix gVisor.',
    )
    expect(resolveRuntime('auto', 'force_on', missing, 'Analyst').reason).toBe(
      'gVisor is required for Analyst but isn\'t available (it isn\'t installed). Turn off Force on or fix gVisor.',
    )
  })
  it('before any probe: nothing claimed', () => {
    expect(resolveRuntime('auto', 'inherit', null, 'A')).toMatchObject({ effective: null, status: 'not_installed' })
    expect(resolveRuntime('auto', 'force_on', null, 'A')).toMatchObject({ effective: null, status: 'required_unavailable' })
  })
  it('runsc flags ride along for the runner', () => {
    expect(resolveRuntime('auto', 'inherit', { ...base, runscFlags: ['--runtime-flag=x'] }, 'A').flags).toEqual(['--runtime-flag=x'])
  })
})

describe('GET/POST /api/vm/probe', () => {
  it('GET returns the last result (empty before the first), POST re-checks', async () => {
    const app = Fastify()
    const p = createRuntimeProbe({ exec: fakeEngine().exec, engine, image: () => 'img' })
    registerProbeRoutes(app, p)
    const before = (await app.inject({ method: 'GET', url: '/api/vm/probe' })).json()
    expect(before).toMatchObject({ checkedAt: null, checks: null, standard: null })
    const post = await app.inject({ method: 'POST', url: '/api/vm/probe' })
    expect(post.statusCode).toBe(200)
    expect(post.json().standard.limitsEnforced).toBe(false)
    expect((await app.inject({ method: 'GET', url: '/api/vm/probe' })).json().checkedAt).toBe(post.json().checkedAt)
    await app.close()
  })
})
