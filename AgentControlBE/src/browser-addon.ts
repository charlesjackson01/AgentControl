/**
 * BE-P2-15: the browser add-on (contract "BE-P2-15 Browser add-on").
 *
 * - The shared `botvm-browser` "download" is AgentControl's own pinned image, built from
 *   vm/images/versions.env with `imageBuildArgv('botvm-browser')` on the server (never through a
 *   bot's proxy credential). There is no registry in M1, so there is no prebuilt digest to pull.
 * - Per bot, turning the browser on runs: low-disk check, the shared download (or `reused`), a
 *   `tool_build` run (`via:'browser'`, `base:'browser'`), `waiting_idle` (the container is recreated
 *   once the bot's current run ends), then the real Chromium check on the bot's own image. Ready
 *   releases the runs waiting for the browser (PermissionGate.browserReady); a failure ends them.
 * - Turning off rebuilds the bot back onto the base when idle (`via:'browser'`, `base:'base'`); during
 *   a setup it cancels it (the setup's build is stopped).
 * - State (shared + per bot) is kept in <data>/browser/state.json so a restart resumes a setup.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { EngineRef } from './bot-env.js'
import { execCommandRunner, type CommandResult, type CommandRunner } from './command-runner.js'
import { fail, failWithReason } from './http.js'
import type { BrowserSetupStatus } from './permission-gate.js'
import { LOW_DISK_REASON, LOW_DISK_TEXT, RUN_FREE_FLOOR_BYTES } from './run-service.js'
import type {
  Agent,
  BotBrowserInfo,
  BrowserAddonInfo,
  BrowserError,
  BrowserSetup,
  BrowserState,
  LiveEvent,
  PermissionRequest,
  ScriptRun,
} from './shared/types.js'
import { BOT_ENV_LABELS } from './bot-env.js'
import { baseImageFor, botImageRef, imageBuildArgv, SHARED_IMAGE_APPROX_BYTES, sharedImageRef } from './vm-images.js'

/** PATCH / create 409 internet_never (contract BE-P2-15; the browser-base rebuild re-installs the packages). */
export const BROWSER_INTERNET_NEVER_TEXT = 'Set internet to Ask or Always to install packages.'
export const NOTHING_TO_RETRY_TEXT = "There's nothing to retry."
export const BROWSER_BUSY_TEXT = 'The Chromium download is in progress. Wait for it to finish first.'
export const browserInUseText = (names: string[]) => `Turn off the browser for every bot first (used by ${names.join(', ')}).`
export const downloadFailedText = (mb: number, cause: string) => `The Chromium download stopped at ${mb} MB (${cause}).`
export const checkFailedText = (cause: string) => `Chromium was installed but didn't start (${cause}).`
/** The download: about 1.3 GB (SHARED_IMAGE_APPROX_BYTES; there is no real size before it is built). */
export const BROWSER_DOWNLOAD_BYTES = SHARED_IMAGE_APPROX_BYTES['botvm-browser']
/** Building botvm-browser (npx playwright install) takes a while; past this it ends download_failed. */
export const BROWSER_DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000
const TICK_MS = 1000
const IDLE_POLL_MS = 1000
const PRESENT_CACHE_MS = 5000

/** "0.6 GB": free bytes ÷ 1024³, one decimal, rounded down (never overstates the space). */
export function freeGbText(freeBytes: number): string {
  return `${(Math.floor((Math.max(0, freeBytes) / 1024 ** 3) * 10) / 10).toFixed(1)} GB`
}

/** The low-disk refusal for a turn-on (null: enough space). `reused`: the download is already there. */
export function lowDiskProblem(freeBytes: number | null, reused: boolean): { message: string; neededBytes: number; freeBytes: number } | null {
  if (freeBytes === null) return null
  if (reused) return freeBytes < RUN_FREE_FLOOR_BYTES ? { message: LOW_DISK_TEXT, neededBytes: RUN_FREE_FLOOR_BYTES, freeBytes } : null
  const needed = BROWSER_DOWNLOAD_BYTES + RUN_FREE_FLOOR_BYTES
  if (freeBytes < BROWSER_DOWNLOAD_BYTES) {
    return { message: `The download needs about 1.3 GB and this computer has ${freeGbText(freeBytes)} free. Free some space, then try again.`, neededBytes: needed, freeBytes }
  }
  if (freeBytes < needed) {
    return { message: `The download needs about 1.3 GB, plus 3 GB kept free for runs, and this computer has ${freeGbText(freeBytes)} free.`, neededBytes: needed, freeBytes }
  }
  return null
}

