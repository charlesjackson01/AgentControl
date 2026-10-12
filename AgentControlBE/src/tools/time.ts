import { argError, readEnum, readNumber, readString } from './args.js'
import { clipText, fitJson } from './limits.js'
import type { ToolContext, ToolEntry } from './types.js'

const durations = { millisecond: 1, second: 1000, minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 604_800_000 } as const
const durationUnits = ['millisecond', 'second', 'minute', 'hour', 'day', 'week'] as const

/** Explicit zones avoid dependence on the host clock zone; reject rollover dates. */
function readDate(args: Record<string, unknown>, key: string, example: Record<string, unknown>): Date {
  const raw = readString(args, key, { required: true, max: 40, example })!
  const value = raw.trim()
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2}))?$/.exec(value)
  const invalid = () => argError(`"${key}" must be a valid ISO date (YYYY-MM-DD) or timestamp with seconds and Z/offset.`, example)
  if (!match) throw invalid()
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3])
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]!) throw invalid()
  if (match[4] !== undefined && (Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59)) throw invalid()
  const offset = match[8]
  if (offset && offset !== 'Z' && (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4)) > 59)) throw invalid()
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) throw invalid()
  return date
}

// --- resolve_date (decisions 11 and 24) ---------------------------------------
//
// Strict ISO only, never Date.parse or new Date(text): y/m/d are round-trip
// validated and years stay in 1000-9999. Date-only values are calendar dates;
// a date-time without an offset is read in time_zone through Intl, never V8
// local time. Month/quarter/year shifts clamp to the month end and business
// days are O(1) for any count. Inputs are capped at 64 chars before any work,
// regexes only ever run on those capped strings, and every lookup keyed by
// model text is a Map.

type Example = Record<string, unknown>

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000
/** Longest expression or "from" accepted (decision 24). */
const PHRASE_MAX = 64
const MIN_YEAR = 1000
const MAX_YEAR = 9999

const RESOLVE_EXAMPLE: Example = { expression: 'next friday' }
const FROM_EXAMPLE: Example = { expression: 'in 2 weeks', from: '2027-03-01' }
const ZONE_EXAMPLE: Example = { expression: 'today', time_zone: 'America/Chicago' }

const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December',
] as const

const mod = (a: number, n: number): number => ((a % n) + n) % n
const pad = (n: number, width = 2): string => String(n).padStart(width, '0')

// Calendar arithmetic on day numbers (days since 1970-01-01, UTC).
const isLeapYear = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
const daysInMonth = (y: number, m: number): number =>
  m === 2 ? (isLeapYear(y) ? 29 : 28) : m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31
/** Callers keep y within 1000-9999 (Date.UTC maps years 0-99 to 1900+). */
const dayNumber = (y: number, m: number, d: number): number => Date.UTC(y, m - 1, d) / DAY_MS

function civil(dn: number): { y: number; m: number; d: number } {
  const date = new Date(dn * DAY_MS)
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() }
}

/** 0 = Monday … 6 = Sunday (day 0, 1970-01-01, was a Thursday). */
const weekdayIndex = (dn: number): number => mod(dn + 3, 7)
const weekdayName = (dn: number): string => WEEKDAY_NAMES[weekdayIndex(dn)] ?? ''
const shortWeekday = (dn: number): string => weekdayName(dn).slice(0, 3)
const monthName = (m: number): string => MONTH_NAMES[m - 1] ?? ''

const MIN_DN = dayNumber(MIN_YEAR, 1, 1)
const MAX_DN = dayNumber(MAX_YEAR, 12, 31)
const inRange = (dn: number): boolean => dn >= MIN_DN && dn <= MAX_DN
/** Instants handed to Intl stay within a few days of the supported range. */
const LOW_MS = (MIN_DN - 2) * DAY_MS
const HIGH_MS = (MAX_DN + 3) * DAY_MS

/**
 * `n` business days (Mon-Fri) from `dn`, like a spreadsheet WORKDAY: a
 * weekend start counts from the Friday before (forward) or the Monday after
 * (backward). O(1) for any n.
 */
