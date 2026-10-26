// Registry facade first: it must load standalone (see registry.test.ts).
import { executeToolCall } from '../tools.js'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { WorkspaceStore } from '../store.js'
import { textTools } from './text.js'
import type { ToolContext } from './types.js'

/** A vault value that matches none of redact.ts's key patterns, so only the exact-value pass can catch it. */
const SECRET = 'Zq7-endpoint-secret-91'
const PROTO_KEYS = ['__proto__', 'constructor', 'toString'] as const
const TOOLS = ['diff_text', 'encode_text'] as const
const N = 200_000


const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')
const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')

const store = {
  endpointKeys: { ep_test: SECRET },
} as unknown as WorkspaceStore

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return { store, agentId: 'agent', runId: 'run', input: '', allowed: new Set<string>([...TOOLS]),
    now: () => new Date('2026-10-12T09:30:00Z'), timeZone: 'UTC', writes: { count: 0 }, ...overrides }
}

type Json = Record<string, any>

function entry(name: string) {
  const found = textTools.find((t) => t.name === name)
  if (!found) throw new Error(`missing tool ${name}`)
  return found
}

/** Call a handler directly; every result is a JSON object that fits one tool result. */
function call(name: string, args: Json): Json {
  const value = entry(name).handler(args, context())
  expect(value).not.toBeUndefined()
  expect(JSON.stringify(value).length).toBeLessThanOrEqual(3500)
  return value as Json
}

async function run(name: string, args: Json | string, overrides: Partial<ToolContext> = {}) {
  return executeToolCall({ id: 'call', name, arguments: typeof args === 'string' ? args : JSON.stringify(args) }, context(overrides))
}

/** The handler's error, asserted to end with an example that then runs cleanly through executeToolCall. */
async function failure(name: string, args: Json): Promise<string> {
  let message = ''
  try {
    entry(name).handler(args, context())
  } catch (err) {
    expect(err).toBeInstanceOf(Error)
    message = (err as Error).message
  }
  const example = /Example: (\{.*\})$/.exec(message)
  expect(example, message || `expected ${name} to throw`).not.toBeNull()
  const outcome = await run(name, JSON.parse(example![1]!) as Json)
  expect(outcome.ok, `example in: ${message} -> ${outcome.content}`).toBe(true)
  return message
}

/**
 * Time one handler call after a warm-up run (so JIT tiers do not count),
 * keeping the best of up to 3 runs so a GC pause or a busy parallel worker
 * cannot fail it. Far under 1 s; a super-linear algorithm is slow every run.
 */
function expectFast(name: string, args: Json, label: string, maxMs = 1_000): Json {
  const once = () => {
    try {
      return entry(name).handler(args, context()) as Json
    } catch (err) {
      return { error: (err as Error).message }
    }
  }
  once()
  let ms = Infinity
  let value: Json = {}
  for (let attempt = 0; attempt < 3 && ms >= maxMs; attempt++) {
    const start = performance.now()
    value = once()
    ms = Math.min(ms, performance.now() - start)
  }
  expect(ms, `${name} ${label}: ${ms.toFixed(1)}ms`).toBeLessThan(maxMs)
  expect(JSON.stringify(value).length, label).toBeLessThanOrEqual(3500)
  return value
}

const lines = (...items: string[]) => items.join('\n')

describe('diff_text and encode_text declarations', () => {
  it('are appended to the text tools with content params and short descriptions', () => {
    expect(textTools.map((t) => t.name).slice(-2)).toEqual([...TOOLS])
    expect(entry('diff_text')).toMatchObject({ category: 'text', effect: 'read', contentParams: { names: ['before', 'after'] } })
    expect(entry('encode_text')).toMatchObject({ category: 'text', effect: 'read', contentParams: { names: ['text'] } })
    for (const name of TOOLS) {
      expect(entry(name).description.length).toBeLessThanOrEqual(240)
      expect(entry(name).description).toContain('Example:')
    }
  })
})

// --- diff_text -------------------------------------------------------------------

