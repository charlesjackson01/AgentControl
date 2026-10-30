/**
 * BE-P2-4: BotEnvService — each bot's persistent environment (plan §2.2, §3.3, §3.4).
 *
 * Per bot:
 * - container `ac-bot-<slug>` (tini + `sleep infinity`; runs arrive via `exec`), created with the
 *   fixed limits, read-only root, all caps dropped, uid 1000 and `--network none`
 *   (or `ac-egress-<slug>` later; `host` is never allowed).
 * - volumes `ac-tools-<slug>` → /home/bot and `ac-opt-<slug>` → /opt/bot (pip --user, npm -g,
 *   /opt/bot/bin). They outlive container recreates, base upgrades and rollbacks; only Reset drops them.
 * - image `localhost/ac-bot-<slug>:<gen>` built FROM the shared base + `vm.packages`.
 *   Generation 0 means "no layer": the container runs the shared base directly.
 *   The previous generation is kept until the next successful build, so rollback is instant.
 *
 * `ensure()` makes the real state match the stored one: missing volumes are created, a layer
 * built on an older base is rebuilt (base upgrade), and the container is recreated (volumes kept)
 * when its image or config no longer matches. Engine work for one bot is serialized.
 *
 * Everything goes through a CommandRunner (no shell). Env vars are always passed as
 * `--env NAME=VALUE` (a bare `--env NAME` would copy the server's own environment).
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execCommandRunner, type CommandResult, type CommandRunner } from './command-runner.js'
import { fail, failWithReason } from './http.js'
import { MAX_ENV_VALUE_CHARS, MAX_ENV_VARS, VM_LIMITS, type Agent, type AgentVm, type ContainerRuntime, type EnvVar, type ToolManifest } from './shared/types.js'
import { envNameProblem } from './vm-defaults.js'
import { bindMountOptions, checkBotMounts, overlayMountOptions, usernsArgs, volumeMountOptions, type BotMount, type MountAllowList, type UidMapping } from './isolation.js'
import {
  APT_PACKAGE,
  BOT_GID,
  BOT_PATHS,
  BOT_UID,
  BOTVM_VERSION,
  IMAGE_LABELS,
  baseImageFor,
  botContainerName,
  botImageName,
  botImageRef,
  botLayerContainerfile,
  botOptVolume,
  botToolsVolume,
} from './vm-images.js'

/** PATH inside botvm (its Containerfile ENV). PATH_APPEND is added after it. */
export const BOTVM_PATH = '/home/bot/.local/bin:/opt/bot/bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin'
/** The one user env var that isn't passed as is: its folders go after BOTVM_PATH. */
export const PATH_APPEND = 'PATH_APPEND'
/** Extra labels BE-P2-4 sets (besides IMAGE_LABELS). */
export const BOT_ENV_LABELS = {
  /** Image: the exact shared image the layer was built FROM (a different value = base upgraded). */
  from: 'io.agentcontrol.from',
  /** Image: the space-separated apt packages in the layer (rollback reads them back). */
  packages: 'io.agentcontrol.packages',
  /** Container: hash of its create argv (a different value = recreate). */
  config: 'io.agentcontrol.config',
  /** Container (BE-P2-7): the runtime flags it was created for (runsc variants), so stop/rm use them after a change. */
  runtimeFlags: 'io.agentcontrol.runtime-flags',
} as const
export const TMP_SIZE_MB = 512
export const MAX_PACKAGES = 100
export const BUILD_TIMEOUT_MS = 15 * 60_000

export type EngineCli = 'podman' | 'docker'
export interface EngineRef {
  cli: EngineCli
  /** Global args before the verb, e.g. ['--connection', 'agentcontrol'] (Mac/Windows) or a test --root. */
  globalArgs: string[]
  /**
   * Program to run when it isn't `cli` itself (BE-P2-8, tests): e.g. command 'sudo' with
   * globalArgs ['-n', 'podman', '--root', …]. `cli` still names the engine type.
   */
  command?: string
}

export type { BotMount } from './isolation.js'

/** Allowed container networks: none, or the bot's own egress network (BE-P2-9). Never `host`. */
export function checkNetwork(slug: string, network: string): string {
  if (network === 'none' || network === `ac-egress-${slug}`) return network
  throw new Error(`refusing container network ${JSON.stringify(network.slice(0, 40))} for bot ${slug}: only none or ac-egress-${slug}`)
}

