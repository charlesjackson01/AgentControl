import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MOBILE_BACK_PATH, MOBILE_MAX_WIDTH, MOBILE_QUERY, homeView, isMobileWidth, mobileBack } from '../src/lib/mobile.ts'

describe('FE-8 breakpoint', () => {
  it('phone layouts below 760 px, the same breakpoint as the CSS', () => {
    assert.equal(MOBILE_MAX_WIDTH, 759)
    assert.equal(MOBILE_QUERY, '(max-width: 759px)')
    assert.equal(isMobileWidth(390), true)
    assert.equal(isMobileWidth(759), true)
    assert.equal(isMobileWidth(760), false)
    assert.equal(isMobileWidth(1440), false)
    assert.equal(isMobileWidth(Number.NaN), false)
  })
})

describe('homeView: what / shows', () => {
  it('phone (05a): the chat list, even while loading or on error', () => {
    assert.equal(homeView({ narrow: true, loaded: false }), 'list')
    assert.equal(homeView({ narrow: true, loaded: true, target: 'chat' }), 'list')
    assert.equal(homeView({ narrow: true, loaded: true, target: 'empty' }), 'list')
    assert.equal(homeView({ narrow: true, loaded: true, target: 'setup', error: true }), 'list')
  })
  it('phone: first-run setup (no bots) still wins once loaded', () => {
    assert.equal(homeView({ narrow: true, loaded: true, target: 'setup' }), 'setup')
  })
  it('desktop is unchanged: wait, redirect to newest chat, setup, empty', () => {
    assert.equal(homeView({ narrow: false, loaded: false }), 'waiting')
    assert.equal(homeView({ narrow: false, loaded: true, target: 'chat' }), 'redirect')
    assert.equal(homeView({ narrow: false, loaded: true, target: 'setup' }), 'setup')
    assert.equal(homeView({ narrow: false, loaded: true, target: 'setup', error: true }), 'empty')
    assert.equal(homeView({ narrow: false, loaded: true, target: 'empty' }), 'empty')
  })
})

describe('mobileBack (05b "‹ 5")', () => {
  it('goes to the list screen at /, not browser history', () => {
    assert.equal(MOBILE_BACK_PATH, '/')
    assert.equal(mobileBack(5).to, '/')
  })
  it('shows the total unread badge and an accessible label', () => {
    assert.deepEqual(mobileBack(5), { to: '/', badge: '5', label: 'Back to chats, 5 unread' })
  })
  it('no badge and a plain label when nothing is unread', () => {
    assert.deepEqual(mobileBack(0), { to: '/', badge: '', label: 'Back to chats' })
  })
})
