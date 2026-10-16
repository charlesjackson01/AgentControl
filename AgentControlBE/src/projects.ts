/**
 * Project team plans and task runs (docs/PROJECTS_HANDOFF.md, Part 2).
 *
 * POST /api/projects/:id/team-plan sends the user's prompt to Primary (the
 * Team Lead) with a fixed assembler prompt. Primary answers with JSON: a
 * reply, library agents to add, project specialists to create, and tasks.
 * That answer is untrusted model output: it is parsed leniently, validated
 * strictly into a TeamPlan and returned. Nothing is written (D-P1).
 *
 * POST /api/projects/:id/team-plan/apply commits the plan the user
 * confirmed. The plan comes back from the client, so it is validated again
 * exactly like model output, against the store as it is now, and only the
 * plan's own fields ever reach the store (ids are resolved against the
 * library or minted here, never taken from the plan). Applying records
 * Primary's reply, a 'team-update' and one 'task-assignment' per task; a
 * per-project runner executes the tasks one at a time through executeRun and
 * posts each output back as a 'message' from the assignee (taskId, runId,
 * taskStatus).
 */
import { fail, uid } from './http.js'
import { mentionCandidates, resolveMentions } from './mentions.js'
import { estimateTokens } from './prompt.js'
import { executeRun } from './runs.js'
import type {
  Agent,
  Project,
  ProjectMessage,
  ProjectUpdate,
  TeamPlan,
  TeamPlanAdd,
  TeamPlanCreate,
  TeamPlanResult,
  TeamPlanTask,
} from './shared/types.js'
import type { WorkspaceStore } from './store.js'
import { clipText } from './tools/limits.js'
import { chatCompletion, STOPPED_BY_YOU, type ChatMessage } from './upstream.js'

/** Plan limits: what one plan may propose. */
const MAX_ADD = 10
const MAX_CREATE = 5
const MAX_TASKS = 10
const MAX_CREATE_SKILLS = 10
/** Raw list entries looked at per list; anything past it is dropped unread. */
const RAW_ENTRIES_MAX = 50
const MAX_WARNINGS = 30
const NAME_MAX = 60
const ROLE_MAX = 60
const REASON_MAX = 300
const REPLY_MAX = 2_000
const INSTRUCTIONS_MAX = 4_000
const TASK_MAX = 2_000

/** A prompt sent without a chat message: the same cap as a chat message. */
const PROMPT_MAX = 20_000
/** Entries one apply selection list may hold. */
const SELECTION_MAX = 100

/** Planner prompt sizes. */
const LEAD_INSTRUCTIONS_MAX = 1_500
const PROJECT_DESC_MAX = 1_000
const AGENT_DESC_MAX = 200
const SKILL_DESC_MAX = 120
const AGENT_SKILL_NAMES_MAX = 8
const CHAT_MESSAGES_MAX = 12
const CHAT_MESSAGE_MAX = 400
const ROSTER_TEAM_MAX = 50
const ROSTER_AGENTS_MAX = 30
const ROSTER_SKILLS_MAX = 40
/** Tokens kept free for the plan: min(this, window / 3). */
const PLAN_REPLY_RESERVE_MAX = 2_048
/** max_tokens ceiling for the planner call (the run route's RESPONSE_RESERVE). */
const PLAN_MAX_TOKENS = 4_096
const PLANNER_TEMPERATURE = 0.2
/** Primary's raw answer is cut to this before parsing. */
const RAW_REPLY_MAX = 100_000

/** Task runs. */
const TASK_PROMPT_MAX = 2_000
const TASK_TEAMMATES_MAX = 20
const RESULT_TEXT_MAX = 20_000
/** Tasks one drain runs before it re-queues itself behind other work. */
const TASKS_PER_DRAIN = 100

// ---------------------------------------------------------------------------
// Shared helpers

const norm = (s: string): string => s.trim().toLowerCase()
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()
const quote = (s: string): string => `"${clipText(oneLine(s), 60)}"`
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

function projectOrFail(store: WorkspaceStore, id: string): Project {
  const project = store.projects.find((p) => p.id === id)
  if (!project) fail(404, `No project with id "${id}"`)
  return project
}

function findMessage(store: WorkspaceStore, projectId: string, id: string): ProjectMessage | undefined {
  return store.projectMessages.find((m) => m.id === id && m.projectId === projectId)
}

/** A message the user wrote in this project's chat (what a plan answers). */
function userMessageOrFail(store: WorkspaceStore, projectId: string, id: string): ProjectMessage {
  const message = findMessage(store, projectId, id)
  if (!message || message.kind !== 'message' || message.author !== 'user') {
    fail(400, `No user message with id "${id.slice(0, 100)}" in this project.`)
  }
  return message
}

