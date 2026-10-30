/**
 * BE-P2-15: the browser add-on routes (contract "BE-P2-15 Browser add-on").
 *   GET    /api/vm/browser          → BrowserAddonInfo
 *   POST   /api/vm/browser/retry    {agentId?} → BrowserAddonInfo (404, 409 nothing_to_retry, 409 low_disk)
 *   DELETE /api/vm/browser          (x-agentcontrol-confirm: 1) → BrowserAddonInfo state 'absent'
 *                                    (403 confirm_required, 409 browser_in_use, 409 browser_busy)
 */
import type { FastifyInstance } from 'fastify'
import type { BrowserAddon } from './browser-addon.js'
import { fail, failWithReason } from './http.js'
import { PERMISSION_CSRF_HEADER } from './shared/types.js'
import type { WorkspaceStore } from './store.js'

export const BROWSER_CONFIRM_TEXT = `Removing the Chromium download needs the ${PERMISSION_CSRF_HEADER}: 1 header.`

export function registerBrowserRoutes(app: FastifyInstance, _store: WorkspaceStore, addon: BrowserAddon): void {
  app.get('/api/vm/browser', async () => addon.info())

  app.post('/api/vm/browser/retry', async (request) => {
    const body = (request.body ?? {}) as unknown
    if (body === null || typeof body !== 'object' || Array.isArray(body)) fail(400, 'Send a JSON object, e.g. {} or {"agentId": "…"}.')
    const { agentId, ...rest } = body as Record<string, unknown>
    if (Object.keys(rest).length) fail(400, `"${Object.keys(rest)[0]!.slice(0, 40)}" can't be sent here.`)
    if (agentId !== undefined && (typeof agentId !== 'string' || !agentId)) fail(400, '"agentId" must be a bot id.')
    return addon.retry(agentId as string | undefined)
  })

  app.delete('/api/vm/browser', async (request) => {
    if (request.headers[PERMISSION_CSRF_HEADER] !== '1') failWithReason(403, 'confirm_required', BROWSER_CONFIRM_TEXT)
    return addon.remove()
  })
}
