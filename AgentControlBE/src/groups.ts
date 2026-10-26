/**
 * BE-5: group chats. CRUD (the Primary always leads and is always a member),
 * system lines, and the background reply turn: the lead answers first, then
 * the bots @mentioned by the user or the lead reply in order (one hop, at
 * most MAX_GROUP_REPLIES bot replies per user message, lead included).
 */
import { randomUUID } from 'node:crypto'
import { groupTyping, messagesOf, runActivity, syncGroupLeads } from './conversations.js'
import { archiveGroupFolder, ensureGroupFolder } from './group-files.js'
import { fail } from './http.js'
import { resolveMentions } from './mentions.js'
import { executeRun } from './runs.js'
import { attachmentPrompt } from './attachments.js'
import type { Agent, Attachment, ChatMessage, GroupConversation } from './shared/types.js'
import type { WorkspaceStore } from './store.js'

export const MIN_GROUP_MEMBERS = 2
export const MAX_GROUP_MEMBERS = 8
export const MAX_GROUP_REPLIES = 4
const MAX_NAME = 60
/** Transcript a group run sees: the newest messages, capped in count and characters. */
const TRANSCRIPT_MESSAGES = 20
const TRANSCRIPT_CHARS = 6000

export function liveGroups(store: WorkspaceStore): GroupConversation[] {
  return store.conversations.filter((c): c is GroupConversation => c.kind === 'group' && c.archivedAt === undefined)
}

export function groupOr404(store: WorkspaceStore, id: string): GroupConversation {
  syncGroupLeads(store.conversations, store.agents)
  const group = liveGroups(store).find((g) => g.id === id)
  if (!group) fail(404, `No group with id "${id}"`)
  return group
}

function parseName(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') fail(400, '"name" is required.')
  const name = raw.trim().replace(/\s+/g, ' ')
  if (name.length > MAX_NAME) fail(400, `"name" must be at most ${MAX_NAME} characters.`)
  return name
}

/** Members in the order given, Primary first; 400 on unknown ids, duplicates or size. */
function parseMembers(store: WorkspaceStore, raw: unknown, primary: Agent): string[] {
  if (!Array.isArray(raw) || raw.some((id) => typeof id !== 'string')) fail(400, '"memberAgentIds" must be an array of agent ids.')
  const ids = raw as string[]
  for (const id of ids) if (!store.agents.some((a) => a.id === id)) fail(400, `No agent with id "${id}".`)
  const members = [primary.id, ...new Set(ids.filter((id) => id !== primary.id))]
  if (members.length < MIN_GROUP_MEMBERS) fail(400, `A group needs at least ${MIN_GROUP_MEMBERS} bots, the Team Lead and one more.`)
  if (members.length > MAX_GROUP_MEMBERS) fail(400, `A group can have at most ${MAX_GROUP_MEMBERS} bots.`)
  return members
}

function primaryOf(store: WorkspaceStore): Agent {
  const primary = store.agents.find((a) => a.isPrimary)
  if (!primary) fail(409, 'Create a Team Lead bot before starting a group.')
  return primary
}

