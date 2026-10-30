/**
 * BE-P2-14: PermissionGate. Internet (and, behind BE-P2-15's hook, browser) requests for script runs
 * and vm_install builds: one pending request per bot, a `kind:'permission'` chat card per request,
 * persisted under data/permissions/requests.json (expiresAt included, so the timeout survives a
 * restart), and permission.requested / permission.resolved / permission.updated events.
 *
 * RunService asks `admit(run)` how a new run goes on (queue, end, or wait for a card) and tells the
 * gate when a waiting run ends (`runEnded`). The gate answers runs back through `ops.release`.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fail, failWithReason, internetNeverText } from './http.js'
import { PROXY_UNAVAILABLE, PROXY_UNAVAILABLE_REASON } from './egress-service.js'
import {
  PERMISSION_DECISIONS,
  PERMISSION_HOSTS_MAX,
  PERMISSION_TIMEOUT_MS,
  VM_INSTALL_EXPECTED_HOSTS,
  type Agent,
  type BrowserError,
  type BrowserSetup,
  type ChatMessage,
  type Conversation,
  type LiveEvent,
  type PermissionDecision,
  type PermissionRequest,
  type PermissionType,
  type RunWaitingFor,
  type ScriptRun,
  type ScriptRunPermission,
} from './shared/types.js'

export const PERMISSION_DENIED_REASON = 'permission_denied'
export const PERMISSION_TIMEOUT_REASON = 'permission_timeout'
export const INTERNET_NEVER_REASON = 'internet_never'
export const BROWSER_UNAVAILABLE_REASON = 'browser_unavailable'
export const CHROMIUM_CHECK_FAILED_REASON = 'chromium_check_failed'
export const INTERNET_DENIED_TEXT = "You denied internet access, so this run didn't start. No files changed."
export const BROWSER_DENIED_TEXT = "You denied the browser, so this run didn't start. No files changed."
export const PERMISSION_TIMEOUT_TEXT = "No answer in 10 minutes, so this run didn't start. No files changed."
export const BROWSER_UNAVAILABLE_TEXT = "The browser couldn't be turned on, so this run didn't start."
export const chromiumCheckFailedText = (bot: string) => `Chromium didn't start for ${bot}, so this run didn't start.`
/** What the model is told for a run that never started (contract "Denied runs"). */
export const MODEL_INTERNET_DENIED = 'The user declined internet access.'
export const MODEL_BROWSER_DENIED = 'The user declined the browser.'
export const MODEL_PERMISSION_TIMEOUT = 'No answer in 10 minutes.'
export const modelInternetNever = (bot: string) => `${bot}'s internet is set to Never.`
export const ALREADY_RESOLVED_REASON = 'already_resolved'
export const BAD_DECISION_REASON = 'bad_decision'
export const badDecisionText = (decision: string, type: PermissionType) =>
  `“${decision.slice(0, 40)}” isn't an answer for an ${type} request.`
/** Resolved requests kept in requests.json (pending ones are always kept). */
export const PERMISSION_HISTORY_MAX = 2000

/** How a run goes on after the gate decided (RunService applies it). */
export type GateRelease =
  | { kind: 'queue'; permission?: ScriptRunPermission }
  | { kind: 'wait'; waitingFor: RunWaitingFor; requestId?: string; permission?: ScriptRunPermission }
  | { kind: 'end'; status: 'denied' | 'failed'; reason: string; error: string; permission?: ScriptRunPermission }

/** admit() before the run is recorded: `ask` means record it waiting, then raise(). */
export type GateAdmit = GateRelease | { kind: 'ask'; type: PermissionType }

/** BE-P2-15: where the bot's browser setup is (GateBrowserHooks.status). */
export type BrowserSetupStatus =
  | { state: 'ready' }
  | { state: 'pending' }
  | { state: 'failed'; reason: 'browser_unavailable' | 'chromium_check_failed' }

