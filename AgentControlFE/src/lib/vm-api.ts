/*
 * FE-P2-1: the Phase 2 VM, script-run and undo routes (docs/phase2-contract.md @ 6e4291b).
 * A factory over the shared `request`, so tests/vm-api.test.mjs can check every
 * method, path and body with a fake. `api.vm` in ./api.ts is the live instance.
 *
 * Routes land in BE-P2-17 (and earlier tasks); shapes are fixed by BE-P2-1.
 */
import type {
  AgentVm, ScriptRun, ScriptRunSummary, ToolManifest, UndoConflict, UndoGone, UndoPreview, UndoRequest, UndoResult,
  VmHostInfo, VmInfo, VmPatch, VmSettingsPatch, VmSettingsView,
} from './types'

/** GET /api/agents/:id/vm/tools. Not a named BE type: the contract says `ToolManifest & {packages, image}`. */
export type VmToolsInfo = ToolManifest & { packages: string[]; image: AgentVm['image'] }

/** GET /api/agents/:id/runs page: newest first. */
export type ScriptRunPage = { runs: ScriptRunSummary[]; hasMore: boolean }

export type RunOutputStream = 'stdout' | 'stderr'

export const RUN_PAGE_SIZE = 50

/** `request<T>(path, init)` from ./api.ts: JSON in and out, throws ApiError (with `body`) on non-2xx. */
export type JsonRequest = <T>(path: string, init?: RequestInit) => Promise<T>
/** Same, but resolves the raw text body (the run log). */
export type TextRequest = (path: string, init?: RequestInit) => Promise<string>

const enc = encodeURIComponent
const post = (body?: unknown): RequestInit => (body === undefined ? { method: 'POST' } : { method: 'POST', body: JSON.stringify(body) })
const patch = (body: unknown): RequestInit => ({ method: 'PATCH', body: JSON.stringify(body) })

/** Paths, kept apart so download links (export zips) and tests share them. */
export const vmPaths = {
  agentVm: (agentId: string) => `/api/agents/${enc(agentId)}/vm`,
  agentRuns: (agentId: string, opts?: { before?: string; limit?: number }) => {
    const qs = new URLSearchParams({ limit: String(opts?.limit ?? RUN_PAGE_SIZE) })
    if (opts?.before) qs.set('before', opts.before)
    return `/api/agents/${enc(agentId)}/runs?${qs}`
  },
  agentExport: (agentId: string) => `/api/agents/${enc(agentId)}/export`,
  run: (runId: string) => `/api/runs/${enc(runId)}`,
  runOutput: (runId: string, stream: RunOutputStream) => `/api/runs/${enc(runId)}/output?stream=${stream}`,
  vmExport: () => '/api/vm/export',
  /** Live events (SSE). Filters are optional; the app opens one unfiltered stream. */
  events: (filters?: { conversationId?: string; agentId?: string }) => {
    const qs = new URLSearchParams()
    if (filters?.conversationId) qs.set('conversationId', filters.conversationId)
    if (filters?.agentId) qs.set('agentId', filters.agentId)
    const q = qs.toString()
    return q ? `/api/events?${q}` : '/api/events'
  },
}

