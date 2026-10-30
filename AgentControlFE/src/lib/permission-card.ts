/*
 * FE-P2-3: the permission card's logic (mockups 01–05, 09, 10; M2 contract fec4670 "Card copy the FE builds").
 * Pure; the markup is permission-card-render.ts. Tests: tests/permission-card.test.mjs.
 */
import { durationText, clockText } from './run-card.ts'
import { lowDiskText } from './low-disk.ts'
import { clockTime } from './thread.ts'
import {
  PERMISSION_HOSTS_MAX, VM_LIMITS,
  type BotBrowserState, type BrowserAddonInfo, type BrowserError, type BrowserSetup, type PermissionDecision, type PermissionRequest,
} from './types.ts'

/** Copy the FE builds that no mockup shows. Each is listed in the FE-P2-3 report and has a `*-GAP-*` shot. */
export const PERMISSION_CARD_GAPS = {
  closed: 'closedBy run_stopped / run_ended / policy_changed: "… request closed" + why (no mockup)',
  browserDenied: 'browser card denied (no mockup; internet denied is mockup 02)',
  browserExpired: 'browser card expired (reuses the internet expired sentence)',
  toolBuildPending: 'internet card for a tool build, pending (mockup 02 shows only its allowed state)',
  buildFailed: 'setupError build_failed (09 shows download / check / low disk)',
  reusedDownload: 'setup step "Headless Chromium already downloaded" (download reused)',
  rebuildDone: 'setup step "Rebuilt …" and "Restarting … and checking Chromium" (04 shows only the first two steps live)',
  waitingIdle: 'VmInfo.browser.state waiting_idle: "· after the current run" on the restart step',
  actionError: 'Try again / Turn off browser failing: a red line under the buttons (like the send error)',
  turnedOff: 'after "Turn off browser" succeeds the buttons go away (the card keeps its error)',
} as const

/** Inline segments the render turns into elements (all text is escaped by React). */
export type Seg = string | { code: string } | { b: string } | { link: 'settings'; text: string }

export type CardTone = 'ok' | 'bad' | 'off' | 'run'
export type CardAction = 'retry' | 'turnOff' | 'settings'
export type CardButton = { key: string; label: string; cls: 'primary' | 'plain' | 'ghost' }
export type DecisionButton = CardButton & { decision: PermissionDecision }
export type ActionButton = CardButton & { action: CardAction }
export type StepState = 'ok' | 'run' | 'dim'
export type SetupStep = { key: string; state: StepState; label: string; meta?: string; progress?: number }

export type PendingView = {
  mode: 'pending'
  kind: PermissionRequest['type']
  title: string
  sub: Seg[]
  hostsLabel: string | null
  hosts: string[]
  /** More than PERMISSION_HOSTS_MAX hosts arrived (the BE caps; defensive). */
  moreHosts: number
  buttons: DecisionButton[]
  foot: Seg[]
  timer: string
  timerLow: boolean
  error: string | null
  label: string
}

export type DoneView = {
  mode: 'done'
  kind: PermissionRequest['type']
  title: Seg[]
  sub: Seg[]
  tone: CardTone
  pill: string
  steps: SetupStep[]
  next: string | null
  buttons: ActionButton[]
  error: string | null
  label: string
}

export type PermissionCardView = PendingView | DoneView

export type PermissionCardInput = {
  request: PermissionRequest
  botName: string
  /** Server time now (client clock + LiveState.clockSkewMs), for the countdown and running step clocks. */
  nowMs: number
  /** The group's name when the request has no groupName (older rows). */
  groupName?: string
  /** An internet card that follows this run's browser card (mockup 05): browser sentence, no footer link. */
  afterBrowser?: boolean
  /** The decision being sent. */
  sending?: PermissionDecision | null
  /** "Couldn't send your answer: …" (mockup 10). */
  sendError?: string | null
  /** The POST came back 409: the card shows the real status with the "already answered" line (mockup 10). */
  answeredElsewhere?: boolean
  /** The shared download (browser.updated), for live bytes while this card's download step runs. */
  browser?: BrowserAddonInfo
  /** VmInfo.browser.state when known (waiting_idle). */
  botBrowserState?: BotBrowserState
  /** Try again / Turn off browser in flight, failed, or done. */
  acting?: CardAction | null
  actionError?: string | null
  turnedOff?: boolean
}

/* ---- formatting ---- */

const MB = 1000 ** 2
const GB = 1000 ** 3