function addBusinessDays(dn: number, n: number): number {
  if (n === 0) return dn
  const wd = weekdayIndex(dn)
  if (n > 0) {
    const start = wd === 5 ? dn - 1 : wd === 6 ? dn - 2 : dn
    const rem = n % 5
    return start + Math.floor(n / 5) * 7 + rem + (weekdayIndex(start) + rem >= 5 ? 2 : 0)
  }
  const k = -n
  const start = wd === 5 ? dn + 2 : wd === 6 ? dn + 1 : dn
  const rem = k % 5
  return start - Math.floor(k / 5) * 7 - rem - (weekdayIndex(start) - rem < 0 ? 2 : 0)
}

/** Resolved zone plus a numeric-parts formatter built once per call (no cache keyed by model text). */
interface Env {
  zone: string
  parts: Intl.DateTimeFormat
  example: Example
  /** Argument being parsed, named in phrase errors ("expression" or "from"). */
  param: 'expression' | 'from'
}

/** Accepts exactly what current_time accepts (anything Intl takes), named by Intl's resolved zone. */
function zoneEnv(args: Record<string, unknown>, ctx: ToolContext): Env {
  const timeZone = readString(args, 'time_zone', { max: 100, example: ZONE_EXAMPLE })?.trim() ?? ctx.timeZone
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
      hourCycle: 'h23',
    })
    return { zone: parts.resolvedOptions().timeZone, parts, example: RESOLVE_EXAMPLE, param: 'expression' }
  } catch { throw argError('Unknown time zone; use an IANA zone such as America/Chicago or UTC.', ZONE_EXAMPLE) }
}

/** UTC offset (ms, local minus UTC) of the zone at instant `ms`. */
function offsetAt(ms: number, env: Env): number {
  let y = 0, m = 0, d = 0, h = 0, mi = 0, s = 0
  for (const part of env.parts.formatToParts(ms)) {
    const v = Number(part.value)
    if (part.type === 'year') y = v
    else if (part.type === 'month') m = v
    else if (part.type === 'day') d = v
    else if (part.type === 'hour') h = v
    else if (part.type === 'minute') mi = v
    else if (part.type === 'second') s = v
  }
  return Date.UTC(y, m - 1, d, h, mi, s) - (ms - mod(ms, 1000))
}

/**
 * Instant for a local wall-clock time (ms as if UTC). Ambiguous times (clocks
 * fall back) take the earlier instant; skipped times (clocks spring forward)
 * move forward by the gap, like Temporal's "compatible" disambiguation.
 * `last` (the 23:59:59.999 of an "end of …" date) takes the later instant and
 * the last one before a gap instead, so the end of a day never lands an hour
 * early (Asia/Beirut falls back at midnight) or on the next day (America/Nuuk
 * springs forward at 23:00).
 */
function fromWall(wall: number, env: Env, last = false): number {
  const before = offsetAt(wall - DAY_MS, env)
  const after = offsetAt(wall + DAY_MS, env)
  let best: number | undefined
  for (const offset of before === after ? [before] : [before, after]) {
    const t = wall - offset
    if (offsetAt(t, env) === offset && (best === undefined || (last ? t > best : t < best))) best = t
  }
  return best ?? wall - (last ? after : before)
}

/**
 * A resolved point in time. `date` moments are calendar dates (wall = local
 * midnight, or 23:59:59.999 for "end of …"); `instant` moments carry a time.
 * `wall` is the local wall-clock time in the zone, as ms since the epoch.
 */
interface Moment {
  kind: 'date' | 'instant'
  ms: number
  wall: number
  end: boolean
}

interface Resolved {
  moment: Moment
  interpreted: string
}

const dnOf = (m: Moment): number => Math.floor(m.wall / DAY_MS)

function outOfRange(env: Env): Error {
  return argError(`The date is outside the supported range (years ${MIN_YEAR}-${MAX_YEAR}).`, env.example)
}

function checkDn(dn: number, env: Env): void {
  if (!inRange(dn)) throw outOfRange(env)
}

function checkYear(y: number, env: Env): void {
  if (!(y >= MIN_YEAR && y <= MAX_YEAR)) throw outOfRange(env)
}

function dateMoment(dn: number, env: Env, end = false): Moment {
  checkDn(dn, env)
  const wall = dn * DAY_MS + (end ? DAY_MS - 1 : 0)
  return { kind: 'date', ms: fromWall(wall, env, end), wall, end }
}

