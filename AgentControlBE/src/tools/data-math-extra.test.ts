// Registry facade first: it must load standalone (see registry.test.ts).
import { executeToolCall } from '../tools.js'
import { describe, expect, it } from 'vitest'
import type { WorkspaceStore } from '../store.js'
import { dataTools } from './data.js'
import { mathTools } from './math.js'
import type { ToolContext } from './types.js'

/** A vault value that matches none of redact.ts's key patterns, so only the exact-value pass can catch it. */
const SECRET = 'Zq7-endpoint-secret-91'
const entries = [...dataTools, ...mathTools]
type Json = Record<string, any>

function context(): ToolContext {
  return { store: { endpointKeys: { ep: SECRET }, notes: [] } as unknown as WorkspaceStore,
    agentId: 'agent', runId: 'run', input: '', allowed: new Set(entries.map((entry) => entry.name)),
    now: () => new Date('2026-10-12T00:00:00Z'), timeZone: 'UTC', writes: { count: 0 } }
}
function run(name: string, args: Json): Json { return entries.find((entry) => entry.name === name)!.handler(args, context()) as Json }
const size = (value: unknown) => JSON.stringify(value).length
/** Best of three runs under the 1,000 ms bound (the 5s tool timeout cannot interrupt synchronous code). */
function fast(name: string, args: Json): Json {
  let best = Infinity
  let result: Json = {}
  for (let i = 0; i < 3; i++) {
    const start = performance.now()
    try { result = run(name, args) } catch (err) { result = { error: (err as Error).message } }
    best = Math.min(best, performance.now() - start)
  }
  expect(best, `${name}: ${best.toFixed(1)}ms`).toBeLessThan(1_000)
  return result
}

