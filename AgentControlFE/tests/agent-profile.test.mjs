import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  AVATAR_PALETTE, MAX_RULES, MAX_RULE_LENGTH, addRule, initialsOf, moveRule, normalizeRules,
  paletteColor, removeRule, rulesTokenCost, describeRulesCost, isHexColor, rulesEqual, updateRule,
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

describe('BE-aligned limits', () => {
  it('rules cap at 20 x 500', () => {
    assert.equal(MAX_RULES, 20)
    assert.equal(MAX_RULE_LENGTH, 500)
  })
  it('rulesTokenCost reads rulesTokens from the budget, defaulting to 0', () => {
    assert.equal(rulesTokenCost({ rulesTokens: 21 }), 21)
    assert.equal(rulesTokenCost({}), 0)
  })
  it('describeRulesCost covers each state', () => {
    const base = { ruleCount: 2, hasEndpoint: true, cost: 1234, pending: false }
    assert.equal(describeRulesCost({ ...base, ruleCount: 0 }), 'No rules yet.')
    assert.match(describeRulesCost({ ...base, hasEndpoint: false }), /Pick an endpoint/)
    assert.match(describeRulesCost({ ...base, cost: null, pending: true }), /Measuring/)
    assert.match(describeRulesCost({ ...base, cost: null }), /unavailable/)
    assert.equal(describeRulesCost(base), 'Rules add ≈1,234 tokens to the prompt.')
  })
  it('isHexColor accepts #rrggbb only', () => {
    assert.ok(isHexColor('#a1B2c3'))
    assert.ok(!isHexColor('#abc'))
    assert.ok(!isHexColor('red'))
  })
  it('palette is all #rrggbb', () => assert.ok(AVATAR_PALETTE.every(isHexColor)))
})
