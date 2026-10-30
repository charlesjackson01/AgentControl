/**
 * BE-P2-16: the VM tools (plan §3.1, §10.3). `run_script` starts a script run in the bot's VM through
 * RunService (the run card, queue, snapshot and logs are RunService's), waits for it and returns the
 * model's view (8 KB stdout/stderr tails, file changes, runtime). `vm_install` asks BotEnvService for
 * a bot-layer build with apt packages. Both are offered only when the app bound a VmToolHost to the
 * store and the bot's runs aren't blocked on this machine (vmToolNames).
 */
// Type-only store import first: registry.test's no-cycle check reads import lines up to a ';'.
import type { WorkspaceStore } from '../store.js'
import { BROWSER_LAUNCH_NOTE } from '../vm-images.js'
import type { ModelRunResult, StartRunInput } from '../run-service.js'
import { hostsProblem, INTERNET_NEVER_REASON, PERMISSION_DENIED_REASON, PERMISSION_TIMEOUT_REASON } from '../permission-gate.js'
import { SCRIPT_RUN_ACTIVE, type FileChange, type ScriptRun } from '../shared/types.js'
import { argError, readBoolean, readEnum, readList, readNumber, readString } from './args.js'
import type { ToolContext, ToolEntry } from './types.js'

export const VM_TOOL_NAMES = ['run_script', 'vm_install'] as const
/** Longest a script may run (VM_LIMITS.timeoutSec). */
export const RUN_SCRIPT_MAX_SEC = 600
/** How long run_script waits for its run (queue, snapshot and the run itself) before answering "still running". */
export const RUN_SCRIPT_WAIT_MS = 14 * 60_000
/** The tool's own limit in executeToolCall (above the wait, so the handler always answers first). */
export const RUN_SCRIPT_TOOL_TIMEOUT_MS = RUN_SCRIPT_WAIT_MS + 60_000
/**
 * vm_install builds an image layer (apt over the network in M2). M2 contract (fec4670): at least
 * 30 min, the permission wait (up to 10 min) plus the 20 min build limit (BUILD_TIMEOUT_MS); the
 * extra minute lets the build's own limit end first. (BE-P2-13 landed this fix for BE-P2-21.)
 */
export const VM_INSTALL_TOOL_TIMEOUT_MS = 31 * 60_000
/** BE-P2-21: how long vm_install waits for its recorded build before it answers early with a note. */
export const VM_INSTALL_WAIT_MS = 30 * 60_000
export const VM_INSTALL_STILL_BUILDING =
  'The build is still going (it is waiting for your current run, or still installing). Its card in the chat keeps updating; the packages are on your computer from the first run after it finishes.'
/** Room for two 8 KB tails, JSON escaping and the other fields. */
export const RUN_SCRIPT_RESULT_MAX_CHARS = 20_000
export const MAX_SCRIPT_CHARS = 16_000
export const MAX_ARGV = 64
const MAX_FILES_SHOWN = 50
export const BROWSER_NOT_ON =
  "The browser isn't turned on for this bot (it arrives in a later update), so this script can't use it. Run it without the browser."

/** What the app gives the VM tools (bound per store; tests bind fakes). */
export interface VmToolHost {
  start(input: StartRunInput): Promise<ScriptRun>
  wait(runId: string): Promise<ScriptRun>
  stop(runId: string): Promise<unknown>
  modelResult(run: ScriptRun): ModelRunResult
  /**
   * BotEnvService.vmInstall (400 / 409 / 502 via fail()). BE-P2-21: an online build is recorded
   * (a tool_build run with a card in `where.conversationId`) and returned as `{run}` to wait for.
   */
  vmInstall(
    agentId: string,
    packages: string[],
    where?: { conversationId: string; context: { kind: 'dm' } | { kind: 'group'; groupId: string }; agentRunId?: string; why?: string },
  ): Promise<{ generation: number; log: string } | { run: ScriptRun }>
  /** Whether the tools are offered to this bot now (its runs aren't blocked on this machine). */
  offered(agentId: string): boolean
  /** The bot's DM conversation id (created if needed), for a DM run without one. */
  dmConversation(agentId: string): string
  /** Whether the bot has the browser on (permissions.browser; always false in M1). */
  browserOn(agentId: string): boolean
}

