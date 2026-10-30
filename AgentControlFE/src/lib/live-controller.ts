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
import type { PermissionListResponse, ScriptRun, VmInfo } from './types.ts'

export type LiveClient = {
  getRun: (runId: string) => Promise<ScriptRun>
  getVm: (agentId: string) => Promise<VmInfo>
  /** GET /api/permissions?status=pending (unfiltered). An M1 BE may not have it yet: a failure keeps what we hold. */
  listPendingPermissions: () => Promise<PermissionListResponse>
}

export type LiveControllerOptions = {
  client: LiveClient
  /** Passed to connectLiveEvents (url, fetch, headers, timers, retry/idle overrides). */
  connection: Omit<LiveConnectionOptions, 'onEvent' | 'onReset' | 'onOpen' | 'onStatus'>
  initialState?: LiveState
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
  /** Resolves when the in-flight resync (if any) settles. */
  resync: () => Promise<void>
}

export function createLiveController(opts: LiveControllerOptions): LiveController {
  let state = opts.initialState ?? initialLiveState
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

  const loadPending = async () => {
    try {
      const { requests } = await opts.client.listPendingPermissions()
      if (Array.isArray(requests)) dispatch({ type: 'pending', requests })
    } catch {
      // Keep the requests we hold; the next (re)connect tries again.
    }
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
        await Promise.all([...plan.runIds.map(loadRun), ...plan.agentIds.map(loadVm), loadPending()])
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
        onEvent: (event) => dispatch({ type: 'event', event }),
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
    trackRuns(runIds) {
      for (const id of runIds) if (!state.runs[id]) tracked.add(id)
    },
    resync,
  }
}