describe('json_query paths: wildcards, negative indices, quoted keys', () => {
  const json = JSON.stringify({
    items: [{ name: 'a', tags: ['x', 'y'] }, { name: 'b', tags: [] }, { id: 3, tags: ['z'] }],
    'odd key': { 'a"b': 1, 'café': 2, "it's": 3, '-1': 'minus' },
    meta: { count: 3, owner: null },
  })
  it('fans [*] and .* out over array items and own object values, counting matches and misses', () => {
    expect(run('json_query', { json, path: 'items[*].name' })).toEqual({ found: true, path: 'items[*].name', count: 2, missing: 1, values: ['a', 'b'] })
    expect(run('json_query', { json, path: '$.items.*.tags[*]' })).toMatchObject({ found: true, count: 3, values: ['x', 'y', 'z'] })
    expect(run('json_query', { json, path: 'meta[*]' })).toMatchObject({ count: 2, values: [3, null] })
    expect(run('json_query', { json: '[{"a":1},{"a":2}]', path: '[*].a' })).toMatchObject({ count: 2, values: [1, 2] })
  })
  it('treats a wildcard over a scalar, null or missing value as no match, not an error', () => {
    for (const path of ['meta.count[*]', 'meta.owner[*]', 'nope[*]', 'items[*].name[*]']) {
      const result = run('json_query', { json, path })
      expect(result, path).toMatchObject({ found: false, count: 0, values: [] })
      expect(result.missing, path).toBeGreaterThan(0)
    }
    expect(run('json_query', { json, path: 'items[*].tags[5]' })).toMatchObject({ found: false, count: 0, missing: 3 })
  })
  it('allows at most two wildcards and caps listed values while counting all of them', () => {
    expect(() => run('json_query', { json, path: 'items[*].tags[*][*]' })).toThrow(/at most 2 \[\*\].*Example:/)
    const many = JSON.stringify({ rows: Array.from({ length: 1100 }, (_, i) => ({ id: i, label: 'r'.repeat(20) })) })
    const ids = run('json_query', { json: many, path: 'rows[*].id' })
    expect(ids).toMatchObject({ found: true, count: 1100, shown: 100 })
    expect(ids.values).toEqual(Array.from({ length: 100 }, (_, i) => i))
    const rows = run('json_query', { json: many, path: 'rows[*]' })
    expect(rows.count).toBe(1100)
    expect(rows.truncated).toBe(true)
    expect(rows.shown).toBe(rows.values.length)
    expect(rows.values.length).toBeLessThan(100)
    expect(size(rows)).toBeLessThanOrEqual(3500)
  })
  it('counts negative indices from the end of arrays and treats them as keys on objects', () => {
    expect(run('json_query', { json, path: 'items[-1].id' })).toMatchObject({ found: true, value: 3 })
    expect(run('json_query', { json, path: 'items[-3].name' }).value).toBe('a')
    expect(run('json_query', { json, path: 'items[-4]' })).toEqual({ found: false, path: 'items[-4]' })
    expect(run('json_query', { json, path: 'items[0].tags[-1]' }).value).toBe('y')
    expect(run('json_query', { json, path: '["odd key"][-1]' }).value).toBe('minus')
    expect(run('json_query', { json, path: 'items[-99999999999999999999]' }).found).toBe(false)
    for (const path of ['items[-0]', 'items[-01]', 'items[- 1]']) expect(() => run('json_query', { json, path }), path).toThrow(/Example:/)
  })
  it('reads bracket-quoted keys with JSON escapes, or single quotes with backslash escapes', () => {
    expect(run('json_query', { json, path: '["odd key"]["a\\"b"]' }).value).toBe(1)
    expect(run('json_query', { json, path: '$["odd key"]["caf\\u00e9"]' }).value).toBe(2)
    expect(run('json_query', { json, path: "['odd key']['it\\'s']" }).value).toBe(3)
    expect(run('json_query', { json, path: 'meta["count"]' }).value).toBe(3)
    expect(run('json_query', { json, path: '["odd key"].nope' }).found).toBe(false)
    for (const path of ['["odd key"', '["unclosed]', '["bad \\q escape"]', '[odd key]', '["a"]x', '[\'a\'"]']) {
      expect(() => run('json_query', { json, path }), path).toThrow(/Example:/)
    }
  })
  it('keeps the original path forms and the no-path default', () => {
    expect(run('json_query', { json, path: '$.items[0].name' })).toEqual({ found: true, path: '$.items[0].name', type: 'string', value: 'a' })
    expect(run('json_query', { json, path: '/odd key/a"b' }).value).toBe(1)
    expect(run('json_query', { json: '{"0":"zero"}', path: '[0]' }).value).toBe('zero')
    expect(run('json_query', { json: '[1,2]' })).toEqual({ found: true, path: '', type: 'array', length: 2, value: [1, 2] })
  })
})

describe('json_query own properties only', () => {
  const json = '{"__proto__":{"polluted":true,"list":[1,2]},"constructor":{"name":"own"},"plain":{"a":1}}'
  it('reads own "__proto__"/"constructor" keys and never reaches the prototype', () => {
    expect(run('json_query', { json, path: '__proto__.list[-1]' }).value).toBe(2)
    expect(run('json_query', { json, path: '["__proto__"][*]' })).toMatchObject({ count: 2, values: [true, [1, 2]] })
    expect(run('json_query', { json, path: '[*]' }).count).toBe(3)
    expect(run('json_query', { json, path: 'constructor.name' }).value).toBe('own')
    for (const path of ['plain.constructor', 'plain.toString', 'plain["__proto__"]', 'plain.hasOwnProperty[*]', '__proto__.list.length', '__proto__.list["length"]']) {
      expect(run('json_query', { json, path }).found, path).toBe(false)
    }
    expect(run('json_query', { json: '{"a":{"b":1}}', path: 'a.constructor[*]' })).toMatchObject({ found: false, count: 0 })
    expect(({} as Json).polluted).toBeUndefined()
  })
  it('lists own keys in shapes, including "__proto__", and no inherited ones', () => {
    const shape = run('json_query', { json, shape: true }).shape
    expect(Object.keys(shape.keys)).toEqual(['__proto__', 'constructor', 'plain'])
    expect(Object.hasOwn(shape.keys, '__proto__')).toBe(true)
    expect(shape.keys.__proto__).toMatchObject({ type: 'object', key_count: 2, keys: { polluted: 'boolean', list: 'array(2)' } })
    expect(Object.keys(shape.keys.plain.keys)).toEqual(['a'])
    expect(({} as Json).polluted).toBeUndefined()
  })
})

