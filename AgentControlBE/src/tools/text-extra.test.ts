// Registry facade first: it must load standalone (see registry.test.ts).
import { executeToolCall } from '../tools.js'
import { describe, expect, it } from 'vitest'
import type { Note } from '../shared/types.js'
import type { WorkspaceStore } from '../store.js'
import { textTools } from './text.js'
import type { ToolContext } from './types.js'

const SECRET = 'sk-test-secret-123'
const PROTO_KEYS = ['__proto__', 'constructor', 'toString'] as const
const TOOLS = ['process_lines', 'extract_entities'] as const
const N = 200_000

function note(id: string, title: string, body: string): Note {
  return { id, title, body, tags: [], authorAgentId: 'agent', updatedByAgentId: 'agent', runId: 'run_old',
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' }
}

const store = {
  endpointKeys: { ep_test: SECRET },
  notes: [note('note_log', 'Server log', 'INFO start\nERROR disk full\nINFO retry\nerror disk full\n')],
} as unknown as WorkspaceStore

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return { store, agentId: 'agent', runId: 'run', input: '', allowed: new Set<string>([...TOOLS, 'read_note']),
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
 * Time one call through executeToolCall with ctx.input = the big string (the
 * "@input" path), after a warm-up run of the same call so JIT tiers and lazy
 * tables do not count. The best of up to 3 timed runs is kept, so a GC pause
 * or a busy parallel test worker cannot fail one run; a super-linear
 * algorithm is slow in every run.
 */
async function expectFast(name: string, args: Json, input: string, label: string): Promise<Json> {
  await run(name, args, { input })
  let ms = Infinity
  let outcome = { content: '', ok: false }
  for (let attempt = 0; attempt < 3 && ms >= 50; attempt++) {
    const start = performance.now()
    outcome = await run(name, args, { input })
    ms = Math.min(ms, performance.now() - start)
  }
  expect(ms, `${name} ${label}: ${ms.toFixed(1)}ms`).toBeLessThan(50)
  expect(typeof outcome.content, label).toBe('string')
  expect(outcome.content.length, label).toBeLessThan(3600)
  return outcome.ok ? (JSON.parse(outcome.content) as Json) : { error: outcome.content }
}

const lines = (...items: string[]) => items.join('\n')

describe('process_lines and extract_entities declarations', () => {
  it('are appended after the existing text tools with @input content params', () => {
    expect(textTools.map((t) => t.name)).toEqual(['text_stats', 'transform_text', 'compare_text', ...TOOLS])
    for (const name of TOOLS) {
      expect(entry(name)).toMatchObject({ category: 'text', effect: 'read', contentParams: { names: ['text'], defaultParam: 'text' } })
    }
  })
})

describe('process_lines', () => {
  const op = (operation: string, text: unknown, extra: Json = {}) => call('process_lines', { text, operation, ...extra })

  it('sorts naturally: numbers by value first, then case-insensitive natural text order', () => {
    const text = lines('item10', 'item2', 'Item1', '-3.5', '10', '2', '1,200', 'banana', 'Apple', '')
    expect(op('sort', text)).toEqual({
      operation: 'sort', nonblank_lines: 9, total: 9, returned: 9,
      result: ['-3.5', '2', '10', '1,200', 'Apple', 'banana', 'Item1', 'item2', 'item10'],
    })
    expect(op('sort_desc', text).result).toEqual(['item10', 'item2', 'Item1', 'banana', 'Apple', '1,200', '10', '2', '-3.5'])
  })

  it('orders digit runs by value without precision loss and leading zeros', () => {
    const text = lines('x100000000000000000000000', 'v0100', 'v9', 'x99999999999999999999999', 'v010', 'a0', 'a', 'a00b', 'a0a')
    expect(op('sort', text).result).toEqual(['a', 'a0', 'a0a', 'a00b', 'v9', 'v010', 'v0100', 'x99999999999999999999999', 'x100000000000000000000000'])
    // Lowercasing lengthens "İ"; the key buffer must still fit.
    expect(op('sort', lines('İİİİİİ10', 'İİİİİİ9', 'b')).result).toEqual(['b', 'İİİİİİ9', 'İİİİİİ10'])
    // Keys longer than one fromCharCode chunk, equal until the last run; leading zeros keep the clipped rows distinct.
    const runs = (zeros: number, last: number) => `${'0'.repeat(zeros)}5,${'1,'.repeat(3_000)}${last}`
    expect(op('sort', lines(runs(2, 10), runs(1, 9), runs(3, 100))).result).toEqual([runs(1, 9), runs(2, 10), runs(3, 100)].map((l) => `${l.slice(0, 199)}…`))
  })

  it('dedupes in order (trimmed, blank lines ignored) and splits CRLF and lone CR like the other text tools', () => {
    expect(op('dedupe', lines('b', 'a', 'b', ' a ', '', 'c', 'a'))).toEqual({
      operation: 'dedupe', nonblank_lines: 6, duplicates_removed: 3, total: 3, returned: 3, result: ['b', 'a', 'c'],
    })
    expect(op('dedupe', 'x\r\ny\rx\r\n')).toMatchObject({ nonblank_lines: 3, result: ['x', 'y'] })
  })

  it('counts line frequency with prototype-named lines (Map-keyed)', () => {
    const text = lines('__proto__', 'constructor', 'toString', '__proto__', 'x', 'constructor', '__proto__')
    expect(op('count', text)).toEqual({
      operation: 'count', nonblank_lines: 7, distinct: 4, total: 4, returned: 4,
      result: [{ line: '__proto__', count: 3 }, { line: 'constructor', count: 2 }, { line: 'toString', count: 1 }, { line: 'x', count: 1 }],
    })
  })

  it('defaults count to the top 20 and honors limit', () => {
    const text = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')
    expect(op('count', text)).toMatchObject({ distinct: 30, total: 30, returned: 20 })
    expect(op('count', text, { limit: '5' })).toMatchObject({ returned: 5 })
    expect(op('sort', text, { limit: 3 }).result).toEqual(['line 0', 'line 1', 'line 2'])
    expect(op('sort', text, { limit: 1e9 })).toMatchObject({ returned: 30 })
  })

  it('filters case-insensitively with original line numbers', () => {
    expect(op('filter', lines('INFO start', '', 'ERROR disk', 'info again', 'error net'), { match: 'Error' })).toEqual({
      operation: 'filter', nonblank_lines: 4, matched: 2, total: 2, returned: 2, result: ['3: ERROR disk', '5: error net'],
    })
  })

  it('applies match as a pre-filter to every operation', () => {
    const text = lines('ERROR b', 'INFO x', 'error a', 'ERROR b')
    expect(op('count', text, { match: 'error' })).toMatchObject({
      nonblank_lines: 4, matched: 3, result: [{ line: 'ERROR b', count: 2 }, { line: 'error a', count: 1 }],
    })
    expect(op('sort', text, { match: 'error' }).result).toEqual(['error a', 'ERROR b', 'ERROR b'])
  })

  it('samples without replacement and shuffles by default (CSPRNG)', () => {
    const input = Array.from({ length: 20 }, (_, i) => `n${i}`)
    const picked = op('sample', input.join('\n'), { limit: 3 })
    expect(picked).toMatchObject({ operation: 'sample', nonblank_lines: 20, total: 3, returned: 3 })
    expect(new Set(picked.result).size).toBe(3)
    for (const value of picked.result) expect(input).toContain(value)
    const orders = new Set<string>()
    for (let i = 0; i < 8; i++) {
      const shuffled = op('Shuffle', input.join('\n')).result as string[]
      expect([...shuffled].sort()).toEqual([...input].sort())
      orders.add(shuffled.join(','))
    }
    expect(orders.size).toBeGreaterThan(1)
    expect(op('sample', 'only', { limit: 5 }).result).toEqual(['only'])
    expect(op('sample', '').result).toEqual([])
  })

  it('accepts lenient operations (readEnum spelling plus synonyms), limits and list input', () => {
    const text = lines('b', 'a', 'b')
    expect(op('Sort Desc', text).operation).toBe('sort_desc')
    expect(op('sort-desc', text).operation).toBe('sort_desc')
    expect(op('SORTS', text).operation).toBe('sort')
    expect(op('UNIQUE', text).operation).toBe('dedupe')
    expect(op('counts', text).operation).toBe('count')
    expect(op('frequencies', text).operation).toBe('count')
    expect(op('grep', text, { match: 'a' }).operation).toBe('filter')
    expect(op('random', text).operation).toBe('sample')
    expect(op('sort', ['b', 'a', 3]).result).toEqual(['3', 'a', 'b'])
    expect(op('sort', text, { limit: '2.9' }).result).toEqual(['a', 'b'])
  })

  // Review fix (regression): transform_text's "sort_lines"/"dedupe_lines" and plain phrasings used to fail.
  it('maps transform_text names, "<op> lines" and common phrasings to an operation', () => {
    const text = lines('b', 'a', 'b')
    const cases: [string, string][] = [
      ['sort_lines', 'sort'], ['Sort Lines', 'sort'], ['dedupe_lines', 'dedupe'], ['count lines', 'count'], ['unique-lines', 'dedupe'],
      ['sort_desc_lines', 'sort_desc'], ['numeric sort', 'sort'], ['sort numerically', 'sort'], ['alphabetical', 'sort'],
      ['natural', 'sort'], ['sort reverse', 'sort_desc'], ['remove duplicates', 'dedupe'], ['histogram', 'count'],
      ['most common', 'count'], ['random sample', 'sample'], ['contains', 'filter'],
    ]
    for (const [operation, expected] of cases) {
      expect(op(operation, text, { match: 'b' }).operation, operation).toBe(expected)
    }
  })

  // Review fix (regression): other names for match/limit were ignored, so the result was silently wrong.
  it('reads the names small models use for match and limit instead of ignoring them', async () => {
    const text = lines('INFO a', 'ERROR b', 'ERROR b', 'INFO c', 'WARN d')
    expect(op('count', text, { pattern: 'error' })).toMatchObject({ matched: 2, result: [{ line: 'ERROR b', count: 2 }] })
    expect(op('filter', text, { query: 'warn' }).result).toEqual(['5: WARN d'])
    expect(op('filter', text, { filter: 'info', match: '' }).result).toEqual(['1: INFO a', '4: INFO c'])
    expect(op('sample', text, { count: 2 })).toMatchObject({ total: 2, returned: 2 })
    expect(op('sort', text, { top: '1' }).result).toEqual(['ERROR b'])
    expect(op('sort', text, { n: 2, limit: 3 }).returned).toBe(3) // the canonical name wins
    expect(await failure('process_lines', { text, operation: 'sort', max: 0 })).toMatch(/"max" must be at least 1/)
  })

  it('rejects bad operations, limits and match with a working example', async () => {
    for (const operation of ['reverse', 'reverse_lines', 'lines', '_lines', 'md5', ...PROTO_KEYS]) {
      expect(await failure('process_lines', { text: 'a', operation })).toMatch(/"operation" must be one of: sort, sort_desc/)
    }
    expect(await failure('process_lines', { text: 'a' })).toMatch(/"operation" is required/)
    expect(await failure('process_lines', { text: 'a', operation: ['sort'] })).toMatch(/"operation" must be one of/)
    expect(await failure('process_lines', { text: 'a', operation: 'filter' })).toMatch(/"match" is required for filter/)
    expect(await failure('process_lines', { text: 'a', operation: 'filter', match: '   ' })).toMatch(/"match" is required/)
    expect(await failure('process_lines', { text: 'a', operation: 'sort', limit: 0 })).toMatch(/"limit" must be at least 1/)
    expect(await failure('process_lines', { text: 'a', operation: 'sort', limit: 'ten' })).toMatch(/"limit" must be a number/)
    expect(await failure('process_lines', { text: 'a', operation: 'filter', match: 'm'.repeat(201) })).toMatch(/"match" is too long/)
    expect(await failure('process_lines', { text: { a: 1 }, operation: 'sort' })).toMatch(/"text" must be a string/)
    expect(await failure('process_lines', { text: [{}], operation: 'sort' })).toMatch(/list of lines/)
  })

  it('enforces 5,000 lines and 200,000 chars before any work, and budgets the output', async () => {
    expect(await failure('process_lines', { text: 'x\n'.repeat(5_001), operation: 'sort' })).toMatch(/5001 lines \(max 5000\)/)
    expect(await failure('process_lines', { text: 'x\r'.repeat(5_001), operation: 'sort' })).toMatch(/5001 lines/)
    expect(await failure('process_lines', { text: Array(5_001).fill('x'), operation: 'sort' })).toMatch(/5001 lines/)
    expect(await failure('process_lines', { text: 'x'.repeat(N + 1), operation: 'sort' })).toMatch(/too long/)
    expect(await failure('process_lines', { text: Array(4).fill('x'.repeat(N / 4)), operation: 'sort' })).toMatch(/too long/)
    expect(op('count', 'x\n'.repeat(5_000))).toMatchObject({ nonblank_lines: 5_000, distinct: 1 })

    const long = Array.from({ length: 3_000 }, (_, i) => `${i} ${'z'.repeat(60)}`).join('\n')
    const result = op('dedupe', long)
    expect(result).toMatchObject({ total: 3_000, truncated: true, hint: 'Narrow with "match" or a smaller "limit".' })
    expect(result.returned > 10 && result.returned < 3_000).toBe(true)
    expect((op('sort', lines('b'.repeat(500), 'a'.repeat(500))).result as string[]).map((l) => l.length)).toEqual([200, 200])
  })

  it('reads "@input" by default and notes through executeToolCall, and redacts secrets', async () => {
    const byDefault = await run('process_lines', { operation: 'dedupe' }, { input: 'a\nb\na' })
    expect(JSON.parse(byDefault.content)).toMatchObject({ result: ['a', 'b'], sources: { text: '@input' } })
    const explicit = await run('process_lines', { operation: 'count', text: '@input' }, { input: 'a\na' })
    expect(JSON.parse(explicit.content)).toMatchObject({ result: [{ line: 'a', count: 2 }], sources: { text: '@input' } })

    const fromNote = await run('process_lines', { text: '@note:Server log', operation: 'count', match: 'error' })
    expect(JSON.parse(fromNote.content)).toMatchObject({
      nonblank_lines: 4, matched: 2, result: [{ line: 'ERROR disk full', count: 1 }, { line: 'error disk full', count: 1 }],
    })
    const proto = await run('process_lines', '{"__proto__":{"operation":"sort"},"toString":1,"operation":"count","text":"a"}')
    expect(JSON.parse(proto.content)).toMatchObject({ operation: 'count', result: [{ line: 'a', count: 1 }] })
    const leak = await run('process_lines', { operation: 'sort' }, { input: `a\n${SECRET}` })
    expect(leak.ok).toBe(true)
    expect(leak.content).not.toContain(SECRET)
  })
})

describe('extract_entities', () => {
  it('finds urls, emails, dates and numbers in one whitespace-token pass', () => {
    const text =
      'Mail <john@Example.com>, see (https://en.wikipedia.org/wiki/Foo_(bar)). On March 5, 2027 and 2026-10-12 ' +
      'we paid $1,200.50 or 15% of 3.5 [x](https://a.com/b?c=1). 2024-02-30 is not a date. mailto:a@b.io'
    expect(call('extract_entities', { text })).toEqual({
      urls: ['https://en.wikipedia.org/wiki/Foo_(bar)', 'https://a.com/b?c=1'],
      emails: ['john@Example.com', 'a@b.io'],
      dates: ['March 5, 2027', '2026-10-12'],
      numbers: ['$1,200.50', '15%', '3.5'],
      counts: { urls: 2, emails: 2, dates: 2, numbers: 3 },
    })
  })

  it('handles URL wrappers, punctuation and case', () => {
    const text =
      '<https://x.org/a> href="https://y.org/b?q=1#top" HTTPS://Z.ORG/C. http://localhost:3000/p, ' +
      "'https://q.org/x' https://w.org/a|b https://nohost http://.bad.com https://a..b"
    expect(call('extract_entities', { text, kinds: ['urls'] }).urls).toEqual([
      'https://x.org/a', 'https://y.org/b?q=1#top', 'HTTPS://Z.ORG/C', 'http://localhost:3000/p', 'https://q.org/x', 'https://w.org/a',
    ])
  })

  it('validates emails and dates strictly and dedupes', () => {
    const text =
      'A@x.com a@X.COM user@localhost a@b x@@y.com Email:ops@corp.io ' +
      '2027-03-05 March 5 2027 5th March 2027 2026/1/9 2026-13-01 2025-02-29 2024-02-29 ' +
      '2026-10-12T09:30:00Z 2026-10-12T25:00 May 2027 1.2.3 -4 +5 −6 .5 1e3 12,34'
    const result = call('extract_entities', { text })
    expect(result.emails).toEqual(['A@x.com', 'ops@corp.io'])
    expect(result.dates).toEqual(['2027-03-05', '2026/1/9', '2024-02-29', '2026-10-12T09:30:00Z'])
    expect(result.counts).toMatchObject({ emails: 2, dates: 4 })
    expect(result.numbers).toEqual(['2027', '-4', '+5', '−6', '.5', '1e3'])
  })

  it('leaves the day and year of a written date as numbers when dates are not requested', () => {
    expect(call('extract_entities', { text: 'Due March 5, 2027.', kinds: ['numbers'] })).toEqual({ numbers: ['5', '2027'], counts: { numbers: 2 } })
  })

  it('accepts lenient kinds: comma string, case, singular/plural, synonyms, "all"', () => {
    const text = 'a@b.io https://x.io 7'
    expect(Object.keys(call('extract_entities', { text, kinds: 'Emails, URL' }))).toEqual(['urls', 'emails', 'counts'])
    expect(call('extract_entities', { text, kinds: ['NUMBER'] })).toEqual({ numbers: ['7'], counts: { numbers: 1 } })
    expect(call('extract_entities', { text, kinds: ['links', 'e-mail', 'Email addresses'] })).toMatchObject({ urls: ['https://x.io'], emails: ['a@b.io'] })
    expect(Object.keys(call('extract_entities', { text, kinds: 'all' }))).toEqual(['urls', 'emails', 'dates', 'numbers', 'counts'])
    expect(Object.keys(call('extract_entities', { text, kinds: [] }))).toEqual(['urls', 'emails', 'dates', 'numbers', 'counts'])
  })

  it('rejects unknown kinds, including prototype names, and oversized text with a working example', async () => {
    for (const kind of ['phones', ...PROTO_KEYS]) expect(await failure('extract_entities', { text: 'x', kinds: [kind] })).toMatch(/Unknown kind/)
    expect(await failure('extract_entities', { text: 'x', kinds: 5 })).toMatch(/"kinds" must be a list/)
    expect(await failure('extract_entities', { text: 'x', kinds: Array(11).fill('urls') })).toMatch(/max 10/)
    expect(await failure('extract_entities', { text: 'a'.repeat(N + 1) })).toMatch(/too long/)
    expect(await failure('extract_entities', { text: Array(5_001).fill('a') })).toMatch(/5001 lines/)
    expect(call('extract_entities', {})).toEqual({ urls: [], emails: [], dates: [], numbers: [], counts: { urls: 0, emails: 0, dates: 0, numbers: 0 } })
  })

  it('caps 50 values per kind with totals, clips values to 200 chars, skips tokens over 2,048', () => {
    const emails = Array.from({ length: 60 }, (_, i) => `user${i}@example.com`).join(' ')
    expect(call('extract_entities', { text: emails, kinds: ['emails'] })).toMatchObject({ counts: { emails: 60 }, truncated: true })
    expect(call('extract_entities', { text: emails, kinds: ['emails'] }).emails).toHaveLength(50)

    const longUrl = `https://example.com/${'p'.repeat(2_028)}`
    expect(longUrl.length).toBe(2_048)
    const clipped = call('extract_entities', { text: `${longUrl} https://example.com/${'q'.repeat(2_029)}`, kinds: 'urls' })
    expect(clipped.urls).toEqual([`${longUrl.slice(0, 199)}…`])
    expect(clipped.skipped_long_tokens).toBe(1)
  })

  it('treats prototype-named tokens as plain text', () => {
    const result = call('extract_entities', { text: `${PROTO_KEYS.join(' ')} __proto__@x.io constructor@toString.com _em@x.io_ *b@x.io*` })
    expect(result.emails).toEqual(['__proto__@x.io', 'constructor@toString.com', 'em@x.io', 'b@x.io'])
    expect(result.numbers).toEqual([])
    expect(({} as Json).urls).toBeUndefined()
  })

  // Review fixes (regressions): each case below returned a wrong value or nothing before.
  it('never turns URL userinfo or other "x:" prefixes into an email, but keeps mailto:/Email:/To:', () => {
    const text = 'https://user:hunter2@db.example.com redis://:s3cret@cache.example.com postgres://u:p4ss@pg.example.com:5432/app ' +
      'ftp://anon@files.example.com user:topsecret@host.example.com x=admin:pw@example.org mailto:a@b.io Email:c@d.io To:e@f.io <mailto:g@h.io>'
    const result = call('extract_entities', { text, kinds: ['emails', 'urls'] })
    expect(result.emails).toEqual(['a@b.io', 'c@d.io', 'e@f.io', 'g@h.io'])
    expect(result.urls).toEqual([])
    expect(JSON.stringify(result)).not.toMatch(/hunter2|s3cret|p4ss|topsecret|pw@/)
  })

  it('finds emails and dates glued by , ; = | quotes or brackets (CSV, key=value, compact JSON), but never splits numbers', () => {
    const text = 'a@b.io;c@d.io e@f.io,g@h.io Name<x@y.io> mailto:z@w.io?subject=hi user=k@l.io ' +
      'row,m@n.io,2026-10-12,5 ts=2026-10-13T09:30:00Z|status=500 {"to":"p@q.io","at":"2026-10-14","url":"https://x.io/?cc=r@s.io"} ' +
      '12,34 x=7 o\'brien@x.io'
    expect(call('extract_entities', { text })).toEqual({
      urls: ['https://x.io/?cc=r@s.io'],
      emails: ['a@b.io', 'c@d.io', 'e@f.io', 'g@h.io', 'x@y.io', 'z@w.io', 'k@l.io', 'm@n.io', 'p@q.io', 'r@s.io'],
      dates: ['2026-10-12', '2026-10-13T09:30:00Z', '2026-10-14'],
      numbers: [],
      counts: { urls: 1, emails: 10, dates: 3, numbers: 0 },
    })
    // Requested kinds only: a glued email is not reported when only dates are wanted.
    expect(call('extract_entities', { text: 'a@b.io,2026-10-12', kinds: 'dates' })).toEqual({ dates: ['2026-10-12'], counts: { dates: 1 } })
  })

  it('enforces the email local (64) and domain (253) limits, UTC offsets, ports and control chars', () => {
    // Every label is at most 63 chars, so only the total domain length differs.
    const domain = (last: number) => `${'d'.repeat(63)}.${'d'.repeat(63)}.${'d'.repeat(63)}.${'d'.repeat(last)}.io`
    expect([domain(58).length, domain(59).length]).toEqual([253, 254])
    const emails = call('extract_entities', {
      text: `a@${domain(58)} b@${domain(59)} ${'l'.repeat(64)}@x.io ${'l'.repeat(65)}@y.io`, kinds: 'emails',
    }).emails as string[]
    // a@ (255 chars) is kept and clipped to 200; the 254-char domain and the 65-char local part are rejected.
    expect(emails.map((e) => e.length)).toEqual([200, 69])
    expect(emails[0]!.startsWith('a@ddd')).toBe(true)

    expect(call('extract_entities', { text: '2026-10-12T09:30+99:99 2026-10-12T09:30-24:00 2026-10-12T09:30+05:30 2026-10-12T09:30-0800', kinds: 'dates' }).dates)
      .toEqual(['2026-10-12T09:30+05:30', '2026-10-12T09:30-0800'])
    // Century leap rules and the 1000-9999 year range, ISO and written.
    expect(call('extract_entities', { text: '1900-02-29 2000-02-29 0999-01-01 Feb 29, 2100 29 Feb 2400', kinds: 'dates' }).dates)
      .toEqual(['2000-02-29', '29 Feb 2400'])
    expect(call('extract_entities', { text: 'http://localhost:65535/a http://localhost:65536/b https://x.io:99999 https://x.io:443/', kinds: 'urls' }).urls)
      .toEqual(['http://localhost:65535/a', 'https://x.io:443/'])
    expect(call('extract_entities', { text: 'https://x.io/a\u0001b https://y.io/\u007fz', kinds: 'urls' }).urls).toEqual(['https://x.io/a', 'https://y.io/'])
  })

  it('accepts kinds glued into one item ("urls and emails", "url;email") and timestamp/datetime for dates', () => {
    const text = 'a@b.io https://x.io 2026-10-12 7'
    const keys = (kinds: unknown) => Object.keys(call('extract_entities', { text, kinds }))
    expect(keys(['urls, emails'])).toEqual(['urls', 'emails', 'counts'])
    expect(keys('url;email')).toEqual(['urls', 'emails', 'counts'])
    expect(keys(['urls and emails', 'numbers'])).toEqual(['urls', 'emails', 'numbers', 'counts'])
    expect(keys('emails or links')).toEqual(['urls', 'emails', 'counts'])
    expect(keys(['timestamps'])).toEqual(['dates', 'counts'])
    expect(keys(['Datetime'])).toEqual(['dates', 'counts'])
    expect(keys('all kinds')).toEqual(['urls', 'emails', 'dates', 'numbers', 'counts'])
  })

  it('still rejects glued kinds with an unknown part', async () => {
    for (const kinds of [['phone numbers'], 'urls and phones', ['and'], [';;']]) {
      expect(await failure('extract_entities', { text: 'x', kinds })).toMatch(/Unknown kind/)
    }
  })

  it('reads "@input" by default and redacts secrets inside found values', async () => {
    const outcome = await run('extract_entities', { kinds: ['urls'] }, { input: `see https://x.io/?key=${SECRET} now` })
    expect(outcome.ok).toBe(true)
    expect(outcome.content).not.toContain(SECRET)
    // "@input" is redacted before extraction, so the URL ends at the marker
    // (brackets are not URL characters): no secret, no secret prefix.
    expect(JSON.parse(outcome.content)).toMatchObject({ urls: ['https://x.io/?key='], sources: { text: '@input' } })
    const proto = await run('extract_entities', '{"__proto__":{"kinds":["urls"]},"constructor":"x","text":"a@b.io"}')
    expect(JSON.parse(proto.content)).toMatchObject({ emails: ['a@b.io'], counts: { urls: 0, emails: 1 } })
  })
})

describe('adversarial max-size input through executeToolCall with "@input" (< 50 ms each)', () => {
  const longLines = (line: string) => `${line}\n`.repeat(5_000)
  const shared: [string, string][] = [
    ['"a" x N (a single 200k token)', 'a'.repeat(N)],
    ['"a." x N/2', 'a.'.repeat(N / 2)],
    ['"a@" x N/2', 'a@'.repeat(N / 2)],
    ['"@" x N', '@'.repeat(N)],
    ['"1," x N/2', '1,'.repeat(N / 2)],
    ['"http://" x N/7', 'http://'.repeat(Math.floor(N / 7))],
    ['a single 200k URL token', `https://example.com/${'a'.repeat(N - 20)}`],
    ['5,000 long lines', longLines('x'.repeat(39))],
  ]

  it('extract_entities stays linear', async () => {
    const cases: [string, string][] = [
      ...shared,
      ['5,000 long lines of entities', longLines('a@b.co https://x.io/p 2026-10-12 1,234')],
      ['"a " x N/2', 'a '.repeat(N / 2)],
      ['"1 " x N/2', '1 '.repeat(N / 2)],
      ['near-emails', `${'a.'.repeat(30)}@${'b-'.repeat(30)} `.repeat(Math.floor(N / 122))],
      ['2,048-char @ tokens', `${'a@'.repeat(1_024)} `.repeat(97)],
      ['2,048-char digit tokens', `${'1,'.repeat(1_024)} `.repeat(97)],
      ['2,048-char url tokens', `https://x.com/${'a'.repeat(2_034)} `.repeat(97)],
      ['2,048-char "http://" tokens', `${'http://'.repeat(292)} `.repeat(97)],
      ['2,048-char paren tokens', `${')'.repeat(1_024)}${'('.repeat(1_024)} `.repeat(97)],
      ['written dates', 'March 5, 2027 '.repeat(Math.floor(N / 14))],
      ['iso-ish', '2026-10-12T '.repeat(Math.floor(N / 12))],
      // Glued values: every token is split once more on , ; = | and friends.
      ['glued emails', `${'a@b.io,'.repeat(292)} `.repeat(97)],
      ['glued distinct emails', Array.from({ length: 97 }, (_, t) => `${Array.from({ length: 140 }, (_, i) => `u${t}x${i}@x.io`).join(';').slice(0, 2_000)} `).join('')],
      ['glued dates', `${'2026-10-12,'.repeat(186)} `.repeat(97)],
      ['glued near-dates', `${'2026-13-12T'.repeat(186)} `.repeat(97)],
      ['glued near-emails', `${`${'a.'.repeat(30)}@${'b-'.repeat(30)},`.repeat(16)} `.repeat(Math.floor(N / 1_953))],
      ['glued url query', `https://x.com/?${'to=a@b.io&'.repeat(200)} `.repeat(97)],
      ['glued 6-char parts', `${'aaaaaa,'.repeat(292)} `.repeat(97)],
      ['compact JSON lines', '{"user":"a@b.io","at":"2026-10-12T09:30:00Z","n":5,"url":"https://x.io/p"}\n'.repeat(2_500).slice(0, N)],
    ]
    for (const [label, input] of cases) {
      expect(input.length, label).toBeLessThanOrEqual(N)
      const result = await expectFast('extract_entities', { text: '@input' }, input, label)
      expect(result.error, label).toBeUndefined()
    }
  })

  it('process_lines stays linear for every operation', async () => {
    const cases: [string, string][] = [
      ...shared,
      ['shared prefixes', Array.from({ length: 5_000 }, (_, i) => 'x'.repeat(30) + ((i * 7_919) % 5_000)).join('\n')],
      ['numbers', Array.from({ length: 5_000 }, (_, i) => String(((i * 7_919) % 5_000) / 7 - 300)).join('\n')],
      ['zero-padded', Array.from({ length: 5_000 }, (_, i) => '0'.repeat(30) + ((i * 7_919) % 5_000)).join('\n')],
      ['many digit runs', Array.from({ length: 5_000 }, (_, i) => `a1b2c3d4e5f6g7h8i9j${(i * 31) % 97}k${i}`).join('\n')],
      ['long digit lines', Array.from({ length: 100 }, (_, i) => `${i}${'9'.repeat(1_990)}`).join('\n')],
      ['blank lines', '\n'.repeat(4_999)],
    ]
    for (const [label, input] of cases) {
      expect(input.length, label).toBeLessThanOrEqual(N)
      for (const operation of ['sort', 'sort_desc', 'dedupe', 'count', 'sample']) {
        const result = await expectFast('process_lines', { text: '@input', operation }, input, `${label} ${operation}`)
        expect(result.error, `${label} ${operation}`).toBeUndefined()
      }
      await expectFast('process_lines', { text: '@input', operation: 'filter', match: `${'a'.repeat(199)}b` }, input, `${label} filter`)
    }
  })
})

// Review fix (regression): values used to be clipped before executeToolCall redacted them, so a
// key cut by the 200-char clip leaked its first chars ("sk-or-v1-0123…") past both redaction passes.
describe('redaction happens before clipping', () => {
  const key = 'sk-or-v1-0123456789abcdef0123456789abcdef'
  const keyStore = { ...store, endpointKeys: { ep_or: key }, notes: [note('note_keys', 'Keys', `${'x'.repeat(185)} ${key}\nhttps://x.io/${'p'.repeat(170)}?k=${key}`)] } as unknown as WorkspaceStore

  it('never returns a clipped prefix of a vault key from either tool', async () => {
    for (const [name, args] of [['process_lines', { text: '@note:Keys', operation: 'sort' }], ['extract_entities', { text: '@note:Keys', kinds: 'urls' }]] as const) {
      const outcome = await run(name, args, { store: keyStore })
      expect(outcome.ok, outcome.content).toBe(true)
      expect(outcome.content, name).not.toContain('sk-or-v1-0')
      // Note text is redacted before the handler: lines keep the marker, and a
      // URL ends where the redacted key began.
      if (name === 'process_lines') expect(outcome.content, name).toContain('[redacted]')
      else expect(outcome.content, name).toContain('?k="')
    }
  })

  it('clips without leaving half a surrogate pair', () => {
    const line = `${'a'.repeat(198)}😀tail`
    expect(call('process_lines', { text: line, operation: 'dedupe' }).result).toEqual([`${'a'.repeat(198)}…`])
    const url = `https://x.io/${'b'.repeat(185)}😀tail`
    expect(call('extract_entities', { text: url, kinds: 'urls' }).urls).toEqual([`https://x.io/${'b'.repeat(185)}…`])
  })
})

describe('process_lines and extract_entities through executeToolCall', () => {
  const bad: Json[] = [
    {},
    { text: null, operation: null, kinds: null },
    { text: 5, operation: 5, kinds: 5, limit: 'x', match: 5 },
    { text: [], operation: [], kinds: [] },
    { text: { a: 1 }, operation: { a: 1 }, kinds: { a: 1 } },
    Object.fromEntries(PROTO_KEYS.map((k) => [k, k])),
  ]

  it('never throws, never returns undefined content, stays under 3,600 chars, and errors carry an example', async () => {
    for (const name of TOOLS) {
      for (const args of bad) {
        const outcome = await run(name, args, { input: 'Some input. a@b.io 2026-10-12' })
        expect(typeof outcome.content, name).toBe('string')
        expect(outcome.content.length, name).toBeLessThan(3_600)
        if (!outcome.ok) expect(outcome.content, `${name} ${JSON.stringify(args)}`).toMatch(/Example: \{.*\}$/)
      }
      const proto = await run(name, '{"__proto__":{"text":"x"},"constructor":"y","toString":"z"}', { input: 'line' })
      expect(typeof proto.content).toBe('string')
    }
  })
})
