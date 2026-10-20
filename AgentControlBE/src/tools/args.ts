/**
 * Lenient argument readers for tool handlers. Small local models send "5" for
 * 5, "True" for true, "a, b" for ["a","b"] and agent names for ids; accept
 * those, ignore unknown keys, and make every error end with a corrected
 * example so the model can fix the call within the loop's 4 iterations.
 */
import type { Agent, Note, Skill } from '../shared/types.js'
import type { WorkspaceStore } from '../store.js'

/** Error whose message ends with `Example: {...}` for the model to copy. */
export function argError(message: string, example: Record<string, unknown>): Error {
  return new Error(`${message} Example: ${JSON.stringify(example)}`)
}

function has(args: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(args, key) && args[key] !== undefined && args[key] !== null && args[key] !== ''
}

export interface StrOptions {
  required?: boolean
  max?: number
  example: Record<string, unknown>
}

/** String param (numbers/booleans are stringified). Throws when required and missing or too long. */
export function readString(args: Record<string, unknown>, key: string, opts: StrOptions): string | undefined {
  if (!has(args, key)) {
    if (opts.required) throw argError(`"${key}" is required.`, opts.example)
    return undefined
  }
  const raw = args[key]
  const value = typeof raw === 'string' ? raw : typeof raw === 'number' || typeof raw === 'boolean' ? String(raw) : undefined
  if (value === undefined) throw argError(`"${key}" must be a string.`, opts.example)
  if (opts.max !== undefined && value.length > opts.max) {
    throw argError(`"${key}" is too long (${value.length} chars, max ${opts.max}).`, opts.example)
  }
  return value
}

export interface NumOptions {
  required?: boolean
  min?: number
  max?: number
  integer?: boolean
  example: Record<string, unknown>
}

/** Number param; accepts numeric strings like "5" or " 2.5 ". */
export function readNumber(args: Record<string, unknown>, key: string, opts: NumOptions): number | undefined {
  if (!has(args, key)) {
    if (opts.required) throw argError(`"${key}" is required.`, opts.example)
    return undefined
  }
  const raw = args[key]
  const value =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && /^\s*[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?\s*$/.test(raw)
        ? Number(raw)
        : Number.NaN
  if (!Number.isFinite(value)) throw argError(`"${key}" must be a number.`, opts.example)
  if (opts.integer && !Number.isInteger(value)) throw argError(`"${key}" must be a whole number.`, opts.example)
  if (opts.min !== undefined && value < opts.min) throw argError(`"${key}" must be at least ${opts.min}.`, opts.example)
  if (opts.max !== undefined && value > opts.max) throw argError(`"${key}" must be at most ${opts.max}.`, opts.example)
  return value
}

/** Boolean param; accepts true/false, "true"/"false", "yes"/"no", 1/0. */
export function readBoolean(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
  if (!has(args, key)) return fallback
  const raw = args[key]
  if (typeof raw === 'boolean') return raw
  if (raw === 1 || raw === 0) return raw === 1
  if (typeof raw === 'string') {
    const v = raw.trim().toLowerCase()
    if (['true', 'yes', '1'].includes(v)) return true
    if (['false', 'no', '0'].includes(v)) return false
  }
  return fallback
}

export interface ListOptions {
  max: number
  example: Record<string, unknown>
}

/** String-list param; accepts an array or a comma/newline separated string. Empty items dropped. */
export function readList(args: Record<string, unknown>, key: string, opts: ListOptions): string[] | undefined {
  if (!has(args, key)) return undefined
  const raw = args[key]
  const items = Array.isArray(raw)
    ? raw.map((v) => (typeof v === 'string' || typeof v === 'number' ? String(v) : ''))
    : typeof raw === 'string'
      ? raw.split(/[,\n]/)
      : null
  if (!items) throw argError(`"${key}" must be a list.`, opts.example)
  const cleaned = items.map((v) => v.trim()).filter(Boolean)
  if (cleaned.length > opts.max) throw argError(`"${key}" has ${cleaned.length} items (max ${opts.max}).`, opts.example)
  return cleaned
}

export interface EnumOptions<T extends string> {
  required?: boolean
  fallback?: T
  example: Record<string, unknown>
}

/**
 * Enum param, matched case-insensitively and tolerant of a trailing "s"
 * ("Days" → "day", "minute" → "minutes"), spaces/dashes as underscores.
 */
export function readEnum<T extends string>(
  args: Record<string, unknown>,
  key: string,
  values: readonly T[],
  opts: EnumOptions<T>,
): T | undefined {
  if (!has(args, key)) {
    if (opts.required) throw argError(`"${key}" is required (one of: ${values.join(', ')}).`, opts.example)
    return opts.fallback
  }
  const raw = args[key]
  if (typeof raw !== 'string') throw argError(`"${key}" must be one of: ${values.join(', ')}.`, opts.example)
  const norm = (v: string) => v.trim().toLowerCase().replace(/[\s-]+/g, '_').replace(/s$/, '')
  const wanted = norm(raw)
  const match = values.find((v) => norm(v) === wanted)
  if (!match) throw argError(`"${key}" must be one of: ${values.join(', ')} (got "${raw.slice(0, 40)}").`, opts.example)
  return match
}

const fold = (s: string) => s.trim().toLowerCase()

/** Agent by id or case-insensitive name. */
export function findAgent(store: WorkspaceStore, ref: string): Agent | undefined {
  return store.agents.find((a) => a.id === ref) ?? store.agents.find((a) => fold(a.name) === fold(ref))
}

/** Skill by id or case-insensitive name. */
export function findSkill(store: WorkspaceStore, ref: string): Skill | undefined {
  return findSkillIn(store.skills, ref)
}

/** findSkill over a given list (e.g. the skills a run may read). */
export function findSkillIn(skills: readonly Skill[], ref: string): Skill | undefined {
  const exact = skills.find((s) => s.id === ref) ?? skills.find((s) => fold(s.name) === fold(ref))
  if (exact || ref.includes('/')) return exact
  // BE-6 ids are <source>/<name>; a bare name a model copies resolves when only one source has it.
  const suffix = `/${fold(ref)}`
  const matches = skills.filter((s) => s.id.toLowerCase().endsWith(suffix))
  return matches.length === 1 ? matches[0] : undefined
}

/** Note by id or case-insensitive title. */
export function findNote(store: WorkspaceStore, ref: string): Note | undefined {
  return store.notes.find((n) => n.id === ref) ?? store.notes.find((n) => fold(n.title) === fold(ref))
}