const hosts = new WeakMap<WorkspaceStore, VmToolHost>()

/** The app binds its RunService/BotEnv to the store once; null unbinds. */
export function bindVmTools(store: WorkspaceStore, host: VmToolHost | null): void {
  if (host) hosts.set(store, host)
  else hosts.delete(store)
}

export function vmToolHost(store: WorkspaceStore): VmToolHost | undefined {
  return hosts.get(store)
}

/** The VM tool names to offer this bot ([] when no VM is bound or its runs are blocked here). */
export function vmToolNames(store: WorkspaceStore, agentId: string): string[] {
  const host = hosts.get(store)
  if (!host) return []
  try {
    return host.offered(agentId) ? [...VM_TOOL_NAMES] : []
  } catch {
    return []
  }
}

function hostOf(ctx: ToolContext): VmToolHost {
  const host = ctx.vm ?? hosts.get(ctx.store)
  if (!host) throw new Error("This bot has no computer to run scripts on here.")
  return host
}

const RUN_EXAMPLE = { argv: ['python3', 'report.py'], cwd: 'workspace', why: 'Build the weekly report' }

/** Member groups' folder names (archived groups excluded). */
function memberSlugs(ctx: ToolContext): Set<string> {
  const out = new Set<string>()
  for (const c of ctx.store.conversations) {
    if (c.kind === 'group' && !c.archivedAt && c.memberAgentIds.includes(ctx.agentId)) out.add(c.slug)
  }
  return out
}

/**
 * The run folder: `workspace[/…]` or `groups/<group>[/…]` for a group the bot is in. Accepts
 * `/bot/…`, `group:shared[/…]` (this group chat's folder) and a trailing slash. Default: the group's
 * folder in a group chat, else `workspace`.
 */
export function resolveCwd(raw: unknown, ctx: ToolContext): string {
  const fallback = ctx.group ? `groups/${ctx.group.slug}` : 'workspace'
  if (raw === undefined || raw === null || raw === '') return fallback
  if (typeof raw !== 'string') throw argError('"cwd" must be a folder like "workspace".', RUN_EXAMPLE)
  let p = raw.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  if (p.startsWith('/bot/')) p = p.slice(5)
  else if (p === '/bot') p = ''
  if (/^group:shared(\/|$)/.test(p)) {
    if (!ctx.group) throw argError('"group:shared" is only available in a group chat; use "workspace".', RUN_EXAMPLE)
    p = `groups/${ctx.group.slug}${p.slice('group:shared'.length)}`
  }
  if (p === '' || p === '.') return fallback
  const parts = p.split('/')
  if (parts.some((s) => s === '' || s === '.' || s === '..') || p.startsWith('/')) {
    throw argError(`"cwd" must be a folder inside workspace or groups/<group> (got ${JSON.stringify(raw.slice(0, 80))}).`, RUN_EXAMPLE)
  }
  if (parts[0] === 'workspace') return p
  if (parts[0] === 'groups' && parts[1]) {
    if (!memberSlugs(ctx).has(parts[1])) {
      throw new Error(`The folder groups/${parts[1].slice(0, 60)} isn't available: this bot isn't in that group, so it isn't on its computer.`)
    }
    return p
  }
  throw argError(`"cwd" must be "workspace" or "groups/<group>" (got ${JSON.stringify(raw.slice(0, 80))}).`, RUN_EXAMPLE)
}