/** "0:48", "9:52" (never negative). */
export function timerText(ms: number): string {
  return clockText(Math.max(0, Math.ceil(ms / 1000) * 1000))
}

/** "620 MB" (decimal MB, like the BE's 1343 MB download). */
export function mbText(bytes: number): string {
  return `${Math.round(bytes / MB)} MB`
}

/** "1.3 GB". Under 1 GB: MB. */
export function sizeText(bytes: number): string {
  return bytes < GB ? mbText(bytes) : `${(Math.round(bytes / GB * 10) / 10).toFixed(1)} GB`
}

/** "1 min 42 s" between two ISO times (null when either is missing). */
export function spanText(from: string | undefined, to: string | undefined): string | null {
  if (!from || !to) return null
  return durationText(Date.parse(to) - Date.parse(from))
}

const lowerFirst = (s: string) => (s ? s[0].toLowerCase() + s.slice(1) : s)
const noDot = (s: string) => s.trim().replace(/[.!]+$/, '')
const hm = (iso: string | undefined) => (iso ? clockTime(iso) : '')
const possessive = (name: string) => `${name}'s`

/** The send error line (mockup 10): "Couldn't send your answer: could not reach the API server. Try again." */
export function sendErrorText(err: unknown): string {
  const msg = err instanceof Error ? err.message.trim() : ''
  const what = !msg || /fetch|network/i.test(msg) ? 'could not reach the API server' : lowerFirst(noDot(msg))
  return `Couldn't send your answer: ${what}. Try again.`
}

/* ---- copy ---- */

export const NET_FOOT = "Public sites only, through AgentControl's proxy. Your home network, Tailscale, this computer and your model server stay blocked."
export const GROUP_FOOT = "Only you can answer; other bots in this group can't."
export const PENDING_LINE = 'Nothing in this run reaches the internet until you choose.'
export const AFTER_BROWSER_LINE = 'The browser can only open pages you allow.'
export const BUILD_PENDING_LINE = 'Nothing in this build reaches the internet until you choose.'
const SETTINGS: Seg = { link: 'settings', text: 'Settings › VM' }

const isToolBuild = (r: PermissionRequest) => r.runKind === 'tool_build'
const groupOf = (input: PermissionCardInput) => (input.request.groupId ? (input.request.groupName ?? input.groupName ?? 'this group') : null)

/** "To run `x.py` in Q3 report". */
function runRef(input: PermissionCardInput): Seg[] {
  const r = input.request
  if (isToolBuild(r)) return [`To build ${possessive(input.botName)} tools`]
  const group = groupOf(input)
  return ['To run ', r.scriptName ? { code: r.scriptName } : 'its script', ...(group ? [` in ${group}`] : [])]
}

/** "fetch_rates.py" as a code segment, or "the tool build". */
function runName(r: PermissionRequest): Seg {
  if (isToolBuild(r)) return 'the tool build'
  return r.scriptName ? { code: r.scriptName } : 'its script'
}

const DECISION_LABEL = (bot: string): Record<string, string> => ({
  allowed_once: 'Allowed once', always: `Always for ${bot}`, denied: 'Denied', timeout: 'Expired', enabled: 'Turned on',
})

/**
 * The internet card's closing sentence (mockups 01, 05). Mockups 09 and 10 leave it out: none on group
 * cards (10, where the footer carries the group sentence) and none while a send error shows (09).
 */
export function pendingLine(input: PermissionCardInput): string | null {
  if (input.request.type !== 'internet' || groupOf(input) || input.sendError) return null
  if (input.afterBrowser) return AFTER_BROWSER_LINE
  return isToolBuild(input.request) ? BUILD_PENDING_LINE : PENDING_LINE
}

/**
 * The bot whose VmInfo a card needs (its browser state shows "after the current run" while waiting_idle):
 * a browser card that turned the browser on and whose setup hasn't finished or failed, while that bot's
 * VM isn't held. The card then calls loadVm, which keeps it fresh through vm.updated and resyncs.
 */
export function setupVmAgent(request: PermissionRequest | undefined, heldVms: Readonly<Record<string, unknown>>): string | undefined {
  if (!request || request.type !== 'browser' || request.status !== 'enabled') return undefined
  if (request.setupError || request.setup?.readyAt) return undefined
  return heldVms[request.agentId] ? undefined : request.agentId
}