/** A short plain cause from engine output ("connection reset"), and the longer detail. */
export function downloadCause(r: CommandResult): { cause: string; detail: string } {
  const text = `${r.stderr}\n${r.stdout}`
  const last = text.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? ''
  const detail = last.slice(0, 300)
  if (r.code === 124) return { cause: 'timed out', detail: detail || 'the download took longer than 30 minutes' }
  if (/connection reset/i.test(text)) return { cause: 'connection reset', detail }
  if (/no space left/i.test(text)) return { cause: 'out of disk space', detail }
  if (/temporary failure in name resolution|could not resolve|no such host|network is unreachable|timed? ?out/i.test(text)) return { cause: 'no connection', detail }
  if (r.code === 127) return { cause: 'no container engine', detail: detail || 'Podman or Docker isn\'t installed' }
  return { cause: 'the image build failed', detail }
}

/** "missing shared library" / "libnss3.so missing" from the Chromium check's error. */
export function checkCause(error: string): { cause: string; detail: string } {
  const lib = /([\w.+-]+\.so(?:\.[\d.]+)?): cannot open shared object file/.exec(error)
  if (lib) return { cause: 'missing shared library', detail: `${lib[1]} missing` }
  const detail = error.trim().slice(0, 300) || 'no details'
  if (/timed? ?out|timeout/i.test(error)) return { cause: 'it timed out', detail }
  return { cause: detail.length > 60 ? `${detail.slice(0, 59)}…` : detail, detail }
}

export type ChromiumCheck = { ok: true; version: string } | { ok: false; error: string }

export interface BrowserAddonDeps {
  dataDir(): string
  getAgent(id: string): Agent | undefined
  agents(): Agent[]
  /** Save permissions.browser for the bot (throws when the store can't save). */
  saveBrowser(agentId: string, on: boolean): void
  engine(): Promise<EngineRef | null>
  exec?: CommandRunner
  /** Free bytes where the images and bots' files live (null: unknown, not checked). */
  freeBytes(): Promise<number | null>
  /** RunService.startToolBuild for the on/off rebuild (409s are thrown). */
  startBuild(agent: Agent, base: 'base' | 'browser', where: { conversationId?: string }): Promise<ScriptRun>
  waitRun(runId: string): Promise<ScriptRun>
  stopRun(runId: string): Promise<unknown>
  /** The bot's build (any kind) that's active now, to wait for before starting ours. */
  activeBuildRunId(agentId: string): string | null
  /** Runs running in the bot's container now (the waiting_idle step waits for 0). */
  busy(agentId: string): number
  /** Recreate the bot's container on its new image (BotEnvService.ensure at idle). */
  recreate(agent: Agent): Promise<void>
  /** The real Chromium check on the bot's own image. */
  chromiumCheck(agent: Agent): Promise<ChromiumCheck>
  gate?: {
    browserReady(agentId: string): Promise<void>
    browserFailed(agentId: string, reason: 'browser_unavailable' | 'chromium_check_failed'): void
    updateSetup(requestId: string, setup: BrowserSetup | undefined, setupError?: BrowserError): void
  }
  publish(event: LiveEvent): void
  /** vm.updated for the bot (VmInfo.browser changed). */
  vmChanged(agentId: string): void
  /** The probe's feature set changed (chromium on/off). */
  featuresChanged?(): void
  now?(): Date
  log?(msg: string): void
  tickMs?: number
  idlePollMs?: number
}

interface BotState {
  info: BotBrowserInfo
  /** The bot's image is (or may still be) on the browser base after a turn-off; the off-rebuild is due. */
  offPending?: boolean
  /** The off-rebuild failed (retry with {agentId}). */
  offFailed?: string
}

interface Saved {
  version: 1
  shared: { error?: BrowserError; readyAt?: string }
  bots: Record<string, BotState>
}

