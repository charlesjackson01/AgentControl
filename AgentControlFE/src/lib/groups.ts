/*
 * FE-6 group chats (mockups 06a–06d) on BE-5 e76bfaf. Pure; tests/groups.test.mjs.
 *
 * Mockup gaps (not in v3 06a–06d; neutral versions, each marked GAP-Gn where it renders):
 *   GAP-G1  typing / polling: "<Bot> is typing…" row with the author name, plus "· 25s" once a
 *           reply has taken 10 s or more (live replies arrive ~20 s apart); "Waiting for replies…"
 *           between the 202 and the first typing poll.
 *   GAP-G2  an error reply in a group: author name above the error bubble; no Retry (the BE
 *           runs the queue on; resending is the composer's job).
 *   GAP-G3  the 4-reply cap: mentioned bots the BE skipped get one muted line under the turn.
 *   GAP-G4  create: "New group" dialog (name, bot picker, Primary preselected and locked).
 *   GAP-G5  Settings tab: rename, Learn from chat, Mute (this browser only), Delete with confirm.
 *   GAP-G6  "＋ Add bot" picker (bots not in the group, up to 8).
 *   GAP-G7  remove a member: inline "Remove X? Remove / Keep" under the row.
 *   GAP-G8  a deleted bot's messages: "A deleted bot" author with initials; a group deleted
 *           elsewhere falls back to "Chat not found".
 *   GAP-G9  an empty group thread: one muted line naming the lead.
 *   GAP-G10 phone (390 px): group header and panel, same pieces stacked.
 *   GAP-G11 @mention autocomplete popover in the composer.
 *   GAP-G12 Shared files "By member": files grouped under who added them.
 *   GAP-G13 group memory empty state and the user's own row ("You added this").
 */
import type { Agent, ChatMessage, GroupConversation } from './types.ts'

export const MIN_GROUP_BOTS = 2
export const MAX_GROUP_BOTS = 8
export const MAX_GROUP_REPLIES = 4
export const MAX_GROUP_NAME = 60
/** Poll cadence while a group turn runs (FE-6). */
export const GROUP_POLL_MS = 1_500
/** After a send, keep polling this long even before typing shows (the BE starts the turn after the 202). */
export const GROUP_START_GRACE_MS = 6_000
/** GAP-G1: show the elapsed seconds once one reply has taken this long. */
export const SLOW_REPLY_MS = 10_000

type AgentLike = Pick<Agent, 'id' | 'name'> & Partial<Pick<Agent, 'isPrimary' | 'role' | 'description'>>
type GroupLike = Pick<GroupConversation, 'memberAgentIds' | 'leadAgentId'> & Partial<Pick<GroupConversation, 'name' | 'slug'>>

/* ---------- create (GAP-G4) ---------- */

/** The picker starts with Primary (the lead) selected. */
export function pickerInitial(agents: readonly AgentLike[]): string[] {
  const primary = agents.find((a) => a.isPrimary)
  return primary ? [primary.id] : []
}

/** Toggle a bot; Primary is locked in, and no more than 8 bots. */
export function togglePick(selected: readonly string[], id: string, agents: readonly AgentLike[]): string[] {
  const primary = agents.find((a) => a.isPrimary)
  if (primary && id === primary.id) return [...selected]
  if (selected.includes(id)) return selected.filter((x) => x !== id)
  if (selected.length >= MAX_GROUP_BOTS) return [...selected]
  return [...selected, id]
}

/** True when the bot can't be unticked (the lead). */
export function isLocked(id: string, agents: readonly AgentLike[]): boolean {
  return agents.some((a) => a.id === id && a.isPrimary)
}

/** Body for POST /api/groups: trimmed name, Primary first, no duplicates. */
export function createGroupBody(name: string, selected: readonly string[], agents: readonly AgentLike[]): { name: string; memberAgentIds: string[] } {
  const primary = agents.find((a) => a.isPrimary)
  const ids = [...new Set(selected)].filter((id) => agents.some((a) => a.id === id))
  const ordered = primary ? [primary.id, ...ids.filter((id) => id !== primary.id)] : ids
  return { name: name.trim().replace(/\s+/g, ' '), memberAgentIds: ordered }
}

