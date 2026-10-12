import { argError, readEnum, readNumber, readString } from './args.js'
import type { ToolEntry } from './types.js'

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
]
