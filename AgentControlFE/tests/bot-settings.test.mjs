import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SETTINGS_TABS, settingsOpen, settingsTab, withSettingsTab, withoutPanel } from '../src/lib/settings-tabs.ts'
import { INTERNET_POLICY_LABELS, agentChatFirstFields, agentPutBody, botFolder } from '../src/lib/agent-put.ts'
import { isRouteMissing } from '../src/lib/route-missing.ts'
import { chatPanelPath } from '../src/lib/commands.ts'

const qs = (s) => new URLSearchParams(s)

describe('settings tab routing (?panel=settings&tab=)', () => {
  it('five tabs in 03a order; FE-4 owns files + sandbox', () => {
    assert.deepEqual(SETTINGS_TABS.map((t) => t.id), ['profile', 'memory', 'skills', 'files', 'sandbox'])
    assert.deepEqual(SETTINGS_TABS.filter((t) => t.owner === 'FE-4').map((t) => t.id), ['files', 'sandbox'])
  })
  it('open only with panel=settings; tab defaults to profile', () => {
    assert.equal(settingsOpen(qs('panel=settings')), true)
    assert.equal(settingsOpen(qs('panel=files&path=x')), false)
    assert.equal(settingsOpen(qs('')), false)
    assert.equal(settingsTab(qs('panel=settings')), 'profile')
    assert.equal(settingsTab(qs('panel=settings&tab=memory')), 'memory')
    assert.equal(settingsTab(qs('panel=settings&tab=bogus')), 'profile')
  })
  it('switching tabs keeps other params, drops path, profile has no tab', () => {
    assert.equal(withSettingsTab(qs('m=1'), 'skills').toString(), 'm=1&panel=settings&tab=skills')
    assert.equal(withSettingsTab(qs('panel=settings&tab=skills'), 'profile').toString(), 'panel=settings')
    assert.equal(withSettingsTab(qs('panel=files&path=a.png'), 'files').toString(), 'panel=settings&tab=files')
  })
  it('close removes panel, tab and path only', () => {
    assert.equal(withoutPanel(qs('panel=settings&tab=memory&m=9&path=x')).toString(), 'm=9')
  })
  it('the FE-2 command links parse back to the right tab', () => {
    const link = (to) => new URLSearchParams(to.split('?')[1])
    assert.equal(settingsTab(link(chatPanelPath('c', 'settings', { tab: 'memory' }))), 'memory')
    assert.equal(settingsOpen(link(chatPanelPath('c', 'settings'))), true)
  })
})

describe('agent PUT body for one-field saves', () => {
  const agent = {
    id: 'a', name: 'Primary', role: 'Team Lead', description: 'd', instructions: 'i', modelId: 'm', endpointId: 'e',
    temperature: 0.7, skillIds: ['x', 'y'], rules: ['r'], color: '#112233', isPrimary: true, slug: 'primary', internetPolicy: 'never', memoryLearn: true,
  }
  it('resends the required core fields and skillIds (PUT would reset them)', () => {
    const body = agentPutBody(agent, { memoryLearn: false })
    assert.deepEqual(body, { name: 'Primary', role: 'Team Lead', description: 'd', instructions: 'i', modelId: 'm', endpointId: 'e', skillIds: ['x', 'y'], memoryLearn: false })
  })
  it('omits optional profile fields so the BE keeps them', () => {
    const body = agentPutBody(agent, { skillIds: ['z'] })
    for (const k of ['rules', 'color', 'avatar', 'internetPolicy', 'isPrimary', 'slug']) assert.equal(k in body, false, k)
    assert.deepEqual(body.skillIds, ['z'])
  })
  it('never sends temperature: unchanged sends nothing, PUT keeps the stored value (BE-4 af197cd)', () => {
    assert.equal(agent.temperature, 0.7)
    assert.equal('temperature' in agentPutBody(agent, {}), false)
    const { temperature: _t, ...rest } = agent
    assert.equal('temperature' in agentPutBody(rest, {}), false)
  })
  it('does not share the skillIds array', () => {
    const body = agentPutBody(agent, {})
    body.skillIds.push('q')
    assert.deepEqual(agent.skillIds, ['x', 'y'])
  })
})

describe('BE-1 fields', () => {
  it('defaults: internetPolicy ask, memoryLearn true, slug null', () => {
    assert.deepEqual(agentChatFirstFields({}), { slug: null, internetPolicy: 'ask', memoryLearn: true })
    assert.deepEqual(agentChatFirstFields({ slug: 'researcher', internetPolicy: 'always', memoryLearn: false }), { slug: 'researcher', internetPolicy: 'always', memoryLearn: false })
    assert.equal(INTERNET_POLICY_LABELS.ask, 'Ask each time')
  })
  it('folder path', () => {
    assert.equal(botFolder('primary'), 'bots/primary/')
    assert.equal(botFolder(undefined), null)
  })
})

describe('isRouteMissing', () => {
  const e = (status, message = 'x') => Object.assign(new Error(message), { status })
  it("Fastify's unregistered-route 404, 405 and 501 mean the feature isn't on this server", () => {
    assert.equal(isRouteMissing(e(404, 'Route GET:/api/agents/a/memory?limit=200 not found')), true)
    assert.equal(isRouteMissing(e(405)), true)
    assert.equal(isRouteMissing(e(501)), true)
  })
  it('a real 404 or any other error is not', () => {
    assert.equal(isRouteMissing(e(404, 'No agent with id "a"')), false)
    assert.equal(isRouteMissing(e(400)), false)
    assert.equal(isRouteMissing(new Error('Failed to fetch')), false)
    assert.equal(isRouteMissing(null), false)
  })
})
