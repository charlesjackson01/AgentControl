import { randomUUID } from 'node:crypto'
import type { AgentRun, AgentStatus, ChatMessage, Conversation, ConversationSummary, DmConversation } from './shared/types.js'

/** The slice of the store this module touches (keeps it unit-testable). */
export interface ConversationState {
  agents: { id: string; status?: AgentStatus }[]
  runs: AgentRun[]
  conversations: Conversation[]
  chatMessages: ChatMessage[]
}

export const CONVERSATIONS_MIGRATION = 'conversations-from-runs-v1'

export function dmOf(state: ConversationState, agentId: string): DmConversation | undefined {
  return state.conversations.find((c): c is DmConversation => c.kind === 'dm' && c.agentId === agentId)
}

/** The agent's DM, created on first use. */
export function ensureDm(state: ConversationState, agentId: string, now: string = new Date().toISOString()): DmConversation {
  const existing = dmOf(state, agentId)
  if (existing) return existing
  const conversation: DmConversation = {
    id: `conv-${randomUUID()}`,
    kind: 'dm',
    agentId,
    createdAt: now,
    updatedAt: now,
    lastReadAt: null,
  }
  state.conversations.push(conversation)
  return conversation
}

/**
 * Append a non-project run to its agent's DM as a user + assistant pair.
 * Idempotent: a run already recorded (by runId) is skipped. Returns whether
 * anything was added.
 */
export function recordRunMessages(state: ConversationState, run: AgentRun): boolean {
  if (run.projectId !== undefined) return false
  if (!state.agents.some((a) => a.id === run.agentId)) return false
  if (state.chatMessages.some((m) => m.runId === run.id)) return false
  const conversation = ensureDm(state, run.agentId, run.startedAt)
  const userAt = run.startedAt
  const startMs = Date.parse(run.startedAt)
  const replyAt = Number.isFinite(startMs)
    ? new Date(startMs + Math.max(0, run.durationMs || 0)).toISOString()
    : run.startedAt
  state.chatMessages.push({
    id: `msg-${randomUUID()}`,
    conversationId: conversation.id,
    role: 'user',
    content: run.input,
    createdAt: userAt,
    runId: run.id,
  })
  const reply = run.output || (run.status === 'failed' ? (run.error ?? '') : '')
  let newest = userAt
  if (reply) {
    state.chatMessages.push({
      id: `msg-${randomUUID()}`,
      conversationId: conversation.id,
      role: 'assistant',
      content: reply,
      createdAt: replyAt,
      runId: run.id,
      authorAgentId: run.agentId,
      ...(run.activatedSkills && run.activatedSkills.length > 0
        ? { activity: { skills: run.activatedSkills.map((s) => ({ ...s })), steps: [], filesChanged: [] } }
        : {}),
      ...(run.status === 'failed' ? { error: true as const } : {}),
    })
    newest = replyAt
  }
  if (newest > conversation.updatedAt) conversation.updatedAt = newest
  return true
}

/**
 * Move existing 1:1 runs into DMs, oldest first. History that existed before
 * the migration counts as read. Safe to run any number of times.
 */
export function migrateRunsToConversations(state: ConversationState, migrations: string[]): boolean {
  if (migrations.includes(CONVERSATIONS_MIGRATION)) return false
  const ordered = [...state.runs]
    .filter((r) => r.projectId === undefined)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  const touched = new Set<string>()
  for (const run of ordered) {
    if (recordRunMessages(state, run)) touched.add(run.agentId)
  }
  for (const c of state.conversations) {
    if (c.kind === 'dm' && touched.has(c.agentId) && c.lastReadAt === null) c.lastReadAt = c.updatedAt
  }
  migrations.push(CONVERSATIONS_MIGRATION)
  return true
}