/** Client-side copy of the BE checks; null when the form can be sent. */
export function createGroupError(name: string, selected: readonly string[], agents: readonly AgentLike[]): string | null {
  if (!agents.some((a) => a.isPrimary)) return 'Create a Team Lead bot before starting a group.'
  const body = createGroupBody(name, selected, agents)
  if (!body.name) return 'Name the group.'
  if (body.name.length > MAX_GROUP_NAME) return `Keep the name under ${MAX_GROUP_NAME} characters.`
  if (body.memberAgentIds.length < MIN_GROUP_BOTS) return 'Pick at least one more bot.'
  if (body.memberAgentIds.length > MAX_GROUP_BOTS) return `A group can have at most ${MAX_GROUP_BOTS} bots.`
  return null
}

/** Name suggestion from the picked bots ("Researcher & Summarizer"); '' when only the lead is picked. */
export function suggestName(selected: readonly string[], agents: readonly AgentLike[]): string {
  const names = selected.flatMap((id) => agents.filter((a) => a.id === id && !a.isPrimary).map((a) => a.name))
  if (names.length === 0) return ''
  if (names.length <= 2) return names.join(' & ')
  return `${names[0]}, ${names[1]} +${names.length - 2}`
}

/* ---------- header and panel ---------- */

export const DELETED_BOT = 'A deleted bot'

export function nameOf(id: string | undefined, agents: readonly AgentLike[]): string {
  return agents.find((a) => a.id === id)?.name ?? DELETED_BOT
}

/** Lead first, then the other members in group order. */
export function orderedMembers(g: GroupLike): string[] {
  const rest = g.memberAgentIds.filter((id) => id !== g.leadAgentId)
  return g.memberAgentIds.includes(g.leadAgentId) ? [g.leadAgentId, ...rest] : rest
}

/** 06a header: "★ Led by Primary" + "You, Researcher, Summarizer". */
export function groupHeaderLine(g: GroupLike, agents: readonly AgentLike[]): { lead: string; members: string } {
  const others = g.memberAgentIds.filter((id) => id !== g.leadAgentId).map((id) => nameOf(id, agents))
  return { lead: `★ Led by ${nameOf(g.leadAgentId, agents)}`, members: ['You', ...others].join(', ') }
}

/** 06b panel subline: "Group chat · led by Primary · you + 3 bots · shared folder " (folder shown as code). */
export function groupPanelSub(g: GroupLike, agents: readonly AgentLike[]): { text: string; folder: string | null } {
  const n = g.memberAgentIds.length
  const folder = g.slug ? `groups/${g.slug}/` : null
  return {
    text: `Group chat · led by ${nameOf(g.leadAgentId, agents)} · you + ${n} ${n === 1 ? 'bot' : 'bots'}${folder ? ' · shared folder ' : ''}`,
    folder,
  }
}

/** 06b: what each member row says on the right. */
export function memberRule(id: string, g: GroupLike, agents: readonly AgentLike[]): string {
  return id === g.leadAgentId ? 'Answers first, hands tasks out' : `When ${nameOf(g.leadAgentId, agents)} or you @mention it`
}

/** Members tab header: "4 of 8" counts the bots against the BE's 8-bot cap. */
export function membersCount(g: GroupLike): string {
  return `${g.memberAgentIds.length} of ${MAX_GROUP_BOTS}`
}

/** PATCH body removing one bot; null for the lead (locked, the BE would 400). */
export function withoutMember(g: GroupLike, id: string): string[] | null {
  if (id === g.leadAgentId) return null
  return g.memberAgentIds.filter((x) => x !== id)
}

/** PATCH body adding bots (up to 8), lead kept first. */
export function withMembers(g: GroupLike, ids: readonly string[]): string[] {
  const next = [...g.memberAgentIds]
  for (const id of ids) if (!next.includes(id) && next.length < MAX_GROUP_BOTS) next.push(id)
  return next
}

/** GAP-G6: bots that can still join (not members; hidden ones too, they're still bots). */
export function addableBots<T extends AgentLike>(g: GroupLike, agents: readonly T[]): T[] {
  return agents.filter((a) => !g.memberAgentIds.includes(a.id))
}

/* ---------- mentions ---------- */

export type MentionCandidate = { id: string; name: string }
export type TextPart = { text: string; mention?: string }

const WORD = /[\p{L}\p{N}_]/u
const MAX_TAG_CHARS = 80

/** Who an @ can name in a group: members other than the lead (as the BE resolves them). */
export function mentionCandidates(g: GroupLike, agents: readonly AgentLike[]): MentionCandidate[] {
  return g.memberAgentIds
    .filter((id) => id !== g.leadAgentId)
    .flatMap((id) => agents.filter((a) => a.id === id).map((a) => ({ id: a.id, name: a.name })))
}

