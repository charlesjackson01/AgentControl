import { argError, readNumber, readString } from './args.js'
import type { ToolEntry } from './types.js'

const CALC_EXAMPLE = { expression: '(12 + 3) * 2' }
const MAX_ARGS = 20
const NAMES = 'functions sqrt, abs, round, floor, ceil, min, max, log (base 10), ln, exp and constants pi, e'

function fail(message: string, example: Record<string, unknown> = CALC_EXAMPLE): never {
  throw argError(message, example)
}

interface MathFunction {
  min: number
  max: number
  /** Corrected call shown in errors. */
  example: string
  apply(values: readonly number[]): number
}

const CONSTANTS = new Map<string, number>([['pi', Math.PI], ['e', Math.E]])

function positive(name: string, x: number, example: string): number {
  if (!(x > 0)) fail(`${name}(${x}) is undefined; ${name} needs a number above 0.`, { expression: example })
  return x
}

/** Round half away from zero (round(-2.5) = -3), optionally to `digits` decimals (negative: tens, hundreds). */
function roundTo(x: number, digits: number): number {
  if (!Number.isInteger(digits) || Math.abs(digits) > 15) fail('round(x, digits) needs whole-number digits from -15 to 15.', { expression: 'round(3.14159, 2)' })
  const factor = 10 ** Math.abs(digits)
  const scaled = digits >= 0 ? x * factor : x / factor
  // Past 2^52 every double is already whole at this scale.
  if (!Number.isFinite(scaled) || Math.abs(scaled) >= 2 ** 52) return x
  // toPrecision first: 1.005 * 100 is 100.49999999999999 in binary.
  const whole = Math.sign(scaled) * Math.round(Number(Math.abs(scaled).toPrecision(15)))
  return digits >= 0 ? whole / factor : whole * factor
}

const FUNCTIONS = new Map<string, MathFunction>([
  ['sqrt', { min: 1, max: 1, example: 'sqrt(16)', apply: ([x = 0]) => x < 0 ? fail(`sqrt(${x}) is not a real number; sqrt needs 0 or more.`, { expression: 'sqrt(16)' }) : Math.sqrt(x) }],
  ['abs', { min: 1, max: 1, example: 'abs(-3)', apply: ([x = 0]) => Math.abs(x) }],
  ['round', { min: 1, max: 2, example: 'round(3.14159, 2)', apply: ([x = 0, digits = 0]) => roundTo(x, digits) }],
  ['floor', { min: 1, max: 1, example: 'floor(2.7)', apply: ([x = 0]) => Math.floor(x) }],
  ['ceil', { min: 1, max: 1, example: 'ceil(2.1)', apply: ([x = 0]) => Math.ceil(x) }],
  ['min', { min: 1, max: MAX_ARGS, example: 'min(3, 9, 4)', apply: (values) => Math.min(...values) }],
  ['max', { min: 1, max: MAX_ARGS, example: 'max(3, 9, 4)', apply: (values) => Math.max(...values) }],
  ['log', {
    min: 1, max: 2, example: 'log(1000)',
    apply: ([x = 0, base]) => {
      positive('log', x, 'log(1000)')
      if (base === undefined) return Math.log10(x)
      if (!(base > 0) || base === 1) fail('log(x, base) needs a base above 0 other than 1.', { expression: 'log(8, 2)' })
      return Math.log(x) / Math.log(base)
    },
  }],
  ['ln', { min: 1, max: 1, example: 'ln(10)', apply: ([x = 0]) => Math.log(positive('ln', x, 'ln(10)')) }],
  ['exp', { min: 1, max: 1, example: 'exp(2)', apply: ([x = 0]) => Math.exp(x) }],
])

const arity = (fn: MathFunction): string =>
  fn.min === fn.max ? `${fn.min} argument${fn.min === 1 ? '' : 's'}` : fn.max === MAX_ARGS ? `${fn.min} to ${MAX_ARGS} arguments` : `${fn.min} or ${fn.max} arguments`

/**
 * A bounded arithmetic grammar: numbers, + - * / % ^, parentheses, and a fixed
 * table of functions and constants. Names are looked up in Maps, never
 * evaluated; anything else is rejected. % is the remainder (11 % 4 = 3).
 */
