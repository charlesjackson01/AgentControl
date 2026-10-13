/**
 * @mentions in the project chat (D-O11, docs/ORCHESTRATION_HANDOFF.md). Pure:
 * no store access, so the routes, the task runner and tests share one rule.
 * The frontend (AgentControlFE) implements the same rule to draw the chips.
 *
 * A mention is "@" followed by an agent's name:
 * - The "@" starts the text, or follows whitespace or an opening bracket or
 *   quote: ( [ { < " ' ` “ ‘ «. So "a@b.com" is not a mention.
 * - The name (trimmed) matches case-insensitively, longest name first, so
 *   "@Copy Editor" tags Copy Editor even when an agent is called "Copy".
 *   Names may contain spaces.
 * - The name ends at a word boundary: the end of the text, or any character
 *   that is not a letter, digit, "_" or "-" ("@Ana," and "@Ana's" tag Ana;
 *   "@Anabel" and "@Ana-Bot" do not).
 * - When two agents share a name, the earlier candidate wins: callers list
 *   Primary first, then the team, then the rest of the library.
 * - An "@word" that names no candidate stays plain text.
 */

export interface MentionCandidate {
  id: string
  name: string
}

/** One tag in the text: `text.slice(start, end)` is "@" plus the name as written. */
export interface MentionSpan {
  start: number
  end: number
  agentId: string
}

export interface ResolvedMentions {
  /** Tagged agent ids in order of first appearance, deduped (at most MENTIONS_MAX). */
  ids: string[]
  /** Every tag of those agents, in text order (at most MENTION_SPANS_MAX). */
  spans: MentionSpan[]
}

/** "@" signs are looked for in the first this many chars (a chat message's cap). */
export const MENTION_TEXT_MAX = 20_000
/** Distinct agents one message can tag; ProjectMessage.mentions holds at most this many. */
export const MENTIONS_MAX = 20
/** Tags returned per text. */
export const MENTION_SPANS_MAX = 100
/** "@" signs examined per text. */
const AT_SIGNS_MAX = 1_000
/** Candidates considered, in preference order. */
const CANDIDATES_MAX = 2_000
/** Names longer than this cannot be tagged. */
const NAME_MAX = 200

/** Characters an "@" may follow (besides whitespace and the start of the text). */
const OPENERS = new Set(['(', '[', '{', '<', '"', "'", '`', '“', '‘', '«'])
/** A character that continues a word: a name followed by one of these is not a tag. */
const WORD_CHAR = /^[\p{L}\p{N}_-]$/u
const SPACE = /^\s$/u

/** The tag for an agent's name, as the BE writes it into chat text (resolveMentions reads it back). */
export const tag = (name: string): string => `@${name.trim()}`

function startsMention(text: string, at: number): boolean {
  if (at === 0) return true
  const before = text.charAt(at - 1)
  return SPACE.test(before) || OPENERS.has(before)
}

function endsWord(text: string, end: number): boolean {
  const next = text.codePointAt(end)
  return next === undefined || !WORD_CHAR.test(String.fromCodePoint(next))
}

/**
 * The agents `text` tags, from `candidates` in preference order (see the
 * module comment for the rule). Bounded: at most MENTION_TEXT_MAX chars are
 * searched for "@", AT_SIGNS_MAX of them examined, and the result capped.
 */
export function resolveMentions(text: string, candidates: readonly MentionCandidate[]): ResolvedMentions {
  if (!text.includes('@')) return { ids: [], spans: [] }
  // Lowercased name -> agent id; the first candidate with a name keeps it.
  const byName = new Map<string, string>()
  const lengths = new Set<number>()
  for (const c of candidates.slice(0, CANDIDATES_MAX)) {
    if (typeof c?.id !== 'string' || typeof c.name !== 'string') continue
    const name = c.name.trim()
    if (name === '' || name.length > NAME_MAX) continue
    const key = name.toLowerCase()
    if (byName.has(key)) continue
    byName.set(key, c.id)
    lengths.add(name.length)
  }
  const ids: string[] = []
  const spans: MentionSpan[] = []
  if (byName.size === 0) return { ids, spans }
  const longestFirst = [...lengths].sort((a, b) => b - a)

  const scanEnd = Math.min(text.length, MENTION_TEXT_MAX)
  let from = 0
  for (let n = 0; n < AT_SIGNS_MAX && spans.length < MENTION_SPANS_MAX; n++) {
    const at = text.indexOf('@', from)
    if (at === -1 || at >= scanEnd) break
    from = at + 1
    if (!startsMention(text, at)) continue
    for (const length of longestFirst) {
      const end = at + 1 + length
      if (end > text.length) continue
      const agentId = byName.get(text.slice(at + 1, end).toLowerCase())
      if (agentId === undefined || !endsWord(text, end)) continue
      if (!ids.includes(agentId)) {
        if (ids.length >= MENTIONS_MAX) break
        ids.push(agentId)
      }
      spans.push({ start: at, end, agentId })
      from = end
      break
    }
  }
  return { ids, spans }
}
