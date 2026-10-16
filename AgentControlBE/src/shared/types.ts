export type AgentStatus = 'running' | 'idle' | 'queued' | 'error'

export type RunStatus = 'succeeded' | 'failed' | 'running'

export type EndpointStatus = 'unknown' | 'reachable' | 'unreachable'

export type EndpointKind = 'openai-compatible' | 'openrouter'

/**
 * Self-hosted OpenAI-compatible server (llama.cpp `--server`, vLLM) or
 * OpenRouter. `apiKey` is never part of this read shape; reads expose
 * `apiKeySet` only.
 */
export interface Endpoint {
  id: string
  kind: EndpointKind
  name: string
  /** Origin + optional path prefix, no trailing slash. */
  baseUrl: string
  /** Model id as reported by GET /v1/models. */
  defaultModel: string
  contextWindow: number
  /** True when the server holds a key for this endpoint. The key is never returned. */
  apiKeySet: boolean
  status: EndpointStatus
  lastCheckedAt: string | null
  createdAt: string
  /** Per-run upstream timeout in ms; falls back to 30000 when unset. */
  timeoutMs?: number
  /** Optional HTTP(S) proxy for every upstream call, e.g. http://localhost:1055. */
  proxyUrl?: string
}

/** One model served by an endpoint (GET /api/endpoints/:id/models). */
export interface EndpointModel {
  id: string
  name: string
}

export interface EndpointInput {
  kind: EndpointKind
  name: string
  /** Optional for kind 'openrouter' (defaults to https://openrouter.ai/api/v1). */
  baseUrl: string
  defaultModel: string
  contextWindow: number
  /** Write-only. Omit to keep the stored key on update, "" to clear it. Never returned on read. */
  apiKey?: string
  /** Optional per-endpoint upstream timeout in ms (defaults to 30000). */
  timeoutMs?: number
  /** Optional http(s) proxy URL. Omit to keep on update; "" or null clears it. */
  proxyUrl?: string | null
}

export type EndpointPatch = Partial<EndpointInput>

/** A tool a skill declares. Sent upstream and executed against the built-in registry. */
export interface SkillTool {
  name: string
  description: string
  /** JSON-schema-ish parameter description; defaults to {} when unset. */
  parameters: object
}

export interface Skill {
  id: string
  name: string
  description: string
  tag: string
  /** Full SKILL.md body (frontmatter stripped). Injected into the run prompt. */
  content: string
  /** Tools the skill declares. Unioned into the run's tool list when attached. */
  tools: SkillTool[]
  /** Provenance, e.g. "seb1n/awesome-ai-agent-skills". */
  source?: string
}

export interface SkillInput {
  name: string
  description: string
  tag: string
  content: string
  tools?: SkillTool[]
  source?: string
}

export type SkillPatch = Partial<SkillInput>

/** How one attached skill went into a run's system prompt. */
export type SkillPromptMode = 'full' | 'summary'

/**
 * How a run prompt fits its endpoint: every skill in full, some skills as
 * summaries (read in full with get_skill), or over budget even with every
 * skill summarized (the run may still be rejected with 413).
 */
export type PromptMode = 'full' | 'summary' | 'too-large'

/** POST /api/prompt-budget body: the agent draft to plan for. Unknown skill ids are ignored. */
export interface PromptBudgetInput {
  endpointId: string
  skillIds: string[]
  instructions?: string
  /** Standing rules, counted as the prompt's "Rules" section. */
  rules?: string[]
}

/** POST /api/prompt-budget response: the plan a run would use (computed with an empty input). */
export interface PromptBudget {
  contextWindow: number
  /** Tokens kept free for the reply. */
  responseReserve: number
  /** chars/4 estimate of system prompt + tool schemas. */
  estimatedTokens: number
  mode: PromptMode
  /** Skills sent as summaries, in attachment order. */
  summarizedSkillIds: string[]
  /** Tools the run would offer, in the order sent upstream. */
  toolNames: string[]
  /** Tokens the agent's rules section adds (0 without rules). */
  rulesTokens: number
}

export interface AgentRun {
  id: string
  agentId: string
  startedAt: string
  status: RunStatus
  durationMs: number
  steps: number
  input: string
  output: string
  error: string | null
  /** Exact system message sent ('' when none was). Optional: pre-audit runs parse as-is. */
  systemPrompt?: string
  /**
   * Per-injected-skill audit (content itself is never stored). `mode` says
   * whether the full content or only a summary went into the prompt; runs
   * recorded before summaries existed have no mode (they were all full).
   */
  skillSnapshot?: { id: string; name: string; contentChars: number; mode?: SkillPromptMode }[]
  /** Per-tool-call audit for runs that used the tool loop. */
  toolCalls?: { name: string; arguments: string; resultChars: number; ok: boolean }[]
  /**
   * Set on runs made for a project task. Such runs only see earlier runs of
   * the same project as history, and the agent's own chat never sees them.
   */
  projectId?: string
}