/** What RunService gives the gate. */
export interface GateRunOps {
  /** Live runs in waiting_permission (all bots, or one). */
  waitingRuns(agentId?: string): ScriptRun[]
  release(runId: string, r: GateRelease): void
}

/** BE-P2-15's browser add-on (absent: browser requests are never raised; run_script refuses browser:true when off). */
export interface GateBrowserHooks {
  /** A card `enable`: turn the browser on for the bot and start its setup (the gate already saved nothing). */
  enable(agentId: string, request: PermissionRequest): void
  /**
   * BE-P2-15: for a run with browser:true on a bot whose browser is on. 'pending' (setup not done):
   * the run waits for the browser; 'failed' (setup error): the run ends failed with that reason.
   * Absent: the browser counts as ready.
   */
  status?(agentId: string): BrowserSetupStatus
}

export interface PermissionGateDeps {
  dataDir(): string
  getAgent(id: string): Agent | undefined
  conversations(): Conversation[]
  messages(): ChatMessage[]
  save(): void
  /** Set the bot's internet policy to Always (the card's `always`), save, and send vm.updated. */
  setAlways(agentId: string): void
  /** BE-P2-13: the proxy is up (`egress.available()`); checked before an internet card is raised. */
  proxyAvailable(): Promise<boolean>
  browser?: GateBrowserHooks
  publish?(event: LiveEvent): void
  now?(): Date
  newId?(): string
  log?(msg: string): void
  /** Tests: the request lifetime (default PERMISSION_TIMEOUT_MS). */
  timeoutMs?: number
}

export interface PermissionListQuery {
  status?: 'pending' | 'all'
  agentId?: string
  conversationId?: string
  limit?: number
  before?: string
}

export interface PermissionGate {
  bind(ops: GateRunOps): void
  /** How a new run goes on. `hosts`: run_script's expected hosts (display only). */
  admit(run: ScriptRun, opts?: { hosts?: string[] }): Promise<GateAdmit>
  /** The run is recorded waiting: raise its card (or wait on the bot's pending one). Returns the request id it waits on. */
  raise(run: ScriptRun, type: PermissionType): { requestId: string; own: boolean }
  /** A waiting run ended (stopped, or its bot is gone): close its pending request. */
  runEnded(run: ScriptRun, closedBy: 'run_stopped' | 'run_ended'): void
  list(q?: PermissionListQuery): { requests: PermissionRequest[]; now: string }
  get(id: string): PermissionRequest | null
  /** The user's answer (404 / 400 bad_decision / 409 already_resolved via fail()). */
  answer(id: string, decision: unknown): Promise<PermissionRequest>
  /** After a saved change of the bot's internet policy or browser permission (PATCH). */
  settingsChanged(agentId: string, before: { internetPolicy: Agent['internetPolicy']; browser: boolean }): Promise<void>
  /** The bot was deleted: its pending requests close denied run_ended. */
  agentDeleted(agentId: string): void
  /** BE-P2-15: the browser setup for a card changed (permission.updated). */
  updateSetup(requestId: string, setup: BrowserSetup | undefined, setupError?: BrowserError): void
  /** BE-P2-15: the bot's browser is ready: its runs waiting for it go on (internet card next under ask). */
  browserReady(agentId: string): Promise<void>
  /** BE-P2-15: the bot's browser setup failed: its runs waiting for it end failed. */
  browserFailed(agentId: string, reason: 'browser_unavailable' | 'chromium_check_failed'): void
  /** On start: pending requests close (timeout past expiresAt, else denied run_ended). Returns how many. */
  recover(): number
  /** Timers off (shutdown, tests). */
  close(): void
}

function scriptNameOf(argv: string[]): string | undefined {
  const a = argv[1] && !argv[1].startsWith('-') ? argv[1] : argv[0]
  if (!a) return undefined
  return a.replace(/\\/g, '/').split('/').pop() || undefined
}

