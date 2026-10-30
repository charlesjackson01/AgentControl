/**
 * BE-P2-12: script run routes (contract "Per bot"):
 * - GET  /api/agents/:id/script-runs?before=<runId>&limit=50 → { runs: ScriptRunSummary[], hasMore } newest first
 * - GET  /api/runs/:runId → ScriptRun (404)
 * - GET  /api/runs/:runId/output?stream=stdout|stderr → text/plain full log (404, 410 log_evicted)
 * - POST /api/runs/:runId/stop → ScriptRun (409 not_active)
 * BE-P2-17 (undo, contract "Per bot"):
 * - GET  /api/runs/:runId/undo/preview → UndoPreview (404; 409 run_active / already_undone; 410 UndoGone{reason})
 * - POST /api/runs/:runId/undo {force?} → UndoResult {run, undoRun} (400 bad body; 404; 409 run_active /
 *   conflicts (with `conflicts`) / already_undone; 410 UndoGone{reason})
 * The Phase 1 /api/agents/:id/runs (model turns) is unchanged. Tool-build routes are in bot-env-routes.ts.
 */
import { createReadStream } from 'node:fs'
import type { FastifyInstance } from 'fastify'
import { fail, failWithReason } from './http.js'
import type { RunService } from './run-service.js'
import type { WorkspaceStore } from './store.js'
import type { Agent, UndoPreview, UndoResult } from './shared/types.js'
import { UNDO_RUN_ACTIVE_TEXT } from './undo.js'

/** BE-P2-17: what the undo routes need besides RunService (app.vmUndo and the bot's active-run count). */
export interface RunRouteDeps {
  undoPreview?: (agent: Agent, runId: string) => UndoPreview
  /** Runs queued or running for the bot, plus an undo in its slot (preview answers 409 run_active). */
  activeRuns?: (agentId: string) => number
}

export function registerRunRoutes(app: FastifyInstance, store: WorkspaceStore, runs: RunService, deps: RunRouteDeps = {}): void {
  app.get('/api/agents/:id/script-runs', async (request) => {
    const { id } = request.params as { id: string }
    if (!store.agents.some((a) => a.id === id)) fail(404, `No agent with id "${id}"`)
    const q = (request.query ?? {}) as { before?: string; limit?: string }
    let limit: number | undefined
    if (q.limit !== undefined && q.limit !== '') {
      limit = Number(q.limit)
      if (!Number.isInteger(limit) || limit < 1) fail(400, 'limit must be a whole number from 1 to 50.')
    }
    return runs.list(id, { ...(q.before ? { before: q.before } : {}), ...(limit !== undefined ? { limit } : {}) })
  })

  app.get('/api/runs/:runId', async (request) => {
    const { runId } = request.params as { runId: string }
    const run = runs.get(runId)
    if (!run) fail(404, 'Run not found.')
    return run
  })

  app.get('/api/runs/:runId/output', async (request, reply) => {
    const { runId } = request.params as { runId: string }
    const q = (request.query ?? {}) as { stream?: string }
    const stream = q.stream ?? 'stdout'
    if (stream !== 'stdout' && stream !== 'stderr') fail(400, 'stream must be stdout or stderr.')
    if (!runs.get(runId)) fail(404, 'Run not found.')
    const path = runs.outputPath(runId, stream)
    reply.header('content-type', 'text/plain; charset=utf-8')
    reply.header('cache-control', 'no-store')
    return reply.send(createReadStream(path))
  })

  app.post('/api/runs/:runId/stop', async (request) => {
    const { runId } = request.params as { runId: string }
    return runs.stop(runId)
  })

  /** The run's bot, or 404 (an unknown run, or a run whose bot was deleted). */
  const ownerOf = (runId: string): Agent => {
    const run = runs.get(runId)
    if (!run) fail(404, 'Run not found.')
    const agent = store.agents.find((a) => a.id === run.agentId)
    if (!agent) fail(404, 'Bot not found.')
    return agent
  }

  app.get('/api/runs/:runId/undo/preview', async (request): Promise<UndoPreview> => {
    const { runId } = request.params as { runId: string }
    const agent = ownerOf(runId)
    if (!deps.undoPreview) fail(503, 'Undo isn\'t available right now.')
    if ((deps.activeRuns?.(agent.id) ?? 0) > 0) failWithReason(409, 'run_active', UNDO_RUN_ACTIVE_TEXT)
    return deps.undoPreview(agent, runId)
  })

  app.post('/api/runs/:runId/undo', async (request): Promise<UndoResult> => {
    const { runId } = request.params as { runId: string }
    const body = request.body ?? {}
    if (typeof body !== 'object' || Array.isArray(body)) fail(400, 'Send a JSON object, e.g. {"force": false}.')
    const raw = body as Record<string, unknown>
    const extra = Object.keys(raw).find((k) => k !== 'force')
    if (extra !== undefined) fail(400, `"${extra.slice(0, 40)}" isn't an undo option. Send {"force": true} to undo anyway.`)
    if (raw.force !== undefined && typeof raw.force !== 'boolean') fail(400, '"force" must be true or false.')
    ownerOf(runId)
    return runs.undo(runId, { force: raw.force === true })
  })
}