describe('json_query shape', () => {
  const json = JSON.stringify({
    name: 'atlas', tags: ['a', 'b'], owner: { id: 7, profile: { email: 'x@y.z' }, roles: ['admin'] },
    items: [{ sku: 'a', qty: 1 }, { sku: 'b', qty: null, extra: { deep: true } }, 5],
  })
  it('summarizes types, keys and array lengths two levels deep instead of returning values', () => {
    const result = run('json_query', { json, shape: true })
    expect(result).toMatchObject({ found: true, path: '', type: 'object' })
    expect(result.value).toBeUndefined()
    expect(result.shape).toEqual({
      type: 'object', key_count: 4,
      keys: {
        name: 'string',
        tags: { type: 'array', length: 2, item_types: { string: 2 } },
        owner: { type: 'object', key_count: 3, keys: { id: 'number', profile: 'object(1 keys)', roles: 'array(1)' } },
        items: { type: 'array', length: 3, item_types: { object: 2, number: 1 }, item_keys: { sku: 'string', qty: 'number|null', extra: 'object' } },
      },
    })
  })
  it('shapes the value at a path, wildcard matches, scalars and empty containers', () => {
    expect(run('json_query', { json, path: 'items', shape: 'yes' })).toMatchObject({ found: true, type: 'array', length: 3, shape: { type: 'array', length: 3 } })
    expect(run('json_query', { json, path: 'items[*].sku', shape: true })).toEqual({
      found: true, path: 'items[*].sku', count: 2, missing: 1, shape: { type: 'array', length: 2, item_types: { string: 2 } },
    })
    expect(run('json_query', { json, path: 'name', shape: true }).shape).toEqual({ type: 'string', length: 5 })
    expect(run('json_query', { json: 'null', shape: true }).shape).toEqual({ type: 'null' })
    expect(run('json_query', { json: '[]', shape: true }).shape).toEqual({ type: 'array', length: 0 })
    expect(run('json_query', { json: '{}', shape: true }).shape).toEqual({ type: 'object', key_count: 0, keys: {} })
    expect(run('json_query', { json, path: 'missing', shape: true })).toEqual({ found: false, path: 'missing' })
  })
  it('stays bounded for wide, deep and escape-heavy documents', () => {
    const wide = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`key_${i}`, { n: i }]))
    const shape = run('json_query', { json: JSON.stringify(wide), shape: true })
    expect(shape.shape).toMatchObject({ type: 'object', key_count: 1000, more_keys: 960 })
    expect(shape.shape.more_keys).toBeGreaterThan(0)
    expect(size(shape)).toBeLessThanOrEqual(3500)

    let deep: unknown = 'bottom'
    for (let i = 0; i < 23; i++) deep = { level: deep }
    expect(run('json_query', { json: JSON.stringify(deep), shape: true }).shape).toEqual({
      type: 'object', key_count: 1, keys: { level: { type: 'object', key_count: 1, keys: { level: 'object(1 keys)' } } },
    })
    expect(run('json_query', { json: JSON.stringify(deep), path: 'level.'.repeat(22) + 'level' }).value).toBe('bottom')

    const escapes = Object.fromEntries(Array.from({ length: 100 }, (_, i) => ['"\\'.repeat(40) + i, { ['\n'.repeat(50) + i]: i }]))
    const heavy = run('json_query', { json: JSON.stringify(escapes), shape: true })
    expect(heavy.shape).toMatchObject({ key_count: 100, more_keys: 90 })
    expect(size(heavy)).toBeLessThanOrEqual(3500)
    // Keys clipped to the same 60-char prefix stay distinct instead of overwriting each other.
    const clipped = Object.keys(heavy.shape.keys)
    expect(clipped).toHaveLength(10)
    expect(clipped[1]).toBe(`${clipped[0]} #2`)
    const items = run('json_query', { json: JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ ['k'.repeat(50) + i]: i }))), shape: true })
    expect(items.shape.more_item_keys).toBe(true)
    expect(size(items)).toBeLessThanOrEqual(3500)
  })
})