function readArgv(args: Record<string, unknown>): string[] {
  const script = readString(args, 'script', { max: MAX_SCRIPT_CHARS, example: { script: 'ls -la\npython3 report.py' } })
  const raw = args.argv
  const hasArgv = raw !== undefined && raw !== null && !(Array.isArray(raw) && raw.length === 0) && raw !== ''
  if (script !== undefined && script.trim() !== '' && hasArgv) throw argError('Give either "argv" or "script", not both.', RUN_EXAMPLE)
  if (script !== undefined && script.trim() !== '') {
    if (script.includes('\0')) throw argError('"script" contains a NUL character.', RUN_EXAMPLE)
    return ['bash', '-c', script]
  }
  if (!hasArgv) throw argError('Give the command as "argv" (a list) or a shell "script".', RUN_EXAMPLE)
  let argv: string[]
  if (Array.isArray(raw)) {
    if (raw.some((a) => typeof a !== 'string' && typeof a !== 'number')) throw argError('"argv" must be a list of strings.', RUN_EXAMPLE)
    argv = raw.map(String)
  } else if (typeof raw === 'string') {
    // A small model may send one string: split on whitespace (no quoting; use "script" for that).
    argv = raw.trim().split(/\s+/)
  } else throw argError('"argv" must be a list of strings.', RUN_EXAMPLE)
  if (argv.length > MAX_ARGV) throw argError(`"argv" has ${argv.length} items (max ${MAX_ARGV}).`, RUN_EXAMPLE)
  if (argv.some((a) => a.includes('\0'))) throw argError('"argv" contains a NUL character.', RUN_EXAMPLE)
  if (!argv[0]) throw argError('"argv" is empty.', RUN_EXAMPLE)
  return argv
}

/** Card-style name for the activity line: the script file, else the program. */
function shownName(args: Record<string, unknown>): string {
  if (typeof args.script === 'string' && args.script.trim()) return 'a script'
  const argv = Array.isArray(args.argv) ? args.argv.map(String) : typeof args.argv === 'string' ? args.argv.trim().split(/\s+/) : []
  const a = argv[1] && !argv[1].startsWith('-') ? argv[1] : argv[0]
  const name = a ? a.replace(/\\/g, '/').split('/').pop() : ''
  return name ? name.slice(0, 80) : 'a script'
}

/** Shrink the two tails (keeping their ends) until the JSON fits `max`. */
function fitResult(result: Record<string, unknown> & { stdout: string; stderr: string }, max: number): Record<string, unknown> {
  let out = result
  for (let i = 0; i < 12 && JSON.stringify(out).length > max; i++) {
    const over = JSON.stringify(out).length - max
    const total = out.stdout.length + out.stderr.length
    if (total === 0) break
    // Take the excess (plus slack for the outputClipped flag) from both streams in proportion; the
    // loop repeats when JSON escaping makes the cut too small.
    const cut = (s: string) => {
      const drop = Math.ceil(((over + 64) * s.length) / total)
      return s.length > drop ? s.slice(drop) : ''
    }
    out = { ...out, stdout: cut(out.stdout), stderr: cut(out.stderr), outputClipped: true }
  }
  return out
}

function runResult(run: ScriptRun, host: VmToolHost, ctx: ToolContext): Record<string, unknown> {
  const m = host.modelResult(run)
  const files: FileChange[] = m.filesChanged.slice(0, MAX_FILES_SHOWN)
  const shownBytes = Buffer.byteLength(m.stdout) + Buffer.byteLength(m.stderr)
  const base = {
    runId: run.id,
    ...m,
    filesChanged: files,
    ...(m.filesChanged.length > files.length ? { filesChangedCount: m.filesChanged.length } : {}),
    ...(SCRIPT_RUN_ACTIVE.includes(run.status)
      ? { note: 'The run is still going; it shows in the chat as a run card. Tell the user it is running.' }
      : {}),
    ...(shownBytes < (run.outputBytes ?? 0) || m.outputTruncated
      ? { outputNote: `Only the last 8 KB of each stream is shown (${run.outputBytes} bytes in all); the full output is on the run card.` }
      : {}),
  }
  return fitResult(base, Math.min(ctx.resultMaxChars ?? RUN_SCRIPT_RESULT_MAX_CHARS, RUN_SCRIPT_RESULT_MAX_CHARS) - 50)
}

