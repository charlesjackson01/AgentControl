/**
 * Project team plans and task runs (docs/PROJECTS_HANDOFF.md, Part 2).
 *
 * A user message in the project chat goes to Primary (the Team Lead) with a
 * fixed assembler prompt. Primary answers with JSON: a reply, library agents
 * to add, project specialists to create, and tasks. That answer is untrusted
 * model output: it is parsed leniently, then validated strictly into a
 * TeamPlan, and only the plan's own fields ever reach the store (ids are
 * resolved against the library or minted here, never taken from the model).
 *
 * D-P1: team changes wait for the user (planStatus 'pending' until apply or
 * cancel); a plan with only tasks applies at once. Applied tasks become
 * 'task-assignment' messages that a per-project runner executes one at a time
 * through runAgent, posting each output back as a 'task-result'.
 */
import { fail, uid } from './http.js'
import { estimateTokens } from './prompt.js'
import { runAgent } from './runs.js'
import type {
  Agent,
  Project,
  ProjectMessage,
  TeamPlan,
  TeamPlanAdd,
  TeamPlanCreate,
  TeamPlanResponse,
  TeamPlanTask,
} from './shared/types.js'
import type { WorkspaceStore } from './store.js'
import { clipText } from './tools/limits.js'
import { chatCompletion, type ChatMessage } from './upstream.js'

/** Plan limits: what one Primary answer may propose. */
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

function projectOrFail(store: WorkspaceStore, id: string): Project {
  const project = store.projects.find((p) => p.id === id)
  if (!project) fail(404, `No project with id "${id}"`)
  return project
}

function findMessage(store: WorkspaceStore, projectId: string, id: string): ProjectMessage | undefined {
  return store.projectMessages.find((m) => m.id === id && m.projectId === projectId)
}

