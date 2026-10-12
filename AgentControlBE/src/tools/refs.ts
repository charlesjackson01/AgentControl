/**
 * Content references: a text parameter may be literal text, "@input" (this
 * run's user message) or "@note:<id or title>". Resolving here means large
 * content never has to pass through the model's output tokens. JSON/CSV
 * params given "@input" take the message's first fenced code block, if any.
 */
import { findNote } from './args.js'
import type { ContentParams, ToolContext } from './types.js'

const NOTE_REF = /^@note:(.{1,200})$/s

/** Body of the first ``` fenced block, or undefined. */
export function firstFencedBlock(text: string): string | undefined {
  const open = text.indexOf('```')
  if (open === -1) return undefined
  const lineEnd = text.indexOf('\n', open)
  if (lineEnd === -1) return undefined
  const close = text.indexOf('```', lineEnd + 1)
  if (close === -1) return undefined
  return text.slice(lineEnd + 1, close).replace(/\n$/, '')
}

export interface ResolvedRefs {
  args: Record<string, unknown>
  /** param → "@input" | "@note:<id>" for every ref that was resolved. */
  sources: Record<string, string>
}

export function resolveContentRefs(
  spec: ContentParams | undefined,
  args: Record<string, unknown>,
  ctx: ToolContext,
): ResolvedRefs {
  if (!spec) return { args, sources: {} }
  const next: Record<string, unknown> = { ...args }
  const sources: Record<string, string> = {}
  for (const name of spec.names) {
    let value = Object.hasOwn(next, name) ? next[name] : undefined
    if ((value === undefined || value === null || value === '') && spec.defaultParam === name) value = '@input'
    // Structured params: accept an object/array the model inlined instead of a JSON string.
    if (spec.structured && value !== null && typeof value === 'object') {
      next[name] = JSON.stringify(value)
      continue
    }
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed === '@input') {
      next[name] = spec.structured ? (firstFencedBlock(ctx.input) ?? ctx.input) : ctx.input
      sources[name] = '@input'
      continue
    }
    const ref = NOTE_REF.exec(trimmed)
    if (ref?.[1]) {
      if (!ctx.allowed.has('read_note')) {
        throw new Error(`"@note:" references need the read_note tool, which this agent does not have. Paste the text instead.`)
      }
      const note = findNote(ctx.store, ref[1].trim())
      if (!note) throw new Error(`No note "${ref[1].trim().slice(0, 80)}". Use list_notes to find the id or exact title.`)
      next[name] = spec.structured ? (firstFencedBlock(note.body) ?? note.body) : note.body
      sources[name] = `@note:${note.id}`
    }
  }
  return { args: next, sources }
}
