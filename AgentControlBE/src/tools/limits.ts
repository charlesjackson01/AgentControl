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
