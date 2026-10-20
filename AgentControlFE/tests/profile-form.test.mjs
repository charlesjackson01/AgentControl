import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  PROFILE_SWATCHES, modelOptions, modelValue, parseModelValue, profileDirty, profileDraftFrom, profilePutBody, profileSwatches, validateProfile,
} from '../src/lib/profile-form.ts'

const agent = {
  id: 'p', name: 'Primary', role: 'Team Lead', description: 'Your personal agent.', instructions: 'You are Primary.',
  modelId: 'qwen', endpointId: 'local', skillIds: ['core/a'], rules: ['Keep answers short.'], color: '#e5487f', temperature: 0.3,
}
const endpoints = [
  { id: 'local', name: 'Local llama', defaultModel: 'qwen' },
  { id: 'cloud', name: 'Cloud', defaultModel: 'big' },
]

describe('profile form (03a)', () => {
  it('lists "<endpoint> · <model>" options, served models first, default as fallback', () => {
    const opts = modelOptions(endpoints, { local: [{ id: 'qwen', name: 'Qwen 3.8 Flash' }, { id: 'tiny', name: '' }] }, agent)
    assert.deepEqual(opts.map((o) => o.label), ['Local llama · Qwen 3.8 Flash', 'Local llama · tiny', 'Cloud · big'])
    assert.deepEqual(parseModelValue(opts[2].value), { endpointId: 'cloud', modelId: 'big' })
  })

  it('keeps the current model even if the endpoint no longer serves it', () => {
    const opts = modelOptions(endpoints, { local: [{ id: 'other', name: 'Other' }] }, { endpointId: 'gone', modelId: 'old' })
    assert.equal(opts[0].label, 'Missing endpoint · old')
    assert.equal(opts[0].value, modelValue('gone', 'old'))
  })

  it('validates name, model and rules', () => {
    const d = profileDraftFrom(agent)
    assert.deepEqual(validateProfile(d, endpoints), {})
    assert.ok(validateProfile({ ...d, name: '  ' }, endpoints).name)
    assert.ok(validateProfile({ ...d, endpointId: 'gone' }, endpoints).model)
    assert.ok(validateProfile({ ...d, rules: Array.from({ length: 21 }, (_, i) => `r${i}`) }, endpoints).rules)
  })

  it('builds a full PUT body that keeps skillIds and temperature, trims, and drops blank rules', () => {
    const d = { ...profileDraftFrom(agent), name: ' Prime ', rules: ['  a ', '', 'b'], color: null, endpointId: 'cloud', modelId: 'big' }
    assert.deepEqual(profilePutBody(agent, d), {
      name: 'Prime', role: 'Team Lead', description: 'Your personal agent.', instructions: 'You are Primary.',
      modelId: 'big', endpointId: 'cloud', temperature: 0.3, skillIds: ['core/a'], rules: ['a', 'b'], color: null,
    })
  })

  it('is dirty only for real changes', () => {
    const d = profileDraftFrom(agent)
    assert.equal(profileDirty(d, agent), false)
    assert.equal(profileDirty({ ...d, rules: [...d.rules, ''] }, agent), false)
    assert.equal(profileDirty({ ...d, role: 'Lead' }, agent), true)
    assert.equal(profileDirty({ ...d, color: null }, agent), true)
  })

  it('shows the six 03a swatches plus an off-palette current colour', () => {
    assert.deepEqual(profileSwatches('#E5487F'), [...PROFILE_SWATCHES])
    assert.deepEqual(profileSwatches('#123456'), [...PROFILE_SWATCHES, '#123456'])
    assert.equal(profileSwatches(null).length, 6)
  })
})
