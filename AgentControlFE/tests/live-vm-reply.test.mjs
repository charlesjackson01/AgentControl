// BE-15 check (0d0f292): the browser switch's PATCH reply can be older than a vm.updated that overtook it.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createLiveController } from '../src/lib/live-controller.ts'
import { fakeEventsFetch, frame, until, vm } from './live-fixtures.mjs'

const failed = vm('a1', { permissions: { browser: true, browserState: 'error' }, browser: { state: 'error', error: { reason: 'download_failed', message: 'The Chromium download stopped at 447 MB (connection reset).', at: '2026-10-30T22:00:04.933Z' } } })
const settingUp = vm('a1', { permissions: { browser: true, browserState: 'absent' }, browser: { state: 'setting_up' } })

function setup({ frames = [], getVm }) {
  const gets = []
  const f = fakeEventsFetch([{ frames, end: false }])
  const client = {
    getRun: async () => { throw new Error('no runs') },
    getVm: async (id) => { gets.push(id); return getVm(id) },
    listPendingPermissions: async () => ({ requests: [] }),
  }
  return { gets, live: createLiveController({ client, connection: { url: '/api/events', fetch: f.fetch } }) }
}

describe('vmReply', () => {
  it('a vm.updated that lands while the PATCH is out wins: the bot is re-read, the stale setting_up reply is not shown', async () => {
    const { gets, live } = setup({ frames: [frame('1', { type: 'vm.updated', agentId: 'a1', vm: failed })], getVm: async () => failed })
    const reply = await live.vmReply('a1', async () => {
      live.start() // the event arrives before the reply
      await until(() => live.getState().vms.a1?.browser?.state === 'error')
      return settingUp
    })
    await until(() => gets.length > 0)
    live.stop()
    assert.equal(reply, settingUp, 'resolves with the reply')
    assert.equal(live.getState().vms.a1.browser.state, 'error')
    assert.deepEqual(gets, ['a1'])
  })

  it('no event meanwhile: the reply is put as is, no extra GET', async () => {
    const { gets, live } = setup({ getVm: async () => failed })
    await live.vmReply('a1', async () => settingUp)
    assert.equal(live.getState().vms.a1.browser.state, 'setting_up')
    assert.deepEqual(gets, [])
  })

  it('an event for another bot does not trigger a re-read', async () => {
    const other = vm('a2', { state: 'stopped' })
    const { gets, live } = setup({ frames: [frame('1', { type: 'vm.updated', agentId: 'a2', vm: other })], getVm: async () => failed })
    await live.vmReply('a1', async () => {
      live.start()
      await until(() => live.getState().vms.a2?.state === 'stopped')
      return settingUp
    })
    live.stop()
    assert.equal(live.getState().vms.a1.browser.state, 'setting_up')
    assert.ok(!gets.includes('a1'))
  })

  it('if the re-read fails, the reply is used', async () => {
    const { live } = setup({ frames: [frame('1', { type: 'vm.updated', agentId: 'a1', vm: failed })], getVm: async () => { throw new Error('down') } })
    await live.vmReply('a1', async () => {
      live.start()
      await until(() => live.getState().vms.a1?.browser?.state === 'error')
      return settingUp
    })
    live.stop()
    assert.equal(live.getState().vms.a1.browser.state, 'setting_up')
  })

  it('a failed PATCH rejects (the confirm shows its 409) and puts nothing', async () => {
    const { live } = setup({ getVm: async () => failed })
    const e = Object.assign(new Error('low disk'), { status: 409 })
    await assert.rejects(live.vmReply('a1', async () => { throw e }), (x) => x === e)
    assert.equal(live.getState().vms.a1, undefined)
  })
})