const HOST_RE = /^(?=.{1,253}$)(?:(?!-)[A-Za-z0-9-]{1,63}(?<!-)\.)*(?!-)[A-Za-z0-9-]{1,63}(?<!-)\.?$/
const IPV4_RE = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/

/** run_script `hosts`: hostname or IP syntax, each ≤ 253 chars, at most 10. Returns the problem, or null. */
export function hostsProblem(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null
  if (!Array.isArray(raw)) return '"hosts" must be a list of host names, e.g. ["api.example.com"].'
  if (raw.length > PERMISSION_HOSTS_MAX) return `"hosts" has ${raw.length} names (max ${PERMISSION_HOSTS_MAX}).`
  for (const h of raw) {
    if (typeof h !== 'string' || !isHostSyntax(h)) {
      return `"hosts" must hold host names or IP addresses (got ${JSON.stringify(typeof h === 'string' ? h.slice(0, 60) : h)}).`
    }
  }
  return null
}

export function isHostSyntax(h: string): boolean {
  if (h.length === 0 || h.length > 253) return false
  if (IPV4_RE.test(h)) return true
  const v6 = h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h
  if (v6.includes(':')) return /^[0-9A-Fa-f:.]+$/.test(v6) && v6.split(':').length >= 3 && v6.split(':').length <= 9
  return HOST_RE.test(h)
}

/** The card message's text (previews). */
export function permissionContent(r: PermissionRequest, bot: string): string {
  const internet = r.type === 'internet'
  if (r.status === 'pending') return internet ? `${bot} wants to use the internet` : `${bot} wants to use a browser`
  if (r.setupError) return `Couldn't turn on the browser for ${bot}`
  switch (r.status) {
    case 'allowed_once':
      return r.runKind === 'tool_build' ? 'Internet allowed for the tool build' : 'Internet allowed once'
    case 'always':
      return `Internet always allowed for ${bot}`
    case 'enabled':
      return `Browser turned on for ${bot}`
    case 'timeout':
      return internet ? 'Internet request expired' : 'Browser request expired'
    case 'denied':
      if (r.closedBy === 'run_stopped') return internet ? 'Internet request closed (run stopped)' : 'Browser request closed (run stopped)'
      // GAPs (no contract text): the run ended / the setting changed while the card was pending.
      if (r.closedBy === 'run_ended') return internet ? 'Internet request closed (run ended)' : 'Browser request closed (run ended)'
      if (r.closedBy === 'policy_changed') return internet ? `Internet request closed (set to Never for ${bot})` : `Browser request closed (browser turned off for ${bot})`
      return internet ? 'Internet denied' : 'Browser denied'
  }
  return ''
}

interface Saved {
  version: 1
  requests: PermissionRequest[]
}

