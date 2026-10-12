// Registry facade first: it must load standalone (see registry.test.ts).
import { executeToolCall } from '../tools.js'
import { beforeAll, describe, expect, it } from 'vitest'
import type { WorkspaceStore } from '../store.js'
import { timeTools } from './time.js'
import type { ToolContext } from './types.js'

/** Monday 2026-10-12, 11:30 in Berlin (CEST, +02:00), 05:30 in New York (EDT). */
const NOW = new Date('2026-10-12T09:30:00.000Z')
const PROTO_KEYS = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'] as const
const DAY = 86_400_000

const store = { agents: [], skills: [], runs: [], notes: [], endpoints: [], endpointKeys: {} } as unknown as WorkspaceStore

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    store,
    agentId: 'agent_lead',
    runId: 'run_test',
    input: '',
    allowed: new Set<string>(['resolve_date']),
    now: () => NOW,
    timeZone: 'Europe/Berlin',
    writes: { count: 0 },
    ...overrides,
  }
}

function entry(name: string) {
  const found = timeTools.find((t) => t.name === name)
  if (!found) throw new Error(`missing tool ${name}`)
  return found
}

type Json = Record<string, unknown>

/** Every handler call must finish in < 50 ms (the 5 s timeout cannot interrupt sync code). */
function timed<T>(fn: () => T): T {
  const started = performance.now()
  try {
    return fn()
  } finally {
    expect(performance.now() - started).toBeLessThan(50)
  }
}

function call(name: string, args: Json = {}, ctx: ToolContext = makeCtx()): Json {
  const value = timed(() => entry(name).handler(args, ctx))
  expect(value).not.toBeUndefined()
  expect(JSON.stringify(value).length).toBeLessThanOrEqual(3_500)
  return value as Json
}

function errorOf(name: string, args: Json, ctx: ToolContext = makeCtx()): string {
  try {
    timed(() => entry(name).handler(args, ctx))
  } catch (err) {
    expect(err).toBeInstanceOf(Error)
    return (err as Error).message
  }
  throw new Error(`expected ${name} to throw for ${JSON.stringify(args)}`)
}

/** Every bad-input error ends with a corrected, parseable example. */
function expectExample(message: string): void {
  const match = /Example: (\{.*\})$/.exec(message)
  expect(match, message).not.toBeNull()
  expect(() => JSON.parse(match?.[1] ?? '')).not.toThrow()
}

const resolve = (expression: string, extra: Json = {}, ctx?: ToolContext) => call('resolve_date', { expression, ...extra }, ctx)
const dateOf = (expression: string, extra: Json = {}) => resolve(expression, extra).date

// Reference implementation for cross-checks (a simple day loop, test-only).
const dayNumber = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / DAY
const isoOfDay = (dn: number) => new Date(dn * DAY).toISOString().slice(0, 10)
const isWeekday = (dn: number) => new Date(dn * DAY).getUTCDay() % 6 !== 0

function refAddBusinessDays(start: number, n: number): number {
  let dn = start
  let left = Math.abs(n)
  while (left > 0) {
    dn += Math.sign(n)
    if (isWeekday(dn)) left--
  }
  return dn
}

beforeAll(() => {
  // Warm Intl/ICU zone data once so the per-call timing below measures the handler.
  entry('resolve_date').handler({ expression: 'today', time_zone: 'America/New_York' }, makeCtx())
})

describe('resolve_date registration', () => {
  it('is appended after the existing time tools, with a small declaration', () => {
    expect(timeTools.map((t) => t.name)).toEqual(['current_time', 'date_difference', 'add_date', 'resolve_date'])
    const tool = entry('resolve_date')
    expect(tool).toMatchObject({ category: 'time', effect: 'read' })
    expect(tool.description.length).toBeLessThanOrEqual(240)
    expect(tool.description).toContain('Example: {"expression":"next friday"}')
    expect(JSON.stringify({ description: tool.description, parameters: tool.parameters }).length).toBeLessThanOrEqual(1200)
    expect(Object.keys((tool.parameters as { properties: Json }).properties)).toEqual(['expression', 'from', 'time_zone'])
  })
})