/** A project's messages in GET order (oldest first). */
function projectThread(store: WorkspaceStore, projectId: string): ProjectMessage[] {
  return store.projectMessages
    .filter((m) => m.projectId === projectId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
}

/**
 * createdAt for new messages: now, but always after the project's latest
 * message, so a batch (plan, team update, assignments) keeps its order in GET.
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

/** By id first, then by case-insensitive name. */
function findAgent(pool: readonly Agent[], ref: string): Agent | undefined {
  return pool.find((a) => a.id === ref) ?? pool.find((a) => norm(a.name) === norm(ref))
}

function teamMembers(store: WorkspaceStore, project: Project): Agent[] {
  const out: Agent[] = []
  for (const id of project.teamAgentIds) {
    const agent = store.agents.find((a) => a.id === id)
    if (agent) out.push(agent)
  }
  return out
}

function assignmentMessages(
  projectId: string,
  planId: string,
  authorId: string,
  tasks: { assigneeId: string; task: string }[],
  clock: () => string,
): ProjectMessage[] {
  return tasks.map((t) => ({
    id: uid('msg'),
    projectId,
    author: authorId,
    text: t.task,
    kind: 'task-assignment',
    createdAt: clock(),
    planId,
    assigneeId: t.assigneeId,
    taskStatus: 'queued',
  }))
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/** Fallback chat text for a plan whose reply is empty. */
function planSummary(plan: TeamPlan): string {
  const parts: string[] = []
  if (plan.add.length > 0) parts.push(count(plan.add.length, 'agent to add', 'agents to add'))
  if (plan.create.length > 0) parts.push(count(plan.create.length, 'specialist to create', 'specialists to create'))
  if (plan.tasks.length > 0) parts.push(count(plan.tasks.length, 'task', 'tasks'))
  return parts.length > 0 ? `Proposed ${parts.join(', ')}.` : 'No changes or tasks proposed.'
}

// ---------------------------------------------------------------------------
// Planner prompt

const PLANNER_RULES = `The user's prompt is at the end of the next message. Check the team, then decide who does what:
- Team members fit the work: assign them tasks.
- No team yet: create project specialists (or add library agents that fit) and assign them tasks.
- The team lacks a specialty the work needs: recommend adding a library agent or creating a specialist, and say why.
- The prompt needs no work (a question, a greeting): answer in "reply" and leave the lists empty.

Rules:
- Answer with ONE JSON object and nothing else: no prose, no markdown.
- "reply": what you tell the user, in a few plain sentences.
- "add": library agents to bring onto the team, by "agentId" from "Library agents". At most ${MAX_ADD}. Never yourself or current team members.
- "create": new specialists, only when no library agent fits. At most ${MAX_CREATE}. Each needs a new, unique "name" (at most ${NAME_MAX} characters), a short "role", "instructions" written to that agent, "skillIds" from "Library skills" (may be empty) and a "reason".
- "tasks": at most ${MAX_TASKS}. "agent" is a team member's id, an "agentId" from your "add", the "name" of one of your "create" entries, or your own id. Make each task stand on its own: the assignee sees only the task, the project and the user's prompt.
- Use only ids from the lists you were given. Never invent ids.
- The user approves team changes ("add", "create") before work starts; tasks for current team members start at once.

Shape:
{"reply":"...","add":[{"agentId":"...","reason":"..."}],"create":[{"name":"...","role":"...","instructions":"...","skillIds":["..."],"reason":"..."}],"tasks":[{"agent":"...","task":"..."}]}

Example:
{"reply":"Ana can draft the post. No one edits copy, so I suggest a Copy Editor.","add":[],"create":[{"name":"Copy Editor","role":"Editor","instructions":"You edit drafts for clarity, tone and correctness. Return the edited text.","skillIds":["technical-writing"],"reason":"The team has no editor."}],"tasks":[{"agent":"agt_1a2b3c4d","task":"Draft a 500-word launch post for the new release."},{"agent":"Copy Editor","task":"Edit the launch post draft for clarity and tone."}]}`

function plannerSystem(lead: Agent): string {
  const own = clipText(lead.instructions.trim(), LEAD_INSTRUCTIONS_MAX)
  return [
    `You are ${lead.name}, the team lead of this project in AgentControl. Your agent id is ${lead.id}.`,
    own ? `Your own instructions:\n${own}` : '',
    PLANNER_RULES,
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

function chatLine(store: WorkspaceStore, m: ProjectMessage): string {
  const name = (id: string): string => store.agents.find((a) => a.id === id)?.name ?? 'A removed agent'
  const author = m.author === 'user' ? 'User' : name(m.author)
  const label =
    m.kind === 'team-plan'
      ? ' (plan)'
      : m.kind === 'team-update'
        ? ' (team update)'
        : m.kind === 'task-assignment'
          ? ` (task for ${m.assigneeId ? name(m.assigneeId) : 'someone'})`
          : m.kind === 'task-result'
            ? ' (task result)'
            : ''
  return `- ${author}${label}: ${clipText(oneLine(m.text), CHAT_MESSAGE_MAX)}`
}

function section(title: string, lines: string[], empty: string): string {
  return `${title}:\n${lines.length > 0 ? lines.join('\n') : empty}`
}

export interface PlannerRequest {
  messages: ChatMessage[]
  maxTokens: number
}

/**
 * The planning request for `prompt` (a user message in this project), fitted
 * to `contextWindow`: chat, then skills, then library agents, then the team
 * are trimmed until prompt + reply reserve fit. 413 when even the fixed part
 * (assembler prompt, project, user prompt) does not.
 */
export function buildPlannerRequest(
  store: WorkspaceStore,
  project: Project,
  lead: Agent,
  prompt: ProjectMessage,
  contextWindow: number,
): PlannerRequest {
  const system = plannerSystem(lead)
  const team = teamMembers(store, project)
  const teamIds = new Set(team.map((a) => a.id))

  const teamLines = team.slice(0, ROSTER_TEAM_MAX).map((a) => agentLine(store, a))
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
  const at = thread.findIndex((m) => m.id === prompt.id)
  const earlier = at === -1 ? thread.filter((m) => m.id !== prompt.id) : thread.slice(0, at)
  const chatLines = earlier.slice(-CHAT_MESSAGES_MAX).map((m) => chatLine(store, m))

  const header = [
    `Project: ${oneLine(project.name)}`,
    `Description: ${clipText(project.desc.trim(), PROJECT_DESC_MAX) || 'none'}`,
  ].join('\n')
  const render = (): string =>
    [
      header,
      section(`Team (${team.length})`, teamLines, 'No one yet.'),
      section('Library agents that could join', libraryLines, 'None.'),
      section('Library skills for new specialists (id: name — description)', skillLines, 'None.'),
      section('Recent project chat (oldest first)', chatLines, 'No earlier messages.'),
      `The user's prompt:\n${prompt.text}`,
    ].join('\n\n')

  const reserve = Math.min(PLAN_REPLY_RESERVE_MAX, Math.floor(contextWindow / 3))
  let user = render()
  let estimated = estimateTokens(system.length + user.length)
  // Bounded by the number of roster and chat lines (at most 132).
  while (estimated + reserve > contextWindow) {
    if (chatLines.length > 0) chatLines.shift()
    else if (skillLines.length > 0) skillLines.pop()
    else if (libraryLines.length > 0) libraryLines.pop()
    else if (teamLines.length > 0) teamLines.pop()
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
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
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
function rawList(raw: Record<string, unknown>, key: string, warn: (w: string) => void): unknown[] {
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

/**
 * Validate Primary's parsed answer against the store: every agent and skill
 * reference must resolve, limits hold, and nothing outside the TeamPlan
 * fields survives. Each dropped entry becomes a plain-language warning.
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
    const e = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {}
    const ref = typeof entry === 'string' ? entry.trim() : firstString(e.agentId, e.id, e.name)
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
    else add.push({ agentId: agent.id, reason: clipText(str(e.reason).trim(), REASON_MAX) })
  }
  overflow(MAX_ADD, addExtra, 'agents to add')

  // create: new names only; skills resolved by id or name.
  const create: TeamPlanCreate[] = []
  const createEntries = rawList(raw, 'create', warn)
  let createExtra = Math.max(0, createEntries.length - RAW_ENTRIES_MAX)
  for (const entry of createEntries.slice(0, RAW_ENTRIES_MAX)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      warn('Skipped a new specialist that was not described as an object.')
      continue
    }
    const e = entry as Record<string, unknown>
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
    if (store.agents.some((a) => norm(a.name) === norm(name))) {
      warn(`Skipped creating ${quote(name)}: an agent with that name already exists.`)
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
    const skillRefs = Array.isArray(e.skillIds) ? e.skillIds : []
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
  const resolveAssignee = (ref: string): string | undefined => {
    const byId = [lead, ...team, ...added].find((a) => a.id === ref)
    if (byId) return byId.id
    const byName = [lead, ...team, ...added].find((a) => norm(a.name) === norm(ref))
    if (byName) return byName.id
    return create.find((c) => norm(c.name) === norm(ref))?.name
  }
  const tasks: TeamPlanTask[] = []
  const taskEntries = rawList(raw, 'tasks', warn)
  let taskExtra = Math.max(0, taskEntries.length - RAW_ENTRIES_MAX)
  for (const entry of taskEntries.slice(0, RAW_ENTRIES_MAX)) {
    const e = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {}
    const text = str(e.task).trim()
    const ref = firstString(e.agent, e.agentId)
    if (!text) {
      warn('Skipped a task with no text.')
      continue
    }
    const assignee = ref ? resolveAssignee(ref) : undefined
    if (!assignee) {
      warn(
        ref
          ? `Skipped the task ${quote(text)}: ${quote(ref)} is not on the team, in this plan, or the team lead.`
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

  const kept = warnings.length > MAX_WARNINGS ? [...warnings.slice(0, MAX_WARNINGS - 1), `…and ${warnings.length - MAX_WARNINGS + 1} more.`] : warnings
  return { reply, add, create, tasks, warnings: kept }
}

// ---------------------------------------------------------------------------
// Routes (app.ts registers them; these hold the logic)

/** Plans being computed: "<projectId>/<messageId>" per store. */
const planning = new WeakMap<WorkspaceStore, Set<string>>()

/**
 * POST /api/projects/:id/team-plan. Asks Primary, validates the answer and
 * records the 'team-plan' message. A plan with no team changes applies at
 * once (its tasks queue); otherwise it waits for apply or cancel. Nothing is
 * written when Primary's call fails or its answer is not a plan (502).
 */
export async function requestTeamPlan(
  store: WorkspaceStore,
  runner: TaskRunner,
  projectId: string,
  body: unknown,
): Promise<TeamPlanResponse> {
  projectOrFail(store, projectId)
  const raw = (body ?? {}) as Record<string, unknown>
  const messageId = typeof raw.messageId === 'string' ? raw.messageId.trim() : ''
  if (!messageId) fail(400, 'Send {"messageId": "<id>"}: the user message Primary should answer.')
  const prompt = findMessage(store, projectId, messageId)
  if (!prompt || prompt.kind !== 'message' || prompt.author !== 'user') {
    fail(400, `No user message with id "${messageId.slice(0, 100)}" in this project.`)
  }
  const lead = store.agents.find((a) => a.isPrimary)
  if (!lead) fail(409, 'Create the Team Lead first: Primary plans the team and its tasks.')
  const existing = store.projectMessages.find(
    (m) =>
      m.projectId === projectId &&
      m.kind === 'team-plan' &&
      m.replyTo === messageId &&
      (m.planStatus === 'pending' || m.planStatus === 'applied'),
  )
  if (existing) {
    fail(
      409,
      existing.planStatus === 'pending'
        ? 'Primary already proposed a plan for this message. Apply or cancel it first.'
        : 'Primary already answered this message and its plan was applied.',
    )
  }
  const key = `${projectId}/${messageId}`
  const inFlight = planning.get(store) ?? new Set<string>()
  planning.set(store, inFlight)
  if (inFlight.has(key)) fail(409, 'Primary is already answering this message.')

  const endpoint = store.endpoints.find((e) => e.id === lead.endpointId)
  if (!endpoint) fail(400, `Agent "${lead.name}" has no valid endpoint. Pick one in its settings.`)
  const request = buildPlannerRequest(store, projectOrFail(store, projectId), lead, prompt, endpoint.contextWindow)

  inFlight.add(key)
  let content: string
  let finishReason: string | undefined
  try {
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
    content = result.content
    finishReason = result.finishReason
  } finally {
    inFlight.delete(key)
  }

  // The store may have changed during the call: re-check before writing.
  const project = projectOrFail(store, projectId)
  if (!findMessage(store, projectId, messageId)) fail(400, 'The message was removed while Primary was answering.')
  const parsed = parsePlanJson(content)
  if (!parsed || !PLAN_KEYS.some((k) => k in parsed)) {
    const excerpt = clipText(oneLine(content), 160)
    fail(
      502,
      finishReason === 'length'
        ? `${lead.name}'s answer was cut off before the plan was complete. Nothing was changed; try a shorter request.`
        : `${lead.name}'s answer was not a valid team plan (one JSON object with reply, add, create and tasks). ` +
            `Nothing was changed; try again.${excerpt ? ` It began: "${excerpt}"` : ''}`,
    )
  }
  const plan = validateTeamPlan(parsed, store, project, lead)

  // D-P1 gates team changes only: a tasks-only plan applies right away.
  const immediate = plan.add.length === 0 && plan.create.length === 0
  const clock = messageClock(store, projectId)
  const planMessage: ProjectMessage = {
    id: uid('msg'),
    projectId,
    author: lead.id,
    text: plan.reply || planSummary(plan),
    kind: 'team-plan',
    createdAt: clock(),
    replyTo: messageId,
    plan,
    planStatus: immediate ? 'applied' : 'pending',
  }
  const assignments = immediate
    ? assignmentMessages(
        projectId,
        planMessage.id,
        lead.id,
        plan.tasks.map((t) => ({ assigneeId: t.agent, task: t.task })),
        clock,
      )
    : []
  const previous = store.projectMessages
  store.projectMessages = [...previous, planMessage, ...assignments]
  if (!store.save()) {
    store.projectMessages = previous
    fail(500, 'The plan could not be saved. Please retry.')
  }
  if (assignments.length > 0) runner.kick(projectId)
  return { project, messages: [planMessage, ...assignments] }
}

function planOrFail(store: WorkspaceStore, projectId: string, messageId: string): ProjectMessage & { plan: TeamPlan } {
  const message = findMessage(store, projectId, messageId)
  if (!message || message.kind !== 'team-plan' || !message.plan) {
    fail(404, `No team plan with id "${messageId.slice(0, 100)}" in this project.`)
  }
  return message as ProjectMessage & { plan: TeamPlan }
}

function assertPending(message: ProjectMessage): void {
  if (message.planStatus !== 'pending') {
    fail(409, `This plan is ${message.planStatus ?? 'not pending'}; only a pending plan can be applied or cancelled.`)
  }
}

/** Indexes (or ids) the apply body accepts; an omitted list accepts all. */
function parseSelection(body: unknown, plan: TeamPlan): { add: Set<string>; create: Set<number>; tasks: Set<number> } {
  if (body !== undefined && (body === null || typeof body !== 'object' || Array.isArray(body))) {
    fail(400, 'Send a JSON object, e.g. {"add": ["agt_…"], "create": [0], "tasks": [0, 1]}.')
  }
  const raw = (body ?? {}) as Record<string, unknown>
  const indexes = (key: 'create' | 'tasks', length: number): Set<number> => {
    const value = raw[key]
    if (value === undefined) return new Set(Array.from({ length }, (_, i) => i))
    if (!Array.isArray(value) || value.length > 100) fail(400, `"${key}" must be a list of indexes into the plan.`)
    for (const i of value) {
      if (typeof i !== 'number' || !Number.isInteger(i) || i < 0 || i >= length) {
        fail(400, `"${key}" lists ${JSON.stringify(i)}, which is not an index into this plan's ${key}.`)
      }
    }
    return new Set(value as number[])
  }
  let add: Set<string>
  if (raw.add === undefined) add = new Set(plan.add.map((a) => a.agentId))
  else {
    if (!Array.isArray(raw.add) || raw.add.length > 100) fail(400, '"add" must be a list of agent ids from the plan.')
    for (const id of raw.add) {
      if (typeof id !== 'string' || !plan.add.some((a) => a.agentId === id)) {
        fail(400, `"add" lists ${JSON.stringify(id).slice(0, 100)}, which this plan does not propose.`)
      }
    }
    add = new Set(raw.add as string[])
  }
  return { add, create: indexes('create', plan.create.length), tasks: indexes('tasks', plan.tasks.length) }
}

/**
 * POST /api/projects/:id/plans/:messageId/apply. Creates the accepted
 * specialists (library agents tagged with the project, on Primary's
 * endpoint/model/temperature), adds accepted and created agents to the team,
 * records a 'team-update' and one 'task-assignment' per accepted task, and
 * starts the task runner. Tasks whose agent did not join are dropped.
 */
export function applyTeamPlan(
  store: WorkspaceStore,
  runner: TaskRunner,
  projectId: string,
  messageId: string,
  body: unknown,
): TeamPlanResponse {
  const project = projectOrFail(store, projectId)
  const message = planOrFail(store, projectId, messageId)
  assertPending(message)
  const plan = message.plan
  const selection = parseSelection(body, plan)
  const lead = store.agents.find((a) => a.isPrimary)
  if (!lead) fail(409, 'Create the Team Lead first: new specialists use its endpoint and model.')

  // Accepted creations must still have unique names; check before any write.
  const accepted = plan.create.filter((_, i) => selection.create.has(i))
  for (const c of accepted) {
    if (store.agents.some((a) => norm(a.name) === norm(c.name))) {
      fail(409, `An agent named "${c.name}" exists now. Untick it, or cancel and ask Primary again.`)
    }
  }

  const now = new Date().toISOString()
  const notes: string[] = []
  const created: Agent[] = accepted.map((c) => ({
    id: uid('agt'),
    name: c.name,
    description: c.reason || `Specialist for ${project.name}.`,
    instructions: c.instructions,
    modelId: lead.modelId,
    endpointId: lead.endpointId,
    isPrimary: false,
    role: c.role,
    ...(lead.temperature !== undefined ? { temperature: lead.temperature } : {}),
    skillIds: c.skillIds.filter((id) => store.skills.some((s) => s.id === id)),
    status: 'idle',
    createdAt: now,
    lastRunAt: null,
    runCount: 0,
    projectId: project.id,
  }))

  const joined: Agent[] = []
  for (const a of plan.add) {
    if (!selection.add.has(a.agentId)) continue
    const agent = store.agents.find((x) => x.id === a.agentId)
    if (!agent) notes.push(`Skipped an agent that is no longer in the library.`)
    else if (!project.teamAgentIds.includes(agent.id)) joined.push(agent)
  }
  const teamAgentIds = [...project.teamAgentIds, ...joined.map((a) => a.id), ...created.map((a) => a.id)]

  // Tasks go to the lead, the plan's author, or someone on the new team.
  const assigneeFor = (ref: string): string | undefined => {
    const i = accepted.findIndex((c) => norm(c.name) === norm(ref))
    if (i !== -1) return created[i]?.id
    if (ref === lead.id || ref === message.author) return store.agents.some((a) => a.id === ref) ? ref : undefined
    return teamAgentIds.includes(ref) && store.agents.some((a) => a.id === ref) ? ref : undefined
  }
  const tasks: { assigneeId: string; task: string }[] = []
  let dropped = 0
  plan.tasks.forEach((t, i) => {
    if (!selection.tasks.has(i)) return
    const assigneeId = assigneeFor(t.agent)
    if (assigneeId) tasks.push({ assigneeId, task: t.task })
    else dropped += 1
  })

  const lines: string[] = []
  if (joined.length > 0) lines.push(`Added ${joined.map((a) => a.name).join(', ')} to the team.`)
  if (created.length > 0) {
    lines.push(`Created ${created.map((a) => (a.role ? `${a.name} (${a.role})` : a.name)).join(', ')} for this project.`)
  }
  if (lines.length === 0) lines.push('No team changes.')
  lines.push(...notes)
  if (dropped > 0) lines.push(`Skipped ${count(dropped, 'task', 'tasks')} whose agent is not on the team.`)
  if (tasks.length > 0) lines.push(`Assigned ${count(tasks.length, 'task', 'tasks')}.`)

  const clock = messageClock(store, projectId)
  const appliedPlan: ProjectMessage = { ...message, planStatus: 'applied', updatedAt: now }
  const update: ProjectMessage = {
    id: uid('msg'),
    projectId,
    author: lead.id,
    text: lines.join(' '),
    kind: 'team-update',
    createdAt: clock(),
    planId: message.id,
  }
  const assignments = assignmentMessages(projectId, message.id, lead.id, tasks, clock)
  const teamChanged = joined.length > 0 || created.length > 0
  const nextProject: Project = teamChanged ? { ...project, teamAgentIds, updatedAt: now } : project

  const previous = { agents: store.agents, projects: store.projects, messages: store.projectMessages }
  store.agents = [...created, ...store.agents]
  store.projects = store.projects.map((p) => (p.id === projectId ? nextProject : p))
  store.projectMessages = [
    ...store.projectMessages.map((m) => (m.id === message.id ? appliedPlan : m)),
    update,
    ...assignments,
  ]
  if (!store.save()) {
    store.agents = previous.agents
    store.projects = previous.projects
    store.projectMessages = previous.messages
    fail(500, 'The plan could not be applied in storage. Please retry.')
  }
  if (assignments.length > 0) runner.kick(projectId)
  return { project: nextProject, messages: [appliedPlan, update, ...assignments] }
}

/** POST /api/projects/:id/plans/:messageId/cancel. */
export function cancelTeamPlan(store: WorkspaceStore, projectId: string, messageId: string): TeamPlanResponse {
  const project = projectOrFail(store, projectId)
  const message = planOrFail(store, projectId, messageId)
  assertPending(message)
  const cancelled: ProjectMessage = { ...message, planStatus: 'cancelled', updatedAt: new Date().toISOString() }
  const previous = store.projectMessages
  replaceMessage(store, cancelled)
  if (!store.save()) {
    store.projectMessages = previous
    fail(500, 'The plan could not be cancelled in storage. Please retry.')
  }
  return { project, messages: [cancelled] }
}

/** POST /api/projects/:id/tasks/:messageId/retry: re-queue a failed task. */
export function retryTask(
  store: WorkspaceStore,
  runner: TaskRunner,
  projectId: string,
  messageId: string,
): TeamPlanResponse {
  const project = projectOrFail(store, projectId)
  const task = findMessage(store, projectId, messageId)
  if (!task || task.kind !== 'task-assignment') fail(404, `No task with id "${messageId.slice(0, 100)}" in this project.`)
  if (task.taskStatus !== 'failed') fail(409, `Only a failed task can be retried; this one is ${task.taskStatus ?? 'unknown'}.`)
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

// ---------------------------------------------------------------------------
// Task runner

export interface TaskRunner {
  /** Run the project's queued tasks (no-op when a drain is already waiting to start). */
  kick(projectId: string): void
  /** Resolves once the project has no drain running or waiting. */
  whenIdle(projectId: string): Promise<void>
  /** True while a drain for the project is running or waiting. */
  busy(projectId: string): boolean
  /** Start no further tasks for the project (it was deleted); the one in flight finishes. */
  stop(projectId: string): void
  /** Start no further tasks anywhere and wait for the ones in flight. */
  close(): Promise<void>
}

interface Lane {
  tail: Promise<void>
  waiting: boolean
  stopped: boolean
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

/** What the assignee is asked: the project, the user's prompt, the task, the team. */
function buildTaskInput(store: WorkspaceStore, project: Project, task: ProjectMessage, assignee: Agent): string {
  const plan = task.planId ? findMessage(store, project.id, task.planId) : undefined
  const prompt = plan?.replyTo ? findMessage(store, project.id, plan.replyTo) : undefined
  const lead = store.agents.find((a) => a.id === task.author) ?? store.agents.find((a) => a.isPrimary)
  const teammates = teamMembers(store, project)
    .filter((a) => a.id !== assignee.id)
    .slice(0, TASK_TEAMMATES_MAX)
  const desc = clipText(project.desc.trim(), PROJECT_DESC_MAX)
  return [
    `Project: ${project.name}${desc ? `\n${desc}` : ''}`,
    prompt ? `The user asked:\n${clipText(prompt.text.trim(), TASK_PROMPT_MAX)}` : '',
    lead && lead.id === assignee.id
      ? `As the team lead, you took this task:\n${task.text}`
      : `${lead?.name ?? 'The team lead'} assigned you this task:\n${task.text}`,
    teammates.length > 0
      ? `Your teammates:\n${teammates.map((a) => `- ${a.name}${a.role ? ` (${a.role})` : ''}`).join('\n')}`
      : '',
    'Reply with your result for the team.',
  ]
    .filter(Boolean)
    .join('\n\n')
}

/**
 * Fail every queued or running task (with a 'task-result' saying why) so the
 * user can retry it. Used at startup: tasks a previous process left behind
 * never finish on their own. Projects `busy` reports are skipped.
 */
export function failInterruptedTasks(store: WorkspaceStore, busy: (projectId: string) => boolean = () => false): number {
  const stale = store.projectMessages.filter(
    (m) =>
      m.kind === 'task-assignment' &&
      (m.taskStatus === 'queued' || m.taskStatus === 'running') &&
      !busy(m.projectId) &&
      store.projects.some((p) => p.id === m.projectId),
  )
  if (stale.length === 0) return 0
  const now = new Date().toISOString()
  const failedIds = new Set(stale.map((m) => m.id))
  const clocks = new Map<string, () => string>()
  const results: ProjectMessage[] = stale.map((m) => {
    const clock = clocks.get(m.projectId) ?? messageClock(store, m.projectId)
    clocks.set(m.projectId, clock)
    return {
      id: uid('msg'),
      projectId: m.projectId,
      author: m.assigneeId ?? m.author,
      text: 'Could not finish: interrupted by a restart. Retry the task to run it again.',
      kind: 'task-result',
      createdAt: clock(),
      taskId: m.id,
      taskStatus: 'failed',
      ...(m.planId ? { planId: m.planId } : {}),
    }
  })
  store.projectMessages = [
    ...store.projectMessages.map((m) => (failedIds.has(m.id) ? { ...m, taskStatus: 'failed' as const, updatedAt: now } : m)),
    ...results,
  ]
  store.save()
  return stale.length
}

/**
 * Per-project task queues: each project runs its queued tasks one at a time,
 * oldest queue time first; different projects run concurrently. Creating a
 * runner first fails tasks a previous process left queued or running.
 */
export function createTaskRunner(store: WorkspaceStore, log: (err: unknown) => void = console.error): TaskRunner {
  const previous = runners.get(store)
  failInterruptedTasks(store, (projectId) => previous?.busy(projectId) ?? false)

  const lanes = new Map<string, Lane>()
  let closed = false

  async function runTask(projectId: string, taskId: string): Promise<void> {
    const project = store.projects.find((p) => p.id === projectId)
    const task = findMessage(store, projectId, taskId)
    if (!project || !task || task.taskStatus !== 'queued') return
    replaceMessage(store, { ...task, taskStatus: 'running', updatedAt: new Date().toISOString() })
    store.save()

    const assignee = store.agents.find((a) => a.id === task.assigneeId)
    let text: string
    let ok = false
    let runId: string | undefined
    if (!assignee) {
      text = 'Could not finish: the assigned agent is no longer in the library.'
    } else {
      try {
        const run = await runAgent(store, assignee, buildTaskInput(store, project, task, assignee), { projectId })
        runId = run.id
        ok = run.status === 'succeeded'
        text = ok
          ? clipText(run.output.trim(), RESULT_TEXT_MAX) || '(The agent replied with no text.)'
          : `Could not finish: ${run.error ?? 'the run failed.'}`
      } catch (err) {
        text = `Could not finish: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    // The project (and its chat) may have been deleted while the run was in flight.
    const current = findMessage(store, projectId, taskId)
    if (!current || !store.projects.some((p) => p.id === projectId)) return
    const result: ProjectMessage = {
      id: uid('msg'),
      projectId,
      author: task.assigneeId ?? task.author,
      text: clipText(text, RESULT_TEXT_MAX),
      kind: 'task-result',
      createdAt: messageClock(store, projectId)(),
      taskId,
      taskStatus: ok ? 'done' : 'failed',
      ...(runId ? { runId } : {}),
      ...(task.planId ? { planId: task.planId } : {}),
    }
    store.projectMessages = [
      ...store.projectMessages.map((m) =>
        m.id === taskId ? { ...current, taskStatus: ok ? ('done' as const) : ('failed' as const), updatedAt: new Date().toISOString() } : m,
      ),
      result,
    ]
    store.save()
  }

  async function drain(projectId: string, lane: Lane): Promise<void> {
    for (let i = 0; i < TASKS_PER_DRAIN; i++) {
      if (closed || lane.stopped || !store.projects.some((p) => p.id === projectId)) return
      const next = nextQueuedTask(store, projectId)
      if (!next) return
      await runTask(projectId, next.id)
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
      if (lane) lane.stopped = true
    },
    async close() {
      closed = true
      await Promise.all([...lanes.values()].map((l) => l.tail))
    },
  }
  runners.set(store, runner)
  return runner
}
