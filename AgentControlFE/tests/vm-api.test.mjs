// FE-P2-1: every Phase 2 client call hits the contract's method, path and body (docs/phase2-contract.md @ 4bf9429).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { RUN_PAGE_SIZE, createVmApi, permissionErrorOf, undoErrorOf, vmPaths } from '../src/lib/vm-api.ts'

function recorder() {
  const calls = []
  const request = async (path, init) => {
    calls.push([init?.method ?? 'GET', path, init?.body === undefined ? undefined : JSON.parse(init.body)])
    if (init?.headers) calls.push(['headers', init.headers])
    return {}
  }
  const requestText = async (path, init) => {
    calls.push([init?.method ?? 'GET', path, 'text'])
    return 'log'
  }
  return { api: createVmApi(request, requestText), calls }
}

describe('vm api routes', () => {
  it('per bot', async () => {
    const { api, calls } = recorder()
    await api.getVm('a/1')
    await api.updateVm('a1', { env: [{ name: 'TZ', value: 'UTC' }] })
    await api.startVm('a1')
    await api.stopVm('a1')
    await api.resetVm('a1')
    await api.getVmTools('a1')
    await api.rebuildTools('a1')
    await api.rollbackTools('a1')
    await api.listRuns('a1')
    await api.listRuns('a1', { before: 'r9', limit: 10 })
    assert.deepEqual(calls, [
      ['GET', '/api/agents/a%2F1/vm', undefined],
      ['PATCH', '/api/agents/a1/vm', { env: [{ name: 'TZ', value: 'UTC' }] }],
      ['POST', '/api/agents/a1/vm/start', undefined],
      ['POST', '/api/agents/a1/vm/stop', undefined],
      ['POST', '/api/agents/a1/vm/reset', { confirm: true }],
      ['GET', '/api/agents/a1/vm/tools', undefined],
      ['POST', '/api/agents/a1/vm/tools/rebuild', undefined],
      ['POST', '/api/agents/a1/vm/tools/rollback', undefined],
      ['GET', `/api/agents/a1/runs?limit=${RUN_PAGE_SIZE}`, undefined],
      ['GET', '/api/agents/a1/runs?limit=10&before=r9', undefined],
    ])
  })
  it('one run, undo ("Undo anyway" sends force:true)', async () => {
    const { api, calls } = recorder()
    await api.getRun('r1')
    assert.equal(await api.getRunOutput('r1'), 'log')
    await api.getRunOutput('r1', 'stderr')
    await api.stopRun('r1')
    await api.getUndoPreview('r1')
    await api.undoRun('r1')
    await api.undoRun('r1', true)
    assert.deepEqual(calls, [
      ['GET', '/api/runs/r1', undefined],
      ['GET', '/api/runs/r1/output?stream=stdout', 'text'],
      ['GET', '/api/runs/r1/output?stream=stderr', 'text'],
      ['POST', '/api/runs/r1/stop', undefined],
      ['GET', '/api/runs/r1/undo/preview', undefined],
      ['POST', '/api/runs/r1/undo', {}],
      ['POST', '/api/runs/r1/undo', { force: true }],
    ])
  })
  it('global', async () => {
    const { api, calls } = recorder()
    await api.getHost()
    await api.getSettings()
    await api.updateSettings({ snapshotBudget: { perBotMb: 2048 } })
    await api.getProbe()
    await api.recheckProbe()
    await api.growMachine(80)
    assert.deepEqual(calls, [
      ['GET', '/api/vm/host', undefined],
      ['GET', '/api/vm/settings', undefined],
      ['PATCH', '/api/vm/settings', { snapshotBudget: { perBotMb: 2048 } }],
      ['GET', '/api/vm/probe', undefined],
      ['POST', '/api/vm/probe', undefined],
      ['POST', '/api/vm/machine/grow', { toGb: 80 }],
    ])
  })
  it('permissions: the pending list, and answers carry the CSRF header', async () => {
    const { api, calls } = recorder()
    await api.listPendingPermissions()
    await api.listPendingPermissions({ agentId: 'a1', conversationId: 'c 1' })
    await api.answerPermission('p/1', 'allow_once')
    assert.deepEqual(calls, [
      ['GET', '/api/permissions?status=pending', undefined],
      ['GET', '/api/permissions?status=pending&agentId=a1&conversationId=c+1', undefined],
      ['POST', '/api/permissions/p%2F1', { decision: 'allow_once' }],
      ['headers', { 'x-agentcontrol-confirm': '1' }],
    ])
  })
  it('paths for links and the events stream', () => {
    assert.equal(vmPaths.agentExport('a1'), '/api/agents/a1/export')
    assert.equal(vmPaths.vmExport(), '/api/vm/export')
    assert.equal(vmPaths.events(), '/api/events')
    assert.equal(vmPaths.events({ conversationId: 'c1', agentId: 'a1' }), '/api/events?conversationId=c1&agentId=a1')
  })
})

describe('undoErrorOf', () => {
  const apiErr = (status, body, message = 'Undo failed.') => Object.assign(new Error(message), { status, body })
  it('409 run_active, 409 conflicts (with the list), 410 gone (with why)', () => {
    assert.deepEqual(undoErrorOf(apiErr(409, { error: 'x', reason: 'run_active' }, 'A run is still going.')), { kind: 'run_active', message: 'A run is still going.' })
    const conflicts = [{ path: 'workspace/out.csv', root: 'agent' }]
    assert.deepEqual(undoErrorOf(apiErr(409, { error: 'x', reason: 'conflicts', conflicts })), { kind: 'conflicts', message: 'Undo failed.', conflicts })
    assert.deepEqual(undoErrorOf(apiErr(409, { error: 'x', reason: 'conflicts' })).conflicts, [])
    assert.deepEqual(undoErrorOf(apiErr(410, { error: 'x', reason: 'expired' })), { kind: 'gone', message: 'Undo failed.', reason: 'expired' })
  })
  it('anything else is other', () => {
    assert.deepEqual(undoErrorOf(apiErr(500, undefined, 'Boom')), { kind: 'other', message: 'Boom', status: 500 })
    assert.deepEqual(undoErrorOf(apiErr(409, { error: 'x' })), { kind: 'other', message: 'Undo failed.', status: 409 })
    assert.deepEqual(undoErrorOf(new TypeError('Failed to fetch')), { kind: 'other', message: 'Failed to fetch' })
  })
})

describe('permissionErrorOf', () => {
  const apiErr = (status, message = 'x') => Object.assign(new Error(message), { status })
  it('409 resolved, 403 forbidden (CSRF header), 404, else other', () => {
    assert.deepEqual(permissionErrorOf(apiErr(409, 'Already answered.')), { kind: 'resolved', message: 'Already answered.' })
    assert.equal(permissionErrorOf(apiErr(403)).kind, 'forbidden')
    assert.equal(permissionErrorOf(apiErr(404)).kind, 'not_found')
    assert.deepEqual(permissionErrorOf(apiErr(400, 'Wrong decision.')), { kind: 'other', message: 'Wrong decision.', status: 400 })
    assert.deepEqual(permissionErrorOf(new TypeError('Failed to fetch')), { kind: 'other', message: 'Failed to fetch' })
  })
})
