import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import type { CommandResult, CommandRunner } from './command-runner.js'
import {
  bindProbeArgv,
  CHECK_ORDER,
  chromiumProbeArgv,
  createRuntimeProbe,
  forceOnMessage,
  orderChecks,
  parseChromiumOutput,
  PROBE_MAX_AGE_MS,
  judgeBind,
  judgeLimits,
  parseBindOutput,
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

interface BindCall {
  runtime: string | null
  mapping: 'idmap' | 'keep-id' | null
  rw: string
  ro: string
}
const IDMAP_EPERM = bad('Error: crun: mount_setattr `/bot/shared`: Operation not permitted: OCI permission denied', 126)
/** Does what the bind script does, on the host, as this process (so ownership = the server user). */
function emulateBind(c: BindCall, over: { skip?: string[]; writeRo?: string } = {}): CommandResult {
  const out: Record<string, string | number> = { uid: 1000 }
  const step = (name: string, fn: () => void) => {
    if (over.skip?.includes(name)) return void (out[name] = 'EACCES Permission denied')
    try {
      fn()
      out[name] = 'ok'
    } catch (e) {
      out[name] = `${(e as NodeJS.ErrnoException).code} failed`
    }
  }
  step('modify', () => appendFileSync(join(c.rw, 'host.txt'), 'bot\n'))
  step('create', () => writeFileSync(join(c.rw, 'a.txt'), 'x'))
  step('mkdir', () => mkdirSync(join(c.rw, 'd')))
  step('rename', () => renameSync(join(c.rw, 'a.txt'), join(c.rw, 'd', 'b.txt')))
  step('delete', () => unlinkSync(join(c.rw, 'd', 'b.txt')))
  step('keep', () => writeFileSync(join(c.rw, 'd', 'kept.txt'), 'k'))
  out.readRo = readFileSync(join(c.ro, 'in.txt'), 'utf8').trim()
  out.writeRo = over.writeRo ?? 'EROFS'
  return ok(`AC_BIND ${JSON.stringify(out)}\n`)
}
const defaultBind = (c: BindCall) => (c.mapping === 'idmap' ? IDMAP_EPERM : emulateBind(c))

interface FakeOpts {
  bind?: (c: BindCall) => CommandResult
  std?: () => CommandResult
  runsc?: (flags: string[]) => CommandResult
  runscVersion?: CommandResult
  imageId?: () => string
  /** BE-P2-7: the Chromium check's container (default: a pass). */
  chromium?: (runtime: string | null, a: string[]) => CommandResult
}
const CHROMIUM_OK = ok('AC_CHROMIUM {"version": "128.0.6613.18", "bytes": 3120, "png": true, "seconds": 1.2}\n')
function fakeEngine(o: FakeOpts = {}) {
  const calls: { cmd: string; args: string[] }[] = []
  const bindCalls: BindCall[] = []
  const exec: CommandRunner = async (cmd, args) => {
    const a = [...args]
    calls.push({ cmd, args: a })
    if (cmd === 'runsc' || (a[0] === 'machine' && a[1] === 'ssh')) return o.runscVersion ?? ok('runsc version 0.0~20240729.0\nspec: 1.1.0\n')
    if (a.includes('version')) return ok('5.4.2\n')
    if (a.includes('info')) return ok('crun|crun version 1.21\ncommit: x\n')
    const verb = a[0] === '--root' ? a.slice(2) : a
    if (verb[0] === 'image' && verb[1] === 'inspect') return ok(`sha256:${o.imageId?.() ?? 'abcdef0123456789'}\n`)
    if (a.includes('rm')) return ok()
    const runAt = a.indexOf('run')
    if (runAt >= 0 && a.some((x) => x.startsWith('ac-probe-chromium-'))) {
      const rt = a.includes('--runtime') ? a[a.indexOf('--runtime') + 1]! : null
      return o.chromium ? o.chromium(rt, a) : CHROMIUM_OK
    }
    if (runAt >= 0 && a.includes('--mount')) {
      const src = (dest: string) => a.find((x) => x.startsWith('type=bind,') && x.includes(`destination=${dest}`))!.split(',').find((x) => x.startsWith('source='))!.slice(7)
      const userns = a[a.indexOf('--userns') + 1]
      const c: BindCall = {
        runtime: a.includes('--runtime') ? a[a.indexOf('--runtime') + 1]! : null,
        mapping: !a.includes('--userns') ? null : userns === 'auto' ? 'idmap' : 'keep-id',
        rw: src('/bot/workspace'),
        ro: src('/bot/shared'),
      }
      bindCalls.push(c)
      return (o.bind ?? defaultBind)(c)
    }
    if (runAt >= 0) {
      const flags = a.slice(0, runAt).filter((x) => x.startsWith('--runtime-flag'))
      if (a.includes('--runtime')) return o.runsc ? o.runsc(flags) : bad('unknown runtime runsc', 125)
      return o.std ? o.std() : probeOut(facts())
    }
    return bad(`unexpected ${a.join(' ')}`, 1)
  }
  return { exec, calls, bindCalls }
}
const isRun = (c: { args: string[] }) => c.args.includes('run') && !c.args.includes('--mount')
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
      // BE-P2-7: plan order, so the first failing check is the reason.
      ['start', 'pass'], ['bind_mount', 'pass'], ['snapshot_mount', 'skipped'], ['network', 'pass'],
      ['cgroup_limits', 'fail'], ['exec', 'pass'], ['chromium', 'skipped'],
    ])
    expect(r.uidMapping).toBe('keep-id')
    expect(r.standard?.uidMapping).toBe('keep-id')
    expect(r.versions).toEqual({ engine: '5.4.2', runsc: '0.0~20240729.0', image: 'abcdef012345' })
    // All three runsc variants were tried, flags as global args before `run`; failures cleaned up by name.
    const runs = f.calls.filter(isRun)
    expect(runs).toHaveLength(1 + RUNSC_FLAG_VARIANTS.length)
    for (const c of runs) {
      expect(c.args.slice(0, 2)).toEqual(['--root', '/tmp/r'])
      expect(c.args.join(' ')).not.toContain('network=host')
    }
    // 2 failed runsc starts + the failed idmap bind attempt for crun and for runsc.
    expect(f.calls.filter((c) => c.args.includes('rm')).length).toBe(4)
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
    const runs = () => f.calls.filter((c) => isRun(c) && !c.args.includes('--runtime')).length
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