/**
 * Mirror of BE mentions.ts resolveMentions: `@` + the longest candidate name
 * (case-insensitive) ending at a word boundary. Returns the text split into
 * plain parts and mention parts (with the agent id).
 */
export function mentionParts(text: string, candidates: readonly MentionCandidate[]): TextPart[] {
  const usable = candidates.filter((c) => c.name.trim().length > 0)
  const parts: TextPart[] = []
  let plainFrom = 0
  let i = 0
  while (i < text.length) {
    const at = text.indexOf('@', i)
    if (at === -1) break
    const bodyStart = at + 1
    const first = text[bodyStart]
    if (!first || !WORD.test(first)) {
      i = bodyStart
      continue
    }
    let bodyEnd = bodyStart
    while (bodyEnd < text.length && bodyEnd - bodyStart < MAX_TAG_CHARS && /[\p{L}\p{N}_\s]/u.test(text[bodyEnd])) bodyEnd++
    const lower = text.slice(bodyStart, bodyEnd).toLowerCase()
    let best: { id: string; length: number } | null = null
    for (const c of usable) {
      const n = c.name.trim().toLowerCase()
      if (!lower.startsWith(n)) continue
      if (lower.length > n.length && WORD.test(lower[n.length])) continue
      if (!best || n.length > best.length) best = { id: c.id, length: n.length }
    }
    if (!best) {
      i = bodyStart
      continue
    }
    if (at > plainFrom) parts.push({ text: text.slice(plainFrom, at) })
    const end = bodyStart + best.length
    parts.push({ text: text.slice(at, end), mention: best.id })
    plainFrom = end
    i = end
  }
  if (plainFrom < text.length) parts.push({ text: text.slice(plainFrom) })
  return parts
}

/** Mentioned ids in first-match order, deduped (BE `ids`). */
export function mentionIds(text: string, candidates: readonly MentionCandidate[]): string[] {
  return [...new Set(mentionParts(text, candidates).flatMap((p) => (p.mention ? [p.mention] : [])))]
}

/** GAP-G11: the "@prefix" being typed at the caret, or null. Prefix may be '' right after "@". */
export function mentionQuery(draft: string, caret: number): { start: number; query: string } | null {
  const before = draft.slice(0, caret)
  const at = before.lastIndexOf('@')
  if (at < 0) return null
  if (at > 0 && WORD.test(before[at - 1])) return null
  const query = before.slice(at + 1)
  if (query.length > 30 || /[\n@]/.test(query) || /\s{2}/.test(query) || /^\s/.test(query)) return null
  return { start: at, query }
}

/** Candidates whose name starts with the query (case-insensitive), then those containing it. */
export function mentionMatches(query: string, candidates: readonly MentionCandidate[]): MentionCandidate[] {
  const q = query.toLowerCase()
  const starts = candidates.filter((c) => c.name.toLowerCase().startsWith(q))
  const rest = candidates.filter((c) => !starts.includes(c) && q.length > 0 && c.name.toLowerCase().includes(q))
  return [...starts, ...rest]
}

/** Replace the "@prefix" at `start..caret` with "@Name " and return the new draft and caret. */
export function insertMention(draft: string, start: number, caret: number, name: string): { draft: string; caret: number } {
  const ins = `@${name} `
  const after = draft.slice(caret).replace(/^\S*/, '')
  const next = draft.slice(0, start) + ins + after.replace(/^ /, '')
  return { draft: next, caret: start + ins.length }
}

/* ---------- turns, "Seen by", the cap ---------- */

const isReply = (m: Pick<ChatMessage, 'role' | 'kind'>) => m.role === 'assistant' && m.kind !== 'system'
const isUserMsg = (m: Pick<ChatMessage, 'role' | 'kind'>) => m.role === 'user' && m.kind !== 'system'

/** Replies after the latest user message (this turn so far). */
export function turnReplies(messages: readonly ChatMessage[]): { userIndex: number; replies: ChatMessage[] } {
  let u = -1
  for (let i = messages.length - 1; i >= 0; i--) if (isUserMsg(messages[i])) { u = i; break }
  return { userIndex: u, replies: u < 0 ? [] : messages.slice(u + 1).filter(isReply) }
}