function calculate(source: string): number {
  let position = 0
  let depth = 0
  const skip = () => { while (/\s/.test(source[position] ?? '') && position < source.length) position++ }
  const finite = (value: number): number => Number.isFinite(value) ? value : fail('The calculation must have a finite real result.')
  const take = (symbol: string): boolean => {
    skip()
    if (!source.startsWith(symbol, position)) return false
    position += symbol.length
    return true
  }
  const call = (raw: string): number => {
    const name = raw.toLowerCase()
    const constant = CONSTANTS.get(name)
    if (constant !== undefined) return constant
    const fn = FUNCTIONS.get(name)
    if (!fn) return fail(`Unknown name "${raw.slice(0, 30)}". Use ${NAMES}.`, { expression: 'sqrt(16) + 2' })
    if (!take('(')) return fail(`${name} needs parentheses, like ${fn.example}.`, { expression: fn.example })
    const values: number[] = []
    if (!take(')')) {
      do {
        if (values.length === MAX_ARGS) fail(`${name} accepts at most ${MAX_ARGS} arguments.`, { expression: fn.example })
        values.push(sum())
      } while (take(','))
      if (!take(')')) fail(`Missing ")" to close ${name}(...).`, { expression: fn.example })
    }
    if (values.length < fn.min || values.length > fn.max) fail(`${name} takes ${arity(fn)}, like ${fn.example}.`, { expression: fn.example })
    return finite(fn.apply(values))
  }
  const primary = (): number => {
    if (take('(')) {
      const value = sum()
      if (!take(')')) fail('Missing closing parenthesis.')
      return value
    }
    skip()
    const rest = source.slice(position)
    const name = /^[A-Za-z_]\w*/.exec(rest)
    if (name) {
      position += name[0].length
      return call(name[0])
    }
    const match = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest)
    if (!match) return fail(`Expected a number, parentheses, or one of the ${NAMES}.`)
    position += match[0].length
    return finite(Number(match[0]))
  }
  const unary = (): number => {
    if (++depth > 32) fail('Expression nesting exceeds 32 levels.')
    try {
      if (take('+')) return unary()
      if (take('-')) return -unary()
      const value = primary()
      return take('^') || take('**') ? finite(value ** unary()) : value
    } finally { depth-- }
  }
  const product = (): number => {
    let value = unary()
    while (true) {
      if (take('*')) value = finite(value * unary())
      else if (take('/')) {
        const divisor = unary()
        if (divisor === 0) fail('Division by zero is not supported.')
        value = finite(value / divisor)
      } else if (take('%')) {
        const divisor = unary()
        if (divisor === 0) fail('Remainder by zero is not supported.')
        value = finite(value % divisor)
      } else return value
    }
  }
  const sum = (): number => {
    let value = product()
    while (true) {
      if (take('+')) value = finite(value + product())
      else if (take('-')) value = finite(value - product())
      else return value
    }
  }
  const result = sum()
  skip()
  if (position !== source.length) {
    fail(`Unexpected input at character ${position + 1}; use numbers, parentheses, + - * / % ^ and ${NAMES}. Write multiplication explicitly (2 * pi).`)
  }
  return Object.is(result, -0) ? 0 : result
}

