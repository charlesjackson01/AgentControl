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
  /** Optional HTTP(S) or SOCKS5 proxy for every upstream call. Read back with the password masked: user:***@host (BE-11). */
  proxyUrl?: string
  /** Sends chat_template_kwargs.enable_thinking=false on every upstream call. */
  disableThinking?: boolean
  /** Reply budget (max_tokens) for runs; unset means the server default (4096). */
  maxOutputTokens?: number
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
  /* BE-6 additions; optional until it lands. */
  sourceId?: SkillSourceId
  sourceRepo?: string
  sourceCommit?: string
  license?: string
  compatibility?: string
  metadata?: Record<string, string>
  allowedTools?: string[]
  hasScripts?: boolean
  files?: string[]
  defaultOn?: boolean
}

export type SkillSourceId = 'core' | 'superpowers' | 'anthropics' | 'ecc' | 'custom'

/** BE-6 `GET /api/skills` rows: a Skill without its body; fetch `/api/skills/:id` for `content`. */
export type SkillSummary = Omit<Skill, 'content'> & { content?: string }

/** BE-6 `GET /api/skills` source row. */
/** GET /api/skills `sources` entry (BE-6 sends null for unknown repo/commit/licence). */
export type SkillSource = { id: string; repo?: string | null; commit?: string | null; license?: string | null; count: number }

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
  /** Optional proxy URL. Omit to keep on update; "" or null clears it. A `***` password keeps the stored one. */
  proxyUrl?: string | null
  /** Optional. Omit to keep on update; false clears it. */
  disableThinking?: boolean
  /** Optional integer, 0 < n < contextWindow. Omit to keep on update; null clears it (server default). */
  maxOutputTokens?: number | null
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
   * Skills attached to that prompt (content itself is never sent). `mode`: see
   * SkillPromptMode; absent on runs recorded before modes existed.
   */
  skillSnapshot?: { id: string; name: string; contentChars: number; mode?: SkillPromptMode }[]
  /** BE-7: skills the model loaded with activate_skill, in first-use order. */
  activatedSkills?: ActivatedSkill[]
  /** Tool calls executed during the run; absent on pre-tool-execution runs/BEs. */
  toolCalls?: { name: string; arguments: string; resultChars: number; ok: boolean }[]
  /** Set on runs made for a project task; the agent's own chat leaves them out. */
  projectId?: string
}

/**
 * How one attached skill went into a run's system prompt. 'catalog' (BE-7): one
 * catalog line, body loaded on demand with activate_skill. 'full' (whole body)
 * and 'summary' (short summary, read with get_skill) only on runs from before BE-7.
 */
export type SkillPromptMode = 'full' | 'summary' | 'catalog'

/** A skill a run activated (BE-7 `activatedSkills`, message `activity.skills`). */
export type ActivatedSkill = { id: string; name: string; source: string }

/**
 * How a draft's prompt fits its endpoint. BE-7: 'catalog' (skills listed one line
 * each, loaded on demand) or 'too-large' (runs are rejected). 'full' and 'summary'
 * only come from older backends.
 */
export type PromptBudgetMode = 'catalog' | 'too-large' | 'full' | 'summary'

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
  /** @deprecated Always [] since BE-7; older backends listed skills sent as summaries. */
  summarizedSkillIds: string[]
  /** Tools a run would offer, in the order sent upstream. */
  toolNames: string[]
  /** Estimated tokens for the Rules section (header included); 0 when there are no rules. */
  rulesTokens?: number
  /** BE-7: tokens for the one-line-per-skill catalog ("Skills (call activate_skill…)"). */
  catalogTokens?: number
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
  /** Chat-first Phase 1 (BE-1): immutable folder name; 'primary' for Primary. Optional until BE-1 lands. */
  slug?: string
  internetPolicy?: InternetPolicy
  /** "Learn from chat" toggle (BE-1/BE-4); default true. */
  memoryLearn?: boolean
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
  /** BE-1: omitted keeps the stored value. */
  internetPolicy?: InternetPolicy
  memoryLearn?: boolean
}

/* ==========================================================================
   Chat-first Part 2: conversations. Mirrors BE shared/types.ts @ 8a9acd3
   (feat/chat-first-p2-be). One DM per agent, auto-created by GET /api/conversations.
   ========================================================================== */

/* Chat-first Phase 1 shared contracts (phase1-tickets.md, BE shared/types.ts).
   Fields a current BE does not send yet are optional here and the UI copes
   without them; tighten them once BE-1/BE-5/BE-9 land. */

export type InternetPolicy = 'ask' | 'always' | 'never'

/** A file attached to a chat message (BE-9). Paths are relative, e.g. 'shared/x.png'. */
export type Attachment = { root: 'agent' | 'group'; path: string; name: string; size: number; mime: string }

