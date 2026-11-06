/**
 * BE-P2-19 @vm: the §13 rows the older @vm files didn't cover, against a real engine with the
 * product's own mounts (botMounts / botMountAllowList on a throwaway store under TMPDIR).
 * Opt-in: AC_VM_TESTS=1 with localhost/agentcontrol/botvm:<BOTVM_VERSION> in the engine's store.
 * Engine selection as in podman-runner.vm.test.ts (AC_VM_ENGINE, PODMAN_ARGS, AC_VM_GVISOR).
 *
 * Covers:
 * - bot ↔ bot: another bot's snapshots aren't mounted or findable
 * - script → host files: a symlink a script makes isn't followed by the BE's file reads
 * - script → memory/profile with the product mounts: no memory, BOT.md or MEMORY.md; inputs EROFS
 * - privilege: mount, raw sockets, capability raising, setuid; no capabilities at all
 * - engine and storage helper: no engine socket, no DOCKER_HOST/CONTAINER_HOST, no `ac-storaged` name
 * - secrets: the server's GITHUB_TOKEN, TS_AUTHKEY, LLM keys and endpoint key reach neither the
 *   container (env, /proc/1/environ, the engine's Config.Env) nor the runner's log
 * - resources: a full /tmp gives ENOSPC and the run fails with a clear status
 *
 * Runs with --network none (the network row is in egress.vm.test.ts). Everything created is removed.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from './app.js'
import { botMountAllowList, botMounts } from './bot-env-routes.js'
import { createBotEnvService, type BotEnvService, type EngineRef } from './bot-env.js'
import { execCommandRunner } from './command-runner.js'
import { readContent } from './files.js'
import { ALLOW_UNLIMITED_RUNS_ENV, createContainerRunner, type ContainerRunner } from './podman-runner.js'
import type { RunScriptRequest } from './runner.js'
import { createRuntimeProbe, PROBE_LABEL, resolveRuntime, type ResolvedRuntime, type RuntimeProbeResult } from './runtime-probe.js'
import type { Agent, Endpoint, GlobalRuntimeMode } from './shared/types.js'
import { createStore, type WorkspaceStore } from './store.js'
import { sharedImageRef } from './vm-images.js'

const enginePrefix = (process.env.AC_VM_ENGINE ?? 'podman').split(/\s+/).filter(Boolean)
const podmanArgs = (process.env.PODMAN_ARGS ?? '').split(/\s+/).filter(Boolean)
const command = enginePrefix[0] ?? 'podman'
const cli: 'podman' | 'docker' = enginePrefix[enginePrefix.length - 1] === 'docker' ? 'docker' : 'podman'
const ENGINE: EngineRef = { cli, ...(command !== cli ? { command } : {}), globalArgs: [...enginePrefix.slice(1), ...podmanArgs] }
const globalMode = (process.env.AC_VM_GVISOR ?? 'auto') as GlobalRuntimeMode

const pm = (...args: string[]): string | null => {
  try {
    return execFileSync(command, [...ENGINE.globalArgs, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 }).trim()
  } catch {
    return null
  }
}
const engineReady = process.env.AC_VM_TESTS === '1' && pm('image', 'inspect', '--format', '{{.Id}}', sharedImageRef('botvm')) !== null

/** Fake secrets in the server's own environment (sentinels only; never real values). */
const SECRETS: Record<string, string> = {
  GITHUB_TOKEN: 'ghp_be19sentinelGithub0000000000000000',
  TS_AUTHKEY: 'tskey-auth-be19sentinelTailscale',
  OPENAI_API_KEY: 'sk-be19sentinelOpenai',
  ANTHROPIC_API_KEY: 'sk-ant-be19sentinelAnthropic',
  OPENROUTER_API_KEY: 'sk-or-be19sentinelOpenrouter',
  AGENTCONTROL_SECRET: 'be19sentinelAppSecret',
}
const ENDPOINT_KEY = 'sk-be19sentinelEndpointKey'
const SENTINEL = /be19sentinel/