/** A project's messages in GET order (oldest first). */
function projectThread(store: WorkspaceStore, projectId: string): ProjectMessage[] {
  return store.projectMessages
    .filter((m) => m.projectId === projectId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
}

/**
 * createdAt for new messages: now, but always after the project's latest
 * message, so a batch (reply, team update, assignments) keeps its order in GET.
 */
function messageClock(store: WorkspaceStore, projectId: string): () => string {
  let last = Date.now() - 1
  for (const m of store.projectMessages) {
    if (m.projectId !== projectId) continue
    const t = Date.parse(m.createdAt)
    if (t > last) last = t
  }
  return () => new Date(++last).toISOString()
}

function replaceMessage(store: WorkspaceStore, next: ProjectMessage): void {
  store.projectMessages = store.projectMessages.map((m) => (m.id === next.id ? next : m))
}

/** D-O11 candidates for one write: Primary and the team first, then the library. */
function mentionPool(store: WorkspaceStore, project: Project) {
  return mentionCandidates(store.agents.find((a) => a.isPrimary), teamMembers(store, project), store.agents)
}

/**
 * D-O11: fill `mentions` for one message. User messages carry the ids the
 * client picked (validated against Primary and the team); every other write
 * parses `@Name` from the text. Returns the ids, in order, deduped.
 */
function resolveMessageMentions(
  store: WorkspaceStore,
  project: Project,
  author: string,
  text: string,
  picked?: string[],
): string[] {
  const pool = mentionPool(store, project)
  if (author === 'user') {
    const allowed = new Set([
      ...(store.agents.find((a) => a.isPrimary) ? [store.agents.find((a) => a.isPrimary)!.id] : []),
      ...project.teamAgentIds,
    ])
    const ids: string[] = []
    for (const id of picked ?? []) {
      if (!allowed.has(id) || ids.includes(id)) continue
      ids.push(id)
    }
    return ids
  }
  return resolveMentions(text, pool).ids
}

/**
 * POST /api/projects/:id/messages: append one chat message with its D-O11
 * mentions. When the user's message tags team members (a tag of Primary does
 * not count), that is the user's own delegation: one 'task-assignment' per
 * tagged member (author 'user', the message as the task) is queued with it
 * and returned together. No confirm card (the user wrote it).
 */
export function appendProjectMessage(store: WorkspaceStore, projectId: string, body: unknown): ProjectUpdate {
  const project = projectOrFail(store, projectId)
  const raw = (body ?? {}) as Record<string, unknown>
  const author = typeof raw.author === 'string' ? raw.author.trim() : ''
  if (!author) fail(400, 'Set the author: "user" or an agent id.')
  if (author !== 'user' && !store.agents.some((a) => a.id === author)) {
    fail(400, `No agent with id "${author}"`)
  }
  const text = typeof raw.text === 'string' ? raw.text.trim() : ''
  if (!text) fail(400, 'Message text cannot be empty.')
  if (text.length > 20_000) fail(400, 'Message text must be 20,000 characters or fewer.')
  if (raw.mentions !== undefined && !Array.isArray(raw.mentions)) fail(400, '"mentions" must be a list of agent ids.')

  const mentions = resolveMessageMentions(store, project, author, text, raw.mentions as string[] | undefined)
  const message: ProjectMessage = {
    id: uid('msg'),
    projectId,
    author,
    text,
    kind: 'message',
    createdAt: '',
    ...(mentions.length > 0 ? { mentions } : {}),
  }

  // The user tagging team members delegates to them directly (D-O11).
  const primaryId = store.agents.find((a) => a.isPrimary)?.id
  const targets = author === 'user' ? mentions.filter((id) => id !== primaryId && project.teamAgentIds.includes(id)) : []

  const clock = messageClock(store, projectId)
  message.createdAt = clock()
  const assignments: ProjectMessage[] = targets.map((assigneeId) => {
    const taskMentions = resolveMentions(text, mentionPool(store, project)).ids
    return {
      id: uid('msg'),
      projectId,
      author,
      text,
      kind: 'task-assignment',
      createdAt: clock(),
      assigneeId,
      taskStatus: 'queued',
      ...(taskMentions.length > 0 ? { mentions: taskMentions } : {}),
    }
  })

  const created = [message, ...assignments]
  const previous = store.projectMessages
  store.projectMessages = [...store.projectMessages, ...created]
  if (!store.save()) {
    store.projectMessages = previous
    fail(500, 'The message could not be saved. Please retry.')
  }
  if (assignments.length > 0) runners.get(store)?.kick(projectId)
  return { project, messages: created }
}

/** By id first, then by case-insensitive name. */
function findAgent(pool: readonly Agent[], ref: string): Agent | undefined {
  return pool.find((a) => a.id === ref) ?? pool.find((a) => norm(a.name) === norm(ref))
}

/** Why a new specialist cannot take `name`: an agent already has it as its name or id. */
function nameClash(store: WorkspaceStore, name: string): string | undefined {
  const n = norm(name)
  if (store.agents.some((a) => norm(a.name) === n)) return 'an agent with that name already exists'
  if (store.agents.some((a) => norm(a.id) === n)) return "it is an existing agent's id"
  return undefined
}

function teamMembers(store: WorkspaceStore, project: Project): Agent[] {
  const out: Agent[] = []
  for (const id of project.teamAgentIds) {
    const agent = store.agents.find((a) => a.id === id)
    if (agent) out.push(agent)
  }
  return out
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

// ---------------------------------------------------------------------------
// Planner prompt

/** What an assignee sees besides its task: the prompt only when it is a stored chat message. */
const SEES_WITH_PROMPT = "the task, the project and the user's prompt"
const SEES_WITHOUT_PROMPT = 'the task and the project, so include whatever it needs from the prompt'

const plannerRules = (SEES: string): string => `The user's prompt is at the end of the next message. Check the team, then decide who does what:
- Team members fit the work: assign them tasks.
- No team yet: create project specialists (or add library agents that fit) and assign them tasks.
- The team lacks a specialty the work needs: recommend adding a library agent or creating a specialist, and say why.
- The prompt needs no work (a question, a greeting): answer in "reply" and leave the lists empty.

Rules:
- Answer with ONE JSON object and nothing else: no prose, no markdown.
- "reply": what you tell the user, in a few plain sentences.
- "add": library agents to bring onto the team, by "agentId" from "Library agents". At most ${MAX_ADD}. Never yourself or current team members.
- "create": new specialists, only when no library agent fits. At most ${MAX_CREATE}. Each needs a new, unique "name" (at most ${NAME_MAX} characters), a short "role", "instructions" written to that agent, "skillIds" from "Library skills" (may be empty) and a "reason".
- "tasks": at most ${MAX_TASKS}. "agent" is a team member's id, an "agentId" from your "add", the "name" of one of your "create" entries, or your own id. Make each task stand on its own: the assignee sees only ${SEES}. Tasks run one at a time and never see each other's results, so no task may depend on another task's output.
- Use only ids from the lists you were given. Never invent ids.
- The user reviews your plan first: nobody joins, is created or starts a task until they approve it.

Shape:
{"reply":"...","add":[{"agentId":"...","reason":"..."}],"create":[{"name":"...","role":"...","instructions":"...","skillIds":["..."],"reason":"..."}],"tasks":[{"agent":"...","task":"..."}]}

Example:
{"reply":"Ana can draft the post. No one owns our writing style, so I suggest a Copy Editor to write a short style guide.","add":[],"create":[{"name":"Copy Editor","role":"Editor","instructions":"You write and enforce the team's writing style: clear, plain, consistent terms.","skillIds":["technical-writing"],"reason":"The team has no editor."}],"tasks":[{"agent":"agt_1a2b3c4d","task":"Draft a 500-word launch post for the new release, for developers who use the API."},{"agent":"Copy Editor","task":"Write a one-page style guide for launch posts: tone, length, and terms to avoid."}]}`

function plannerSystem(lead: Agent, promptInChat: boolean): string {
  const own = clipText(lead.instructions.trim(), LEAD_INSTRUCTIONS_MAX)
  return [
    `You are ${lead.name}, the team lead of this project in AgentControl. Your agent id is ${lead.id}.`,
    own ? `Your own instructions:\n${own}` : '',
    // Tasks quote the prompt only when it is a chat message the plan replies to.
    plannerRules(promptInChat ? SEES_WITH_PROMPT : SEES_WITHOUT_PROMPT),
  ]
    .filter(Boolean)
    .join('\n\n')
}

function agentLine(store: WorkspaceStore, agent: Agent): string {
  const skills: string[] = []
  for (const id of agent.skillIds) {
    if (skills.length >= AGENT_SKILL_NAMES_MAX) break
    const skill = store.skills.find((s) => s.id === id)
    if (skill) skills.push(skill.name)
  }
  const about = clipText(oneLine(agent.description), AGENT_DESC_MAX)
  return (
    `- id: ${agent.id} | name: ${oneLine(agent.name)} | role: ${oneLine(agent.role) || 'none'}` +
    ` | skills: ${skills.join(', ') || 'none'} | about: ${about || 'none'}`
  )
}

/** A team member when the full lines do not fit: still enough to assign tasks. */
function compactAgentLine(agent: Agent): string {
  return `- id: ${agent.id} | name: ${clipText(oneLine(agent.name), NAME_MAX)}`
}

function chatLine(store: WorkspaceStore, m: ProjectMessage): string {
  const name = (id: string): string => store.agents.find((a) => a.id === id)?.name ?? 'A removed agent'
  const author = m.author === 'user' ? 'User' : name(m.author)
  const label =
    m.kind === 'team-update'
      ? ' (team update)'
      : m.kind === 'task-assignment'
        ? ` (task for ${m.assigneeId ? name(m.assigneeId) : 'someone'})`
        : m.taskId
          ? m.taskStatus === 'failed'
            ? ' (task failed)'
            : ' (task result)'
          : ''
  return `- ${author}${label}: ${clipText(oneLine(m.text), CHAT_MESSAGE_MAX)}`
}

/**
 * A roster or chat section. `total` is how many entries exist; when fewer
 * lines are shown, the section says how many were left out (never "none").
 */
function section(title: string, lines: readonly string[], total: number, empty: string, hiddenFirst = false): string {
  if (total === 0) return `${title}:\n${empty}`
  const hidden = total - lines.length
  if (hidden <= 0) return `${title}:\n${lines.join('\n')}`
  const note = hiddenFirst ? `(${count(hidden, 'earlier message', 'earlier messages')} not shown)` : `(${hidden} more not shown)`
  return `${title}:\n${(hiddenFirst ? [note, ...lines] : [...lines, note]).join('\n')}`
}

/** What Primary is asked: the user's text, and the chat message it came from (if any). */
export interface PlannerPrompt {
  text: string
  /** The chat shown to Primary is what came before this message; without it, the latest messages. */
  messageId?: string
}

export interface PlannerRequest {
  messages: ChatMessage[]
  maxTokens: number
}

/**
 * The planning request for `prompt`, fitted to `contextWindow`: chat, then
 * skills, then library agents are trimmed first; then team lines shrink to
 * id and name, and only then are team members left out. Every trimmed
 * section says how many entries it does not show. 413 when even the fixed
 * part (assembler prompt, project, user prompt) does not fit.
 */
export function buildPlannerRequest(
  store: WorkspaceStore,
  project: Project,
  lead: Agent,
  prompt: PlannerPrompt,
  contextWindow: number,
): PlannerRequest {
  const system = plannerSystem(lead, prompt.messageId !== undefined)
  const team = teamMembers(store, project)
  const teamIds = new Set(team.map((a) => a.id))

  const shownTeam = team.slice(0, ROSTER_TEAM_MAX)
  let teamLines = shownTeam.map((a) => agentLine(store, a))
  let teamCompact = false
  // This project's own specialists first, then the rest of the library.
  const candidates = store.agents
    .filter((a) => !a.isPrimary && a.id !== lead.id && !teamIds.has(a.id))
    .sort((a, b) => Number(b.projectId === project.id) - Number(a.projectId === project.id))
  const libraryLines = candidates.slice(0, ROSTER_AGENTS_MAX).map((a) => agentLine(store, a))
  const skillLines = store.skills.slice(0, ROSTER_SKILLS_MAX).map((s) => {
    const about = clipText(oneLine(s.description), SKILL_DESC_MAX)
    const label = s.name === s.id ? s.id : `${s.id}: ${oneLine(s.name)}`
    return `- ${label}${about ? ` — ${about}` : ''}`
  })
  const thread = projectThread(store, project.id)
  const at = prompt.messageId ? thread.findIndex((m) => m.id === prompt.messageId) : -1
  // Everything before the prompt, plus what already answers it (a re-ask after
  // an applied plan): Primary's reply, the team update, tasks and their results.
  const answeredTasks = new Set(
    at === -1 ? [] : thread.filter((m) => m.replyTo === prompt.messageId && m.kind === 'task-assignment').map((m) => m.id),
  )
  const earlier =
    at === -1
      ? thread
      : [
          ...thread.slice(0, at),
          ...thread.slice(at + 1).filter((m) => m.replyTo === prompt.messageId || (m.taskId !== undefined && answeredTasks.has(m.taskId))),
        ]
  const chatLines = earlier.slice(-CHAT_MESSAGES_MAX).map((m) => chatLine(store, m))

  const header = [
    `Project: ${oneLine(project.name)}`,
    `Description: ${clipText(project.desc.trim(), PROJECT_DESC_MAX) || 'none'}`,
  ].join('\n')
  const render = (): string =>
    [
      header,
      section(`Team (${team.length})`, teamLines, team.length, 'No one yet.'),
      section(`Library agents that could join (${candidates.length})`, libraryLines, candidates.length, 'None.'),
      section(
        `Library skills for new specialists (${store.skills.length}; id: name — description)`,
        skillLines,
        store.skills.length,
        'None.',
      ),
      section('Recent project chat (oldest first)', chatLines, earlier.length, 'No earlier messages.', true),
      `The user's prompt:\n${prompt.text}`,
    ].join('\n\n')

  const reserve = Math.min(PLAN_REPLY_RESERVE_MAX, Math.floor(contextWindow / 3))
  let user = render()
  let estimated = estimateTokens(system.length + user.length)
  // Bounded by the number of roster and chat lines, plus one compaction step (at most 133).
  while (estimated + reserve > contextWindow) {
    if (chatLines.length > 0) chatLines.shift()
    else if (skillLines.length > 0) skillLines.pop()
    else if (libraryLines.length > 0) libraryLines.pop()
    else if (!teamCompact && teamLines.length > 0) {
      teamCompact = true
      teamLines = shownTeam.map(compactAgentLine)
    } else if (teamLines.length > 0) teamLines.pop()
    else break
    user = render()
    estimated = estimateTokens(system.length + user.length)
  }
  if (estimated + reserve > contextWindow) {
    fail(
      413,
      `Prompt too large for ${lead.name}'s context window: about ${estimated} tokens of planning prompt ` +
        `plus ${reserve} reserved for the plan exceed the ${contextWindow}-token window. ` +
        "Shorten the message, or raise the endpoint's context window in Settings.",
    )
  }
  return {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    maxTokens: Math.min(PLAN_MAX_TOKENS, contextWindow - estimated),
  }
}

// ---------------------------------------------------------------------------
// Parsing and validation

const PLAN_KEYS = ['reply', 'add', 'create', 'tasks'] as const

function asObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text)
    return isRecord(value) ? value : null
  } catch {
    return null
  }
}