describe('resolve_date grammar', () => {
  it('resolves today, tomorrow, yesterday and now from the fixed clock', () => {
    expect(resolve('today')).toEqual({
      iso: '2026-10-12T00:00:00+02:00',
      date: '2026-10-12',
      weekday: 'Monday',
      time_zone: 'Europe/Berlin',
      interpreted: expect.stringContaining('Mon 2026-10-12 11:30'),
    })
    expect(resolve('tomorrow')).toMatchObject({ date: '2026-10-13', weekday: 'Tuesday', iso: '2026-10-13T00:00:00+02:00' })
    expect(resolve('yesterday')).toMatchObject({ date: '2026-10-11', weekday: 'Sunday' })
    expect(dateOf('day after tomorrow')).toBe('2026-10-14')
    expect(dateOf('day before yesterday')).toBe('2026-10-10')
    expect(resolve('now').iso).toBe('2026-10-12T11:30:00+02:00')
  })

  it('resolves next/last/this weekdays (weeks run Monday-Sunday)', () => {
    expect(dateOf('next friday')).toBe('2026-10-16')
    expect(dateOf('next monday')).toBe('2026-10-19') // strictly after today
    expect(dateOf('last monday')).toBe('2026-10-05') // strictly before today
    expect(dateOf('last friday')).toBe('2026-10-09')
    expect(dateOf('this sunday')).toBe('2026-10-18')
    expect(dateOf('this monday')).toBe('2026-10-12')
    expect(dateOf('this wednesday')).toBe('2026-10-14')
    expect(dateOf('fri')).toBe('2026-10-16')
    expect(dateOf('on thursday')).toBe('2026-10-15')
    expect(dateOf('coming tue')).toBe('2026-10-13')
    expect(resolve('next friday').interpreted).toContain('first Friday after Mon 2026-10-12')
    expect(resolve('this sunday').interpreted).toContain('Monday-Sunday week')
  })

  it('shifts with "in N <unit>", "N <unit> ago" and "+/-N <unit>", keeping the time of day for calendar units', () => {
    expect(resolve('in 3 days')).toMatchObject({ iso: '2026-10-15T11:30:00+02:00', weekday: 'Thursday' })
    expect(resolve('in 3 days').interpreted).toContain('time of day kept')
    expect(dateOf('2 weeks ago')).toBe('2026-09-28')
    expect(resolve('+1 month').iso).toBe('2026-11-12T11:30:00+01:00') // after Berlin's DST change
    expect(dateOf('-1 year')).toBe('2025-10-12')
    expect(dateOf('+10 days')).toBe('2026-10-22')
    expect(resolve('in 2 hours').iso).toBe('2026-10-12T13:30:00+02:00')
    expect(resolve('90 minutes ago').iso).toBe('2026-10-12T10:00:00+02:00')
    expect(resolve('in 2 hours').interpreted).toContain('elapsed time')
    expect(dateOf('in 1 quarter')).toBe('2027-01-12')
    expect(dateOf('5 days from now')).toBe('2026-10-17')
    expect(dateOf('3 days later')).toBe('2026-10-15')
    expect(dateOf('next week')).toBe('2026-10-19')
    expect(dateOf('last year')).toBe('2025-10-12')
  })

  it('is lenient about case, spacing, compact units, number words and zero padding', () => {
    expect(dateOf('  Next   FRIDAY ')).toBe('2026-10-16')
    expect(dateOf('In 3 Days')).toBe('2026-10-15')
    expect(dateOf('3days')).toBe('2026-10-15')
    expect(dateOf('+2w')).toBe('2026-10-26')
    expect(dateOf('three days ago')).toBe('2026-10-09')
    expect(dateOf('a week ago')).toBe('2026-10-05')
    expect(resolve('in an hour').iso).toBe('2026-10-12T12:30:00+02:00')
    expect(dateOf('in 03 days')).toBe('2026-10-15')
    expect(dateOf('Mar. 5th, 2027')).toBe('2027-03-05')
    expect(dateOf('end of the month')).toBe('2026-10-31')
  })

  it('resolves start/end of week, month, quarter and year (with this/next/last)', () => {
    expect(resolve('start of week')).toMatchObject({ date: '2026-10-12', iso: '2026-10-12T00:00:00+02:00' })
    expect(resolve('end of week')).toMatchObject({ date: '2026-10-18', iso: '2026-10-18T23:59:59+02:00' })
    expect(resolve('end of month')).toMatchObject({ date: '2026-10-31', iso: '2026-10-31T23:59:59+01:00' })
    expect(dateOf('start of month')).toBe('2026-10-01')
    expect(dateOf('start of quarter')).toBe('2026-10-01')
    expect(dateOf('end of quarter')).toBe('2026-12-31')
    expect(dateOf('start of year')).toBe('2026-01-01')
    expect(dateOf('end of year')).toBe('2026-12-31')
    expect(dateOf('start of next month')).toBe('2026-11-01')
    expect(dateOf('end of last month')).toBe('2026-09-30')
    expect(dateOf('beginning of next week')).toBe('2026-10-19')
    expect(dateOf('end of next quarter')).toBe('2027-03-31')
    expect(dateOf('start of last quarter')).toBe('2026-07-01')
    expect(dateOf('start of last year')).toBe('2025-01-01')
    expect(dateOf('last day of the month')).toBe('2026-10-31')
    expect(dateOf('first day of next year')).toBe('2027-01-01')
    expect(dateOf('end of month', { from: '2028-02-10' })).toBe('2028-02-29')
    expect(dateOf('end of month', { from: '2027-02-10' })).toBe('2027-02-28')
    expect(resolve('end of day').iso).toBe('2026-10-12T23:59:59+02:00')
    expect(resolve('end of week').interpreted).toContain('Monday-Sunday')
  })

  it('resolves explicit dates: ISO and month names, with and without a year', () => {
    expect(resolve('2027-03-05')).toMatchObject({ date: '2027-03-05', weekday: 'Friday', iso: '2027-03-05T00:00:00+01:00' })
    expect(resolve('2026-10-12T08:00:00Z').iso).toBe('2026-10-12T10:00:00+02:00')
    expect(resolve('2026-10-12T08:00:00.5+05:30').iso).toBe('2026-10-12T04:30:00+02:00')
    expect(resolve('2026-10-12T08:00').iso).toBe('2026-10-12T08:00:00+02:00') // no offset: read in the zone
    expect(resolve('2026-10-12 14:00').iso).toBe('2026-10-12T14:00:00+02:00')
    expect(resolve('2026-10-12t08:00z').iso).toBe('2026-10-12T10:00:00+02:00')
    expect(dateOf('March 5')).toBe('2026-03-05')
    expect(resolve('March 5').interpreted).toContain('year taken from')
    expect(resolve('March 5, 2027')).toMatchObject({ date: '2027-03-05', weekday: 'Friday' })
    expect(dateOf('5 March 2027')).toBe('2027-03-05')
    expect(dateOf('5th of march')).toBe('2026-03-05')
    expect(dateOf('may 1')).toBe('2026-05-01')
  })
})

