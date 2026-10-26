import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import { createDialogStack } from '../src/lib/dialog-stack.ts'

describe('dialog stack (Esc goes to the topmost dialog)', () => {
  it('the last opened dialog is on top; closing it hands the top back', () => {
    const s = createDialogStack()
    const settings = {}, endpoint = {}
    s.open(settings)
    assert.equal(s.isTop(settings), true)
    s.open(endpoint)
    assert.equal(s.isTop(endpoint), true)
    assert.equal(s.isTop(settings), false, 'Settings ignores Esc while Edit endpoint is open')
    s.close(endpoint)
    assert.equal(s.isTop(settings), true)
    s.close(settings)
    assert.equal(s.size(), 0)
    assert.equal(s.isTop(settings), false)
  })
  it('re-opening an already-open dialog does not move it to the top', () => {
    const s = createDialogStack()
    const a = {}, b = {}
    s.open(a); s.open(b); s.open(a)
    assert.equal(s.isTop(b), true)
    assert.equal(s.size(), 2)
  })
  it('closing a lower dialog keeps the top one; closing unknown tokens is a no-op', () => {
    const s = createDialogStack()
    const a = {}, b = {}, c = {}
    s.open(a); s.open(b); s.open(c)
    s.close(b); s.close({})
    assert.equal(s.isTop(c), true)
    s.close(c)
    assert.equal(s.isTop(a), true)
  })
  it('useDialogFocus (Dialog and ConfirmDialog) only acts on keys when it is the top dialog', () => {
    const src = readFileSync(new URL('../src/hooks/useDialogFocus.ts', import.meta.url), 'utf8')
    assert.match(src, /if \(!dialogStack\.isTop\(token\)\) return/)
    assert.match(src, /dialogStack\.open\(token\)/)
    assert.match(src, /dialogStack\.close\(token\)/)
    assert.doesNotMatch(src, /\[open, onClose\]/, 'a new onClose each render must not re-register the dialog')
  })
})