/**
 * Primary's answer as a JSON object: a fenced ```json block first (or a
 * fence with no language), else the outermost {...}; when prose before it
 * holds a stray "{", later starts are tried (at most 20). Reasoning in
 * <think> tags is ignored. null when nothing parses to an object.
 */
export function parsePlanJson(text: string): Record<string, unknown> | null {
  const body = text.slice(0, RAW_REPLY_MAX).replace(/<think>[\s\S]*?<\/think>/gi, '')
  const fence = /```[ \t]*([a-zA-Z]*)[ \t]*\r?\n([\s\S]*?)```/g
  for (let i = 0, match = fence.exec(body); match && i < 10; i++, match = fence.exec(body)) {
    const lang = (match[1] ?? '').toLowerCase()
    if (lang && lang !== 'json') continue
    const parsed = asObject((match[2] ?? '').trim())
    if (parsed) return parsed
  }
  const end = body.lastIndexOf('}')
  for (let i = 0, start = body.indexOf('{'); start !== -1 && start < end && i < 20; i++, start = body.indexOf('{', start + 1)) {
    const parsed = asObject(body.slice(start, end + 1))
    if (parsed) return parsed
  }
  return null
}

/** A list field of the raw plan; a non-list is ignored with a warning. */
function rawList(raw: Record<string, unknown>, key: string, warn: (w: string) => void = () => {}): unknown[] {
  const value = raw[key]
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    warn(`Ignored "${key}": it was not a list.`)
    return []
  }
  return value
}

function firstString(...values: unknown[]): string {
  for (const v of values) if (typeof v === 'string' && v.trim()) return v.trim()
  return ''
}

/** The agent a raw "add" entry names: the entry itself, or its agentId, id or name. */
function addRef(entry: unknown): string {
  if (typeof entry === 'string') return entry.trim()
  return isRecord(entry) ? firstString(entry.agentId, entry.id, entry.name) : ''
}