describe('resolve_date calendar rules', () => {
  it('clamps month, quarter and year arithmetic to the end of the month', () => {
    expect(dateOf('in 1 month', { from: '2026-01-31' })).toBe('2026-02-28')
    expect(dateOf('in 1 month', { from: '2024-01-31' })).toBe('2024-02-29') // leap year
    expect(dateOf('+1 month', { from: '2026-03-31' })).toBe('2026-04-30')
    expect(dateOf('1 month ago', { from: '2026-03-31' })).toBe('2026-02-28')
    expect(dateOf('in 1 quarter', { from: '2026-11-30' })).toBe('2027-02-28')
    expect(dateOf('in 2 months', { from: '2026-12-31' })).toBe('2027-02-28')
    expect(resolve('in 1 month', { from: '2026-01-31' }).interpreted).toContain('clamped to the last day of the month')
    // A date-only reference stays a calendar date (midnight, no time carried).
    expect(resolve('in 1 month', { from: '2026-01-31' }).iso).toBe('2026-02-28T00:00:00+01:00')
  })

  it('handles leap years', () => {
    expect(dateOf('+1 year', { from: '2024-02-29' })).toBe('2025-02-28')
    expect(dateOf('+4 years', { from: '2024-02-29' })).toBe('2028-02-29')
    expect(dateOf('tomorrow', { from: '2024-02-28' })).toBe('2024-02-29')
    expect(dateOf('tomorrow', { from: '2100-02-28' })).toBe('2100-03-01') // 2100 is not a leap year
    expect(dateOf('tomorrow', { from: '2000-02-28' })).toBe('2000-02-29') // 2000 is
    expect(dateOf('February 29 2028')).toBe('2028-02-29')
    expect(dateOf('2024-02-29')).toBe('2024-02-29')
  })

  it('rejects invalid dates such as 2024-02-30, never rolling them over', () => {
    const bad = [
      '2024-02-30', '2023-02-29', '1900-02-29', '2026-13-01', '2026-00-10', '2026-04-31', '2026-10-00',
      '2026-10-12T24:00', '2026-10-12T10:60', '2026-10-12T10:00:60Z', '2026-10-12T10:00+19:00', '0999-12-31',
    ]
    for (const expression of bad) {
      const message = errorOf('resolve_date', { expression })
      expect(message, expression).toMatch(/not a real date|invalid time|invalid UTC offset|outside the supported/)
      expectExample(message)
    }
    expect(errorOf('resolve_date', { expression: '2024-02-30' })).toContain('February 2024 has 29 days')
    expect(errorOf('resolve_date', { expression: 'February 29' })).toContain('does not exist')
    expect(errorOf('resolve_date', { expression: 'April 31, 2027' })).toContain('does not exist')
    // Never parsed as free text: other formats are phrase errors, not silent guesses.
    for (const expression of ['10000-01-01', '2026/10/12', '12.10.2026', 'Oct 2026', '2026-1-5', 'March 32', 'March 7 2001 10:00']) {
      expectExample(errorOf('resolve_date', { expression }))
    }
  })

  it('keeps results within years 1000-9999', () => {
    for (const expression of ['99999999 days', 'in 8000 years', '-99999999 business days', 'in 99999999 hours', '99999999 hours ago']) {
      const message = errorOf('resolve_date', { expression })
      expect(message, expression).toContain('outside the supported range')
      expectExample(message)
    }
    expect(dateOf('1000 years ago')).toBe('1026-10-12')
    expect(dateOf('99999999 minutes ago')).toBe('1836-08-24') // ~190 years: still in range
    expect(dateOf('end of year', { from: '9999-06-01' })).toBe('9999-12-31')
    expect(errorOf('resolve_date', { expression: 'start of next year', from: '9999-06-01' })).toContain('outside')
    expect(errorOf('resolve_date', { expression: 'tomorrow', from: '9999-12-31' })).toContain('outside')
    expect(errorOf('resolve_date', { expression: 'yesterday', from: '1000-01-01' })).toContain('outside')
  })

  it('adds business days across weekends, matching a day-by-day reference', () => {
    expect(dateOf('1 business day', { from: '2026-10-16' })).toBe('2026-10-19') // Fri → Mon
    expect(dateOf('5 business days', { from: '2026-10-16' })).toBe('2026-10-23')
    expect(dateOf('1 business day', { from: '2026-10-17' })).toBe('2026-10-19') // Sat → Mon
    expect(dateOf('1 business day ago', { from: '2026-10-19' })).toBe('2026-10-16') // Mon → Fri
    expect(dateOf('1 business day ago', { from: '2026-10-18' })).toBe('2026-10-16') // Sun → Fri
    expect(dateOf('10 working days')).toBe('2026-10-26')
    expect(dateOf('in 3 business days', { from: '2026-10-15' })).toBe('2026-10-20') // Thu → Tue
    expect(dateOf('-3 workdays', { from: '2026-10-14' })).toBe('2026-10-09')
    expect(dateOf('0 business days', { from: '2026-10-17' })).toBe('2026-10-17')
    expect(resolve('10 business days').interpreted).toContain('holidays not excluded')

    const start = dayNumber('2026-10-05') // a Monday; cover all seven start weekdays
    for (let s = start; s < start + 7; s++) {
      for (let n = -12; n <= 12; n++) {
        const expected = isoOfDay(refAddBusinessDays(s, n))
        expect(dateOf(`${n} business days`, { from: isoOfDay(s) }), `${isoOfDay(s)} ${n}`).toBe(expected)
      }
    }
  })

  it('computes huge business-day counts in O(1)', () => {
    // 2,000,000 business days = exactly 400,000 weeks.
    const far = resolve('2000000 business days', { from: '1000-01-01' })
    expect(far.date).toBe(isoOfDay(dayNumber('1000-01-01') + 2_800_000))
    expect(far.weekday).not.toMatch(/Saturday|Sunday/)
    const back = resolve('-1999999 business days', { from: '9999-12-31' })
    expect(back.weekday).not.toMatch(/Saturday|Sunday/)
  })
})