export function createPermissionGate(deps: PermissionGateDeps): PermissionGate {
  const now = deps.now ?? (() => new Date())
  const log = deps.log ?? (() => {})
  const lifetime = deps.timeoutMs ?? PERMISSION_TIMEOUT_MS
  const newId = deps.newId ?? (() => `perm_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`)
  let ops: GateRunOps | null = null
  const requests = new Map<string, PermissionRequest>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  /** run_script's expected hosts, by run (display only; dropped when the run leaves the gate). */
  const hostsOf = new Map<string, string[]>()
  let loaded = false

  const file = () => join(deps.dataDir(), 'permissions', 'requests.json')
  const botName = (agentId: string) => deps.getAgent(agentId)?.name?.trim() || 'The bot'
  const copy = (r: PermissionRequest): PermissionRequest => JSON.parse(JSON.stringify(r)) as PermissionRequest

  function load(): void {
    if (loaded) return
    loaded = true
    try {
      const raw = JSON.parse(readFileSync(file(), 'utf8')) as Saved
      for (const r of Array.isArray(raw?.requests) ? raw.requests : []) {
        if (r && typeof r.id === 'string' && typeof r.agentId === 'string') requests.set(r.id, r)
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log(`permissions: couldn't read ${file()}: ${(err as Error).message}`)
    }
  }

  function persist(): void {
    const all = [...requests.values()].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
    const resolved = all.filter((r) => r.status !== 'pending')
    if (resolved.length > PERMISSION_HISTORY_MAX) {
      for (const r of resolved.slice(0, resolved.length - PERMISSION_HISTORY_MAX)) requests.delete(r.id)
    }
    try {
      const dir = join(deps.dataDir(), 'permissions')
      mkdirSync(dir, { recursive: true })
      const tmp = `${file()}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify({ version: 1, requests: [...requests.values()] } satisfies Saved))
      renameSync(tmp, file())
    } catch (err) {
      log(`permissions: couldn't save requests: ${(err as Error).message}`)
    }
  }

  /** Create or update the request's card (kind 'permission'). */
  function syncCard(r: PermissionRequest): void {
    const msgs = deps.messages()
    let msg = r.messageId ? msgs.find((m) => m.id === r.messageId) : undefined
    if (!msg && !r.messageId) {
      const conv = deps.conversations().find((c) => c.id === r.conversationId)
      if (conv) {
        msg = {
          id: `msg-${crypto.randomUUID()}`,
          conversationId: r.conversationId,
          role: 'assistant',
          content: '',
          createdAt: r.createdAt,
          kind: 'permission',
          permissionRequestId: r.id,
          authorAgentId: r.agentId,
        }
        msgs.push(msg)
        conv.updatedAt = r.createdAt
        r.messageId = msg.id
      }
    }
    if (msg) msg.content = permissionContent(r, botName(r.agentId))
    deps.save()
  }

  function arm(r: PermissionRequest): void {
    if (timers.has(r.id)) return
    const ms = Math.max(0, Date.parse(r.expiresAt) - now().getTime())
    const t = setTimeout(() => {
      timers.delete(r.id)
      const cur = requests.get(r.id)
      if (cur && cur.status === 'pending') void resolve(cur, 'timeout', {})
    }, ms)
    t.unref?.()
    timers.set(r.id, t)
  }

  function disarm(id: string): void {
    const t = timers.get(id)
    if (t) clearTimeout(t)
    timers.delete(id)
  }

  function pendingOf(agentId: string): PermissionRequest | undefined {
    for (const r of requests.values()) if (r.agentId === agentId && r.status === 'pending') return r
    return undefined
  }

  /** A pending request already past expiresAt (e.g. a timer that was late) ends as timeout. */
  function sweep(): void {
    const t = now().getTime()
    for (const r of [...requests.values()]) {
      if (r.status === 'pending' && Date.parse(r.expiresAt) <= t) void resolve(r, 'timeout', {})
    }
  }

  const internetPermission = (decision: ScriptRunPermission['decision'], requestId?: string, source: ScriptRunPermission['source'] = 'card'): ScriptRunPermission => ({
    type: 'internet',
    decision,
    ...(requestId ? { requestId } : {}),
    source,
  })

  function needsBrowser(run: ScriptRun, agent: Agent): boolean {
    return run.browser === true && !agent.vm.permissions.browser
  }

  async function admit(run: ScriptRun, opts: { hosts?: string[] } = {}): Promise<GateAdmit> {
    load()
    if (opts.hosts?.length) hostsOf.set(run.id, [...opts.hosts])
    const agent = deps.getAgent(run.agentId)
    if (!agent) return { kind: 'end', status: 'failed', reason: 'bot_not_found', error: 'Bot not found.' }
    const internet = run.network === 'on'
    const policy = agent.internetPolicy
    if (internet && policy === 'never') {
      return { kind: 'end', status: 'denied', reason: INTERNET_NEVER_REASON, error: internetNeverText(agent.name) }
    }
    if (deps.browser && needsBrowser(run, agent)) return { kind: 'ask', type: 'browser' }
    if (run.browser && agent.vm.permissions.browser && deps.browser?.status) {
      const s = deps.browser.status(agent.id)
      const enabled: ScriptRunPermission = run.permissions.find((p) => p.type === 'browser' && p.decision === 'enable') ?? { type: 'browser', decision: 'enable', source: 'policy' }
      if (s.state === 'pending') return { kind: 'wait', waitingFor: 'browser', permission: enabled }
      if (s.state === 'failed') {
        const error = s.reason === CHROMIUM_CHECK_FAILED_REASON ? chromiumCheckFailedText(agent.name) : BROWSER_UNAVAILABLE_TEXT
        return { kind: 'end', status: 'failed', reason: s.reason, error }
      }
    }
    // An enable this run already got from its card stays on the record (with its request id).
    const enabledBy = run.permissions.find((p) => p.type === 'browser' && p.decision === 'enable')
    if (!internet) return { kind: 'queue', ...(run.browser ? { permission: enabledBy ?? { type: 'browser', decision: 'enable', source: 'policy' } } : {}) }
    if (policy === 'always') return { kind: 'queue', permission: internetPermission('always', undefined, 'policy') }
    // Ask: the proxy's health first, so no card is raised for a run that couldn't get the internet.
    const up = await deps.proxyAvailable().catch(() => false)
    if (!up) return { kind: 'end', status: 'failed', reason: PROXY_UNAVAILABLE_REASON, error: PROXY_UNAVAILABLE }
    // An earlier answer this run already got (released while it waited on a browser card).
    const had = run.permissions.find((p) => p.type === 'internet' && (p.decision === 'allow_once' || p.decision === 'always'))
    if (had) return { kind: 'queue', permission: had }
    return { kind: 'ask', type: 'internet' }
  }

  function raise(run: ScriptRun, type: PermissionType): { requestId: string; own: boolean } {
    load()
    const existing = pendingOf(run.agentId)
    if (existing) return { requestId: existing.id, own: false }
    const agent = deps.getAgent(run.agentId)
    const conv = deps.conversations().find((c) => c.id === run.conversationId)
    const created = now()
    const hosts = type === 'internet' ? (run.kind === 'tool_build' ? [...VM_INSTALL_EXPECTED_HOSTS] : hostsOf.get(run.id)) : undefined
    const scriptName = run.kind === 'tool_build' ? undefined : scriptNameOf(run.argv)
    const r: PermissionRequest = {
      id: newId(),
      runId: run.id,
      agentId: run.agentId,
      conversationId: run.conversationId,
      type,
      ...(hosts?.length ? { hosts } : {}),
      ...(run.why ? { why: run.why } : {}),
      status: 'pending',
      createdAt: created.toISOString(),
      expiresAt: new Date(created.getTime() + lifetime).toISOString(),
      runKind: run.kind,
      ...(scriptName ? { scriptName } : {}),
      ...(conv?.kind === 'group' ? { groupId: conv.id, groupName: conv.name } : {}),
      ...(type === 'browser' ? { internetNext: run.network === 'on' && agent?.internetPolicy === 'ask' } : {}),
    }
    requests.set(r.id, r)
    syncCard(r)
    persist()
    arm(r)
    deps.publish?.({ type: 'permission.requested', conversationId: r.conversationId, request: copy(r) })
    log(`permissions: ${r.id} (${type}) raised for run ${run.id}`)
    return { requestId: r.id, own: true }
  }

  /** Re-decide a waiting run (after the request it waited on ended, or its browser became ready). */
  async function readmit(run: ScriptRun): Promise<void> {
    if (!ops) return
    const d = await admit(run)
    // It may have ended while the proxy was checked.
    if (!ops.waitingRuns(run.agentId).some((r) => r.id === run.id)) return
    if (d.kind === 'ask') {
      const { requestId, own } = raise(run, d.type)
      ops.release(run.id, { kind: 'wait', waitingFor: 'permission', requestId, permission: { type: d.type, decision: 'pending', ...(own ? { requestId, source: 'card' as const } : {}) } })
      return
    }
    if (d.kind === 'wait') {
      ops.release(run.id, d)
      return
    }
    if (d.kind === 'end' || d.kind === 'queue') {
      hostsOf.delete(run.id)
      ops.release(run.id, d)
    }
  }

  /** Bots being deleted: their waiting runs are stopped by RunService, never re-asked. */
  const deleted = new Set<string>()
  async function readmitAll(runs: ScriptRun[]): Promise<void> {
    runs = runs.filter((x) => !deleted.has(x.agentId))
    // One at a time, oldest first: the first raises the next card, the rest wait on it.
    for (const run of [...runs].sort((a, b) => (a.queuedAt < b.queuedAt ? -1 : 1))) await readmit(run)
  }

  const waitersOf = (r: PermissionRequest) => (ops?.waitingRuns(r.agentId) ?? []).filter((x) => x.waitingOnRequestId === r.id)

  type Outcome = PermissionRequest['status']
  /** End a pending request and move its runs on. */
  async function resolve(r: PermissionRequest, status: Exclude<Outcome, 'pending'>, how: { byUser?: boolean; closedBy?: PermissionRequest['closedBy'] }): Promise<void> {
    if (r.status !== 'pending') return
    disarm(r.id)
    const waiters = waitersOf(r)
    r.status = status
    r.resolvedAt = now().toISOString()
    if (how.byUser) r.resolvedBy = 'user'
    if (how.closedBy) r.closedBy = how.closedBy
    syncCard(r)
    persist()
    deps.publish?.({ type: 'permission.resolved', conversationId: r.conversationId, request: copy(r) })
    log(`permissions: ${r.id} ${status}${how.closedBy ? ` (${how.closedBy})` : ''}`)
    if (!ops) return
    const own = waiters.find((x) => x.id === r.runId)
    const others = waiters.filter((x) => x.id !== r.runId)
    const bot = botName(r.agentId)
    const perm = (decision: ScriptRunPermission['decision'], source: ScriptRunPermission['source'] = 'card'): ScriptRunPermission => ({ type: r.type, decision, requestId: r.id, source })
    if (own) {
      hostsOf.delete(own.id)
      if (status === 'allowed_once') ops.release(own.id, { kind: 'queue', permission: perm('allow_once') })
      else if (status === 'always') ops.release(own.id, { kind: 'queue', permission: perm('always', how.byUser ? 'card' : 'policy') })
      else if (status === 'enabled') ops.release(own.id, { kind: 'wait', waitingFor: 'browser', permission: perm('enable') })
      else if (status === 'timeout') {
        ops.release(own.id, { kind: 'end', status: 'denied', reason: PERMISSION_TIMEOUT_REASON, error: PERMISSION_TIMEOUT_TEXT, permission: perm('timeout') })
      } else if (how.closedBy === 'policy_changed') {
        if (r.type === 'internet') ops.release(own.id, { kind: 'end', status: 'denied', reason: INTERNET_NEVER_REASON, error: internetNeverText(bot), permission: perm('deny') })
        else ops.release(own.id, { kind: 'end', status: 'failed', reason: BROWSER_UNAVAILABLE_REASON, error: BROWSER_UNAVAILABLE_TEXT, permission: perm('deny') })
      } else if (how.byUser) {
        ops.release(own.id, { kind: 'end', status: 'denied', reason: PERMISSION_DENIED_REASON, error: r.type === 'internet' ? INTERNET_DENIED_TEXT : BROWSER_DENIED_TEXT, permission: perm('deny') })
      }
      // closedBy run_stopped / run_ended: RunService already ended the run.
    }
    // Other runs that waited on this card: an enabled browser takes the ones needing it to the same
    // setup; the rest are decided again (Always lets them go on; otherwise the oldest gets its card).
    const again: ScriptRun[] = []
    for (const x of others) {
      if (status === 'enabled' && x.browser) ops.release(x.id, { kind: 'wait', waitingFor: 'browser', permission: { type: 'browser', decision: 'enable', requestId: r.id, source: 'policy' } })
      else if (how.closedBy === 'policy_changed' && r.type === 'browser' && x.browser) {
        ops.release(x.id, { kind: 'end', status: 'failed', reason: BROWSER_UNAVAILABLE_REASON, error: BROWSER_UNAVAILABLE_TEXT })
      } else again.push(x)
    }
    await readmitAll(again)
  }

  const gate: PermissionGate = {
    bind(o) {
      ops = o
    },
    admit,
    raise,
    runEnded(run, closedBy) {
      load()
      hostsOf.delete(run.id)
      for (const r of requests.values()) {
        if (r.status === 'pending' && r.runId === run.id) void resolve(r, 'denied', { closedBy })
      }
    },
    list(q = {}) {
      load()
      sweep()
      const status = q.status ?? 'pending'
      let all = [...requests.values()]
      if (status === 'pending') all = all.filter((r) => r.status === 'pending')
      if (q.agentId) all = all.filter((r) => r.agentId === q.agentId)
      if (q.conversationId) all = all.filter((r) => r.conversationId === q.conversationId)
      all.sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1))
      if (q.before) all = all.filter((r) => r.createdAt < q.before!)
      if (status === 'all') all = all.slice(0, Math.min(200, Math.max(1, q.limit ?? 50)))
      return { requests: all.map(copy), now: now().toISOString() }
    },
    get(id) {
      load()
      sweep()
      const r = requests.get(id)
      return r ? copy(r) : null
    },
    async answer(id, decision) {
      load()
      sweep()
      const r = requests.get(id)
      if (!r) failWithReason(404, 'not_found', 'This request no longer exists.')
      if (typeof decision !== 'string' || !(PERMISSION_DECISIONS[r.type] as readonly string[]).includes(decision)) {
        failWithReason(400, BAD_DECISION_REASON, badDecisionText(typeof decision === 'string' ? decision : String(decision ?? ''), r.type))
      }
      if (r.status !== 'pending') {
        failWithReason(409, ALREADY_RESOLVED_REASON, 'This request was already answered or closed.', { request: copy(r) })
      }
      const d = decision as PermissionDecision
      if (d === 'always') {
        // The bot's own rule only (never the conversation or the group's other bots); set first so
        // the other runs waiting on this card are decided under Always.
        try {
          deps.setAlways(r.agentId)
        } catch (err) {
          // Nothing changed (the request stays pending); 5xx bodies carry no reason.
          log(`permissions: couldn't set ${r.agentId} to Always: ${(err as Error).message}`)
          fail(500, "Couldn't save the bot's internet setting. Try again.")
        }
        await resolve(r, 'always', { byUser: true })
      } else if (d === 'allow_once') await resolve(r, 'allowed_once', { byUser: true })
      else if (d === 'enable') {
        await resolve(r, 'enabled', { byUser: true })
        deps.browser?.enable(r.agentId, copy(r))
      } else await resolve(r, 'denied', { byUser: true })
      return copy(requests.get(id) ?? r)
    },
    async settingsChanged(agentId, before) {
      load()
      const agent = deps.getAgent(agentId)
      if (!agent) return
      const pending = pendingOf(agentId)
      if (agent.internetPolicy !== before.internetPolicy) {
        if (pending?.type === 'internet') {
          if (agent.internetPolicy === 'never') await resolve(pending, 'denied', { closedBy: 'policy_changed' })
          else if (agent.internetPolicy === 'always') await resolve(pending, 'always', {})
        }
        // Runs waiting for the browser that need the internet are decided once the browser is ready.
      }
      // BE-P2-15: turned on in the VM tab while a browser card was pending: the card counts as enabled
      // (its runs wait for the setup the PATCH started).
      if (!before.browser && agent.vm.permissions.browser) {
        const p = pendingOf(agentId)
        if (p?.type === 'browser') await resolve(p, 'enabled', {})
      }
      if (before.browser && !agent.vm.permissions.browser) {
        const p = pendingOf(agentId)
        if (p?.type === 'browser') await resolve(p, 'denied', { closedBy: 'policy_changed' })
        for (const x of ops?.waitingRuns(agentId) ?? []) {
          if (x.waitingFor === 'browser') ops!.release(x.id, { kind: 'end', status: 'failed', reason: BROWSER_UNAVAILABLE_REASON, error: BROWSER_UNAVAILABLE_TEXT })
        }
      }
    },
    agentDeleted(agentId) {
      load()
      // Its waiting runs are stopped next (RunService.stopAgent); nothing is asked again.
      deleted.add(agentId)
      for (const r of [...requests.values()]) if (r.agentId === agentId && r.status === 'pending') void resolve(r, 'denied', { closedBy: 'run_ended' })
    },
    updateSetup(requestId, setup, setupError) {
      load()
      const r = requests.get(requestId)
      if (!r || r.type !== 'browser') return
      if (setup) r.setup = JSON.parse(JSON.stringify(setup)) as BrowserSetup
      else delete r.setup
      if (setupError) r.setupError = JSON.parse(JSON.stringify(setupError)) as BrowserError
      else delete r.setupError
      syncCard(r)
      persist()
      deps.publish?.({ type: 'permission.updated', conversationId: r.conversationId, request: copy(r) })
    },
    async browserReady(agentId) {
      await readmitAll((ops?.waitingRuns(agentId) ?? []).filter((x) => x.waitingFor === 'browser'))
    },
    browserFailed(agentId, reason) {
      const error = reason === CHROMIUM_CHECK_FAILED_REASON ? chromiumCheckFailedText(botName(agentId)) : BROWSER_UNAVAILABLE_TEXT
      for (const x of ops?.waitingRuns(agentId) ?? []) {
        if (x.waitingFor === 'browser') ops!.release(x.id, { kind: 'end', status: 'failed', reason, error })
      }
    },
    recover() {
      load()
      let n = 0
      const t = now().getTime()
      // No run survives a restart (RunService ends them), so every pending request closes.
      for (const r of [...requests.values()]) {
        if (r.status !== 'pending') continue
        n++
        void resolve(r, Date.parse(r.expiresAt) <= t ? 'timeout' : 'denied', Date.parse(r.expiresAt) <= t ? {} : { closedBy: 'run_ended' })
      }
      if (n) log(`permissions: ${n} pending request(s) left by a restart were closed`)
      return n
    },
    close() {
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
    },
  }
  return gate
}

