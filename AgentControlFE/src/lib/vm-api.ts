/*
 * FE-P2-1: the Phase 2 VM, script-run, undo and permission routes (docs/phase2-contract.md @ 4bf9429).
 * A factory over the shared `request`, so tests/vm-api.test.mjs can check every
 * method, path and body with a fake. `api.vm` in ./api.ts is the live instance.
 *
 * Routes land in BE-P2-17 (and earlier tasks); shapes are fixed by BE-P2-1.
 */
import {
  PERMISSION_CSRF_HEADER,
  type PermissionAnswer, type PermissionDecision, type PermissionListResponse, type PermissionRequest,
  type ScriptRun, type ScriptRunSummary, type UndoConflict, type UndoGone, type UndoPreview, type UndoRequest, type UndoResult,
  type VmHostInfo, type VmInfo, type VmPatch, type VmProbeResult, type VmSettingsPatch, type VmSettingsView, type VmToolsInfo,
} from './types.ts'

/** GET /api/agents/:id/script-runs page: newest first (BE be7afe4; Phase 1 /runs is model turns). */
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
    return `/api/agents/${enc(agentId)}/script-runs?${qs}`
  },
  agentExport: (agentId: string) => `/api/agents/${enc(agentId)}/export`,
  run: (runId: string) => `/api/runs/${enc(runId)}`,
  runOutput: (runId: string, stream: RunOutputStream) => `/api/runs/${enc(runId)}/output?stream=${stream}`,
  vmExport: () => '/api/vm/export',
  /** Pending permission requests, newest first (M2 route; shapes fixed now). */
  pendingPermissions: (filters?: { agentId?: string; conversationId?: string }) => {
    const qs = new URLSearchParams({ status: 'pending' })
    if (filters?.agentId) qs.set('agentId', filters.agentId)
    if (filters?.conversationId) qs.set('conversationId', filters.conversationId)
    return `/api/permissions?${qs}`
  },
  permission: (requestId: string) => `/api/permissions/${enc(requestId)}`,
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
    /** Last probe result; POST re-checks and answers when done. */
    getProbe: () => request<VmProbeResult>('/api/vm/probe'),
    recheckProbe: () => request<VmProbeResult>('/api/vm/probe', post()),
    /** 409 while runs are active, 400 when the host disk is low. */
    growMachine: (toGb: number) => request<VmHostInfo>('/api/vm/machine/grow', post({ toGb })),

    /* ---- permissions (M2 routes; shapes fixed by BE-P2-1 @ 4bf9429) ---- */
    listPendingPermissions: (filters?: { agentId?: string; conversationId?: string }) =>
      request<PermissionListResponse>(vmPaths.pendingPermissions(filters)),
    /**
     * Answer a request. The CSRF header (`x-agentcontrol-confirm: 1`) is required (403 without);
     * 409 when it was already resolved, 400 for a decision of the wrong type: read with permissionErrorOf.
     */
    answerPermission: (requestId: string, decision: PermissionDecision) => {
      const body: PermissionAnswer = { decision }
      return request<PermissionRequest>(vmPaths.permission(requestId), { ...post(body), headers: { [PERMISSION_CSRF_HEADER]: '1' } })
    },
  }
}

export type VmApi = ReturnType<typeof createVmApi>

/* ---- undo errors ---- */

export type UndoError =
  | { kind: 'run_active'; message: string }
  | { kind: 'conflicts'; message: string; conflicts: UndoPreview['conflicts'] }
  /** BE-P2-11: 409 already_undone (undo its undo run instead); `message` is the BE's text. */
  | { kind: 'already_undone'; message: string }
  | { kind: 'gone'; message: string; reason: UndoGone['reason'] }
  | { kind: 'other'; message: string; status?: number }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/**
 * Reads a failed preview/undo call (an ApiError carrying `status` and the parsed `body`)
 * into what the undo dialog needs: 409 run_active, 409 conflicts (the list), 409 already_undone,
 * 410 gone (why; BE-P2-11 also answers 410 'expired' when there's no snapshot record).
 */
export function undoErrorOf(err: unknown): UndoError {
  const message = err instanceof Error ? err.message : String(err)
  const status = isObj(err) && typeof err.status === 'number' ? err.status : undefined
  const body = isObj(err) && isObj(err.body) ? err.body : undefined
  // BE eb1d418: 409/410 come in Fastify's shape {statusCode, error, message, reason}; `message` is the
  // readable text and `error` only the status phrase ("Gone"), so the typed bodies are read by `message`.
  const own = (b: { message?: unknown }) => (typeof b.message === 'string' && b.message.trim() ? b.message.trim() : message)
  if (status === 409 && body) {
    const b = body as Partial<UndoConflict>
    if (b.reason === 'run_active') return { kind: 'run_active', message: own(b) }
    if (b.reason === 'conflicts') return { kind: 'conflicts', message: own(b), conflicts: Array.isArray(b.conflicts) ? b.conflicts : [] }
    if (b.reason === 'already_undone') return { kind: 'already_undone', message: own(b) }
  }
  if (status === 410 && body && typeof body.reason === 'string') {
    const b = body as Partial<UndoGone>
    return { kind: 'gone', message: own(b), reason: body.reason as UndoGone['reason'] }
  }
  return status === undefined ? { kind: 'other', message } : { kind: 'other', message, status }
}

/* ---- permission answer errors ---- */

export type PermissionError =
  /** 409: answered already (another tab, or it timed out). Re-fetch the list; nothing to retry. */
  | { kind: 'resolved'; message: string }
  /** 403: the CSRF header was missing or refused. A client bug, not the user's. */
  | { kind: 'forbidden'; message: string }
  | { kind: 'not_found'; message: string }
  | { kind: 'other'; message: string; status?: number }

export function permissionErrorOf(err: unknown): PermissionError {
  const message = err instanceof Error ? err.message : String(err)
  const status = isObj(err) && typeof err.status === 'number' ? err.status : undefined
  if (status === 409) return { kind: 'resolved', message }
  if (status === 403) return { kind: 'forbidden', message }
  if (status === 404) return { kind: 'not_found', message }
  return status === undefined ? { kind: 'other', message } : { kind: 'other', message, status }
}