export interface BrowserAddon {
  /** GET /api/vm/browser (checks the image is there). */
  info(): Promise<BrowserAddonInfo>
  /** In-memory state for VmInfo.permissions.browserState / progress. */
  sharedState(): { state: BrowserState; progress?: number }
  /** VmInfo.browser (absent when the bot never had the browser). */
  botInfo(agentId: string): BotBrowserInfo | undefined
  /** PATCH / create: 409 internet_never / low_disk before a change is saved. `policy`: the policy it will have. */
  checkChange(agent: Agent, on: boolean, policy?: Agent['internetPolicy']): Promise<void>
  /** After a saved change of permissions.browser (PATCH, create). */
  changed(agentId: string, on: boolean): void
  /** The gate's hooks (card enable; run admit). */
  enable(agentId: string, request: PermissionRequest): void
  status(agentId: string): BrowserSetupStatus
  retry(agentId?: string): Promise<BrowserAddonInfo>
  remove(): Promise<BrowserAddonInfo>
  /** The bot was deleted: forget it. */
  agentDeleted(agentId: string): void
  /** On start: resume setups and off-rebuilds a restart interrupted. */
  recover(): void
  /** Settles when no setup, download or off-rebuild is in flight (tests). */
  idle(): Promise<void>
  close(): void
}