/** GET /api/permissions query parsing (400 on a bad status / limit / before). */
export function parsePermissionQuery(raw: Record<string, unknown>): PermissionListQuery {
  const one = (k: string) => {
    const v = raw[k]
    return Array.isArray(v) ? v[0] : v
  }
  const q: PermissionListQuery = {}
  const status = one('status')
  if (status !== undefined && status !== '') {
    if (status !== 'pending' && status !== 'all') fail(400, '"status" must be "pending" or "all".')
    q.status = status
  }
  const limit = one('limit')
  if (limit !== undefined && limit !== '') {
    const n = Number(limit)
    if (typeof limit !== 'string' || !/^\d+$/.test(limit) || n < 1 || n > 200) fail(400, '"limit" must be a whole number from 1 to 200.')
    q.limit = n
  }
  const before = one('before')
  if (before !== undefined && before !== '') {
    if (typeof before !== 'string' || !Number.isFinite(Date.parse(before))) fail(400, '"before" must be a request\'s createdAt time.')
    q.before = new Date(Date.parse(before)).toISOString()
  }
  const agentId = one('agentId')
  if (typeof agentId === 'string' && agentId) q.agentId = agentId
  const conversationId = one('conversationId')
  if (typeof conversationId === 'string' && conversationId) q.conversationId = conversationId
  return q
}
