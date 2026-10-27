import { createContext, useContext } from 'react'
import type { LiveController } from '../lib/live-controller'
import type { LiveState } from '../lib/live-store'
import type { ScriptRun } from '../lib/types'

/** FE-P2-1: Phase 2 live data (script runs, run cards, VM info, permission requests). */
export type LiveContextValue = {
  state: LiveState
  loadRun: LiveController['loadRun']
  loadVm: LiveController['loadVm']
  trackRuns: LiveController['trackRuns']
  /** Put a run from a REST response (stop, undo, rebuild) into the store. */
  putRun: (run: ScriptRun) => void
}

export const LiveContext = createContext<LiveContextValue | null>(null)

export function useLive(): LiveContextValue {
  const ctx = useContext(LiveContext)
  if (!ctx) throw new Error('useLive must be used inside <LiveProvider>')
  return ctx
}