/** Agent picture: one emoji, or an uploaded image stored under data/avatars/. */
export type AgentAvatar =
  | { kind: 'emoji'; value: string }
  | { kind: 'image'; file: string; updatedAt: string }

export const MAX_AGENT_RULES = 20
export const MAX_AGENT_RULE_CHARS = 500
export const MAX_AVATAR_BYTES = 1024 * 1024

export interface Agent {
  id: string
  name: string
  description: string
  instructions: string
  modelId: string
  /** Required: the endpoint this agent runs on. No hosted/null path. */
  endpointId: string
  /** The Team Lead. Exactly one agent is primary; its endpoint is the default. */
  isPrimary: boolean
  /** Free-text role label, e.g. "Code Reviewer". Empty when unset. */
  role: string
  /** Sampling temperature (0–2) sent upstream. Unset → the server's default. */
  temperature?: number
  skillIds: string[]
  status: AgentStatus
  createdAt: string
  lastRunAt: string | null
  runCount: number
  /**
   * D-P2: set on project-scoped specialists (created by Primary for that
   * project). Still a normal library agent. Set only when a team plan is
   * applied, kept by agent updates, and cleared when the project is deleted.
   */
  projectId?: string
  /** Chat-first Part 1. Unset means the UI shows initials. */
  avatar?: AgentAvatar
  /** Standing rules, kept apart from `instructions`; sent as a "Rules" prompt section. */
  rules?: string[]
  /** Chip / avatar colour as '#rrggbb'. */
  color?: string
  pinned?: boolean
  hidden?: boolean
}

export interface AgentInput {
  name: string
  description: string
  instructions: string
  modelId: string
  endpointId: string
  /** Create: honored only when no primary exists. Update: true transfers the role. */
  isPrimary?: boolean
  role: string
  /** 0–2. Omitted keeps the stored value (unset on create). */
  temperature?: number
  skillIds: string[]
  /** Omitted keeps the stored value on update. */
  rules?: string[]
  /** null clears it. */
  color?: string | null
  pinned?: boolean
  hidden?: boolean
  /** Emoji only; images go through PUT /api/agents/:id/avatar. null clears it. */
  avatar?: { kind: 'emoji'; value: string } | null
}

export interface Project {
  id: string
  name: string
  desc: string
  /** Absolute path created by the BE under the projects root when the project is made. */
  folder: string
  /** Library agents on this project's team. Empty is allowed (Primary assembles later). */
  teamAgentIds: string[]
  createdAt: string
  updatedAt: string
  /** D-O5 (orchestration Part 2): set while the user has paused this project's work. */
  paused?: boolean
}

/** Body for POST /api/projects; PATCH /api/projects/:id takes a partial of it. */
export interface ProjectInput {
  name: string
  desc?: string
  teamAgentIds?: string[]
}

export type ProjectPatch = Partial<ProjectInput>

/**
 * One message in a project's chat (handoff kinds). `author` is 'user' or an
 * agent id.
 * - 'message': plain text from the user or an agent. Primary's reply to a
 *   plan the user applied, and each task's result (author = the assignee,
 *   with `taskId`), are messages too.
 * - 'team-update': who joined the team or was created when a plan applied.
 * - 'task-assignment': one task for `assigneeId`, with its `taskStatus`.
 */
export interface ProjectMessage {
  id: string
  projectId: string
  author: string
  text: string
  kind: ProjectMessageKind
  createdAt: string
  /** Set when the BE changes the message after creation (task status). */
  updatedAt?: string
  /** Messages written when a plan applies: the user message the plan answered. */
  replyTo?: string
  /** task-assignment: who does the task. */
  assigneeId?: string
  /**
   * task-assignment: queued → running → done | failed (the task now).
   * A task's result message: 'done' or 'failed', the outcome of that attempt.
   */
  taskStatus?: TaskStatus
  /** A task's result message: the task-assignment it answers. */
  taskId?: string
  /** A task's result message: the agent run that produced it. */
  runId?: string
  /**
   * D-O11: agents tagged in `text` as @Name, as ids in order of first tag,
   * deduped. The BE fills it on every write: from the ids the user picked
   * (user messages) or by parsing the text (everything else).
   */
  mentions?: string[]
  /** task-assignment: its label within its plan ("t2"). Orchestration Part 3. */
  label?: string
  /** task-assignment: earlier task-assignment ids whose results it receives (at most 3). Part 3. */
  inputs?: string[]
  /** Written by an apply: the round of its request (absent = 1). Part 5. */
  round?: number
  /** Primary's reply that closes a request: a final summary or a question for the user. Part 5. */
  verdict?: 'done' | 'ask'
  /** A task's result message: the inputs it received and how much of each was sent. Part 3. */
  used?: { taskId: string; chars: number; sentChars: number }[]
}