describe('resolve_date reference, zones and DST', () => {
  it('uses "from" (ISO or phrase) as the reference', () => {
    expect(dateOf('next friday', { from: '2027-03-01' })).toBe('2027-03-05')
    expect(dateOf('in 2 weeks', { from: 'end of month' })).toBe('2026-11-14')
    expect(resolve('now', { from: '2026-12-24T18:00:00Z' }).iso).toBe('2026-12-24T19:00:00+01:00')
    let message = errorOf('resolve_date', { expression: 'today', from: 'whenever' })
    expect(message).toContain('"from":"2027-03-01"')
    expectExample(message)
    message = errorOf('resolve_date', { expression: 'today', from: '2024-02-30' })
    expect(message).toContain('not a real date')
    expectExample(message)
  })

  it('defaults to ctx.timeZone and validates time_zone like current_time', () => {
    expect(resolve('today', {}, makeCtx({ timeZone: 'Asia/Tokyo' }))).toMatchObject({
      date: '2026-10-12', iso: '2026-10-12T00:00:00+09:00', time_zone: 'Asia/Tokyo',
    })
    // "today" depends on the zone: 09:30 UTC is still Sunday in Pago Pago and late Monday in Kiritimati.
    expect(resolve('today', { time_zone: 'Pacific/Pago_Pago' })).toMatchObject({ date: '2026-10-11', iso: '2026-10-11T00:00:00-11:00' })
    expect(resolve('today', { time_zone: 'Pacific/Kiritimati' })).toMatchObject({ date: '2026-10-12', iso: '2026-10-12T00:00:00+14:00' })
    expect(resolve('now', { time_zone: 'America/New_York' }).iso).toBe('2026-10-12T05:30:00-04:00')
    expect(resolve('now', { time_zone: 'UTC' }).iso).toBe('2026-10-12T09:30:00+00:00')
    expect(resolve('today', { time_zone: ' america/new_york ' }).time_zone).toBe('America/New_York')
    // A date-time without an offset is read in the given zone, not the server's.
    expect(resolve('now', { from: '2026-10-12T09:00', time_zone: 'Asia/Tokyo' }).iso).toBe('2026-10-12T09:00:00+09:00')

    // Same acceptance and canonical name as current_time for every zone.
    const current = entry('current_time')
    for (const zone of ['UTC', 'utc', 'Europe/Berlin', 'america/chicago', 'US/Eastern', 'Asia/Kolkata', 'Mars/Olympus', 'Z', 'not/a/zone', ...PROTO_KEYS]) {
      let expected: unknown
      try {
        expected = (current.handler({ time_zone: zone }, makeCtx()) as Json).time_zone
      } catch (err) {
        expected = (err as Error).message.startsWith('Unknown time zone') ? 'unknown' : 'other'
      }
      let actual: unknown
      try {
        actual = resolve('today', { time_zone: zone }).time_zone
      } catch (err) {
        actual = (err as Error).message.startsWith('Unknown time zone') ? 'unknown' : 'other'
        expectExample((err as Error).message)
      }
      expect(actual, zone).toBe(expected)
    }
  })

  it('handles the America/New_York DST boundaries: calendar shifts keep wall time, hour shifts are elapsed', () => {
    const ny = { time_zone: 'America/New_York' }
    // 2026-03-08: 02:00 → 03:00. 02:30 does not exist and moves forward by the gap.
    expect(resolve('now', { from: '2026-03-08T02:30', ...ny }).iso).toBe('2026-03-08T03:30:00-04:00')
    expect(resolve('in 1 day', { from: '2026-03-07T02:30', ...ny }).iso).toBe('2026-03-08T03:30:00-04:00')
    expect(resolve('in 1 day', { from: '2026-03-07T12:00', ...ny }).iso).toBe('2026-03-08T12:00:00-04:00')
    expect(resolve('in 24 hours', { from: '2026-03-07T12:00', ...ny }).iso).toBe('2026-03-08T13:00:00-04:00')
    expect(resolve('tomorrow', { from: '2026-03-07T12:00', ...ny }).iso).toBe('2026-03-08T00:00:00-05:00')
    expect(resolve('end of day', { from: '2026-03-08', ...ny }).iso).toBe('2026-03-08T23:59:59-04:00')
    // 2026-11-01: 02:00 → 01:00. 01:30 happens twice; the earlier one is used.
    expect(resolve('now', { from: '2026-11-01T01:30', ...ny }).iso).toBe('2026-11-01T01:30:00-04:00')
    expect(resolve('in 1 hour', { from: '2026-11-01T01:30', ...ny }).iso).toBe('2026-11-01T01:30:00-05:00')
    expect(resolve('in 1 day', { from: '2026-10-31T12:00', ...ny }).iso).toBe('2026-11-01T12:00:00-05:00')
    expect(resolve('in 24 hours', { from: '2026-10-31T12:00', ...ny }).iso).toBe('2026-11-01T11:00:00-05:00')

    // The injected clock just before the spring-forward jump (01:30 EST).
    const early = makeCtx({ now: () => new Date('2026-03-08T06:30:00Z'), timeZone: 'America/New_York' })
    expect(resolve('now', {}, early).iso).toBe('2026-03-08T01:30:00-05:00')
    expect(resolve('in 1 hour', {}, early).iso).toBe('2026-03-08T03:30:00-04:00')
    expect(resolve('today', {}, early).iso).toBe('2026-03-08T00:00:00-05:00')
    expect(resolve('tomorrow', {}, early).iso).toBe('2026-03-09T00:00:00-04:00')
  })
})