function checkMount(m: BotMount): BotMount {
  // --mount is comma-separated key=value; a comma, '=' or newline in a path would change its meaning.
  for (const p of [m.source, m.target]) {
    if (!p || /[,\n\r\0]/.test(p)) throw new Error(`unsafe mount path: ${JSON.stringify(p.slice(0, 120))}`)
  }
  if (!m.target.startsWith('/bot/')) throw new Error(`mount target must be under /bot: ${m.target}`)
  if (m.overlay) {
    // BE-P2-9: `-v src:target:O,upperdir=…,workdir=…` is ':' and ',' separated.
    if (m.readonly) throw new Error(`a read-only mount can't be an overlay: ${m.target}`)
    for (const p of [m.source, m.target, m.overlay.upper, m.overlay.work]) {
      if (!p || !p.startsWith('/') || /[,:\n\r\0=]/.test(p)) throw new Error(`unsafe overlay mount path: ${JSON.stringify(p.slice(0, 120))}`)
    }
  }
  return m
}

export interface CreateArgvOptions {
  slug: string
  image: string
  mounts: BotMount[]
  network?: string
  /** Fixed limits (memory, cpus, pids); off only where the engine can't enforce them (BE-P2-6 probe). */
  enforceLimits?: boolean
  /** BE-P2-7: e.g. 'runsc'. */
  runtime?: ContainerRuntime | null
  /** BE-P2-7: podman global runtime flags it runs with (runsc variants); kept as a label (and in the hash). */
  runtimeFlags?: readonly string[]
  /**
   * BE-P2-5: uid mapping (Podman; see isolation.ts). null/absent = the engine's default (Docker).
   * Part of the config hash, so a changed mapping recreates the container (volumes kept, re-owned by U).
   */
  uidMapping?: UidMapping | null
}

/** `create` argv (after the engine's global args), without the config label. */
export function createArgvBody(o: CreateArgvOptions): string[] {
  const network = checkNetwork(o.slug, o.network ?? 'none')
  const argv = [
    'create',
    '--name', botContainerName(o.slug),
    '--label', `${IMAGE_LABELS.agent}=${o.slug}`,
    '--label', `${IMAGE_LABELS.image}=ac-bot-container`,
    '--user', `${BOT_UID}:${BOT_GID}`,
    '--read-only',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--network', network,
  ]
  if (o.enforceLimits !== false) {
    argv.push('--memory', `${VM_LIMITS.memoryMb}m`, '--memory-swap', `${VM_LIMITS.memoryMb}m`, '--cpus', String(VM_LIMITS.cpus), '--pids-limit', String(VM_LIMITS.pids))
  }
  if (o.runtime) argv.push('--runtime', o.runtime)
  if (o.runtimeFlags?.length) argv.push('--label', `${BOT_ENV_LABELS.runtimeFlags}=${o.runtimeFlags.join(' ')}`)
  const uid = o.uidMapping ?? null
  argv.push(...usernsArgs(uid))
  argv.push(
    '--tmpfs', `${BOT_PATHS.tmp}:rw,nosuid,nodev,size=${TMP_SIZE_MB}m,mode=1777`,
    '--mount', `type=volume,source=${botToolsVolume(o.slug)},destination=${BOT_PATHS.home}${volumeMountOptions(uid)}`,
    '--mount', `type=volume,source=${botOptVolume(o.slug)},destination=${BOT_PATHS.opt}${volumeMountOptions(uid)}`,
  )
  for (const m of o.mounts.map(checkMount)) {
    if (m.overlay) argv.push('-v', `${m.source}:${m.target}:O,upperdir=${m.overlay.upper},workdir=${m.overlay.work}${overlayMountOptions(uid)}`)
    else argv.push('--mount', `type=bind,source=${m.source},destination=${m.target}${m.readonly ? ',readonly' : ''}${bindMountOptions(uid)}`)
  }
  argv.push('--workdir', BOT_PATHS.workspace, o.image)
  return argv
}

/** The full `create` argv with the config-hash label (so a changed config is detected). */
export function createArgv(o: CreateArgvOptions): { argv: string[]; configHash: string } {
  const body = createArgvBody(o)
  const configHash = createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 16)
  const argv = [...body]
  argv.splice(argv.length - 1, 0, '--label', `${BOT_ENV_LABELS.config}=${configHash}`)
  return { argv, configHash }
}

