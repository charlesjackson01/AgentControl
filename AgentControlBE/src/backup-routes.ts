/**
 * BE-P2-18: backup and export routes (M3 plan §4.2). User-session only: the app's user_only hook
 * refuses every request from the bot side with 403 before it gets here.
 *
 *   GET  /api/vm/backups                → BackupInfo[] (newest first)
 *   POST /api/vm/backups {agentIds?}    → 202 BackupInfo (status 'in_progress'; progress and the end
 *                                         as vm.updated with `backup`) · 400 · 409 backup_in_progress · 507
 *   POST /api/vm/backups/:id/restore {agentIds?, confirm:true} + x-agentcontrol-confirm: 1
 *                                       → 200 BackupRestoreResult · 400 confirm_required · 403 confirm_required
 *                                         · 404 not_found · 409 runs_active / backup_in_progress /
 *                                         backup_incomplete / files_missing (mismatch)
 *   GET  /api/vm/export                 → application/zip (every bot + group shared folders + index)
 *   GET  /api/agents/:id/export         → application/zip (that bot) · 404 · 409 files_missing
 */
import type { FastifyInstance } from 'fastify'
import type { BackupService } from './backup-service.js'
import { fail, failWithReason } from './http.js'
import { PERMISSION_CSRF_HEADER, type Agent, type BackupInfo, type BackupRestoreResult } from './shared/types.js'
import type { WorkspaceStore } from './store.js'

export const BACKUP_CONFIRM_TEXT = 'Send {"confirm": true} to restore this backup. Restoring replaces the bots\' files with the ones in the backup.'
export const BACKUP_CONFIRM_HEADER_TEXT = `Restoring a backup needs the ${PERMISSION_CSRF_HEADER}: 1 header.`

export interface BackupRouteDeps {
  /** files_missing check for one bot's export (409 with the VM tab's text). */
  assertBotFiles: (agent: Agent) => void
  /** The volume marker state; 'mismatch' refuses a restore (the files belong to another setup). */
  volume: () => 'ok' | 'missing' | 'mismatch' | 'unchecked'
  mismatchText: string
  /** After a successful restore while the marker was missing: write it back (the user confirmed). */
  volumeRestored: () => void
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

function agentIdsOf(raw: Record<string, unknown>): string[] | undefined {
  if (raw.agentIds === undefined) return undefined
  if (!Array.isArray(raw.agentIds) || !raw.agentIds.every((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 200)) {
    fail(400, '"agentIds" must be a list of bot ids, e.g. ["agent_1"].')
  }
  if (raw.agentIds.length > 1000) fail(400, '"agentIds" can list at most 1000 bots.')
  return raw.agentIds
}

function bodyOf(body: unknown, keys: readonly string[], example: string): Record<string, unknown> {
  if (body === undefined || body === null) return {}
  if (!isObj(body)) fail(400, `Send a JSON object, e.g. ${example}.`)
  const extra = Object.keys(body).find((k) => !keys.includes(k))
  if (extra !== undefined) fail(400, `"${extra.slice(0, 40)}" can't be set here.`)
  return body
}

const zipName = (what: string, at: Date) => `agentcontrol-${what}-${at.toISOString().slice(0, 10)}.zip`

export function registerBackupRoutes(app: FastifyInstance, store: WorkspaceStore, backups: BackupService, deps: BackupRouteDeps): void {
  app.get('/api/vm/backups', async (): Promise<BackupInfo[]> => backups.list())

  app.post('/api/vm/backups', async (request, reply) => {
    const raw = bodyOf(request.body, ['agentIds'], '{"agentIds": ["agent_1"]}')
    const info = backups.start({ trigger: 'manual', agentIds: agentIdsOf(raw) })
    return reply.code(202).send(info)
  })

  app.post('/api/vm/backups/:id/restore', async (request): Promise<BackupRestoreResult> => {
    const { id } = request.params as { id: string }
    const raw = bodyOf(request.body, ['agentIds', 'confirm'], '{"confirm": true}')
    if (raw.confirm !== true) failWithReason(400, 'confirm_required', BACKUP_CONFIRM_TEXT)
    if (request.headers[PERMISSION_CSRF_HEADER] !== '1') failWithReason(403, 'confirm_required', BACKUP_CONFIRM_HEADER_TEXT)
    const agentIds = agentIdsOf(raw)
    const volume = deps.volume()
    if (volume === 'mismatch') failWithReason(409, 'files_missing', deps.mismatchText)
    const result = await backups.restore(id, agentIds)
    if (volume === 'missing') deps.volumeRestored()
    return result
  })

  app.get('/api/vm/export', async (_request, reply) => {
    const stream = backups.exportAll()
    return reply
      .header('content-type', 'application/zip')
      .header('content-disposition', `attachment; filename="${zipName('export', new Date())}"`)
      .header('cache-control', 'no-store')
      .send(stream)
  })

  app.get('/api/agents/:id/export', async (request, reply) => {
    const { id } = request.params as { id: string }
    const agent = store.agents.find((a) => a.id === id)
    if (!agent) fail(404, `No agent with id "${id}"`)
    deps.assertBotFiles(agent)
    const stream = backups.exportAgent(agent)
    return reply
      .header('content-type', 'application/zip')
      .header('content-disposition', `attachment; filename="${zipName(agent.slug, new Date())}"`)
      .header('cache-control', 'no-store')
      .send(stream)
  })
}
