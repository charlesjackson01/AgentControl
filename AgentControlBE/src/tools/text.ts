/** Bounded, offline text operations. All replacements are literal. */
import { randomInt } from 'node:crypto'
import { argError, readBoolean, readEnum, readList, readNumber, readString } from './args.js'
import { clipText, fitJson, RESULT_MAX_CHARS } from './limits.js'
import { redactSecrets } from './redact.js'
import type { ToolContext, ToolEntry } from './types.js'

const MAX_TEXT = 50_000
const operations = ['trim', 'lowercase', 'uppercase', 'collapse_whitespace', 'sort_lines', 'dedupe_lines', 'replace'] as const
const textExample = { text: '@input' }

function content(args: Record<string, unknown>, key: string, example: Record<string, unknown>): string {
  return readString(args, key, { max: MAX_TEXT, example }) ?? ''
}

// --- process_lines and extract_entities ------------------------------------------
// Both read up to 200,000 chars. Handlers are synchronous and the run loop's
// timeout cannot interrupt them, so caps are checked before any work, every
// pass is linear, each regex is anchored with bounded quantifiers and only ever
// sees one capped line or whitespace token, and tables keyed by model input are
// Maps or Sets (never plain objects).

const MAX_LONG_TEXT = 200_000
const MAX_LINES = 5_000
/** JSON chars the main result list may use, so rows stop whole before fitJson has to halve them. */
const LIST_BUDGET = RESULT_MAX_CHARS - 500

const isDigit = (c: number): boolean => c >= 48 && c <= 57

/** readEnum's spelling tolerance (case, spaces/dashes as "_"), for synonym lookups. */
const enumKey = (value: string): string => value.trim().toLowerCase().replace(/[\s-]+/g, '_')

/** Synonym → value: the key as typed, then without a plural "s". Never matches inherited keys. */
function lookupAlias<T>(aliases: ReadonlyMap<string, T>, raw: string): T | undefined {
  if (raw.length > 64) return undefined
  const key = enumKey(raw)
  return aliases.get(key) ?? (key.endsWith('s') ? aliases.get(key.slice(0, -1)) : undefined)
}

/** "text" up to 200,000 chars; a JSON list of lines (as small models often send) is joined with "\n" after both caps pass. */
function longText(args: Record<string, unknown>, example: Record<string, unknown>): string {
  const raw = Object.hasOwn(args, 'text') ? args.text : undefined
  if (!Array.isArray(raw)) return readString(args, 'text', { max: MAX_LONG_TEXT, example }) ?? ''
  if (raw.length > MAX_LINES) throw argError(`"text" has ${raw.length} lines (max ${MAX_LINES}).`, example)
  let length = Math.max(0, raw.length - 1)
  for (const item of raw) {
    if (typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') {
      throw argError('"text" must be a string or a list of lines.', example)
    }
    length += String(item).length
  }
  if (length > MAX_LONG_TEXT) throw argError(`"text" is too long (${length} chars, max ${MAX_LONG_TEXT}).`, example)
  return raw.join('\n')
}

/** Lines as /\r\n|\r|\n/ splits them, counted without allocating; a final line break does not start a line. */
function countLines(text: string): number {
  if (text === '') return 0
  let breaks = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c === 10 || (c === 13 && text.charCodeAt(i + 1) !== 10)) breaks++
  }
  const last = text.charCodeAt(text.length - 1)
  return last === 10 || last === 13 ? breaks : breaks + 1
}

/**
 * Secrets replaced BEFORE a value is clipped. executeToolCall redacts the whole
 * result, but a clip (ours or fitJson's) through a pasted key leaves a prefix
 * ("sk-or-v1-0123…") that neither its exact-value nor its key-pattern pass matches.
 */
const redacted = (value: string, ctx: ToolContext): string => (ctx?.store ? redactSecrets(value, ctx.store) : value)

/** clipText that never leaves half a surrogate pair in front of the "…". */
function clipSafe(value: string, max: number): string {
  if (value.length <= max) return value
  let end = max - 1
  const last = value.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end--
  return `${value.slice(0, end)}…`
}

/** Up to `limit` rendered rows whose JSON fits in LIST_BUDGET chars. */
function takeWithin<T>(items: readonly T[], limit: number, render: (item: T) => unknown): { shown: unknown[]; cut: boolean } {
  const shown: unknown[] = []
  let used = 2
  for (const item of items) {
    if (shown.length >= limit) break
    const row = render(item)
    const cost = JSON.stringify(row).length + 1
    if (used + cost > LIST_BUDGET) return { shown, cut: true }
    shown.push(row)
    used += cost
  }
  return { shown, cut: false }
}

// process_lines