/** In range when its UTC or its local date is, so "9999-12-31T23:59Z" works east of UTC. */
function instantMoment(ms: number, env: Env): Moment {
  if (!(ms >= LOW_MS && ms <= HIGH_MS)) throw outOfRange(env)
  const wall = ms + offsetAt(ms, env)
  if (!inRange(Math.floor(wall / DAY_MS)) && !inRange(Math.floor(ms / DAY_MS))) throw outOfRange(env)
  return { kind: 'instant', ms, wall, end: false }
}

function wallMoment(wall: number, env: Env): Moment {
  checkDn(Math.floor(wall / DAY_MS), env)
  return instantMoment(fromWall(wall, env), env)
}

function dateText(dn: number): string {
  const c = civil(dn)
  return `${pad(c.y, 4)}-${pad(c.m)}-${pad(c.d)}`
}

function timeText(wall: number): string {
  const t = mod(wall, DAY_MS)
  return `${pad(Math.floor(t / HOUR_MS))}:${pad(Math.floor((t % HOUR_MS) / MINUTE_MS))}:${pad(Math.floor((t % MINUTE_MS) / 1000))}`
}

/** ±HH:MM for a whole-minute offset. */
function offsetText(offset: number): string {
  const minutes = Math.round(Math.abs(offset) / MINUTE_MS)
  return `${offset < 0 ? '-' : '+'}${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`
}

/**
 * Local ISO date-time with the zone's offset at that instant, always ±HH:MM so
 * the result is valid input for "from", date_difference and add_date. A
 * sub-minute offset (pre-1900 local mean time, e.g. -04:56:02) is rounded
 * toward the middle of the day, so reading the iso back stays on the same
 * local date; `rounded` reports it.
 */
function isoText(ms: number, env: Env): { iso: string; rounded: boolean } {
  const offset = offsetAt(ms, env)
  const wall = ms + offset
  const rounded = offset % MINUTE_MS !== 0
  const round = mod(wall, DAY_MS) < DAY_MS / 2 ? Math.floor : Math.ceil
  const shown = rounded ? round(offset / MINUTE_MS) * MINUTE_MS : offset
  return { iso: `${dateText(Math.floor(wall / DAY_MS))}T${timeText(wall)}${offsetText(shown)}`, rounded }
}

/** "Mon 2026-10-12" for dates, "Mon 2026-10-12 11:30" for instants. */
function refLabel(m: Moment): string {
  const dn = dnOf(m)
  const day = `${shortWeekday(dn)} ${dateText(dn)}`
  return m.kind === 'date' ? day : `${day} ${timeText(m.wall).slice(0, 5)}`
}

/** Decision 11's pattern with capture groups; only ever run on ≤64 chars. */
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?)?$/

/** Day number for y-m-d, round-trip validated through Date.UTC. */
function validDay(y: number, m: number, d: number, text: string, env: Env): number {
  const t = Date.UTC(y, m - 1, d)
  const back = new Date(t)
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) {
    const detail = m >= 1 && m <= 12 ? ` (${monthName(m)} ${y} has ${daysInMonth(y, m)} days)` : ' (months are 01-12)'
    throw argError(`"${text}" is not a real date${detail}.`, env.example)
  }
  return t / DAY_MS
}

function parseIso(text: string, env: Env): Resolved | undefined {
  // Accept "2026-10-12 14:00" and lowercase t/z; the structure stays strict.
  const spaced = /^\d{4}-\d{2}-\d{2} \d/.test(text)
  const match = ISO_RE.exec((spaced ? `${text.slice(0, 10)}T${text.slice(11)}` : text).toUpperCase())
  if (!match) return undefined
  const y = Number(match[1])
  if (y < MIN_YEAR || y > MAX_YEAR) throw argError(`"${text}" is outside the supported years ${MIN_YEAR}-${MAX_YEAR}.`, env.example)
  const dn = validDay(y, Number(match[2]), Number(match[3]), text, env)
  if (match[4] === undefined) return { moment: dateMoment(dn, env), interpreted: 'ISO date (a calendar date)' }

  const h = Number(match[4]), mi = Number(match[5]), s = Number(match[6] ?? 0)
  const ms = Number((match[7] ?? '').padEnd(3, '0'))
  if (h > 23 || mi > 59 || s > 59) throw argError(`"${text}" has an invalid time (00:00:00-23:59:59).`, env.example)
  const wall = dn * DAY_MS + h * HOUR_MS + mi * MINUTE_MS + s * 1000 + ms
  const zone = match[8]
  if (zone === undefined) return { moment: wallMoment(wall, env), interpreted: `ISO date-time read in ${env.zone}` }
  let offset = 0
  if (zone !== 'Z') {
    const oh = Number(zone.slice(1, 3)), om = Number(zone.slice(4, 6))
    if (oh > 18 || om > 59 || (oh === 18 && om > 0)) throw argError(`"${text}" has an invalid UTC offset (max ±18:00).`, env.example)
    offset = (zone.startsWith('-') ? -1 : 1) * (oh * HOUR_MS + om * MINUTE_MS)
  }
  return { moment: instantMoment(wall - offset, env), interpreted: 'ISO date-time with an explicit offset' }
}