describe('json_query bounds and redaction', () => {
  it('answers pathological documents and paths well under the bound', () => {
    const flat = JSON.stringify(Array.from({ length: 9_999 }, (_, i) => i % 7))
    expect(fast('json_query', { json: flat, path: '[*]' })).toMatchObject({ count: 9_999, shown: 100 })
    expect(fast('json_query', { json: flat, shape: true }).shape).toEqual({ type: 'array', length: 9_999, item_types: { number: 9_999 } })
    const grid = JSON.stringify(Array.from({ length: 70 }, () => Array.from({ length: 70 }, (_, i) => ({ i: i % 10 }))))
    expect(grid.length).toBeLessThanOrEqual(50_000)
    expect(fast('json_query', { json: grid, path: '[*][*].i' })).toMatchObject({ count: 4_900, shown: 100 })
    expect(fast('json_query', { json: grid, path: '[*][-1]', shape: true })).toMatchObject({ count: 70, shape: { length: 70, item_keys: { i: 'number' } } })
    const nested = '['.repeat(24) + '1' + ']'.repeat(24)
    expect(fast('json_query', { json: nested, path: '[0]'.repeat(23) + '[-1]' }).value).toBe(1)
    expect(fast('json_query', { json: '{"a":1}', path: '["' + '\\'.repeat(997) }).error).toMatch(/Example:/)
    expect(fast('json_query', { json: '{"a":1}', path: '["' + 'a'.repeat(996) + '"' }).error).toMatch(/Example:/)
    expect(fast('json_query', { json: '{"a":1}', path: 'a'.repeat(1000) }).found).toBe(false)
    expect(fast('json_query', { json: '{"a":1}', path: 'a' + '.a'.repeat(32) }).error).toMatch(/32 segments.*Example:/)
    expect(fast('json_query', { json: '{"a":1}', path: '/a'.repeat(33) }).error).toMatch(/32 segments.*Example:/)
  })
  it('redacts secrets before fitJson clips long strings', async () => {
    // Twelve 1,600-char strings clip to ~200 chars, cutting through the keys near offset 170-200.
    const leaky = (lead: number) => `${'x'.repeat(lead)}${SECRET} sk-${'A'.repeat(40)}`.padEnd(1600, 'y')
    const doc = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, leaky(170 + i * 2)]))
    const cases = [{ json: JSON.stringify(doc) }, { json: JSON.stringify({ list: [doc] }), path: 'list[*]' }]
    const handler = entries.find((entry) => entry.name === 'json_query')!.handler
    for (const args of cases) {
      // Without a store nothing is redacted: the clip leaves a key prefix no output pattern can match.
      expect(JSON.stringify(handler(args, { ...context(), store: undefined } as unknown as ToolContext))).toMatch(/sk-A{1,15}…/)
      const text = JSON.stringify(run('json_query', args))
      expect(text).toContain('truncated')
      expect(text).not.toMatch(/Zq7|sk-A/)
    }
    const outcome = await executeToolCall({ id: 'call', name: 'json_query', arguments: JSON.stringify(cases[1]) }, context())
    expect(outcome.ok).toBe(true)
    expect(outcome.content).not.toMatch(/Zq7|sk-A/)
  })
})

