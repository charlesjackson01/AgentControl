/** Small, bounded JSON and CSV readers; paths never execute expressions. */
import { argError, readBoolean, readString } from './args.js'
import { clipText, fitJson, RESULT_MAX_CHARS } from './limits.js'
import { redactSecrets } from './redact.js'
import type { ToolContext, ToolEntry } from './types.js'

const MAX_DATA = 50_000
const jsonExample = { json: '@input', path: 'items[0].name' }
const csvExample = { csv: '@input', has_header: true }

/**
 * Secrets replaced BEFORE parsing: results clip long strings (fitJson, top
 * values, group keys), and a clipped key ("sk-or-v1-0123…") no longer matches
 * the redaction executeToolCall runs on the serialized result.
 */
const redacted = (text: string, ctx: ToolContext | undefined): string => (ctx?.store ? redactSecrets(text, ctx.store) : text)

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Null-prototype map: keys taken from the data ("__proto__") stay plain own properties. */
const dict = <T>(): Record<string, T> => Object.create(null) as Record<string, T>

// --- json_query paths ---------------------------------------------------------

/** One path step; an index keeps its spelling for objects with numeric-looking keys. */
type Step = { kind: 'key'; key: string } | { kind: 'index'; index: number; text: string } | { kind: 'wild' }

const MAX_STEPS = 32
const MAX_WILDCARDS = 2
/** Values listed for a wildcard path; `count` still reports every match. */
const MAX_MATCHES = 100
const PATH_HELP = 'Path must use dot keys, [0] or [-1], ["quoted key"], [*] (max 2), or a JSON Pointer (/key/0).'
/** .key | .* | [0] [-1] | [*] | ["json string"] | ['text']. Quoted bodies use disjoint classes, so matching stays linear. */
const STEP = /^(?:\.([A-Za-z_$][\w$-]*)|\.\*|\[(0|-?[1-9]\d*)\]|\[\*\]|\["((?:[^"\\]|\\[\s\S])*)"\]|\['((?:[^'\\]|\\[\s\S])*)'\])/

function pathSteps(path: string): Step[] {
  if (path === '' || path === '$') return []
  if (path.startsWith('/')) {
    const parts = path.slice(1).split('/')
    if (parts.some((part) => /~[^01]|~$/.test(part))) throw argError('Invalid JSON Pointer escape; use ~0 for ~ and ~1 for /.', jsonExample)
    if (parts.length > MAX_STEPS) throw argError(`Path must contain at most ${MAX_STEPS} segments.`, jsonExample)
    return parts.map((part) => ({ kind: 'key', key: part.replace(/~1/g, '/').replace(/~0/g, '~') }))
  }
  const body = path.startsWith('$.') ? path.slice(2) : path.startsWith('$[') ? path.slice(1) : path
  // A leading key has no dot ("items[0]"); give it one so every step has the same grammar.
  const value = body.startsWith('[') ? body : `.${body}`
  const steps: Step[] = []
  let cursor = 0
  while (cursor < value.length) {
    const match = STEP.exec(value.slice(cursor))
    if (!match) throw argError(PATH_HELP, jsonExample)
    const [whole, key, index, quoted, single] = match
    if (key !== undefined) steps.push({ kind: 'key', key })
    else if (index !== undefined) steps.push({ kind: 'index', index: Number(index), text: index })
    else if (quoted !== undefined) {
      let parsed: unknown
      try { parsed = JSON.parse(`"${quoted}"`) } catch { throw argError('A ["quoted key"] must be a valid JSON string; escape " and \\ with a backslash.', { json: '@input', path: '["odd key"].value' }) }
      steps.push({ kind: 'key', key: parsed as string })
    } else if (single !== undefined) steps.push({ kind: 'key', key: single.replace(/\\([\s\S])/g, '$1') })
    else steps.push({ kind: 'wild' })
    if (steps.length > MAX_STEPS) throw argError(`Path must contain at most ${MAX_STEPS} segments.`, jsonExample)
    cursor += whole.length
  }
  if (steps.length === 0) throw argError('Invalid JSON path.', jsonExample)
  if (steps.filter((step) => step.kind === 'wild').length > MAX_WILDCARDS) {
    throw argError(`Path may use at most ${MAX_WILDCARDS} [*] wildcards.`, { json: '@input', path: 'orders[*].items[*].sku' })
  }
  return steps
}

