import { argError, readNumber, readString } from './args.js'
import type { ToolEntry } from './types.js'

const CALC_EXAMPLE = { expression: '(12 + 3) * 2' }

/** A bounded arithmetic grammar; no identifiers or executable expressions. */
function calculate(source: string): number {
  let position = 0
  let depth = 0
  const fail = (message: string): never => { throw argError(message, CALC_EXAMPLE) }
  const skip = () => { while (/\s/.test(source[position] ?? '') && position < source.length) position++ }
  const finite = (value: number): number => Number.isFinite(value) ? value : fail('The calculation must have a finite real result.')
  const take = (symbol: string): boolean => {
    skip()
    if (!source.startsWith(symbol, position)) return false
    position += symbol.length
    return true
  }
  const primary = (): number => {
    if (take('(')) {
      const value = sum()
      if (!take(')')) fail('Missing closing parenthesis.')
      return value
    }
    skip()
    const match = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(source.slice(position))
    if (!match) return fail('Expected a number or parentheses; only + - * / % ^ are supported.')
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
  if (position !== source.length) fail('Unexpected input; use numbers, parentheses, and + - * / % ^ only.')
  return Object.is(result, -0) ? 0 : result
}

type Unit = { name: string; dimension: string; scale: number; offset: number }
const units = new Map<string, Unit>()
function unit(name: string, dimension: string, scale: number, aliases: string[], offset = 0): void {
  const definition = { name, dimension, scale, offset }
  for (const alias of [name, ...aliases]) units.set(alias, definition)
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

export const mathTools: ToolEntry[] = [
  {
    name: 'calculate', category: 'math', effect: 'read',
    description: 'Calculate arithmetic with + - * / % ^ (or **), parentheses, and scientific notation. Powers associate right; no code or functions. Example: {"expression":"(12 + 3) * 2"}',
    parameters: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] },
    handler(args) {
      const expression = readString(args, 'expression', { required: true, max: 512, example: CALC_EXAMPLE })!
      return { expression, result: calculate(expression) }
    },
  },
  {
    name: 'convert_units', category: 'math', effect: 'read',
    description: 'Convert length (mm cm m km in ft yd mi), mass (g kg oz lb), volume (ml l), or temperature (C F K). Full unit names also work. Example: {"value":10,"from":"km","to":"mi"}',
    parameters: {
      type: 'object', properties: { value: { type: 'number' }, from: { type: 'string' }, to: { type: 'string' } },
      required: ['value', 'from', 'to'],
    },
    handler(args) {
      const example = { value: 10, from: 'km', to: 'mi' }
      const value = readNumber(args, 'value', { required: true, min: -1e100, max: 1e100, example })!
      const from = units.get(readString(args, 'from', { required: true, max: 40, example })!.trim().toLowerCase())
      const to = units.get(readString(args, 'to', { required: true, max: 40, example })!.trim().toLowerCase())
      if (!from || !to) throw argError('Unknown unit. Use a supported length, mass, volume, or temperature unit.', example)
      if (from.dimension !== to.dimension) throw argError('Units must measure the same dimension.', example)
      const result = from.name === to.name ? value : (value * from.scale + from.offset - to.offset) / to.scale
      if (!Number.isFinite(result)) throw argError('Conversion result must be finite.', example)
      return { value, from: from.name, to: to.name, result }
    },
  },
]
