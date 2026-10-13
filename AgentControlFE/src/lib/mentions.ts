/* ==========================================================================
   @mentions (D-O11). Pure, no React; covered by tests/mentions.test.mjs.

   Tagging is part of the project chat: every agent named as @Name in a
   message is a tag. The BE resolves `ProjectMessage.mentions` on every write
   (the ids the user picked in the composer, or by parsing an agent's or the
   runner's text); the page only finds where those ids sit in the text, so it
   can show them as chips. Both sides apply the same rules:

   - A mention is "@" followed by an agent's name, matched ignoring case,
     longest name first (names may contain spaces: "@Copy Editor").
   - It ends at a word boundary: the end of the text, or any character that
     is not a letter, a digit, "_" or "-".
   - The "@" starts the text or follows whitespace or an opening bracket or
     quote: ( [ { " ' “ ‘ «. So an email (a@b.com) is never a mention.
   - When two agents share a name, the earlier one in the given list wins:
     callers order it Primary, the team, then other library agents
     (mentionOrder).
   - "@words" that name no agent stay plain text.
   The bounds match the BE's resolveMentions (AgentControlBE/src/mentions.ts),
   so both sides find the same tags in the same text.
   ========================================================================== */

/** An agent that can be tagged: its id, its name and (for the picker and chip titles) its role. */
export type MentionAgent = {
  id: string
  name: string
  role?: string
}

/** Where a tag sits in a text: `text.slice(start, end)` is "@Name" (as typed); `id` is the agent. */
export type MentionSpan = {
  start: number
  end: number
  id: string
}

/** Characters after which an "@" may start a mention (besides whitespace and the start of the text). */
const OPENERS = new Set(['(', '[', '{', '"', "'", '“', '‘', '«'])

/** A character that continues a word, so a name followed by one is not a whole-word match. */
const WORD_CHAR = /^[\p{L}\p{N}_-]$/u

/** "@" signs are looked for in the first this many characters (a chat message's cap). */
export const MENTION_TEXT_MAX = 20_000
/** Distinct agents one text can tag (ProjectMessage.mentions holds at most this many). */
export const MENTIONS_MAX = 20
/** Tags found per text. */
const MENTION_SPANS_MAX = 100
/** "@" signs examined per text. */
const AT_SIGNS_MAX = 1_000
/** Agents considered, in preference order. */
const CANDIDATES_MAX = 2_000
/** Names longer than this cannot be tagged. */
const NAME_MAX = 200

/** Longest query the composer picker looks back for (agent names are short; bounds the scan). */
export const MENTION_QUERY_MAX = 64

const norm = (s: string): string => s.trim().toLowerCase()

/** Whether the "@" at `at` can start a mention: first in the text, or after whitespace or an opening bracket/quote. */
export function mentionStartsAt(text: string, at: number): boolean {
  if (text[at] !== '@') return false
  if (at === 0) return true
  const before = text[at - 1]
  return /\s/.test(before) || OPENERS.has(before)
}

/** Whether a name that ends at `end` ends on a word boundary (checked by code point). */
function endsWord(text: string, end: number): boolean {
  const next = text.codePointAt(end)
  return next === undefined || !WORD_CHAR.test(String.fromCodePoint(next))
}

/**
 * Every @mention in `text`, in order and without overlaps. `agents` is in
 * preference order (Primary, the team, then the library); when `ids` is
 * given, only those agents are matched (a stored message's `mentions`).
 */
export function mentionSpans(
  text: string,
  agents: readonly Pick<MentionAgent, 'id' | 'name'>[],
  ids?: readonly string[],
): MentionSpan[] {
  const allowed = ids ? new Set(ids) : null
  // Lowercased name -> agent id: the first agent with a name keeps it.
  const byName = new Map<string, string>()
  const lengths = new Set<number>()
  for (const a of agents.slice(0, CANDIDATES_MAX)) {
    if (allowed && !allowed.has(a.id)) continue
    if (a.name.trim() === '' || a.name.length > NAME_MAX) continue
    const key = a.name.toLowerCase()
    if (byName.has(key)) continue
    byName.set(key, a.id)
    lengths.add(a.name.length)
  }
  const spans: MentionSpan[] = []
  if (byName.size === 0) return spans
  const longestFirst = [...lengths].sort((a, b) => b - a)
  const tagged = new Set<string>()
  const scanEnd = Math.min(text.length, MENTION_TEXT_MAX)
  let from = 0
  for (let n = 0; n < AT_SIGNS_MAX && spans.length < MENTION_SPANS_MAX; n += 1) {
    const at = text.indexOf('@', from)
    if (at === -1 || at >= scanEnd) break
    from = at + 1
    if (!mentionStartsAt(text, at)) continue
    for (const length of longestFirst) {
      const end = at + 1 + length
      if (end > text.length) continue
      const id = byName.get(text.slice(at + 1, end).toLowerCase())
      if (id === undefined || !endsWord(text, end)) continue
      if (!tagged.has(id)) {
        if (tagged.size >= MENTIONS_MAX) break
        tagged.add(id)
      }
      spans.push({ start: at, end, id })
      from = end
      break
    }
  }
  return spans
}

/** Agent ids in order of first appearance, without duplicates. */
export function uniqueIds(spans: readonly Pick<MentionSpan, 'id'>[]): string[] {
  return [...new Set(spans.map((s) => s.id))]
}

/**
 * Agents in mention preference order: Primary, then team members in team
 * order, then every other agent in the given order. Team ids that name no
 * agent are skipped.
 */
