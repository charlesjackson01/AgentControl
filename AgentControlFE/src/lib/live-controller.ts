/*
 * FE-P2-1: ties the live-events stream to the live store and does the re-fetching.
 * No React here (tests/live-controller.test.mjs drives it with a fake fetch and client);
 * state/LiveProvider.tsx wraps one controller per app.
 *
 * - Every frame goes through liveReducer.
 * - On every open (the first one too) and on `event: reset`, the resyncPlan is fetched:
 *   active runs, the VM info of watched bots, and the pending permission requests (one list call).
 */
import { connectLiveEvents, type LiveConnectionOptions } from './live-events.ts'
import { initialLiveState, liveReducer, resyncPlan, type LiveAction, type LiveState } from './live-store.ts'
import type { BrowserAddonInfo, PermissionListResponse, PermissionRequest, ScriptRun, VmInfo } from './types.ts'

export type LiveClient = {
  getRun: (runId: string) => Promise<ScriptRun>
  getVm: (agentId: string) => Promise<VmInfo>
  /** GET /api/permissions?status=pending (unfiltered). An M1 BE may not have it yet: a failure keeps what we hold. */
  listPendingPermissions: () => Promise<PermissionListResponse>
  /** FE-P2-3 (fec4670): GET /api/permissions/:id, for a chat card whose request isn't held. */
  getPermission?: (requestId: string) => Promise<PermissionRequest>
  /** FE-P2-3 (fec4670): GET /api/vm/browser, re-fetched on every resync (contract: after `reset`). */
  getBrowser?: () => Promise<BrowserAddonInfo>
}

export type LiveControllerOptions = {
  client: LiveClient
  /** Passed to connectLiveEvents (url, fetch, headers, timers, retry/idle overrides). */
  connection: Omit<LiveConnectionOptions, 'onEvent' | 'onReset' | 'onOpen' | 'onStatus'>
  initialState?: LiveState
  /** Clock for the permission countdown's skew (tests). */
  now?: () => number
}

export type LiveController = {
  getState: () => LiveState
  subscribe: (listener: () => void) => () => void
  dispatch: (action: LiveAction) => void
  start: () => void
  stop: () => void
  /** Fetch one run into the store; it is then kept fresh by events and resyncs. */
  loadRun: (runId: string) => Promise<ScriptRun | undefined>
  /** Fetch a bot's VM info; the bot is then re-fetched on every resync. */
  loadVm: (agentId: string) => Promise<VmInfo | undefined>
  /** Mark run ids a view shows as active (from a message's scriptRun) so resyncs cover them before they're loaded. */
  trackRuns: (runIds: Iterable<string>) => void
  /** FE-P2-3: fetch one permission request (any status) into the store; one fetch at a time per id. */
  loadPermission: (requestId: string) => Promise<PermissionRequest | undefined>
  /** Resolves when the in-flight resync (if any) settles. */
  resync: () => Promise<void>
  /**
   * Put a VM REST reply (e.g. PATCH /api/agents/:id/vm) into the store. When a `vm.updated` for the bot
   * arrived while the request was out, the reply can be older than that event (BE-15 check: a Chromium
   * download that fails at once sends vm.updated `error` before the PATCH reply `setting_up`), so the bot
   * is re-read instead; if that read fails, the reply is used. Resolves with the reply.
   */
  vmReply: (agentId: string, call: () => Promise<VmInfo>) => Promise<VmInfo>
}