/** Own child of an object, or an array item (negative indices count from the end). */
function child(node: unknown, step: Exclude<Step, { kind: 'wild' }>): { value: unknown } | undefined {
  if (Array.isArray(node)) {
    const index = step.kind === 'index'
      ? (step.index < 0 ? node.length + step.index : step.index)
      : /^(0|[1-9]\d*)$/.test(step.key) ? Number(step.key) : -1
    return index >= 0 && index < node.length ? { value: node[index] } : undefined
  }
  if (!isRecord(node)) return undefined
  const key = step.kind === 'index' ? step.text : step.key
  return Object.hasOwn(node, key) ? { value: node[key] } : undefined
}

/**
 * Every value `steps` reaches from `root`. [*] fans out over array items and
 * own object values; parseJson caps the document at 10,000 values, so the
 * frontier (distinct subtrees) never exceeds that. `missing` counts nodes a
 * step could not continue from.
 */
function select(root: unknown, steps: readonly Step[]): { matches: unknown[]; missing: number } {
  let frontier: unknown[] = [root]
  let missing = 0
  for (const step of steps) {
    const next: unknown[] = []
    for (const node of frontier) {
      if (step.kind !== 'wild') {
        const found = child(node, step)
        if (found) next.push(found.value)
        else missing++
      } else if (Array.isArray(node)) {
        for (const item of node) next.push(item)
      } else if (isRecord(node)) {
        for (const key of Object.keys(node)) next.push(node[key])
      } else missing++
    }
    frontier = next
  }
  return { matches: frontier, missing }
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

// --- json_query shape -----------------------------------------------------------

const typeOf = (value: unknown): string => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value

/** "string", "array(3)", "object(2 keys)": a value's type at a glance. */
function label(value: unknown): string {
  if (Array.isArray(value)) return `array(${value.length})`
  if (isRecord(value)) return `object(${Object.keys(value).length} keys)`
  return typeOf(value)
}

/** Set a clipped key without overwriting an earlier one that clips the same ("long…", "long… #2"). */
function setKey<T>(target: Record<string, T>, key: string, value: T): void {
  const clipped = clipText(key, SHAPE_KEY_CHARS)
  let name = clipped
  for (let n = 2; Object.hasOwn(target, name); n++) name = `${clipped} #${n}`
  target[name] = value
}

/** Keys listed per level (root, then its children); later tries are smaller. Level 2 is labels only. */
const SHAPE_LIMITS: readonly (readonly number[])[] = [[40, 12], [20, 6], [10, 0]]
const SHAPE_BUDGET = 3_000
const SHAPE_KEY_CHARS = 60

/**
 * Structure without values, two levels deep: objects list their keys,
 * arrays their length, item type counts and the union of their items' keys.
 * Own keys only. Work is linear in the (≤10,000-value) document.
 */
function shapeOf(value: unknown, limits: readonly number[], level: number): unknown {
  const limit = limits[level] ?? 0
  if (Array.isArray(value)) {
    if (limit === 0) return label(value)
    const out: Record<string, unknown> = { type: 'array', length: value.length }
    if (value.length === 0) return out
    const types = dict<number>()
    const itemKeys = new Map<string, Set<string>>()
    let moreKeys = false
    for (const item of value) {
      const type = typeOf(item)
      types[type] = (types[type] ?? 0) + 1
      if (!isRecord(item)) continue
      for (const key of Object.keys(item)) {
        const seen = itemKeys.get(key)
        if (seen) seen.add(typeOf(item[key]))
        else if (itemKeys.size < limit) itemKeys.set(key, new Set([typeOf(item[key])]))
        else moreKeys = true
      }
    }
    out.item_types = types
    if (itemKeys.size > 0) {
      const keys = dict<string>()
      for (const [key, seen] of itemKeys) setKey(keys, key, [...seen].join('|'))
      out.item_keys = keys
    }
    if (moreKeys) out.more_item_keys = true
    return out
  }
  if (isRecord(value)) {
    if (limit === 0) return label(value)
    const names = Object.keys(value)
    const keys = dict<unknown>()
    for (const key of names.slice(0, limit)) setKey(keys, key, shapeOf(value[key], limits, level + 1))
    return { type: 'object', key_count: names.length, keys, ...(names.length > limit ? { more_keys: names.length - limit } : {}) }
  }
  if (level > 0) return label(value)
  return typeof value === 'string' ? { type: 'string', length: value.length } : { type: typeOf(value) }
}

/** The most detailed shape that fits SHAPE_BUDGET; fitJson remains the backstop for escape-heavy keys. */
function boundedShape(value: unknown): unknown {
  let shape: unknown
  for (const limits of SHAPE_LIMITS) {
    shape = shapeOf(value, limits, 0)
    if (JSON.stringify(shape).length <= SHAPE_BUDGET) break
  }
  return shape
}

// --- csv_summary ------------------------------------------------------------------

const NUMBER = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/
const TOP_VALUES = 3
const MAX_GROUPS = 20
const VALUE_CHARS = 60
const groupExample = { csv: '@input', group_by: 'region', sum_column: 'sales' }

/** Finite number in a trimmed cell; "1e400" and text are not numbers. */
function cellNumber(value: string): number | undefined {
  if (!NUMBER.test(value)) return undefined
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

const finiteOrNull = (value: number): number | null => Number.isFinite(value) ? value : null

/** Middle of sorted values; halves first when the plain mean of the middle pair overflows. */
function median(sorted: Float64Array): number {
  const mid = sorted.length >> 1
  if (sorted.length % 2 === 1) return sorted[mid]!
  const low = sorted[mid - 1]!
  const high = sorted[mid]!
  const mean = (low + high) / 2
  return Number.isFinite(mean) ? mean : low / 2 + high / 2
}

/** The 3 most frequent values (ties keep first appearance), or none when no value repeats. */
function topValues(counts: Map<string, number>): { value: string; count: number }[] | undefined {
  const top: [string, number][] = []
  for (const entry of counts) {
    let at = top.length
    while (at > 0 && top[at - 1]![1] < entry[1]) at--
    if (at < TOP_VALUES) {
      top.splice(at, 0, entry)
      if (top.length > TOP_VALUES) top.pop()
    }
  }
  if ((top[0]?.[1] ?? 0) < 2) return undefined
  return top.map(([value, count]) => ({ value: clipText(value, VALUE_CHARS), count }))
}

function summarizeColumn(rows: string[][], index: number, name: string): Record<string, unknown> {
  const values = rows.map((row) => row[index]?.trim() ?? '')
  const nonblank = values.filter((value) => value !== '')
  const numbers = nonblank.map(cellNumber).filter((value) => value !== undefined)
  // Rows are capped at 1,000, so the distinct-value map is too.
  const counts = new Map<string, number>()
  for (const value of nonblank) counts.set(value, (counts.get(value) ?? 0) + 1)
  const sum = numbers.reduce((total, value) => total + value, 0)
  const top = topValues(counts)
  return {
    index: index + 1, name,
    blank: values.length - nonblank.length, numeric_count: numbers.length, nonnumeric_count: nonblank.length - numbers.length,
    distinct: counts.size,
    ...(numbers.length ? {
      min: Math.min(...numbers), max: Math.max(...numbers), sum: finiteOrNull(sum), mean: Number.isFinite(sum) ? sum / numbers.length : null,
      median: median(Float64Array.from(numbers).sort()),
    } : {}),
    ...(top ? { top_values: top } : {}),
  }
}

/** Column by exact name, then trimmed case-insensitive name, then 1-based position. */
function findColumn(names: readonly string[], ref: string): number | undefined {
  const exact = names.indexOf(ref)
  if (exact >= 0) return exact
  const folded = ref.trim().toLowerCase()
  const loose = names.findIndex((name) => name.trim().toLowerCase() === folded)
  if (loose >= 0) return loose
  const position = /^\d{1,3}$/.test(folded) ? Number(folded) : 0
  return position >= 1 && position <= names.length ? position - 1 : undefined
}

function columnError(names: readonly string[], ref: string, param: string, example: Record<string, unknown>): Error {
  if (names.length === 0) return argError(`No column "${clipText(ref, 40)}" for "${param}"; the CSV has no columns.`, example)
  const listed = names.slice(0, 20).map((name) => JSON.stringify(clipText(name, 40))).join(', ')
  return argError(`No column "${clipText(ref, 40)}" for "${param}". Columns: ${listed}${names.length > 20 ? `, … (${names.length})` : ''}.`, example)
}

/**
 * Rows per distinct group_by value (blank cells form the "" group), with
 * sum_column totals over numeric cells. Groups ≤ rows ≤ 1,000; the 20
 * largest are listed by rows (ties keep first appearance), the rest totalled.
 */
function groupRows(rows: string[][], groupIndex: number, sumIndex: number | undefined): Record<string, unknown> {
  const groups = new Map<string, { rows: number; sum: number }>()
  for (const row of rows) {
    const key = row[groupIndex]?.trim() ?? ''
    let group = groups.get(key)
    if (!group) groups.set(key, group = { rows: 0, sum: 0 })
    group.rows++
    const number = sumIndex === undefined ? undefined : cellNumber(row[sumIndex]?.trim() ?? '')
    if (number !== undefined) group.sum += number
  }
  const sorted = [...groups].sort((a, b) => b[1].rows - a[1].rows)
  const withSum = (rowCount: number, sum: number) => ({ rows: rowCount, ...(sumIndex === undefined ? {} : { sum: finiteOrNull(sum) }) })
  const out: Record<string, unknown> = {
    group_count: groups.size,
    groups: sorted.slice(0, MAX_GROUPS).map(([key, group]) => ({ key: clipText(key, VALUE_CHARS), ...withSum(group.rows, group.sum) })),
  }
  if (sorted.length > MAX_GROUPS) {
    const rest = sorted.slice(MAX_GROUPS)
    out.other = { groups: rest.length, ...withSum(rest.reduce((total, [, g]) => total + g.rows, 0), rest.reduce((total, [, g]) => total + g.sum, 0)) }
  }
  return out
}

/** group_by / sum_column fields for the summary; throws for unknown or non-numeric columns. */
function grouping(rows: string[][], names: readonly string[], groupRef: string | undefined, sumRef: string | undefined): Record<string, unknown> {
  if (groupRef === undefined && sumRef === undefined) return {}
  const groupIndex = groupRef === undefined ? undefined : findColumn(names, groupRef)
  if (groupRef !== undefined && groupIndex === undefined) throw columnError(names, groupRef, 'group_by', { csv: '@input', group_by: clipText(names[0] ?? 'region', 40) })
  const sumIndex = sumRef === undefined ? undefined : findColumn(names, sumRef)
  const numericNames = () => names.filter((_, index) => rows.some((row) => cellNumber(row[index]?.trim() ?? '') !== undefined))
  const sumExample = () => ({ csv: '@input', ...(groupIndex === undefined ? {} : { group_by: clipText(names[groupIndex]!, 40) }), sum_column: clipText(numericNames()[0] ?? 'sales', 40) })
  if (sumRef !== undefined && sumIndex === undefined) throw columnError(names, sumRef, 'sum_column', sumExample())
  const out: Record<string, unknown> = {}
  if (groupIndex !== undefined) out.group_by = clipText(names[groupIndex]!, VALUE_CHARS)
  if (sumIndex !== undefined) {
    out.sum_column = clipText(names[sumIndex]!, VALUE_CHARS)
    const numbers = rows.map((row) => cellNumber(row[sumIndex]?.trim() ?? '')).filter((value) => value !== undefined)
    if (rows.length > 0 && numbers.length === 0) {
      const listed = numericNames().slice(0, 20).map((name) => JSON.stringify(clipText(name, 40))).join(', ')
      throw argError(`"sum_column" ${JSON.stringify(clipText(names[sumIndex]!, 40))} has no numeric values. Numeric columns: ${listed || 'none'}.`, sumExample())
    }
    if (numbers.length < rows.length) out.sum_skipped = rows.length - numbers.length
    if (groupIndex === undefined) out.sum_total = finiteOrNull(numbers.reduce((total, value) => total + value, 0))
  }
  return groupIndex === undefined ? out : { ...out, ...groupRows(rows, groupIndex, sumIndex) }
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
    description: 'Read JSON (max 50,000 chars) at a path: a.b, [0], [-1], ["odd key"], [*] (max 2) or /json/pointer. shape:true returns keys and types instead of the value. Own keys only; defaults to @input. Example: {"json":"@input","path":"items[*].name"}',
    parameters: { type: 'object', properties: { json: { type: 'string' }, path: { type: 'string' }, shape: { type: 'boolean' } } },
    contentParams: { names: ['json'], defaultParam: 'json', structured: true },
    handler(args, ctx) {
      const text = redacted(readString(args, 'json', { required: true, max: MAX_DATA, example: jsonExample })!, ctx)
      const path = readString(args, 'path', { max: 1000, example: jsonExample }) ?? ''
      const shape = readBoolean(args, 'shape', false)
      const steps = pathSteps(path)
      const { matches, missing } = select(parseJson(text), steps)
      if (!steps.some((step) => step.kind === 'wild')) {
        if (matches.length === 0) return { found: false, path }
        const value = matches[0]
        const head = { found: true, path, type: typeOf(value), ...(Array.isArray(value) ? { length: value.length } : {}) }
        return fitJson(shape ? { ...head, shape: boundedShape(value) } : { ...head, value })
      }
      const head = { found: matches.length > 0, path, count: matches.length, ...(missing > 0 ? { missing } : {}) }
      if (shape) return fitJson({ ...head, shape: boundedShape(matches) })
      // Room for "shown" after fitting; fitJson may halve the list further.
      const result = fitJson({ ...head, values: matches.slice(0, MAX_MATCHES) }, RESULT_MAX_CHARS - 40) as Record<string, unknown>
      if (Array.isArray(result.values) && result.values.length < matches.length) result.shown = result.values.length
      return result
    },
  },
  {
    name: 'csv_summary', category: 'data', effect: 'read',
    description: 'Summarize CSV (50,000 chars, 1,000 rows, 100 cols): counts, samples, distinct, top values, min/max/mean/median per column; group_by a column (+ sum_column). Default @input. Example: {"csv":"@input","group_by":"region","sum_column":"sales"}',
    parameters: {
      type: 'object',
      properties: { csv: { type: 'string' }, delimiter: { type: 'string' }, has_header: { type: 'boolean' }, group_by: { type: 'string' }, sum_column: { type: 'string' } },
    },
    contentParams: { names: ['csv'], defaultParam: 'csv', structured: true },
    handler(args, ctx) {
      const text = redacted((readString(args, 'csv', { max: MAX_DATA, example: csvExample }) ?? '').replace(/^\uFEFF/, ''), ctx)
      const delimiter = readString(args, 'delimiter', { max: 1, example: { csv: '@input', delimiter: ';' } }) ?? ','
      if (delimiter === '"' || delimiter === '\r' || delimiter === '\n' || delimiter.charCodeAt(0) < 32 && delimiter !== '\t') throw argError('Delimiter must be one non-quote, non-newline character (tab is allowed).', csvExample)
      const hasHeader = readBoolean(args, 'has_header', true)
      // snake_case or camelCase; a blank reference means "not given".
      const column = (key: string, alias: string) => {
        const ref = readString(args, key, { max: 200, example: groupExample }) ?? readString(args, alias, { max: 200, example: groupExample })
        return ref?.trim() ? ref : undefined
      }
      const groupBy = column('group_by', 'groupBy')
      const sumColumn = column('sum_column', 'sumColumn')
      const rows = parseCsv(text, delimiter)
      const headers = hasHeader ? (rows.shift() ?? []) : []
      if (rows.length > 1000) throw argError('CSV accepts at most 1,000 data rows.', csvExample)
      const width = Math.max(headers.length, ...rows.map((row) => row.length), 0)
      const expected = hasHeader ? headers.length : (rows[0]?.length ?? 0)
      const names = Array.from({ length: width }, (_, index) => headers[index] ?? `column_${index + 1}`)
      const groups = grouping(rows, names, groupBy, sumColumn)
      const columns = names.map((name, index) => summarizeColumn(rows, index, name))
      return fitJson({ rows: rows.length, column_count: width, has_header: hasHeader, inconsistent_rows: rows.filter((row) => row.length !== expected).length, ...groups, columns, sample: rows.slice(0, 5), sampled: rows.length > 5 })
    },
  },
]