/**
 * Validate a raw plan (Primary's parsed answer, or a plan a client sends
 * back to apply) against the store: every agent and skill reference must
 * resolve, limits hold, and nothing outside the TeamPlan fields survives.
 * Each dropped entry becomes a plain-language warning. Validating a
 * validated plan against the same store returns it unchanged.
 */
export function validateTeamPlan(
  raw: Record<string, unknown>,
  store: WorkspaceStore,
  project: Project,
  lead: Agent,
): TeamPlan {
  const warnings: string[] = []
  const warn = (w: string): void => {
    warnings.push(w)
  }
  const overflow = (kept: number, extra: number, what: string): void => {
    if (extra > 0) warn(`Kept the first ${kept} ${what}; dropped ${extra} more.`)
  }

  if (raw.reply !== undefined && typeof raw.reply !== 'string') warn('Ignored "reply": it was not text.')
  const reply = clipText(str(raw.reply).trim(), REPLY_MAX)
  const isLead = (a: Agent): boolean => a.isPrimary || a.id === lead.id
  const onTeam = new Set(project.teamAgentIds)

  // add: existing library agents, not the lead, not already on the team.
  const add: TeamPlanAdd[] = []
  const addEntries = rawList(raw, 'add', warn)
  let addExtra = Math.max(0, addEntries.length - RAW_ENTRIES_MAX)
  for (const entry of addEntries.slice(0, RAW_ENTRIES_MAX)) {
    const ref = addRef(entry)
    if (!ref) {
      warn('Skipped an agent to add that had no id.')
      continue
    }
    const agent = findAgent(store.agents, ref)
    if (!agent) warn(`Skipped adding ${quote(ref)}: there is no such agent in the library.`)
    else if (isLead(agent)) warn(`Skipped adding ${agent.name}: they already lead the team.`)
    else if (onTeam.has(agent.id)) warn(`Skipped adding ${agent.name}: already on the team.`)
    else if (add.some((a) => a.agentId === agent.id)) continue
    else if (add.length >= MAX_ADD) addExtra += 1
    else add.push({ agentId: agent.id, reason: clipText(str(isRecord(entry) ? entry.reason : '').trim(), REASON_MAX) })
  }
  overflow(MAX_ADD, addExtra, 'agents to add')

  // create: names no agent has as its name or id; skills resolved by id or name.
  const create: TeamPlanCreate[] = []
  const createEntries = rawList(raw, 'create', warn)
  let createExtra = Math.max(0, createEntries.length - RAW_ENTRIES_MAX)
  for (const e of createEntries.slice(0, RAW_ENTRIES_MAX)) {
    if (!isRecord(e)) {
      warn('Skipped a new specialist that was not described as an object.')
      continue
    }
    const name = oneLine(str(e.name))
    const instructions = str(e.instructions).trim()
    if (!name) {
      warn('Skipped a new specialist with no name.')
      continue
    }
    if (name.length > NAME_MAX) {
      warn(`Skipped new specialist ${quote(name)}: names must be ${NAME_MAX} characters or fewer.`)
      continue
    }
    const clash = nameClash(store, name)
    if (clash) {
      warn(`Skipped creating ${quote(name)}: ${clash}.`)
      continue
    }
    if (create.some((c) => norm(c.name) === norm(name))) {
      warn(`Skipped a second new specialist named ${quote(name)}.`)
      continue
    }
    if (!instructions) {
      warn(`Skipped creating ${quote(name)}: it had no instructions.`)
      continue
    }
    if (create.length >= MAX_CREATE) {
      createExtra += 1
      continue
    }
    const skillIds: string[] = []
    if (e.skillIds !== undefined && !Array.isArray(e.skillIds)) warn(`Ignored the skills of ${quote(name)}: not a list.`)
    const skillRefs: unknown[] = Array.isArray(e.skillIds) ? e.skillIds : []
    let skillExtra = Math.max(0, skillRefs.length - RAW_ENTRIES_MAX)
    for (const skillRef of skillRefs.slice(0, RAW_ENTRIES_MAX)) {
      const ref = typeof skillRef === 'string' ? skillRef.trim() : ''
      if (!ref) continue
      const skill = store.skills.find((s) => s.id === ref) ?? store.skills.find((s) => norm(s.name) === norm(ref))
      if (!skill) warn(`Dropped unknown skill ${quote(ref)} from ${quote(name)}.`)
      else if (skillIds.includes(skill.id)) continue
      else if (skillIds.length >= MAX_CREATE_SKILLS) skillExtra += 1
      else skillIds.push(skill.id)
    }
    overflow(MAX_CREATE_SKILLS, skillExtra, `skills for ${quote(name)}`)
    create.push({
      name,
      role: clipText(oneLine(str(e.role)), ROLE_MAX),
      instructions: clipText(instructions, INSTRUCTIONS_MAX),
      skillIds,
      reason: clipText(str(e.reason).trim(), REASON_MAX),
    })
  }
  overflow(MAX_CREATE, createExtra, 'new specialists')

  // tasks: to the lead, a team member, an agent in `add`, or a `create` name.
  const team = teamMembers(store, project)
  const added = add.map((a) => store.agents.find((x) => x.id === a.agentId)).filter((a): a is Agent => Boolean(a))
  const assignable = [lead, ...team, ...added]
  const resolveAssignee = (ref: string): string | undefined => {
    const byId = assignable.find((a) => a.id === ref)
    if (byId) return byId.id
    const byName = assignable.find((a) => norm(a.name) === norm(ref))
    if (byName) return byName.id
    return create.find((c) => norm(c.name) === norm(ref))?.name
  }
  const tasks: TeamPlanTask[] = []
  const taskEntries = rawList(raw, 'tasks', warn)
  let taskExtra = Math.max(0, taskEntries.length - RAW_ENTRIES_MAX)
  for (const entry of taskEntries.slice(0, RAW_ENTRIES_MAX)) {
    const e = isRecord(entry) ? entry : {}
    const text = str(e.task).trim()
    const ref = firstString(e.agent, e.agentId)
    if (!text) {
      warn('Skipped a task with no text.')
      continue
    }
    const assignee = ref ? resolveAssignee(ref) : undefined
    if (!assignee) {
      const known = ref ? findAgent(store.agents, ref) : undefined
      warn(
        ref
          ? `Skipped the task ${quote(text)}: ${known ? known.name : quote(ref)} is not on the team, in this plan, or the team lead.`
          : `Skipped the task ${quote(text)}: it named no agent.`,
      )
      continue
    }
    if (tasks.length >= MAX_TASKS) {
      taskExtra += 1
      continue
    }
    tasks.push({ agent: assignee, task: clipText(text, TASK_MAX) })
  }
  overflow(MAX_TASKS, taskExtra, 'tasks')

  const kept =
    warnings.length > MAX_WARNINGS
      ? [...warnings.slice(0, MAX_WARNINGS - 1), `…and ${warnings.length - MAX_WARNINGS + 1} more.`]
      : warnings
  return { reply, add, create, tasks, warnings: kept }
}

// ---------------------------------------------------------------------------
// Routes (app.ts registers them; these hold the logic)

const TEAM_PLAN_USAGE = 'Send {"messageId": "<id>"} (a user message in this chat) or {"prompt": "<text>"}.'