export function messagesOf(state: ConversationState, conversationId: string): ChatMessage[] {
  return state.chatMessages
    .filter((m) => m.conversationId === conversationId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

export function summarize(state: ConversationState, c: Conversation): ConversationSummary {
  const messages = messagesOf(state, c.id)
  const lastMessage = messages.at(-1) ?? null
  const unreadCount = messages.filter(
    (m) => m.role === 'assistant' && (c.lastReadAt === null || m.createdAt > c.lastReadAt),
  ).length
  // A DM is typing while its agent's run is in flight (groups set this in BE-5).
  const typingAgentId =
    c.kind === 'dm' && state.agents.some((a) => a.id === c.agentId && a.status === 'running') ? c.agentId : null
  return { ...c, lastMessage, unreadCount, typingAgentId }
}

/** Drop a conversation's messages (and, with `dropConversation`, the conversation). */
export function clearAgentConversations(state: ConversationState, agentId: string, dropConversation: boolean): void {
  const ids = new Set(state.conversations.filter((c) => c.kind === 'dm' && c.agentId === agentId).map((c) => c.id))
  state.chatMessages = state.chatMessages.filter((m) => !ids.has(m.conversationId))
  if (dropConversation) state.conversations = state.conversations.filter((c) => !ids.has(c.id))
}

/** Keep well-formed records only, and messages whose conversation exists. */
export function normalizeConversations(raw: unknown, agentIds: Set<string>): Conversation[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: Conversation[] = []
  for (const c of raw as Partial<DmConversation>[]) {
    // Groups arrive in BE-5; until then only DMs load.
    if (c && c.kind !== undefined && c.kind !== 'dm') continue
    if (!c || typeof c.id !== 'string' || typeof c.agentId !== 'string' || !agentIds.has(c.agentId)) continue
    if (seen.has(c.agentId)) continue
    seen.add(c.agentId)
    const createdAt = typeof c.createdAt === 'string' ? c.createdAt : new Date(0).toISOString()
    out.push({
      id: c.id,
      kind: 'dm',
      agentId: c.agentId,
      createdAt,
      updatedAt: typeof c.updatedAt === 'string' ? c.updatedAt : createdAt,
      lastReadAt: typeof c.lastReadAt === 'string' ? c.lastReadAt : null,
    })
  }
  return out
}

export function normalizeChatMessages(raw: unknown, conversationIds: Set<string>): ChatMessage[] {
  if (!Array.isArray(raw)) return []
  return (raw as Partial<ChatMessage>[]).flatMap((m) =>
    m &&
    typeof m.id === 'string' &&
    typeof m.conversationId === 'string' &&
    conversationIds.has(m.conversationId) &&
    (m.role === 'user' || m.role === 'assistant') &&
    typeof m.content === 'string' &&
    typeof m.createdAt === 'string'
      ? [{
          id: m.id,
          conversationId: m.conversationId,
          role: m.role,
          content: m.content,
          createdAt: m.createdAt,
          ...(typeof m.runId === 'string' ? { runId: m.runId } : {}),
          ...(m.error === true ? { error: true as const } : {}),
          ...(m.kind === 'system' || m.kind === 'message' ? { kind: m.kind } : {}),
          ...(typeof m.authorAgentId === 'string' ? { authorAgentId: m.authorAgentId } : {}),
        }]
      : [],
  )
}

/** Flag assistant messages from failed runs recorded before `error` existed. Returns whether any changed. */
export function backfillErrorFlags(state: ConversationState): boolean {
  const failed = new Set(state.runs.filter((r) => r.status === 'failed').map((r) => r.id))
  let changed = false
  for (const m of state.chatMessages) {
    if (m.role === 'assistant' && m.error !== true && m.runId !== undefined && failed.has(m.runId)) {
      m.error = true
      changed = true
    }
  }
  return changed
}

/** Set authorAgentId on DM assistant messages recorded before it existed. Returns whether any changed. */
export function backfillAuthors(state: ConversationState): boolean {
  const dmAgent = new Map<string, string>()
  for (const c of state.conversations) if (c.kind === 'dm') dmAgent.set(c.id, c.agentId)
  let changed = false
  for (const m of state.chatMessages) {
    const agentId = dmAgent.get(m.conversationId)
    if (m.role === 'assistant' && m.authorAgentId === undefined && agentId !== undefined) {
      m.authorAgentId = agentId
      changed = true
    }
  }
  return changed
}
