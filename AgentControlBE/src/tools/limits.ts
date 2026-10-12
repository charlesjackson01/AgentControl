/**
 * Output limits shared by tool handlers. The run loop clips every result to
 * ≤4,000 chars as a backstop; handlers aim lower and shrink structurally so a
 * small model never receives JSON cut off mid-string.
 */

/** Default ceiling for one tool result, leaving room under the loop's clip. */
export const RESULT_MAX_CHARS = 3_500

export function clipText(text: string, max: number): string {
  if (text.length <= max) return text
  let end = Math.max(0, max - 1)
  // Never leave half of a surrogate pair (emoji, rare CJK) before the ellipsis.
  const last = text.charCodeAt(end - 1)
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1
  return `${text.slice(0, end)}…`
}

const isHighSurrogate = (c: number): boolean => c >= 0xd800 && c <= 0xdbff
const isLowSurrogate = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff

/**
 * End of the longest slice text[start, end) holding at most `maxUnits` UTF-16
 * units whose JSON string encoding (quotes excluded) is at most `budget`
 * chars, counted the way JSON.stringify escapes: `"` `\` \b \t \n \f \r take
 * 2, other control chars and lone surrogates 6 (\uXXXX). Never ends between
 * the halves of a surrogate pair. O(maxUnits).
 */
function jsonSliceEnd(text: string, start: number, maxUnits: number, budget: number): number {
  const limit = Math.min(text.length, start + Math.max(0, maxUnits))
  let i = start
  let used = 0
  while (i < limit) {
    const c = text.charCodeAt(i)
    let units = 1
    let cost = 1
    if (isHighSurrogate(c) && i + 1 < text.length && isLowSurrogate(text.charCodeAt(i + 1))) {
      units = 2
      cost = 2
    } else if (c >= 0xd800 && c <= 0xdfff) {
      cost = 6
    } else if (c === 0x22 || c === 0x5c || c === 0x08 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d) {
      cost = 2
    } else if (c < 0x20) {
      cost = 6
    }
    if (i + units > limit || used + cost > budget) break
    used += cost
    i += units
  }
  return i
}

/**
 * clipText bounded by JSON size too: at most `max` chars whose JSON string
 * (quotes included) is at most `jsonMax` chars, ending in "…" when cut. For
 * short fields that sit next to a page, so their escapes cannot squeeze it.
 */
export function clipJsonText(text: string, max: number, jsonMax: number): string {
  if (jsonSliceEnd(text, 0, max, jsonMax - 2) >= text.length) return text
  return `${text.slice(0, jsonSliceEnd(text, 0, max - 1, jsonMax - 3))}…`
}

/** One page of a longer text; `content` is text[offset, nextOffset ?? totalChars). */
export interface TextPage {
  content: string
  offset: number
  /** Where the next page starts, or null on the last page. */
  nextOffset: number | null
  totalChars: number
}

/**
 * The page of `text` starting at `offset`: at most `pageChars` UTF-16 units,
 * shrunk so JSON.stringify(content).length stays within `jsonBudget` (escapes
 * count). The caller budgets the whole result under its cap, so fitJson never
 * clips the page and nextOffset stays exact. Never splits a surrogate pair:
 * an offset between the halves (not one a page returned) starts at the pair.
 * Throws RangeError for a negative, fractional or past-the-end offset; the
 * caller turns it into an argError. `text` must already be redacted: offsets
 * index the text as given.
 */
export function pageText(text: string, offset: number, pageChars: number, jsonBudget: number): TextPage {
  // One code point costs at most 2 units and 6 JSON chars, so every page makes progress.
  if (!Number.isInteger(pageChars) || pageChars < 2) throw new Error('Page size must be at least 2 characters.')
  if (!Number.isInteger(jsonBudget) || jsonBudget < 8) throw new Error('Page JSON budget must be at least 8 characters.')
  const total = text.length
  if (!Number.isInteger(offset) || offset < 0) throw new RangeError(`Offset must be a whole number of at least 0 (got ${offset}).`)
  if (offset > 0 && offset >= total) {
    throw new RangeError(`Offset ${offset} is past the end of the text (${total} chars); the last page has "nextOffset": null.`)
  }
  let start = offset
  if (start > 0 && isLowSurrogate(text.charCodeAt(start)) && isHighSurrogate(text.charCodeAt(start - 1))) start -= 1
  const end = jsonSliceEnd(text, start, pageChars, jsonBudget - 2)
  return { content: text.slice(start, end), offset: start, nextOffset: end < total ? end : null, totalChars: total }
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

function toJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value ?? null)) as Json
}