describe('csv_summary column stats', () => {
  const csv = 'region,sales,rep,id\nEast,10,ann,1\nWest,5,bob,2\nEast,7,ann,3\nNorth,x,cy,4\nEast,3,bob,5\nWest,,dee,6\n'
  it('adds distinct counts, medians and top values without changing existing fields', () => {
    const { columns } = run('csv_summary', { csv })
    expect(columns[0]).toEqual({
      index: 1, name: 'region', blank: 0, numeric_count: 0, nonnumeric_count: 6, distinct: 3,
      top_values: [{ value: 'East', count: 3 }, { value: 'West', count: 2 }, { value: 'North', count: 1 }],
    })
    expect(columns[1]).toEqual({
      index: 2, name: 'sales', blank: 1, numeric_count: 4, nonnumeric_count: 1, distinct: 5,
      min: 3, max: 10, sum: 25, mean: 6.25, median: 6,
    })
    expect(columns[2].top_values).toEqual([{ value: 'ann', count: 2 }, { value: 'bob', count: 2 }, { value: 'cy', count: 1 }])
    expect(columns[3]).toMatchObject({ distinct: 6, median: 3.5 })
    expect(columns[3].top_values).toBeUndefined()
  })
  it('keeps medians finite near the overflow limit and handles empty input', () => {
    expect(run('csv_summary', { csv: 'n\n1e308\n1.5e308' }).columns[0]).toMatchObject({ sum: null, mean: null, median: 1.25e308 })
    expect(run('csv_summary', { csv: 'n\n-1e308\n1e308' }).columns[0]).toMatchObject({ sum: 0, median: 0 })
    expect(run('csv_summary', { csv: 'n\n5\n1\n3' }).columns[0].median).toBe(3)
    expect(run('csv_summary', { csv: '' })).toEqual({ rows: 0, column_count: 0, has_header: true, inconsistent_rows: 0, columns: [], sample: [], sampled: false })
    expect(run('csv_summary', { csv: 'a,b\n' }).columns[0]).toEqual({ index: 1, name: 'a', blank: 0, numeric_count: 0, nonnumeric_count: 0, distinct: 0 })
  })
})