/**
 * POST /api/projects/:id/team-plan. Asks Primary about the user's prompt
 * (a chat message by id, or a prompt sent as text) and returns the
 * validated plan. Never writes: concurrent requests are harmless, and a
 * failed call or an answer that is not a plan is a 502 with nothing changed.
 */
export async function requestTeamPlan(store: WorkspaceStore, projectId: string, body: unknown): Promise<TeamPlanResult> {
  projectOrFail(store, projectId)
  if (!isRecord(body)) fail(400, TEAM_PLAN_USAGE)
  if (body.messageId !== undefined && typeof body.messageId !== 'string') fail(400, '"messageId" must be a string.')
  if (body.prompt !== undefined && typeof body.prompt !== 'string') fail(400, '"prompt" must be a string.')
  const messageId = str(body.messageId).trim()
  let prompt: PlannerPrompt
  if (messageId) {
    // The message's text is the prompt; a "prompt" sent alongside is ignored.
    prompt = { text: userMessageOrFail(store, projectId, messageId).text, messageId }
  } else {
    const text = str(body.prompt).trim()
    if (!text) fail(400, TEAM_PLAN_USAGE)
    if (text.length > PROMPT_MAX) fail(400, `"prompt" must be ${PROMPT_MAX.toLocaleString('en-US')} characters or fewer.`)
    prompt = { text }
  }
  const lead = store.agents.find((a) => a.isPrimary)
  if (!lead) fail(409, 'Create the Team Lead first: Primary plans the team and its tasks.')
  const endpoint = store.endpoints.find((e) => e.id === lead.endpointId)
  if (!endpoint) fail(400, `Agent "${lead.name}" has no valid endpoint. Pick one in its settings.`)
  const request = buildPlannerRequest(store, projectOrFail(store, projectId), lead, prompt, endpoint.contextWindow)

  const result = await chatCompletion(
    endpoint.baseUrl,
    store.endpointKeys[endpoint.id],
    lead.modelId,
    request.messages,
    endpoint.timeoutMs ?? 30_000,
    request.maxTokens,
    undefined,
    PLANNER_TEMPERATURE,
  )
  if (!result.ok) fail(502, `${lead.name} could not answer: ${result.error ?? 'request failed'}. Nothing was changed.`)

  // The store may have changed during the call: validate against it as it is now.
  const project = projectOrFail(store, projectId)
  const parsed = parsePlanJson(result.content)
  if (!parsed || !PLAN_KEYS.some((k) => k in parsed)) {
    const excerpt = clipText(oneLine(result.content), 160)
    fail(
      502,
      result.finishReason === 'length'
        ? `${lead.name}'s answer was cut off before the plan was complete. Nothing was changed; try a shorter request.`
        : `${lead.name}'s answer was not a valid team plan (one JSON object with reply, add, create and tasks). ` +
            `Nothing was changed; try again.${excerpt ? ` It began: "${excerpt}"` : ''}`,
    )
  }
  const plan = validateTeamPlan(parsed, store, project, lead)
  return messageId ? { plan, replyTo: messageId } : { plan }
}

interface ApplyInput {
  /** The plan as sent, still raw: only what the user accepted of it. */
  accepted: Record<string, unknown>
  replyTo?: string
}

const APPLY_USAGE =
  'Send {"plan": <the plan from POST /api/projects/:id/team-plan>, "replyTo"?: "<message id>", ' +
  '"add"?: ["<agent id>"], "create"?: [0], "tasks"?: [0, 1]}.'

/**
 * The apply body: the message the plan answers, and the part of the plan the
 * user accepted. Agent ids and indexes refer to the plan as sent (the plan
 * the user confirmed), so they are checked against it, not against what
 * validation keeps of it; anything else is a 400. An omitted list accepts
 * the whole list, exactly as sent.
 */
function parseApply(store: WorkspaceStore, projectId: string, body: unknown): ApplyInput {
  if (!isRecord(body) || !isRecord(body.plan)) fail(400, APPLY_USAGE)
  const plan = body.plan
  let replyTo: string | undefined
  if (body.replyTo !== undefined) {
    if (typeof body.replyTo !== 'string') fail(400, '"replyTo" must be the id of a user message in this chat.')
    replyTo = userMessageOrFail(store, projectId, body.replyTo).id
  }
  const indexed = (key: 'create' | 'tasks'): unknown => {
    const value = body[key]
    if (value === undefined) return plan[key]
    if (!Array.isArray(value) || value.length > SELECTION_MAX) fail(400, `"${key}" must be a list of indexes into plan.${key}.`)
    const entries = rawList(plan, key)
    for (const i of value) {
      if (typeof i !== 'number' || !Number.isInteger(i) || i < 0 || i >= entries.length) {
        fail(400, `"${key}" lists ${String(JSON.stringify(i)).slice(0, 100)}, which is not an index into plan.${key}.`)
      }
    }
    const picked = new Set(value as number[])
    return entries.filter((_, i) => picked.has(i))
  }
  let add: unknown = plan.add
  if (body.add !== undefined) {
    if (!Array.isArray(body.add) || body.add.length > SELECTION_MAX) fail(400, '"add" must be a list of agent ids from plan.add.')
    const entries = rawList(plan, 'add')
    const proposed = new Set(entries.slice(0, RAW_ENTRIES_MAX).map(addRef))
    for (const id of body.add) {
      if (typeof id !== 'string' || !id || !proposed.has(id)) {
        fail(400, `"add" lists ${String(JSON.stringify(id)).slice(0, 100)}, which plan.add does not propose.`)
      }
    }
    const picked = new Set(body.add as string[])
    add = entries.filter((e) => picked.has(addRef(e)))
  }
  return {
    accepted: { reply: plan.reply, add, create: indexed('create'), tasks: indexed('tasks') },
    ...(replyTo ? { replyTo } : {}),
  }
}

/**
 * POST /api/projects/:id/team-plan/apply. What the user accepted of the plan
 * is validated again like model output against the current store (bad
 * entries dropped and noted in the team update; a task whose agent was not
 * accepted is one of them). Then: Primary's reply becomes a 'message' from
 * Primary; the specialists are created (library agents tagged with the
 * project, on Primary's endpoint/model/temperature); added and created
 * agents join the team ('team-update'); each task becomes a
 * 'task-assignment'; all of them carry replyTo; the task runner starts.
 * 409 when an accepted specialist's name is taken.
 */