const lineOperations = ['sort', 'sort_desc', 'dedupe', 'count', 'filter', 'sample'] as const
type LineOperation = (typeof lineOperations)[number]
const linesExample = { operation: 'count', text: '@input' }
const LINE_CHARS = 200
const lineAliases = new Map<string, LineOperation>([
  ['asc', 'sort'], ['ascending', 'sort'], ['sort_asc', 'sort'], ['natural_sort', 'sort'], ['natural', 'sort'], ['sort_natural', 'sort'],
  ['numeric_sort', 'sort'], ['numerical_sort', 'sort'], ['sort_numeric', 'sort'], ['sort_numerically', 'sort'],
  ['alphabetical', 'sort'], ['alphabetic', 'sort'], ['alphabetize', 'sort'], ['sort_alphabetically', 'sort'],
  ['desc', 'sort_desc'], ['descending', 'sort_desc'], ['sort_descending', 'sort_desc'], ['reverse_sort', 'sort_desc'], ['sort_reverse', 'sort_desc'],
  ['dedup', 'dedupe'], ['deduplicate', 'dedupe'], ['unique', 'dedupe'], ['uniq', 'dedupe'], ['distinct', 'dedupe'], ['remove_duplicate', 'dedupe'], ['remove_dupe', 'dedupe'],
  ['frequency', 'count'], ['frequencies', 'count'], ['tally', 'count'], ['histogram', 'count'], ['most_common', 'count'],
  ['grep', 'filter'], ['find', 'filter'], ['search', 'filter'], ['contain', 'filter'], ['include', 'filter'],
  ['shuffle', 'sample'], ['random', 'sample'], ['random_sample', 'sample'], ['pick_random', 'sample'],
])
/** Default rows; other operations return every row that fits. */
const lineDefaultLimits = new Map<LineOperation, number>([['count', 20], ['filter', 50]])
/**
 * Names small models use for "match" and "limit". An ignored {"pattern":"ERROR"}
 * would silently count every line, and {"count":5} would shuffle them all.
 */
const MATCH_KEYS = ['match', 'pattern', 'query', 'search', 'contains', 'keyword', 'term', 'filter']
const LIMIT_KEYS = ['limit', 'n', 'max', 'top', 'count', 'size']

/** The first of `keys` the call set (own property, not blank); else the canonical name. */
function givenKey(args: Record<string, unknown>, keys: readonly string[]): string {
  return keys.find((key) => Object.hasOwn(args, key) && args[key] !== undefined && args[key] !== null && args[key] !== '') ?? keys[0]!
}

function readLineOperation(args: Record<string, unknown>): LineOperation {
  const raw = Object.hasOwn(args, 'operation') ? args.operation : undefined
  if (typeof raw === 'string' && raw.length <= 64) {
    // Also transform_text's names ("sort_lines", "dedupe_lines") and "count lines".
    const key = enumKey(raw).replace(/_lines?$/, '')
    const found = lookupAlias(lineAliases, key) ?? lineOperations.find((op) => op === key || `${op}s` === key)
    if (found) return found
  }
  return readEnum(args, 'operation', lineOperations, { required: true, example: linesExample })!
}

/** A plain number line ("-3.5", "1,200"); only tried on lines of at most 40 chars. */
const NUMERIC_LINE = /^[-+]?(?:\d{1,3}(?:,\d{3}){1,13}(?:\.\d{1,36})?|\d{1,40}(?:\.\d{1,40})?|\.\d{1,40})$/

interface SortItem {
  raw: string
  /** Natural-order key, compared as a plain string. */
  key: string
  num: number | null
}

/** Chars per String.fromCharCode call (well under engine argument limits). */
const KEY_CHUNK = 4_096

/**
 * Natural-order key of a lowercased line: each digit run becomes "0", one char
 * encoding its length without leading zeros, then those digits. A plain string
 * compare of two keys orders digit runs by value (length first, so long runs
 * never lose precision) and everything else by code unit. Linear in the line;
 * written into a reused buffer (a key is at most 2 × length + 1 units) so a line
 * of 100,000 digit runs costs one pass instead of 100,000 string concatenations.
 */
function naturalKey(lower: string, shared: Uint16Array): string {
  let i = 0
  while (i < lower.length && !isDigit(lower.charCodeAt(i))) i++
  if (i === lower.length) return lower
  // toLowerCase can lengthen a line ("İ" → "i̇"), so check the size here.
  const scratch = shared.length >= 2 * lower.length + 2 ? shared : new Uint16Array(2 * lower.length + 2)
  let n = 0
  for (let k = 0; k < i; k++) scratch[n++] = lower.charCodeAt(k)
  while (i < lower.length) {
    const c = lower.charCodeAt(i)
    if (!isDigit(c)) {
      scratch[n++] = c
      i++
      continue
    }
    let start = i
    while (lower.charCodeAt(start) === 48) start++
    let end = start
    while (isDigit(lower.charCodeAt(end))) end++
    scratch[n++] = 48
    scratch[n++] = 0x30 + Math.min(end - start, 0xffcf)
    for (let k = start; k < end; k++) scratch[n++] = lower.charCodeAt(k)
    i = Math.max(end, i + 1)
  }
  let key = ''
  for (let k = 0; k < n; k += KEY_CHUNK) {
    key += String.fromCharCode.apply(null, scratch.subarray(k, Math.min(n, k + KEY_CHUNK)) as unknown as number[])
  }
  return key
}