/** `legacy` units are the original catalog: their conversions stay bit-for-bit as before. */
type Unit = { name: string; dimension: string; scale: number; offset: number; legacy: boolean }
const units = new Map<string, Unit>()
/** Case-sensitive symbols, checked first: b is a bit and B a byte; Kb Mb Gb Tb are bits. */
const symbols = new Map<string, Unit>()
function register(map: Map<string, Unit>, key: string, definition: Unit): void {
  if (map.has(key)) throw new Error(`Duplicate unit alias "${key}".`)
  map.set(key, definition)
}
function unit(name: string, dimension: string, scale: number, aliases: string[], offset = 0): void {
  const definition = { name, dimension, scale, offset, legacy: true }
  for (const alias of [name, ...aliases]) register(units, alias, definition)
}
/** A unit added after the original catalog; results involving it are tidied to 15 significant digits. */
function added(name: string, dimension: string, scale: number, aliases: string[], exact: string[] = []): void {
  const definition = { name, dimension, scale, offset: 0, legacy: false }
  for (const symbol of exact) register(symbols, symbol, definition)
  for (const alias of exact.includes(name) ? aliases : [name, ...aliases]) register(units, alias.toLowerCase(), definition)
}
unit('mm', 'length', 0.001, ['millimeter', 'millimeters', 'millimetre', 'millimetres'])
unit('cm', 'length', 0.01, ['centimeter', 'centimeters', 'centimetre', 'centimetres'])
unit('m', 'length', 1, ['meter', 'meters', 'metre', 'metres'])
unit('km', 'length', 1000, ['kilometer', 'kilometers', 'kilometre', 'kilometres'])
unit('in', 'length', 0.0254, ['inch', 'inches'])
unit('ft', 'length', 0.3048, ['foot', 'feet'])
unit('yd', 'length', 0.9144, ['yard', 'yards'])
unit('mi', 'length', 1609.344, ['mile', 'miles'])
unit('g', 'mass', 1, ['gram', 'grams'])
unit('kg', 'mass', 1000, ['kilogram', 'kilograms'])
unit('oz', 'mass', 28.349523125, ['ounce', 'ounces'])
unit('lb', 'mass', 453.59237, ['pound', 'pounds', 'lbs'])
unit('ml', 'volume', 0.001, ['milliliter', 'milliliters', 'millilitre', 'millilitres'])
unit('l', 'volume', 1, ['liter', 'liters', 'litre', 'litres'])
unit('c', 'temperature', 1, ['celsius', '°c'], 273.15)
unit('f', 'temperature', 5 / 9, ['fahrenheit', '°f'], 273.15 - 32 * 5 / 9)
unit('k', 'temperature', 1, ['kelvin'])
// US customary volumes (US gallon, cup and fluid ounce) and the imperial gallon, in litres.
added('cup', 'volume', 0.2365882365, ['cups', 'us cup', 'us cups'])
added('fl oz', 'volume', 0.0295735295625, ['floz', 'fl_oz', 'fl. oz', 'us fl oz', 'fluid ounce', 'fluid ounces'])
added('gal', 'volume', 3.785411784, ['gallon', 'gallons', 'us gal', 'us gallon', 'us gallons'])
added('imp gal', 'volume', 4.54609, ['imp_gal', 'uk gal', 'imperial gallon', 'imperial gallons', 'uk gallon', 'uk gallons'])
added('ms', 'time', 0.001, ['msec', 'millisecond', 'milliseconds'])
added('s', 'time', 1, ['sec', 'secs', 'second', 'seconds'])
added('min', 'time', 60, ['mins', 'minute', 'minutes'])
added('h', 'time', 3600, ['hr', 'hrs', 'hour', 'hours'])
added('day', 'time', 86_400, ['d', 'days'])
added('week', 'time', 604_800, ['wk', 'wks', 'weeks'])
// Data in bytes: KB..TB are 1000-based, KiB..TiB 1024-based.
added('bit', 'data', 0.125, ['bits'], ['b'])
added('B', 'data', 1, ['byte', 'bytes'], ['B'])
added('KB', 'data', 1e3, ['kilobyte', 'kilobytes'])
added('MB', 'data', 1e6, ['megabyte', 'megabytes'])
added('GB', 'data', 1e9, ['gigabyte', 'gigabytes'])
added('TB', 'data', 1e12, ['terabyte', 'terabytes'])
added('KiB', 'data', 1024, ['kibibyte', 'kibibytes'])
added('MiB', 'data', 1024 ** 2, ['mebibyte', 'mebibytes'])
added('GiB', 'data', 1024 ** 3, ['gibibyte', 'gibibytes'])
added('TiB', 'data', 1024 ** 4, ['tebibyte', 'tebibytes'])
added('kbit', 'data', 125, ['kilobit', 'kilobits'], ['Kb'])
added('Mbit', 'data', 125e3, ['megabit', 'megabits'], ['Mb'])
added('Gbit', 'data', 125e6, ['gigabit', 'gigabits'], ['Gb'])
added('Tbit', 'data', 125e9, ['terabit', 'terabits'], ['Tb'])
// Speed in metres per second.
added('m/s', 'speed', 1, ['mps', 'meter per second', 'meters per second', 'metre per second', 'metres per second'])
added('km/h', 'speed', 1000 / 3600, ['kph', 'kmh', 'kmph', 'km/hr', 'kilometer per hour', 'kilometers per hour', 'kilometre per hour', 'kilometres per hour'])
added('mph', 'speed', 0.44704, ['mi/h', 'mi/hr', 'mile per hour', 'miles per hour'])
added('knot', 'speed', 1852 / 3600, ['knots', 'kn', 'kt', 'kts'])