describe('resolve_date bad input', () => {
  it('caps the expression and "from" at 64 chars before any work, and requires the expression', () => {
    let message = errorOf('resolve_date', { expression: 'x'.repeat(65) })
    expect(message).toMatch(/too long \(65 chars, max 64\)/)
    expectExample(message)
    expect(dateOf(`${' '.repeat(59)}today`)).toBe('2026-10-12') // exactly 64 chars is fine
    message = errorOf('resolve_date', { expression: 'today', from: '2'.repeat(65) })
    expect(message).toMatch(/too long/)
    expectExample(message)
    expectExample(errorOf('resolve_date', { expression: 'today', time_zone: 'E'.repeat(101) }))
    message = errorOf('resolve_date', {})
    expect(message).toMatch(/"expression" is required/)
    expectExample(message)
    expect(errorOf('resolve_date', { expression: '   ' })).toMatch(/"expression" is required/)
    expectExample(errorOf('resolve_date', { expression: { when: 'today' } }))
    // A 64-char cap keeps adversarial input cheap.
    for (const expression of ['9'.repeat(64), `${'in '.repeat(21)}x`, `${'a'.repeat(63)}.`, '1'.repeat(30) + ' days']) {
      expectExample(errorOf('resolve_date', { expression }))
    }
  })

  it('rejects unknown phrases with the supported forms and an example', () => {
    const phrases = ['next blursday', 'in 3 fortnights', 'this week', 'whenever', '3 days after tomorrow', 'in 3 days ago', 'on']
    for (const expression of phrases) {
      const message = errorOf('resolve_date', { expression })
      expect(message, expression).toContain('Could not read the date')
      expect(message).toContain('Supported: today, tomorrow, yesterday, next/last/this <weekday>, in N <unit>, N <unit> ago')
      expect(message).toContain('N business days [ago], start/end of week/month/quarter/year')
      expectExample(message)
    }
    // Numbers are stringified, then rejected as phrases (with the grammar).
    const numeric = errorOf('resolve_date', { expression: 2027 })
    expect(numeric).toContain('Supported: today')
    expectExample(numeric)
  })

  it('treats prototype keys as unknown weekday, unit, month and period words', () => {
    const phrases = [
      ...PROTO_KEYS,
      ...PROTO_KEYS.map((k) => `next ${k}`),
      ...PROTO_KEYS.map((k) => `this ${k}`),
      ...PROTO_KEYS.map((k) => `in 2 ${k}`),
      ...PROTO_KEYS.map((k) => `2${k.toLowerCase()}`),
      ...PROTO_KEYS.map((k) => `5 ${k} ago`),
      ...PROTO_KEYS.map((k) => `start of ${k}`),
      ...PROTO_KEYS.map((k) => `end of ${k} month`),
      ...PROTO_KEYS.map((k) => `${k} 5`),
      ...PROTO_KEYS.map((k) => `in ${k} days`),
    ]
    for (const expression of phrases) {
      const message = errorOf('resolve_date', { expression })
      expect(message, expression).toContain('Could not read the date')
      expectExample(message)
    }
    for (const key of PROTO_KEYS) {
      expect(errorOf('resolve_date', { expression: 'today', time_zone: key })).toContain('Unknown time zone')
      expectExample(errorOf('resolve_date', { expression: 'today', from: key }))
    }
  })

  it('reports an invalid injected clock as an argument error', () => {
    expectExample(errorOf('resolve_date', { expression: 'today' }, makeCtx({ now: () => new Date(Number.NaN) })))
  })
})