describe.skipIf(!engineReady)('@vm BE-P2-19 security suite', () => {
  let dir = ''
  let store: WorkspaceStore
  let probe: RuntimeProbeResult
  let rt: ResolvedRuntime
  let botEnv: BotEnvService
  let runner: ContainerRunner
  let a: Agent
  let b: Agent
  const logs: string[] = []
  const saved: Record<string, string | undefined> = {}
  const slugs = () => [a?.slug, b?.slug].filter(Boolean) as string[]
  const cleanup = () => {
    for (const s of slugs()) {
      pm('rm', '--force', `ac-bot-${s}`)
      pm('volume', 'rm', '--force', `ac-tools-${s}`, `ac-opt-${s}`)
    }
    for (const id of (pm('ps', '-a', '--filter', `label=${PROBE_LABEL}=1`, '--format', '{{.ID}}') ?? '').split('\n').filter(Boolean)) pm('rm', '--force', id)
  }
  const run = (agent: Agent, script: string, over: Partial<RunScriptRequest> = {}) =>
    runner.run({ agentId: agent.id, context: { kind: 'dm' }, argv: ['bash', '-c', script], cwd: 'workspace', timeoutSec: 120, network: 'off', ...over })
  const py = (agent: Agent, code: string) => runner.run({ agentId: agent.id, context: { kind: 'dm' }, argv: ['python3', '-c', code], cwd: 'workspace', timeoutSec: 120, network: 'off' })

  beforeAll(async () => {
    for (const k of [...Object.keys(SECRETS), ALLOW_UNLIMITED_RUNS_ENV]) saved[k] = process.env[k]
    Object.assign(process.env, SECRETS)
    dir = mkdtempSync(join(tmpdir(), 'ac-be19-vm-'))
    store = createStore(join(dir, 'store.json'))
    const app = buildApp(store)
    const ep = await app.inject({ method: 'POST', url: '/api/endpoints', payload: { kind: 'openai-compatible', name: 'E', baseUrl: 'http://127.0.0.1:9', defaultModel: 'm', contextWindow: 8192, apiKey: ENDPOINT_KEY } })
    expect(ep.statusCode).toBe(201)
    const endpointId = (ep.json() as Endpoint).id
    const mk = async (name: string) => {
      const r = await app.inject({ method: 'POST', url: '/api/agents', payload: { name, description: 'd', instructions: 'i', modelId: 'm', endpointId, skillIds: [], rules: [] } })
      expect(r.statusCode).toBe(201)
      return r.json() as Agent
    }
    a = await mk('Be19 Alpha')
    b = await mk('Be19 Beta')
    await app.close()
    cleanup()
    // Bot B's snapshot and memory, where the product keeps them.
    mkdirSync(join(dir, 'snapshots', b.slug, 'run_be19', 'workspace'), { recursive: true })
    writeFileSync(join(dir, 'snapshots', b.slug, 'run_be19', 'workspace', 'be19-snapmark.txt'), 'snapshot of b\n')
    for (const s of [a, b]) {
      mkdirSync(join(dir, 'bots', s.slug, 'memory'), { recursive: true })
      writeFileSync(join(dir, 'bots', s.slug, 'memory', 'MEMORY.md'), 'be19-memmark\n')
      writeFileSync(join(dir, 'bots', s.slug, 'BOT.md'), 'be19-profilemark\n')
      writeFileSync(join(dir, 'bots', s.slug, 'shared', 'input.txt'), 'input\n')
    }

    const p = createRuntimeProbe({ exec: execCommandRunner, engine: async () => ENGINE, tryRunsc: process.env.AC_VM_RUNSC !== '0' })
    probe = await p.refresh()
    rt = resolveRuntime(globalMode, 'inherit', probe, a.name)
    if (!rt.limitsEnforced) process.env[ALLOW_UNLIMITED_RUNS_ENV] = '1'
    const agentOf = (id: string) => store.agents.find((x) => x.id === id)
    botEnv = createBotEnvService({
      exec: execCommandRunner,
      engine: async () => ENGINE,
      mounts: (ag) => botMounts(store, ag),
      allowedMounts: (ag) => botMountAllowList(store, ag),
      uidMapping: () => (cli === 'docker' ? null : ((rt.effective === 'runsc' ? probe.uidMapping : probe.standard?.uidMapping) ?? 'keep-id')),
      saveVm: () => true,
      runtime: () => (rt.effective === 'runsc' ? 'runsc' : null),
      runtimeFlags: () => (rt.effective === 'runsc' ? (rt.flags ?? []) : []),
      enforceLimits: () => probe.standard?.limitsAccepted ?? true,
      activeRuns: (id) => runner.activeRuns(id),
    })
    runner = createContainerRunner({ botEnv, engine: async () => ENGINE, getAgent: (id) => agentOf(id), runtime: () => rt, idleStopMs: 1, log: (m) => logs.push(m) })
  }, 300_000)
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    cleanup()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }, 120_000)

  it("bot ↔ bot: another bot's snapshots aren't mounted or findable", async () => {
    const r = await run(a, 'grep -c snapshots /proc/self/mountinfo || true; find / -xdev -name "be19-snapmark*" 2>/dev/null | head -1; find / -name "be19-snapmark*" -not -path "/proc/*" 2>/dev/null | head -1; ls /bot')
    expect(r.status, r.stderr).toBe('ok')
    expect(r.stdout.split('\n')[0]).toBe('0')
    expect(r.stdout).not.toContain('be19-snapmark')
    expect(r.stdout).not.toContain(b.slug)
  }, 240_000)

  it('script → host files: a symlink a script makes is not followed by the BE', async () => {
    const r = await run(a, ['ln -s /etc/passwd /bot/workspace/passwd', 'ln -s ../memory/MEMORY.md /bot/workspace/mem', 'ln -s ../../' + b.slug + '/BOT.md /bot/workspace/other', 'mkdir -p /bot/workspace/d && ln -s /bot/workspace/d /bot/workspace/dlink', 'ls -l /bot/workspace'].join(' && '))
    expect(r.status, r.stderr).toBe('ok')
    for (const link of ['workspace/passwd', 'workspace/mem', 'workspace/other', 'workspace/dlink']) {
      await expect(readContent(store, a, link), link).rejects.toMatchObject({ statusCode: expect.any(Number) })
    }
    await expect(readContent(store, a, 'workspace/passwd')).rejects.toMatchObject({ statusCode: expect.toSatisfy((c: number) => c === 400 || c === 403) })
  }, 240_000)

  it('script → memory/profile with the product mounts: no memory or profile; inputs read-only', async () => {
    const r = await py(a, [
      'import os, errno, subprocess',
      'hits = subprocess.run("grep -rl be19-memmark be19-profilemark / --exclude-dir=proc --exclude-dir=sys 2>/dev/null; find / \\\\( -name MEMORY.md -o -name BOT.md \\\\) -not -path \\"/proc/*\\" 2>/dev/null", shell=True, capture_output=True, text=True).stdout',
      'print("hits=" + repr(hits.strip()))',
      'print(sorted(os.listdir("/bot")))',
      'for f in ["/bot/shared/x.txt", "/bot/shared/input.txt", "/bot/memory", "/bot/BOT.md"]:',
      '    try:',
      '        open(f, "w").write("x"); print(f, "WROTE")',
      '    except OSError as e: print(f, errno.errorcode.get(e.errno))',
    ].join('\n'))
    expect(r.status, r.stderr).toBe('ok')
    expect(r.stdout).toContain("hits=''")
    expect(r.stdout).not.toMatch(/memory'|BOT\.md'/)
    expect(r.stdout).toContain('/bot/shared/x.txt EROFS')
    expect(r.stdout).toContain('/bot/shared/input.txt EROFS')
    expect(r.stdout).not.toContain('WROTE')
  }, 240_000)

  it('privilege: mount, raw sockets, setuid and capability raising all fail; no capabilities', async () => {
    const r = await run(a, [
      'id -u',
      'mkdir -p /tmp/m; mount -t tmpfs none /tmp/m >/dev/null 2>&1 && echo MOUNT_OK || echo MOUNT_FAIL',
      'unshare -m true >/dev/null 2>&1 && echo UNSHARE_OK || echo UNSHARE_FAIL',
      'python3 -c "import socket\ntry:\n  socket.socket(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_ICMP); print(\'RAW_OK\')\nexcept OSError as e: print(\'RAW_FAIL\', e.errno)"',
      'python3 -c "import socket\ntry:\n  socket.socket(socket.AF_PACKET, socket.SOCK_RAW); print(\'PACKET_OK\')\nexcept OSError as e: print(\'PACKET_FAIL\', e.errno)"',
      'python3 -c "import os\ntry:\n  os.setuid(0); print(\'SETUID_OK\')\nexcept OSError as e: print(\'SETUID_FAIL\', e.errno)"',
      'grep -E "^(CapInh|CapPrm|CapEff|CapBnd|CapAmb|NoNewPrivs|Seccomp):" /proc/self/status',
      'if command -v capsh >/dev/null; then capsh --caps="cap_sys_admin+eip" -- -c true >/dev/null 2>&1 && echo CAPSH_OK || echo CAPSH_FAIL; else echo CAPSH_ABSENT; fi',
      'find / -xdev -perm -4000 -type f 2>/dev/null | head -5 | sed "s/^/SUID /"',
    ].join('; '))
    expect(r.status, r.stderr).toBe('ok')
    const out = r.stdout
    expect(out.split('\n')[0]).toBe('1000')
    expect(out).toContain('MOUNT_FAIL')
    expect(out).toContain('UNSHARE_FAIL')
    expect(out).toMatch(/RAW_FAIL/)
    expect(out).toMatch(/PACKET_FAIL/)
    expect(out).toMatch(/SETUID_FAIL/)
    expect(out).toMatch(/CAPSH_(FAIL|ABSENT)/)
    for (const k of ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb']) expect(out, k).toMatch(new RegExp(`^${k}:\\s+0+$`, 'm'))
    expect(out).toMatch(/^NoNewPrivs:\s+1$/m)
    // A setuid file can't help: no_new_privileges and an empty bounding set. Logged, not failed.
    if (/^SUID /m.test(out)) console.log(`[be19] setuid files in the image (inert here): ${out.match(/^SUID .*$/gm)!.join(', ')}`)
  }, 240_000)

  it('engine and storage helper: no engine socket, no engine variables, no ac-storaged name', async () => {
    const r = await run(a, [
      'ls -d /run/podman /var/run/podman /run/docker.sock /var/run/docker.sock /run/user 2>/dev/null | sed "s/^/PATH /"',
      'find / -xdev -type s 2>/dev/null | sed "s/^/SOCK /"',
      'env | grep -E "^(DOCKER_HOST|CONTAINER_HOST|CONTAINER_CONNECTION|XDG_RUNTIME_DIR)=" | sed "s/^/VAR /"',
      'getent hosts ac-storaged >/dev/null && echo NAME_OK || echo NAME_FAIL',
      'getent hosts host.containers.internal >/dev/null && echo HOSTNAME_OK || echo HOSTNAME_FAIL',
    ].join('; '))
    expect(r.status, r.stderr).toBe('ok')
    expect(r.stdout).not.toMatch(/^(PATH|SOCK|VAR) /m)
    expect(r.stdout).toContain('NAME_FAIL')
    const mounts = JSON.parse(pm('container', 'inspect', '--format', '{{json .Mounts}}', `ac-bot-${a.slug}`) ?? '[]') as { Source: string; Destination: string }[]
    expect(mounts.length).toBeGreaterThan(0)
    for (const m of mounts) {
      expect(m.Source, m.Destination).not.toMatch(/\.sock$|\/run\/podman|\/run\/user\/|docker/)
      expect(m.Destination).toMatch(/^\/(bot|home\/bot|opt)(\/|$)/)
    }
  }, 240_000)

  it("secrets: the server's tokens and LLM keys reach neither the container nor the runner's log", async () => {
    const r = await run(a, 'env; echo ---; tr "\\0" "\\n" < /proc/1/environ 2>/dev/null; echo ---; grep -rs be19sentinel / --exclude-dir=proc --exclude-dir=sys -l 2>/dev/null | head -3')
    expect(r.status, r.stderr).toBe('ok')
    expect(r.stdout).not.toMatch(SENTINEL)
    for (const k of Object.keys(SECRETS)) expect(r.stdout, k).not.toMatch(new RegExp(`^${k}=`, 'm'))
    const env = pm('container', 'inspect', '--format', '{{json .Config.Env}}', `ac-bot-${a.slug}`)
    expect(env).not.toBeNull()
    expect(env).not.toMatch(SENTINEL)
    expect(logs.join('\n')).not.toMatch(SENTINEL)
    expect(r.stderr).not.toMatch(SENTINEL)
  }, 240_000)

  it('resources: a full /tmp gives ENOSPC and the run fails with a clear status', async () => {
    const r = await run(a, 'dd if=/dev/zero of=/tmp/fill bs=1M count=2048 2>&1 | grep -i space; echo "exit=${PIPESTATUS[0]}"; df -m /tmp | tail -1; rm -f /tmp/fill; exit 3')
    expect(r.status).toBe('error')
    expect(r.stdout + r.stderr).toMatch(/No space left on device/)
    expect(r.stdout).toMatch(/exit=1/)
    const after = await run(a, 'touch /tmp/ok && echo fine')
    expect(after.status, after.stderr).toBe('ok')
    expect(after.stdout).toContain('fine')
  }, 240_000)
})
