import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { proxyUrlPatch, validateProxyUrl } from '../src/lib/endpoint-proxy.ts'

describe('validateProxyUrl', () => {
  it('blank is fine (no proxy)', () => {
    assert.equal(validateProxyUrl(''), null)
    assert.equal(validateProxyUrl('   '), null)
  })
  it('accepts http and https', () => {
    assert.equal(validateProxyUrl('http://localhost:1055'), null)
    assert.equal(validateProxyUrl(' https://proxy.example.com:8443 '), null)
  })
  it('rejects other schemes and junk', () => {
    assert.match(validateProxyUrl('socks5://localhost:1055'), /http/)
    assert.match(validateProxyUrl('localhost:1055'), /http|valid/)
    assert.match(validateProxyUrl('not a url'), /valid URL/)
  })
})

describe('proxyUrlPatch', () => {
  it('create: only sends a set value', () => {
    assert.deepEqual(proxyUrlPatch('', undefined, false), {})
    assert.deepEqual(proxyUrlPatch(' http://p:1 ', undefined, false), { proxyUrl: 'http://p:1' })
  })
  it('edit: omit unchanged, null to clear, value to change', () => {
    assert.deepEqual(proxyUrlPatch('http://p:1', 'http://p:1', true), {})
    assert.deepEqual(proxyUrlPatch('', undefined, true), {})
    assert.deepEqual(proxyUrlPatch('', 'http://p:1', true), { proxyUrl: null })
    assert.deepEqual(proxyUrlPatch('http://q:2', 'http://p:1', true), { proxyUrl: 'http://q:2' })
  })
})