describe('csv_summary group_by', () => {
  const csv = 'region,sales,rep\nEast,10,ann\nWest,5,bob\nEast,7,ann\nNorth,x,cy\nEast,3\nWest\n'
  it('groups rows by a column, largest first, with per-group sums and skipped cells', () => {
    const result = run('csv_summary', { csv, group_by: 'region', sum_column: 'sales' })
    expect(result).toMatchObject({
      rows: 6, inconsistent_rows: 2, group_by: 'region', sum_column: 'sales', group_count: 3, sum_skipped: 2,
      groups: [{ key: 'East', rows: 3, sum: 20 }, { key: 'West', rows: 2, sum: 5 }, { key: 'North', rows: 1, sum: 0 }],
    })
    expect(result.other).toBeUndefined()
    expect(result.columns).toHaveLength(3)
  })
  it('accepts camelCase aliases, loose names, positions and headerless column names', () => {
    // Ties keep first appearance; short rows fall into the blank ("") group.
    const groups = [{ key: 'ann', rows: 2 }, { key: '', rows: 2 }, { key: 'bob', rows: 1 }, { key: 'cy', rows: 1 }]
    expect(run('csv_summary', { csv, groupBy: ' REP ' })).toMatchObject({ group_by: 'rep', group_count: 4, groups })
    expect(run('csv_summary', { csv, group_by: 3 }).groups).toEqual(groups)
    expect(run('csv_summary', { csv: '1;x\n2;y\n3;x', delimiter: ';', has_header: false, groupBy: 'column_2', sumColumn: 'column_1' }))
      .toMatchObject({ group_by: 'column_2', groups: [{ key: 'x', rows: 2, sum: 4 }, { key: 'y', rows: 1, sum: 2 }] })
    expect(run('csv_summary', { csv, group_by: 'region', groupBy: 'rep' }).group_by).toBe('region')
    expect(run('csv_summary', { csv, group_by: '  ' }).group_by).toBeUndefined()
  })
  it('lists at most 20 groups plus the total count and the remainder', () => {
    const lines = ['k,v', ...Array.from({ length: 30 }, (_, i) => Array.from({ length: i < 5 ? 3 : 1 }, () => `g${i},2`)).flat()]
    const result = run('csv_summary', { csv: lines.join('\n'), group_by: 'k', sum_column: 'v' })
    expect(result.group_count).toBe(30)
    expect(result.groups).toHaveLength(20)
    expect(result.groups.slice(0, 6)).toEqual([...[0, 1, 2, 3, 4].map((i) => ({ key: `g${i}`, rows: 3, sum: 6 })), { key: 'g5', rows: 1, sum: 2 }])
    expect(result.other).toEqual({ groups: 10, rows: 10, sum: 20 })
  })
  it('totals sum_column without group_by', () => {
    expect(run('csv_summary', { csv, sum_column: 'sales' })).toMatchObject({ sum_column: 'sales', sum_total: 25, sum_skipped: 2 })
    expect(run('csv_summary', { csv: 'n\n1e308\n1e308', sum_column: 'n' }).sum_total).toBeNull()
    expect(run('csv_summary', { csv: 'k,n\na,1e308\na,1e308', group_by: 'k', sum_column: 'n' }).groups).toEqual([{ key: 'a', rows: 2, sum: null }])
  })
  it('rejects unknown and non-numeric columns with the columns to choose from', () => {
    expect(() => run('csv_summary', { csv, group_by: 'country' })).toThrow(/No column "country" for "group_by". Columns: "region", "sales", "rep".*Example:.*"group_by":"region"/)
    expect(() => run('csv_summary', { csv, group_by: 'region', sum_column: 'revenue' })).toThrow(/No column "revenue" for "sum_column".*"sum_column":"sales"/)
    expect(() => run('csv_summary', { csv, group_by: 'region', sum_column: 'rep' })).toThrow(/"rep" has no numeric values. Numeric columns: "sales".*Example:/)
    expect(() => run('csv_summary', { csv: 'a,b\nx,y', sumColumn: 'b' })).toThrow(/Numeric columns: none.*Example:/)
    expect(() => run('csv_summary', { csv: '', group_by: 'region' })).toThrow(/the CSV has no columns.*Example:/)
    expect(() => run('csv_summary', { csv, group_by: 'x'.repeat(201) })).toThrow(/max 200.*Example:/)
    expect(run('csv_summary', { csv: 'region,sales\n', group_by: 'region', sum_column: 'sales' })).toMatchObject({ group_count: 0, groups: [] })
  })
  it('stays bounded and fast for the largest accepted CSV', () => {
    const header = Array.from({ length: 50 }, (_, i) => `c${i}`).join(',')
    const body = Array.from({ length: 1000 }, (_, r) => Array.from({ length: 50 }, (_, c) => (c === 0 ? `id${r}` : String((r * c) % 97))).join(','))
    const csvText = [header, ...body].join('\n')
    expect(csvText.length).toBeLessThanOrEqual(50_000 * 4)
    const result = fast('csv_summary', { csv: csvText.slice(0, 50_000).replace(/\n[^\n]*$/, ''), group_by: 'c0', sum_column: 'c1' })
    expect(result.group_count).toBeGreaterThan(20)
    expect(result.groups.length).toBeLessThanOrEqual(20)
    expect(size(result)).toBeLessThanOrEqual(3500)
  })
  it('redacts secrets before clipping top values and group keys', () => {
    const value = `${'z'.repeat(50)}${SECRET}`
    const result = run('csv_summary', { csv: `k,n\n${value},1\n${value},2\nb,3`, group_by: 'k' })
    expect(result.columns[0].top_values[0].count).toBe(2)
    expect(result.groups[0].rows).toBe(2)
    expect(JSON.stringify(result)).not.toMatch(/Zq7/)
  })
})