function sortItem(raw: string, scratch: Uint16Array): SortItem {
  let num: number | null = null
  if (raw.length <= 40 && NUMERIC_LINE.test(raw)) {
    const value = Number(raw.split(',').join(''))
    if (Number.isFinite(value)) num = value
  }
  return { raw, key: naturalKey(raw.toLowerCase(), scratch), num }
}

/** Plain numbers first (by value), then natural text order, then exact text. */
function compareItems(a: SortItem, b: SortItem): number {
  if (a.num !== null && b.num !== null && a.num !== b.num) return a.num - b.num
  if (a.num !== null && b.num === null) return -1
  if (a.num === null && b.num !== null) return 1
  if (a.key !== b.key) return a.key < b.key ? -1 : 1
  return a.raw < b.raw ? -1 : a.raw > b.raw ? 1 : 0
}

function processLines(text: string, operation: LineOperation, match: string | undefined, limit: number, ctx: ToolContext): Record<string, unknown> {
  const items: { n: number; text: string }[] = []
  const all = text === '' ? [] : text.split(/\r\n|\r|\n/)
  for (let i = 0; i < all.length; i++) {
    const line = (all[i] ?? '').trim()
    if (line) items.push({ n: i + 1, text: line })
  }
  const needle = match?.toLowerCase()
  const selected = needle ? items.filter((item) => item.text.toLowerCase().includes(needle)) : items
  // Rows stay within LIST_BUDGET, so fitJson never clips them: only a line clipped here needs redacting first.
  const out = (line: string) => (line.length <= LINE_CHARS ? line : clipSafe(redacted(line, ctx), LINE_CHARS))
  const base: Record<string, unknown> = { operation, nonblank_lines: items.length }
  if (needle) base.matched = selected.length

  let rows: readonly unknown[]
  let render: (row: never) => unknown
  if (operation === 'sort' || operation === 'sort_desc') {
    let longest = 0
    for (const item of selected) longest = Math.max(longest, item.text.length)
    const scratch = new Uint16Array(2 * longest + 2)
    const sorted = selected.map((item) => sortItem(item.text, scratch)).sort(compareItems)
    if (operation === 'sort_desc') sorted.reverse()
    rows = sorted
    render = (row: SortItem) => out(row.raw)
  } else if (operation === 'dedupe') {
    const unique = [...new Set(selected.map((item) => item.text))]
    base.duplicates_removed = selected.length - unique.length
    rows = unique
    render = (row: string) => out(row)
  } else if (operation === 'count') {
    const counts = new Map<string, { line: string; count: number; first: number }>()
    for (const item of selected) {
      const entry = counts.get(item.text)
      if (entry) entry.count++
      else counts.set(item.text, { line: item.text, count: 1, first: item.n })
    }
    base.distinct = counts.size
    rows = [...counts.values()].sort((a, b) => b.count - a.count || a.first - b.first)
    render = (row: { line: string; count: number }) => ({ line: out(row.line), count: row.count })
  } else if (operation === 'filter') {
    rows = selected
    render = (row: { n: number; text: string }) => `${row.n}: ${out(row.text)}`
  } else {
    // sample: partial Fisher-Yates with a CSPRNG; a limit of at least the line count is a full shuffle.
    const picked = selected.map((item) => item.text)
    const k = Math.min(limit, picked.length)
    for (let i = 0; i < k; i++) {
      const j = randomInt(i, picked.length)
      const swap = picked[i]!
      picked[i] = picked[j]!
      picked[j] = swap
    }
    rows = picked.slice(0, k)
    render = (row: string) => out(row)
  }

  const { shown, cut } = takeWithin(rows as never[], limit, render)
  return {
    ...base, total: rows.length, returned: shown.length, result: shown,
    ...(cut ? { truncated: true, hint: 'Narrow with "match" or a smaller "limit".' } : {}),
  }
}

// extract_entities

const entityKinds = ['urls', 'emails', 'dates', 'numbers'] as const
type EntityKind = (typeof entityKinds)[number]
const entitiesExample = { text: '@input', kinds: ['emails', 'urls'] }
const MAX_TOKEN = 2_048
const MAX_PER_KIND = 50
const MAX_VALUE = 200
const kindAliases = new Map<string, EntityKind>([
  ['url', 'urls'], ['link', 'urls'], ['hyperlink', 'urls'], ['website', 'urls'],
  ['email', 'emails'], ['e_mail', 'emails'], ['mail', 'emails'], ['email_address', 'emails'], ['email_addresses', 'emails'],
  ['date', 'dates'], ['datetime', 'dates'], ['timestamp', 'dates'], ['number', 'numbers'], ['num', 'numbers'],
])