export function createBrowserAddon(deps: BrowserAddonDeps): BrowserAddon {
  const run = deps.exec ?? execCommandRunner
  const now = () => (deps.now ? deps.now() : new Date())
  const log = deps.log ?? (() => {})
  const tickMs = deps.tickMs ?? TICK_MS
  const idlePollMs = deps.idlePollMs ?? IDLE_POLL_MS
  let saved: Saved | null = null
  let closed = false
  /** Per bot: a counter; a setup / off-rebuild whose token is stale stops at its next step. */
  const tokens = new Map<string, number>()
  /** Per bot: the build the setup / off-rebuild is waiting on (stopped by a turn-off). */
  const buildOf = new Map<string, string>()
  const inflight = new Set<Promise<unknown>>()
  interface Download { promise: Promise<boolean>; startedAt: number; step: number; steps: number; timer?: ReturnType<typeof setInterval> }
  let download = null as Download | null
  let present: { value: boolean; at: number } | null = null

  const file = () => join(deps.dataDir(), 'browser', 'state.json')
  function load(): Saved {
    if (saved) return saved
    saved = { version: 1, shared: {}, bots: {} }
    try {
      if (existsSync(file())) {
        const v = JSON.parse(readFileSync(file(), 'utf8')) as Partial<Saved>
        if (v && v.version === 1) saved = { version: 1, shared: v.shared ?? {}, bots: v.bots ?? {} }
      }
    } catch (err) {
      log(`browser: couldn't read ${file()}: ${(err as Error).message}`)
    }
    return saved
  }
  function persist(): void {
    try {
      mkdirSync(join(deps.dataDir(), 'browser'), { recursive: true })
      const tmp = `${file()}.tmp`
      writeFileSync(tmp, JSON.stringify(load(), null, 2))
      renameSync(tmp, file())
    } catch (err) {
      log(`browser: couldn't save ${file()}: ${(err as Error).message}`)
    }
  }
  const track = <T>(p: Promise<T>): Promise<T> => {
    inflight.add(p)
    void p.finally(() => inflight.delete(p)).catch(() => {})
    return p
  }
  const nameOf = (agentId: string) => deps.getAgent(agentId)?.name ?? 'The bot'
  const iso = () => now().toISOString()

  async function cli(args: string[], timeoutMs = 60_000, opts: { onOutput?: (s: 'stdout' | 'stderr', c: string) => void } = {}): Promise<CommandResult> {
    const e = await deps.engine().catch(() => null)
    if (!e) return { code: 127, stdout: '', stderr: 'no container engine' }
    return run(e.command ?? e.cli, [...e.globalArgs, ...args], { timeoutMs, ...(opts.onOutput ? { onOutput: opts.onOutput } : {}) })
  }
  async function imagePresent(fresh = false): Promise<boolean> {
    if (!fresh && present && Date.now() - present.at < PRESENT_CACHE_MS) return present.value
    const r = await cli(['image', 'inspect', '--format', '{{.Id}}', sharedImageRef('botvm-browser')], 30_000)
    present = { value: r.code === 0, at: Date.now() }
    return present.value
  }

  function usedBy(): string[] {
    const s = load()
    return deps
      .agents()
      .filter((a) => a.vm.permissions.browser || a.vm.image.base === 'browser' || s.bots[a.id]?.offPending)
      .map((a) => a.id)
  }
  function progressNow(): { progress: number; bytes: number; etaSec?: number } | null {
    if (!download) return null
    // Estimated from the build's steps (podman build has no byte counter for the browser layer).
    const p = download.steps > 0 ? Math.min(0.99, Math.max(0, (download.step - 1) / download.steps)) : 0
    const elapsed = (Date.now() - download.startedAt) / 1000
    const eta = p > 0.05 ? Math.round((elapsed / p) * (1 - p)) : undefined
    return { progress: p, bytes: Math.round(p * BROWSER_DOWNLOAD_BYTES), ...(eta !== undefined ? { etaSec: eta } : {}) }
  }
  function sharedState(): { state: BrowserState; progress?: number } {
    const p = progressNow()
    if (p) return { state: 'downloading', progress: p.progress }
    if (present?.value) return { state: 'ready' }
    if (load().shared.error) return { state: 'error' }
    return { state: present?.value ? 'ready' : 'absent' }
  }
  function snapshot(): BrowserAddonInfo {
    const s = load()
    const st = sharedState()
    const p = progressNow()
    return {
      state: st.state,
      ...(p ? { progress: p.progress, bytes: p.bytes, ...(p.etaSec !== undefined ? { etaSec: p.etaSec } : {}) } : {}),
      totalBytes: BROWSER_DOWNLOAD_BYTES,
      ...(st.state === 'error' && s.shared.error ? { error: { ...s.shared.error } } : {}),
      usedBy: usedBy(),
      ...(st.state === 'ready' && s.shared.readyAt ? { readyAt: s.shared.readyAt } : {}),
    }
  }
  function sharedChanged(): void {
    deps.publish({ type: 'browser.updated', browser: snapshot() })
  }

  /** The shared download (one at a time; every setup that needs it waits on the same one). */
  function ensureDownload(): Promise<boolean> {
    if (download) return download.promise
    const s = load()
    delete s.shared.error
    persist()
    const d: Download = { promise: Promise.resolve(false), startedAt: Date.now(), step: 0, steps: 0 }
    download = d
    d.timer = setInterval(() => sharedChanged(), tickMs)
    d.timer.unref?.()
    log('browser: building the shared botvm-browser image')
    let rest = ''
    d.promise = track(
      (async () => {
        const r = await cli(imageBuildArgv('botvm-browser'), BROWSER_DOWNLOAD_TIMEOUT_MS, {
          onOutput: (_s, chunk) => {
            const text = rest + chunk
            const lines = text.split('\n')
            rest = lines.pop() ?? ''
            for (const line of lines) {
              const m = /^STEP (\d+)\/(\d+):/.exec(line.trim()) ?? /^Step (\d+)\/(\d+) :/.exec(line.trim())
              if (m) {
                d.step = Number(m[1])
                d.steps = Number(m[2])
              }
            }
          },
        })
        const ok = r.code === 0 && (await imagePresent(true))
        const est = progressNow()
        clearInterval(d.timer)
        download = null
        if (ok) {
          s.shared = { readyAt: iso() }
          log('browser: botvm-browser is ready')
        } else {
          const { cause, detail } = downloadCause(r)
          const bytes = est?.bytes ?? 0
          s.shared = { error: { reason: 'download_failed', message: downloadFailedText(Math.floor(bytes / 1000 ** 2), cause), at: iso(), bytes, cause, detail } }
          log(`browser: botvm-browser build failed: ${detail}`)
        }
        persist()
        sharedChanged()
        return ok
      })().catch((err: Error) => {
        clearInterval(d.timer)
        download = null
        s.shared = { error: { reason: 'download_failed', message: downloadFailedText(0, 'the image build failed'), at: iso(), cause: 'the image build failed', detail: err.message } }
        persist()
        sharedChanged()
        return false
      }),
    )
    sharedChanged()
    return d.promise
  }

  // ----- per bot -----
  function bot(agentId: string): BotState | undefined {
    return load().bots[agentId]
  }
  function botChanged(agentId: string): void {
    persist()
    const b = bot(agentId)
    const setup = b?.info.setup
    if (setup?.requestId) deps.gate?.updateSetup(setup.requestId, setup, b?.info.state === 'error' ? b.info.error : undefined)
    deps.vmChanged(agentId)
  }
  const bump = (agentId: string) => {
    const t = (tokens.get(agentId) ?? 0) + 1
    tokens.set(agentId, t)
    return t
  }
  const live = (agentId: string, token: number) => !closed && tokens.get(agentId) === token && !!deps.getAgent(agentId)

  function failSetup(agentId: string, token: number, error: BrowserError): void {
    const b = bot(agentId)
    if (!b || !live(agentId, token)) return
    b.info = { ...b.info, state: 'error', error }
    botChanged(agentId)
    log(`browser: ${agentId}: setup failed (${error.reason}): ${error.message}`)
    deps.gate?.browserFailed(agentId, error.reason === 'chromium_check_failed' ? 'chromium_check_failed' : 'browser_unavailable')
  }

  /** Wait for any build of the bot that is running now (the user's Rebuild, a vm_install). */
  async function afterOtherBuild(agentId: string): Promise<void> {
    for (let i = 0; i < 5; i++) {
      const other = deps.activeBuildRunId(agentId)
      if (!other) return
      await deps.waitRun(other).catch(() => null)
    }
  }

  /** Start the on/off rebuild and wait for it; returns the ended run (or the refusal). */
  async function rebuildOnto(agentId: string, base: 'base' | 'browser', token: number, where: { conversationId?: string }, onStart?: (r: ScriptRun) => void): Promise<{ ok: true } | { ok: false; message: string }> {
    await afterOtherBuild(agentId)
    if (!live(agentId, token)) return { ok: false, message: 'cancelled' }
    const agent = deps.getAgent(agentId)
    if (!agent) return { ok: false, message: 'Bot not found.' }
    let started: ScriptRun
    try {
      started = await deps.startBuild(agent, base, where)
    } catch (err) {
      return { ok: false, message: (err as Error).message }
    }
    buildOf.set(agentId, started.id)
    onStart?.(started)
    const ended = await deps.waitRun(started.id).catch((err: Error) => ({ status: 'failed', error: err.message }) as ScriptRun)
    if (buildOf.get(agentId) === started.id) buildOf.delete(agentId)
    if (ended.status === 'succeeded') return { ok: true }
    return { ok: false, message: ended.error ?? 'The tool build failed.' }
  }

  async function runSetup(agentId: string, token: number): Promise<void> {
    const b = bot(agentId)
    if (!b?.info.setup) return
    const setup = b.info.setup
    let agent = deps.getAgent(agentId)
    if (!agent || !live(agentId, token)) return

    // 1. Low disk (the download's size plus the run floor; only the floor when it's already there).
    const there = await imagePresent(true)
    if (!live(agentId, token)) return
    const needsDownload = !there && agent.vm.image.base !== 'browser'
    if (needsDownload || setup.download.reused === undefined) {
      const low = lowDiskProblem(await deps.freeBytes().catch(() => null), !needsDownload)
      if (low) return failSetup(agentId, token, { reason: 'low_disk', message: low.message, at: iso(), neededBytes: low.neededBytes, freeBytes: low.freeBytes })
    }

    // 2. The shared download (skipped, reused, when it's there).
    if (!needsDownload) {
      // A retry {agentId} started the download for this setup and it already finished.
      if (setup.download.startedAt && !setup.download.endedAt) setup.download = { ...setup.download, endedAt: iso(), bytes: BROWSER_DOWNLOAD_BYTES }
      else if (setup.download.reused === undefined && !setup.download.startedAt) setup.download.reused = true
    } else {
      b.info = { ...b.info, state: 'setting_up' }
      setup.download = { startedAt: iso(), totalBytes: BROWSER_DOWNLOAD_BYTES }
      botChanged(agentId)
      const ok = await ensureDownload()
      if (!live(agentId, token)) return
      const p = progressNow()
      setup.download = { ...setup.download, endedAt: iso(), ...(ok ? { bytes: BROWSER_DOWNLOAD_BYTES } : p ? { bytes: p.bytes } : {}) }
      if (!ok) {
        const e = load().shared.error
        return failSetup(agentId, token, e ? { ...e } : { reason: 'download_failed', message: downloadFailedText(0, 'the image build failed'), at: iso() })
      }
    }

    // 3. The tool build onto the browser base (keeps the bot's packages; internet only with packages).
    agent = deps.getAgent(agentId)
    if (!agent) return
    if (agent.vm.image.base !== 'browser') {
      if (agent.internetPolicy === 'never' && agent.vm.packages.length) {
        return failSetup(agentId, token, { reason: 'build_failed', message: BROWSER_INTERNET_NEVER_TEXT, at: iso() })
      }
      b.info = { ...b.info, state: 'rebuilding' }
      setup.rebuild = { startedAt: iso() }
      botChanged(agentId)
      const res = await rebuildOnto(agentId, 'browser', token, {}, (r) => {
        setup.rebuild = { ...setup.rebuild, runId: r.id }
        botChanged(agentId)
      })
      if (!live(agentId, token)) return
      setup.rebuild = { ...setup.rebuild, endedAt: iso() }
      if (!res.ok) return failSetup(agentId, token, { reason: 'build_failed', message: res.message, at: iso() })
    }

    // 4. waiting_idle: the container is recreated once the bot's current run ends.
    if (deps.busy(agentId) > 0) {
      b.info = { ...b.info, state: 'waiting_idle' }
      botChanged(agentId)
      while (deps.busy(agentId) > 0) {
        await new Promise((r) => setTimeout(r, idlePollMs))
        if (!live(agentId, token)) return
      }
    }
    agent = deps.getAgent(agentId)
    if (!agent) return
    await deps.recreate(agent).catch((err: Error) => log(`browser: ${agent!.slug}: couldn't recreate the container: ${err.message}`))
    if (!live(agentId, token)) return

    // 5. The real Chromium check for this bot.
    b.info = { ...b.info, state: b.info.state === 'waiting_idle' ? 'waiting_idle' : 'rebuilding' }
    const c = await deps.chromiumCheck(agent).catch((err: Error) => ({ ok: false as const, error: err.message }))
    if (!live(agentId, token)) return
    const at = iso()
    if (!c.ok) {
      const { cause, detail } = checkCause(c.error)
      setup.check = { status: 'fail', at, message: checkFailedText(cause) }
      return failSetup(agentId, token, { reason: 'chromium_check_failed', message: checkFailedText(cause), at, cause, detail })
    }
    setup.check = { status: 'pass', at, message: `Chromium ${c.version} launched` }
    setup.readyAt = at
    const { error: _e, ...rest } = b.info
    b.info = { ...rest, state: 'ready', setup, chromium: { version: c.version, checkedAt: at } }
    botChanged(agentId)
    sharedChanged()
    log(`browser: ${agent.slug}: ready (Chromium ${c.version})`)
    await deps.gate?.browserReady(agentId)
  }

  function startSetup(agentId: string, setup: BrowserSetup): void {
    const s = load()
    const token = bump(agentId)
    s.bots[agentId] = { info: { state: 'setting_up', setup } }
    botChanged(agentId)
    sharedChanged()
    void track(runSetup(agentId, token).catch((err: Error) => failSetup(agentId, token, { reason: 'build_failed', message: err.message, at: iso() })))
  }

  /** Back onto the base when idle (after a turn-off; also resumed on start). */
  async function runOff(agentId: string, token: number): Promise<void> {
    const b = bot(agentId)
    if (!b) return
    while (deps.busy(agentId) > 0) {
      await new Promise((r) => setTimeout(r, idlePollMs))
      if (!live(agentId, token)) return
    }
    const agent = deps.getAgent(agentId)
    if (!agent || !live(agentId, token)) return
    if (agent.vm.image.base !== 'browser') {
      b.offPending = false
      delete b.offFailed
      botChanged(agentId)
      sharedChanged()
      return
    }
    const res = await rebuildOnto(agentId, 'base', token, {})
    if (!live(agentId, token)) return
    if (res.ok) {
      // The container moves onto the new image now (it's idle), so the browser-base generation isn't in use.
      const fresh = deps.getAgent(agentId)
      if (fresh && deps.busy(agentId) === 0) await deps.recreate(fresh).catch((err: Error) => log(`browser: ${agent.slug}: couldn't recreate the container: ${err.message}`))
      if (!live(agentId, token)) return
      b.offPending = false
      delete b.offFailed
      log(`browser: ${agent.slug}: back on the base image`)
    } else {
      b.offFailed = res.message
      log(`browser: ${agent.slug}: the rebuild off the browser base failed: ${res.message}`)
    }
    botChanged(agentId)
    sharedChanged()
  }

  function turnOff(agentId: string): void {
    const s = load()
    const token = bump(agentId)
    const prev = s.bots[agentId]
    // A setup in progress is cancelled: its build is stopped (the generation is kept).
    const building = buildOf.get(agentId)
    if (building) void deps.stopRun(building).catch(() => {})
    const agent = deps.getAgent(agentId)
    const setup = prev?.info.setup
    s.bots[agentId] = { info: { state: 'off', ...(setup ? { setup } : {}) }, offPending: agent?.vm.image.base === 'browser' || !!building }
    botChanged(agentId)
    sharedChanged()
    deps.featuresChanged?.()
    void track(
      (async () => {
        if (building) await deps.waitRun(building).catch(() => null)
        await runOff(agentId, token)
      })().catch((err: Error) => log(`browser: ${agentId}: turn-off failed: ${err.message}`)),
    )
  }

  function newSetup(extra: { requestId?: string; runId?: string } = {}): BrowserSetup {
    return { turnedOnAt: iso(), turnedOnBy: 'user', ...extra, download: {}, rebuild: {}, check: { status: 'pending' } }
  }

  const addon: BrowserAddon = {
    async info() {
      if (!download) await imagePresent()
      return snapshot()
    },
    sharedState,
    botInfo(agentId) {
      const b = bot(agentId)
      return b ? JSON.parse(JSON.stringify(b.info)) as BotBrowserInfo : undefined
    },
    async checkChange(agent, on, policy = agent.internetPolicy) {
      if (on === agent.vm.permissions.browser) return
      if (policy === 'never' && agent.vm.packages.length) failWithReason(409, 'internet_never', BROWSER_INTERNET_NEVER_TEXT)
      if (!on) return
      const reused = agent.vm.image.base === 'browser' || (await imagePresent(true))
      const low = lowDiskProblem(await deps.freeBytes().catch(() => null), reused)
      if (low) failWithReason(409, LOW_DISK_REASON, low.message)
    },
    changed(agentId, on) {
      if (on) {
        startSetup(agentId, newSetup())
        deps.featuresChanged?.()
      } else turnOff(agentId)
    },
    enable(agentId, request) {
      const agent = deps.getAgent(agentId)
      if (!agent) return
      if (!agent.vm.permissions.browser) {
        try {
          deps.saveBrowser(agentId, true)
        } catch (err) {
          log(`browser: ${agentId}: couldn't save the browser setting: ${(err as Error).message}`)
          deps.gate?.browserFailed(agentId, 'browser_unavailable')
          return
        }
      }
      startSetup(agentId, newSetup({ requestId: request.id, ...(request.runId ? { runId: request.runId } : {}) }))
      deps.featuresChanged?.()
    },
    status(agentId) {
      const b = bot(agentId)
      if (!b || b.info.state === 'ready') return b ? { state: 'ready' } : { state: 'pending' }
      if (b.info.state === 'error') return { state: 'failed', reason: b.info.error?.reason === 'chromium_check_failed' ? 'chromium_check_failed' : 'browser_unavailable' }
      return { state: 'pending' }
    },
    async retry(agentId) {
      const s = load()
      if (agentId === undefined) {
        if (download || !s.shared.error || (await imagePresent(true))) failWithReason(409, 'nothing_to_retry', NOTHING_TO_RETRY_TEXT)
        const low = lowDiskProblem(await deps.freeBytes().catch(() => null), false)
        if (low) failWithReason(409, LOW_DISK_REASON, low.message)
        void ensureDownload()
        // Bots whose setup stopped at the download join it again.
        for (const [id, b] of Object.entries(s.bots)) {
          if (b.info.state === 'error' && b.info.error?.reason === 'download_failed' && deps.getAgent(id)?.vm.permissions.browser) {
            startSetup(id, { ...(b.info.setup ?? newSetup()), download: {}, check: { status: 'pending' } })
          }
        }
        return snapshot()
      }
      const agent = deps.getAgent(agentId)
      if (!agent) fail(404, 'Bot not found.')
      const b = s.bots[agentId]
      if (agent.vm.permissions.browser && b?.info.state === 'error') {
        const reused = agent.vm.image.base === 'browser' || (await imagePresent(true))
        const low = lowDiskProblem(await deps.freeBytes().catch(() => null), reused)
        if (low) failWithReason(409, LOW_DISK_REASON, low.message)
        const prev = b.info.setup ?? newSetup()
        // FE review (7c6665f): a setup that needs the shared download starts it now (the disk check is
        // above), so the reply and the next browser.updated say 'downloading', never the old 'error'.
        // runSetup joins the same download.
        if (!reused) void ensureDownload()
        startSetup(agentId, {
          ...prev,
          ...(reused ? {} : { download: { startedAt: iso(), totalBytes: BROWSER_DOWNLOAD_BYTES } }),
          check: { status: 'pending' },
        })
        return snapshot()
      }
      if (!agent.vm.permissions.browser && b?.offPending && b.offFailed && !buildOf.has(agentId)) {
        delete b.offFailed
        const token = bump(agentId)
        void track(runOff(agentId, token).catch(() => {}))
        return snapshot()
      }
      failWithReason(409, 'nothing_to_retry', NOTHING_TO_RETRY_TEXT)
    },
    async remove() {
      if (download) failWithReason(409, 'browser_busy', BROWSER_BUSY_TEXT)
      const users = usedBy()
      if (users.length) failWithReason(409, 'browser_in_use', browserInUseText(users.map(nameOf)))
      const ref = sharedImageRef('botvm-browser')
      // A bot's previous generation built on the browser base would keep the image: those go (no rollback onto the browser).
      for (const a of deps.agents()) {
        const prev = a.vm.image.previous
        if (!prev) continue
        const r = await cli(['image', 'inspect', '--format', `{{index .Labels "${BOT_ENV_LABELS.from}"}}`, botImageRef(a.slug, prev)], 30_000)
        if (r.code === 0 && r.stdout.trim() === baseImageFor('browser')) {
          const rm = await cli(['rmi', botImageRef(a.slug, prev)], 60_000)
          log(rm.code === 0 ? `browser: ${a.slug}: removed generation ${prev} (built on the browser base)` : `browser: ${a.slug}: couldn't remove generation ${prev}: ${rm.stderr.trim().split('\n').pop() ?? ''}`)
        }
      }
      if (await imagePresent(true)) {
        const r = await cli(['rmi', ref], 120_000)
        if (r.code !== 0 && (await imagePresent(true))) {
          const last = `${r.stderr}`.trim().split('\n').pop() ?? ''
          log(`browser: couldn't remove ${ref}: ${last}`)
          fail(502, "Couldn't remove the Chromium download. Try again.")
        }
      }
      present = { value: false, at: Date.now() }
      const s = load()
      s.shared = {}
      persist()
      sharedChanged()
      return snapshot()
    },
    agentDeleted(agentId) {
      bump(agentId)
      const s = load()
      if (s.bots[agentId]) {
        delete s.bots[agentId]
        persist()
        sharedChanged()
      }
    },
    recover() {
      const s = load()
      for (const id of Object.keys(s.bots)) if (!deps.getAgent(id)) delete s.bots[id]
      for (const a of deps.agents()) {
        const b = s.bots[a.id]
        if (a.vm.permissions.browser) {
          if (b && (b.info.state === 'ready' || b.info.state === 'error')) continue
          log(`browser: ${a.slug}: resuming the browser setup`)
          const prev = b?.info.setup
          startSetup(a.id, prev ? { ...prev, check: { status: 'pending' } } : newSetup())
        } else if (b?.offPending || a.vm.image.base === 'browser') {
          s.bots[a.id] = { info: b?.info ?? { state: 'off' }, offPending: true }
          const token = bump(a.id)
          void track(runOff(a.id, token).catch(() => {}))
        }
      }
      persist()
    },
    async idle() {
      while (inflight.size) await Promise.allSettled([...inflight])
    },
    close() {
      closed = true
      if (download?.timer) clearInterval(download.timer)
    },
  }
  return addon
}