describe('calculate functions and constants', () => {
  it.each([
    ['sqrt(16) + 2', 6], ['abs(-3.5)', 3.5], ['round(2.5)', 3], ['round(-2.5)', -3], ['round(1.005, 2)', 1.01],
    ['round(1234.5, -2)', 1200], ['floor(-2.5)', -3], ['ceil(2.1)', 3], ['min(3, 9, 4)', 3], ['max(3, -9, 4)', 4],
    ['log(1000)', 3], ['log(8, 2)', 3], ['ln(e)', 1], ['exp(0)', 1], ['2 * pi', 2 * Math.PI], ['PI', Math.PI],
    ['Sqrt(sqrt(81))', 3], ['max(1, min(5, 2) ^ 3)', 8], ['-sqrt(4)', -2], ['2 ^ sqrt(4)', 4], ['round(-0.4)', 0],
    ['11 % 4', 3], ['-7 % 3', -1], ['10 % 3 * 2', 2], ['max(1e308, 1e308)', 1e308], ['round(1e300, 2)', 1e300],
  ])('calculates %s', (expression, expected) => {
    expect(run('calculate', { expression }).result).toBe(expected)
  })
  it.each([
    ['foo(2)', /Unknown name "foo".*sqrt.*Example:/], ['x + 1', /Unknown name "x"/], ['Math.PI', /Unknown name "Math"/],
    ['constructor(1)', /Unknown name/], ['__proto__', /Unknown name/], ['sqrt 4', /needs parentheses.*sqrt\(16\)/],
    ['sqrt(-1)', /not a real number/], ['log(0)', /log needs a number above 0/], ['ln(-1)', /ln needs/],
    ['log(8, 1)', /base above 0 other than 1/], ['round(2.5, 1.5)', /whole-number digits/], ['round(1, 16)', /-15 to 15/],
    ['min()', /min takes 1 to 20 arguments/], ['sqrt(1, 2)', /sqrt takes 1 argument/], ['round(1, 2, 3)', /1 or 2 arguments/],
    ['sqrt(4', /Missing "\)" to close sqrt/], ['min(1,)', /Expected a number/], ['2pi', /explicitly \(2 \* pi\)/],
    ['200 + 10%', /Expected a number/], ['1 / 0', /Division by zero/], ['5 % 0', /Remainder by zero/],
    ['1 / (2 - 2)', /Division by zero/], ['exp(710)', /finite/], ['1e308 * 10', /finite/], ['10 ^ 400', /finite/],
    [`max(${Array(21).fill(1).join(',')})`, /at most 20 arguments/], ['pi()', /Unexpected input/], ['e3', /Unknown name "e3"/],
  ])('rejects %s with a corrected example', (expression, message) => {
    expect(() => run('calculate', { expression })).toThrow(message)
    expect(() => run('calculate', { expression })).toThrow(/Example: /)
  })
  it('keeps nesting and length bounded', () => {
    expect(fast('calculate', { expression: 'sqrt('.repeat(40) + '1' + ')'.repeat(40) }).error).toMatch(/32 levels.*Example:/)
    expect(fast('calculate', { expression: 'abs(-'.repeat(20) + '1' + ')'.repeat(20) }).error).toMatch(/32 levels/)
    expect(fast('calculate', { expression: 'abs('.repeat(30) + '1' + ')'.repeat(30) }).result).toBe(1)
    expect(fast('calculate', { expression: Array(256).fill('1').join('+') }).result).toBe(256)
    expect(fast('calculate', { expression: 'a'.repeat(512) }).error).toMatch(/Unknown name "a{30}"\./)
    expect(fast('calculate', { expression: 'max(' + Array(200).fill('1').join(',') + ')' }).error).toMatch(/at most 20/)
    expect(() => run('calculate', { expression: 'sqrt(1)'.padEnd(513, ' ') })).toThrow(/max 512.*Example:/)
  })
})