/** One kinds item: a kind name, "all", or several glued together ("urls and emails", "url;email"). */
function kindsIn(item: string): EntityKind[] | 'all' | undefined {
  if (item.length > 64) return undefined
  if (enumKey(item) === 'all') return 'all'
  const kind = lookupAlias(kindAliases, item)
  if (kind) return [kind]
  const words = item.split(/[\s,;|/&+]+/).filter((word) => word !== '' && word.toLowerCase() !== 'and' && word.toLowerCase() !== 'or')
  const kinds: EntityKind[] = []
  for (const word of words) {
    if (enumKey(word) === 'all') return 'all'
    const found = lookupAlias(kindAliases, word)
    if (!found) return undefined
    kinds.push(found)
  }
  return kinds.length > 0 ? kinds : undefined
}

function readKinds(args: Record<string, unknown>): EntityKind[] {
  const list = readList(args, 'kinds', { max: 10, example: entitiesExample })
  if (!list || list.length === 0) return [...entityKinds]
  const wanted = new Set<EntityKind>()
  for (const item of list) {
    const kinds = kindsIn(item)
    if (kinds === 'all') return [...entityKinds]
    if (!kinds) throw argError(`Unknown kind "${clipText(item, 40)}". Use any of: ${entityKinds.join(', ')}.`, entitiesExample)
    for (const kind of kinds) wanted.add(kind)
  }
  return entityKinds.filter((kind) => wanted.has(kind))
}

function isSpace(c: number): boolean {
  return c === 0x20 || (c >= 0x09 && c <= 0x0d) || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200b) ||
    c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff
}

/** Whitespace tokens; a token over MAX_TOKEN chars becomes null (skipped, and it breaks a written date). */
function tokenize(text: string): { tokens: (string | null)[]; skipped: number } {
  const tokens: (string | null)[] = []
  let skipped = 0
  let start = -1
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || isSpace(text.charCodeAt(i))) {
      if (start !== -1) {
        if (i - start > MAX_TOKEN) {
          tokens.push(null)
          skipped++
        } else {
          tokens.push(text.slice(start, i))
        }
        start = -1
      }
    } else if (start === -1) {
      start = i
    }
  }
  return { tokens, skipped }
}

/** Bit 1: stripped from a token's start; bit 2: from its end. Indexed by char code. */
const PUNCT = (() => {
  const table = new Uint8Array(0x2030)
  const mark = (chars: string, bit: number) => {
    for (const ch of chars) table[ch.charCodeAt(0)] = (table[ch.charCodeAt(0)] ?? 0) | bit
  }
  mark('([{<"\'`“‘«*~¿¡', 1)
  mark(')]}>"\'`”’».,;:!?*~…', 2)
  return table
})()
const punct = (c: number): number => (c < 0x2030 ? (PUNCT[c] ?? 0) : 0)

/**
 * Strip surrounding quotes, brackets and sentence punctuation. A trailing ")"
 * stays while the token still holds a matching "(" (Wikipedia-style URLs);
 * underscores go only as a matching emphasis pair ("_a@b.io_"). Linear:
 * parentheses are counted at most once.
 */
function trimPunct(token: string): string {
  let s = 0
  let e = token.length
  while (s < e && (punct(token.charCodeAt(s)) & 1) !== 0) s++
  let open = -1
  let close = 0
  while (e > s && (punct(token.charCodeAt(e - 1)) & 2) !== 0) {
    if (token.charCodeAt(e - 1) === 0x29) {
      if (open === -1) {
        open = 0
        for (let i = s; i < e; i++) {
          const c = token.charCodeAt(i)
          if (c === 0x28) open++
          else if (c === 0x29) close++
        }
      }
      if (close <= open) break
      close--
    }
    e--
  }
  while (e - s >= 2 && token.charCodeAt(s) === 0x5f && token.charCodeAt(e - 1) === 0x5f) {
    s++
    e--
  }
  return s === 0 && e === token.length ? token : token.slice(s, e)
}

/** Digit, sign, "." or one of the currency symbols NUMBER_TOKEN accepts. */
function canStartNumber(c: number): boolean {
  return isDigit(c) || c === 0x2d || c === 0x2b || c === 0x2212 || c === 0x2e ||
    c === 0x24 || c === 0x20ac || c === 0xa3 || c === 0xa5 || c === 0x20b9
}

function allDigits(token: string): boolean {
  for (let i = 0; i < token.length; i++) if (!isDigit(token.charCodeAt(i))) return false
  return token.length > 0
}

