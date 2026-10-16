export type AgentStatus = 'running' | 'idle' | 'queued' | 'error'

export type RunStatus = 'succeeded' | 'failed' | 'running'

export type EndpointStatus = 'unknown' | 'reachable' | 'unreachable'

export type EndpointKind = 'openai-compatible' | 'openrouter'

/* ==========================================================================
   FROZEN API CONTRACT (FE is source of truth — BE implements this).
   --------------------------------------------------------------------------
   Endpoints (self-hosted llama.cpp --server / vLLM, or OpenRouter):
   - No global model catalog: model choice is per endpoint via
     `GET /api/endpoints/:id/models` (live, cached in endpointModels).
     OpenRouter access is an Endpoint with kind 'openrouter'.
   - `GET    /api/endpoints`              -> Endpoint[]
   - `POST   /api/endpoints`              (EndpointInput) -> Endpoint (201)
   - `PATCH  /api/endpoints/:id`          (Partial<EndpointInput>) -> Endpoint
   - `DELETE /api/endpoints/:id`          -> { ok, reassignedAgents } (its
     agents move to the Team Lead's endpoint, the workspace default)
   - `GET    /api/endpoints/:id/models`   -> { models: EndpointModel[] }
   - `POST   /api/endpoints/:id/test`     -> { ok, models: string[], latencyMs }
     Test and inference run server-side only (GET {baseUrl}/v1/models and
     POST {baseUrl}/v1/chat/completions with `{ model: modelId }`). The
     browser never calls baseUrl directly (CORS/LAN) and never sees apiKey.
   - `apiKey` is write-only: accepted on create/update, never returned on
     read. Reads expose `apiKeySet: boolean` only. On update: field omitted
     keeps the stored key, non-empty string replaces it, "" clears it.
     kind 'openrouter' requires an effective key (stored or provided);
     kind 'openai-compatible' sends it as `Authorization: Bearer` if set.
   - `Agent.endpointId` + `Agent.modelId` (DD-7): endpointId is REQUIRED —
      every agent runs on an endpoint; there is no hosted/null path. The
      Team Lead's (isPrimary agent's) endpoint is the default for new agents.
   - `POST   /api/agents/:id/runs`      (AgentRunInput { input }) -> AgentRun
     Synchronous run: 200 with status 'succeeded' | 'failed' ('failed' sets
     `error`; `output` empty). BE proxies the agent's endpoint
     (POST {baseUrl}/v1/chat/completions) server-side.
    - `GET    /api/agents/:id/runs`      -> AgentRun[] (newest first)
      Authoritative run history; replaces the legacy `Agent.recentRuns`
      field, which is removed from the Agent shape.
    --------------------------------------------------------------------------
    Skills (Skill Library):
    - `GET    /api/skills`               -> Skill[]
    - `GET    /api/skills/:id`           -> Skill
    - `POST   /api/skills`               (SkillInput) -> Skill (201)
    - `PATCH  /api/skills/:id`           (Partial<SkillInput>) -> Skill
    - `DELETE /api/skills/:id`           -> 204 (detaches from every agent
      in the same transaction; agents keep working without the skill)
    - `POST   /api/skills/import`        ({ markdown }) -> Skill (201)
      YAML frontmatter -> name + description, body -> content; id is the
      slugified name. 422 when the frontmatter is missing/incomplete,
      409 when the id already exists.
    - `POST   /api/prompt-budget`        (PromptBudgetInput) -> PromptBudget
      Additive: how an agent draft's instructions + skills fit its
      endpoint's context window (the plan a run would use). 400 on an
      unknown endpoint.
    --------------------------------------------------------------------------
   Canonical shapes (BE adopts these; FE does not rename):
   - Agent: { id, name, description (not `desc`), instructions, modelId,
      endpointId (required), skillIds, isPrimary (exactly one — the Team
      Lead), status (+ 'error'), createdAt, lastRunAt: string|null, runCount }
   - Skill: { id, name, description (not `desc`), tag: string } (`tag`
     accepts BE's 'Core'|'Sandbox'|'Integration' union).
   --------------------------------------------------------------------------
   Error codes (frozen):
   - 400 validation: bad kind/name/baseUrl/defaultModel/contextWindow/apiKey,
     empty/unknown agent modelId, empty agent name, missing or unknown agent
     endpointId.
   - 404 unknown id: agent, endpoint (incl. its /models and /test).
   - 409: deleting the Team Lead's own endpoint, deleting the Team Lead agent
      itself, or creating a second Team Lead (isPrimary). Deleting any other
      endpoint succeeds and moves its agents to the Team Lead's endpoint.
   ========================================================================== */