describe('BE-P2-5 bind_mount check', () => {
  const owner = { uid: 501, gid: 20 }
  const okOut = { uid: 1000, modify: 'ok', create: 'ok', mkdir: 'ok', rename: 'ok', delete: 'ok', keep: 'ok', readRo: 'read only', writeRo: 'EROFS' }
  const host = { owner, kept: owner, dir: owner, modified: true, leftovers: [] as string[] }
  const withDir = async <T>(fn: (dir: string) => Promise<T>): Promise<T> => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-bindtest-'))
    try {
      return await fn(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('the bind probe container is hardened and offline; userns and idmap per mapping; never U on binds', () => {
    const base = { name: 'n', image: 'img', runtime: null, rw: '/h/rw', ro: '/h/ro' }
    const keep = bindProbeArgv({ ...base, uidMapping: 'keep-id' }).join(' ')
    for (const f of ['--network none', '--user 1000:1000', '--read-only', '--cap-drop ALL', '--security-opt no-new-privileges', '--userns keep-id:uid=1000,gid=1000',
      'type=bind,source=/h/rw,destination=/bot/workspace --mount', 'type=bind,source=/h/ro,destination=/bot/shared,readonly img']) expect(keep).toContain(f)
    expect(keep).not.toMatch(/idmap|U=true|--privileged|=host|--memory/)
    const idmap = bindProbeArgv({ ...base, runtime: 'runsc', uidMapping: 'idmap' }).join(' ')
    expect(idmap).toContain('--runtime runsc --userns auto')
    expect(idmap).toContain('destination=/bot/workspace,idmap')
    expect(idmap).toContain('destination=/bot/shared,readonly,idmap')
    expect(bindProbeArgv({ ...base, uidMapping: null }).join(' ')).not.toContain('--userns')
  })

  it('parses AC_BIND and judges writes, EROFS and host ownership', () => {
    expect(parseBindOutput(`x\nAC_BIND ${JSON.stringify(okOut)}`)).toEqual(okOut)
    expect(parseBindOutput('AC_BIND [1]')).toBeNull()
    expect(parseBindOutput('nothing')).toBeNull()
    expect(judgeBind(okOut, host)).toMatchObject({ ok: true })
    expect(judgeBind(okOut, host).message).toContain('owned by the server user')
    expect(judgeBind(null, host)).toMatchObject({ ok: false })
    expect(judgeBind({ ...okOut, create: 'EACCES Permission denied' }, host).message).toBe('create: EACCES Permission denied')
    expect(judgeBind({ ...okOut, writeRo: 'writable' }, host).message).toContain('expected EROFS')
    expect(judgeBind({ ...okOut, uid: 0 }, host).message).toContain('runs as uid 0')
    expect(judgeBind(okOut, { ...host, kept: { uid: 100999, gid: 100999 } }).message).toBe('the new file is owned by 100999:100999 on the host, expected the server user 501:20')
    expect(judgeBind(okOut, { ...host, dir: null }).message).toBe('the new folder is missing on the host')
    expect(judgeBind(okOut, { ...host, modified: false }).ok).toBe(false)
    expect(judgeBind(okOut, { ...host, leftovers: ['a.txt'] }).message).toContain('a.txt')
    // No uid on this OS (Windows): ownership isn't judged.
    expect(judgeBind(okOut, { ...host, owner: null, kept: null, dir: null })).toMatchObject({ ok: true })
  })

  it('idmap is tried first and wins where it works; keep-id is then not tried', async () => {
    await withDir(async (dir) => {
      const f = fakeEngine({ std: () => probeOut(ENFORCED), runsc: () => probeOut(ENFORCED), bind: (c) => emulateBind(c) })
      const r = await createRuntimeProbe({ exec: f.exec, engine, image: () => 'img', bindDir: () => dir }).refresh()
      expect(r.standard?.uidMapping).toBe('idmap')
      expect(r.uidMapping).toBe('idmap')
      expect(f.bindCalls.map((c) => [c.runtime, c.mapping])).toEqual([[null, 'idmap'], ['runsc', 'idmap']])
      expect(r.standard?.checks.find((c) => c.id === 'bind_mount')).toMatchObject({ status: 'pass', message: expect.stringMatching(/^idmap: /) })
      expect(readdirSync(dir)).toEqual([])
    })
  })

  it('idmap EPERM falls back to keep-id; the pass message says why', async () => {
    await withDir(async (dir) => {
      const f = fakeEngine({ std: () => probeOut(ENFORCED), runsc: () => probeOut(ENFORCED) })
      const r = await createRuntimeProbe({ exec: f.exec, engine, image: () => 'img', bindDir: () => dir }).refresh()
      expect(r.standard?.uidMapping).toBe('keep-id')
      expect(r.compatible).toBe(true)
      const check = r.standard!.checks.find((c) => c.id === 'bind_mount')!
      expect(check.status).toBe('pass')
      expect(check.message).toMatch(/^keep-id: .*\(idmap failed: the test container didn't start: .*mount_setattr/)
      expect(r.standard!.checks.map((c) => c.id).slice(0, 5)).toEqual(['start', 'bind_mount', 'snapshot_mount', 'network', 'cgroup_limits'])
      // The failed idmap containers are removed by name; the host temp folders are gone.
      expect(f.calls.filter((c) => c.args[c.args.length - 1]?.startsWith('ac-probe-bind-') && c.args.includes('rm'))).toHaveLength(2)
      expect(readdirSync(dir)).toEqual([])
    })
  })

  it('no mapping works → bind_mount fails, uidMapping null, and runsc is incompatible', async () => {
    await withDir(async (dir) => {
      const f = fakeEngine({ std: () => probeOut(ENFORCED), runsc: () => probeOut(ENFORCED), bind: (c) => (c.mapping === 'idmap' ? IDMAP_EPERM : emulateBind(c, { writeRo: 'writable' })) })
      const r = await createRuntimeProbe({ exec: f.exec, engine, image: () => 'img', bindDir: () => dir }).refresh()
      expect(r.standard?.uidMapping).toBeNull()
      expect(r.uidMapping).toBeNull()
      const check = r.standard!.checks.find((c) => c.id === 'bind_mount')!
      expect(check.status).toBe('fail')
      expect(check.message).toContain('idmap failed')
      expect(check.message).toContain('keep-id failed: writing to the read-only mount gave writable, expected EROFS')
      expect(r.compatible).toBe(false)
      expect(resolveRuntime('auto', 'inherit', r, 'A').effective).toBe('crun')
    })
  })

  it('a step that fails (e.g. EACCES on create) fails that mapping', async () => {
    await withDir(async (dir) => {
      const f2 = fakeEngine({ bind: (c) => emulateBind(c, { skip: c.mapping === 'keep-id' ? ['create'] : [] }) })
      const r = await createRuntimeProbe({ exec: f2.exec, engine, image: () => 'img', bindDir: () => dir, tryRunsc: false }).refresh()
      expect(r.standard?.uidMapping).toBe('idmap')
      const r2 = await createRuntimeProbe({
        exec: fakeEngine({ bind: (c) => (c.mapping === 'idmap' ? IDMAP_EPERM : emulateBind(c, { skip: ['create'] })) }).exec,
        engine, image: () => 'img', bindDir: () => dir, tryRunsc: false,
      }).refresh()
      expect(r2.standard?.checks.find((c) => c.id === 'bind_mount')?.message).toContain('keep-id failed: create: EACCES Permission denied')
    })
  })

  it('Docker: one attempt with the engine default mapping (no --userns)', async () => {
    await withDir(async (dir) => {
      const f = fakeEngine({ bind: (c) => emulateBind(c) })
      const r = await createRuntimeProbe({ exec: f.exec, engine: async () => ({ cli: 'docker' as const, globalArgs: [] }), image: () => 'img', bindDir: () => dir, tryRunsc: false }).refresh()
      expect(f.bindCalls.map((c) => c.mapping)).toEqual([null])
      expect(r.standard?.uidMapping).toBeNull()
      expect(r.standard?.checks.find((c) => c.id === 'bind_mount')).toMatchObject({ status: 'pass', message: expect.stringMatching(/^default mapping: /) })
    })
  })

  it('no mountable folder (bindDir null, or a remote --connection by default) → skipped, nothing run', async () => {
    const f = fakeEngine()
    const r = await createRuntimeProbe({ exec: f.exec, engine, image: () => 'img', bindDir: () => null, tryRunsc: false }).refresh()
    expect(r.standard?.checks.find((c) => c.id === 'bind_mount')?.status).toBe('skipped')
    expect(r.standard?.uidMapping).toBeNull()
    const g = fakeEngine()
    const r2 = await createRuntimeProbe({ exec: g.exec, engine: async () => ({ cli: 'podman' as const, globalArgs: ['--connection', 'agentcontrol'] }), image: () => 'img', tryRunsc: false }).refresh()
    expect(r2.standard?.checks.find((c) => c.id === 'bind_mount')?.status).toBe('skipped')
    expect([...f.bindCalls, ...g.bindCalls]).toHaveLength(0)
  })

  it('a runtime that did not start gets no bind check', async () => {
    const f = fakeEngine({ std: () => bad('Error: image not known', 125) })
    const r = await createRuntimeProbe({ exec: f.exec, engine, image: () => 'img', tryRunsc: false }).refresh()
    expect(r.standard?.checks.map((c) => c.id)).toEqual(['start'])
    expect(f.bindCalls).toHaveLength(0)
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
  it('BE-P2-7: every row, with the reason and failing check where the plan shows them', () => {
    const fallback = resolveRuntime('auto', 'inherit', failed, 'Analyst')
    expect(fallback).toEqual({
      effective: 'crun', status: 'incompatible_fallback', reason: 'bind-mount ownership check failed', failedCheck: 'bind_mount',
      checkedAt: '2026-10-27T18:00:00.000Z', mode: 'inherit', globalMode: 'auto', limitsEnforced: true,
    })
    expect(resolveRuntime('auto', 'inherit', base, 'A')).toEqual({ effective: 'runsc', status: 'active', limitsEnforced: true, checkedAt: base.checkedAt, mode: 'inherit', globalMode: 'auto' })
    const notInstalled = resolveRuntime('auto', 'inherit', missing, 'A')
    expect(notInstalled).toMatchObject({ effective: 'crun', status: 'not_installed' })
    expect(notInstalled.reason).toBeUndefined()
    expect(notInstalled.failedCheck).toBeUndefined()
    expect(resolveRuntime('force_on', 'inherit', failed, 'Analyst')).toMatchObject({ status: 'required_unavailable', failedCheck: 'bind_mount' })
    expect(resolveRuntime('force_off', 'inherit', failed, 'A')).toMatchObject({ effective: 'crun', status: 'forced_off', failedCheck: 'bind_mount' })
    expect(resolveRuntime('force_off', 'inherit', failed, 'A').reason).toBeUndefined()
  })
  it('BE-P2-7: force_on names the first failing check in plain words, whatever its detail', () => {
    const detail: RuntimeProbeResult = { ...base, compatible: false, checks: [
      { id: 'start', status: 'pass' },
      { id: 'bind_mount', status: 'fail', message: 'idmap failed: …; keep-id failed: the new file is owned by 100999:100999 on the host' },
      { id: 'cgroup_limits', status: 'fail', message: `${LIMITS_NOT_ENFORCED} (memory.max reads "max")` },
    ] }
    expect(resolveRuntime('auto', 'force_on', detail, 'Analyst').reason).toBe(
      'gVisor is required for Analyst but isn\'t available (bind-mount ownership check failed). Turn off Force on or fix gVisor.',
    )
    // Incompatible fallback keeps the detail (the VM tab shows it with the time).
    expect(resolveRuntime('auto', 'inherit', detail, 'Analyst').reason).toBe(detail.checks![1]!.message)
    const chromium: RuntimeProbeResult = { ...base, compatible: false, checks: [{ id: 'chromium', status: 'fail', message: 'Chromium didn\'t launch: x' }] }
    expect(resolveRuntime('auto', 'force_on', chromium, 'Analyst').reason).toBe(forceOnMessage('Analyst', 'Chromium check failed'))
    expect(resolveRuntime('auto', 'force_on', null, 'Analyst').reason).toBe(
      'gVisor is required for Analyst but isn\'t available (the runtime check hasn\'t run yet). Turn off Force on or fix gVisor.',
    )
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
    for (const headers of [{}, { 'x-agentcontrol-confirm': '0' }, { 'x-agentcontrol-confirm': 'yes' }]) {
      const denied = await app.inject({ method: 'POST', url: '/api/vm/probe', headers })
      expect(denied.statusCode).toBe(403)
      expect(denied.json()).toMatchObject({ message: 'Re-checking the VM runtime needs the x-agentcontrol-confirm: 1 header.' })
    }
    expect(p.current()).toBeNull()
    const post = await app.inject({ method: 'POST', url: '/api/vm/probe', headers: { 'x-agentcontrol-confirm': '1' } })
    expect(post.statusCode).toBe(200)
    expect(post.json().standard.limitsEnforced).toBe(false)
    expect((await app.inject({ method: 'GET', url: '/api/vm/probe' })).json().checkedAt).toBe(post.json().checkedAt)
    await app.close()
  })
})

describe('BE-P2-7 probe: order, Chromium, cache key, cache file, timer', () => {
  const withDir = async <T>(fn: (dir: string) => Promise<T>): Promise<T> => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-be7-'))
    try {
      return await fn(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  const chromiumRuns = (f: ReturnType<typeof fakeEngine>) => f.calls.filter((c) => c.args.some((x) => x.startsWith('ac-probe-chromium-')) && c.args.includes('run'))

  it('checks come in plan order (1–7), unknown ids last', () => {
    expect(CHECK_ORDER).toEqual(['start', 'bind_mount', 'snapshot_mount', 'network', 'cgroup_limits', 'exec', 'chromium'])
    const shuffled = [...CHECK_ORDER].reverse().map((id) => ({ id, status: 'pass' as const }))
    expect(orderChecks(shuffled).map((c) => c.id)).toEqual([...CHECK_ORDER])
  })

  it('force_on + runsc missing (real probe, fake engine) → the exact run message', async () => {
    const f = fakeEngine({ runscVersion: bad('runsc: not found', 127) })
    const r = await createRuntimeProbe({ exec: f.exec, engine, image: () => 'img', bindDir: () => null }).refresh()
    expect(r.runsc.installed).toBe(false)
    expect(resolveRuntime('auto', 'force_on', r, 'Analyst')).toMatchObject({
      effective: null, status: 'required_unavailable',
      reason: 'gVisor is required for Analyst but isn\'t available (it isn\'t installed). Turn off Force on or fix gVisor.',
    })
  })

  it('a broken idmap on runsc (no keep-id fallback) → Incompatible fallback with the bind reason', async () => {
    await withDir(async (dir) => {
      const f = fakeEngine({ std: () => probeOut(ENFORCED), runsc: () => probeOut(ENFORCED) })
      const r = await createRuntimeProbe({
        exec: f.exec, engine, image: () => 'img', bindDir: () => dir,
        uidMappings: (rt) => (rt === 'runsc' ? ['idmap'] : ['idmap', 'keep-id']),
      }).refresh()
      expect(r.compatible).toBe(false)
      expect(r.checks?.[1]).toMatchObject({ id: 'bind_mount', status: 'fail' })
      const res = resolveRuntime('auto', 'inherit', r, 'Analyst')
      expect(res).toMatchObject({ effective: 'crun', status: 'incompatible_fallback', failedCheck: 'bind_mount' })
      expect(res.reason).toMatch(/^The bot can't use its folders: idmap failed: the test container didn't start: .*mount_setattr/)
      expect(resolveRuntime('auto', 'force_on', r, 'Analyst').reason).toBe(forceOnMessage('Analyst', 'bind-mount ownership check failed'))
      expect(f.bindCalls.map((c) => [c.runtime, c.mapping])).toEqual([[null, 'idmap'], [null, 'keep-id'], ['runsc', 'idmap']])
    })
  })

  it('Chromium: skipped unless a bot has the browser on; then hardened, offline, both runtimes', async () => {
    const f = fakeEngine({ std: () => probeOut(ENFORCED), runsc: () => probeOut(ENFORCED) })
    const r0 = await createRuntimeProbe({ exec: f.exec, engine, image: () => 'img', bindDir: () => null }).refresh()
    expect(r0.checks?.find((c) => c.id === 'chromium')).toEqual({ id: 'chromium', status: 'skipped', message: 'Not needed: no bot has the browser on.' })
    expect(r0.features).toEqual([])
    expect(chromiumRuns(f)).toHaveLength(0)
    const g = fakeEngine({ std: () => probeOut(ENFORCED), runsc: () => probeOut(ENFORCED) })
    const r = await createRuntimeProbe({ exec: g.exec, engine, image: () => 'img', bindDir: () => null, features: () => ['chromium'], browserImage: () => 'browser-img' }).refresh()
    expect(r.features).toEqual(['chromium'])
    expect(r.compatible).toBe(true)
    expect(r.checks?.at(-1)).toMatchObject({ id: 'chromium', status: 'pass', message: 'Chromium 128.0.6613.18 launched and took a screenshot of about:blank' })
    expect(r.standard?.checks.at(-1)).toMatchObject({ id: 'chromium', status: 'pass' })
    const runs = chromiumRuns(g)
    expect(runs).toHaveLength(2)
    const rs = runs[1]!.args
    expect(rs.slice(0, 2)).toEqual(['--root', '/tmp/r'])
    expect(rs.join(' ')).toContain('--runtime runsc')
    expect(rs).toContain('browser-img')
    expect(typeof r.durationMs).toBe('number')
  })

  it('Chromium failing on runsc only → runsc incompatible with the Chromium reason', async () => {
    const f = fakeEngine({
      std: () => probeOut(ENFORCED), runsc: () => probeOut(ENFORCED),
      chromium: (rt) => (rt === 'runsc' ? ok('AC_CHROMIUM {"error": "BrowserType.launch: Target page, context or browser has been closed"}\n') : CHROMIUM_OK),
    })
    const r = await createRuntimeProbe({ exec: f.exec, engine, image: () => 'img', bindDir: () => null, features: () => ['chromium'] }).refresh()
    expect(r.standard?.checks.at(-1)?.status).toBe('pass')
    expect(r.compatible).toBe(false)
    const res = resolveRuntime('auto', 'inherit', r, 'A')
    expect(res).toMatchObject({ status: 'incompatible_fallback', failedCheck: 'chromium', reason: 'Chromium didn\'t launch: BrowserType.launch: Target page, context or browser has been closed' })
    const h = fakeEngine({ std: () => probeOut(ENFORCED), runsc: () => probeOut(ENFORCED), chromium: () => bad('Error: image not known', 125) })
    const r2 = await createRuntimeProbe({ exec: h.exec, engine, image: () => 'img', bindDir: () => null, features: () => ['chromium'], tryRunsc: false }).refresh()
    expect(r2.standard?.checks.at(-1)).toMatchObject({ status: 'fail', message: 'Chromium didn\'t launch: the test container didn\'t start: Error: image not known' })
  })

  it('the Chromium container is hardened and offline; the output parser ignores junk', () => {
    const argv = chromiumProbeArgv({ name: 'ac-probe-chromium-x', image: 'img', runtime: 'runsc', uidMapping: 'keep-id' }).join(' ')
    for (const f of ['--rm', '--network none', '--user 1000:1000', '--read-only', '--cap-drop ALL', '--security-opt no-new-privileges', '--runtime runsc', '--userns keep-id:uid=1000,gid=1000', '--env HOME=/tmp']) expect(argv).toContain(f)
    expect(argv).not.toMatch(/=host|--privileged|--network host/)
    expect(parseChromiumOutput('x\nAC_CHROMIUM {"png": true, "bytes": 5, "version": "1"}')).toEqual({ png: true, bytes: 5, version: '1' })
    expect(parseChromiumOutput('AC_CHROMIUM {bad')).toBeNull()
    expect(parseChromiumOutput('none')).toBeNull()
  })

  it('the feature set is part of the cache key; per-key results are reused while fresh', async () => {
    let features: ('chromium')[] = []
    let t = Date.parse('2026-10-27T18:00:00Z')
    const f = fakeEngine()
    const p = createRuntimeProbe({ exec: f.exec, engine, image: () => 'img', bindDir: () => null, tryRunsc: false, features: () => features, now: () => new Date(t) })
    const runs = () => f.calls.filter((c) => isRun(c) && !c.args.some((x) => x.startsWith('ac-probe-chromium-'))).length
    await p.ensureFresh()
    expect(runs()).toBe(1)
    await p.ensureFresh()
    expect(runs()).toBe(1)
    features = ['chromium']
    const withBrowser = await p.ensureFresh()
    expect(runs()).toBe(2)
    expect(withBrowser.features).toEqual(['chromium'])
    features = []
    t += 1000
    const back = await p.ensureFresh()
    expect(runs()).toBe(2) // cached result for the old key
    expect(back.features).toEqual([])
    expect(p.current()).toBe(back)
    t += PROBE_MAX_AGE_MS + 1
    await p.ensureFresh()
    expect(runs()).toBe(3)
  })

  it('cache file: saved (0600) and restored at start for the same key; stale or other keys are not', async () => {
    await withDir(async (dir) => {
      const cacheFile = join(dir, 'vm', 'runtime-probe.json')
      let t = Date.parse('2026-10-27T18:00:00Z')
      const now = () => new Date(t)
      const f = fakeEngine()
      const r = await createRuntimeProbe({ exec: f.exec, engine, image: () => 'img', bindDir: () => null, tryRunsc: false, cacheFile, now }).refresh()
      expect(statSync(cacheFile).mode & 0o777).toBe(0o600)
      expect(readdirSync(join(dir, 'vm'))).toEqual(['runtime-probe.json'])
      const g = fakeEngine()
      const p2 = createRuntimeProbe({ exec: g.exec, engine, image: () => 'img', bindDir: () => null, tryRunsc: false, cacheFile, now })
      expect(await p2.restore()).toEqual(r)
      expect(p2.current()).toEqual(r)
      expect(g.calls.filter(isRun)).toHaveLength(0)
      await p2.ensureFresh()
      expect(g.calls.filter(isRun)).toHaveLength(0)
      // Another image digest: a different key.
      const p3 = createRuntimeProbe({ exec: fakeEngine({ imageId: () => '99999999aaaa' }).exec, engine, image: () => 'img', bindDir: () => null, tryRunsc: false, cacheFile, now })
      expect(await p3.restore()).toBeNull()
      t += PROBE_MAX_AGE_MS + 1
      const p4 = createRuntimeProbe({ exec: fakeEngine().exec, engine, image: () => 'img', bindDir: () => null, tryRunsc: false, cacheFile, now })
      expect(await p4.restore()).toBeNull()
      expect(p4.current()).toBeNull()
      // A broken file is ignored (logged), not fatal.
      writeFileSync(cacheFile, '{broken')
      const logs: string[] = []
      const p5 = createRuntimeProbe({ exec: fakeEngine().exec, engine, image: () => 'img', bindDir: () => null, tryRunsc: false, cacheFile, now, log: (m) => logs.push(m) })
      expect(await p5.restore()).toBeNull()
      expect(logs.some((m) => m.includes('ignoring the probe cache'))).toBe(true)
    })
  })

  it('startTimer runs ensureFresh on the interval until stopped', async () => {
    vi.useFakeTimers()
    try {
      const f = fakeEngine()
      let t = Date.parse('2026-10-27T18:00:00Z')
      const p = createRuntimeProbe({ exec: f.exec, engine, image: () => 'img', bindDir: () => null, tryRunsc: false, now: () => new Date(t) })
      const stop = p.startTimer(1000)
      await vi.advanceTimersByTimeAsync(1000)
      expect(f.calls.filter(isRun)).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(1000)
      expect(f.calls.filter(isRun)).toHaveLength(1) // fresh, same key
      t += PROBE_MAX_AGE_MS + 1
      await vi.advanceTimersByTimeAsync(1000)
      expect(f.calls.filter(isRun)).toHaveLength(2)
      stop()
      t += PROBE_MAX_AGE_MS + 1
      await vi.advanceTimersByTimeAsync(5000)
      expect(f.calls.filter(isRun)).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('Mac/Windows: runsc --version is read inside the machine', async () => {
    const f = fakeEngine()
    const r = await createRuntimeProbe({ exec: f.exec, engine: async () => ({ cli: 'podman' as const, globalArgs: ['--connection', 'agentcontrol'] }), image: () => 'img', tryRunsc: false }).refresh()
    expect(r.versions.runsc).toBe('0.0~20240729.0')
    expect(f.calls.some((c) => c.cmd === 'podman' && c.args.join(' ') === 'machine ssh agentcontrol runsc --version')).toBe(true)
    expect(f.calls.some((c) => c.cmd === 'runsc')).toBe(false)
  })
})
