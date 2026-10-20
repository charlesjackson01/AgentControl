import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createLearnField, saveAgentChange } from '../src/lib/agent-patch.ts'

const agent = {
  id: 'a 1', name: 'Primary', role: 'Team Lead', description: 'd', instructions: 'i', modelId: 'm', endpointId: 'e',
  skillIds: ['core/x'], memoryLearn: true, rules: ['r'],
}
const httpError = (status, message) => Object.assign(new Error(message), { status })

function fakeRequest(handlers) {
  const calls = []
  const request = async (path, init) => {
    calls.push({ path, method: init.method, body: JSON.parse(init.body) })
    const h = handlers[init.method]
    if (h instanceof Error) throw h
    return h(JSON.parse(init.body))
  }
  return { calls, request }
}

describe('saveAgentChange (Learn from chat)', () => {
  it('PATCHes only the changed field and returns the full agent', async () => {
    const { calls, request } = fakeRequest({ PATCH: (b) => ({ ...agent, ...b }) })
    const out = await saveAgentChange(request, agent, { memoryLearn: false })
    assert.equal(out.agent.memoryLearn, false)
    assert.deepEqual(calls, [{ path: '/api/agents/a%201', method: 'PATCH', body: { memoryLearn: false } }])
  })

  it('PATCH only: no PUT fallback on any error (missing route, 405, real 404, 400)', async () => {
    for (const err of [httpError(404, 'Route PATCH:/api/agents/a%201 not found'), httpError(405, 'Method Not Allowed'), httpError(404, 'No agent with id a 1'), httpError(400, 'memoryLearn must be boolean')]) {
      const { calls, request } = fakeRequest({ PATCH: err, PUT: () => assert.fail('PUT must not run') })
      await assert.rejects(saveAgentChange(request, agent, { memoryLearn: false }), err)
      assert.equal(calls.length, 1)
    }
  })
})

describe('create: memoryLearn only when the user changed it', () => {
  it('untouched (undefined) or on -> not sent, so the BE default (on) applies', () => {
    assert.deepEqual(createLearnField(undefined), {})
    assert.deepEqual(createLearnField(true), {})
  })
  it('turned off -> memoryLearn: false', () => {
    assert.deepEqual(createLearnField(false), { memoryLearn: false })
  })
})