export function createLiveController(opts: LiveControllerOptions): LiveController {
  let state = opts.initialState ?? initialLiveState
  const clock = opts.now ?? (() => Date.now())
  const listeners = new Set<() => void>()
  const tracked = new Set<string>()
  let conn: ReturnType<typeof connectLiveEvents> | undefined
  let lastEventId = opts.connection.lastEventId
  let running: Promise<void> | undefined
  let again = false

  const dispatch = (action: LiveAction) => {
    const next = liveReducer(state, action)
    if (next === state) return
    state = next
    for (const l of listeners) l()
  }

  const loadRun = async (runId: string) => {
    try {
      const run = await opts.client.getRun(runId)
      dispatch({ type: 'run', run })
      return run
    } catch {
      return undefined
    }
  }
  const loadVm = async (agentId: string) => {
    try {
      const vm = await opts.client.getVm(agentId)
      dispatch({ type: 'vm', vm })
      return vm
    } catch {
      return undefined
    }
  }

  // vm.updated frames seen per bot, so a REST reply can tell whether an event overtook it.
  const vmEvents = new Map<string, number>()
  const vmReply = async (agentId: string, call: () => Promise<VmInfo>): Promise<VmInfo> => {
    const mark = vmEvents.get(agentId) ?? 0
    const vm = await call()
    if ((vmEvents.get(agentId) ?? 0) === mark || !(await loadVm(agentId))) dispatch({ type: 'vm', vm })
    return vm
  }

  const loadPending = async () => {
    try {
      const sentAt = clock()
      const { requests, now } = await opts.client.listPendingPermissions()
      // fec4670: `now` is the server time; skew = server - (the midpoint of our request).
      const server = typeof now === 'string' ? Date.parse(now) : NaN
      const skewMs = Number.isFinite(server) ? Math.round(server - (sentAt + clock()) / 2) : undefined
      if (Array.isArray(requests)) dispatch(skewMs === undefined ? { type: 'pending', requests } : { type: 'pending', requests, skewMs })
    } catch {
      // Keep the requests we hold; the next (re)connect tries again.
    }
  }

  const loadBrowser = async () => {
    if (!opts.client.getBrowser) return
    try {
      dispatch({ type: 'browser', browser: await opts.client.getBrowser() })
    } catch {
      // An M1 BE has no /api/vm/browser; cards fall back to their own setup snapshot.
    }
  }

  const permissionLoads = new Map<string, Promise<PermissionRequest | undefined>>()
  const loadPermission = (requestId: string): Promise<PermissionRequest | undefined> => {
    const get = opts.client.getPermission
    if (!get) return Promise.resolve(undefined)
    const inflight = permissionLoads.get(requestId)
    if (inflight) return inflight
    const p = get(requestId).then(
      (request) => {
        dispatch({ type: 'permissions', requests: [request] })
        return request
      },
      () => undefined,
    ).finally(() => permissionLoads.delete(requestId))
    permissionLoads.set(requestId, p)
    return p
  }

  // One resync at a time; a request during one runs one more pass after it.
  const resync = (): Promise<void> => {
    if (running) {
      again = true
      return running
    }
    running = (async () => {
      do {
        again = false
        const plan = resyncPlan(state, tracked)
        await Promise.all([...plan.runIds.map(loadRun), ...plan.agentIds.map(loadVm), loadPending(), loadBrowser()])
        // Once loaded, the store's own active list covers them.
        for (const id of [...tracked]) if (state.runs[id]) tracked.delete(id)
      } while (again)
    })().finally(() => {
      running = undefined
    })
    return running
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    dispatch,
    start() {
      if (conn) return
      conn = connectLiveEvents({
        ...opts.connection,
        // A stop/start (e.g. a provider remount) resumes where the last stream left off.
        lastEventId,
        onStatus: (status) => dispatch({ type: 'connection', status }),
        onEvent: (event) => {
          if (event.type === 'vm.updated') vmEvents.set(event.agentId, (vmEvents.get(event.agentId) ?? 0) + 1)
          dispatch({ type: 'event', event })
        },
        onOpen: () => {
          void resync()
        },
        onReset: () => {
          dispatch({ type: 'reset' })
          void resync()
        },
      })
    },
    stop() {
      lastEventId = conn?.lastEventId() ?? lastEventId
      conn?.close()
      conn = undefined
    },
    loadRun,
    loadVm,
    loadPermission,
    trackRuns(runIds) {
      for (const id of runIds) if (!state.runs[id]) tracked.add(id)
    },
    resync,
    vmReply,
  }
}