/**
 * 06a "Seen by 3 · 8:24 PM": distinct bots that replied to (or are typing for) the
 * latest user message, in reply order; the time is the first reply's. Null before anyone.
 */
export function seenBy(messages: readonly ChatMessage[], typingAgentId?: string | null, typingAt?: string): { ids: string[]; at: string } | null {
  const { userIndex, replies } = turnReplies(messages)
  if (userIndex < 0) return null
  const ids: string[] = []
  for (const m of replies) if (m.authorAgentId && !ids.includes(m.authorAgentId)) ids.push(m.authorAgentId)
  if (typingAgentId && !ids.includes(typingAgentId)) ids.push(typingAgentId)
  if (ids.length === 0) return null
  const at = replies[0]?.createdAt ?? typingAt ?? messages[userIndex].createdAt
  return { ids, at }
}

/**
 * GAP-G3: bots that were @mentioned this turn but never asked, because a user message
 * gets at most 4 bot replies (the lead's first answer and wrap-up included). Same queue as
 * BE runGroupTurn. Only meaningful once the turn is over (nobody typing).
 */
export function skippedMentions(messages: readonly ChatMessage[], g: GroupLike, agents: readonly AgentLike[]): string[] {
  const { userIndex, replies } = turnReplies(messages)
  if (userIndex < 0) return []
  const lead = replies.find((m) => m.authorAgentId === g.leadAgentId)
  if (!lead) return []
  // BE-5 d5e5a99: the lead's reply says who the cap skipped. The calculation below is the
  // fallback for replies stored before the field existed.
  const listed = serverSkipped(lead)
  if (listed) return listed
  const cands = mentionCandidates(g, agents)
  const fromUser = mentionIds(messages[userIndex].content, cands)
  const fromLead = lead.error ? [] : mentionIds(lead.content, cands)
  const queue = [...new Set([...fromUser, ...fromLead])]
  const room = MAX_GROUP_REPLIES - 1 - (fromLead.length > 0 ? 1 : 0)
  return queue.slice(Math.max(0, room))
}

/** The lead reply's own `skippedAgentIds` (deduped, strings only); null when the BE didn't send one. */
export function serverSkipped(lead: Pick<ChatMessage, 'skippedAgentIds'>): string[] | null {
  const raw: unknown = lead.skippedAgentIds
  if (!Array.isArray(raw)) return null
  return [...new Set(raw.filter((id): id is string => typeof id === 'string' && id !== ''))]
}

/* ---------- polling ---------- */

export type PollState = {
  /** When the last send was accepted (ms); null when not waiting on a send. */
  sentAt: number | null
  /** A poll has shown typing since the send. */
  sawTyping: boolean
}

export const IDLE_POLL: PollState = { sentAt: null, sawTyping: false }

/**
 * Whether to keep the 1.5 s `?after=` poll going after one poll result.
 * - Typing set: always continue (a reply can take 20 s or more; never time out on typing).
 * - Typing clear after it was seen: the turn is over, stop.
 * - Typing never seen yet: continue for GROUP_START_GRACE_MS after the send (the BE starts
 *   the turn after its 202; before d5e5a99 the 202 said nobody was typing), then stop.
 */
export function nextPoll(state: PollState, poll: { typingAgentId?: string | null }, now: number): { state: PollState; poll: boolean } {
  if (poll.typingAgentId) return { state: { ...state, sawTyping: true }, poll: true }
  if (state.sawTyping) return { state: IDLE_POLL, poll: false }
  if (state.sentAt !== null && now - state.sentAt < GROUP_START_GRACE_MS) return { state, poll: true }
  return { state: IDLE_POLL, poll: false }
}

/**
 * BE-5 d5e5a99: the 202 send already names the lead as typing. Who to show typing straight
 * after a send, or null when the 202 doesn't say (older BEs: "Waiting for replies…" until a poll does).
 */
export function typingAfterSend(conversation: { typingAgentId?: string | null } | null | undefined): string | null {
  const id = conversation?.typingAgentId
  return typeof id === 'string' && id !== '' ? id : null
}

/** GAP-G1: "Researcher is typing…" and, past 10 s on one reply, "· 25s". */
export function typingLabel(name: string, sinceMs: number | null, now: number): string {
  const base = `${name} is typing…`
  if (sinceMs === null) return base
  const s = Math.floor((now - sinceMs) / 1000)
  return now - sinceMs >= SLOW_REPLY_MS ? `${base} · ${s}s` : base
}

