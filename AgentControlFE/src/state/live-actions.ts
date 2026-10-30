import type { LiveController } from '../lib/live-controller'
import type { LiveContextValue } from './live-context'

export type LiveActions = Omit<LiveContextValue, 'state'>

/**
 * The live context's actions. They depend only on the controller, so LiveProvider builds them once
 * (useMemo on [controller]) and they keep their identity when the state changes. Effects that list
 * one (VmTab's GET /api/vm/browser → putBrowser) must not re-run on every dispatch: a fresh putBrowser
 * per state change made that effect fetch, dispatch and fetch again without end (BE-15 check, 0d0f292).
 */
export function liveActions(controller: Pick<LiveController, 'loadRun' | 'loadVm' | 'trackRuns' | 'loadPermission' | 'dispatch' | 'vmReply'>): LiveActions {
  return {
    loadRun: controller.loadRun,
    loadVm: controller.loadVm,
    trackRuns: controller.trackRuns,
    putRun: (run) => controller.dispatch({ type: 'run', run }),
    putVm: (vm) => controller.dispatch({ type: 'vm', vm }),
    vmReply: controller.vmReply,
    loadPermission: controller.loadPermission,
    putPermission: (request) => controller.dispatch({ type: 'permissions', requests: [request] }),
    putBrowser: (browser) => controller.dispatch({ type: 'browser', browser }),
  }
}