async function waitFor(host: VmToolHost, run: ScriptRun, ctx: ToolContext, waitMs = RUN_SCRIPT_WAIT_MS): Promise<ScriptRun> {
  const signal = ctx.signal
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    return await Promise.race([
      host.wait(run.id),
      new Promise<ScriptRun>((resolve) => {
        timer = setTimeout(() => resolve(run), ctx.vmWaitMs ?? waitMs)
        timer.unref?.()
      }),
      new Promise<ScriptRun>((resolve) => {
        if (!signal) return
        onAbort = () => {
          // The user stopped the reply: stop its script too, then report what it is now.
          void host.stop(run.id).catch(() => {}).then(() => host.wait(run.id)).then(resolve, () => resolve(run))
        }
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
    if (onAbort) signal?.removeEventListener('abort', onAbort)
  }
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** BE-P2-21: what vm_install answers for its recorded build (an ended build that didn't succeed is a tool error). */
function buildResult(run: ScriptRun, apt: string[], host: VmToolHost): Record<string, unknown> {
  const tail = (run.stdoutTail || '').slice(-2000)
  if (run.status === 'succeeded') {
    return {
      installed: apt,
      generation: run.build?.generation,
      note: 'Installed. The packages are on your computer from your next run.',
      ...(tail ? { logTail: tail } : {}),
    }
  }
  if (SCRIPT_RUN_ACTIVE.includes(run.status)) {
    return { installed: [], runId: run.id, status: run.status, generation: run.build?.generation, note: VM_INSTALL_STILL_BUILDING }
  }
  // BE-P2-14: a build the user declined (or didn't answer) tells the model in its words.
  if (run.reason === PERMISSION_DENIED_REASON || run.reason === PERMISSION_TIMEOUT_REASON || run.reason === INTERNET_NEVER_REASON) {
    throw new Error(host.modelResult(run).error || run.error || `The tool build ended ${run.status}.`)
  }
  throw new Error(run.error || `The tool build ended ${run.status}.`)
}

export const vmTools: ToolEntry[] = [
  {
    name: 'run_script',
    category: 'vm',
    effect: 'write',
    timeoutMs: RUN_SCRIPT_TOOL_TIMEOUT_MS,
    maxResultChars: RUN_SCRIPT_RESULT_MAX_CHARS,
    description:
      "Run a command or shell script on your own Linux computer (Python 3, Node). Files: /bot/workspace, /bot/groups/<group>, /bot/shared (read-only). Returns exit code, output tails, changed files. Example: {\"argv\":[\"python3\",\"report.py\"]}",
    parameters: {
      type: 'object',
      properties: {
        argv: { type: 'array', items: { type: 'string' }, description: 'Program and args' },
        script: { type: 'string', description: 'Or a bash script' },
        cwd: { type: 'string', description: '"workspace" or "groups/<group>"' },
        timeoutSec: { type: 'integer', minimum: 1, maximum: RUN_SCRIPT_MAX_SEC },
        network: { type: 'string', enum: ['off', 'on'] },
        browser: { type: 'boolean', description: `Needs the browser. ${BROWSER_LAUNCH_NOTE}` },
        // BE-P2-14: sites for the internet card (checked in the handler: ≤ PERMISSION_HOSTS_MAX; small-model budget).
        hosts: { type: 'array', items: { type: 'string' } },
        why: { type: 'string', description: 'Shown to the user' },
      },
    },
    activity: (args) => {
      const name = shownName(args)
      return { summary: `Ran ${name}`, failed: `Couldn't run ${name}` }
    },
    async handler(args, ctx) {
      const host = hostOf(ctx)
      const argv = readArgv(args)
      const cwd = resolveCwd(args.cwd, ctx)
      const timeoutSec = readNumber(args, 'timeoutSec', { min: 1, max: RUN_SCRIPT_MAX_SEC, integer: true, example: { ...RUN_EXAMPLE, timeoutSec: 120 } })
      const network = readEnum(args, 'network', ['off', 'on'] as const, { fallback: 'off', example: { ...RUN_EXAMPLE, network: 'off' } }) ?? 'off'
      const browser = readBoolean(args, 'browser', false)
      const why = readString(args, 'why', { max: 300, example: RUN_EXAMPLE })?.trim()
      // BE-P2-14: hosts are a hint for the card (the proxy doesn't limit to them).
      const hostsBad = hostsProblem(args.hosts)
      if (hostsBad) throw argError(hostsBad, { ...RUN_EXAMPLE, network: 'on', hosts: ['api.example.com'] })
      const hostList = Array.isArray(args.hosts) ? [...new Set((args.hosts as string[]).map((h) => h.toLowerCase()))] : []
      // M1: the browser is never on (PATCH permissions.browser → 400); the M2 browser request card is BE-P2-14.
      if (browser && !host.browserOn(ctx.agentId)) throw new Error(BROWSER_NOT_ON)
      // A group run always has its conversation; a DM run may be the bot's first (no DM yet).
      const conversationId = ctx.group ? ctx.group.id : (ctx.conversationId ?? host.dmConversation(ctx.agentId))
      let run: ScriptRun
      try {
        run = await host.start({
          agentId: ctx.agentId,
          conversationId,
          context: ctx.group ? { kind: 'group', groupId: ctx.group.id } : { kind: 'dm' },
          argv,
          cwd,
          network,
          ...(browser ? { browser } : {}),
          ...(timeoutSec !== undefined ? { timeoutSec } : {}),
          ...(why ? { why } : {}),
          ...(network === 'on' && hostList.length ? { hosts: hostList } : {}),
          agentRunId: ctx.runId,
        })
      } catch (err) {
        // 400/404/409 from RunService (blocks, low disk, bad cwd): plain text for the model.
        throw new Error(errText(err))
      }
      const ended = await waitFor(host, run, ctx)
      return runResult(ended, host, ctx)
    },
    // A failed run is still a full result (the model reads its output), but the call and its step show it failed.
    resultOk: (value) => {
      const status = (value as { status?: string } | null)?.status
      return status === 'succeeded' || SCRIPT_RUN_ACTIVE.includes(status as ScriptRun['status'])
    },
  },
  {
    name: 'vm_install',
    category: 'vm',
    effect: 'write',
    timeoutMs: VM_INSTALL_TOOL_TIMEOUT_MS,
    description:
      'Install Debian system packages (apt) on your computer; pip/npm go in run_script instead. Takes effect from your next run. Example: {"apt":["ffmpeg"],"why":"Convert the audio files"}',
    parameters: {
      type: 'object',
      properties: {
        apt: { type: 'array', items: { type: 'string' }, maxItems: 100 },
        why: { type: 'string' },
      },
      required: ['apt'],
    },
    activity: (args) => {
      const list = Array.isArray(args.apt) ? args.apt.map(String).join(', ') : typeof args.apt === 'string' ? args.apt : ''
      const shown = list.length > 80 ? `${list.slice(0, 79)}…` : list
      return { summary: `Installed ${shown || 'packages'}`, failed: `Couldn't install ${shown || 'packages'}` }
    },
    async handler(args, ctx) {
      const host = hostOf(ctx)
      const example = { apt: ['ffmpeg'] }
      const apt = readList(args, 'apt', { max: 100, example })
      if (!apt || apt.length === 0) throw argError('"apt" is required: a list of Debian package names.', example)
      const why = readString(args, 'why', { max: 300, example })?.trim()
      let result: Awaited<ReturnType<VmToolHost['vmInstall']>>
      try {
        const conversationId = ctx.group ? ctx.group.id : (ctx.conversationId ?? host.dmConversation(ctx.agentId))
        result = await host.vmInstall(ctx.agentId, apt, {
          conversationId,
          context: ctx.group ? { kind: 'group', groupId: ctx.group.id } : { kind: 'dm' },
          ...(ctx.runId ? { agentRunId: ctx.runId } : {}),
          ...(why ? { why } : {}),
        })
      } catch (err) {
        throw new Error(errText(err))
      }
      if ('run' in result) return buildResult(await waitFor(host, result.run, ctx, VM_INSTALL_WAIT_MS), apt, host)
      const built = result
      const log = built.log.length > 2000 ? built.log.slice(-2000) : built.log
      return {
        installed: apt,
        generation: built.generation,
        note: built.log === 'Already installed.' ? 'Already installed.' : 'Installed. The packages are on your computer from your next run.',
        ...(log && built.log !== 'Already installed.' ? { logTail: log } : {}),
      }
    },
  },
]