function pendingView(input: PermissionCardInput): PendingView {
  const r = input.request
  const bot = input.botName
  const group = groupOf(input)
  const remaining = Date.parse(r.expiresAt) - input.nowMs
  const why = r.why?.trim()
  let title: string
  let sub: Seg[]
  let foot: Seg[]
  let buttons: DecisionButton[]
  if (r.type === 'browser') {
    title = `${bot} wants to use a browser`
    sub = [...runRef(input), ' it needs headless Chromium (Playwright)', ...(why ? [` to ${lowerFirst(noDot(why))}`] : []), `. The browser is off for ${bot}.`]
    const gb = Math.round(VM_LIMITS.personalDiskMb / 1024)
    foot = [`Turning it on downloads Chromium once (about ${sizeText(1343 * MB)}, shared by all bots, not counted in ${possessive(bot)} ${gb} GB).`]
    if (r.internetNext) foot.push(` The page is on the internet, so ${possessive(bot)} `, { b: 'Ask each time' }, ' rule asks next.')
    buttons = [
      { key: 'enable', decision: 'enable', label: `Turn on browser for ${bot}`, cls: 'primary' },
      { key: 'deny', decision: 'deny', label: 'Deny', cls: 'ghost' },
    ]
  } else {
    title = `${bot} wants to use the internet`
    const line = pendingLine(input)
    sub = [...runRef(input), why ? `: “${why}”` : '.', ...(line ? [` ${line}`] : [])]
    foot = [NET_FOOT]
    buttons = [
      { key: 'allow_once', decision: 'allow_once', label: 'Allow once', cls: 'primary' },
      { key: 'always', decision: 'always', label: `Always for ${bot}`, cls: 'plain' },
      { key: 'deny', decision: 'deny', label: 'Deny', cls: 'ghost' },
    ]
  }
  if (group) foot = [`${GROUP_FOOT} `, ...foot]
  // Link: 01/03 show it; group cards (10, 01b), the follow-up internet card (05) and a card showing a
  // send error (09) don't.
  else if (!input.afterBrowser && !input.sendError) foot = [...foot, ' ', SETTINGS]
  const hosts = r.type === 'internet' ? (r.hosts ?? []) : []
  return {
    mode: 'pending', kind: r.type, title, sub,
    hostsLabel: hosts.length ? 'Expects to reach' : null,
    hosts: hosts.slice(0, PERMISSION_HOSTS_MAX),
    moreHosts: Math.max(0, hosts.length - PERMISSION_HOSTS_MAX),
    buttons, foot,
    timer: `${timerText(remaining)} left`,
    timerLow: remaining <= 60_000,
    error: input.sendError ?? null,
    label: `${r.type} permission`,
  }
}

/** Live bytes for the download step: the shared download's when it's further along than the card's snapshot. */
function downloadBytes(setup: BrowserSetup, browser: BrowserAddonInfo | undefined): { bytes: number; total: number } {
  const total = setup.download.totalBytes ?? browser?.totalBytes ?? 1343 * MB
  let bytes = setup.download.bytes ?? 0
  if (browser?.state === 'downloading' && typeof browser.bytes === 'number' && browser.bytes > bytes) bytes = browser.bytes
  return { bytes: Math.min(bytes, total), total }
}

export function setupSteps(input: PermissionCardInput, setup: BrowserSetup): SetupStep[] {
  const bot = input.botName
  const steps: SetupStep[] = [{ key: 'on', state: 'ok', label: `Turned on for ${bot} by you`, meta: hm(setup.turnedOnAt) }]
  const d = setup.download
  if (d.reused) steps.push({ key: 'dl', state: 'ok', label: 'Headless Chromium already downloaded' })
  else if (d.endedAt) {
    const parts = [sizeText(d.totalBytes ?? d.bytes ?? 1343 * MB), spanText(d.startedAt, d.endedAt)].filter(Boolean)
    steps.push({ key: 'dl', state: 'ok', label: 'Downloaded headless Chromium', meta: parts.join(' · ') })
  } else {
    const { bytes, total } = downloadBytes(setup, input.browser)
    const pct = total ? Math.floor((bytes / total) * 100) : 0
    steps.push({ key: 'dl', state: 'run', label: 'Downloading headless Chromium', meta: `${mbText(bytes)} of ${sizeText(total)} · ${pct}%`, progress: pct })
  }
  const downloaded = Boolean(d.reused || d.endedAt)
  const rb = setup.rebuild
  const tools = `${possessive(bot)} tools on the browser base`
  if (rb.endedAt) steps.push({ key: 'rb', state: 'ok', label: `Rebuilt ${tools}`, meta: spanText(rb.startedAt, rb.endedAt) ?? undefined })
  else if (rb.startedAt && downloaded) steps.push({ key: 'rb', state: 'run', label: `Rebuilding ${tools}`, meta: clockText(input.nowMs - Date.parse(rb.startedAt)) })
  else steps.push({ key: 'rb', state: 'dim', label: `Rebuild ${tools}` })
  const c = setup.check
  if (c.status === 'pass') steps.push({ key: 'ck', state: 'ok', label: `Restarted ${possessive(bot)} VM and checked Chromium`, meta: hm(c.at) })
  else if (rb.endedAt) {
    const waiting = input.botBrowserState === 'waiting_idle'
    steps.push({ key: 'ck', state: 'run', label: `Restarting ${possessive(bot)} VM and checking Chromium`, meta: waiting ? 'after the current run' : undefined })
  } else steps.push({ key: 'ck', state: 'dim', label: `Restart ${possessive(bot)} VM and check Chromium` })
  return steps
}