/** Unique folder name [a-z0-9-]{1,40}; archived groups' names are reused only after their folder moved. */
function groupSlug(store: WorkspaceStore, name: string): string {
  const base = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'group'
  const taken = new Set(liveGroups(store).map((g) => g.slug))
  if (!taken.has(base)) return base
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`
    const candidate = `${base.slice(0, 40 - suffix.length).replace(/-+$/, '')}${suffix}`
    if (!taken.has(candidate)) return candidate
  }
}

const nameOf = (store: WorkspaceStore, id: string) => store.agents.find((a) => a.id === id)?.name ?? 'A deleted bot'

/** "A", "A and B", "A, B and C". */
function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

/** Strictly after the conversation's newest message, so order never depends on clock ties. */
function nextStamp(store: WorkspaceStore, conversationId: string): string {
  const now = new Date().toISOString()
  const newest = messagesOf(store, conversationId).at(-1)?.createdAt
  if (!newest || now > newest) return now
  return new Date(Date.parse(newest) + 1).toISOString()
}

function pushMessage(store: WorkspaceStore, group: GroupConversation, message: Omit<ChatMessage, 'id' | 'conversationId' | 'createdAt'>): ChatMessage {
  const full: ChatMessage = { id: `msg-${randomUUID()}`, conversationId: group.id, createdAt: nextStamp(store, group.id), ...message }
  store.chatMessages.push(full)
  if (full.createdAt > group.updatedAt) group.updatedAt = full.createdAt
  return full
}

export function systemMessage(store: WorkspaceStore, group: GroupConversation, text: string): ChatMessage {
  return pushMessage(store, group, { role: 'assistant', kind: 'system', content: text })
}

export function createGroup(store: WorkspaceStore, body: unknown): GroupConversation {
  const input = (body ?? {}) as { name?: unknown; memberAgentIds?: unknown; memoryLearn?: unknown }
  const name = parseName(input.name)
  const primary = primaryOf(store)
  const members = parseMembers(store, input.memberAgentIds, primary)
  if (input.memoryLearn !== undefined && typeof input.memoryLearn !== 'boolean') fail(400, '"memoryLearn" must be true or false.')
  const now = new Date().toISOString()
  const group: GroupConversation = {
    id: `conv-${randomUUID()}`,
    kind: 'group',
    name,
    slug: groupSlug(store, name),
    memberAgentIds: members,
    leadAgentId: primary.id,
    memoryLearn: input.memoryLearn !== false,
    createdAt: now,
    updatedAt: now,
    lastReadAt: now,
  }
  store.conversations.push(group)
  ensureGroupFolder(store, group)
  systemMessage(store, group, `You created "${name}" and added ${joinNames(members.map((id) => nameOf(store, id)))}.`)
  return group
}

export function updateGroup(store: WorkspaceStore, group: GroupConversation, body: unknown): GroupConversation {
  const input = (body ?? {}) as { name?: unknown; memberAgentIds?: unknown; memoryLearn?: unknown }
  if (input.memoryLearn !== undefined && typeof input.memoryLearn !== 'boolean') fail(400, '"memoryLearn" must be true or false.')
  const name = input.name !== undefined ? parseName(input.name) : group.name
  let members = group.memberAgentIds
  if (input.memberAgentIds !== undefined) {
    const primary = primaryOf(store)
    if (Array.isArray(input.memberAgentIds) && !input.memberAgentIds.includes(primary.id)) {
      fail(400, `${primary.name} leads every group and can't be removed. Move the Team Lead role to another bot first.`)
    }
    members = parseMembers(store, input.memberAgentIds, primary)
  }
  const added = members.filter((id) => !group.memberAgentIds.includes(id))
  const removed = group.memberAgentIds.filter((id) => !members.includes(id))
  const renamed = name !== group.name
  group.name = name
  group.memberAgentIds = members
  if (typeof input.memoryLearn === 'boolean') group.memoryLearn = input.memoryLearn
  if (renamed) systemMessage(store, group, `You renamed the group "${name}".`)
  if (added.length > 0) systemMessage(store, group, `You added ${joinNames(added.map((id) => nameOf(store, id)))}.`)
  if (removed.length > 0) systemMessage(store, group, `You removed ${joinNames(removed.map((id) => nameOf(store, id)))}.`)
  ensureGroupFolder(store, group)
  return group
}

/** DELETE: the conversation is archived (kept, never listed) and the folder moves to data/archive/groups/. */
export function archiveGroup(store: WorkspaceStore, group: GroupConversation): void {
  archiveGroupFolder(store, group)
  group.archivedAt = new Date().toISOString()
  groupTyping.delete(group.id)
}

/** An agent was deleted: it leaves its groups, with a system line in each. */
export function removeAgentFromGroups(store: WorkspaceStore, agent: Agent): void {
  for (const group of liveGroups(store)) {
    if (!group.memberAgentIds.includes(agent.id)) continue
    group.memberAgentIds = group.memberAgentIds.filter((id) => id !== agent.id)
    systemMessage(store, group, `${agent.name} was deleted and left the group.`)
    ensureGroupFolder(store, group)
  }
}

// --- The reply turn -----------------------------------------------------------

/** One turn at a time per group, in send order. */
const turnChains = new Map<string, Promise<void>>()

/** Resolves once every queued turn for the group has finished (tests, shutdown). */
export function groupIdle(groupId: string): Promise<void> {
  return turnChains.get(groupId) ?? Promise.resolve()
}

export function postGroupMessage(store: WorkspaceStore, group: GroupConversation, content: string, attachments: Attachment[] = []): ChatMessage {
  const message = pushMessage(store, group, { role: 'user', content, ...(attachments.length > 0 ? { attachments } : {}) })
  // The sender has read everything up to their own message.
  group.lastReadAt = message.createdAt
  store.save()
  // The lead always answers first, so it is "typing" from the 202 on (unless a turn is already running).
  if (!groupTyping.has(group.id)) groupTyping.set(group.id, group.leadAgentId)
  const previous = turnChains.get(group.id) ?? Promise.resolve()
  const next = previous.then(() => runGroupTurn(store, group.id, message)).catch((err: unknown) => {
    console.error(`Group ${group.id} turn failed:`, err instanceof Error ? err.message : err)
  })
  turnChains.set(group.id, next)
  void next.finally(() => {
    if (turnChains.get(group.id) === next) {
      turnChains.delete(group.id)
      groupTyping.delete(group.id)
    }
  })
  return message
}

function roleLine(agent: Agent, group: GroupConversation): string {
  const role = (agent.role || agent.description || '').replace(/\s*\n\s*/g, ' ').trim()
  return `- ${agent.name}${agent.id === group.leadAgentId ? ' (leads the group)' : ''}${role ? `: ${role}` : ''}`
}