/** Problem with an env list (PATCH /vm), or null. */
export function envListProblem(env: unknown): string | null {
  if (!Array.isArray(env)) return '"env" must be a list of {name, value}.'
  if (env.length > MAX_ENV_VARS) return `At most ${MAX_ENV_VARS} variables per bot.`
  const seen = new Set<string>()
  for (const e of env as unknown[]) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return 'Each variable must be {"name": "...", "value": "..."}.'
    const { name, value, ...rest } = e as Record<string, unknown>
    if (Object.keys(rest).length) return `Unknown field "${Object.keys(rest)[0]!.slice(0, 40)}" in a variable.`
    if (typeof name !== 'string' || typeof value !== 'string') return 'Each variable needs a text "name" and "value".'
    const problem = envNameProblem(name)
    if (problem) return problem
    if (value.length > MAX_ENV_VALUE_CHARS) return `"${name}" is too long (at most ${MAX_ENV_VALUE_CHARS} characters).`
    if (value.includes('\0')) return `"${name}" contains a null character.`
    if (seen.has(name)) return `"${name}" is listed twice.`
    seen.add(name)
  }
  return null
}

/** `--env NAME=VALUE` pairs for a run. PATH_APPEND extends PATH; reserved names are dropped (defense in depth). */
export function envArgs(env: readonly EnvVar[], extra: readonly EnvVar[] = []): string[] {
  const out: string[] = []
  for (const e of env) {
    if (e.name === PATH_APPEND) {
      const add = e.value.split(':').filter((p) => p.startsWith('/'))
      if (add.length) out.push('--env', `PATH=${BOTVM_PATH}:${add.join(':')}`)
      continue
    }
    if (envNameProblem(e.name) !== null || e.value.includes('\0')) continue
    out.push('--env', `${e.name}=${e.value}`)
  }
  // AgentControl's own (AC_*, proxies in M2) go last so they win.
  for (const e of extra) out.push('--env', `${e.name}=${e.value}`)
  return out
}

/** A run's working dir: /bot/workspace or /bot/groups/<slug> (and below). */
export function checkCwd(cwd: string): string {
  const norm = path.posix.normalize(cwd)
  if (norm !== cwd.replace(/\/+$/, '') || !(norm === BOT_PATHS.workspace || norm.startsWith(`${BOT_PATHS.workspace}/`) || norm.startsWith(`${BOT_PATHS.groups}/`))) {
    throw new Error(`run cwd must be under /bot/workspace or /bot/groups: ${JSON.stringify(cwd.slice(0, 120))}`)
  }
  return norm
}

export interface ExecArgvOptions {
  slug: string
  argv: string[]
  env: readonly EnvVar[]
  extraEnv?: readonly EnvVar[]
  cwd?: string
  interactive?: boolean
}
/** `exec` argv (after the engine's global args). */
export function execArgv(o: ExecArgvOptions): string[] {
  if (!o.argv.length) throw new Error('empty argv')
  return [
    'exec',
    ...(o.interactive ? ['--interactive'] : []),
    '--user', `${BOT_UID}:${BOT_GID}`,
    '--workdir', checkCwd(o.cwd ?? BOT_PATHS.workspace),
    ...envArgs(o.env, o.extraEnv),
    botContainerName(o.slug),
    ...o.argv,
  ]
}

/** The per-bot layer Containerfile plus the labels BE-P2-4 reads back. */
export function layerContainerfile(slug: string, generation: number, base: AgentVm['image']['base'], packages: readonly string[], version: string): string {
  const pkgs = [...new Set(packages)].sort()
  const from = baseImageFor(base, version)
  return botLayerContainerfile({ slug, generation, base, packages: pkgs, version }) + `LABEL ${BOT_ENV_LABELS.from}="${from}" ${BOT_ENV_LABELS.packages}="${pkgs.join(' ')}"\n`
}

// ───────────────────────── service ─────────────────────────

