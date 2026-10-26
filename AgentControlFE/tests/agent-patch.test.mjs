import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createLearnField, saveAgentChange, saveAgentEdit, saveLearnToggle } from '../src/lib/agent-patch.ts'
import { createTemperatureField, editTemperaturePatch } from '../src/lib/temperature.ts'

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

describe('Learn from chat toggle: 400 shows the server message and reverts (BE-4 c4d4f52)', () => {
  const messageOf = (e) => e.message
  it('sends a real boolean and keeps the new state on success', async () => {
    const { calls, request } = fakeRequest({ PATCH: (b) => ({ ...agent, ...b }) })
    const out = await saveLearnToggle((c) => saveAgentChange(request, agent, c), false, messageOf)
    assert.deepEqual(calls[0].body, { memoryLearn: false })
    assert.equal(typeof calls[0].body.memoryLearn, 'boolean')
    assert.deepEqual({ learn: out.learn, error: out.error }, { learn: false, error: null })
    assert.equal(out.agent.memoryLearn, false)
  })
  it('400: toggle goes back, the server\'s message is shown, no agent update', async () => {
    const err = httpError(400, '"memoryLearn" must be true or false.')
    const { calls, request } = fakeRequest({ PATCH: err })
    const off = await saveLearnToggle((c) => saveAgentChange(request, agent, c), false, messageOf)
    assert.deepEqual(off, { learn: true, agent: null, error: '"memoryLearn" must be true or false.' })
    const on = await saveLearnToggle((c) => saveAgentChange(request, agent, c), true, messageOf)
    assert.deepEqual(on, { learn: false, agent: null, error: '"memoryLearn" must be true or false.' })
    assert.equal(calls.length, 2)
  })
})

describe('temperature payloads (BE-4 af197cd / e2221c8)', () => {
  const stored = { ...agent, temperature: 0.7 }
  const put = { name: 'Primary', role: 'Team Lead', description: 'd', instructions: 'i', modelId: 'm', endpointId: 'e', skillIds: ['core/x'], rules: ['r'], color: null }
  const handlers = () => ({ PUT: (b) => ({ ...stored, ...b }), PATCH: (b) => { const a = { ...stored, ...b }; if (b.temperature === null) delete a.temperature; return a } })
  it('edit, unchanged: one PUT without temperature, no PATCH', async () => {
    const { calls, request } = fakeRequest(handlers())
    const out = await saveAgentEdit(request, 'a 1', put, editTemperaturePatch(0.7, '0.7'))
    assert.deepEqual(calls.map((c) => c.method), ['PUT'])
    assert.equal('temperature' in calls[0].body, false)
    assert.equal(out.temperature, 0.7)
  })
  it('edit, blank over 0.7: PUT without temperature, then PATCH { temperature: null }', async () => {
    const { calls, request } = fakeRequest(handlers())
    const out = await saveAgentEdit(request, 'a 1', put, editTemperaturePatch(0.7, ''))
    assert.deepEqual(calls.map((c) => [c.method, c.path]), [['PUT', '/api/agents/a%201'], ['PATCH', '/api/agents/a%201']])
    assert.equal('temperature' in calls[0].body, false)
    assert.deepEqual(calls[1].body, { temperature: null })
    assert.equal('temperature' in out, false)
  })
  it('edit, new value: PATCH { temperature: 1.2 } (a number)', async () => {
    const { calls, request } = fakeRequest(handlers())
    await saveAgentEdit(request, 'a 1', put, editTemperaturePatch(0.7, '1.2'))
    assert.deepEqual(calls[1].body, { temperature: 1.2 })
  })
  it('edit, PATCH 400: the error surfaces (form shows it)', async () => {
    const err = httpError(400, 'Temperature must be a number between 0 and 2.')
    const { request } = fakeRequest({ PUT: (b) => ({ ...stored, ...b }), PATCH: err })
    await assert.rejects(saveAgentEdit(request, 'a 1', put, { temperature: 1.2 }), err)
  })
  it('create: blank omits temperature; the Team Lead preset sends 0.7', () => {
    assert.deepEqual({ ...put, ...createTemperatureField('') }, put)
    assert.deepEqual({ ...put, ...createTemperatureField('0.7') }, { ...put, temperature: 0.7 })
  })
})