type ShiftUnit = 'minute' | 'hour' | 'day' | 'week' | 'month' | 'quarter' | 'year' | 'business'

const SHIFT_UNITS = new Map<string, ShiftUnit>([
  ['minute', 'minute'], ['minutes', 'minute'], ['min', 'minute'], ['mins', 'minute'],
  ['hour', 'hour'], ['hours', 'hour'], ['hr', 'hour'], ['hrs', 'hour'], ['h', 'hour'],
  ['day', 'day'], ['days', 'day'], ['d', 'day'],
  ['week', 'week'], ['weeks', 'week'], ['wk', 'week'], ['wks', 'week'], ['w', 'week'],
  ['month', 'month'], ['months', 'month'], ['mo', 'month'], ['mos', 'month'],
  ['quarter', 'quarter'], ['quarters', 'quarter'],
  ['year', 'year'], ['years', 'year'], ['yr', 'year'], ['yrs', 'year'], ['y', 'year'],
  ['businessday', 'business'], ['businessdays', 'business'], ['workday', 'business'],
  ['workdays', 'business'], ['weekday', 'business'], ['weekdays', 'business'],
])

const SHIFT_LABELS = new Map<ShiftUnit, string>([
  ['minute', 'minute'], ['hour', 'hour'], ['day', 'day'], ['week', 'week'],
  ['month', 'month'], ['quarter', 'quarter'], ['year', 'year'], ['business', 'business day'],
])

const NUMBER_WORDS = new Map<string, number>([
  ['a', 1], ['an', 1], ['one', 1], ['two', 2], ['three', 3], ['four', 4], ['five', 5], ['six', 6],
  ['seven', 7], ['eight', 8], ['nine', 9], ['ten', 10], ['eleven', 11], ['twelve', 12],
])

const WEEKDAYS = new Map<string, number>([
  ['monday', 0], ['mon', 0], ['tuesday', 1], ['tue', 1], ['tues', 1],
  ['wednesday', 2], ['wed', 2], ['thursday', 3], ['thu', 3], ['thur', 3], ['thurs', 3],
  ['friday', 4], ['fri', 4], ['saturday', 5], ['sat', 5], ['sunday', 6], ['sun', 6],
])

const MONTHS = new Map<string, number>([
  ['january', 1], ['jan', 1], ['february', 2], ['feb', 2], ['march', 3], ['mar', 3],
  ['april', 4], ['apr', 4], ['may', 5], ['june', 6], ['jun', 6], ['july', 7], ['jul', 7],
  ['august', 8], ['aug', 8], ['september', 9], ['sep', 9], ['sept', 9], ['october', 10],
  ['oct', 10], ['november', 11], ['nov', 11], ['december', 12], ['dec', 12],
])

const FIXED_DAYS = new Map<string, number>([
  ['today', 0], ['tomorrow', 1], ['yesterday', -1], ['day after tomorrow', 2], ['day before yesterday', -2],
])

type WeekdayMode = 'next' | 'last' | 'this'
const WEEKDAY_MODES = new Map<string, WeekdayMode>([
  ['next', 'next'], ['coming', 'next'], ['last', 'last'], ['previous', 'last'], ['past', 'last'], ['this', 'this'],
])

/** "next week" = in 1 week; "this week" is not a shift. */
const SHIFT_WORDS = new Map<string, number>([['next', 1], ['coming', 1], ['last', -1], ['previous', -1], ['past', -1]])

