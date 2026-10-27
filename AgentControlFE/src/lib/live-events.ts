/*
 * FE-P2-1: the Phase 2 live-events stream, GET /api/events (docs/phase2-contract.md @ 6e4291b).
 * Pure apart from the injected fetch; tests/live-events.test.mjs.
 *
 * Read with fetch rather than EventSource so the optional bearer token (VITE_AUTH_TOKEN)
 * and `Last-Event-ID` go out as headers on every (re)connect. Frames are
 * `id: <n>` · `event: <type>` · `data: <LiveEvent JSON>`; `: ping` comments every 15 s;
 * `retry: 3000` once; `event: reset` when our Last-Event-ID is older than the 1000-event ring.
 * M1 is SSE only (no polling): on every open and every reset the caller re-fetches active
 * runs (see live-store.ts resyncPlan).
 */
import { LIVE_EVENT_HEARTBEAT_MS, type LiveEvent } from './types.ts'

export type SseFrame = { id?: string; event: string; data: string }

/**
 * Incremental text/event-stream parser (WHATWG rules: CR, LF or CRLF line ends; `id`
 * persists across frames; `data` lines join with \n; lines starting ':' are comments).
 * Frames with no data still dispatch when they name an event (so a bare `event: reset` counts).
 */
export function createSseParser(handlers: { frame: (f: SseFrame) => void; retry?: (ms: number) => void; comment?: (text: string) => void }) {
  let buf = ''
  let lastId: string | undefined
  let event = ''
  let data: string[] = []
  let pendingCr = false

  const line = (l: string) => {
    if (l === '') {
      if (data.length || event) handlers.frame({ ...(lastId !== undefined ? { id: lastId } : {}), event: event || 'message', data: data.join('\n') })
      event = ''
      data = []
      return
    }
    if (l.startsWith(':')) {
      handlers.comment?.(l.slice(1).trim())
      return
    }
    const colon = l.indexOf(':')
    const field = colon === -1 ? l : l.slice(0, colon)
    let value = colon === -1 ? '' : l.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') data.push(value)
    else if (field === 'event') event = value
    else if (field === 'id') {
      if (!value.includes('\0')) lastId = value
    } else if (field === 'retry') {
      if (/^\d+$/.test(value)) handlers.retry?.(Number(value))
    }
  }

  return {
    push(chunk: string) {
      let text = chunk
      // A CR at the end of the last chunk may be half of a CRLF.
      if (pendingCr) {
        pendingCr = false
        if (text.startsWith('\n')) text = text.slice(1)
      }
      buf += text
      for (;;) {
        const m = /\r\n|\r|\n/.exec(buf)
        if (!m) break
        if (m[0] === '\r' && m.index === buf.length - 1) {
          pendingCr = true
        }
        line(buf.slice(0, m.index))
        buf = buf.slice(m.index + m[0].length)
      }
    },
    /** The last `id:` seen (what to send as Last-Event-ID). */
    lastEventId: () => lastId,
  }
}

const LIVE_TYPES = new Set<LiveEvent['type']>(['run.updated', 'run.output', 'permission.requested', 'permission.resolved', 'vm.updated'])
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): v is string => typeof v === 'string' && v !== ''

/** One frame read: a live event, the server's reset, or null for anything malformed or unknown (ignored). */
export type LiveFrame = { kind: 'event'; id?: string; event: LiveEvent } | { kind: 'reset'; id?: string }

/** Checks the shape just enough that the store can't be broken by a bad or newer frame. */
export function readLiveFrame(f: SseFrame): LiveFrame | null {
  const id = f.id !== undefined ? { id: f.id } : {}
  if (f.event === 'reset') return { kind: 'reset', ...id }
  if (!LIVE_TYPES.has(f.event as LiveEvent['type'])) return null
  let body: unknown
  try {
    body = JSON.parse(f.data)
  } catch {
    return null
  }
  if (!isObj(body)) return null
  // The JSON carries `type` too; the event: line wins when it's missing, a mismatch is dropped.
  if (body.type !== undefined && body.type !== f.event) return null
  const ev = { ...body, type: f.event } as Record<string, unknown>
  switch (f.event) {
    case 'run.updated':
      if (!isObj(ev.run) || !str(ev.run.id) || !str(ev.run.agentId) || !str(ev.run.status) || !isObj(ev.summary)) return null
      break
    case 'run.output':
      if (!str(ev.runId) || (ev.stream !== 'stdout' && ev.stream !== 'stderr') || typeof ev.chunk !== 'string') return null
      break
    case 'permission.requested':
    case 'permission.resolved':
      if (!isObj(ev.request) || !str(ev.request.id) || !str(ev.request.runId) || !str(ev.request.status)) return null
      break
    case 'vm.updated':
      if (!str(ev.agentId) || !isObj(ev.vm)) return null
      break
  }
  return { kind: 'event', ...id, event: ev as unknown as LiveEvent }
}