export function applyTeamPlan(store: WorkspaceStore, runner: TaskRunner, projectId: string, body: unknown): ProjectUpdate {
  const project = projectOrFail(store, projectId)
  const { accepted, replyTo } = parseApply(store, projectId, body)
  const lead = store.agents.find((a) => a.isPrimary)
  if (!lead) fail(409, 'Create the Team Lead first: new specialists use its endpoint and model.')

  // A specialist the user accepted whose name is taken now: refuse, write nothing.
  for (const e of rawList(accepted, 'create').slice(0, RAW_ENTRIES_MAX)) {
    const name = isRecord(e) ? oneLine(str(e.name)) : ''
    if (name && nameClash(store, name)) {
      fail(409, `An agent named or with the id "${clipText(name, NAME_MAX)}" exists now. Untick it, or ask Primary again.`)
    }
  }
  const plan = validateTeamPlan(accepted, store, project, lead)

  const now = new Date().toISOString()
  const created: Agent[] = plan.create.map((c) => ({
    id: uid('agt'),
    name: c.name,
    description: c.reason || `Specialist for ${project.name}.`,
    instructions: c.instructions,
    modelId: lead.modelId,
    endpointId: lead.endpointId,
    isPrimary: false,
    role: c.role,
    ...(lead.temperature !== undefined ? { temperature: lead.temperature } : {}),
    skillIds: [...c.skillIds],
    status: 'idle',
    createdAt: now,
    lastRunAt: null,
    runCount: 0,
    projectId: project.id,
  }))
  const joined = plan.add
    .map((a) => store.agents.find((x) => x.id === a.agentId))
    .filter((a): a is Agent => Boolean(a))
  const teamAgentIds = [...project.teamAgentIds, ...joined.map((a) => a.id), ...created.map((a) => a.id)]

  // A validated task names the lead, a team member, an added agent (by id) or
  // a created one (by name, now mapped to its new id).
  const tasks: { assigneeId: string; task: string }[] = []
  for (const t of plan.tasks) {
    const i = plan.create.findIndex((c) => norm(c.name) === norm(t.agent))
    const assigneeId = i === -1 ? t.agent : created[i]?.id
    if (assigneeId && (assigneeId === lead.id || teamAgentIds.includes(assigneeId))) tasks.push({ assigneeId, task: t.task })
  }

  const teamChanged = joined.length > 0 || created.length > 0
  const lines: string[] = []
  if (joined.length > 0) lines.push(`Added ${joined.map((a) => a.name).join(', ')} to the team.`)
  if (created.length > 0) {
    lines.push(`Created ${created.map((a) => (a.role ? `${a.name} (${a.role})` : a.name)).join(', ')} for this project.`)
  }
  if (!teamChanged) lines.push('No team changes.')
  lines.push(...plan.warnings)
  if (tasks.length > 0) lines.push(`Assigned ${count(tasks.length, 'task', 'tasks')}.`)

  const clock = messageClock(store, projectId)
  const thread = replyTo ? { replyTo } : {}
  const messages: ProjectMessage[] = []
  // Specialists created by this apply are not in the store yet: add them to
  // the mention pool so an assignment naming one resolves.
  const pool = mentionCandidates(lead, [...teamMembers(store, project), ...created], store.agents)
  const mentionIds = (text: string): { mentions?: string[] } => {
    const ids = resolveMentions(text, pool).ids
    return ids.length > 0 ? { mentions: ids } : {}
  }
  if (plan.reply) {
    messages.push({ id: uid('msg'), projectId, author: lead.id, text: plan.reply, kind: 'message', createdAt: clock(), ...thread, ...mentionIds(plan.reply) })
  }
  // The team update says who joined, and why anything the user accepted was dropped.
  if (teamChanged || plan.warnings.length > 0) {
    const updateText = lines.join(' ')
    messages.push({ id: uid('msg'), projectId, author: lead.id, text: updateText, kind: 'team-update', createdAt: clock(), ...thread, ...mentionIds(updateText) })
  }
  for (const t of tasks) {
    // D-O11: assignments name the lead and the assignee as @tags. The
    // assignee may be a specialist created moments ago (not in the store yet).
    const assigneeName =
      created.find((c) => c.id === t.assigneeId)?.name ?? store.agents.find((a) => a.id === t.assigneeId)?.name ?? 'someone'
    const text = `@${lead.name} → @${assigneeName}: ${t.task}`
    messages.push({
      id: uid('msg'),
      projectId,
      author: lead.id,
      text,
      kind: 'task-assignment',
      createdAt: clock(),
      ...thread,
      assigneeId: t.assigneeId,
      taskStatus: 'queued',
      ...mentionIds(text),
    })
  }
  if (messages.length === 0) return { project, messages }

  const nextProject: Project = teamChanged ? { ...project, teamAgentIds, updatedAt: now } : project
  const previous = { agents: store.agents, projects: store.projects, messages: store.projectMessages }
  store.agents = [...created, ...store.agents]
  store.projects = store.projects.map((p) => (p.id === projectId ? nextProject : p))
  store.projectMessages = [...store.projectMessages, ...messages]
  if (!store.save()) {
    store.agents = previous.agents
    store.projects = previous.projects
    store.projectMessages = previous.messages
    fail(500, 'The plan could not be applied in storage. Please retry.')
  }
  if (tasks.length > 0) runner.kick(projectId)
  return { project: nextProject, messages }
}

/** POST /api/projects/:id/tasks/:messageId/retry: re-queue a failed or cancelled task. */
export function retryTask(store: WorkspaceStore, runner: TaskRunner, projectId: string, messageId: string): ProjectUpdate {
  const project = projectOrFail(store, projectId)
  const task = findMessage(store, projectId, messageId)
  if (!task || task.kind !== 'task-assignment') fail(404, `No task with id "${messageId.slice(0, 100)}" in this project.`)
  if (task.taskStatus !== 'failed' && task.taskStatus !== 'cancelled') {
    fail(409, `Only a failed or cancelled task can be retried; this one is ${task.taskStatus ?? 'unknown'}.`)
  }
  if (!store.agents.some((a) => a.id === task.assigneeId)) {
    fail(409, 'The agent assigned to this task is no longer in the library.')
  }
  const queued: ProjectMessage = { ...task, taskStatus: 'queued', updatedAt: new Date().toISOString() }
  const previous = store.projectMessages
  replaceMessage(store, queued)
  if (!store.save()) {
    store.projectMessages = previous
    fail(500, 'The task could not be re-queued in storage. Please retry.')
  }
  runner.kick(projectId)
  return { project, messages: [queued] }
}

/** Tasks that name `taskId` in `inputs` (and their transitive dependents), newest-ready first. */
export function dependentTasks(store: WorkspaceStore, projectId: string, taskId: string): ProjectMessage[] {
  const open = new Set([taskId])
  const found: ProjectMessage[] = []
  let grew = true
  while (grew) {
    grew = false
    for (const m of store.projectMessages) {
      if (m.projectId !== projectId || m.kind !== 'task-assignment' || !m.inputs?.length) continue
      if (found.some((f) => f.id === m.id) || open.has(m.id)) continue
      if (!m.inputs.some((id) => open.has(id))) continue
      found.push(m)
      open.add(m.id)
      grew = true
    }
  }
  return found
}

function setProjectPaused(store: WorkspaceStore, project: Project, paused: boolean): Project {
  const next: Project = paused ? { ...project, paused: true } : (() => {
    const { paused: _drop, ...rest } = project
    return rest
  })()
  store.projects = store.projects.map((p) => (p.id === project.id ? next : p))
  return next
}

/** POST /api/projects/:id/work/pause — start nothing new; the in-flight call keeps going (D-O5). */
export function pauseWork(store: WorkspaceStore, projectId: string): ProjectUpdate {
  const project = projectOrFail(store, projectId)
  if (project.paused) return { project, messages: [] }
  const previous = store.projects
  const next = setProjectPaused(store, project, true)
  if (!store.save()) {
    store.projects = previous
    fail(500, 'The project could not be paused in storage. Please retry.')
  }
  return { project: next, messages: [] }
}

/** POST /api/projects/:id/work/resume — clear pause and kick the queue. */
export function resumeWork(store: WorkspaceStore, runner: TaskRunner, projectId: string): ProjectUpdate {
  const project = projectOrFail(store, projectId)
  if (!project.paused) {
    runner.kick(projectId)
    return { project, messages: [] }
  }
  const previous = store.projects
  const next = setProjectPaused(store, project, false)
  if (!store.save()) {
    store.projects = previous
    fail(500, 'The project could not be resumed in storage. Please retry.')
  }
  runner.kick(projectId)
  return { project: next, messages: [] }
}