type Period = 'day' | 'week' | 'month' | 'quarter' | 'year'
const PERIODS = new Map<string, Period>([
  ['day', 'day'], ['week', 'week'], ['month', 'month'], ['quarter', 'quarter'], ['year', 'year'],
])
const PERIOD_SHIFTS = new Map<string, number>([
  ['this', 0], ['current', 0], ['next', 1], ['coming', 1], ['last', -1], ['previous', -1],
])
const EDGES = new Map<string, 'start' | 'end'>([['start', 'start'], ['beginning', 'start'], ['begin', 'start'], ['end', 'end']])

// Anchored, no nested quantifiers, and only run on single tokens of a ≤64-char phrase.
const COUNT_RE = /^[+-]?\d{1,8}$/
const DAY_RE = /^(\d{1,2})(?:st|nd|rd|th)?$/
const YEAR_RE = /^\d{4}$/
const COMPACT_RE = /^([+-]?\d{1,8})([a-z]{1,12})$/

function readCount(token: string | undefined): number | undefined {
  if (token === undefined) return undefined
  if (COUNT_RE.test(token)) return Number(token) + 0
  return NUMBER_WORDS.get(token)
}

/** Lowercase tokens; "3days" → "3 days", "business days" → "businessdays", "the" dropped. */
function tokenize(text: string): string[] {
  const raw = text.toLowerCase().split(',').join(' ').split(/\s+/)
  const out: string[] = []
  for (let i = 0; i < raw.length; i++) {
    let token = raw[i] ?? ''
    if (token.endsWith('.')) token = token.slice(0, -1)
    if (token === '' || token === 'the') continue
    const next = raw[i + 1]
    if ((token === 'business' || token === 'working' || token === 'work') && (next === 'day' || next === 'days')) {
      out.push('businessdays')
      i++
      continue
    }
    const compact = COMPACT_RE.exec(token)
    if (compact?.[1] && compact[2] && SHIFT_UNITS.has(compact[2])) {
      out.push(compact[1], compact[2])
      continue
    }
    out.push(token)
  }
  if (out[0] === 'on') out.shift()
  return out
}

function weekdayPhrase(tokens: string[], base: Moment, env: Env): Resolved | undefined {
  let mode: WeekdayMode | 'bare' | undefined
  let target: number | undefined
  if (tokens.length === 1) {
    mode = 'bare'
    target = WEEKDAYS.get(tokens[0] ?? '')
  } else if (tokens.length === 2) {
    mode = WEEKDAY_MODES.get(tokens[0] ?? '')
    target = WEEKDAYS.get(tokens[1] ?? '')
  }
  if (mode === undefined || target === undefined) return undefined
  const dn = dnOf(base)
  const wd = weekdayIndex(dn)
  const name = WEEKDAY_NAMES[target] ?? ''
  const from = `${shortWeekday(dn)} ${dateText(dn)}`
  if (mode === 'this') {
    return { moment: dateMoment(dn - wd + target, env), interpreted: `this ${name}: the ${name} of the Monday-Sunday week containing ${from}` }
  }
  if (mode === 'last') {
    return { moment: dateMoment(dn - (mod(wd - target, 7) || 7), env), interpreted: `last ${name}: the most recent ${name} before ${from}` }
  }
  return {
    moment: dateMoment(dn + (mod(target - wd, 7) || 7), env),
    interpreted: `${mode === 'bare' ? name : `next ${name}`}: the first ${name} after ${from}`,
  }
}

