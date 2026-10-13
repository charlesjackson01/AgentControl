/**
 * D-O11: @Name tags in the project chat (pure; no store access).
 *
 * Every agent named in a project message is a mention: `@` followed by the
 * longest matching agent name, case-insensitive, ending at a word boundary.
 * Candidates are ordered by preference — Primary and the project's team come
 * first, so a name that matches both a team member and another library agent
 * resolves to the team member. Unmatched `@words` stay plain text.
 */

export interface MentionCandidate {
  id: string
  name: string
}

export interface MentionSpan {
  /** Agent id the span names. */
  id: string
  /** Offset of the '@' in the text. */
  start: number
  /** Offset just past the matched name. */
  end: number
  /** The name as it appears in the text (the client's spelling). */
  name: string
}

/** Longest agent name considered for a tag (names are capped at 60; room for slop). */
const MAX_TAG_CHARS = 80

/** True when `text[i]` ends a name that started before i. */
function boundaryAfter(text: string, i: number): boolean {
  if (i >= text.length) return true
  const next = text[i]!
  return !/[\p{L}\p{N}_]/u.test(next)
}

/**
 * Find every `@Name` tag in `text`. Returns spans sorted by position and a
 * deduped id list in order of first match. Earlier candidates win ties on
 * length (the caller orders Primary and the team first).
 */
export function resolveMentions(
  text: string,
  candidates: readonly MentionCandidate[],
): { ids: string[]; spans: MentionSpan[] } {
  const usable = candidates.filter((c) => typeof c.id === 'string' && c.name.trim().length > 0)
  const spans: MentionSpan[] = []
  if (usable.length === 0) return { ids: [], spans }

  let i = 0
  while (i < text.length) {
    const at = text.indexOf('@', i)
    if (at === -1) break
    // The tag body: up to MAX_TAG_CHARS of word characters and spaces, so
    // names with spaces can match; the match itself must end at a boundary.
    const bodyStart = at + 1
    const first = text[bodyStart]
    if (bodyStart >= text.length || !first || !/[\p{L}\p{N}_]/u.test(first)) {
      i = bodyStart
      continue
    }
    let bodyEnd = bodyStart
    while (bodyEnd < text.length && bodyEnd - bodyStart < MAX_TAG_CHARS && /[\p{L}\p{N}_\s]/u.test(text[bodyEnd]!)) bodyEnd++
    const body = text.slice(bodyStart, bodyEnd)
    const lower = body.toLowerCase()
    let best: { id: string; length: number } | null = null
    for (const c of usable) {
      const name = c.name.trim()
      const n = name.toLowerCase()
      if (!lower.startsWith(n)) continue
      if (lower.length > n.length && !boundaryAfter(lower, n.length)) continue
      if (!best || n.length > best.length) best = { id: c.id, length: name.length }
    }
    if (best) {
      spans.push({ id: best.id, start: at, end: bodyStart + best.length, name: text.slice(bodyStart, bodyStart + best.length) })
      i = bodyStart + best.length
    } else {
      i = bodyStart
    }
  }

  const ids: string[] = []
  for (const s of spans) if (!ids.includes(s.id)) ids.push(s.id)
  return { ids, spans }
}

/**
 * Candidates for one project message write: Primary and the project's team
 * first (in that order), then the rest of the library. `primary` may be
 * undefined (no Team Lead yet).
 */
export function mentionCandidates(
  primary: { id: string; name: string } | undefined,
  team: readonly { id: string; name: string }[],
  everyone: readonly { id: string; name: string }[],
): MentionCandidate[] {
  const out: MentionCandidate[] = []
  const seen = new Set<string>()
  const push = (a: { id: string; name: string }) => {
    if (!seen.has(a.id)) {
      seen.add(a.id)
      out.push({ id: a.id, name: a.name })
    }
  }
  if (primary) push(primary)
  for (const a of team) push(a)
  for (const a of everyone) push(a)
  return out
}