describe('diff_text', () => {
  const ten = lines('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j')
  const diff = (before: unknown, after: unknown) => call('diff_text', { before, after })

  it('reports identical texts, and only line-ending differences, without hunks', () => {
    expect(diff('x\ny', 'x\ny')).toEqual({ identical: true, added: 0, removed: 0, unchanged: 2 })
    expect(diff('x\r\ny\r\n', 'x\ny')).toEqual({
      identical: true, added: 0, removed: 0, unchanged: 2, note: 'Only line endings or a final line break differ.',
    })
    expect(diff('x\ry', 'x\ny')).toMatchObject({ identical: true, unchanged: 2 })
  })

  it('handles empty sides with 0-length hunk ranges', () => {
    expect(diff('', '')).toEqual({ identical: true, added: 0, removed: 0, unchanged: 0 })
    expect(diff('', 'x\ny')).toMatchObject({ added: 2, removed: 0, diff: ['@@ -0,0 +1,2 @@', '+x', '+y'] })
    expect(diff('x', '')).toMatchObject({ added: 0, removed: 1, diff: ['@@ -1,1 +0,0 @@', '-x'] })
    // A lone line break is one empty line.
    expect(diff('\n', '')).toMatchObject({ removed: 1, diff: ['@@ -1,1 +0,0 @@', '-'] })
  })

  it('emits unified hunks with 2 context lines and counts', () => {
    expect(diff(ten, lines('a', 'B', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'))).toEqual({
      identical: false, added: 2, removed: 1, unchanged: 9, hunks: 2,
      diff: ['@@ -1,4 +1,4 @@', ' a', '-b', '+B', ' c', ' d', '@@ -9,2 +9,3 @@', ' i', ' j', '+k'],
    })
    // Changes separated by at most 4 unchanged lines share one hunk.
    expect(diff(ten, lines('a', 'B', 'c', 'd', 'e', 'F', 'g', 'h', 'i', 'j'))).toMatchObject({
      hunks: 1, diff: ['@@ -1,8 +1,8 @@', ' a', '-b', '+B', ' c', ' d', ' e', '-f', '+F', ' g', ' h'],
    })
  })

  it('diffs inserted, deleted and moved lines', () => {
    expect(diff(lines('a', 'b'), lines('a', 'new', 'b'))).toMatchObject({
      added: 1, removed: 0, unchanged: 2, diff: ['@@ -1,2 +1,3 @@', ' a', '+new', ' b'],
    })
    expect(diff(lines('a', 'gone', 'b', 'c'), lines('a', 'b', 'c'))).toMatchObject({
      added: 0, removed: 1, unchanged: 3, diff: ['@@ -1,4 +1,3 @@', ' a', '-gone', ' b', ' c'],
    })
    // A moved line is one removal plus one insertion; the rest stays unchanged.
    expect(diff(lines('a', 'b', 'c', 'd'), lines('b', 'c', 'd', 'a'))).toMatchObject({
      added: 1, removed: 1, unchanged: 3, hunks: 1, diff: ['@@ -1,4 +1,4 @@', '-a', ' b', ' c', ' d', '+a'],
    })
  })

  it('diffs prototype-named lines like any other (interned in a Map)', () => {
    expect(diff(lines(...PROTO_KEYS), lines('__proto__', 'toString', 'constructor'))).toMatchObject({
      added: 1, removed: 1, unchanged: 2, diff: ['@@ -1,3 +1,3 @@', ' __proto__', '-constructor', ' toString', '+constructor'],
    })
  })

  it('accepts a list of lines (or a number) for either side', () => {
    expect(diff(['a', 'b'], 'a\nc')).toMatchObject({ added: 1, removed: 1, unchanged: 1 })
    expect(diff(42, '42')).toMatchObject({ identical: true })
  })

  it('windows a long changed line around its first difference, at most 200 chars per line', () => {
    const out = diff(`${'a'.repeat(1_000)}X${'a'.repeat(1_000)}`, `${'a'.repeat(1_000)}Y${'a'.repeat(1_000)}`).diff as string[]
    expect(out.find((l) => l.startsWith('-'))).toMatch(/^-….*X/)
    expect(out.find((l) => l.startsWith('+'))).toMatch(/^\+….*Y/)
    for (const line of out) expect(line.length).toBeLessThanOrEqual(200)
    const unpaired = diff('short', `short\n${'z'.repeat(500)}`).diff as string[]
    expect(unpaired.at(-1)).toHaveLength(200)
    expect(unpaired.at(-1)?.endsWith('…')).toBe(true)
  })

  it('stops at 80 output lines within the result budget and says the hunks were truncated', () => {
    const before = Array.from({ length: 400 }, (_, i) => `old ${i}`).join('\n')
    const after = Array.from({ length: 400 }, (_, i) => `new ${i}`).join('\n')
    const result = diff(before, after)
    expect(result).toMatchObject({ added: 400, removed: 400, unchanged: 0, hunks: 1, truncated: true, diff_lines: 801 })
    expect(result.hint).toMatch(/smaller section/)
    expect(result.diff).toHaveLength(80)
    expect(result.diff[0]).toBe('@@ -1,400 +1,400 @@')

    const wide = diff(
      Array.from({ length: 100 }, (_, i) => `${i} ${'w'.repeat(300)}`).join('\n'),
      Array.from({ length: 100 }, (_, i) => `${i}! ${'w'.repeat(300)}`).join('\n'),
    )
    expect(wide.truncated).toBe(true)
    expect(wide.diff.length).toBeLessThan(80)
    for (const line of wide.diff as string[]) expect(line.length).toBeLessThanOrEqual(200)
  })

  it('caps each side at 400 lines and 50,000 chars and requires both sides', async () => {
    expect(await failure('diff_text', { before: 'x' })).toMatch(/"after" is required/)
    expect(await failure('diff_text', { after: 'x' })).toMatch(/"before" is required/)
    expect(await failure('diff_text', { before: 'x', after: { a: 1 } })).toMatch(/"after" must be text/)
    expect(await failure('diff_text', { before: 'x\n'.repeat(401), after: 'x' })).toMatch(/"before" has 401 lines \(max 400\)/)
    expect(await failure('diff_text', { before: 'x\r'.repeat(401), after: 'x' })).toMatch(/401 lines \(max 400\)/)
    expect(await failure('diff_text', { before: 'x', after: Array(401).fill('y') })).toMatch(/"after" has 401 lines \(max 400\)/)
    expect(await failure('diff_text', { before: 'x', after: 'y'.repeat(50_001) })).toMatch(/too long \(50001 chars, max 50000\)/)
    expect(await failure('diff_text', { before: ['a', { b: 1 }], after: 'x' })).toMatch(/list of lines/)
    // A final line break does not count as a 401st line.
    expect(diff('x\n'.repeat(400), 'x\n'.repeat(399))).toMatchObject({ removed: 1, unchanged: 399 })
  })

  it('resolves "@input" on either side, with no default', async () => {
    const outcome = await run('diff_text', { before: 'alpha\nbeta\ngamma\n', after: '@input' }, { input: 'alpha\nBETA\ngamma' })
    expect(outcome.ok).toBe(true)
    expect(JSON.parse(outcome.content)).toMatchObject({
      added: 1, removed: 1, unchanged: 2,
      diff: ['@@ -1,3 +1,3 @@', ' alpha', '-beta', '+BETA', ' gamma'],
      sources: { after: '@input' },
    })
    const noDefault = await run('diff_text', { before: 'a' }, { input: 'b' })
    expect(noDefault).toMatchObject({ ok: false, content: expect.stringMatching(/"after" is required/) })
  })

  it('redacts vault values before clipping a long line', () => {
    expect(diff('key: none', `key: ${SECRET}`).diff).toEqual(['@@ -1,1 +1,1 @@', '-key: none', `+key: [redacted]`])
    // Unredacted, the 199-char clip would end in a prefix of the key that no later pass can match.
    const out = JSON.stringify(diff('short', `short\n${'x'.repeat(190)}${SECRET}`))
    expect(out).not.toContain(SECRET.slice(0, 4))
    expect(out).toContain('[redacte')
  })

  it('finishes pathological inputs at max size quickly', () => {
    const block = (p: string) => Array.from({ length: 400 }, (_, i) => `${p}${i} ${'y'.repeat(110)}`).join('\n')
    expectFast('diff_text', { before: block('b'), after: block('a') }, 'all lines differ')
    expectFast('diff_text', { before: block('b'), after: block('b').replace('b200 ', 'X ') }, 'one line differs')
    expectFast('diff_text', { before: block('b'), after: block('b').split('\n').reverse().join('\n') }, 'reversed')
    expectFast('diff_text', { before: 'a'.repeat(50_000), after: `${'a'.repeat(25_000)}b${'a'.repeat(24_999)}` }, 'one long line')
    expectFast('diff_text', {
      before: Array.from({ length: 400 }, (_, i) => (i % 2 ? 'a' : 'b')).join('\n'),
      after: Array.from({ length: 400 }, (_, i) => (i % 3 ? 'a' : 'b')).join('\n'),
    }, 'interleaved repeats')
    expectFast('diff_text', { before: Array(400).fill('a').join('\n'), after: Array(400).fill('b').join('\n') }, 'disjoint')
    expectFast('diff_text', { before: Array(400).fill('x'.repeat(124)), after: Array(400).fill('x'.repeat(123) + 'y') }, 'near-equal lists')
    expectFast('diff_text', { before: `${SECRET}\n`.repeat(400), after: `${SECRET} \n`.repeat(400) }, 'redaction-heavy')
  })
})

// --- encode_text -----------------------------------------------------------------

describe('encode_text', () => {
  const enc = (operation: string, text: unknown) => call('encode_text', { operation, text })

  it('round-trips base64 and URL encoding for ASCII and Unicode', () => {
    expect(enc('base64_encode', 'hello')).toEqual({ operation: 'base64_encode', result: 'aGVsbG8=' })
    expect(enc('base64_encode', '')).toEqual({ operation: 'base64_encode', result: '' })
    expect(enc('base64_decode', '')).toEqual({ operation: 'base64_decode', result: '', bytes: 0 })
    for (const text of ['héllo wörld ✓ 😀', 'tab\tand\r\nnewline', '"quotes" \\ back']) {
      const encoded = enc('base64_encode', text).result as string
      expect(encoded).toBe(b64(text))
      expect(enc('base64_decode', encoded)).toEqual({ operation: 'base64_decode', result: text, bytes: Buffer.byteLength(text) })
      const url = enc('url_encode', text).result as string
      expect(url).toBe(encodeURIComponent(text))
      expect(enc('url_decode', url)).toEqual({ operation: 'url_decode', result: text })
    }
    expect(enc('url_encode', 'a b&c/ü')).toEqual({ operation: 'url_encode', result: 'a%20b%26c%2F%C3%BC' })
    expect(enc('url_decode', 'q=a+b%2Bc')).toEqual({ operation: 'url_decode', result: 'q=a b+c', plus_as_space: true })
    expect(enc('base64_encode', 12345).result).toBe(b64('12345'))
  })

  it('decodes base64url and unpadded input (JWT parts), whitespace and data: URIs', () => {
    expect(enc('base64_decode', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9').result).toBe('{"alg":"HS256","typ":"JWT"}')
    const payload = '{"sub":"1234567890","name":"Jöhn ?>","iat":1516239022}'
    const part = Buffer.from(payload, 'utf8').toString('base64url')
    expect(part).not.toMatch(/=$/)
    expect(part).toMatch(/[-_]/)
    expect(enc('base64_decode', part)).toEqual({ operation: 'base64_decode', result: payload, bytes: Buffer.byteLength(payload) })
    expect(enc('base64_decode', 'PDw_Pz4-').result).toBe('<<??>>')
    expect(enc('base64_decode', 'aGVsbG8').result).toBe('hello')
    expect(enc('base64_decode', 'aGVsbA').result).toBe('hell')
    expect(enc('base64_decode', ' aGVs\nbG8=\n').result).toBe('hello')
    expect(enc('base64_decode', 'data:text/plain;base64,aGVsbG8=').result).toBe('hello')
  })

  it('rejects invalid base64 with a reason and an example', async () => {
    expect(await failure('encode_text', { operation: 'base64_decode', text: 'abc$' })).toMatch(/not valid base64: use only/)
    expect(await failure('encode_text', { operation: 'base64_decode', text: 'abcde' })).toMatch(/cannot encode whole bytes/)
    expect(await failure('encode_text', { operation: 'base64_decode', text: 'ab=' })).toMatch(/cannot encode whole bytes/)
    expect(await failure('encode_text', { operation: 'base64_decode', text: '=' })).toMatch(/cannot encode whole bytes/)
    expect(await failure('encode_text', { operation: 'base64_decode', text: 'ab==c' })).toMatch(/use only/)
    expect(await failure('encode_text', { operation: 'base64_decode', text: 'a+b-' })).toMatch(/mixes base64/)
    expect(await failure('encode_text', { operation: 'base64_decode', text: 'QR==' })).toMatch(/stray bits/)
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl'
    expect(await failure('encode_text', { operation: 'base64_decode', text: jwt })).toMatch(/decode one part at a time/)
  })

  it('rejects malformed %-sequences and unpaired surrogates', async () => {
    for (const text of ['100%', '%zz', '%E0%A4%A', '%C3', '%FF', '%C3%28', '%ED%A0%80']) {
      expect(await failure('encode_text', { operation: 'url_decode', text })).toMatch(/malformed percent-encoding/)
    }
    expect(await failure('encode_text', { operation: 'url_encode', text: 'bad \ud800 pair' })).toMatch(/unpaired surrogate/)
  })

  it('hashes the UTF-8 bytes with sha256 (known vectors)', () => {
    const vectors: [string, string][] = [
      ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
      ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
      ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
      ['The quick brown fox jumps over the lazy dog', 'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592'],
    ]
    for (const [text, hex] of vectors) expect(enc('sha256', text)).toEqual({ operation: 'sha256', result: hex, bytes: text.length })
    expect(enc('sha256', 'é')).toEqual({ operation: 'sha256', result: sha(Buffer.from('é', 'utf8')), bytes: 2 })
    expect(enc('sha256', 'a'.repeat(N))).toMatchObject({ bytes: N })
  })

  it('returns only size and hash for bytes that are not UTF-8 text', () => {
    expect(enc('base64_decode', '//79')).toEqual({ operation: 'base64_decode', binary: true, bytes: 3, sha256: sha(Buffer.from([0xff, 0xfe, 0xfd])) })
    // Valid UTF-8 with control characters is binary too.
    expect(enc('base64_decode', 'AAE=')).toEqual({ operation: 'base64_decode', binary: true, bytes: 2, sha256: sha(Buffer.from([0, 1])) })
    // A vault value inside binary data leaves in no form at all (no hex, base64 or text rendering).
    const bytes = Buffer.concat([Buffer.from([0xff]), Buffer.from(SECRET, 'utf8')])
    const out = JSON.stringify(enc('base64_decode', bytes.toString('base64')))
    for (const form of [SECRET, Buffer.from(SECRET).toString('hex'), b64(SECRET).slice(0, 12), SECRET.slice(0, 4)]) expect(out).not.toContain(form)
    expect(JSON.parse(out)).toEqual({ operation: 'base64_decode', binary: true, bytes: bytes.length, sha256: sha(bytes) })
  })

  it('redacts a base64- or %-encoded vault key after decoding, even when the result is clipped', async () => {
    expect(enc('base64_decode', b64(`token ${SECRET}`))).toEqual({ operation: 'base64_decode', result: 'token [redacted]', bytes: 6 + SECRET.length })
    const percent = [...SECRET].map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`).join('')
    expect(enc('url_decode', `k=${percent}`).result).toBe('k=[redacted]')
    // Decoded text over the clip, with the key straddling the cut: no prefix of it may survive.
    for (const lead of [3_190, 3_195, 3_199]) {
      const decoded = `${'a'.repeat(lead)}${SECRET}${'b'.repeat(500)}`
      const result = enc('base64_decode', b64(decoded))
      expect(result).toMatchObject({ truncated: true, shown_chars: 3_200, chars: decoded.length - SECRET.length + '[redacted]'.length })
      expect(result.result).not.toContain(SECRET.slice(0, 4))
      expect(result.result.endsWith('a') || result.result.includes('[')).toBe(true)
    }
    // Through executeToolCall: an @input holding a base64 key is not caught by ref redaction, only after decoding.
    const outcome = await run('encode_text', { operation: 'base64_decode', text: '@input' }, { input: b64(`vault: ${SECRET}`) })
    expect(outcome.ok).toBe(true)
    expect(outcome.content).not.toContain(SECRET.slice(0, 4))
    expect(JSON.parse(outcome.content)).toMatchObject({ result: 'vault: [redacted]', sources: { text: '@input' } })
  })

  it('keeps max-size decodes within the result budget, counting JSON escapes', () => {
    const ascii = enc('base64_decode', 'QUJD'.repeat(1_250))
    expect(ascii).toMatchObject({ truncated: true, chars: 3_750, shown_chars: 3_200, bytes: 3_750 })
    expect(enc('url_decode', '%22'.repeat(1_166)).truncated).toBeUndefined()
    expect(enc('url_decode', 'a'.repeat(3_500))).toMatchObject({ truncated: true, chars: 3_500, shown_chars: 3_200 })
    const controls = enc('url_decode', '%01'.repeat(1_166))
    expect(controls).toMatchObject({ truncated: true, chars: 1_166, shown_chars: 533 })
    // Never half a surrogate pair at the cut.
    const emoji = enc('url_decode', `a${'😀'.repeat(1_700)}`)
    expect(emoji).toMatchObject({ truncated: true, chars: 3_401, shown_chars: 3_199 })
    expect(emoji.result.at(-1)).not.toBe('\ud83d')
  })

  it('enforces per-operation input caps (bytes for encodes, chars for decodes)', async () => {
    expect(await failure('encode_text', { operation: 'base64_encode', text: 'x'.repeat(2_501) })).toMatch(/base64_encode \(2501\+ bytes, max 2500\)/)
    expect(await failure('encode_text', { operation: 'base64_encode', text: 'é'.repeat(1_251) })).toMatch(/\(2502 bytes, max 2500\)/)
    expect(await failure('encode_text', { operation: 'url_encode', text: 'é'.repeat(551) })).toMatch(/\(1102 bytes, max 1100\)/)
    expect(await failure('encode_text', { operation: 'base64_decode', text: 'A'.repeat(5_001) })).toMatch(/\(5001 chars, max 5000\)/)
    expect(await failure('encode_text', { operation: 'url_decode', text: 'a'.repeat(3_501) })).toMatch(/\(3501 chars, max 3500\)/)
    expect(await failure('encode_text', { operation: 'sha256', text: 'a'.repeat(N + 1) })).toMatch(/too long/)
    expect(enc('base64_encode', 'x'.repeat(2_500)).result).toHaveLength(3_336)
    expect(enc('url_encode', 'é'.repeat(550)).result).toHaveLength(3_300)
  })

  it('accepts lenient operation names and rejects others with an example', async () => {
    const cases: [string, string][] = [
      ['Base64 Encode', 'base64_encode'], ['BASE64-DECODE', 'base64_decode'], ['b64decode', 'base64_decode'],
      ['atob', 'base64_decode'], ['base64url_decode', 'base64_decode'], ['SHA-256', 'sha256'], ['hash', 'sha256'],
      ['urlencode', 'url_encode'], ['URL_DECODE', 'url_decode'], ['decodeURIComponent', 'url_decode'],
    ]
    for (const [given, expected] of cases) expect(enc(given, 'aGVsbG8=').operation).toBe(expected)
    for (const operation of ['md5', 'hex', 'base64', 'rot13', ...PROTO_KEYS]) {
      expect(await failure('encode_text', { operation, text: 'x' })).toMatch(/"operation" must be one of: base64_encode/)
    }
    expect(await failure('encode_text', { text: 'x' })).toMatch(/"operation" is required/)
    expect(await failure('encode_text', { operation: 'sha256' })).toMatch(/"text" is required/)
    expect(await failure('encode_text', { operation: 'sha256', text: ['a', 'b'] })).toMatch(/"text" must be text/)
  })

  it('resolves "@input" (no default) and ignores prototype keys', async () => {
    const fromInput = await run('encode_text', { operation: 'sha256', text: '@input' }, { input: 'abc' })
    expect(JSON.parse(fromInput.content)).toMatchObject({ result: sha('abc'), sources: { text: '@input' } })
    expect(JSON.parse((await run('encode_text', { operation: 'sha256', text: '@input' })).content)).toMatchObject({ result: sha(''), bytes: 0 })
    const omitted = await run('encode_text', { operation: 'sha256' }, { input: 'abc' })
    expect(omitted).toMatchObject({ ok: false, content: expect.stringMatching(/"text" is required/) })
    const proto = await run('encode_text', '{"__proto__":{"operation":"sha256"},"constructor":{},"operation":"url_encode","text":"a b"}')
    expect(JSON.parse(proto.content)).toEqual({ operation: 'url_encode', result: 'a%20b' })
  })

  it('finishes pathological inputs at max size quickly', () => {
    expectFast('encode_text', { operation: 'sha256', text: 'é'.repeat(N) }, 'sha256 200k')
    expectFast('encode_text', { operation: 'base64_decode', text: 'A'.repeat(5_000) }, 'b64 zeros')
    expectFast('encode_text', { operation: 'base64_decode', text: '//79'.repeat(1_250) }, 'b64 binary')
    expectFast('encode_text', { operation: 'base64_decode', text: `${'A'.repeat(4_999)}$` }, 'b64 invalid')
    expectFast('encode_text', { operation: 'base64_decode', text: ' \n'.repeat(2_500) }, 'b64 whitespace')
    expectFast('encode_text', { operation: 'base64_decode', text: b64(`${SECRET} `.repeat(160)) }, 'b64 many secrets')
    expectFast('encode_text', { operation: 'url_decode', text: '%00'.repeat(1_166) }, 'url NULs')
    expectFast('encode_text', { operation: 'url_decode', text: '%'.repeat(3_500) }, 'url malformed')
    expectFast('encode_text', { operation: 'url_decode', text: '+'.repeat(3_500) }, 'url plus')
    expectFast('encode_text', { operation: 'base64_encode', text: '😀'.repeat(625) }, 'b64 encode emoji')
    expectFast('encode_text', { operation: 'url_encode', text: 'é'.repeat(550) }, 'url encode')
  })
})

describe('diff_text and encode_text through executeToolCall', () => {
  const bad: Json[] = [
    {},
    { text: null, before: null, after: null, operation: null },
    { text: 5, before: 5, after: 5, operation: 5 },
    { text: [], before: [], after: [], operation: [] },
    { text: { a: 1 }, before: { a: 1 }, after: { a: 1 }, operation: { a: 1 } },
    Object.fromEntries(PROTO_KEYS.map((k) => [k, k])),
  ]

  it('never throws, never returns undefined content, stays under 3,600 chars, and errors carry an example', async () => {
    for (const name of TOOLS) {
      for (const args of bad) {
        const outcome = await run(name, args, { input: 'Some input' })
        expect(typeof outcome.content, name).toBe('string')
        expect(outcome.content.length, name).toBeLessThan(3_600)
        if (!outcome.ok) expect(outcome.content, `${name} ${JSON.stringify(args)}`).toMatch(/Example: \{.*\}$/)
      }
      const proto = await run(name, '{"__proto__":{"text":"x"},"constructor":"y","toString":"z"}', { input: 'line' })
      expect(typeof proto.content).toBe('string')
    }
  })
})