// Anchored, bounded patterns; each only ever sees one token of at most MAX_TOKEN chars (numbers: 64).
const URL_TOKEN = /^https?:\/\/[\p{L}\p{N}.-]{1,253}(?::\d{1,5})?(?:[/?#][^\s<>"`]{0,2040})?$/iu
const EMAIL_TOKEN = /^[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9-]{1,63}\.){1,8}[A-Za-z]{2,63}$/
const ISO_DATE_TOKEN = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-](\d{2}):?(\d{2}))?)?$/i
const SLASH_DATE_TOKEN = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/
const DAY_TOKEN = /^(\d{1,2})(?:st|nd|rd|th)?$/i
const YEAR_TOKEN = /^\d{4}$/
const NUMBER_TOKEN =
  /^[-+−]?[$€£¥₹]?(?:\d{1,3}(?:,\d{3}){1,20}(?:\.\d{1,60})?|\d{1,64}(?:\.\d{1,64})?|\.\d{1,64})(?:[eE][-+]?\d{1,3})?%?$/

/** Chars that never belong to a URL in running text (plus C0 controls and DEL): the candidate is cut there. */
const URL_STOP = new Set([0x3c, 0x3e, 0x22, 0x60, 0x5b, 0x5d, 0x7c, 0x5c, 0x5e, 0x7b, 0x7d])

const MONTHS = new Map<string, number>([
  ['jan', 1], ['january', 1], ['feb', 2], ['february', 2], ['mar', 3], ['march', 3],
  ['apr', 4], ['april', 4], ['may', 5], ['jun', 6], ['june', 6], ['jul', 7], ['july', 7],
  ['aug', 8], ['august', 8], ['sep', 9], ['sept', 9], ['september', 9], ['oct', 10], ['october', 10],
  ['nov', 11], ['november', 11], ['dec', 12], ['december', 12],
])

const pad2 = (n: number) => String(n).padStart(2, '0')

/** Calendar check from numbers (never parses a string): years 1000-9999, real day of month. */
function validDate(year: number, month: number, day: number): boolean {
  if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1) return false
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = month === 2 ? (leap ? 29 : 28) : month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31
  return day <= days
}

/** A URL starting inside the token (also in `[x](url)`, `<url>` or `href="url"`). */
function urlIn(raw: string): string | undefined {
  const lower = raw.toLowerCase()
  const plain = lower.indexOf('http://')
  const secure = lower.indexOf('https://')
  const at = plain === -1 ? secure : secure === -1 ? plain : Math.min(plain, secure)
  if (at === -1) return undefined
  const quote = raw.charCodeAt(at - 1) === 0x27
  let cut = raw.length
  for (let i = at; i < raw.length; i++) {
    const c = raw.charCodeAt(i)
    if (c < 0x20 || c === 0x7f || URL_STOP.has(c) || (quote && c === 0x27)) {
      cut = i
      break
    }
  }
  const candidate = trimPunct(raw.slice(at, cut))
  if (!URL_TOKEN.test(candidate)) return undefined
  // Host: a dotted name with no empty labels, or localhost.
  const hostStart = candidate.indexOf('//') + 2
  let hostEnd = hostStart
  while (hostEnd < candidate.length && !':/?#'.includes(candidate.charAt(hostEnd))) hostEnd++
  const host = candidate.slice(hostStart, hostEnd).toLowerCase()
  const dotted = host.includes('.') && !host.startsWith('.') && !host.endsWith('.') && !host.includes('..') && !host.startsWith('-')
  if (!dotted && host !== 'localhost') return undefined
  // URL_TOKEN allows at most 5 port digits; a real port is at most 65535.
  let port = 0
  if (candidate.charCodeAt(hostEnd) === 0x3a) {
    for (let i = hostEnd + 1; i < candidate.length && isDigit(candidate.charCodeAt(i)); i++) port = port * 10 + candidate.charCodeAt(i) - 48
  }
  return port <= 65535 ? candidate : undefined
}

/**
 * Labels allowed before an email inside one token ("mailto:a@b.io", "Email:a@b.io").
 * Any other "x:" prefix may be URL userinfo ("redis://:password@host.com",
 * "user:password@host.com"), so the part after the colon is not an email.
 */
const EMAIL_PREFIXES = new Set(['mailto', 'email', 'e-mail', 'mail', 'from', 'to', 'cc', 'bcc', 'reply-to', 'contact', 'sender'])

function emailIn(token: string): string | undefined {
  const at = token.indexOf('@')
  const colon = token.lastIndexOf(':', at)
  if (colon !== -1 && (colon > 16 || !EMAIL_PREFIXES.has(token.slice(0, colon).toLowerCase()))) return undefined
  const candidate = colon === -1 ? token : token.slice(colon + 1)
  const domainLength = token.length - at - 1
  if (at - colon - 1 > 64 || domainLength > 253 || !EMAIL_TOKEN.test(candidate)) return undefined
  return candidate
}