function transcript(store: WorkspaceStore, group: GroupConversation): string {
  const lines: string[] = []
  let chars = 0
  for (const m of messagesOf(store, group.id).reverse()) {
    if (lines.length >= TRANSCRIPT_MESSAGES) break
    const who = m.kind === 'system' ? '(group)' : m.role === 'user' ? 'User' : nameOf(store, m.authorAgentId ?? '')
    const attached = m.role === 'user' && m.attachments?.length ? `${m.content ? '\n' : ''}${attachmentPrompt(m.attachments)}` : ''
    const line = `${who}: ${m.error ? '(reply failed)' : m.content}${attached}`
    if (chars + line.length > TRANSCRIPT_CHARS && lines.length > 0) break
    lines.push(line.length > TRANSCRIPT_CHARS ? `${line.slice(0, TRANSCRIPT_CHARS)}…` : line)
    chars += line.length
  }
  return lines.reverse().join('\n')
}

type Turn = 'lead' | 'member' | 'wrap-up'

function groupInput(store: WorkspaceStore, group: GroupConversation, agent: Agent, members: Agent[], turn: Turn): string {
  const header = [
    `You are ${agent.name}, in the group chat "${group.name}" with the user and these bots:`,
    ...members.map((m) => roleLine(m, group)),
    'Files in group:shared/ are shared with every member.',
  ]
  const task =
    turn === 'lead'
      ? 'You lead this group, so you answer first. Answer the user, or hand parts of the task to members by writing @ and their exact name with what you need from them; they reply after you. Only mention bots that should act now.'
      : turn === 'member'
        ? `You were mentioned in this group. Do your part of the latest request and reply to the group. Don't @mention other bots.`
        : 'The members you asked have replied above. Wrap up for the user in a few lines. Don\'t @mention anyone.'
  return [...header, '', 'Conversation so far (oldest first):', transcript(store, group), '', task].join('\n')
}

async function reply(store: WorkspaceStore, group: GroupConversation, agent: Agent, members: Agent[], turn: Turn): Promise<ChatMessage> {
  groupTyping.set(group.id, agent.id)
  try {
    const { run } = await executeRun(store, agent, groupInput(store, group, agent, members, turn), {
      group: { id: group.id, memoryLearn: group.memoryLearn, slug: group.slug },
      conversationId: group.id,
    })
    const failed = run.status !== 'succeeded'
    return pushMessage(store, group, {
      role: 'assistant',
      content: failed ? (run.error || 'The reply failed.') : run.output,
      runId: run.id,
      authorAgentId: agent.id,
      ...runActivity(run),
      ...(failed ? { error: true as const } : {}),
    })
  } catch (err) {
    // A 400/413 before the run started: the error is the reply; the queue goes on.
    return pushMessage(store, group, {
      role: 'assistant',
      content: err instanceof Error ? err.message : 'The reply failed.',
      authorAgentId: agent.id,
      error: true,
    })
  } finally {
    groupTyping.delete(group.id)
    store.save()
  }
}

async function runGroupTurn(store: WorkspaceStore, groupId: string, userMessage: ChatMessage): Promise<void> {
  const current = () => liveGroups(store).find((g) => g.id === groupId)
  const group = current()
  if (!group) return
  syncGroupLeads(store.conversations, store.agents)
  const members = () => group.memberAgentIds.flatMap((id) => store.agents.filter((a) => a.id === id))
  const lead = store.agents.find((a) => a.id === group.leadAgentId)
  if (!lead) return
  const candidates = () => members().filter((a) => a.id !== group.leadAgentId).map((a) => ({ id: a.id, name: a.name }))

  const leadReply = await reply(store, group, lead, members(), 'lead')
  let replies = 1
  // One hop: the user's and the lead's mentions, deduped, lead excluded; members' own mentions are not followed.
  const fromUser = resolveMentions(userMessage.content, candidates()).ids
  const fromLead = leadReply.error ? [] : resolveMentions(leadReply.content, candidates()).ids
  const queue = [...new Set([...fromUser, ...fromLead])]
  // Leave room for the lead's wrap-up when the lead handed work out.
  const room = Math.max(0, MAX_GROUP_REPLIES - replies - (fromLead.length > 0 ? 1 : 0))
  const skipped = queue.slice(room)
  if (skipped.length > 0) {
    leadReply.skippedAgentIds = skipped
    store.save()
  }
  for (const id of queue.slice(0, room)) {
    if (!current()) return
    const agent = store.agents.find((a) => a.id === id && group.memberAgentIds.includes(a.id))
    if (!agent) continue
    await reply(store, group, agent, members(), 'member')
    replies += 1
  }
  if (fromLead.length > 0 && replies > 1 && replies < MAX_GROUP_REPLIES && current()) {
    await reply(store, group, lead, members(), 'wrap-up')
  }
}
