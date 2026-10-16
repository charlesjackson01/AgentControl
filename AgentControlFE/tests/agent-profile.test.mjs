import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  AVATAR_PALETTE, MAX_RULES, MAX_RULE_LENGTH, addRule, initialsOf, moveRule, normalizeRules,
  paletteColor, removeRule, rulesEqual, updateRule,
} from '../src/lib/agent-profile.ts'

describe('initialsOf', () => {
  it('takes first and last word initials', () => {
    assert.equal(initialsOf('Support Triage'), 'ST')
    assert.equal(initialsOf('code review bot'), 'CB')
  })
  it('single word -> one letter, uppercased', () => assert.equal(initialsOf('lead'), 'L'))
  it('splits on - _ .', () => assert.equal(initialsOf('front-end_dev'), 'FD'))
  it('empty or blank -> ?', () => {
    assert.equal(initialsOf(''), '?')
    assert.equal(initialsOf('   '), '?')
  })
  it('handles astral characters without splitting surrogates', () => assert.equal(initialsOf('𝒜lpha 𝔅eta'), '𝒜𝔅'))
})

describe('paletteColor', () => {
  it('is stable and from the palette', () => {
    assert.equal(paletteColor('agent-1'), paletteColor('agent-1'))
    assert.ok(AVATAR_PALETTE.includes(paletteColor('xyz')))
  })
})

describe('rules helpers', () => {
  const r = ['a', 'b', 'c']
  it('add appends and caps', () => {
    assert.deepEqual(addRule(r, 'd'), ['a', 'b', 'c', 'd'])
    assert.deepEqual(addRule(r), ['a', 'b', 'c', ''])
    const full = Array.from({ length: MAX_RULES }, (_, i) => String(i))
    assert.equal(addRule(full, 'x').length, MAX_RULES)
    assert.equal(addRule([], 'x'.repeat(MAX_RULE_LENGTH + 5))[0].length, MAX_RULE_LENGTH)
  })
  it('update replaces at index, ignores out of range, never mutates', () => {
    assert.deepEqual(updateRule(r, 1, 'B'), ['a', 'B', 'c'])
    assert.deepEqual(updateRule(r, 5, 'x'), r)
    assert.deepEqual(r, ['a', 'b', 'c'])
  })
  it('remove drops index', () => assert.deepEqual(removeRule(r, 0), ['b', 'c']))
  it('move up/down and clamps at ends', () => {
    assert.deepEqual(moveRule(r, 2, -1), ['a', 'c', 'b'])
    assert.deepEqual(moveRule(r, 0, 1), ['b', 'a', 'c'])
    assert.deepEqual(moveRule(r, 0, -1), r)
    assert.deepEqual(moveRule(r, 2, 1), r)
  })
  it('normalize trims, drops blanks and duplicates', () => {
    assert.deepEqual(normalizeRules([' a ', '', 'b', 'a', '  ']), ['a', 'b'])
  })
  it('rulesEqual compares normalized order', () => {
    assert.ok(rulesEqual(['a ', ''], ['a']))
    assert.ok(!rulesEqual(['a', 'b'], ['b', 'a']))
  })
})