/** ISO date or datetime (also yyyy/mm/dd); a date-only value dedupes by calendar date. */
function isoDateIn(token: string): { key: string } | undefined {
  if (token.length < 8 || token.length > 40) return undefined
  const iso = ISO_DATE_TOKEN.exec(token)
  const m = iso ?? SLASH_DATE_TOKEN.exec(token)
  if (!m) return undefined
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  if (!validDate(year, month, day)) return undefined
  if (iso && iso[4] !== undefined) {
    if (Number(iso[4]) > 23 || Number(iso[5]) > 59 || (iso[6] !== undefined && Number(iso[6]) > 59)) return undefined
    if (iso[7] !== undefined && (Number(iso[7]) > 23 || Number(iso[8]) > 59)) return undefined // UTC offset
    return { key: token.toUpperCase() }
  }
  return { key: `${year}-${pad2(month)}-${pad2(day)}` }
}

/** "March 5, 2027", "Mar 5th 2027" or "5 March 2027" across three tokens of at most 12 chars. */
function writtenDateAt(tokens: (string | null)[], i: number): { key: string; value: string } | undefined {
  const t0 = tokens[i]
  const t1 = tokens[i + 1]
  const t2 = tokens[i + 2]
  if (!t0 || !t1 || !t2 || t0.length > 12 || t1.length > 12 || t2.length > 12) return undefined
  const a = trimPunct(t0)
  const b = trimPunct(t1)
  const c = trimPunct(t2)
  if (!YEAR_TOKEN.test(c)) return undefined
  const monthFirst = MONTHS.get(a.toLowerCase())
  const month = monthFirst ?? MONTHS.get(b.toLowerCase())
  if (month === undefined) return undefined
  const dayMatch = DAY_TOKEN.exec(monthFirst !== undefined ? b : a)
  if (!dayMatch) return undefined
  const year = Number(c)
  const day = Number(dayMatch[1])
  if (!validDate(year, month, day)) return undefined
  return { key: `${year}-${pad2(month)}-${pad2(day)}`, value: monthFirst !== undefined ? `${a} ${b}, ${c}` : `${a} ${b} ${c}` }
}

/**
 * Chars that glue values into one whitespace token in CSV and log rows,
 * "key=value" fields, compact JSON and "a@b.io;c@d.io" lists. Never part of an
 * email or ISO date. The apostrophe is left out ("o'brien@x.io" stays whole).
 */
const GLUE = new Set([0x2c, 0x3b, 0x3d, 0x7c, 0x22, 0x3c, 0x3e, 0x28, 0x29, 0x5b, 0x5d, 0x7b, 0x7d, 0x26, 0x3f]) // , ; = | " < > ( ) [ ] { } & ?

/**
 * Emails and ISO dates glued into a token whose whole was no email, date or
 * number (or was a URL): one linear split, no recursion. Parts holding "://"
 * are URL pieces and are skipped; emailIn's prefix rule keeps userinfo out.
 */
function gluedValues(token: string, onEmail: ((email: string) => void) | undefined, onDate: ((key: string, value: string) => void) | undefined): void {
  let start = 0
  for (let i = 0; i <= token.length; i++) {
    if (i < token.length && !GLUE.has(token.charCodeAt(i))) continue
    if (start === 0 && i === token.length) return // no glue: the whole token was already checked
    const part = i - start >= 6 ? trimPunct(token.slice(start, i)) : ''
    start = i + 1
    if (part.length < 6 || part.includes('://')) continue // too short, or a URL piece
    if (part.includes('@')) {
      const email = onEmail ? emailIn(part) : undefined
      if (email) onEmail!(email)
    } else if (onDate && part.length >= 8 && isDigit(part.charCodeAt(0))) {
      const date = isoDateIn(part)
      if (date) onDate(date.key, part)
    }
  }
}

/** Deduped values of one kind: the first MAX_PER_KIND are kept, every distinct key is counted. */
class EntityBucket {
  readonly values: string[] = []
  private readonly seen = new Set<string>()
  private readonly ctx: ToolContext
  constructor(ctx: ToolContext) {
    this.ctx = ctx
  }
  add(key: string, value: string): void {
    if (this.seen.has(key)) return
    this.seen.add(key)
    // fitJson may clip any value over 80 chars when the result is over budget, so redact every one first.
    if (this.values.length < MAX_PER_KIND) this.values.push(clipSafe(redacted(value, this.ctx), MAX_VALUE))
  }
  get total(): number {
    return this.seen.size
  }
}

