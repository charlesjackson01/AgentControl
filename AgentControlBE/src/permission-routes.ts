/**
 * BE-P2-14: permission request routes (contract "Permission requests"):
 * - GET  /api/permissions?status=pending|all&agentId=&conversationId=&limit=&before=
 *        → PermissionListResponse {requests (newest first), now} (400 bad query)
 * - GET  /api/permissions/:requestId → PermissionRequest (404 not_found)
 * - POST /api/permissions/:requestId {decision} with header x-agentcontrol-confirm: 1
 *        → PermissionRequest (403 confirm_required; 400 bad_decision; 404 not_found;
 *        409 already_resolved with `request`)
 * User-only: the global onRequest hook (BE-P2-13) answers 403 user_only to the bot side first.
 */
import type { FastifyInstance } from 'fastify'
import { failWithReason } from './http.js'
import { parsePermissionQuery, type PermissionGate } from './permission-gate.js'
import { PERMISSION_CSRF_HEADER, type PermissionListResponse, type PermissionRequest } from './shared/types.js'

export const CONFIRM_REQUIRED_TEXT = `Answering a permission request needs the ${PERMISSION_CSRF_HEADER}: 1 header.`
export const PERMISSION_NOT_FOUND_TEXT = 'This request no longer exists.'

export function registerPermissionRoutes(app: FastifyInstance, gate: PermissionGate): void {
  app.get('/api/permissions', async (request): Promise<PermissionListResponse> => {
    const q = parsePermissionQuery((request.query ?? {}) as Record<string, unknown>)
    return gate.list(q)
  })

  app.get('/api/permissions/:requestId', async (request): Promise<PermissionRequest> => {
    const { requestId } = request.params as { requestId: string }
    const r = gate.get(requestId)
    if (!r) failWithReason(404, 'not_found', PERMISSION_NOT_FOUND_TEXT)
    return r
  })

  app.post('/api/permissions/:requestId', async (request): Promise<PermissionRequest> => {
    if (request.headers[PERMISSION_CSRF_HEADER] !== '1') failWithReason(403, 'confirm_required', CONFIRM_REQUIRED_TEXT)
    const { requestId } = request.params as { requestId: string }
    const body = (request.body ?? {}) as { decision?: unknown }
    return gate.answer(requestId, typeof body === 'object' && body ? body.decision : undefined)
  })
}