function size(value: Json): number {
  return JSON.stringify(value).length
}

/** Account for escaping in the enclosing JSON, not just the preview text. */
function preview(value: string, max: number): Json {
  let low = 0
  let high = Math.min(value.length, max)
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (size({ truncated: true, preview: clipText(value, mid) }) <= max) low = mid
    else high = mid - 1
  }
  return { truncated: true, preview: clipText(value, low) }
}

/** Own-property write: plain assignment to "__proto__" would set the prototype. */
function put(target: object, key: string | number, value: Json): void {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true })
}

/** Every array and long string in the tree, with a setter to replace it. */
function collect(root: Json): { get(): Json; set(v: Json): void; path: string }[] {
  const out: { get(): Json; set(v: Json): void; path: string }[] = []
  const walk = (node: Json, get: () => Json, set: (v: Json) => void, path: string, depth: number) => {
    if (depth > 32) return
    if (Array.isArray(node)) {
      out.push({ get, set, path })
      node.forEach((child, i) =>
        walk(child, () => (get() as Json[])[i] as Json, (v) => put(get() as Json[], i, v), `${path}[${i}]`, depth + 1),
      )
    } else if (node && typeof node === 'object') {
      for (const key of Object.keys(node)) {
        walk(
          node[key] as Json,
          () => (get() as Record<string, Json>)[key] as Json,
          (v) => put(get() as Record<string, Json>, key, v),
          path ? `${path}.${key}` : key,
          depth + 1,
        )
      }
    } else if (typeof node === 'string' && node.length > 80) {
      out.push({ get, set, path })
    }
  }
  const holder = { root }
  walk(root, () => holder.root, (v) => { holder.root = v }, '', 0)
  return out
}

/**
 * Return `value` unchanged when its JSON fits in `max` chars; otherwise shrink
 * the largest arrays (halving) and longest strings until it fits, and report
 * `truncated: true` with the original lengths. Top-level arrays are wrapped as
 * `{ items, truncated, total }` so the marker has somewhere to live.
 */
export function fitJson(value: unknown, max: number = RESULT_MAX_CHARS): unknown {
  if (!Number.isInteger(max) || max < 64) throw new Error('JSON result budget must be at least 64 characters.')
  const json = toJson(value)
  if (size(json) <= max) return json

  let root: Json = Array.isArray(json) ? { items: json, total: json.length } : json
  if (root === null || typeof root !== 'object') {
    return preview(String(root), max)
  }
  const omitted = new Map<string, number>()
  const holder = { root }
  for (let pass = 0; pass < 200 && size(holder.root) > max - 120; pass++) {
    const candidates = collect(holder.root)
      .map((c) => ({ ...c, bytes: size(c.get()) }))
      .filter((c) => {
        const v = c.get()
        return Array.isArray(v) ? v.length > 1 : typeof v === 'string' && v.length > 40
      })
      .sort((a, b) => b.bytes - a.bytes)
    const target = candidates[0]
    if (!target) break
    const current = target.get()
    if (Array.isArray(current)) {
      const key = target.path || 'items'
      if (!omitted.has(key)) omitted.set(key, current.length)
      target.set(current.slice(0, Math.ceil(current.length / 2)))
    } else if (typeof current === 'string') {
      target.set(clipText(current, Math.max(40, Math.floor(current.length / 2))))
    }
  }
  root = holder.root as { [key: string]: Json }
  const result: { [key: string]: Json } = { ...root, truncated: true }
  if (omitted.size > 0) result.totals = Object.fromEntries(omitted)
  if (size(result) > max) {
    return preview(JSON.stringify(root), max)
  }
  return result
}