export function mentionOrder<T extends { id: string }>(
  agents: readonly T[],
  primaryId: string | undefined,
  teamAgentIds: readonly string[],
): T[] {
  const byId = new Map(agents.map((a) => [a.id, a]))
  const out: T[] = []
  const seen = new Set<string>()
  const push = (id: string | undefined) => {
    const agent = id === undefined ? undefined : byId.get(id)
    if (!agent || seen.has(agent.id)) return
    seen.add(agent.id)
    out.push(agent)
  }
  push(primaryId)
  for (const id of teamAgentIds) push(id)
  for (const a of agents) push(a.id)
  return out
}

/** Who the composer's @ picker offers: Primary, then the team members still in the library. */
export function pickerCandidates<T extends { id: string }>(
  agents: readonly T[],
  primaryId: string | undefined,
  teamAgentIds: readonly string[],
): T[] {
  const team = new Set(teamAgentIds)
  return mentionOrder(agents, primaryId, teamAgentIds).filter((a) => a.id === primaryId || team.has(a.id))
}

/* -- Composer ------------------------------------------------------------------ */

/** The "@query" the caret is in: where its "@" is and what follows it up to the caret. */
export type MentionQuery = {
  start: number
  query: string
}

/**
 * The "@…" being typed at the caret, or null. The "@" must start a mention
 * (not an email) and sit on the caret's line, at most MENTION_QUERY_MAX
 * characters back. The query may hold spaces, because names can ("@Copy
 * Ed"); one that starts with a space is not a mention ("@ noon").
 */
export function activeMentionQuery(text: string, caret: number): MentionQuery | null {
  const end = Math.min(Math.max(caret, 0), text.length)
  const stop = Math.max(0, end - 1 - MENTION_QUERY_MAX)
  for (let i = end - 1; i >= stop; i -= 1) {
    const ch = text[i]
    if (ch === '\n' || ch === '\r') return null
    if (ch !== '@') continue
    if (!mentionStartsAt(text, i)) return null
    const query = text.slice(i + 1, end)
    return /^\s/.test(query) ? null : { start: i, query }
  }
  return null
}

/**
 * Whether the picker stays shut for the "@…" at the caret: the user closed
 * it (Esc) or picked a name at this "@", and is still typing on from there.
 * Deleting back past that point, or starting another "@", opens it again.
 */
export function mentionDismissed(current: MentionQuery | null, dismissed: MentionQuery | null): boolean {
  if (!current || !dismissed || current.start !== dismissed.start) return false
  return current.query.toLowerCase().startsWith(dismissed.query.toLowerCase())
}

/**
 * Picker options for a query, ignoring case: names that start with it, then
 * names that contain it; each group keeps the candidates' order (Primary
 * first). An empty query offers everyone.
 */
export function filterCandidates<T extends Pick<MentionAgent, 'name'>>(query: string, candidates: readonly T[]): T[] {
  const q = query.toLowerCase()
  if (!q.trim()) return [...candidates]
  const prefix: T[] = []
  const inside: T[] = []
  for (const c of candidates) {
    const name = c.name.trim().toLowerCase()
    if (name.startsWith(q)) prefix.push(c)
    else if (name.includes(q)) inside.push(c)
  }
  return [...prefix, ...inside]
}

/** The candidate whose name the query spells out in full (ignoring case), or null: typing a whole name picks it. */
export function exactCandidate<T extends Pick<MentionAgent, 'name'>>(query: string, candidates: readonly T[]): T | null {
  const q = norm(query)
  if (!q) return null
  return candidates.find((c) => norm(c.name) === q) ?? null
}

/**
 * Replace the "@query" from `start` (its "@") through the end of the word at
 * the caret with "@Name " and put the caret after it. An existing space after
 * the word is reused instead of doubled.
 */
export function insertMention(text: string, start: number, caret: number, name: string): { text: string; caret: number } {
  const from = Math.min(Math.max(start, 0), text.length)
  let end = Math.min(Math.max(caret, from), text.length)
  // The rest of the word under the caret ("@Co|py" replaces "@Copy"); bounded by the text.
  while (end < text.length && !/\s/.test(text[end])) end += 1
  const tag = `@${name.trim()}`
  const after = text.slice(end)
  const spaced = after.startsWith(' ') ? after : ` ${after}`
  return { text: text.slice(0, from) + tag + spaced, caret: from + tag.length + 1 }
}

/** The ids of picked agents whose @Name is still in the text, in order of first appearance. */
export function pickedMentionIds(text: string, picked: readonly Pick<MentionAgent, 'id' | 'name'>[]): string[] {
  return uniqueIds(mentionSpans(text, picked))
}

/**
 * Who gets a user message directly (D-O11): when it tags team members and
 * not Primary, those members (each gets the message as a task, no plan);
 * otherwise nobody, and it goes to Primary's plan as before.
 */
export function directTargets(mentions: readonly string[], primaryId: string | undefined): string[] {
  if (primaryId !== undefined && mentions.includes(primaryId)) return []
  return [...new Set(mentions)]
}

/** Send button text: "Send to @Ana" / "Send to @Ana, @Ben" / "Send to @Ana, @Ben +2", or "Ask @Atlas". */
export function sendLabel(targetNames: readonly string[], primaryName: string): string {
  if (targetNames.length === 0) return `Ask @${primaryName}`
  const shown = targetNames.slice(0, 2).map((n) => `@${n}`).join(', ')
  const more = targetNames.length - 2
  return more > 0 ? `Send to ${shown} +${more}` : `Send to ${shown}`
}

/** Number of chip colours (index.css: .mention--tone-0 … -5). */
export const MENTION_TONES = 6

/** A stable chip colour for an agent id, 0 … MENTION_TONES - 1. */
export function mentionTone(id: string): number {
  let hash = 0
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) >>> 0
  return hash % MENTION_TONES
}