function extractEntities(text: string, kinds: readonly EntityKind[], ctx: ToolContext): Record<string, unknown> {
  const want = new Set(kinds)
  const buckets = new Map<EntityKind, EntityBucket>(entityKinds.map((kind) => [kind, new EntityBucket(ctx)]))
  const bucket = (kind: EntityKind) => buckets.get(kind)!
  const { tokens, skipped } = tokenize(text)
  const wantDates = want.has('dates')
  const wantNumbers = want.has('numbers')
  const onEmail = want.has('emails') ? (email: string) => bucket('emails').add(email.toLowerCase(), email) : undefined
  const onDate = wantDates ? (key: string, value: string) => bucket('dates').add(key, value) : undefined
  for (let i = 0; i < tokens.length; i++) {
    const raw = tokens[i]
    if (!raw) continue
    // Cheap prefilters first: most tokens are plain words and stop here.
    const year = tokens[i + 2]
    if (wantDates && year && year.length >= 4 && year.length <= 6 && isDigit(year.charCodeAt(0))) {
      const written = writtenDateAt(tokens, i)
      if (written) {
        bucket('dates').add(written.key, written.value)
        i += 2
        continue
      }
    }
    if (raw.length >= 10 && raw.includes('://')) {
      const url = urlIn(raw)
      if (url) {
        if (want.has('urls')) bucket('urls').add(url, url)
        if (onEmail || onDate) gluedValues(raw, onEmail, onDate) // {"url":"https://…","to":"a@b.io"}
        continue
      }
    }
    const token = trimPunct(raw)
    if (token === '') continue
    if (token.length >= 6 && token.includes('@')) {
      const email = emailIn(token)
      if (email) {
        if (want.has('emails')) bucket('emails').add(email.toLowerCase(), email)
        continue
      }
    }
    const first = token.charCodeAt(0)
    if (token.length >= 8 && isDigit(first)) {
      const date = isoDateIn(token)
      if (date) {
        if (wantDates) bucket('dates').add(date.key, token)
        continue
      }
    }
    if (token.length <= 64 && (allDigits(token) || (canStartNumber(first) && NUMBER_TOKEN.test(token)))) {
      if (wantNumbers) bucket('numbers').add(token, token)
      continue
    }
    // "a@b.io,c@d.io", "x,a@b.io,2026-10-12", "user=a@b.io", {"at":"2026-10-12"}. Numbers are
    // not split out of a token ("12,34" may be a decimal).
    if (token.length >= 6 && (onEmail || onDate)) gluedValues(token, onEmail, onDate)
  }

  const result: Record<string, unknown> = {}
  const counts: Record<string, number> = {}
  let over = false
  for (const kind of kinds) {
    const found = bucket(kind)
    result[kind] = found.values
    counts[kind] = found.total
    if (found.total > found.values.length) over = true
  }
  result.counts = counts
  if (over) result.truncated = true
  if (skipped > 0) result.skipped_long_tokens = skipped
  return result
}

