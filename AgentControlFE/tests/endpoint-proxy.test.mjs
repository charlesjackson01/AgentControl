import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MASKED_PROXY_HINT, endpointTestNote, isMaskedProxy, maskedProxyWarning, proxyUrlPatch, validateProxyUrl } from '../src/lib/endpoint-proxy.ts'

describe('validateProxyUrl', () => {
  it('blank is fine (no proxy)', () => {
    assert.equal(validateProxyUrl(''), null)
    assert.equal(validateProxyUrl('   '), null)
  })
  it('accepts http and https', () => {
    assert.equal(validateProxyUrl('http://localhost:1055'), null)
    assert.equal(validateProxyUrl(' https://proxy.example.com:8443 '), null)
  })
  it('accepts socks5 and socks5h (BE-11)', () => {
    assert.equal(validateProxyUrl('socks5://localhost:1055'), null)
    assert.equal(validateProxyUrl('socks5h://100.64.0.1:1080'), null)
    assert.equal(validateProxyUrl('SOCKS5://user:pass@localhost:1080'), null)
  })
  it('rejects other schemes and junk', () => {
    assert.match(validateProxyUrl('socks4://localhost:1055'), /socks5/)
    assert.match(validateProxyUrl('ftp://localhost:21'), /http/)
    assert.match(validateProxyUrl('socks5://'), /valid URL|host/)
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

describe('masked proxy password (BE-11 user:***@host)', () => {
  const masked = ['socks5h://user:***@localhost:1055', 'http://user:***@host:8080', 'socks5://user:***@[::1]:1055', 'https://u:***@proxy.example.com:8443']
  it('validation accepts masked URLs (* is legal in userinfo)', () => {
    for (const v of masked) assert.equal(validateProxyUrl(v), null, v)
  })
  it('an untouched masked value is not sent on save (BE keeps the stored URL)', () => {
    for (const v of masked) assert.deepEqual(proxyUrlPatch(v, v, true), {}, v)
  })
  it('a changed host still sends *** verbatim (BE-11 decides), never normalised to %2A%2A%2A or given a trailing /', () => {
    const out = proxyUrlPatch('http://user:***@newhost:8080', 'http://user:***@host:8080', true)
    assert.deepEqual(out, { proxyUrl: 'http://user:***@newhost:8080' })
    assert.ok(!out.proxyUrl.includes('%2A'))
  })
  it('a new password is sent as typed', () => {
    assert.deepEqual(proxyUrlPatch('socks5h://user:n3w@localhost:1055', 'socks5h://user:***@localhost:1055', true), { proxyUrl: 'socks5h://user:n3w@localhost:1055' })
  })
  it('isMaskedProxy spots the mask only in the password', () => {
    for (const v of masked) assert.equal(isMaskedProxy(v), true, v)
    assert.equal(isMaskedProxy('socks5h://user:secret@localhost:1055'), false)
    assert.equal(isMaskedProxy('socks5h://***@localhost:1055'), false, 'username, not password')
    assert.equal(isMaskedProxy('http://localhost:1055'), false)
    assert.equal(isMaskedProxy('not a url'), false)
    assert.match(MASKED_PROXY_HINT, /\*\*\*/)
    assert.match(MASKED_PROXY_HINT, /same scheme, username, host and port/)
  })
  it('warns before saving when *** no longer matches scheme, username, host and port', () => {
    const loaded = 'socks5h://user:***@localhost:1055'
    assert.equal(maskedProxyWarning(loaded, loaded), null, 'untouched')
    assert.equal(maskedProxyWarning('http://user:***@HOST:8080', 'http://user:***@host:8080'), null, 'http hosts are case-folded by the parser')
    assert.ok(maskedProxyWarning('socks5h://user:***@LOCALHOST:1055', loaded), 'socks5 hosts compare as typed, like BE-11')
    assert.equal(maskedProxyWarning('socks5h://user:n3w@otherhost:1055', loaded), null, 'new password typed')
    assert.equal(maskedProxyWarning('', loaded), null)
    for (const v of ['socks5h://user:***@otherhost:1055', 'socks5h://user:***@localhost:1080', 'socks5://user:***@localhost:1055', 'socks5h://other:***@localhost:1055', 'http://user:***@localhost:1055']) {
      assert.match(maskedProxyWarning(v, loaded) ?? '', /scheme, username, host or port changed/, v)
    }
    assert.match(maskedProxyWarning('http://user:***@h:8080', undefined), /no saved password/)
    assert.match(maskedProxyWarning('http://user:***@h:8080', 'http://h:8080'), /no saved password/, 'saved proxy has no password')
    assert.equal(maskedProxyWarning('http://user:***@h', 'http://user:***@h:80'), null, 'default port is the same port')
  })
  it('socks5h:// with no host is rejected', () => {
    assert.match(validateProxyUrl('socks5h://'), /host/)
    assert.match(validateProxyUrl('socks5h://:1055'), /valid URL|host/)
    assert.match(validateProxyUrl('socks5h://user:***@'), /valid URL|host/)
  })
})

describe('endpointTestNote (Test button)', () => {
  it('success lists latency and models', () => {
    assert.equal(endpointTestNote({ ok: true, models: ['a', 'b'], latencyMs: 12 }), 'Reachable · 12ms · [a, b]')
  })
  it("failure shows BE-11's error cause", () => {
    assert.equal(
      endpointTestNote({ ok: false, models: [], latencyMs: 3, error: 'fetch failed (ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:1055)' }),
      'Unreachable · fetch failed (ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:1055)',
    )
  })
  it('failure without error (pre-BE-11) stays "Unreachable"', () => {
    assert.equal(endpointTestNote({ ok: false, models: [], latencyMs: 0 }), 'Unreachable')
    assert.equal(endpointTestNote({ ok: false, models: [], latencyMs: 0, error: '  ' }), 'Unreachable')
  })
})