/** The newest message id, for `?after=`. */
export function afterCursor(messages: readonly Pick<ChatMessage, 'id'>[]): string | undefined {
  return messages[messages.length - 1]?.id
}

/* ---------- system lines (06a) ---------- */

/** 06a: the first system line of a day carries the day: "Today · You created … · 8:20 PM". */
export function systemLineText(content: string, day: string | null, time: string): string {
  return [day, content.replace(/\.$/, ''), time].filter(Boolean).join(' · ')
}

/* ---------- files (06a card, 06c column) ---------- */

/** "You" for the user, the bot's name, or "A deleted bot". Empty when unknown. */
export function addedByName(addedBy: string | undefined, agents: readonly AgentLike[]): string {
  if (!addedBy) return ''
  return addedBy === 'user' ? 'You' : nameOf(addedBy, agents)
}

/**
 * 06a file card in a group. BE 3a70c34: a FileChange with `root: 'group'` is in a group's folder,
 * `path` relative to it (no prefix) -> "Group folder · added by Researcher · 3 KB", opened in that
 * group's Shared files. A missing root is the author's own folder ("Researcher's folder · workspace
 * · 3 KB", opened in the author's chat). A file in a different group than this one names it
 * ("Q3 report folder", GAP-P2-FILE2: no mockup).
 */
export function groupFileCard(
  f: { path: string; root?: 'agent' | 'group'; groupId?: string; groupName?: string },
  authorName: string,
  size: string | null,
  change?: 'added' | 'modified' | 'deleted',
  currentGroupId?: string,
): { inGroup: boolean; path: string; groupId?: string; meta: string } {
  // Phase 2: a run can delete files; say so instead of "added by" (GAP-P2-FILE: no mockup yet).
  const deleted = change === 'deleted'
  const path = f.path
  if (f.root === 'group') {
    const other = f.groupId && currentGroupId && f.groupId !== currentGroupId
    const folder = other ? `${f.groupName || 'Another group'} folder` : 'Group folder'
    return {
      inGroup: true,
      path,
      ...(f.groupId || currentGroupId ? { groupId: f.groupId || currentGroupId } : {}),
      meta: [folder, deleted ? `deleted by ${authorName}` : `added by ${authorName}`, deleted ? null : size].filter(Boolean).join(' · '),
    }
  }
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
  return { inGroup: false, path, meta: [`${authorName}'s folder`, dir, deleted ? 'deleted' : size].filter(Boolean).join(' · ') }
}

/* ---------- panel tabs and URL ---------- */

export type GroupTab = 'members' | 'memory' | 'files' | 'settings'
export const GROUP_TABS: readonly { id: GroupTab; label: string }[] = [
  { id: 'members', label: 'Members' },
  { id: 'memory', label: 'Memory' },
  { id: 'files', label: 'Shared files' },
  { id: 'settings', label: 'Settings' },
]

type ParamsLike = { get(name: string): string | null }

/**
 * Same URL keys as the bot panel: `?panel=settings&tab=members|memory|settings` and
 * `?panel=files&path=…` (Shared files). Bot tab names map over (profile -> members,
 * skills/vm/sandbox -> members) so a deep link never lands nowhere.
 */
export function groupTab(params: ParamsLike): GroupTab {
  if (params.get('panel') === 'files') return 'files'
  const t = params.get('tab')
  if (t === 'memory' || t === 'files' || t === 'settings') return t
  if (t === 'group-settings') return 'settings'
  return 'members'
}

export function withGroupTab(params: URLSearchParams, tab: GroupTab): URLSearchParams {
  const next = new URLSearchParams(params)
  next.set('panel', 'settings')
  next.delete('path')
  if (tab === 'members') next.delete('tab')
  else next.set('tab', tab)
  return next
}

/* ---------- mute (GAP-G5, local only) ---------- */

export const MUTE_KEY = 'agentcontrol.groups.muted'
type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

export function readMuted(storage: StorageLike | null | undefined): Set<string> {
  try {
    const raw: unknown = JSON.parse(storage?.getItem(MUTE_KEY) ?? '[]')
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

export function writeMuted(storage: StorageLike | null | undefined, ids: ReadonlySet<string>): void {
  try {
    storage?.setItem(MUTE_KEY, JSON.stringify([...ids]))
  } catch {
    // Not persisted; this tab still applies it.
  }
}