describe('resolve_date review regressions', () => {
  it('puts "end of day" on the last instant of that day when a DST change touches midnight', () => {
    // Asia/Beirut falls back at 00:00 → 23:00, so Saturday 23:00-23:59 happens twice: the end is the later one.
    expect(resolve('end of day', { from: '2026-10-24', time_zone: 'Asia/Beirut' })).toMatchObject({
      iso: '2026-10-24T23:59:59+02:00', date: '2026-10-24',
    })
    expect(resolve('start of day', { from: '2026-10-25', time_zone: 'Asia/Beirut' }).iso).toBe('2026-10-25T00:00:00+02:00')
    // America/Nuuk springs forward at 23:00 → 00:00: Saturday ends at 22:59:59, not on Sunday.
    expect(resolve('end of day', { from: '2026-03-28', time_zone: 'America/Nuuk' })).toMatchObject({
      iso: '2026-03-28T22:59:59-02:00', date: '2026-03-28', weekday: 'Saturday',
    })
    // ...and falls back at 00:00 → 23:00 in October (the later 23:59:59 again).
    expect(resolve('end of day', { from: '2026-10-24', time_zone: 'America/Nuuk' }).iso).toBe('2026-10-24T23:59:59-02:00')
    // Ordinary DST days are unaffected.
    expect(resolve('end of day', { from: '2026-11-01', time_zone: 'America/New_York' }).iso).toBe('2026-11-01T23:59:59-05:00')
  })

  it('says so when a zone skipped the calendar date entirely', () => {
    const skipped = resolve('2011-12-30', { time_zone: 'Pacific/Apia' })
    expect(skipped).toMatchObject({ date: '2011-12-30', weekday: 'Friday', iso: '2011-12-31T00:00:00+14:00' })
    expect(skipped.interpreted).toContain('2011-12-30 does not exist in Pacific/Apia')
    expect(resolve('2011-12-29', { time_zone: 'Pacific/Apia' }).interpreted).not.toContain('does not exist')
  })

  it('always emits a ±HH:MM offset that reads back to the same date (pre-1900 local mean time)', () => {
    const ny = { time_zone: 'America/New_York' } // LMT was -04:56:02
    const start = resolve('1850-03-01', ny)
    expect(start).toMatchObject({ iso: '1850-03-01T00:00:00-04:57', date: '1850-03-01', weekday: 'Friday' })
    expect(start.interpreted).toContain('UTC offset rounded to the minute')
    const end = resolve('end of day', { from: '1850-03-01', ...ny })
    expect(end.iso).toBe('1850-03-01T23:59:59-04:56')
    for (const iso of [start.iso, end.iso]) {
      expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/)
      expect(resolve('today', { from: iso, ...ny }).date).toBe('1850-03-01')
      // The existing time tools accept it too.
      expect(call('date_difference', { start: iso, end: '1850-03-02' })).toHaveProperty('difference')
    }
    const berlin = resolve('1000-01-01', { time_zone: 'Europe/Berlin' }) // LMT +00:53:28
    expect(berlin.iso).toBe('1000-01-01T00:00:00+00:53')
    expect(resolve('today', { from: berlin.iso, time_zone: 'Europe/Berlin' }).date).toBe('1000-01-01')
    // Whole-minute offsets are never annotated.
    expect(resolve('today').interpreted).not.toContain('rounded')
  })

  it('rejects UTC offsets beyond ±18:00', () => {
    const message = errorOf('resolve_date', { expression: '2026-10-12T08:00:00+18:01' })
    expect(message).toContain('invalid UTC offset')
    expectExample(message)
    expect(resolve('2026-10-12T08:00:00-18:00').iso).toBe('2026-10-13T04:00:00+02:00')
  })

  it('names "from" when that is the argument it could not read', () => {
    const message = errorOf('resolve_date', { expression: 'today', from: 'whenever' })
    expect(message).toContain('Could not read the date "whenever" given as "from"')
    expectExample(message)
    expect(errorOf('resolve_date', { expression: 'whenever' })).not.toContain('given as')
  })

  it('stays fast and well-formed on pathological max-size input', () => {
    const nasty = [
      '3d '.repeat(21).trim(), '-'.repeat(64), '+'.repeat(63) + '1', 'İ'.repeat(64), 'ß'.repeat(64), '\ud83d'.repeat(64),
      ' '.repeat(63) + '1', 'of '.repeat(21), 'next '.repeat(12) + 'fri', '9'.repeat(8) + ' business days ago',
      '2026-10-12T'.padEnd(64, '0'), '0000-00-00T00:00:00.000+00:00', '9999-12-31T23:59:59.999-18:00',
    ]
    for (const expression of nasty) {
      expect(expression.length).toBeLessThanOrEqual(64)
      for (const from of [undefined, expression]) {
        try {
          call('resolve_date', { expression, ...(from === undefined ? {} : { from }), time_zone: 'Pacific/Chatham' })
        } catch (err) {
          expectExample((err as Error).message)
          expect((err as Error).message.length).toBeLessThan(1_000)
        }
      }
    }
  })

  it('accepts "N <unit> from today"', () => {
    expect(dateOf('3 days from today')).toBe('2026-10-15')
    expect(dateOf('2 business days from today')).toBe('2026-10-14')
  })
})