function readySub(setup: BrowserSetup): string {
  const d = setup.download
  const parts = [
    d.reused ? 'download already here' : spanText(d.startedAt, d.endedAt) ? `download ${spanText(d.startedAt, d.endedAt)}` : null,
    spanText(setup.rebuild.startedAt, setup.rebuild.endedAt) ? `rebuild ${spanText(setup.rebuild.startedAt, setup.rebuild.endedAt)}` : null,
    'Chromium check passed',
  ].filter(Boolean)
  return `Turned on by you at ${hm(setup.turnedOnAt)} · ready at ${hm(setup.readyAt)} (${parts.join(', ')}).`
}

function errorView(input: PermissionCardInput, e: BrowserError): Omit<DoneView, 'mode' | 'kind' | 'label' | 'error' | 'steps' | 'next'> {
  const r = input.request
  const bot = input.botName
  const off = input.turnedOff
  const retry = (cls: CardButton['cls']): ActionButton => ({ key: 'retry', action: 'retry', label: 'Try again', cls })
  const stopped: Seg[] = r.scriptName ? [' ', { code: r.scriptName }, ` was stopped; nothing changed in ${possessive(bot)} tools.`] : [` Nothing changed in ${possessive(bot)} tools.`]
  switch (e.reason) {
    case 'download_failed': {
      const first = typeof e.bytes === 'number' ? `The Chromium download stopped at ${mbText(e.bytes)}${e.cause ? ` (${e.cause})` : ''}.` : e.message
      return {
        title: [`Couldn't turn on the browser for ${bot}`], sub: [first, ...stopped], tone: 'bad', pill: '✕ Failed',
        buttons: off ? [] : [retry('primary'), { key: 'off', action: 'turnOff', label: 'Turn off browser', cls: 'ghost' }],
      }
    }
    case 'chromium_check_failed':
      return {
        title: [`The browser isn't working for ${bot}`],
        sub: [`Chromium was installed but didn't start${e.cause ? ` (${e.cause})` : ''}. ${possessive(bot)} previous tools were kept. Details in Settings › VM.`],
        tone: 'bad', pill: '✕ Check failed',
        buttons: off ? [] : [retry('plain'), { key: 'settings', action: 'settings', label: 'Open Settings › VM', cls: 'ghost' }],
      }
    case 'low_disk':
      return {
        title: ['Not enough space to turn on the browser'], sub: [lowDiskText(e) ?? e.message], tone: 'bad', pill: '✕ Low disk',
        buttons: off ? [] : [retry('plain')],
      }
    default:
      // build_failed (GAP): the BE's message is the build's own line.
      return {
        title: [`Couldn't turn on the browser for ${bot}`], sub: [e.message], tone: 'bad', pill: '✕ Failed',
        buttons: off ? [] : [retry('primary'), { key: 'off', action: 'turnOff', label: 'Turn off browser', cls: 'ghost' }],
      }
  }
}

function closedSub(input: PermissionCardInput): Seg[] {
  const r = input.request
  const bot = input.botName
  if (r.closedBy === 'policy_changed')
    return r.type === 'browser'
      ? [`The browser was turned on or off for ${bot} in Settings › VM while this waited, so it closed.`]
      : [`${possessive(bot)} Internet rule changed in Settings › VM while this waited, so it closed.`]
  const name = runName(r)
  const verb = r.closedBy === 'run_stopped' ? 'was stopped' : 'ended'
  return [typeof name === 'string' ? name[0].toUpperCase() + name.slice(1) : name, ` ${verb} before you answered (${hm(r.resolvedAt)}).`]
}