export type Endpoint = {
  id: string
  kind: EndpointKind
  name: string
  /** Origin + optional path prefix, no trailing slash. e.g. http://192.168.1.20:8080 */
  baseUrl: string
  /** Model id as reported by GET /v1/models, e.g. "llama-3-70b". */
  defaultModel: string
  contextWindow: number
  /** True when the server holds a key for this endpoint. The key itself is never returned. */
  apiKeySet: boolean
  status: EndpointStatus
  lastCheckedAt: string | null
  createdAt: string
}

/** One model served by an endpoint (GET /api/endpoints/:id/models). */
export type EndpointModel = {
  id: string
  name: string
}

/** A tool a skill declares. Sent upstream and executed against the BE's built-in registry. */
export type SkillTool = {
  name: string
  description: string
  /** JSON-schema-ish parameter description; defaults to {} when unset. */
  parameters: object
}

export type ToolInfo = SkillTool & {
  category: 'workspace' | 'notes' | 'time' | 'math' | 'text' | 'data'
  effect: 'read' | 'write'
}

export type Note = {
  id: string
  title: string
  body: string
  tags: string[]
  authorAgentId: string
  authorName: string | null
  updatedByAgentId: string
  runId: string
  createdAt: string
  updatedAt: string
}

export type NoteSummary = Omit<Note, 'body'> & { snippet: string; chars: number }

