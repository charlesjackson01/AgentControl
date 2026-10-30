import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from './app.js'
import type { EgressService } from './egress-service.js'
import { EGRESS_VIA } from './egressd.js'
import { liveEventMatches } from './live-events.js'
import { CONFIRM_REQUIRED_TEXT } from './permission-routes.js'
import { PERMISSION_CSRF_HEADER, type Agent, type LiveEvent, type PermissionRequest, type ScriptRun } from './shared/types.js'
import { createStore } from './store.js'
import { USER_ONLY_MESSAGE } from './user-only.js'

/** BE-P2-14: /api/permissions through the app (error bodies, confirm header, user-only). */

let dir = ''
let app: FastifyInstance
const fakeEgress = { userOnlyCidrs: () => ['10.89.3.0/24'], refreshSubnets: async () => {}, available: async () => ({ ok: false, message: 'test' }) } as unknown as EgressService

beforeEach(async () => {
  vi.stubEnv('AGENTCONTROL_AUTH_TOKEN', '')
  dir = mkdtempSync(join(tmpdir(), 'agentcontrol-be14-routes-'))
  app = buildApp(createStore(join(dir, 'store.json')), { egress: fakeEgress })
  await app.ready()
})
afterEach(async () => {
  await app.close()
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

async function raised(): Promise<{ bot: Agent; request: PermissionRequest }> {
  const res = await app.inject({ method: 'POST', url: '/api/agents', payload: { name: 'Analyst', endpointId: 'ep_local_llama', modelId: 'llama-3-8b' } })
  expect(res.statusCode).toBe(201)
  const bot = res.json() as Agent
  const run = { id: 'run_x1', agentId: bot.id, conversationId: 'conv_none', kind: 'script', argv: ['python', 'a.py'], network: 'on', permissions: [], queuedAt: new Date().toISOString() } as unknown as ScriptRun
  const { requestId } = app.vmPermissions.raise(run, 'internet')
  return { bot, request: app.vmPermissions.get(requestId)! }
}
const post = (id: string, payload: unknown, headers: Record<string, string> = { [PERMISSION_CSRF_HEADER]: '1' }, remoteAddress = '127.0.0.1') =>
  app.inject({ method: 'POST', url: `/api/permissions/${id}`, payload: payload as object, headers, remoteAddress })

describe('/api/permissions', () => {
  it('GET lists pending requests with now; 400 on a bad query', async () => {
    const { request } = await raised()
    const res = await app.inject({ method: 'GET', url: '/api/permissions' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { requests: PermissionRequest[]; now: string }
    expect(body.requests.map((r) => r.id)).toEqual([request.id])
    expect(Number.isFinite(Date.parse(body.now))).toBe(true)
    for (const q of ['status=open', 'limit=0', 'limit=201', 'before=nope']) {
      const bad = await app.inject({ method: 'GET', url: `/api/permissions?${q}` })
      expect([q, bad.statusCode]).toEqual([q, 400])
    }
    expect((await app.inject({ method: 'GET', url: '/api/permissions?status=all&limit=200' })).statusCode).toBe(200)
  })
  it('GET one: 200, or 404 not_found', async () => {
    const { request } = await raised()
    expect((await app.inject({ method: 'GET', url: `/api/permissions/${request.id}` })).json()).toMatchObject({ id: request.id, status: 'pending' })
    const res = await app.inject({ method: 'GET', url: '/api/permissions/perm_nope' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ statusCode: 404, error: 'Request Error', reason: 'not_found', message: 'This request no longer exists.' })
  })
  it('POST: 403 confirm_required without the header, 400 bad_decision, 200, then 409 already_resolved with the request', async () => {
    const { request } = await raised()
    const noHeader = await post(request.id, { decision: 'deny' }, {})
    expect(noHeader.statusCode).toBe(403)
    expect(noHeader.json()).toEqual({ statusCode: 403, error: 'Request Error', reason: 'confirm_required', message: CONFIRM_REQUIRED_TEXT })
    const bad = await post(request.id, { decision: 'enable' })
    expect(bad.statusCode).toBe(400)
    expect(bad.json()).toMatchObject({ statusCode: 400, error: 'Request Error', reason: 'bad_decision' })
    const ok = await post(request.id, { decision: 'deny' })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toMatchObject({ id: request.id, status: 'denied', resolvedBy: 'user' })
    const again = await post(request.id, { decision: 'allow_once' })
    expect(again.statusCode).toBe(409)
    expect(again.json()).toMatchObject({ statusCode: 409, error: 'Request Error', reason: 'already_resolved', message: expect.any(String), request: { id: request.id, status: 'denied' } })
    expect((await post('perm_nope', { decision: 'deny' })).statusCode).toBe(404)
  })
  it('always: the bot is set to Always (its own rule) and saved', async () => {
    const { bot, request } = await raised()
    expect((await post(request.id, { decision: 'always' })).json()).toMatchObject({ status: 'always', resolvedBy: 'user' })
    const after = (await app.inject({ method: 'GET', url: `/api/agents/${bot.id}` })).json() as Agent
    expect(after.internetPolicy).toBe('always')
  })
  it('user-only: the bot side (a VM network address or the proxy\'s Via) gets 403 user_only, and the request stays pending', async () => {
    const { request } = await raised()
    for (const [headers, addr] of [[{ [PERMISSION_CSRF_HEADER]: '1' }, '10.89.3.2'], [{ [PERMISSION_CSRF_HEADER]: '1', via: EGRESS_VIA }, '127.0.0.1']] as const) {
      const res = await post(request.id, { decision: 'always' }, headers, addr)
      expect(res.statusCode).toBe(403)
      expect(res.json()).toEqual({ statusCode: 403, error: 'Forbidden', message: USER_ONLY_MESSAGE, reason: 'user_only' })
    }
    expect((await app.inject({ method: 'GET', url: '/api/permissions', remoteAddress: '10.89.3.2' })).statusCode).toBe(403)
    expect(app.vmPermissions.get(request.id)!.status).toBe('pending')
  })
  it('PATCH internetPolicy → Never closes the pending request (policy_changed)', async () => {
    const { bot, request } = await raised()
    const res = await app.inject({ method: 'PATCH', url: `/api/agents/${bot.id}/vm`, payload: { internetPolicy: 'never' } })
    expect(res.statusCode).toBe(200)
    expect(app.vmPermissions.get(request.id)).toMatchObject({ status: 'denied', closedBy: 'policy_changed' })
  })
  it('DELETE bot closes its pending request (run_ended)', async () => {
    // The first bot is the Team Lead (not deletable); the second one is.
    await app.inject({ method: 'POST', url: '/api/agents', payload: { name: 'Lead', endpointId: 'ep_local_llama', modelId: 'llama-3-8b' } })
    const { bot, request } = await raised()
    expect((await app.inject({ method: 'DELETE', url: `/api/agents/${bot.id}` })).statusCode).toBeLessThan(300)
    expect(app.vmPermissions.get(request.id)).toMatchObject({ status: 'denied', closedBy: 'run_ended' })
  })
})

describe('live event filters (BE-P2-14)', () => {
  const req = { id: 'p1', agentId: 'a1', conversationId: 'c1' } as unknown as PermissionRequest
  it('permission.* match on agentId and the request\'s conversation', () => {
    for (const type of ['permission.requested', 'permission.resolved', 'permission.updated'] as const) {
      const e = { type, conversationId: 'c1', request: req } as LiveEvent
      expect(liveEventMatches(e, { agentId: 'a1' })).toBe(true)
      expect(liveEventMatches(e, { agentId: 'a2' })).toBe(false)
      expect(liveEventMatches(e, { conversationId: 'c1' })).toBe(true)
      expect(liveEventMatches(e, { conversationId: 'c2' })).toBe(false)
    }
  })
  it('vm.updated passes a conversation filter when the bot is in that conversation', () => {
    const e = { type: 'vm.updated', agentId: 'a1', vm: {} } as unknown as LiveEvent
    const inConv = (agentId: string, conversationId: string) => agentId === 'a1' && conversationId === 'g1'
    expect(liveEventMatches(e, { conversationId: 'g1', agentInConversation: inConv })).toBe(true)
    expect(liveEventMatches(e, { conversationId: 'g2', agentInConversation: inConv })).toBe(false)
    expect(liveEventMatches(e, { conversationId: 'g1' })).toBe(false)
  })
})