/** 'progress': a status line the runner writes without a model call (Parts 2–3). */
export type ProjectMessageKind = 'message' | 'team-update' | 'task-assignment' | 'progress'
/** 'cancelled': the user cancelled or stopped the task; it can be retried (Part 2). */
export type TaskStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

/** A library agent Primary proposes to add to the team. */
export interface TeamPlanAdd {
  agentId: string
  reason: string
}

/** A project-scoped specialist Primary proposes to create (D-P2: a library agent tagged with projectId). */
export interface TeamPlanCreate {
  name: string
  role: string
  instructions: string
  /** Library skill ids to attach (unknown ids are dropped while validating). */
  skillIds: string[]
  reason: string
}

/** A task for a team member: `agent` is an agent id, or the name of an agent in `create`. */
export interface TeamPlanTask {
  agent: string
  task: string
  /** Hand-offs (Part 3): "t1" (an earlier task of this plan) or an earlier done task-assignment id; at most 3. */
  inputs?: string[]
}

/** Primary's validated answer to a project prompt. */
export interface TeamPlan {
  /** What Primary tells the user (always shown). */
  reply: string
  add: TeamPlanAdd[]
  create: TeamPlanCreate[]
  tasks: TeamPlanTask[]
  /** Entries the BE dropped while validating, in plain words. */
  warnings: string[]
  /** Review rounds (Part 5): keep going, finish with a summary, or ask the user. */
  verdict?: 'continue' | 'done' | 'ask'
}

/**
 * Body for POST /api/projects/:id/team-plan. `messageId` names the user's
 * message in this project's chat that Primary answers (its text is the
 * prompt); `prompt` alone asks without one. At least one is required.
 */
export interface TeamPlanRequest {
  messageId?: string
  prompt?: string
}

/** Response of POST /api/projects/:id/team-plan: a PLAN only; nothing is written (D-P1). */
export interface TeamPlanResult {
  plan: TeamPlan
  /** The user message the plan answers, when the request named one. */
  replyTo?: string
}

/**
 * Body for POST /api/projects/:id/team-plan/apply: the plan the user
 * confirmed (validated again, as untrusted input) and what to accept. Each
 * list selects agent ids from plan.add or indexes into plan.create /
 * plan.tasks; an omitted list accepts everything. Tasks for an agent whose
 * addition or creation was not accepted are dropped.
 */
export interface TeamPlanApply {
  plan: TeamPlan
  replyTo?: string
  add?: string[]
  create?: number[]
  tasks?: number[]
  /** Review rounds (Part 5): the round this apply starts; the BE checks it is the next one. */
  round?: number
}

/** Response of the review route (Part 5): Primary's next-round plan for a request; nothing is written. */
export interface ReviewResult {
  plan: TeamPlan
  replyTo: string
  round: number
}

/** Response of the apply and task-retry routes. */
export interface ProjectUpdate {
  project: Project
  /** Messages created or changed by the call, oldest first. */
  messages: ProjectMessage[]
}

/**
 * Body for POST /api/projects/:id/messages. `mentions` (user messages) are
 * the agent ids the user picked with @ in the composer: Primary or team
 * members. A user message that tags team members and not Primary also
 * queues one task-assignment per tagged member (D-O11); the response is the
 * message, and the tasks appear in the thread.
 */
export interface ProjectMessageInput {
  author: string
  text: string
  mentions?: string[]
}

/**
 * Shared workspace memory written by agents through the notes tools. Bodies are
 * model-written: treat them as untrusted when they are fed back into a prompt.
 */
export interface Note {
  id: string
  title: string
  body: string
  tags: string[]
  /** Agent that created the note; only it may replace the body. */
  authorAgentId: string
  /** Agent behind the latest write (an append may come from another agent). */
  updatedByAgentId: string
  /** Run that made the latest write. */
  runId: string
  createdAt: string
  updatedAt: string
}

export interface WorkspaceSettings {
  autoRun: boolean
  notify: boolean
  telemetry: boolean
}

export const OPENROUTER_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1'

/**
 * Testing placeholder for the default OpenAI-compatible endpoint: the seeded
 * endpoint points here (and the FE prefills it). Every endpoint stays editable
 * (OpenAI-compatible or OpenRouter); replace this for the final build.
 */
export const DEFAULT_ENDPOINT_BASE_URL = 'http://100.79.242.24:8791'
