/**
 * Content references: a text parameter may be literal text or "@input" (this
 * run's user message). Resolving here means large content never has to pass
 * through the model's output tokens. BE-4 retired "@note:" with the notes. JSON/CSV
 * params given "@input" take the message's first fenced code block, if any.
 */
import type { ContentParams, ToolContext } from './types.js'

/** Retired in BE-4; still caught so the model gets a clear error, not the literal string. */
const NOTE_REF = /^@note:/

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
  /** param → "@input" for every ref that was resolved. */
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
    if (NOTE_REF.test(trimmed)) {
      throw new Error('"@note:" references were retired with notes. Paste the text or pass "@input".')
    }
  }
  return { args: next, sources }
}