describe('resolve_date through executeToolCall', () => {
  const run = (args: unknown, ctx: ToolContext = makeCtx()) =>
    executeToolCall({ id: 'call_1', name: 'resolve_date', arguments: typeof args === 'string' ? args : JSON.stringify(args) }, ctx)

  it('runs end to end, ignoring prototype keys in the arguments', async () => {
    const outcome = await run('{"__proto__": {"polluted": true}, "constructor": "x", "toString": 1, "expression": "next friday"}')
    expect(outcome.ok).toBe(true)
    expect(JSON.parse(outcome.content)).toMatchObject({ date: '2026-10-16', weekday: 'Friday', time_zone: 'Europe/Berlin' })
    expect(({} as Json).polluted).toBeUndefined()
  })

  it('returns argument errors as ok:false text ending in an example', async () => {
    const bad = await run({ expression: '2024-02-30' })
    expect(bad.ok).toBe(false)
    expect(bad.content).toMatch(/^Tool "resolve_date" failed: .*Example: \{.*\}$/)
  })

  it('is refused when not offered to the agent', async () => {
    const outcome = await run({ expression: 'today' }, makeCtx({ allowed: new Set(['current_time']) }))
    expect(outcome.ok).toBe(false)
    expect(outcome.content).toContain('not enabled for this agent')
  })

  it('redacts key-shaped text echoed back in an error', async () => {
    const key = 'sk-abcdefghijklmnopqrstuvwxyz0123'
    const outcome = await run({ expression: `next ${key}` })
    expect(outcome.ok).toBe(false)
    expect(outcome.content).toContain('Could not read the date')
    expect(outcome.content).not.toContain(key)
    expect(outcome.content).toContain('[redacted]')
  })
})