function doneView(input: PermissionCardInput): DoneView {
  const r = input.request
  const bot = input.botName
  const t = hm(r.resolvedAt)
  const base = { mode: 'done' as const, kind: r.type, steps: [] as SetupStep[], next: null as string | null, buttons: [] as ActionButton[], error: null as string | null, label: `${r.type} permission` }
  let v: DoneView
  if (r.closedBy) {
    v = { ...base, title: [r.type === 'browser' ? 'Browser request closed' : 'Internet request closed'], sub: closedSub(input), tone: 'off', pill: 'Closed' }
  } else if (r.status === 'timeout') {
    v = {
      ...base, title: [r.type === 'browser' ? 'Browser request expired' : 'Internet request expired'],
      sub: [`No answer in 10 minutes, so it counted as Deny (${t}). ${bot} can ask again if you want it to.`], tone: 'off', pill: 'Expired',
    }
  } else if (r.status === 'denied') {
    v = r.type === 'browser'
      ? { ...base, title: ['Browser denied for ', runName(r)], sub: [`You denied it at ${t}. The browser stays off for ${bot}.`], tone: 'bad', pill: '✕ Denied' }
      : { ...base, title: ['Internet denied for ', runName(r)], sub: [`You denied it at ${t}. ${bot} was told “The user declined internet access.”`], tone: 'bad', pill: '✕ Denied' }
  } else if (r.status === 'allowed_once') {
    v = {
      ...base, title: ['Internet allowed for ', runName(r)],
      sub: [isToolBuild(r) ? `You allowed it at ${t}. Only this build gets the internet.` : `You allowed this run at ${t}. ${bot} asks again next time.`],
      tone: 'ok', pill: '✓ Allowed once',
    }
  } else if (r.status === 'always') {
    v = {
      ...base, title: [`Internet always allowed for ${bot}`],
      sub: [`You chose this at ${t}, so ${possessive(bot)} Internet rule is now `, { b: 'Always allow' }, '. Change it in ', SETTINGS, '.'],
      tone: 'ok', pill: `✓ Always for ${bot}`,
    }
  } else {
    // enabled (browser): setting up, ready, or an error.
    const setup: BrowserSetup = r.setup ?? {
      turnedOnAt: r.resolvedAt ?? r.createdAt, turnedOnBy: 'user', download: {}, rebuild: {}, check: { status: 'pending' },
    }
    if (r.setupError) {
      v = { ...base, ...errorView(input, r.setupError), error: input.actionError ?? null }
    } else if (setup.readyAt) {
      v = { ...base, title: [`Browser on for ${bot}`], sub: [readySub(setup)], tone: 'ok', pill: '✓ Browser on' }
    } else {
      v = {
        ...base, title: [`Turning on the browser for ${bot}`],
        sub: r.scriptName ? [{ code: r.scriptName }, " waits until it's ready. You can keep chatting."] : ['You can keep chatting.'],
        tone: 'run', pill: 'Setting up', steps: setupSteps(input, setup),
        next: r.internetNext ? `Next: ${bot} asks for the internet, because the page is online.` : null,
      }
    }
  }
  if (input.answeredElsewhere && r.status !== 'pending') {
    const label = r.closedBy ? 'Closed' : (DECISION_LABEL(bot)[r.status] ?? r.status)
    v = { ...v, sub: [`This was already answered in another window (${label} at ${t}).`], steps: [], next: null }
  }
  return v
}

export function permissionCardView(input: PermissionCardInput): PermissionCardView {
  return input.request.status === 'pending' ? pendingView(input) : doneView(input)
}

/** Retry / turn-off errors (FE-7's low-disk sentence for a 409 low_disk). */
export function actionErrorText(err: unknown, what: 'retry' | 'turnOff'): string {
  const body = (err as { body?: unknown } | null)?.body
  const reason = body && typeof body === 'object' ? (body as { reason?: unknown }).reason : undefined
  const msg = err instanceof Error ? err.message.trim() : ''
  const net = !msg || /fetch|network/i.test(msg)
  if (reason === 'low_disk') return lowDiskText(body as BrowserError) ?? msg
  const lead = what === 'retry' ? "Couldn't try again" : "Couldn't turn off the browser"
  return `${lead}: ${net ? 'could not reach the API server' : lowerFirst(noDot(msg))}.`
}