/**
 * Mark tasks cancelled (and leave a result line). Does not abort an in-flight
 * run; the caller aborts first when stopping a running task.
 */
function cancelAssignments(
  store: WorkspaceStore,
  projectId: string,
  tasks: ProjectMessage[],
  reason: string,
): ProjectMessage[] {
  if (tasks.length === 0) return []
  const now = new Date().toISOString()
  const ids = new Set(tasks.map((t) => t.id))
  const clock = messageClock(store, projectId)
  const changed: ProjectMessage[] = []
  const results: ProjectMessage[] = []
  for (const task of tasks) {
    if (task.taskStatus === 'done' || task.taskStatus === 'cancelled') continue
    const next: ProjectMessage = { ...task, taskStatus: 'cancelled', updatedAt: now }
    changed.push(next)
    results.push({
      id: uid('msg'),
      projectId,
      author: task.assigneeId ?? task.author,
      text: reason,
      kind: 'message',
      createdAt: clock(),
      taskId: task.id,
      taskStatus: 'cancelled',
    })
  }
  if (changed.length === 0) return []
  store.projectMessages = [
    ...store.projectMessages.map((m) => (ids.has(m.id) ? (changed.find((c) => c.id === m.id) ?? m) : m)),
    ...results,
  ]
  return [...changed, ...results]
}

/**
 * POST /api/projects/:id/tasks/:messageId/cancel — cancel a queued/running/failed
 * task and any non-done dependents that name it in `inputs` (D-O4). 409 when done.
 */
export function cancelTask(
  store: WorkspaceStore,
  runner: TaskRunner,
  projectId: string,
  messageId: string,
): ProjectUpdate {
  const project = projectOrFail(store, projectId)
  const task = findMessage(store, projectId, messageId)
  if (!task || task.kind !== 'task-assignment') fail(404, `No task with id "${messageId.slice(0, 100)}" in this project.`)
  if (task.taskStatus === 'done') fail(409, 'A finished task cannot be cancelled.')
  if (task.taskStatus === 'cancelled') return { project, messages: [] }

  const deps = dependentTasks(store, projectId, task.id).filter(
    (d) => d.taskStatus !== 'done' && d.taskStatus !== 'cancelled',
  )
  const previousMessages = store.projectMessages
  if (task.taskStatus === 'running') runner.halt(projectId)
  const messages = cancelAssignments(store, projectId, [task, ...deps], 'Cancelled by you.')
  if (!store.save()) {
    store.projectMessages = previousMessages
    fail(500, 'The task could not be cancelled in storage. Please retry.')
  }
  return { project, messages }
}

/**
 * POST /api/projects/:id/work/stop — abort the in-flight call and cancel every
 * queued (and running) task; each can be retried (D-O5).
 */
export function stopWork(store: WorkspaceStore, runner: TaskRunner, projectId: string): ProjectUpdate {
  const project = projectOrFail(store, projectId)
  const open = store.projectMessages.filter(
    (m) =>
      m.projectId === projectId &&
      m.kind === 'task-assignment' &&
      (m.taskStatus === 'queued' || m.taskStatus === 'running'),
  )
  const previousProjects = store.projects
  const previousMessages = store.projectMessages
  runner.halt(projectId)
  const messages = cancelAssignments(store, projectId, open, 'Stopped by you.')
  // Stop clears pause so a later resume/retry is not blocked by a stale flag.
  const next = project.paused ? setProjectPaused(store, project, false) : project
  if (!store.save()) {
    store.projects = previousProjects
    store.projectMessages = previousMessages
    fail(500, 'The project work could not be stopped in storage. Please retry.')
  }
  return { project: next, messages }
}

// ---------------------------------------------------------------------------
// Task runner

export interface TaskRunner {
  /** Run the project's queued tasks (no-op when a drain is already waiting to start). */
  kick(projectId: string): void
  /** Resolves once the project has no drain running or waiting. */
  whenIdle(projectId: string): Promise<void>
  /** True while a drain for the project is running or waiting. */
  busy(projectId: string): boolean
  /**
   * Start no further tasks for the project (it was deleted) and abort the call
   * in flight when there is one (D-O5).
   */
  stop(projectId: string): void
  /** Abort the call in flight for this project, if any. Queue control is separate. */
  halt(projectId: string): void
  /** Start no further tasks anywhere and wait for the ones in flight. */
  close(): Promise<void>
}

interface Lane {
  tail: Promise<void>
  waiting: boolean
  stopped: boolean
  current?: { taskId: string; controller: AbortController }
}

/** The latest runner per store, for whenProjectIdle. */
const runners = new WeakMap<WorkspaceStore, TaskRunner>()

/** Await a project's task queue going idle (tests; no-op without a runner). */
export function whenProjectIdle(store: WorkspaceStore, projectId: string): Promise<void> {
  return runners.get(store)?.whenIdle(projectId) ?? Promise.resolve()
}

/** Queue time: a retried task waits behind tasks queued before the retry. */
const queuedAt = (m: ProjectMessage): string => m.updatedAt ?? m.createdAt

function nextQueuedTask(store: WorkspaceStore, projectId: string): ProjectMessage | undefined {
  let next: ProjectMessage | undefined
  for (const m of store.projectMessages) {
    if (m.projectId !== projectId || m.kind !== 'task-assignment' || m.taskStatus !== 'queued') continue
    if (!next || queuedAt(m) < queuedAt(next)) next = m
  }
  return next
}