function edgePhrase(tokens: string[], base: Moment, env: Env): Resolved | undefined {
  let edge: 'start' | 'end' | undefined
  let rest: string[] = []
  const [t0, t1, t2] = tokens
  if ((t0 === 'first' || t0 === 'last') && t1 === 'day' && t2 === 'of') {
    edge = t0 === 'first' ? 'start' : 'end'
    rest = tokens.slice(3)
  } else if (t1 === 'of') {
    edge = EDGES.get(t0 ?? '')
    rest = tokens.slice(2)
  }
  if (!edge || rest.length < 1 || rest.length > 2) return undefined
  const shift = rest.length === 2 ? PERIOD_SHIFTS.get(rest[0] ?? '') : 0
  const period = PERIODS.get(rest[rest.length - 1] ?? '')
  if (shift === undefined || period === undefined) return undefined

  const dn = dnOf(base)
  const c = civil(dn)
  let first: number
  let last: number
  if (period === 'day') {
    first = dn + shift
    last = first
  } else if (period === 'week') {
    first = dn - weekdayIndex(dn) + 7 * shift
    last = first + 6
  } else if (period === 'year') {
    const y = c.y + shift
    checkYear(y, env)
    first = dayNumber(y, 1, 1)
    last = dayNumber(y, 12, 31)
  } else {
    const months = period === 'quarter' ? 3 : 1
    const startIndex = c.y * 12 + (period === 'quarter' ? Math.floor((c.m - 1) / 3) * 3 : c.m - 1) + shift * months
    const endIndex = startIndex + months - 1
    const y1 = Math.floor(startIndex / 12), y2 = Math.floor(endIndex / 12)
    checkYear(y1, env)
    checkYear(y2, env)
    const m1 = startIndex - y1 * 12 + 1, m2 = endIndex - y2 * 12 + 1
    first = dayNumber(y1, m1, 1)
    last = dayNumber(y2, m2, daysInMonth(y2, m2))
  }
  const which = shift === 0 ? 'this' : shift > 0 ? 'next' : 'last'
  const span = period === 'day' ? dateText(first) : `${dateText(first)} to ${dateText(last)}`
  const weeks = period === 'week' ? ', weeks run Monday-Sunday' : ''
  return {
    moment: edge === 'start' ? dateMoment(first, env) : dateMoment(last, env, true),
    interpreted: `${edge} of ${which} ${period} (${span}${weeks})`,
  }
}

function shiftMoment(base: Moment, count: number, unit: ShiftUnit, env: Env): { moment: Moment; clamped: boolean } {
  if (unit === 'minute' || unit === 'hour') {
    return { moment: instantMoment(base.ms + count * (unit === 'hour' ? HOUR_MS : MINUTE_MS), env), clamped: false }
  }
  const dn = dnOf(base)
  const timeOfDay = base.wall - dn * DAY_MS
  let target: number
  let clamped = false
  if (unit === 'day') target = dn + count
  else if (unit === 'week') target = dn + 7 * count
  else if (unit === 'business') target = addBusinessDays(dn, count)
  else {
    const c = civil(dn)
    const index = c.y * 12 + (c.m - 1) + count * (unit === 'year' ? 12 : unit === 'quarter' ? 3 : 1)
    const y = Math.floor(index / 12)
    const m = index - y * 12 + 1
    checkYear(y, env)
    const lastDay = daysInMonth(y, m)
    clamped = c.d > lastDay
    target = dayNumber(y, m, Math.min(c.d, lastDay))
  }
  checkDn(target, env)
  if (base.kind === 'date') return { moment: dateMoment(target, env, base.end), clamped }
  return { moment: wallMoment(target * DAY_MS + timeOfDay, env), clamped }
}

function shiftPhrase(tokens: string[], base: Moment, env: Env): Resolved | undefined {
  let count: number | undefined
  let unit: ShiftUnit | undefined
  const word = tokens.length === 2 ? SHIFT_WORDS.get(tokens[0] ?? '') : undefined
  if (word !== undefined) {
    count = word
    unit = SHIFT_UNITS.get(tokens[1] ?? '')
  } else {
    let t = tokens
    let sign = 1
    const lastToken = t[t.length - 1]
    if (t[0] === 'in') t = t.slice(1)
    else if (lastToken === 'ago') {
      t = t.slice(0, -1)
      sign = -1
    } else if (t.length === 4 && t[2] === 'from' && (t[3] === 'now' || t[3] === 'today')) t = t.slice(0, 2)
    else if (t.length === 3 && (lastToken === 'later' || lastToken === 'hence')) t = t.slice(0, 2)
    if (t.length !== 2) return undefined
    const n = readCount(t[0])
    count = n === undefined ? undefined : sign * n + 0
    unit = SHIFT_UNITS.get(t[1] ?? '')
  }
  if (count === undefined || unit === undefined) return undefined

  const { moment, clamped } = shiftMoment(base, count, unit, env)
  const abs = Math.abs(count)
  const label = `${abs} ${SHIFT_LABELS.get(unit) ?? unit}${abs === 1 ? '' : 's'}`
  const notes: string[] = []
  if (unit === 'minute' || unit === 'hour') notes.push('elapsed time')
  else if (base.kind === 'instant') notes.push('time of day kept')
  if (unit === 'business') notes.push('Mon-Fri, public holidays not excluded')
  if (clamped) notes.push('clamped to the last day of the month')
  return {
    moment,
    interpreted: `${label} ${count < 0 ? 'before' : 'after'} ${refLabel(base)}${notes.length ? ` (${notes.join('; ')})` : ''}`,
  }
}

