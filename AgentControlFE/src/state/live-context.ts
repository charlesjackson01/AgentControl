import { createContext, useContext } from 'react'
import type { LiveController } from '../lib/live-controller'
import type { LiveState } from '../lib/live-store'
import type { BrowserAddonInfo, ScriptRun, VmInfo } from '../lib/types'

/** FE-P2-1: Phase 2 live data (script runs, run cards, VM info, permission requests). */
export type LiveContextValue = {
  state: LiveState
  loadRun: LiveController['loadRun']
  loadVm: LiveController['loadVm']
  trackRuns: LiveController['trackRuns']
  /** Put a run from a REST response (stop, undo, rebuild) into the store. */
  putRun: (run: ScriptRun) => void
  /** Put VM info from a REST response (start, stop, reset, PATCH) into the store. */
  putVm: (vm: VmInfo) => void
  /** FE-P2-10: the shared Chromium download (GET /api/vm/browser, retry, remove). */
  putBrowser: (browser: BrowserAddonInfo) => void
}

export const LiveContext = createContext<LiveContextValue | null>(null)

export function useLive(): LiveContextValue {
  const ctx = useContext(LiveContext)
  if (!ctx) throw new Error('useLive must be used inside <LiveProvider>')
  return ctx
}