/** "length: mm, cm, …; mass: …" for unknown-unit errors. */
const CATALOG = (() => {
  const byDimension = new Map<string, Set<string>>()
  for (const definition of [...units.values(), ...symbols.values()]) {
    const names = byDimension.get(definition.dimension) ?? new Set<string>()
    byDimension.set(definition.dimension, names.add(definition.dimension === 'temperature' ? definition.name.toUpperCase() : definition.name))
  }
  return [...byDimension].map(([dimension, names]) => `${dimension}: ${[...names].join(', ')}`).join('; ')
})()
const DIMENSION_EXAMPLES = new Map<string, Record<string, unknown>>([
  ['length', { value: 10, from: 'km', to: 'mi' }], ['mass', { value: 2, from: 'kg', to: 'lb' }],
  ['volume', { value: 1, from: 'gal', to: 'l' }], ['temperature', { value: 100, from: 'C', to: 'F' }],
  ['time', { value: 90, from: 'min', to: 'h' }], ['data', { value: 1, from: 'GiB', to: 'MB' }],
  ['speed', { value: 60, from: 'mph', to: 'km/h' }],
])
const exampleFor = (dimension: string): Record<string, unknown> => DIMENSION_EXAMPLES.get(dimension) ?? { value: 10, from: 'km', to: 'mi' }

/** Exact-case symbol first ("b" bit, "MB" folds to megabyte), then the case-folded name. */
function findUnit(raw: string): Unit | undefined {
  const trimmed = raw.trim()
  return symbols.get(trimmed) ?? units.get(trimmed.toLowerCase().replace(/\s+/g, ' '))
}

export const mathTools: ToolEntry[] = [
  {
    name: 'calculate', category: 'math', effect: 'read',
    description: 'Calculate + - * / % (remainder) ^ with parentheses, functions sqrt abs round floor ceil min max log (base 10) ln exp, and constants pi e. No code. Example: {"expression":"round(sqrt(2) * 100, 1)"}',
    parameters: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] },
    handler(args) {
      const expression = readString(args, 'expression', { required: true, max: 512, example: CALC_EXAMPLE })!
      return { expression, result: calculate(expression) }
    },
  },
  {
    name: 'convert_units', category: 'math', effect: 'read',
    description: 'Convert length (mm cm m km in ft yd mi), mass (g kg oz lb), volume (ml l cup fl oz gal imp gal), temp (C F K), time (ms s min h day week), data (bit B KB-TB KiB-TiB), speed (m/s km/h mph knot). Example: {"value":10,"from":"km","to":"mi"}',
    parameters: {
      type: 'object', properties: { value: { type: 'number' }, from: { type: 'string' }, to: { type: 'string' } },
      required: ['value', 'from', 'to'],
    },
    handler(args) {
      const example = { value: 10, from: 'km', to: 'mi' }
      const value = readNumber(args, 'value', { required: true, min: -1e100, max: 1e100, example })!
      const fromRaw = readString(args, 'from', { required: true, max: 40, example })!
      const toRaw = readString(args, 'to', { required: true, max: 40, example })!
      const from = findUnit(fromRaw)
      const to = findUnit(toRaw)
      if (!from || !to) {
        const known = from ?? to
        throw argError(`Unknown unit "${(from ? toRaw : fromRaw).trim()}". Supported: ${CATALOG}.`, known ? exampleFor(known.dimension) : example)
      }
      if (from.dimension !== to.dimension) {
        throw argError(`Cannot convert ${from.name} (${from.dimension}) to ${to.name} (${to.dimension}); units must measure the same dimension.`, exampleFor(from.dimension))
      }
      const raw = from.name === to.name ? value : (value * from.scale + from.offset - to.offset) / to.scale
      if (!Number.isFinite(raw)) throw argError('Conversion result must be finite.', example)
      // New units are tidied (1 mph is 1.609344 km/h, not 1.6093439999999999); the original catalog is unchanged.
      const result = from.legacy && to.legacy || from.name === to.name ? raw : Number(raw.toPrecision(15))
      return { value, from: from.name, to: to.name, result }
    },
  },
]