function monthDayPhrase(tokens: string[], base: Moment, env: Env): Resolved | undefined {
  const t = tokens.filter((token) => token !== 'of')
  if (t.length !== 2 && t.length !== 3) return undefined
  let month = MONTHS.get(t[0] ?? '')
  let dayToken = t[1]
  if (month === undefined) {
    month = MONTHS.get(t[1] ?? '')
    dayToken = t[0]
  }
  const dayMatch = DAY_RE.exec(dayToken ?? '')
  if (month === undefined || !dayMatch) return undefined
  const yearToken = t[2]
  if (yearToken !== undefined && !YEAR_RE.test(yearToken)) return undefined

  const day = Number(dayMatch[1])
  const y = yearToken !== undefined ? Number(yearToken) : civil(dnOf(base)).y
  checkYear(y, env)
  if (day < 1 || day > daysInMonth(y, month)) {
    throw argError(`${monthName(month)} ${day}, ${y} does not exist (${monthName(month)} ${y} has ${daysInMonth(y, month)} days).`, env.example)
  }
  const assumed = yearToken === undefined ? ` (year taken from ${dateText(dnOf(base))})` : ''
  return { moment: dateMoment(dayNumber(y, month, day), env), interpreted: `${monthName(month)} ${day}, ${y}${assumed}` }
}

const SUPPORTED_PHRASES =
  'Supported: today, tomorrow, yesterday, next/last/this <weekday>, in N <unit>, N <unit> ago, +N/-N <unit> ' +
  '(minute, hour, day, week, month, quarter, year), N business days [ago], start/end of week/month/quarter/year, ' +
  'March 5[, 2027], 5 March 2027, or ISO YYYY-MM-DD[THH:MM[:SS][Z|±HH:MM]].'

/** ISO date/date-time or a grammar phrase, relative to `base`, in env.zone. */
function resolvePhrase(raw: string, base: Moment, env: Env): Resolved {
  const text = raw.trim()
  const iso = parseIso(text, env)
  if (iso) return iso
  const tokens = tokenize(text)
  const joined = tokens.join(' ')
  if (joined === 'now') return { moment: base, interpreted: `the reference time (${refLabel(base)})` }
  const fixed = FIXED_DAYS.get(joined)
  if (fixed !== undefined) return { moment: dateMoment(dnOf(base) + fixed, env), interpreted: `${joined} relative to ${refLabel(base)}` }
  const resolved =
    weekdayPhrase(tokens, base, env) ?? edgePhrase(tokens, base, env) ?? shiftPhrase(tokens, base, env) ?? monthDayPhrase(tokens, base, env)
  if (resolved) return resolved
  const where = env.param === 'from' ? ' given as "from"' : ''
  throw argError(`Could not read the date "${clipText(text, PHRASE_MAX)}"${where}. ${SUPPORTED_PHRASES}`, env.example)
}