export function createVmApi(request: JsonRequest, requestText: TextRequest) {
  return {
    /* ---- per bot ---- */
    getVm: (agentId: string) => request<VmInfo>(vmPaths.agentVm(agentId)),
    /** 400 for unknown keys, limits, egress, reserved env names and (M1) permissions.browser:true. */
    updateVm: (agentId: string, body: VmPatch) => request<VmInfo>(vmPaths.agentVm(agentId), patch(body)),
    startVm: (agentId: string) => request<VmInfo>(`${vmPaths.agentVm(agentId)}/start`, post()),
    stopVm: (agentId: string) => request<VmInfo>(`${vmPaths.agentVm(agentId)}/stop`, post()),
    /** 409 while a run is active. */
    resetVm: (agentId: string) => request<VmInfo>(`${vmPaths.agentVm(agentId)}/reset`, post({ confirm: true })),
    getVmTools: (agentId: string) => request<VmToolsInfo>(`${vmPaths.agentVm(agentId)}/tools`),
    /** A kind 'tool_build' run. */
    rebuildTools: (agentId: string) => request<ScriptRun>(`${vmPaths.agentVm(agentId)}/tools/rebuild`, post()),
    rollbackTools: (agentId: string) => request<ScriptRun>(`${vmPaths.agentVm(agentId)}/tools/rollback`, post()),
    listRuns: (agentId: string, opts?: { before?: string; limit?: number }) => request<ScriptRunPage>(vmPaths.agentRuns(agentId, opts)),

    /* ---- one run ---- */
    getRun: (runId: string) => request<ScriptRun>(vmPaths.run(runId)),
    /** Full log as text; 410 once evicted. */
    getRunOutput: (runId: string, stream: RunOutputStream = 'stdout') => requestText(vmPaths.runOutput(runId, stream)),
    /** 409 when the run isn't active. */
    stopRun: (runId: string) => request<ScriptRun>(`${vmPaths.run(runId)}/stop`, post()),
    /** 409 UndoConflict{reason:'run_active'}, 410 UndoGone: read them with undoErrorOf. */
    getUndoPreview: (runId: string) => request<UndoPreview>(`${vmPaths.run(runId)}/undo/preview`),
    /** force: "Undo anyway" over conflicting files. 409 UndoConflict, 410 UndoGone. */
    undoRun: (runId: string, force = false) => {
      const body: UndoRequest = force ? { force: true } : {}
      return request<UndoResult>(`${vmPaths.run(runId)}/undo`, post(body))
    },

    /* ---- global ---- */
    getHost: () => request<VmHostInfo>('/api/vm/host'),
    getSettings: () => request<VmSettingsView>('/api/vm/settings'),
    updateSettings: (body: VmSettingsPatch) => request<VmSettingsView>('/api/vm/settings', patch(body)),
    /** GAP: the contract gives no type for the probe body ("last probe per check"). */
    getProbe: () => request<unknown>('/api/vm/probe'),
    recheckProbe: () => request<unknown>('/api/vm/probe', post()),
    /** 409 while runs are active, 400 when the host disk is low. */
    growMachine: (toGb: number) => request<VmHostInfo>('/api/vm/machine/grow', post({ toGb })),
  }
}

export type VmApi = ReturnType<typeof createVmApi>

/* ---- undo errors ---- */

export type UndoError =
  | { kind: 'run_active'; message: string }
  | { kind: 'conflicts'; message: string; conflicts: UndoPreview['conflicts'] }
  | { kind: 'gone'; message: string; reason: UndoGone['reason'] }
  | { kind: 'other'; message: string; status?: number }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/**
 * Reads a failed preview/undo call (an ApiError carrying `status` and the parsed `body`)
 * into what the undo dialog needs: 409 run_active, 409 conflicts (the list), 410 gone (why).
 */
export function undoErrorOf(err: unknown): UndoError {
  const message = err instanceof Error ? err.message : String(err)
  const status = isObj(err) && typeof err.status === 'number' ? err.status : undefined
  const body = isObj(err) && isObj(err.body) ? err.body : undefined
  if (status === 409 && body) {
    const b = body as Partial<UndoConflict>
    if (b.reason === 'run_active') return { kind: 'run_active', message }
    if (b.reason === 'conflicts') return { kind: 'conflicts', message, conflicts: Array.isArray(b.conflicts) ? b.conflicts : [] }
  }
  if (status === 410 && body && typeof body.reason === 'string') return { kind: 'gone', message, reason: body.reason as UndoGone['reason'] }
  return status === undefined ? { kind: 'other', message } : { kind: 'other', message, status }
}
