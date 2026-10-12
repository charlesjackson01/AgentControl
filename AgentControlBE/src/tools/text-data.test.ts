import { describe, expect, it } from 'vitest'
import { executeToolCall } from '../tools.js'
import type { WorkspaceStore } from '../store.js'
import { dataTools } from './data.js'
import { textTools } from './text.js'
import type { ToolContext } from './types.js'

const entries = [...textTools, ...dataTools]
function context(input = ''): ToolContext {
  return { store: { endpointKeys: {}, notes: [{ id: 'draft', title: 'Draft', body: 'original_text' }] } as WorkspaceStore,
    agentId: 'agent', runId: 'run', input, allowed: new Set([...entries.map((entry) => entry.name), 'read_note']),
    now: () => new Date('2026-01-01T00:00:00Z'), timeZone: 'UTC', writes: { count: 0 } }
}
function run(name: string, args: Record<string, unknown>): any { return entries.find((entry) => entry.name === name)!.handler(args, context()) }
async function call(name: string, args: Record<string, unknown>, ctx = context()) { return executeToolCall({ id: 'call', name, arguments: JSON.stringify(args) }, ctx) }

describe('bounded text tools', () => {
  it('counts Unicode, identifier words and CRLF lines', () => {
    const text = 'hello_world café 😀\r\n\r\nDone'
    expect(run('text_stats', { text })).toEqual({ characters: Array.from(text).length, utf16_units: text.length, words: 3, lines: 3, nonblank_lines: 2 })
    expect(run('text_stats', { text: '' })).toMatchObject({ characters: 0, words: 0, lines: 0 })
  })
  it('preserves underscores and literal replacement characters', () => {
    expect(run('transform_text', { operation: 'trim', text: '  first_name  ' }).text).toBe('first_name')
    expect(run('transform_text', { operation: 'UPPERCASE', text: 'first_name' }).text).toBe('FIRST_NAME')
    expect(run('transform_text', { operation: 'collapse whitespace', text: ' a_b\t c_d\n ' }).text).toBe('a_b c_d')
    expect(run('transform_text', { operation: 'replace', text: 'a.b aXb a.b', find: 'a.b', replacement: '$&_x' }).text).toBe('$&_x aXb $&_x')
    expect(run('transform_text', { operation: 'replace', text: 'a_b', find: '_' }).text).toBe('ab')
    expect(run('transform_text', { operation: 'sort_lines', text: 'z_a\r\nb_c' }).text).toBe('b_c\nz_a')
    expect(run('transform_text', { operation: 'dedupe_lines', text: 'a_b\na_b\n A_B' }).text).toBe('a_b\n A_B')
  })
  it('caps expansion and structurally limits escaped output', () => {
    expect(() => run('transform_text', { operation: 'replace', text: 'a'.repeat(5000), find: 'a', replacement: 'z'.repeat(100) })).toThrow(/exceeds.*Example:/)
    expect(() => run('transform_text', { operation: 'replace', text: 'a', find: '' })).toThrow(/Example:/)
    const result = run('transform_text', { operation: 'trim', text: '\\"'.repeat(20_000) })
    expect(result.truncated).toBe(true)
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(3500)
  })
  it('compares positional lines with normalization and distinguishes missing from blank', () => {
    expect(run('compare_text', { left: ' A_B  c ', right: 'a_b c', ignore_case: 'true', ignore_whitespace: 'yes' }).equal).toBe(true)
    expect(run('compare_text', { left: 'same\n', right: 'same' })).toMatchObject({ equal: false, different_lines: 1, differences: [{ line: 2, left: '', right: null }] })
    expect(() => run('compare_text', { left: 'one' })).toThrow(/right.*Example:/)
    expect(() => run('text_stats', { text: 'a'.repeat(50_001) })).toThrow(/max 50000.*Example:/)
    expect(() => run('compare_text', { left: '\n'.repeat(3000), right: '' })).toThrow(/3,000.*Example:/)
    expect(run('compare_text', { left: Array(30).fill('a').join('\n'), right: '' })).toMatchObject({ different_lines: 30, truncated: true })
  })
})