export const timeTools: ToolEntry[] = [
  {
    name: 'current_time', category: 'time', effect: 'read',
    description: 'Get current UTC timestamp and local date/time in an IANA time zone; defaults to the server zone. Example: {"time_zone":"America/Chicago"}',
    parameters: { type: 'object', properties: { time_zone: { type: 'string' } } },
    handler(args, ctx) {
      const example = { time_zone: 'America/Chicago' }
      const timeZone = readString(args, 'time_zone', { max: 100, example })?.trim() ?? ctx.timeZone
      const now = ctx.now()
      if (!Number.isFinite(now.getTime())) throw argError('The current clock time is invalid.', example)
      try {
        const format = new Intl.DateTimeFormat('en-CA', {
          timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
          hourCycle: 'h23', timeZoneName: 'shortOffset',
        })
        const parts = Object.fromEntries(format.formatToParts(now).map((part) => [part.type, part.value]))
        return {
          iso: now.toISOString(), time_zone: format.resolvedOptions().timeZone,
          local: `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`,
          offset: parts.timeZoneName,
        }
      } catch { throw argError('Unknown time zone; use an IANA zone such as America/Chicago or UTC.', example) }
    },
  },
  {
    name: 'date_difference', category: 'time', effect: 'read',
    description: 'Return signed elapsed end minus start in fixed-duration units (default day). ISO dates mean UTC midnight; timestamps require an offset. Example: {"start":"2026-01-01","end":"2026-01-03","unit":"day"}',
    parameters: {
      type: 'object', properties: { start: { type: 'string' }, end: { type: 'string' }, unit: { type: 'string', enum: durationUnits } },
      required: ['start', 'end'],
    },
    handler(args) {
      const example = { start: '2026-01-01', end: '2026-01-03', unit: 'day' }
      const start = readDate(args, 'start', example), end = readDate(args, 'end', example)
      const unit = readEnum(args, 'unit', durationUnits, { fallback: 'day', example })!
      return { start: start.toISOString(), end: end.toISOString(), unit, difference: (end.getTime() - start.getTime()) / durations[unit] }
    },
  },
  {
    name: 'add_date', category: 'time', effect: 'read',
    description: 'Add a signed amount of fixed-duration units to an ISO date/timestamp (default day); a day is 24 hours, even across DST. Return UTC. Example: {"date":"2026-01-01","amount":7,"unit":"day"}',
    parameters: {
      type: 'object', properties: { date: { type: 'string' }, amount: { type: 'number' }, unit: { type: 'string', enum: durationUnits } },
      required: ['date', 'amount'],
    },
    handler(args) {
      const example = { date: '2026-01-01', amount: 7, unit: 'day' }
      const date = readDate(args, 'date', example)
      const amount = readNumber(args, 'amount', { required: true, min: -1e9, max: 1e9, example })!
      const unit = readEnum(args, 'unit', durationUnits, { fallback: 'day', example })!
      const result = new Date(date.getTime() + amount * durations[unit])
      if (!Number.isFinite(result.getTime())) throw argError('Resulting date is outside the supported date range; use a smaller amount.', example)
      return { date: date.toISOString(), amount, unit, result: result.toISOString() }
    },
  },
  {
    name: 'resolve_date', category: 'time', effect: 'read',
    description: 'Turn a date phrase into an exact date instead of guessing: today, next friday, in 3 days, 2 weeks ago, 10 business days, end of month, March 5, ISO. Relative to "from" (default now). Example: {"expression":"next friday"}',
    parameters: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description: 'Max 64 chars: today, tomorrow, yesterday, next/last/this <weekday>, in N <unit>, N <unit> ago, +N/-N <unit>, N business days [ago], start/end of week/month/quarter/year, March 5[, 2027], 5 March 2027, or ISO. Units: minute hour day week month quarter year.',
        },
        from: { type: 'string', description: 'Reference date: ISO (e.g. 2027-03-01) or a phrase. Default now.' },
        time_zone: { type: 'string' },
      },
      required: ['expression'],
    },
    handler(args, ctx) {
      const expression = readString(args, 'expression', { required: true, max: PHRASE_MAX, example: RESOLVE_EXAMPLE })!.trim()
      if (!expression) throw argError('"expression" is required.', RESOLVE_EXAMPLE)
      const fromText = readString(args, 'from', { max: PHRASE_MAX, example: FROM_EXAMPLE })?.trim()
      const env = zoneEnv(args, ctx)
      const nowMs = ctx.now().getTime()
      if (!Number.isFinite(nowMs)) throw argError('The current clock time is invalid.', RESOLVE_EXAMPLE)
      const now = instantMoment(nowMs, env)
      const base = fromText ? resolvePhrase(fromText, now, { ...env, example: FROM_EXAMPLE, param: 'from' }).moment : now
      const { moment, interpreted } = resolvePhrase(expression, base, env)
      const dn = dnOf(moment)
      const date = dateText(dn)
      const { iso, rounded } = isoText(moment.ms, env)
      const notes: string[] = []
      // A calendar date a zone skipped entirely (Pacific/Apia 2011-12-30) has no local midnight.
      if (moment.kind === 'date' && iso.slice(0, 10) !== date) notes.push(`${date} does not exist in ${env.zone}; iso is the nearest instant`)
      if (rounded) notes.push('local mean time, UTC offset rounded to the minute')
      return fitJson({
        iso, date, weekday: weekdayName(dn), time_zone: env.zone,
        interpreted: notes.length ? `${interpreted} (${notes.join('; ')})` : interpreted,
      })
    },
  },
]