describe('convert_units new dimensions', () => {
  const convert = (value: number | string, from: string, to: string) => run('convert_units', { value, from, to })
  it('converts US and imperial volumes', () => {
    expect(convert(1, 'gal', 'l')).toEqual({ value: 1, from: 'gal', to: 'l', result: 3.785411784 })
    expect(convert(1, 'gallon', 'cups').result).toBe(16)
    expect(convert(2, 'cups', 'fl oz').result).toBe(16)
    expect(convert(1, 'US fl oz', 'ml').result).toBe(29.5735295625)
    expect(convert(1, 'Imperial Gallons', 'l').result).toBe(4.54609)
    expect(convert(1, 'imp gal', 'gal').result).toBe(1.20094992550486)
    expect(convert(1000, 'ml', 'cup').result).toBe(4.22675283773038)
  })
  it('converts time, data and speed with tidy results', () => {
    expect(convert(90, 'minutes', 'h')).toEqual({ value: 90, from: 'min', to: 'h', result: 1.5 })
    expect(convert(1, 'week', 'days').result).toBe(7)
    expect(convert(1, 'day', 'hours').result).toBe(24)
    expect(convert(1500, 'ms', 'sec').result).toBe(1.5)
    expect(convert(1, 'GiB', 'MiB').result).toBe(1024)
    expect(convert(1, 'GB', 'MB').result).toBe(1000)
    expect(convert(1, 'KiB', 'KB').result).toBe(1.024)
    expect(convert(1, 'TiB', 'TB').result).toBe(1.099511627776)
    expect(convert(1, 'B', 'bits')).toEqual({ value: 1, from: 'B', to: 'bit', result: 8 })
    expect(convert(8, 'b', 'byte')).toMatchObject({ from: 'bit', to: 'B', result: 1 })
    expect(convert(1, 'Mb', 'KB')).toMatchObject({ from: 'Mbit', result: 125 })
    expect(convert(1, 'mb', 'kb')).toMatchObject({ from: 'MB', to: 'KB', result: 1000 })
    expect(convert(2, 'gigabytes', 'mebibytes').result).toBe(1907.34863281250)
    expect(convert(1, 'mph', 'km/h')).toEqual({ value: 1, from: 'mph', to: 'km/h', result: 1.609344 })
    expect(convert(1, 'knot', 'km/h').result).toBe(1.852)
    expect(convert(10, 'm/s', 'kph').result).toBe(36)
    expect(convert('36', 'Kilometers Per Hour', 'meters  per second').result).toBe(10)
    expect(convert(-1e100, 'TB', 'bit').result).toBe(-8e112)
  })
  it('keeps the original catalog bit-for-bit', () => {
    expect(convert(10, 'km', 'mi').result).toBe(10_000 / 1609.344)
    expect(convert(1, 'ft', 'in').result).toBe(0.3048 / 0.0254)
    expect(convert(100, 'C', 'F').result).toBe((100 + 273.15 - (273.15 - 32 * 5 / 9)) / (5 / 9))
    expect(convert(1, 'ounces', 'kg')).toEqual({ value: 1, from: 'oz', to: 'kg', result: 28.349523125 / 1000 })
    expect(convert(3, 'ml', 'l')).toEqual({ value: 3, from: 'ml', to: 'l', result: 0.003 })
  })
  it('rejects mixed dimensions and unknown units with the catalog and a matching example', () => {
    expect(() => convert(1, 'gal', 'kg')).toThrow(/Cannot convert gal \(volume\) to kg \(mass\).*Example: \{"value":1,"from":"gal","to":"l"\}/)
    expect(() => convert(1, 's', 'm')).toThrow(/time.*length.*Example:/)
    expect(() => convert(1, 'GB', 'Mbps')).toThrow(/Unknown unit "Mbps". Supported: .*data: bit, B, KB.*Example: \{"value":1,"from":"GiB","to":"MB"\}/)
    for (const unit of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'parsec', 'bites']) {
      expect(() => convert(1, unit, 'm'), unit).toThrow(/Unknown unit.*Example: /)
    }
  })
})

describe('descriptions mention the new capabilities', () => {
  it('stays within 240 chars with an example', () => {
    const text = Object.fromEntries(entries.map((entry) => [entry.name, entry.description]))
    for (const description of Object.values(text)) {
      expect(description.length).toBeLessThanOrEqual(240)
      expect(description).toContain('Example:')
    }
    expect(text.json_query).toMatch(/\[\*\].*shape/)
    expect(text.csv_summary).toMatch(/median.*group_by/)
    expect(text.calculate).toMatch(/sqrt.*pi/)
    expect(text.convert_units).toMatch(/time.*data.*speed/)
  })
})