export interface BotEnvDeps {
  exec?: CommandRunner
  /** Which engine to drive, or null when none is installed. */
  engine: () => Promise<EngineRef | null>
  /** Shared image version in use (BOTVM_VERSION; tests use a fake one for base upgrades). */
  baseVersion?: () => string
  /** Bind mounts for the bot (workspace rw, inputs ro, groups rw, skills ro). */
  mounts: (agent: Agent) => BotMount[]
  /** False only when the engine refuses the cgroup limit flags (BE-P2-8 probe: limitsAccepted; default true). */
  enforceLimits?: () => boolean
  runtime?: (agent: Agent) => ContainerRuntime | null
  /** BE-P2-5: the uid mapping the probe chose for this bot's runtime (Podman); null for Docker. */
  uidMapping?: (agent: Agent) => UidMapping | null
  /**
   * BE-P2-5: what this bot may mount. Every mount from `mounts` is checked against it (symlinks
   * resolved) before the engine is called; a mismatch throws 500 mount_refused. Required for
   * production wiring; tests may omit it.
   */
  allowedMounts?: (agent: Agent) => MountAllowList
  /**
   * Runtime flags passed as engine global args on start/stop/exec (BE-P2-8: runsc variants such
   * as --runtime-flag=ignore-cgroups). Podman doesn't store them in the container.
   */
  runtimeFlags?: (agent: Agent) => string[]
  /**
   * BE-P2-7: the force_on message when gVisor is required for this bot but unavailable, else null.
   * Then ensure/start refuse (409 reason 'gvisor_unavailable') before any engine call, so no
   * container is created or started on the standard runtime instead.
   */
  runtimeBlocked?: (agent: Agent) => string | null
  /** Network for tool builds (apt). Never 'host'. M1: 'none' (no internet yet). */
  buildNetwork?: () => 'none' | 'default'
  /** Persist a changed Agent.vm; false when the save failed. */
  saveVm: (agentId: string, vm: AgentVm) => boolean
  /** Runs queued/running for this bot right now (BE-P2-8 wires the real count). */
  activeRuns?: (agentId: string) => number
  now?: () => Date
  log?: (msg: string) => void
}

export type ContainerState = 'missing' | 'running' | 'stopped'
export interface ContainerStatus {
  state: ContainerState
  imageId?: string
  configHash?: string
  /** BE-P2-7: the runtime flags it was created for (empty: none). */
  runtimeFlags?: string[]
}

export interface BuildResult {
  vm: AgentVm
  generation: number
  /** Last 64 KB of the build output. */
  log: string
}

export interface BotEnvService {
  status(agent: Agent): Promise<ContainerStatus>
  /**
   * Make volumes, layer and container match Agent.vm; start it when `start`. Returns the (maybe
   * updated) vm. A changed image or config (e.g. runtime) recreates the container, except while a
   * run is active in it. `forRun` (BE-P2-7): the caller is the bot's run about to start (runs are
   * one at a time per bot), so nothing else runs in the container and it may be recreated.
   */
  ensure(agent: Agent, opts?: { start?: boolean; forRun?: boolean }): Promise<AgentVm>
  start(agent: Agent): Promise<AgentVm>
  stop(agent: Agent): Promise<void>
  /** Run a command in the (started) container; for the tool manifest, probes and tests. BE-P2-8 streams its own. */
  exec(agent: Agent, argv: string[], opts?: { cwd?: string; timeoutMs?: number; extraEnv?: EnvVar[] }): Promise<CommandResult>
  /** vm_install: add apt packages → build gen+1. The container picks it up at the next ensure (idle). */
  vmInstall(agent: Agent, packages: unknown): Promise<BuildResult>
  /** Rebuild the layer from vm.packages on the current base (gen+1). */
  rebuild(agent: Agent): Promise<BuildResult>
  /** Back to the previous generation (409 no_previous_generation when there is none). */
  rollback(agent: Agent): Promise<AgentVm>
  /** M1 Reset: container, both volumes and the layer go; files, env and history stay. No backup. */
  reset(agent: Agent): Promise<AgentVm>
  /** Re-read pip/npm/opt-bin from the container and store it in vm.tools. */
  refreshTools(agent: Agent): Promise<AgentVm>
}

const lastLine = (r: CommandResult) =>
  (r.stderr || r.stdout).trim().split('\n').filter(Boolean).pop()?.slice(0, 300) ?? `exit code ${r.code}`
const tail = (s: string, n = 64 * 1024) => (s.length > n ? s.slice(-n) : s)
const noSuch = (r: CommandResult) => /no such|not found|not known|does not exist|no container with/i.test(r.stderr + r.stdout)