describe('safe JSON queries', () => {
  const json = '{"items":[{"name":"first"}],"a/b":{"~name":3},"__proto__":{"safe":true}}'
  it('selects own values with dot/index and escaped pointer paths', () => {
    expect(run('json_query', { json, path: '$.items[0].name' })).toMatchObject({ found: true, value: 'first' })
    expect(run('json_query', { json, path: '/a~1b/~0name' }).value).toBe(3)
    expect(run('json_query', { json, path: '__proto__.safe' }).value).toBe(true)
    expect(run('json_query', { json: '[false,null]', path: '$[1]' })).toMatchObject({ found: true, type: 'null', value: null })
  })
  it('never traverses prototypes or interprets expressions', () => {
    for (const path of ['constructor', 'toString', '__proto__.constructor', 'items.length']) expect(run('json_query', { json, path }).found).toBe(false)
    for (const path of ['items[0+0]', 'items.map(x)', 'items..name', '/bad~2', 'items[01]']) expect(() => run('json_query', { json, path })).toThrow(/Example:/)
    expect(({} as Record<string, unknown>).safe).toBeUndefined()
  })
  it('rejects malformed, deep, large or nonfinite data with corrected examples', () => {
    for (const json of ['{bad}', '1e400', '['.repeat(26) + '0' + ']'.repeat(26), JSON.stringify(Array(10_001).fill(0)), ' '.repeat(50_001)]) expect(() => run('json_query', { json })).toThrow(/Example:/)
    const result = run('json_query', { json: JSON.stringify(Array(1000).fill({ value: 'a'.repeat(20) })) })
    expect(result.truncated).toBe(true)
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(3500)
    expect(result.length).toBe(1000)
  })
  it('keeps objects with escape-heavy keys within the serialized output budget', () => {
    const value = Object.fromEntries(Array.from({ length: 300 }, (_, i) => ['"'.repeat(60) + i, 'x']))
    const result = run('json_query', { json: JSON.stringify(value) })
    expect(result.truncated).toBe(true)
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(3500)
  })
})

describe('CSV summaries', () => {
  it('parses quoted newlines, escaped quotes, BOM and CRLF without phantom rows', () => {
    const result = run('csv_summary', { csv: '\uFEFFname,amount\r\n"a\r\nb",2\r\n"say ""hi""",4\r\n' })
    expect(result).toMatchObject({ rows: 2, column_count: 2, inconsistent_rows: 0, sample: [['a\r\nb', '2'], ['say "hi"', '4']] })
    expect(result.columns[1]).toMatchObject({ numeric_count: 2, min: 2, max: 4, sum: 6, mean: 3 })
  })
  it('supports alternate delimiters, no header, blanks, ragged rows and duplicate headers', () => {
    const result = run('csv_summary', { csv: '1;2\n3;;extra', delimiter: ';', has_header: 'false' })
    expect(result).toMatchObject({ rows: 2, column_count: 3, inconsistent_rows: 1, has_header: false })
    expect(result.columns[1]).toMatchObject({ name: 'column_2', blank: 1, numeric_count: 1 })
    expect(run('csv_summary', { csv: 'x\tx\n1\t2', delimiter: '\t' }).columns.map((c: { name: string }) => c.name)).toEqual(['x', 'x'])
    expect(run('csv_summary', { csv: '' })).toMatchObject({ rows: 0, column_count: 0, sample: [] })
    expect(run('csv_summary', { csv: 'a,b\n,\n' })).toMatchObject({ rows: 1, sample: [['', '']] })
  })
  it('reports mixed numeric values and overflow honestly', () => {
    expect(run('csv_summary', { csv: 'amount\n2\nno\n1e400\n4' }).columns[0]).toMatchObject({ numeric_count: 2, nonnumeric_count: 2, sum: 6 })
    expect(run('csv_summary', { csv: 'n\n1e308\n1e308' }).columns[0]).toMatchObject({ sum: null, mean: null })
  })
  it('rejects malformed quoting and exhausted delimiter/row/column/field budgets', () => {
    for (const csv of ['a\n"unclosed', 'a\n"closed"x', 'a\nun"quoted', Array(102).fill('x').join(','), 'a\n' + 'x'.repeat(10_001), 'a\n'.repeat(1003)]) expect(() => run('csv_summary', { csv })).toThrow(/Example:/)
    for (const delimiter of ['"', '\n', '\r', '\0', '::']) expect(() => run('csv_summary', { csv: 'a', delimiter })).toThrow(/Example:/)
    expect(() => run('csv_summary', { csv: 'a\n'.repeat(1001), has_header: false })).toThrow(/1,000.*Example:/)
  })
})

describe('registry refs and recoverable failures', () => {
  it('defaults to input and extracts first fenced JSON or CSV', async () => {
    expect(JSON.parse((await call('text_stats', {}, context('one_two'))).content)).toMatchObject({ words: 1, sources: { text: '@input' } })
    expect(JSON.parse((await call('json_query', { path: 'ok' }, context('Read:\n```json\n{"ok":true}\n```'))).content)).toMatchObject({ value: true, sources: { json: '@input' } })
    expect(JSON.parse((await call('csv_summary', {}, context('```csv\na,b\n1,2\n```'))).content)).toMatchObject({ rows: 1, column_count: 2 })
    expect(JSON.parse((await call('json_query', { json: { items: [1] }, path: 'items[0]' })).content).value).toBe(1)
  })
  it('checks read_note permission and returns handler errors to the model', async () => {
    const ctx = context()
    expect(JSON.parse((await call('transform_text', { text: '@note:Draft', operation: 'trim' }, ctx)).content)).toMatchObject({ text: 'original_text', sources: { text: '@note:draft' } })
    ctx.allowed = new Set(['transform_text'])
    expect((await call('transform_text', { text: '@note:Draft', operation: 'trim' }, ctx)).ok).toBe(false)
    const result = await call('json_query', { json: '{bad}' })
    expect(result.ok).toBe(false)
    expect(result.content).toContain('Example:')
  })
})
