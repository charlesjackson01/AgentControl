import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DEFAULT_MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS_PLACEHOLDER, maxOutputTokensLabel, maxOutputTokensPatch, validateMaxOutputTokens } from '../src/lib/max-output-tokens.ts'

describe('validateMaxOutputTokens', () => {
  it('blank is valid (server default)', () => {
    assert.equal(validateMaxOutputTokens(''), null)
    assert.equal(validateMaxOutputTokens('  ', 8192), null)
  })
  it('accepts integers in (0, contextWindow)', () => {
    assert.equal(validateMaxOutputTokens('1', 8192), null)
    assert.equal(validateMaxOutputTokens(' 2048 ', 8192), null)
    assert.equal(validateMaxOutputTokens('8191', 8192), null)
    assert.equal(validateMaxOutputTokens('100000'), null)
  })
  it('rejects non-integers, zero, negatives', () => {
    assert.match(validateMaxOutputTokens('1.5', 8192), /whole number/)
    assert.match(validateMaxOutputTokens('-3', 8192), /whole number/)
    assert.match(validateMaxOutputTokens('abc'), /whole number/)
    assert.match(validateMaxOutputTokens('1e3'), /whole number/)
    assert.match(validateMaxOutputTokens('0', 8192), /greater than 0/)
  })
  it('rejects >= contextWindow when known', () => {
    assert.match(validateMaxOutputTokens('8192', 8192), /less than the context window \(8,192\)/)
    assert.match(validateMaxOutputTokens('9000', 8192), /context window/)
    assert.equal(validateMaxOutputTokens('9000', NaN), null)
  })
})

describe('maxOutputTokensPatch', () => {
  it('create: only when set', () => {
    assert.deepEqual(maxOutputTokensPatch('', undefined, false), {})
    assert.deepEqual(maxOutputTokensPatch('2048', undefined, false), { maxOutputTokens: 2048 })
  })
  it('edit: only when changed', () => {
    assert.deepEqual(maxOutputTokensPatch('2048', 2048, true), {})
    assert.deepEqual(maxOutputTokensPatch('', undefined, true), {})
    assert.deepEqual(maxOutputTokensPatch('', null, true), {})
    assert.deepEqual(maxOutputTokensPatch('1024', 2048, true), { maxOutputTokens: 1024 })
    assert.deepEqual(maxOutputTokensPatch('1024', undefined, true), { maxOutputTokens: 1024 })
  })
  it('edit: blank clears with null', () => {
    assert.deepEqual(maxOutputTokensPatch(' ', 2048, true), { maxOutputTokens: null })
  })
})

describe('maxOutputTokensLabel', () => {
  it('shows only when set', () => {
    assert.equal(maxOutputTokensLabel(2048), ' · reply 2048')
    assert.equal(maxOutputTokensLabel(undefined), '')
    assert.equal(maxOutputTokensLabel(null), '')
  })
  it('placeholder names the default', () => {
    assert.equal(DEFAULT_MAX_OUTPUT_TOKENS, 4096)
    assert.equal(MAX_OUTPUT_TOKENS_PLACEHOLDER, '4096 (default)')
  })
})