function parseInspect(stdout: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(stdout) as unknown
    const first = Array.isArray(v) ? v[0] : v
    return first && typeof first === 'object' ? (first as Record<string, unknown>) : null
  } catch {
    return null
  }
}
const stripSha = (id: unknown) => (typeof id === 'string' ? id.replace(/^sha256:/, '') : undefined)
function labelsOf(obj: Record<string, unknown>): Record<string, string> {
  const direct = obj.Labels
  const config = (obj.Config as { Labels?: unknown } | undefined)?.Labels
  const raw = (direct && typeof direct === 'object' ? direct : config && typeof config === 'object' ? config : {}) as Record<string, unknown>
  return Object.fromEntries(Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === 'string'))
}

export function createBotEnvService(deps: BotEnvDeps): BotEnvService {
  const run = deps.exec ?? execCommandRunner
  const baseVersion = deps.baseVersion ?? (() => BOTVM_VERSION)
  const enforceLimits = deps.enforceLimits ?? (() => true)
  const buildNetwork = deps.buildNetwork ?? (() => 'none' as const)
  const activeRuns = deps.activeRuns ?? (() => 0)
  const now = deps.now ?? (() => new Date())
  const log = deps.log ?? (() => {})
  const locks = new Map<string, Promise<unknown>>()
  const rtFlags = (agent: Agent) => deps.runtimeFlags?.(agent) ?? []

  /** One engine operation at a time per bot. */
  function serial<T>(slug: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(slug) ?? Promise.resolve()
    const next = prev.catch(() => {}).then(fn)
    locks.set(slug, next)
    void next.finally(() => { if (locks.get(slug) === next) locks.delete(slug) }).catch(() => {})
    return next
  }

  async function engine(): Promise<EngineRef> {
    const e = await deps.engine()
    if (!e) failWithReason(409, 'engine_missing', 'Podman isn\'t installed yet. Finish the setup steps in Settings › VMs first.')
    return e
  }
  async function cli(args: string[], timeoutMs = 60_000): Promise<CommandResult> {
    const e = await engine()
    const r = await run(e.command ?? e.cli, [...e.globalArgs, ...args], { timeoutMs })
    if (r.code === 127) failWithReason(409, 'engine_missing', 'Podman isn\'t installed yet. Finish the setup steps in Settings › VMs first.')
    return r
  }
  async function must(args: string[], what: string, timeoutMs?: number): Promise<CommandResult> {
    const r = await cli(args, timeoutMs)
    if (r.code !== 0) fail(502, `Couldn't ${what}: ${lastLine(r)}`)
    return r
  }
  function save(agent: Agent, vm: AgentVm): AgentVm {
    if (!deps.saveVm(agent.id, vm)) fail(500, 'Couldn\'t save the bot\'s VM settings.')
    agent.vm = vm
    return vm
  }

  async function containerStatus(slug: string): Promise<ContainerStatus> {
    const r = await cli(['container', 'inspect', botContainerName(slug)])
    if (r.code !== 0) {
      if (noSuch(r) || r.code === 125) return { state: 'missing' }
      fail(502, `Couldn't check the bot's VM: ${lastLine(r)}`)
    }
    const c = parseInspect(r.stdout)
    if (!c) fail(502, 'Couldn\'t read the bot\'s VM state from the engine.')
    const st = (c.State as { Status?: unknown; Running?: unknown } | undefined) ?? {}
    const running = st.Running === true || st.Status === 'running'
    const labels = labelsOf(c)
    return {
      state: running ? 'running' : 'stopped',
      imageId: stripSha(c.Image),
      configHash: labels[BOT_ENV_LABELS.config],
      // No label: created before BE-P2-7 or with no flags (undefined: unknown).
      ...(labels[BOT_ENV_LABELS.runtimeFlags] !== undefined
        ? { runtimeFlags: labels[BOT_ENV_LABELS.runtimeFlags]!.split(' ').filter((f) => /^--runtime-flag=[\w.=-]+$/.test(f)) }
        : {}),
    }
  }
  async function imageInfo(ref: string): Promise<{ id: string; labels: Record<string, string> } | null> {
    const r = await cli(['image', 'inspect', ref])
    if (r.code !== 0) return null
    const i = parseInspect(r.stdout)
    const id = i && stripSha(i.Id)
    return i && id ? { id, labels: labelsOf(i) } : null
  }
  async function ensureVolume(name: string, slug: string): Promise<void> {
    const r = await cli(['volume', 'inspect', name])
    if (r.code === 0) return
    await must(['volume', 'create', '--label', `${IMAGE_LABELS.agent}=${slug}`, name], 'create the bot\'s tools volume')
  }
  async function removeImage(ref: string): Promise<void> {
    const r = await cli(['rmi', ref])
    if (r.code !== 0 && !noSuch(r)) log(`bot-env: couldn't remove ${ref}: ${lastLine(r)}`)
  }

  /** Build `gen` of the layer; returns the build log. Throws 502 with the last line on failure. */
  async function build(slug: string, generation: number, base: AgentVm['image']['base'], packages: readonly string[]): Promise<string> {
    const e = await engine()
    const dir = mkdtempSync(path.join(tmpdir(), `ac-bot-${slug}-`))
    try {
      const file = path.join(dir, 'Containerfile')
      writeFileSync(file, layerContainerfile(slug, generation, base, packages, baseVersion()))
      const net = buildNetwork()
      if ((net as string) === 'host') throw new Error('build network host is never allowed')
      // 'default' = the engine's normal build network (M2+, through the egress proxy); 'host' is never used.
      const args = ['build', '--file', file, '--tag', botImageRef(slug, generation), ...(net === 'none' ? ['--network', 'none'] : [])]
      if (e.cli === 'podman') args.push('--pull=never')
      args.push(dir)
      const r = await run(e.command ?? e.cli, [...e.globalArgs, ...args], { timeoutMs: BUILD_TIMEOUT_MS })
      const out = tail(`${r.stdout}${r.stderr ? `\n${r.stderr}` : ''}`)
      if (r.code !== 0) {
        await removeImage(botImageRef(slug, generation))
        const err = new Error(`The tool build failed: ${lastLine(r)}`) as Error & { statusCode: number; reason: string; buildLog: string }
        err.statusCode = 502
        err.reason = 'build_failed'
        err.buildLog = out
        throw err
      }
      return out
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  /** Build gen+1 from `packages`; keep the current one as previous, drop the one before. */
  async function buildNext(agent: Agent, packages: string[]): Promise<BuildResult> {
    const slug = agent.slug
    const cur = agent.vm.image
    const generation = cur.generation + 1
    const out = await build(slug, generation, cur.base, packages)
    const vm = save(agent, { ...agent.vm, packages: [...new Set(packages)].sort(), image: { generation, previous: cur.generation, builtAt: now().toISOString(), base: cur.base } })
    await pruneImages(slug, [generation, cur.generation])
    return { vm, generation, log: out }
  }

  /** Remove this bot's layer images except the given generations (one in use by the container just fails; next time). */
  async function pruneImages(slug: string, keep: readonly (number | undefined)[]): Promise<void> {
    const ls = await cli(['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}', '--filter', `reference=${botImageName(slug)}`])
    if (ls.code !== 0) return
    const keepRefs = new Set(keep.filter((g): g is number => g !== undefined && g > 0).map((g) => botImageRef(slug, g)))
    for (const ref of ls.stdout.split('\n').map((x) => x.trim())) {
      if (ref.startsWith(`${botImageName(slug)}:`) && !keepRefs.has(ref)) await removeImage(ref)
    }
  }

  /** The image the container should run; rebuilds a layer whose base is outdated (or missing). */
  async function desiredImage(agent: Agent): Promise<string> {
    const vm = agent.vm
    const from = baseImageFor(vm.image.base, baseVersion())
    if (vm.image.generation === 0) {
      if (!(await imageInfo(from))) failWithReason(409, 'image_missing', `The bot image ${from} isn't built yet. Finish the setup steps in Settings › VMs first.`)
      return from
    }
    const ref = botImageRef(agent.slug, vm.image.generation)
    const have = await imageInfo(ref)
    if (have && have.labels[BOT_ENV_LABELS.from] === from) return ref
    // A generation reached by rollback (no `previous`) stays on the base it was built on until
    // the next build; otherwise the base-upgrade rebuild would undo the rollback right away.
    if (have && vm.image.previous === undefined) return ref
    // Base upgrade (or a lost layer): rebuild from vm.packages as a new generation. Volumes stay.
    try {
      log(`bot-env: ${agent.slug}: ${have ? 'base changed' : 'layer missing'}, rebuilding from ${from}`)
      const res = await buildNext(agent, vm.packages)
      return botImageRef(agent.slug, res.generation)
    } catch (err) {
      if (have) {
        log(`bot-env: ${agent.slug}: rebuild on the new base failed, keeping generation ${vm.image.generation}: ${(err as Error).message}`)
        return ref
      }
      throw err
    }
  }

  async function ensureLocked(agent: Agent, start: boolean, forRun = false): Promise<AgentVm> {
    const slug = agent.slug
    // BE-P2-7: gVisor required but unavailable: never fall back to the standard runtime.
    const rtBlock = deps.runtimeBlocked?.(agent)
    if (rtBlock) failWithReason(409, 'gvisor_unavailable', rtBlock)
    // Mount guard first: nothing reaches the engine for a mount outside the bot's allow-list.
    const mounts = deps.allowedMounts ? checkBotMounts(deps.mounts(agent), deps.allowedMounts(agent)) : deps.mounts(agent)
    await ensureVolume(botToolsVolume(slug), slug)
    await ensureVolume(botOptVolume(slug), slug)
    const image = await desiredImage(agent)
    const img = await imageInfo(image)
    if (!img) fail(502, `The bot image ${image} disappeared while starting.`)
    const { argv, configHash } = createArgv({
      slug,
      image,
      mounts,
      network: 'none',
      enforceLimits: enforceLimits(),
      runtime: deps.runtime?.(agent) ?? null,
      runtimeFlags: rtFlags(agent),
      uidMapping: deps.uidMapping?.(agent) ?? null,
    })
    let st = await containerStatus(slug)
    if (st.state !== 'missing' && (st.imageId !== img.id || st.configHash !== configHash)) {
      if (!forRun && activeRuns(agent.id) > 0 && st.state === 'running') {
        // Not idle: keep the current container; the next ensure at idle recreates it.
        return agent.vm
      }
      log(`bot-env: ${slug}: recreating the container (${st.imageId !== img.id ? 'new image' : 'new config'}; volumes kept)`)
      // With the flags it was created for (a runsc container may need e.g. ignore-cgroups to be removed).
      await must([...(st.runtimeFlags ?? []), 'rm', '--force', botContainerName(slug)], 'remove the old container')
      st = { state: 'missing' }
    }
    if (st.state === 'missing') {
      await must(argv, 'create the bot\'s VM')
      await pruneImages(slug, [agent.vm.image.generation, agent.vm.image.previous])
    }
    if (start && st.state !== 'running') await must([...rtFlags(agent), 'start', botContainerName(slug)], 'start the bot\'s VM')
    return agent.vm
  }

  async function exec(agent: Agent, argv: string[], opts: { cwd?: string; timeoutMs?: number; extraEnv?: EnvVar[] } = {}): Promise<CommandResult> {
    return cli([...rtFlags(agent), ...execArgv({ slug: agent.slug, argv, env: agent.vm.env, extraEnv: opts.extraEnv, cwd: opts.cwd })], opts.timeoutMs ?? 60_000)
  }

  return {
    status: (agent) => containerStatus(agent.slug),
    ensure: (agent, opts = {}) => serial(agent.slug, () => ensureLocked(agent, opts.start === true, opts.forRun === true)),
    start: (agent) => serial(agent.slug, () => ensureLocked(agent, true)),
    stop: (agent) =>
      serial(agent.slug, async () => {
        const st = await containerStatus(agent.slug)
        // The flags it was created for (the bot's runtime may have changed since).
        if (st.state === 'running') await must([...(st.runtimeFlags ?? rtFlags(agent)), 'stop', '--time', '10', botContainerName(agent.slug)], 'stop the bot\'s VM', 30_000)
      }),
    exec,

    vmInstall: (agent, raw) =>
      serial(agent.slug, async () => {
        const list = Array.isArray(raw) ? raw : [raw]
        if (!list.length || list.some((p) => typeof p !== 'string' || !APT_PACKAGE.test(p))) {
          fail(400, 'Give Debian package names, e.g. ["ffmpeg"] (lowercase letters, digits, + . -).')
        }
        const packages = [...new Set([...agent.vm.packages, ...(list as string[])])].sort()
        if (packages.length > MAX_PACKAGES) fail(400, `At most ${MAX_PACKAGES} system packages per bot.`)
        if (packages.length === agent.vm.packages.length) return { vm: agent.vm, generation: agent.vm.image.generation, log: 'Already installed.' }
        if (agent.internetPolicy === 'never') failWithReason(409, 'internet_never', 'Installing system packages needs the internet, and this bot is set to never use it.')
        if (buildNetwork() === 'none') failWithReason(409, 'internet_unavailable', 'Installing system packages needs internet access, which isn\'t available yet.')
        return buildNext(agent, packages)
      }),

    rebuild: (agent) =>
      serial(agent.slug, async () => {
        if (agent.vm.packages.length && buildNetwork() === 'none') failWithReason(409, 'internet_unavailable', 'Rebuilding system packages needs internet access, which isn\'t available yet.')
        return buildNext(agent, agent.vm.packages)
      }),

    rollback: (agent) =>
      serial(agent.slug, async () => {
        const cur = agent.vm.image
        if (cur.previous === undefined || cur.previous >= cur.generation) failWithReason(409, 'no_previous_generation', 'There is no earlier version of the bot\'s tools to go back to.')
        if (activeRuns(agent.id) > 0) failWithReason(409, 'run_active', 'Wait for the bot\'s run to finish first.')
        let packages: string[] = []
        if (cur.previous > 0) {
          const prev = await imageInfo(botImageRef(agent.slug, cur.previous))
          if (!prev) failWithReason(409, 'no_previous_generation', 'The earlier version of the bot\'s tools is gone.')
          packages = (prev.labels[BOT_ENV_LABELS.packages] ?? '').split(' ').filter((p) => APT_PACKAGE.test(p))
        }
        const vm = save(agent, { ...agent.vm, packages, image: { generation: cur.previous, base: cur.base, builtAt: now().toISOString() } })
        const wasRunning = (await containerStatus(agent.slug)).state === 'running'
        await ensureLocked(agent, wasRunning)
        await removeImage(botImageRef(agent.slug, cur.generation))
        return vm
      }),

    reset: (agent) =>
      serial(agent.slug, async () => {
        if (activeRuns(agent.id) > 0) failWithReason(409, 'run_active', 'Wait for the bot\'s run to finish (or stop it) before resetting.')
        const slug = agent.slug
        const rm = await cli(['rm', '--force', botContainerName(slug)], 30_000)
        if (rm.code !== 0 && !noSuch(rm)) fail(502, `Couldn't remove the bot's VM: ${lastLine(rm)}`)
        for (const v of [botToolsVolume(slug), botOptVolume(slug)]) {
          const r = await cli(['volume', 'rm', '--force', v])
          if (r.code !== 0 && !noSuch(r)) fail(502, `Couldn't remove the bot's tools: ${lastLine(r)}`)
        }
        const ls = await cli(['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}', '--filter', `reference=${botImageName(slug)}`])
        const refs = new Set(ls.code === 0 ? ls.stdout.split('\n').map((s) => s.trim()).filter((s) => s.startsWith(`${botImageName(slug)}:`)) : [])
        for (const g of [agent.vm.image.generation, agent.vm.image.previous]) if (g) refs.add(botImageRef(slug, g))
        for (const ref of refs) await removeImage(ref)
        const vm = save(agent, { ...agent.vm, packages: [], tools: undefined, image: { generation: 0, base: agent.vm.image.base } })
        // Fresh, stopped container on the plain base; files, env and history were never touched.
        await ensureLocked(agent, false)
        return vm
      }),

    refreshTools: (agent) =>
      serial(agent.slug, async () => {
        await ensureLocked(agent, true)
        const lines = (r: CommandResult) => (r.code === 0 ? r.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : [])
        const pip = lines(await exec(agent, ['python3', '-m', 'pip', 'list', '--user', '--format=freeze', '--disable-pip-version-check']))
        const npmR = await exec(agent, ['npm', 'ls', '-g', '--depth=0', '--json'])
        let npm: string[] = []
        try {
          const deps = (JSON.parse(npmR.stdout || '{}') as { dependencies?: Record<string, { version?: string }> }).dependencies ?? {}
          npm = Object.entries(deps).map(([n, d]) => (d.version ? `${n}@${d.version}` : n)).sort()
        } catch {
          npm = []
        }
        const optBin = lines(await exec(agent, ['ls', '-1A', BOT_PATHS.optBin])).sort()
        const tools: ToolManifest = { pip: pip.sort(), npm, optBin, updatedAt: now().toISOString() }
        return save(agent, { ...agent.vm, tools })
      }),
  }
}
