import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import { api, apiUrl, authHeaders } from '../lib/api'
import { createLiveController } from '../lib/live-controller'
import { vmPaths } from '../lib/vm-api'
import { liveActions } from './live-actions'
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
        getPermission: (id) => api.vm.getPermission(id),
        getBrowser: () => api.vm.getBrowser(),
      },
      connection: { url: apiUrl(vmPaths.events()), fetch: (input, init) => fetch(input, init), headers: authHeaders() },
    }),
  )
  useEffect(() => {
    controller.start()
    return () => controller.stop()
  }, [controller])
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState)
  // Built once per controller: a put* that changed with every state made VmTab's getBrowser effect loop.
  const actions = useMemo(() => liveActions(controller), [controller])
  const value = useMemo<LiveContextValue>(() => ({ state, ...actions }), [state, actions])
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>
}
