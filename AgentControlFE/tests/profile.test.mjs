import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { displayName, needsOnboarding, profileNameError } from '../src/lib/profile.ts'
import {
  avatarBaseline, avatarDirty, avatarFileError, avatarSavePlan, cleared, shownAvatar, withEmoji, withFile,
} from '../src/lib/avatar-draft.ts'

describe('profile', () => {
  it('name validation', () => {
    assert.match(profileNameError('  '), /call you/)
    assert.match(profileNameError('x'.repeat(81)), /80/)
    assert.equal(profileNameError(' Charles '), null)
  })
  it('onboarding gate', () => {
    assert.equal(needsOnboarding({ name: '', onboardedAt: null }), true)
    assert.equal(needsOnboarding({ name: 'C', onboardedAt: '2026-10-16T00:00:00Z' }), false)
    assert.equal(needsOnboarding(null), false)
    assert.equal(needsOnboarding(undefined), false)
  })
  it('display name', () => {
    assert.equal(displayName({ name: ' Charles ', onboardedAt: null }), 'Charles')
    assert.equal(displayName(null), 'You')
  })
})

describe('avatar draft', () => {
  const img = { kind: 'image', file: 'a.png', updatedAt: 't' }
  const file = { name: 'x.png' }
  it('baseline / dirty', () => {
    assert.deepEqual(avatarBaseline({ kind: 'emoji', value: '🦊' }), { emoji: '🦊', file: null, removeImage: false })
    assert.equal(avatarDirty(avatarBaseline(img), avatarBaseline(img)), false)
    assert.equal(avatarDirty(withEmoji(avatarBaseline(img), '🦊', img), avatarBaseline(img)), true)
  })
  it('emoji replaces an image and toggles off', () => {
    const d = withEmoji(avatarBaseline(img), '🦊', img)
    assert.deepEqual(d, { emoji: '🦊', file: null, removeImage: true })
    assert.equal(withEmoji(d, '🦊', img).emoji, null)
    assert.deepEqual(shownAvatar(d, img), { kind: 'emoji', value: '🦊' })
  })
  it('file and clear', () => {
    assert.equal(withFile(avatarBaseline({ kind: 'emoji', value: '🦊' }), file).emoji, null)
    assert.deepEqual(cleared(img), { emoji: null, file: null, removeImage: true })
    assert.equal(shownAvatar(cleared(img), img), null)
  })
  it('file validation', () => {
    assert.equal(avatarFileError({ type: 'image/png', size: 10 }), null)
    assert.match(avatarFileError({ type: 'text/plain', size: 10 }), /PNG/)
    assert.match(avatarFileError({ type: 'image/png', size: 2 * 1024 * 1024 }), /1 MB/)
  })
  it('save plans', () => {
    assert.deepEqual(avatarSavePlan(withEmoji(avatarBaseline(img), '🙂', img), img), { avatar: { kind: 'emoji', value: '🙂' }, deleteImage: true, upload: false })
    assert.deepEqual(avatarSavePlan(cleared({ kind: 'emoji', value: '🦊' }), { kind: 'emoji', value: '🦊' }), { avatar: null, deleteImage: false, upload: false })
    assert.deepEqual(avatarSavePlan(cleared(img), img), { avatar: null, deleteImage: true, upload: false })
    assert.deepEqual(avatarSavePlan(avatarBaseline(img), img), { deleteImage: false, upload: false })
    assert.deepEqual(avatarSavePlan(withFile(avatarBaseline(undefined), file), undefined), { deleteImage: false, upload: true })
    assert.deepEqual(avatarSavePlan(avatarBaseline(undefined), undefined), { deleteImage: false, upload: false })
  })
})