/** What the assignee is asked: the project, the user's prompt (replyTo), the task, the team. */
function buildTaskInput(store: WorkspaceStore, project: Project, task: ProjectMessage, assignee: Agent): string {
  const prompt = task.replyTo ? findMessage(store, project.id, task.replyTo) : undefined
  const lead = store.agents.find((a) => a.id === task.author) ?? store.agents.find((a) => a.isPrimary)
  // D-O11: assignments carry a "@lead → @assignee: " tag prefix for the chat;
  // the assignee gets the task text without it.
  const taskText = task.text.replace(/^@[^:]{1,140}: /, '')
  const teammates = teamMembers(store, project)
    .filter((a) => a.id !== assignee.id)
    .slice(0, TASK_TEAMMATES_MAX)
  const desc = clipText(project.desc.trim(), PROJECT_DESC_MAX)
  return [
    `Project: ${project.name}${desc ? `\n${desc}` : ''}`,
    prompt ? `The user asked:\n${clipText(prompt.text.trim(), TASK_PROMPT_MAX)}` : '',
    lead && lead.id === assignee.id
      ? `As the team lead, you took this task:\n${taskText}`
      : `${lead?.name ?? 'The team lead'} assigned you this task:\n${taskText}`,
    teammates.length > 0
      ? `Your teammates:\n${teammates.map((a) => `- ${a.name}${a.role ? ` (${a.role})` : ''}`).join('\n')}`
      : '',
    'Reply with your result for the team.',
    teammates.length > 0 || lead
      ? `Address teammates and the lead by @Name in your result (for example "@${(teammates[0] ?? lead)?.name ?? 'teammate'} …") to hand work on or ask the lead a question.`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}

/**
 * On process start: fail only running tasks left behind, and pause any project
 * that still has queued work (D-O5). Projects `busy` reports are skipped.
 */
export function failInterruptedTasks(store: WorkspaceStore, busy: (projectId: string) => boolean = () => false): number {
  const running = store.projectMessages.filter(
    (m) =>
      m.kind === 'task-assignment' &&
      m.taskStatus === 'running' &&
      !busy(m.projectId) &&
      store.projects.some((p) => p.id === m.projectId),
  )
  const now = new Date().toISOString()
  let changed = 0
  if (running.length > 0) {
    const failedIds = new Set(running.map((m) => m.id))
    const clocks = new Map<string, () => string>()
    const results: ProjectMessage[] = running.map((m) => {
      const clock = clocks.get(m.projectId) ?? messageClock(store, m.projectId)
      clocks.set(m.projectId, clock)
      return {
        id: uid('msg'),
        projectId: m.projectId,
        author: m.assigneeId ?? m.author,
        text: 'Could not finish: interrupted by a restart. Retry the task to run it again.',
        kind: 'message',
        createdAt: clock(),
        taskId: m.id,
        taskStatus: 'failed',
      }
    })
    store.projectMessages = [
      ...store.projectMessages.map((m) => (failedIds.has(m.id) ? { ...m, taskStatus: 'failed' as const, updatedAt: now } : m)),
      ...results,
    ]
    changed += running.length
  }

  // Queued tasks stay queued; pause those projects so nothing starts until the user resumes.
  const queuedProjectIds = new Set(
    store.projectMessages
      .filter(
        (m) =>
          m.kind === 'task-assignment' &&
          m.taskStatus === 'queued' &&
          !busy(m.projectId) &&
          store.projects.some((p) => p.id === m.projectId),
      )
      .map((m) => m.projectId),
  )
  if (queuedProjectIds.size > 0) {
    store.projects = store.projects.map((p) => (queuedProjectIds.has(p.id) && !p.paused ? { ...p, paused: true } : p))
    changed += queuedProjectIds.size
  }

  if (changed > 0) store.save()
  return changed
}

/**
 * Per-project task queues: each project runs its queued tasks one at a time,
 * oldest queue time first; different projects run concurrently. Creating a
 * runner first fails running tasks a previous process left behind and pauses
 * projects that still have queued work.
 */
export function createTaskRunner(store: WorkspaceStore, log: (err: unknown) => void = console.error): TaskRunner {
  const previous = runners.get(store)
  failInterruptedTasks(store, (projectId) => previous?.busy(projectId) ?? false)

  const lanes = new Map<string, Lane>()
  let closed = false

  async function runTask(projectId: string, taskId: string, lane: Lane): Promise<void> {
    const project = store.projects.find((p) => p.id === projectId)
    const task = findMessage(store, projectId, taskId)
    if (!project || !task || task.taskStatus !== 'queued') return
    replaceMessage(store, { ...task, taskStatus: 'running', updatedAt: new Date().toISOString() })
    store.save()

    const controller = new AbortController()
    lane.current = { taskId, controller }

    const assignee = store.agents.find((a) => a.id === task.assigneeId)
    let text: string
    let ok = false
    let stopped = false
    let runId: string | undefined
    if (!assignee) {
      text = 'Could not finish: the assigned agent is no longer in the library.'
    } else {
      try {
        // A failed save of the run is not a task failure: the run is in the
        // store, and the save below persists it with the result message.
        const { run } = await executeRun(store, assignee, buildTaskInput(store, project, task, assignee), {
          projectId,
          signal: controller.signal,
        })
        runId = run.id
        ok = run.status === 'succeeded'
        stopped = run.error === STOPPED_BY_YOU
        text = ok
          ? clipText(run.output.trim(), RESULT_TEXT_MAX) || '(The agent replied with no text.)'
          : `Could not finish: ${run.error ?? 'the run failed.'}`
      } catch (err) {
        text = `Could not finish: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    if (lane.current?.taskId === taskId) lane.current = undefined

    // The project (and its chat) may have been deleted while the run was in
    // flight: then its run goes too, like the project's other runs.
    const current = findMessage(store, projectId, taskId)
    if (!current || !store.projects.some((p) => p.id === projectId)) {
      if (runId && !store.projects.some((p) => p.id === projectId)) {
        store.runs = store.runs.filter((r) => r.id !== runId)
        store.save()
      }
      return
    }
    // Cancel/stop may have marked the task already; never overwrite that.
    if (current.taskStatus === 'cancelled') return

    const status = ok ? ('done' as const) : stopped ? ('cancelled' as const) : ('failed' as const)
    const result: ProjectMessage = {
      id: uid('msg'),
      projectId,
      author: task.assigneeId ?? task.author,
      text: clipText(text, RESULT_TEXT_MAX),
      kind: 'message',
      createdAt: messageClock(store, projectId)(),
      taskId,
      taskStatus: status,
      ...(runId ? { runId } : {}),
      // D-O11: an agent tagging a teammate is a hand-off request; a tag of
      // Primary is a question. The runner records the ids; nothing starts.
      ...(() => {
        const ids = resolveMentions(text, mentionPool(store, project)).ids
        return ids.length > 0 ? { mentions: ids } : {}
      })(),
    }
    store.projectMessages = [
      ...store.projectMessages.map((m) =>
        m.id === taskId ? { ...current, taskStatus: status, updatedAt: new Date().toISOString() } : m,
      ),
      result,
    ]
    store.save()
  }

  async function drain(projectId: string, lane: Lane): Promise<void> {
    for (let i = 0; i < TASKS_PER_DRAIN; i++) {
      if (closed || lane.stopped || !store.projects.some((p) => p.id === projectId)) return
      const project = store.projects.find((p) => p.id === projectId)
      if (project?.paused) return
      const next = nextQueuedTask(store, projectId)
      if (!next) return
      await runTask(projectId, next.id, lane)
    }
    // Still busy after a full drain: queue another behind anything waiting.
    kick(projectId)
  }

  function kick(projectId: string): void {
    if (closed) return
    let lane = lanes.get(projectId)
    if (!lane) {
      lane = { tail: Promise.resolve(), waiting: false, stopped: false }
      lanes.set(projectId, lane)
    }
    if (lane.waiting || lane.stopped) return
    lane.waiting = true
    const current = lane
    const tail = current.tail.then(async () => {
      current.waiting = false
      try {
        await drain(projectId, current)
      } catch (err) {
        log(err)
      }
    })
    current.tail = tail
    void tail.then(() => {
      if (lanes.get(projectId) === current && current.tail === tail) lanes.delete(projectId)
    })
  }

  function abortCurrent(projectId: string): void {
    const lane = lanes.get(projectId)
    lane?.current?.controller.abort()
  }

  const runner: TaskRunner = {
    kick,
    async whenIdle(projectId) {
      // Each pass awaits the current tail; a kick during the wait extends it.
      for (let i = 0; i < 1_000; i++) {
        const lane = lanes.get(projectId)
        if (!lane) return
        const tail = lane.tail
        await tail
        if (lane.tail === tail) return
      }
    },
    busy: (projectId) => lanes.has(projectId),
    stop(projectId) {
      const lane = lanes.get(projectId)
      if (lane) {
        lane.stopped = true
        lane.current?.controller.abort()
      }
    },
    halt(projectId) {
      abortCurrent(projectId)
    },
    async close() {
      closed = true
      for (const lane of lanes.values()) lane.current?.controller.abort()
      await Promise.all([...lanes.values()].map((l) => l.tail))
    },
  }
  runners.set(store, runner)
  return runner
}
