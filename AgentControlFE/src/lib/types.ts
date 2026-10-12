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
}

/** Body for POST /api/agents/:id/runs. */
export type AgentRunInput = {
  input: string
  temperature?: number
}

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
}
