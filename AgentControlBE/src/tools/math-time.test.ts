import { describe, expect, it } from 'vitest'
import { mathTools } from './math.js'
import { timeTools } from './time.js'
import type { ToolContext } from './types.js'

const context = { now: () => new Date('2026-03-08T08:30:00.000Z'), timeZone: 'America/Chicago' } as ToolContext
function call(name: string, args: Record<string, unknown> = {}): Record<string, unknown> {
  return [...mathTools, ...timeTools].find((tool) => tool.name === name)!.handler(args, context) as Record<string, unknown>
}

describe('offline arithmetic', () => {
  it.each([
    ['(12 + 3) * 2', 30], ['2 + 3 * 4', 14], ['2 ^ 3 ^ 2', 512], ['2 ** 3', 8],
    ['-2^2', -4], ['(-2)^2', 4], ['2^-2', 0.25], ['1e3 + .25', 1000.25], ['11 % 4', 3],
    ['  10 / -2 + +3  ', -2], ['0 * -1', 0],
  ])('calculates %s', (expression, expected) => {
    expect(call('calculate', { expression }).result).toBe(expected)
  })
  it.each([
    'globalThis.process.exit()', '1; 2', '1 +', '(1 + 2', '1 / 0', '0 % 0', '1e999', '2^9999',
    '(-1)^0.5', '1e', '1 2', '0x10', '1,2', ' '.repeat(5), '-'.repeat(40) + '1',
    '('.repeat(40) + '1' + ')'.repeat(40), '1'.repeat(513),
  ])('rejects malformed, nonfinite, or excessive input: %s', (expression) => {
    expect(() => call('calculate', { expression })).toThrow(/Example: /)
  })
  it('accepts numeric-string conversions and descriptive unit names', () => {
    expect(call('convert_units', { value: '2.5', from: 'kilometers', to: 'meters' }).result).toBe(2500)
    expect(call('convert_units', { value: 1, from: 'lb', to: 'g' }).result).toBeCloseTo(453.59237)
    expect(call('convert_units', { value: 1000, from: 'ml', to: 'l' }).result).toBe(1)
    expect(call('convert_units', { value: 32, from: 'F', to: 'C' }).result).toBeCloseTo(0)
    expect(call('convert_units', { value: 100, from: 'C', to: 'F' }).result).toBeCloseTo(212)
    expect(call('convert_units', { value: 0, from: 'K', to: 'C' }).result).toBeCloseTo(-273.15)
  })
  it.each([
    { value: 1, from: 'km', to: 'kg' }, { value: 1, from: '__proto__', to: 'm' },
    { value: Infinity, from: 'm', to: 'ft' }, { value: '1e101', from: 'm', to: 'ft' },
  ])('refuses invalid conversions', (args) => {
    expect(() => call('convert_units', args)).toThrow(/Example: /)
  })
})

describe('offline dates and time', () => {
  it('uses the injected clock and formats the default zone across daylight saving', () => {
    expect(call('current_time')).toEqual({
      iso: '2026-03-08T08:30:00.000Z', time_zone: 'America/Chicago', local: '2026-03-08T03:30:00', offset: 'GMT-5',
    })
    expect(call('current_time', { time_zone: 'UTC' }).local).toBe('2026-03-08T08:30:00')
    expect(() => call('current_time', { time_zone: 'not/a/zone' })).toThrow(/Example: /)
  })
  it('calculates signed fractional elapsed units and resolves timestamp offsets', () => {
    expect(call('date_difference', { start: '2026-01-03', end: '2026-01-01', unit: 'Days' }).difference).toBe(-2)
    expect(call('date_difference', { start: '2026-01-01T00:00:00Z', end: '2026-01-01T12:00:00Z' }).difference).toBe(0.5)
    expect(call('date_difference', {
      start: '2026-03-08T01:30:00-06:00', end: '2026-03-08T03:30:00-05:00', unit: 'hours',
    }).difference).toBe(1)
  })
  it('adds negative/fractional amounts, handles leap dates, and treats days as 24 hours', () => {
    expect(call('add_date', { date: '2024-02-28', amount: '1' }).result).toBe('2024-02-29T00:00:00.000Z')
    expect(call('add_date', { date: '2026-01-01', amount: -0.5 }).result).toBe('2025-12-31T12:00:00.000Z')
    expect(call('add_date', { date: '2026-03-08T01:30:00-06:00', amount: 1 }).result).toBe('2026-03-09T07:30:00.000Z')
    expect(call('add_date', { date: '0099-01-01', amount: 1 }).result).toBe('0099-01-02T00:00:00.000Z')
  })
  it.each([
    '2026-02-29', '1900-02-29', '2026-04-31', '2026-13-01', '2026-01-00', 'March 1 2026',
    '2026-01-01T12:00:00', '2026-01-01T24:00:00Z', '2026-01-01T23:60:00Z', '2026-01-01T23:59:60Z',
    '2026-01-01T12:00:00+24:00', '2026-01-01T12:00:00+00:60',
  ])('rejects invalid or ambiguous dates: %s', (date) => {
    expect(() => call('add_date', { date, amount: 1 })).toThrow(/Example: /)
  })
  it('rejects unsupported calendar units, huge amounts, and invalid output dates', () => {
    expect(() => call('add_date', { date: '2026-01-01', amount: 1, unit: 'month' })).toThrow(/Example: /)
    expect(() => call('add_date', { date: '2026-01-01', amount: 1e10 })).toThrow(/Example: /)
    expect(() => call('add_date', { date: '2026-01-01', amount: 1e9, unit: 'week' })).toThrow(/Example: /)
  })
})
