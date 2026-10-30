/**
 * BE-P2-12: script run routes (contract "Per bot"):
 * - GET  /api/agents/:id/script-runs?before=<runId>&limit=50 → { runs: ScriptRunSummary[], hasMore } newest first
 * - GET  /api/runs/:runId → ScriptRun (404)
 * - GET  /api/runs/:runId/output?stream=stdout|stderr → text/plain full log (404, 410 log_evicted)
 * - POST /api/runs/:runId/stop → ScriptRun (409 not_active)
 * The Phase 1 /api/agents/:id/runs (model turns) is unchanged. Undo and tool-build routes are BE-P2-17.
 */
import { createReadStream } from 'node:fs'
import type { FastifyInstance } from 'fastify'
import { fail } from './http.js'
import type { RunService } from './run-service.js'
import type { WorkspaceStore } from './store.js'

export function registerRunRoutes(app: FastifyInstance, store: WorkspaceStore, runs: RunService): void {
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
}