/** What a run did (BE-3/BE-7); rendered by FE-7. BE-7 fills `skills`; `steps` and `filesChanged` are [] until BE-3. */
export type MessageActivity = {
  skills: ActivatedSkill[]
  steps: { tool: string; summary: string; ok: boolean; path?: string }[]
  /** `bytes` and `modifiedAt` (ISO) arrive with BE-3; optional until then. */
  filesChanged: { path: string; change: 'added' | 'modified'; bytes?: number; modifiedAt?: string }[]
}

/** One message in a chat-first conversation (independent of run pruning). */
export type ChatMessage = {
  id: string
  conversationId: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  /** The run that produced this message, when there was one. */
  runId?: string
  /** Assistant message stored for a failed run; `content` is the error text (BE fix/chat-error-flag). */
  error?: true
  /** 'system' = "You created Harbor team…" lines (BE-5). */
  kind?: 'message' | 'system'
  /** Set on assistant messages (required in groups, BE-5). */
  authorAgentId?: string
  attachments?: Attachment[]
  activity?: MessageActivity
}

type ConversationBase = {
  id: string
  createdAt: string
  /** Time of the newest message (or creation). */
  updatedAt: string
  /** Assistant messages newer than this are unread; null = never opened. */
  lastReadAt: string | null
}

/** A 1:1 chat with one agent. One per agent, created lazily. */
export type DmConversation = ConversationBase & { kind: 'dm'; agentId: string }

/** A group chat (BE-5). Primary is always a member and the lead. */
export type GroupConversation = ConversationBase & {
  kind: 'group'
  name: string
  slug: string
  /** Includes the lead; 2-8 agents. */
  memberAgentIds: string[]
  leadAgentId: string
  memoryLearn: boolean
}

export type Conversation = DmConversation | GroupConversation

export type ConversationSummary = Conversation & {
  lastMessage: ChatMessage | null
  unreadCount: number
  /** Agent currently producing a reply. Optional until BE-5 sends it. */
  typingAgentId?: string | null
}

export const CONVERSATION_PAGE_SIZE = 50
export const MAX_CONVERSATION_PAGE_SIZE = 200

/** GET /api/conversations/:id/messages response (messages oldest -> newest). `hasMore` since BE 2a6078c. */
export type ConversationMessagesResponse = {
  conversation: Conversation
  messages: ChatMessage[]
  hasMore?: boolean
}

/** POST /api/conversations/:id/messages response (BE 2a6078c). */
export type ConversationSendResult = {
  conversation: ConversationSummary
  /** This turn's messages (user, and assistant/error when there is one). */
  messages: ChatMessage[]
  run: { id: string; status: AgentRun['status']; error?: string | null }
}

/** Normalized page for the thread view. */
export type ChatMessagePage = Omit<ConversationMessagesResponse, 'hasMore'> & { hasMore: boolean }

/** Chat-first: the workspace owner's profile (GET/PUT /api/profile). */
export type UserProfile = {
  name: string
  avatar?: AgentAvatar
  /** null until first-run setup is saved. */
  onboardedAt: string | null
}

/** PUT /api/profile body (BE c16c83a). `name` required; the first save with a name stamps onboardedAt. Emoji only; images via /api/profile/avatar. */
export type UserProfileInput = {
  name?: string
  avatar?: { kind: 'emoji'; value: string } | null
}

/* BE-4 memory (phase1-tickets.md shared contracts). */
export type MemoryCategory = 'about-you' | 'preferences' | 'work' | 'other'
export type MemoryItem = {
  id: string
  scope: { kind: 'agent'; agentId: string } | { kind: 'group'; groupId: string }
  /** 1-500 chars. */
  text: string
  category: MemoryCategory
  source: { kind: 'user' } | { kind: 'chat'; conversationId: string; runId: string; agentId: string }
  createdAt: string
  updatedAt: string
}
/** GET /api/agents/:id/memory */
export type MemoryPage = { items: MemoryItem[]; total: number; promptTokens: number }

/* BE-2 (c2257b1) per-bot files. */
export type FileZone = 'shared' | 'workspace' | 'memory' | 'skills' | 'meta'

export type FileEntry = {
  path: string
  name: string
  kind: 'file' | 'dir'
  size: number
  mime?: string
  modifiedAt: string
  /** UI badges: workspace "scripts write", memory/meta "managed", skills "read-only". */
  zone: FileZone
  /** Files the user sent in chat (BE-9). */
  sharedAt?: string
  sharedInConversationId?: string
  addedBy?: 'user' | string
}

export type FileListing = {
  /** e.g. 'bots/primary/' */
  root: string
  path: string
  entries: FileEntry[]
  usage: { bytes: number; quotaBytes: number }
}
