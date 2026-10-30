/**
 * BE-P2-12: Phase 2 live events (GET /api/events, text/event-stream).
 *
 * A bus with monotonic ids and a ring of the last LIVE_EVENT_REPLAY events. Each frame is
 * `id: <n>` / `event: <type>` / `data: <LiveEvent JSON>`. `retry: 3000` is sent once on connect,
 * a `: ping` comment every LIVE_EVENT_HEARTBEAT_MS. Reconnects send `Last-Event-ID` (or
 * `?lastEventId=`): newer events are replayed; when the id is older than the ring the first frame
 * is `event: reset` with `data: {}` and `id:` the latest event id (so reconnecting with it doesn't reset again). Optional filters: `?conversationId=` and `?agentId=`.
 */
import type { FastifyInstance } from 'fastify'
import { LIVE_EVENT_HEARTBEAT_MS, LIVE_EVENT_REPLAY, type LiveEvent } from './shared/types.js'

export interface LiveEventEntry {
  id: number
  event: LiveEvent
}

export interface LiveEventBus {
  publish(event: LiveEvent): number
  /** Events newer than `lastId`; `reset` when some of them already left the ring. */
  since(lastId: number): { reset: boolean; events: LiveEventEntry[] }
  subscribe(fn: (e: LiveEventEntry) => void): () => void
  lastId(): number
  /** Connected stream clients (tests and logs). */
  clients(): number
}

export function createLiveEvents(opts: { replay?: number } = {}): LiveEventBus {
  const cap = Math.max(1, opts.replay ?? LIVE_EVENT_REPLAY)
  const ring: LiveEventEntry[] = []
  const subs = new Set<(e: LiveEventEntry) => void>()
  let next = 1
  return {
    publish(event) {
      const entry = { id: next++, event }
      ring.push(entry)
      if (ring.length > cap) ring.splice(0, ring.length - cap)
      for (const fn of [...subs]) {
        try {
          fn(entry)
        } catch {
          // a broken subscriber never stops the others
        }
      }
      return entry.id
    },
    since(lastId) {
      const last = next - 1
      if (!Number.isFinite(lastId) || lastId < 0 || lastId > last) return { reset: lastId > last, events: [] }
      if (lastId === last) return { reset: false, events: [] }
      const oldest = ring.length ? ring[0]!.id : next
      // Every event after lastId must still be in the ring.
      if (lastId + 1 < oldest) return { reset: true, events: [...ring] }
      return { reset: false, events: ring.filter((e) => e.id > lastId) }
    },
    subscribe(fn) {
      subs.add(fn)
      return () => {
        subs.delete(fn)
      }
    },
    lastId: () => next - 1,
    clients: () => subs.size,
  }
}

/** True when the event belongs to the filtered conversation / agent (unfiltered: everything). */
export function liveEventMatches(e: LiveEvent, f: { conversationId?: string; agentId?: string; runAgent?: (runId: string) => string | undefined }): boolean {
  if (f.conversationId) {
    if (!('conversationId' in e) || e.conversationId !== f.conversationId) return false
  }
  if (f.agentId) {
    if (e.type === 'vm.updated') return e.agentId === f.agentId
    if (e.type === 'run.updated') return e.run.agentId === f.agentId
    if (e.type === 'permission.requested' || e.type === 'permission.resolved') return e.request.agentId === f.agentId
    if (e.type === 'run.output') return f.runAgent?.(e.runId) === f.agentId
    return false
  }
  return true
}

export function frame(entry: LiveEventEntry): string {
  return `id: ${entry.id}\nevent: ${entry.event.type}\ndata: ${JSON.stringify(entry.event)}\n\n`
}

export interface EventsRouteOptions {
  heartbeatMs?: number
  /** run.output carries no agentId; this maps a run id to its bot for `?agentId=`. */
  runAgent?: (runId: string) => string | undefined
}

export function registerLiveEventRoutes(app: FastifyInstance, bus: LiveEventBus, opts: EventsRouteOptions = {}): void {
  const open = new Set<() => void>()
  app.addHook('onClose', async () => {
    for (const close of [...open]) close()
  })
  app.get('/api/events', (req, reply) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>
    const filter = {
      conversationId: typeof q.conversationId === 'string' && q.conversationId ? q.conversationId : undefined,
      agentId: typeof q.agentId === 'string' && q.agentId ? q.agentId : undefined,
      runAgent: opts.runAgent,
    }
    const header = req.headers['last-event-id']
    const rawLast = (Array.isArray(header) ? header[0] : header) ?? q.lastEventId
    const lastId = rawLast !== undefined && rawLast !== '' && /^\d+$/.test(String(rawLast)) ? Number(rawLast) : null
    reply.hijack()
    const res = reply.raw
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    let closed = false
    const write = (s: string) => {
      if (!closed) res.write(s)
    }
    write('retry: 3000\n\n')
    // Subscribe before the replay so nothing published in between is lost; dedupe by id.
    const pending: LiveEventEntry[] = []
    let replaying = true
    let sent = lastId ?? bus.lastId()
    const send = (e: LiveEventEntry) => {
      if (e.id <= sent) return
      sent = e.id
      if (liveEventMatches(e.event, filter)) write(frame(e))
    }
    const unsub = bus.subscribe((e) => (replaying ? pending.push(e) : send(e)))
    if (lastId !== null) {
      const r = bus.since(lastId)
      if (r.reset) {
        // The reset carries the latest id: reconnecting with it (Last-Event-ID) doesn't reset again.
        sent = bus.lastId()
        write(`id: ${sent}\nevent: reset\ndata: {}\n\n`)
      } else for (const e of r.events) send(e)
    }
    replaying = false
    for (const e of pending) send(e)
    const ping = setInterval(() => write(': ping\n\n'), opts.heartbeatMs ?? LIVE_EVENT_HEARTBEAT_MS)
    ping.unref?.()
    const close = () => {
      if (closed) return
      closed = true
      clearInterval(ping)
      unsub()
      open.delete(close)
      try {
        res.end()
      } catch {
        // already gone
      }
    }
    open.add(close)
    req.raw.on('close', close)
    res.on('error', close)
  })
}
