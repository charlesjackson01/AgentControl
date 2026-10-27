import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import { api, apiUrl, authHeaders } from '../lib/api'
import { createLiveController } from '../lib/live-controller'
import type { ScriptRun } from '../lib/types'
import { vmPaths } from '../lib/vm-api'
import { LiveContext, type LiveContextValue } from './live-context'

/**
 * FE-P2-1: one unfiltered GET /api/events stream for the app (M1: SSE only, no polling).
 * Re-fetches active runs, watched bots' VM info and pending permission requests on every (re)connect and reset.
 * Renders nothing of its own.
 */
export default function LiveProvider({ children }: { children: ReactNode }) {
  const [controller] = useState(() =>
    createLiveController({
      client: {
        getRun: (id) => api.vm.getRun(id),
        getVm: (id) => api.vm.getVm(id),
        listPendingPermissions: () => api.vm.listPendingPermissions(),
      },
      connection: { url: apiUrl(vmPaths.events()), fetch: (input, init) => fetch(input, init), headers: authHeaders() },
    }),
  )
  useEffect(() => {
    controller.start()
    return () => controller.stop()
  }, [controller])
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState)
  const value = useMemo<LiveContextValue>(
    () => ({
      state,
      loadRun: controller.loadRun,
      loadVm: controller.loadVm,
      trackRuns: controller.trackRuns,
      putRun: (run: ScriptRun) => controller.dispatch({ type: 'run', run }),
    }),
    [state, controller],
  )
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>
}