export const textTools: ToolEntry[] = [
  {
    name: 'text_stats', category: 'text', effect: 'read',
    description: 'Count Unicode characters, words, lines and nonblank lines in up to 50,000 chars. Text defaults to @input; @note:<id> also works. Example: {"text":"@input"}',
    parameters: { type: 'object', properties: { text: { type: 'string' } } },
    contentParams: { names: ['text'], defaultParam: 'text' },
    handler(args) {
      const text = content(args, 'text', textExample)
      const lines = text ? text.split(/\r\n|\r|\n/) : []
      return {
        characters: Array.from(text).length,
        utf16_units: text.length,
        words: (text.match(/[\p{L}\p{N}_]+(?:['’][\p{L}\p{N}_]+)*/gu) ?? []).length,
        lines: lines.length,
        nonblank_lines: lines.filter((line) => line.trim().length > 0).length,
      }
    },
  },
  {
    name: 'transform_text', category: 'text', effect: 'read',
    description: 'Transform up to 50,000 chars; returns a bounded preview if long. Replace is literal, case-sensitive and replaces all matches. Text defaults to @input. Example: {"operation":"trim","text":"@input"}',
    parameters: {
      type: 'object', properties: {
        text: { type: 'string' }, operation: { type: 'string', enum: operations },
        find: { type: 'string' }, replacement: { type: 'string' },
      }, required: ['operation'],
    },
    contentParams: { names: ['text'], defaultParam: 'text' },
    handler(args) {
      const example = { operation: 'trim', text: '@input' }
      const text = content(args, 'text', example)
      const operation = readEnum(args, 'operation', operations, { required: true, example })!
      let result: string
      switch (operation) {
        case 'trim': result = text.trim(); break
        case 'lowercase': result = text.toLowerCase(); break
        case 'uppercase': result = text.toUpperCase(); break
        case 'collapse_whitespace': result = text.trim().replace(/\s+/g, ' '); break
        case 'sort_lines': result = text.split(/\r\n|\r|\n/).sort().join('\n'); break
        case 'dedupe_lines': result = [...new Set(text.split(/\r\n|\r|\n/))].join('\n'); break
        case 'replace': {
          const replaceExample = { operation: 'replace', text: '@input', find: 'old', replacement: 'new' }
          const find = readString(args, 'find', { required: true, max: 1000, example: replaceExample })!
          const replacement = readString(args, 'replacement', { max: 1000, example: replaceExample }) ?? ''
          const parts = text.split(find)
          const length = text.length + (parts.length - 1) * (replacement.length - find.length)
          if (length > 100_000) throw argError('Replacement result exceeds 100,000 chars; use a shorter replacement.', replaceExample)
          result = parts.join(replacement)
          break
        }
      }
      return fitJson({ operation, text: result, characters: Array.from(result).length })
    },
  },
  {
    name: 'compare_text', category: 'text', effect: 'read',
    description: 'Compare up to 50,000 chars and 3,000 lines per side. Reports positional line differences, not an edit script; excerpts may be clipped. Supports content refs. Example: {"left":"@input","right":"@note:Draft"}',
    parameters: {
      type: 'object', properties: {
        left: { type: 'string' }, right: { type: 'string' },
        ignore_case: { type: 'boolean' }, ignore_whitespace: { type: 'boolean' },
      }, required: ['left', 'right'],
    },
    contentParams: { names: ['left', 'right'] },
    handler(args) {
      const example = { left: 'before', right: 'after' }
      for (const key of ['left', 'right']) {
        if (!Object.hasOwn(args, key) || args[key] == null) throw argError(`"${key}" is required.`, example)
      }
      const left = content(args, 'left', example)
      const right = content(args, 'right', example)
      const foldCase = readBoolean(args, 'ignore_case', false)
      const foldSpace = readBoolean(args, 'ignore_whitespace', false)
      const normalize = (value: string) => {
        let result = foldCase ? value.toLowerCase() : value
        if (foldSpace) result = result.trim().replace(/\s+/g, ' ')
        return result
      }
      const leftLines = left ? left.split(/\r\n|\r|\n/) : []
      const rightLines = right ? right.split(/\r\n|\r|\n/) : []
      if (Math.max(leftLines.length, rightLines.length) > 3000) throw argError('Compare accepts at most 3,000 lines per side.', example)
      const differences: { line: number; left: string | null; right: string | null }[] = []
      let differentLines = 0
      for (let i = 0; i < Math.max(leftLines.length, rightLines.length); i++) {
        const a = leftLines[i]
        const b = rightLines[i]
        if (a === undefined || b === undefined || normalize(a) !== normalize(b)) {
          differentLines++
          if (differences.length < 20) differences.push({ line: i + 1, left: a === undefined ? null : clipText(a, 160), right: b === undefined ? null : clipText(b, 160) })
        }
      }
      return fitJson({ equal: differentLines === 0, comparison: 'positional_lines', left_lines: leftLines.length, right_lines: rightLines.length, different_lines: differentLines, differences, truncated: differentLines > differences.length || differences.some((d) => (leftLines[d.line - 1]?.length ?? 0) > 160 || (rightLines[d.line - 1]?.length ?? 0) > 160) })
    },
  },
  {
    name: 'process_lines', category: 'text', effect: 'read',
    description: 'Sort (natural: 2 before 10), sort_desc, dedupe, count, filter or sample up to 5,000 trimmed lines (200,000 chars); blank lines skipped; match narrows any operation. Text defaults to @input. Example: {"operation":"count","match":"error"}',
    parameters: {
      type: 'object', properties: {
        text: { type: 'string' }, operation: { type: 'string', enum: lineOperations },
        match: { type: 'string', description: 'Case-insensitive substring; required for filter.' },
        limit: { type: 'number', description: 'Max rows; for sample, how many random lines (default: count 20, filter 50, others all that fit).' },
      }, required: ['operation'],
    },
    contentParams: { names: ['text'], defaultParam: 'text' },
    handler(args, ctx) {
      const operation = readLineOperation(args)
      const match = readString(args, givenKey(args, MATCH_KEYS), { max: 200, example: { operation: 'filter', match: 'error' } })?.trim() || undefined
      if (operation === 'filter' && !match) throw argError('"match" is required for filter (the text to look for).', { operation: 'filter', match: 'error' })
      const requested = readNumber(args, givenKey(args, LIMIT_KEYS), { min: 1, example: { operation: 'sample', limit: 5 } })
      const limit = Math.min(MAX_LINES, Math.floor(requested ?? lineDefaultLimits.get(operation) ?? MAX_LINES))
      const text = longText(args, linesExample)
      const lines = countLines(text)
      if (lines > MAX_LINES) throw argError(`"text" has ${lines} lines (max ${MAX_LINES}). Pass a smaller section.`, linesExample)
      return fitJson(processLines(text, operation, match, limit, ctx))
    },
  },
  {
    name: 'extract_entities', category: 'text', effect: 'read',
    description: 'Find URLs, emails, dates (ISO or "March 5, 2027") and numbers in up to 200,000 chars; deduped, at most 50 per kind, with counts. Text defaults to @input. Example: {"text":"@input","kinds":["emails","urls"]}',
    parameters: {
      type: 'object', properties: {
        text: { type: 'string' },
        kinds: { type: 'array', items: { type: 'string', enum: entityKinds }, description: 'Default: all kinds.' },
      },
    },
    contentParams: { names: ['text'], defaultParam: 'text' },
    handler(args, ctx) {
      const kinds = readKinds(args)
      return fitJson(extractEntities(longText(args, entitiesExample), kinds, ctx))
    },
  },
]
