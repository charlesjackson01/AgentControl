/** Small, bounded JSON and CSV readers; paths never execute expressions. */
import { argError, readBoolean, readString } from './args.js'
import { fitJson } from './limits.js'
import type { ToolEntry } from './types.js'

const MAX_DATA = 50_000
const jsonExample = { json: '@input', path: 'items[0].name' }
const csvExample = { csv: '@input', has_header: true }

function pathParts(path: string): string[] {
  if (path === '' || path === '$') return []
  if (path.startsWith('/')) {
    const parts = path.slice(1).split('/')
    if (parts.some((part) => /~[^01]|~$/.test(part))) throw argError('Invalid JSON Pointer escape; use ~0 for ~ and ~1 for /.', jsonExample)
    return parts.map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
  }
  const value = path.startsWith('$.') ? path.slice(2) : path.startsWith('$[') ? path.slice(1) : path
  const parts: string[] = []
  let cursor = 0
  while (cursor < value.length) {
    const tail = value.slice(cursor)
    const match = cursor === 0 ? /^([A-Za-z_$][\w$-]*)|^\[(0|[1-9]\d*)\]/.exec(tail) : /^\.([A-Za-z_$][\w$-]*)|^\[(0|[1-9]\d*)\]/.exec(tail)
    if (!match) throw argError('Path must use dot keys, numeric [index], or a JSON Pointer (/key/0).', jsonExample)
    parts.push((match[1] ?? match[2])!)
    cursor += match[0].length
  }
  if (parts.length === 0) throw argError('Invalid JSON path.', jsonExample)
  return parts
}

function parseJson(text: string): unknown {
  let value: unknown
  try { value = JSON.parse(text) } catch { throw argError('Invalid JSON; provide one complete JSON value.', jsonExample) }
  const pending = [{ value, depth: 0 }]
  let count = 0
  while (pending.length) {
    const current = pending.pop()!
    if (++count > 10_000 || current.depth > 24) throw argError('JSON exceeds 10,000 values or 24 nesting levels.', jsonExample)
    if (current.value !== null && typeof current.value === 'object') {
      for (const child of Object.values(current.value)) pending.push({ value: child, depth: current.depth + 1 })
    } else if (typeof current.value === 'number' && !Number.isFinite(current.value)) {
      throw argError('JSON numbers must be finite.', jsonExample)
    }
  }
  return value
}

function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let closed = false
  const pushField = () => {
    row.push(field)
    if (row.length > 100) throw argError('CSV accepts at most 100 columns.', csvExample)
    field = ''; closed = false
  }
  const pushRow = () => {
    pushField(); rows.push(row); row = []
    if (rows.length > 1001) throw argError('CSV accepts at most 1,000 data rows plus a header.', csvExample)
  }
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ }
        else { quoted = false; closed = true }
      } else field += char
    } else if (char === delimiter) pushField()
    else if (char === '\n' || char === '\r') {
      pushRow()
      if (char === '\r' && text[i + 1] === '\n') i++
    } else if (closed) {
      if (char !== ' ' && char !== '\t') throw argError('Unexpected content after a closing CSV quote.', csvExample)
    } else if (char === '"') {
      if (field !== '') throw argError('CSV quotes must start at the beginning of a field.', csvExample)
      quoted = true
    } else field += char
    if (field.length > 10_000) throw argError('CSV fields must be at most 10,000 chars.', csvExample)
  }
  if (quoted) throw argError('CSV has an unterminated quoted field.', csvExample)
  if (field !== '' || row.length > 0 || closed) pushRow()
  return rows
}

export const dataTools: ToolEntry[] = [
  {
    name: 'json_query', category: 'data', effect: 'read',
    description: 'Read JSON (max 50,000 chars), optionally select a dot/index path or JSON Pointer. Own properties only; no expressions. Defaults to @input, using its first code fence. Example: {"json":"@input","path":"items[0].name"}',
    parameters: { type: 'object', properties: { json: { type: 'string' }, path: { type: 'string' } } },
    contentParams: { names: ['json'], defaultParam: 'json', structured: true },
    handler(args) {
      const text = readString(args, 'json', { required: true, max: MAX_DATA, example: jsonExample })!
      const path = readString(args, 'path', { max: 1000, example: jsonExample }) ?? ''
      const parts = pathParts(path)
      if (parts.length > 32) throw argError('Path must contain at most 32 segments.', jsonExample)
      let value = parseJson(text)
      for (const part of parts) {
        if (value === null || typeof value !== 'object' || !Object.hasOwn(value, part) || (Array.isArray(value) && !/^(0|[1-9]\d*)$/.test(part))) return { found: false, path }
        value = (value as Record<string, unknown>)[part]
      }
      const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
      return fitJson({ found: true, path, type, ...(Array.isArray(value) ? { length: value.length } : {}), value })
    },
  },
  {
    name: 'csv_summary', category: 'data', effect: 'read',
    description: 'Summarize CSV (50,000 chars, 1,000 rows, 100 columns): counts, five sample rows and numeric column stats. Supports quoted fields. Defaults to @input and a header. Example: {"csv":"@input","has_header":true}',
    parameters: { type: 'object', properties: { csv: { type: 'string' }, delimiter: { type: 'string' }, has_header: { type: 'boolean' } } },
    contentParams: { names: ['csv'], defaultParam: 'csv', structured: true },
    handler(args) {
      const text = (readString(args, 'csv', { max: MAX_DATA, example: csvExample }) ?? '').replace(/^\uFEFF/, '')
      const delimiter = readString(args, 'delimiter', { max: 1, example: { csv: '@input', delimiter: ';' } }) ?? ','
      if (delimiter === '"' || delimiter === '\r' || delimiter === '\n' || delimiter.charCodeAt(0) < 32 && delimiter !== '\t') throw argError('Delimiter must be one non-quote, non-newline character (tab is allowed).', csvExample)
      const hasHeader = readBoolean(args, 'has_header', true)
      const rows = parseCsv(text, delimiter)
      const headers = hasHeader ? (rows.shift() ?? []) : []
      if (rows.length > 1000) throw argError('CSV accepts at most 1,000 data rows.', csvExample)
      const width = Math.max(headers.length, ...rows.map((row) => row.length), 0)
      const expected = hasHeader ? headers.length : (rows[0]?.length ?? 0)
      const columns = Array.from({ length: width }, (_, index) => {
        const values = rows.map((row) => row[index]?.trim() ?? '')
        const nonblank = values.filter((value) => value !== '')
        const numbers = nonblank.filter((value) => /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/.test(value)).map(Number).filter(Number.isFinite)
        const sum = numbers.reduce((total, value) => total + value, 0)
        return {
          index: index + 1, name: headers[index] ?? `column_${index + 1}`,
          blank: values.length - nonblank.length, numeric_count: numbers.length, nonnumeric_count: nonblank.length - numbers.length,
          ...(numbers.length ? { min: Math.min(...numbers), max: Math.max(...numbers), sum: Number.isFinite(sum) ? sum : null, mean: Number.isFinite(sum) ? sum / numbers.length : null } : {}),
        }
      })
      return fitJson({ rows: rows.length, column_count: width, has_header: hasHeader, inconsistent_rows: rows.filter((row) => row.length !== expected).length, columns, sample: rows.slice(0, 5), sampled: rows.length > 5 })
    },
  },
]