export type LiveConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'closed'

export type LiveConnectionOptions = {
  url: string
  fetch: typeof fetch
  headers?: Record<string, string>
  /** Resume point (e.g. kept across a provider remount). */
  lastEventId?: string
  onEvent: (event: LiveEvent, id: string | undefined) => void
  /** `event: reset`: we were too far behind; re-fetch what's active. */
  onReset: () => void
  /** Each successful (re)connect. `reconnect` is false only for the very first one. */
  onOpen?: (info: { reconnect: boolean }) => void
  onStatus?: (status: LiveConnectionStatus) => void
  /** First retry delay until the server sends `retry:` (contract: 3000). */
  retryMs?: number
  /** Back-off ceiling for repeated failed connects. */
  maxRetryMs?: number
  /** No bytes (not even `: ping`) for this long → drop and reconnect. Default 3 missed heartbeats. */
  idleMs?: number
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
}

export const LIVE_RETRY_MS = 3000
export const LIVE_MAX_RETRY_MS = 30_000
export const LIVE_IDLE_MS = LIVE_EVENT_HEARTBEAT_MS * 3

/** Back-off after `failures` connects in a row that never opened (0 → base). */
export function retryDelay(base: number, failures: number, max: number): number {
  return Math.min(max, base * 2 ** Math.max(0, Math.min(failures, 10)))
}

/**
 * Opens the stream and keeps it open: reconnects after an error, a clean end or an idle
 * watchdog trip, sending `Last-Event-ID` so the server replays what we missed.
 */
export function connectLiveEvents(opts: LiveConnectionOptions): { close: () => void; lastEventId: () => string | undefined } {
  const setT = opts.setTimeout ?? ((fn: () => void, ms: number) => globalThis.setTimeout(fn, ms))
  const clearT = opts.clearTimeout ?? ((h: unknown) => globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>))
  const idleMs = opts.idleMs ?? LIVE_IDLE_MS
  const maxRetry = opts.maxRetryMs ?? LIVE_MAX_RETRY_MS
  let retryBase = opts.retryMs ?? LIVE_RETRY_MS
  let lastId = opts.lastEventId
  let closed = false
  let opened = false
  let failures = 0
  let controller: AbortController | undefined
  let wake: (() => void) | undefined
  let waitTimer: unknown

  const status = (s: LiveConnectionStatus) => opts.onStatus?.(s)

  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      wake = resolve
      waitTimer = setT(resolve, ms)
    })

  /** One connect; true when it opened (then the next retry uses the base delay). */
  async function once(): Promise<boolean> {
    let didOpen = false
    const ac = new AbortController()
    controller = ac
    let idle: unknown
    const bump = () => {
      if (idle !== undefined) clearT(idle)
      idle = setT(() => ac.abort(), idleMs)
    }
    try {
      const headers: Record<string, string> = { Accept: 'text/event-stream', ...opts.headers }
      if (lastId !== undefined) headers['Last-Event-ID'] = lastId
      bump()
      const res = await opts.fetch(opts.url, { headers, signal: ac.signal, cache: 'no-store' })
      if (!res.ok || !res.body) return false
      const reconnect = opened
      opened = true
      didOpen = true
      failures = 0
      status('open')
      opts.onOpen?.({ reconnect })
      const parser = createSseParser({
        retry: (ms) => {
          retryBase = ms
        },
        frame: (f) => {
          if (f.id !== undefined) lastId = f.id
          const read = readLiveFrame(f)
          if (!read) return
          if (read.kind === 'reset') opts.onReset()
          else opts.onEvent(read.event, read.id)
        },
      })
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      for (;;) {
        bump()
        const { done, value } = await reader.read()
        if (done || closed) break
        parser.push(decoder.decode(value, { stream: true }))
      }
      return true
    } catch {
      return didOpen
    } finally {
      if (idle !== undefined) clearT(idle)
      controller = undefined
    }
  }

  void (async () => {
    status('connecting')
    while (!closed) {
      const ok = await once()
      if (closed) break
      if (!ok) failures += 1
      status('reconnecting')
      await wait(retryDelay(retryBase, ok ? 0 : failures - 1, maxRetry))
    }
    status('closed')
  })()

  return {
    close() {
      if (closed) return
      closed = true
      controller?.abort()
      if (waitTimer !== undefined) clearT(waitTimer)
      wake?.()
    },
    lastEventId: () => lastId,
  }
}
