/* Pure helpers for the chat-first agent profile (Avatar + rules editor).
   No React or DOM here so tests/agent-profile.test.mjs can import them. */

/** Up to two initials from a display name: "Support Triage" -> "ST", "lead" -> "L". */
export function initialsOf(name: string): string {
  const words = name
    .trim()
    .split(/[\s\-_.]+/u)
    .filter(Boolean)
  if (words.length === 0) return '?'
  const first = (w: string) => Array.from(w)[0] ?? ''
  const letters = words.length === 1 ? first(words[0]) : first(words[0]) + first(words[words.length - 1])
  return letters.toLocaleUpperCase()
}

/** Palette for the initials fallback when the agent has no `color`. */
export const AVATAR_PALETTE = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6', '#14b8a6']

/** Stable palette colour for a seed (agent id or name). */
export function paletteColor(seed: string): string {
  let h = 0
  for (const ch of seed) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length]
}

/** Emoji offered by the avatar picker. */
export const AVATAR_EMOJI = ['🤖', '🧠', '🦊', '🐙', '🦉', '🐝', '🚀', '🛠️', '📚', '🔍', '✍️', '🎯', '🧪', '💡', '🛡️', '🌱']

export const MAX_RULES = 30
export const MAX_RULE_LENGTH = 500

export function addRule(rules: readonly string[], text = ''): string[] {
  if (rules.length >= MAX_RULES) return [...rules]
  return [...rules, text.slice(0, MAX_RULE_LENGTH)]
}

export function updateRule(rules: readonly string[], index: number, text: string): string[] {
  if (index < 0 || index >= rules.length) return [...rules]
  const next = [...rules]
  next[index] = text.slice(0, MAX_RULE_LENGTH)
  return next
}

export function removeRule(rules: readonly string[], index: number): string[] {
  return rules.filter((_, i) => i !== index)
}

/** Move the rule at `from` by `delta` (-1 up, +1 down); clamps at the ends. */
export function moveRule(rules: readonly string[], from: number, delta: number): string[] {
  const to = from + delta
  if (from < 0 || from >= rules.length || to < 0 || to >= rules.length) return [...rules]
  const next = [...rules]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

/** What gets saved: trimmed, blanks dropped, exact duplicates collapsed (first wins). */
export function normalizeRules(rules: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const r of rules) {
    const t = r.trim()
    if (!t || seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out.slice(0, MAX_RULES)
}

export function rulesEqual(a: readonly string[], b: readonly string[]): boolean {
  const na = normalizeRules(a)
  const nb = normalizeRules(b)
  return na.length === nb.length && na.every((r, i) => r === nb[i])
}