export type Skill = {
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

/** Body for POST /api/skills; PATCH /api/skills/:id takes a partial of it. */
export type SkillInput = {
  name: string
  description: string
  tag: string
  content: string
  tools?: SkillTool[]
  source?: string
}

export type EndpointInput = {
  kind: EndpointKind
  name: string
  /** Optional for kind 'openrouter' (defaults to https://openrouter.ai/api/v1). */
  baseUrl: string
  defaultModel: string
  contextWindow: number
  /** Write-only. Omit to keep the stored key on update, "" to clear it. Never returned on read. */
  apiKey?: string
}

export type AgentRun = {
  id: string
  startedAt: string
  status: RunStatus
  durationMs: number
  steps: number
  /** Set on 'failed' runs: runner/upstream error message. */
  error: string | null
  /** Assistant output; empty string when the run failed. */
  output: string
  /** Prompt the run received. */
  input: string
  /** Exact system message the run sent upstream; absent on pre-audit runs/BEs. */
  systemPrompt?: string
  /**
   * Skills injected into that prompt (content itself is never sent). `mode`
   * 'summary' means only a short summary went in (the agent reads the full
   * text with get_skill); absent on runs recorded before summaries existed.
   */
  skillSnapshot?: { id: string; name: string; contentChars: number; mode?: SkillPromptMode }[]
  /** Tool calls executed during the run; absent on pre-tool-execution runs/BEs. */
  toolCalls?: { name: string; arguments: string; resultChars: number; ok: boolean }[]
  /** Set on runs made for a project task; the agent's own chat leaves them out. */
  projectId?: string
}

/** How one attached skill went into a run's system prompt. */
export type SkillPromptMode = 'full' | 'summary'

/**
 * How a draft's prompt fits its endpoint: every skill in full, the largest
 * skills as summaries (read in full with get_skill), or over budget even then
 * (runs are rejected).
 */
export type PromptBudgetMode = 'full' | 'summary' | 'too-large'

/** Body for POST /api/prompt-budget. Unknown skill ids are ignored. */
export type PromptBudgetInput = {
  endpointId: string
  skillIds: string[]
  instructions?: string
  /** Chat-first Part 1: counted as the Rules prompt section (BE route accepts it). */
  rules?: string[]
}

/** POST /api/prompt-budget response: the plan a run would use, with an empty message. */
export type PromptBudget = {
  contextWindow: number
  /** Tokens kept free for the reply. */
  responseReserve: number
  /** chars/4 estimate of the system prompt + tool schemas. */
  estimatedTokens: number
  mode: PromptBudgetMode
  /** Skills sent as summaries, in attachment order. */
  summarizedSkillIds: string[]
  /** Tools a run would offer, in the order sent upstream. */
  toolNames: string[]
  /** Estimated tokens for the Rules section (header included); 0 when there are no rules. */
  rulesTokens?: number
}

/** Body for POST /api/agents/:id/runs. */
export type AgentRunInput = {
  input: string
  temperature?: number
}

/** Agent picture: one emoji, or an uploaded image stored under data/avatars/. (Mirrors BE shared/types.ts @ 5834fce.) */
export type AgentAvatar =
  | { kind: 'emoji'; value: string }
  | { kind: 'image'; file: string; updatedAt: string }

/* Limits mirrored from BE shared/types.ts (keep in sync). */
export const MAX_AGENT_RULES = 20
export const MAX_AGENT_RULE_CHARS = 500
export const MAX_AVATAR_BYTES = 1024 * 1024

/** Agent that runs in the workspace (the chat producer). */
export type Agent = {
  id: string
  name: string
  /** Free-text role label, e.g. "Code Reviewer". Empty when unset. */
  role: string
  description: string
  instructions: string
  modelId: string
  /** Required: the endpoint this agent runs on. No hosted/null path exists. */
  endpointId: string
  skillIds: string[]
  status: AgentStatus
  createdAt: string
  lastRunAt: string | null
  runCount: number
  /** True for exactly one agent — the Team Lead. Its endpoint is the default for new agents. */
  isPrimary: boolean
  /** Chat transcript for multi-turn context (BE serves it at GET /api/agents/:id/runs; not part of the Agent body). */
  runs?: AgentRun[]
  /** Sampling temperature (0–2). BE accepts it on create/update; older BEs ignore it. */
  temperature?: number
  /** D-P2: set on project-scoped specialists Primary created for that project. */
  projectId?: string
  /** Chat-first Part 1: emoji or uploaded image; absent -> initials. */
  avatar?: AgentAvatar
  /** Chat-first Part 1 (D-C2): standing rules, separate from `instructions` (persona). */
  rules?: string[]
  /** Chip / avatar colour as '#rrggbb'. */
  color?: string
  /** Chat-first: sidebar pinning / hiding (Part 2 uses these). */
  pinned?: boolean
  hidden?: boolean
}

/** Everything the create/edit form owns. */
export type AgentInput = {
  name: string
  role: string
  description: string
  instructions: string
  modelId: string
  /** Required: the endpoint this agent runs on. */
  endpointId: string
  temperature: number
  skillIds: string[]
  /** Bootstrap only: set true when creating the first (Team Lead) agent. */
  isPrimary?: boolean
  rules?: string[]
  /** '#rrggbb'; null clears it. */
  color?: string | null
  pinned?: boolean
  hidden?: boolean
  /** Emoji only; images go through PUT /api/agents/:id/avatar. null clears it. */
  avatar?: { kind: 'emoji'; value: string } | null
}

/** A project: a folder owned by AgentControl plus its team of library agents. */
export type Project = {
  id: string
  name: string
  desc: string
  /** Absolute path created by the BE under the projects root. */
  folder: string
  /** Library agents on this project's team. Empty is allowed. */
  teamAgentIds: string[]
  createdAt: string
  updatedAt: string
  /** D-O5 (orchestration Part 2): set while the user has paused this project's work. */
  paused?: boolean
}

/** Body for POST /api/projects/:id/messages. */
export type ProjectMessageInput = {
  author: string
  text: string
  /** D-O11: agent ids the user picked with @ (Primary or team members). Tagging only team members also queues one task each. */
  mentions?: string[]
}

/**
 * One message in a project's chat (handoff kinds). `author` is 'user' or an
 * agent id.
 * - 'message': plain text from the user or an agent. Primary's reply to a
 *   plan the user applied, and each task's result (author = the assignee,
 *   with `taskId`), are messages too.
 * - 'team-update': who joined the team or was created when a plan applied.
 * - 'task-assignment': one task for `assigneeId`, with its `taskStatus`.
 */
export type ProjectMessage = {
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
export type TeamPlanAdd = {
  agentId: string
  reason: string
}

/** A project-scoped specialist Primary proposes to create (D-P2: a library agent tagged with projectId). */
export type TeamPlanCreate = {
  name: string
  role: string
  instructions: string
  /** Library skill ids to attach (unknown ids are dropped while validating). */
  skillIds: string[]
  reason: string
}

/** A task for a team member: `agent` is an agent id, or the name of an agent in `create`. */
export type TeamPlanTask = {
  agent: string
  task: string
  /** Hand-offs (Part 3): "t1" (an earlier task of this plan) or an earlier done task-assignment id; at most 3. */
  inputs?: string[]
}

/** Primary's validated answer to a project prompt. */
export type TeamPlan = {
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
export type TeamPlanRequest = {
  messageId?: string
  prompt?: string
}

/** Response of POST /api/projects/:id/team-plan: a PLAN only; nothing is written (D-P1). */
export type TeamPlanResult = {
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
export type TeamPlanApply = {
  plan: TeamPlan
  replyTo?: string
  add?: string[]
  create?: number[]
  tasks?: number[]
  /** Review rounds (Part 5): the round this apply starts; the BE checks it is the next one. */
  round?: number
}

/** Response of the review route (Part 5): Primary's next-round plan for a request; nothing is written. */
export type ReviewResult = {
  plan: TeamPlan
  replyTo: string
  round: number
}

/** Response of the apply and task-retry routes. */
export type ProjectUpdate = {
  project: Project
  /** Messages created or changed by the call, oldest first. */
  messages: ProjectMessage[]
}

/** Body for POST /api/projects; PATCH /api/projects/:id takes a partial of it. */
export type ProjectInput = {
  name: string
  desc?: string
  teamAgentIds?: string[]
}
