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
  category: 'workspace' | 'memory' | 'time' | 'math' | 'text' | 'data'
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
  /** BE-3: file steps and files written this run (also copied onto the reply's `activity`). */
  activity?: { steps: MessageActivity['steps']; filesChanged: FileChange[] }
  /**
   * BE-3 (5d5a864): files this run wrote, on every run (failed ones too); [] when none.
   * Backfilled from `activity` for stored runs. The FE's source for file cards (lib/activity runFilesChanged).
   */
  filesChanged?: FileChange[]
  /** Set on runs made for a project task; the agent's own chat leaves them out. */
  projectId?: string
}

/**
 * BE-3: one file a run wrote; `bytes`/`modifiedAt` (ISO) are the file after the write (optional on old runs).
 * Phase 2 (BE-P2-1): script runs and undo also report 'deleted' (bytes/modifiedAt then absent).
 */
export type FileChange = {
  path: string
  change: 'added' | 'modified' | 'deleted'
  bytes?: number
  modifiedAt?: string
  /** Phase 2 run diffs (BE 3a70c34): which folder `path` is relative to (same shape as UndoPreview). Missing means 'agent' (Phase 1 shape). */
  root?: 'agent' | 'group'
  /** root 'group': the group the file belongs to, and its display name. */
  groupId?: string
  groupName?: string
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
  /**
   * BE-4 (4c35e03): a saved bot. The estimate adds its memory block and `recall`, and
   * `memoryLearn` defaults to the bot's own setting. Left out for a new bot.
   */
  agentId?: string
  /** BE-4: offers `remember` when on. Default: the saved bot's setting, else true. */
  memoryLearn?: boolean
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
  /** Phase 2 (BE-P2-1): the bot's VM settings. The BE always sends it; optional here so a Phase 1 BE still type-checks. */
  vm?: AgentVm
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
  /** 0–2. Omitted: create stores none (endpoint default), PUT keeps the stored value; null clears it (PATCH). */
  temperature?: number | null
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
  /**
   * M2 contract (BE-P2-15, approved 2026-10-30): create only. true turns the browser on for the new bot, the
   * same as PATCH /api/agents/:id/vm {permissions:{browser:true}} (download/rebuild start). Default false.
   * Only the user's toggle and Create click send it: the model's /new draft never pre-sets it.
   */
  browser?: boolean
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
  /** Same entries as the run's top-level `filesChanged` (BE-3); `bytes`/`modifiedAt` optional on old messages. */
  filesChanged: FileChange[]
}

export type ChatMessageKind = 'message' | 'system' | 'run' | 'permission'

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
  /**
   * 'system' = "You created Harbor team…" lines (BE-5). Absent = 'message'.
   * Phase 2 (BE-P2-1): 'run' is a script-run card (scriptRunId + scriptRun), 'permission' an
   * internet or browser request card (permissionRequestId). Both are role 'assistant' with authorAgentId.
   */
  kind?: ChatMessageKind
  /** kind 'run': the ScriptRun this card shows (full run: GET /api/runs/:runId). */
  scriptRunId?: string
  /** kind 'run': a small summary kept in step with the run (also pushed as run.updated). */
  scriptRun?: ChatRunSummary
  /** kind 'permission': the PermissionRequest this card shows. */
  permissionRequestId?: string
  /** Set on assistant messages (required in groups, BE-5). */
  authorAgentId?: string
  /** BE-5 d5e5a99: on the lead's reply, the @mentioned bots the 4-reply cap left out, in mention order (absent when none). */
  skippedAgentIds?: string[]
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

/**
 * GET /api/conversations/:id/messages response (messages oldest -> newest). `hasMore` since BE 2a6078c.
 * `conversation` is the full ConversationSummary (unread, typing, lastMessage) on every page since
 * BE-10 (085be14); before that only `?after=` pages carried it and the first page sent a plain Conversation.
 * Read it with `pageSummary` (lib/conversations.ts), which returns null for the plain shape.
 */
export type ConversationMessagesResponse = {
  conversation: Conversation | ConversationSummary
  messages: ChatMessage[]
  hasMore?: boolean
}

/** POST /api/conversations/:id/messages response (BE 2a6078c). */
export type ConversationSendResult = {
  conversation: ConversationSummary
  /** This turn's messages (user, and assistant/error when there is one). */
  messages: ChatMessage[]
  /** `filesChanged`: only if a server sends the run's top-level list here (5d5a864 does not yet). */
  run: { id: string; status: AgentRun['status']; error?: string | null; filesChanged?: FileChange[] }
}

/** BE-5 e76bfaf: POST /api/conversations/:id/messages on a group -> 202. Replies arrive by `?after=` polling. */
export type GroupSendResult = {
  conversation: ConversationSummary
  /** The user's message only. */
  messages: ChatMessage[]
}

/** BE-5: POST /api/groups {name, memberAgentIds} (Primary is added and put first). */
export type GroupCreateInput = { name: string; memberAgentIds: string[] }
/** BE-5: PATCH /api/groups/:id; each field optional. */
export type GroupPatch = { name?: string; memberAgentIds?: string[]; memoryLearn?: boolean }
export type GroupSummary = GroupConversation & Omit<ConversationSummary, keyof Conversation>

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
  /** BE-3: `bytes` includes the bot's trash, which counts toward the quota; `trashBytes` is that part (absent before BE-3). */
  usage: { bytes: number; quotaBytes: number; trashBytes?: number }
  /**
   * Optional (BE-2 follow-up): files (not folders, trash left out) in the whole bot folder,
   * the same on every path's listing. The "Files N" tab count (03d).
   */
  totalFiles?: number
}

/*
 * Hand-copied from AgentControlBE/src/shared/types.ts @ 9180e17 (BE-P2-16), section "Phase 2",
 * verbatim so a diff against the BE stays empty. Contract: docs/phase2-contract.md.
 * Phase 1's RunStatus/AgentRun are model turns; script runs use ScriptRunStatus/ScriptRun.
 */
/* ───────────────────────── Phase 2: bot VMs, script runs, undo, permissions (BE-P2-1) ───────────────────────── */

/** Per-run limits, fixed in Phase 2 (PATCHing them returns 400). */
export const VM_LIMITS = { memoryMb: 4096, personalDiskMb: 10240, cpus: 2, timeoutSec: 600, pids: 256, outputMb: 200 } as const
export type VmLimits = typeof VM_LIMITS
/** Each group's shared/ folder: 10 GB, counted once (not against members). */
export const GROUP_SHARED_QUOTA_MB = 10240
/** Mac/Windows shared machine `agentcontrol` (decision 2). */
export const VM_MACHINE_DEFAULTS = { name: 'agentcontrol', memoryMb: 6144, cpus: 4, initialDiskGb: 60 } as const
/** Undo retention (decision 3): a snapshot is eligible while in the bot's last 20 runs OR under 7 days old. */
export const UNDO_RETENTION = { runs: 20, days: 7 } as const
/** Machine free-space floor below which new runs are blocked. */
export const RUN_BLOCK_FREE_MB = 3072
/** Env var names a bot may not set. Matched case-insensitively; any name starting AC_ is reserved too. */
export const RESERVED_ENV_NAMES: readonly string[] = ['PATH', 'HOME', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']
export const RESERVED_ENV_PREFIX = 'AC_'
/** Env var names: POSIX-ish, 1–64 chars. Values up to 4096 chars; at most 50 vars per bot. */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
export const MAX_ENV_VARS = 50
export const MAX_ENV_VALUE_CHARS = 4096

/** gVisor mode for one bot; 'inherit' follows the global mode. */
export type RuntimeMode = 'inherit' | 'force_on' | 'force_off'
export const RUNTIME_MODES: readonly RuntimeMode[] = ['inherit', 'force_on', 'force_off']
export type GlobalRuntimeMode = 'auto' | 'force_on' | 'force_off'
export const GLOBAL_RUNTIME_MODES: readonly GlobalRuntimeMode[] = ['auto', 'force_on', 'force_off']
export type ContainerRuntime = 'runsc' | 'crun' | 'runc'
export type RuntimeStatus = 'active' | 'not_installed' | 'incompatible_fallback' | 'forced_off' | 'required_unavailable'

/** One non-secret env var, injected on every run. */
export interface EnvVar {
  name: string
  value: string
}

/** The bot's installed-tool manifest (refreshed after a run changes ~/.local or /opt/bot). */
export interface ToolManifest {
  pip: string[]
  npm: string[]
  optBin: string[]
  updatedAt: string
}

/** Agent.vm: stored per bot. */
export interface AgentVm {
  /** Browser (Playwright) permission. Default false; only the user can turn it on. */
  permissions: { browser: boolean }
  gvisor: RuntimeMode
  env: EnvVar[]
  /** apt packages; source of truth for the bot image layer. */
  packages: string[]
  image: { generation: number; previous?: number; builtAt?: string; base: 'base' | 'browser' }
  tools?: ToolManifest
  /** Reserved for a future LAN/Tailscale allow-list; always [] in Phase 2 (PATCH → 400). */
  egress: { allow: [] }
}

export type VmState = 'not_setup' | 'stopped' | 'starting' | 'running' | 'error' | 'files_missing'
export type BrowserState = 'absent' | 'downloading' | 'ready' | 'error'
export type SnapshotDriver = 'reflink' | 'overlay' | 'copy'
export type StorageBackendKind = 'local' | 'wsl'

export type ScriptRunStatus = 'queued' | 'waiting_permission' | 'running' | 'succeeded' | 'failed' | 'timed_out' | 'stopped' | 'denied' | 'undone'
export const SCRIPT_RUN_ACTIVE: readonly ScriptRunStatus[] = ['queued', 'waiting_permission', 'running']
export type ScriptRunKind = 'script' | 'tool_build' | 'undo'
export type UndoUnavailableReason = 'expired' | 'budget_bot' | 'budget_global' | 'low_disk' | 'too_large' | 'machine_restored'
export const UNDO_UNAVAILABLE_REASONS: readonly UndoUnavailableReason[] = ['expired', 'budget_bot', 'budget_global', 'low_disk', 'too_large', 'machine_restored']

export interface ScriptRunUndo {
  /** 'available' while the snapshot is kept, 'unavailable' once evicted (with reason), 'done' after an undo. */
  state: 'available' | 'unavailable' | 'done'
  reason?: UndoUnavailableReason
  /** reason 'too_large': how many bytes the run changed (over the snapshot budget). */
  changedBytes?: number
  /** When it became unavailable or was undone. */
  at?: string
  /** state 'done': the undo run that reversed this one. */
  undoRunId?: string
}

export type PermissionType = 'internet' | 'browser'
/** internet: allow_once | always | deny. browser: enable | deny. */
export type PermissionDecision = 'allow_once' | 'always' | 'enable' | 'deny'

/** One script run, tool build or undo (data/runs/<slug>/<runId>.json). Separate from AgentRun (a model turn). */
export interface ScriptRun {
  id: string
  agentId: string
  conversationId: string
  /** The chat message (kind 'run') that shows this card. */
  messageId?: string
  /** The model turn (AgentRun) that called run_script. */
  agentRunId?: string
  context: 'dm' | 'group'
  groupId?: string
  skillId?: string
  kind: ScriptRunKind
  argv: string[]
  /** Inline script body, when the model sent one instead of argv. */
  script?: string
  /** Relative to /bot (e.g. "workspace" or "groups/<slug>"). */
  cwd: string
  why?: string
  network: 'off' | 'on'
  browser: boolean
  /** null until resolved (queued runs, or a run that failed before start). */
  runtime: ContainerRuntime | null
  /** M2 contract (approved 2026-10-30): see ScriptRunPermission (requestId is absent for grants without a card). */
  permissions: ScriptRunPermission[]
  status: ScriptRunStatus
  /**
   * status 'queued': how many runs are ahead of this one, counting the ones running now
   * (with 1 run at a time, a run queued behind a running one is 1: "Queued · 1 ahead").
   */
  queuePosition?: number
  exitCode?: number
  /** Plain-language reason for failed / denied / timed_out / stopped. */
  error?: string
  /**
   * BE-P2-12 (additive): status 'failed' because a block hit at the run's turn — the same reasons
   * a start answers 409 with (gvisor_unavailable, limits_unenforced, mounts_unusable,
   * personal_quota, snapshot_failed, low_disk). Show `error`; branch on `reason`.
   */
  reason?: string
  queuedAt: string
  startedAt?: string
  endedAt?: string
  durationMs?: number
  peakMemoryMb?: number
  /** Last 64 KB of each stream (the model gets the last 8 KB). */
  stdoutTail: string
  stderrTail: string
  outputBytes: number
  /** True when output passed the 200 MB cap and was cut. */
  outputTruncated?: boolean
  filesChanged: FileChange[]
  /**
   * M2 contract (BE-P2-13/14, approved with changes 2026-10-30): the hosts the run's proxy saw ("Sites used"),
   * at most SCRIPT_RUN_HOSTS_MAX (200) entries, blocked ones first and always kept.
   */
  hostsContacted?: HostContact[]
  /** M2 contract (approved 2026-10-30): how many distinct hosts the proxy saw, when hostsContacted was cut. */
  hostsContactedTotal?: number
  snapshot: { id: string; driver: SnapshotDriver; retainedBytes: number } | null
  undo: ScriptRunUndo
  /** kind 'undo': the run it reversed. */
  undoOfRunId?: string
  /** M2 contract (BE-P2-14, approved 2026-10-30): status 'waiting_permission' only: what it waits for. */
  waitingFor?: RunWaitingFor
  /** M2 contract (BE-P2-14, approved 2026-10-30): waitingFor 'permission': the pending request (its own, or another run's of the same bot while that one is pending). */
  waitingOnRequestId?: string
  /** M2 contract (BE-P2-21, approved 2026-10-30): kind 'tool_build' only. */
  build?: ToolBuildInfo
}

/** Run history row (GET /api/agents/:id/script-runs and VmInfo.runs). */
export type ScriptRunSummary = Pick<ScriptRun,
  'id' | 'agentId' | 'conversationId' | 'kind' | 'argv' | 'why' | 'status' | 'exitCode' | 'queuedAt' | 'startedAt' | 'endedAt' | 'durationMs' | 'runtime' | 'undo' | 'undoOfRunId'
> & {
  filesChangedCount: number
  groupId?: string
  /** Optional split of filesChangedCount for history rows. */
  files?: { added: number; modified: number; deleted: number }
  network?: ScriptRun['network']
  /** M2 contract (approved 2026-10-30): history row "internet once" / "internet always". */
  internet?: InternetUse
  /** M2 contract (approved 2026-10-30): up to 3 reached host names, for the history row. */
  hosts?: string[]
  /** M2 contract (BE-P2-21, approved 2026-10-30): kind 'tool_build' only. */
  build?: ToolBuildInfo
  /** M2 contract (BE-P2-22's field, approved 2026-10-30): status 'queued': "Queued · after tool build" for 'tool_build'. */
  queuedReason?: QueuedReason
}

/** The small run summary a kind 'run' ChatMessage carries. */
export interface ChatRunSummary {
  status: ScriptRunStatus
  kind: ScriptRunKind
  /** Skill name, else the script's file name (argv[1] or argv[0]), else "script". */
  name: string
  files: { added: number; modified: number; deleted: number }
  undo: ScriptRunUndo
  /** status 'queued': runs ahead of it, running ones included (ScriptRun.queuePosition). */
  queuePosition?: number
  exitCode?: number
  /** The script's file name (argv[1] or argv[0]) for the card title; `name` stays the skill. */
  scriptName?: string
  /** kind 'undo': the script name (else skill name) of the run it reversed. */
  undoOfName?: string
  durationMs?: number
  runtime?: ContainerRuntime | null
  /** M2 contract (BE-P2-14, approved 2026-10-30): status 'waiting_permission': "Waiting for permission" / "Waiting for the browser". */
  waitingFor?: RunWaitingFor
  /** M2 contract (approved 2026-10-30): card meta "Internet" and "Browser" rows. */
  network?: ScriptRun['network']
  browser?: boolean
  internet?: InternetUse
  /** M2 contract (approved 2026-10-30): "Sites used" (blocked hosts first, at most 20 entries). */
  hostsContacted?: HostContact[]
  /** M2 contract (approved 2026-10-30): failed / denied runs: ScriptRun.reason, so the card can pick its error row. */
  reason?: string
  /** M2 contract (approved 2026-10-30): failed / denied / stopped runs: ScriptRun.error (shown as is). */
  error?: string
  /** M2 contract (BE-P2-21, approved 2026-10-30): kind 'tool_build' only. */
  build?: ToolBuildInfo
  /** M2 contract (approved 2026-10-30): status 'running' (and after): ScriptRun.startedAt, for the live "Running · 1:12". */
  startedAt?: string
  /** M2 contract (BE-P2-22's field, approved 2026-10-30): status 'queued' only. */
  queuedReason?: QueuedReason
  /** M2 contract (BE-P2-22, approved 2026-10-30): queuedReason 'tool_build': the build it waits for ("runs on the new tools (version 3)"). */
  afterBuild?: { runId: string; generation: number }
  /** M2 contract (approved 2026-10-30): ScriptRun.hostsContactedTotal (or the full count), for "+N more" beyond the 20. */
  hostsContactedTotal?: number
}

export interface PermissionRequest {
  id: string
  runId: string
  agentId: string
  conversationId: string
  /** The chat message (kind 'permission') that shows this card. */
  messageId?: string
  type: PermissionType
  hosts?: string[]
  why?: string
  status: 'pending' | 'allowed_once' | 'always' | 'enabled' | 'denied' | 'timeout'
  createdAt: string
  /** createdAt + 10 min; after that it resolves as 'timeout' (= deny). */
  expiresAt: string
  resolvedAt?: string
  /** M2 contract (BE-P2-14, approved 2026-10-30): 'user' when the user answered; absent for 'timeout' and when the run ended first. */
  resolvedBy?: 'user'
  /** M2 contract (approved 2026-10-30): status 'denied' without an answer: the run was stopped (or ended) while the card was pending. */
  /** 'policy_changed' (approved 2026-10-30): the internet policy went to Never/Always, or the browser was turned off, while it was pending. */
  closedBy?: 'run_stopped' | 'run_ended' | 'policy_changed'
  /** M2 contract (approved 2026-10-30): what the card names: "To run fetch_rates.py" / "the tool build". */
  runKind?: ScriptRunKind
  scriptName?: string
  /** M2 contract (approved 2026-10-30): group chats: the group (the card says "in <group>"). */
  groupId?: string
  /** M2 contract (approved 2026-10-30): the group's name at the time, beside groupId (M1 undo convention). */
  groupName?: string
  /** M2 contract (approved): type 'browser': the run also needs the internet and the policy is ask ("Next: internet"). */
  internetNext?: boolean
  /**
   * M2 contract (BE-P2-15, approved 2026-10-30): type 'browser', after 'enable': a copy of the setup this card
   * started, refreshed on every setup change (permission.updated), so the card keeps its own steps after a
   * later re-setup overwrites VmInfo.browser.setup.
   */
  setup?: BrowserSetup
  /** M2 contract (BE-P2-15, approved 2026-10-30): type 'browser': that setup's failure, copied the same way. */
  setupError?: BrowserError
}
export const PERMISSION_TIMEOUT_MS = 10 * 60 * 1000

/** GET /api/agents/:id/vm (and the /sandbox alias for one release). */
export interface VmInfo {
  agentId: string
  state: VmState
  stateMessage?: string
  host: { engine: 'podman' | 'docker' | null; provider: string; machine?: string }
  runtime: {
    effective: ContainerRuntime | null
    status: RuntimeStatus
    /** Failing probe check, or why it's required but unavailable. */
    reason?: string
    checkedAt?: string
    mode: RuntimeMode
    globalMode: GlobalRuntimeMode
    /** BE-P2-8 (additive): false when the runtime in use can't enforce the memory/process limits. Absent: unknown. */
    limitsEnforced?: boolean
    /** BE-P2-8 (additive): why, when limitsEnforced is false (starts with "limits can't be enforced"). */
    limitsReason?: string
    /** BE-P2-7 (additive, needs OK): the probe check that failed (incompatible_fallback / required_unavailable). */
    failedCheck?: ProbeCheckId
  }
  internetPolicy: InternetPolicy
  permissions: { browser: boolean; browserState: BrowserState; /** 0–1 while downloading */ progress?: number }
  /** M2 contract (BE-P2-15, approved 2026-10-30): this bot's browser setup (absent = off with no history). */
  browser?: BotBrowserInfo
  /** M2 contract (BE-P2-21, approved 2026-10-30): the bot's tool build in progress ("Building tools" head). */
  activeBuild?: ActiveToolBuild
  limits: VmLimits
  usage: {
    memoryMb: number
    /** Bot files & tools meter: always the sum of `breakdown` (counted against personalQuotaBytes, 10 GB). */
    personalBytes: number
    personalQuotaBytes: number
    /** workspace/, shared inputs, memory (incl. BOT.md), ac-tools volume, ac-opt volume, the bot's own image layer (not the shared base). Snapshots are separate. */
    breakdown: { workspace: number; inputs: number; memory: number; tools: number; opt: number; imageLayer: number }
    snapshots: { bytes: number; budgetBytes: number; runsWithUndo: number }
  }
  env: EnvVar[]
  packages: string[]
  tools?: ToolManifest
  image: AgentVm['image']
  idleStopAt?: string
  storage: { backend: StorageBackendKind; driver: SnapshotDriver | null; location: string; lastBackupAt?: string; explorerPath?: string }
  /** Isolation note, e.g. when the host falls back to --userns keep-id. */
  isolationNote?: string
  /** Newest first, at most 50 (older via GET /api/agents/:id/script-runs?before=). */
  runs: ScriptRunSummary[]
  /** True when older runs exist beyond `runs` (same meaning as the runs list's hasMore). */
  runsHasMore: boolean
}

/** PATCH /api/agents/:id/vm body. Unknown keys, `limits` and `egress` → 400. */
export interface VmPatch {
  internetPolicy?: InternetPolicy
  permissions?: { browser?: boolean }
  gvisor?: RuntimeMode
  /** Replaces the whole list. */
  env?: EnvVar[]
}

/** Global VM settings (settings.vm). GET/PATCH /api/vm/settings serves all but volumeId and machine. */
export interface VmSettings {
  gvisor: GlobalRuntimeMode
  backups: { enabled: boolean; /** "HH:MM" local */ time: string; keep: number }
  snapshotBudget: { perBotMb: number; globalMb: number; freeFloorMb: number }
  /** Server-only: the Windows data volume marker. */
  volumeId?: string
  /** Server-only: the managed machine disk budget (grows on demand). */
  machine?: { diskGb: number }
}
export type VmSettingsView = Omit<VmSettings, 'volumeId' | 'machine'>
export type VmSettingsPatch = { gvisor?: GlobalRuntimeMode; backups?: Partial<VmSettings['backups']>; snapshotBudget?: Partial<VmSettings['snapshotBudget']> }
/** Allowed bounds for PATCH /api/vm/settings snapshotBudget (MB) and backups.keep. */
export const SNAPSHOT_BUDGET_BOUNDS = {
  perBotMb: { min: 256, max: 20480 },
  globalMb: { min: 1024, max: 204800 },
  freeFloorMb: { min: 3072, max: 51200 },
} as const
export const BACKUP_KEEP_BOUNDS = { min: 1, max: 30 } as const

/** GET /api/vm/host. */
export interface VmHostInfo {
  engine: 'podman' | 'docker' | null
  version: string | null
  /** e.g. 'native', 'libkrun', 'applehv', 'wsl', 'hyperv'. */
  provider: string
  os: 'linux' | 'darwin' | 'win32'
  machine: { name: 'agentcontrol'; state: 'running' | 'stopped' | 'missing' | 'starting' | 'error'; memoryMb: number; cpus: number; diskGb: number; diskUsedGb: number; growOffer?: { toGb: number } } | null
  storage: { driver: SnapshotDriver | null; backend: StorageBackendKind; volumeState: 'ok' | 'missing' | 'mismatch' }
  /** Max concurrent runs on this host (1 on Mac/Windows; the Linux formula). */
  concurrency: number
  /** Plain-language setup steps still to do (e.g. "Install Podman"); [] when ready. */
  setupSteps: { id: string; text: string; done: boolean; helpUrl?: string }[]
}

/** GET /api/runs/:runId/undo/preview. */
export interface UndoPreview {
  runId: string
  /** What undo would do: added → deleted, modified/deleted → restored. */
  changes: UndoPreviewChange[]
  /** Files changed since the run (by a later run or the user). Undo without force → 409. */
  conflicts: { path: string; root: 'agent' | 'group'; groupId?: string; groupName?: string }[]
  /** Shown in the dialog: undo never reverses internet side effects or installed tools. */
  caveats: ('internet' | 'tools')[]
  /** Optional: the bot's undo snapshot budget (same numbers as VmInfo). */
  budget?: { usedBytes: number; limitBytes: number }
}
/** One file undo would touch. Sizes are optional; null where that side doesn't exist (added/deleted). */
export interface UndoPreviewChange {
  path: string
  action: 'delete' | 'restore'
  root: 'agent' | 'group'
  groupId?: string
  /** Display name of the group, when root is 'group'. */
  groupName?: string
  /** Size now (after the run); null if the run deleted it. */
  afterBytes?: number | null
  /** Size undo would restore; null if the run added it. */
  beforeBytes?: number | null
}
/** 410 `message` text for reason 'machine_restored' (the FE shows the body's `message` as is). */
export const UNDO_MACHINE_RESTORED_TEXT = "This bot's computer was restored from a backup, so this run can't be undone."
/** POST /api/runs/:runId/undo body. force: overwrite conflicting files ("Undo anyway"). */
export interface UndoRequest {
  force?: boolean
}
/** POST /api/runs/:runId/undo 200: the undo run (kind 'undo') that reversed it. */
export interface UndoResult {
  run: ScriptRun
  undoRun: ScriptRun
}
/**
 * 409 body: the bot has an active run, or there are conflicts and force wasn't set.
 * Sent in Fastify's error shape `{ statusCode, error, message, reason }`: `message` is the
 * plain-language text, `error` is only the HTTP status phrase ("Request Error").
 */
export interface UndoConflict {
  statusCode: number
  /** The HTTP status phrase (e.g. "Request Error"), not for display; the readable text is in `message`. */
  error: string
  /** Plain-language text the FE shows as is. */
  message: string
  /** BE-P2-11 (needs OK): 'already_undone' when the run was undone already (undo its undo run instead). */
  reason: 'run_active' | 'conflicts' | 'already_undone'
  conflicts?: UndoPreview['conflicts']
}
/**
 * 410 body when the snapshot is gone, in Fastify's error shape: `message` is the plain-language
 * text (UNDO_MACHINE_RESTORED_TEXT for 'machine_restored'), `error` is the HTTP status phrase.
 */
export interface UndoGone {
  statusCode: number
  /** The HTTP status phrase (e.g. "Request Error"), not for display; the readable text is in `message`. */
  error: string
  /** Plain-language text the FE shows as is (UNDO_MACHINE_RESTORED_TEXT for 'machine_restored'). */
  message: string
  reason: UndoUnavailableReason
}

/**
 * Phase 2 live events: GET /api/events (text/event-stream; new, Phase 1 had none).
 * - Each frame: `id: <n>` (monotonic integer as a string), `event: <type>`, `data: <LiveEvent JSON>`.
 * - Reconnect with `Last-Event-ID: <n>` (or ?lastEventId=) to replay newer events from a ring of the
 *   last 1000; if <n> is older than the ring the first frame is `event: reset` (data {}), meaning
 *   re-fetch active runs, pending requests and VM info.
 * - Heartbeat: a `: ping` comment line every 15 s. `retry: 3000` is sent once on connect.
 * - Optional filters: ?conversationId=… and/or ?agentId=… (vm.updated matches agentId).
 */
export type LiveEventType = LiveEvent['type']
export interface LiveEventFrame {
  id: string
  event: LiveEvent
}
export const LIVE_EVENT_HEARTBEAT_MS = 15_000
export const LIVE_EVENT_REPLAY = 1000
export type LiveEvent =
  | { type: 'run.updated'; conversationId: string; run: ScriptRun; messageId?: string; summary: ChatRunSummary }
  | { type: 'run.output'; conversationId: string; runId: string; stream: 'stdout' | 'stderr'; chunk: string }
  | { type: 'permission.requested'; conversationId: string; request: PermissionRequest }
  | { type: 'permission.resolved'; conversationId: string; request: PermissionRequest }
  /** M2 contract (BE-P2-15, approved 2026-10-30): the request changed after it resolved (setup / setupError snapshot). */
  | { type: 'permission.updated'; conversationId: string; request: PermissionRequest }
  | { type: 'vm.updated'; agentId: string; vm: VmInfo }
  /** M2 contract (BE-P2-15, approved 2026-10-30): the shared Chromium download; sent to every subscriber (no filter applies). */
  | { type: 'browser.updated'; browser: BrowserAddonInfo }

/** GET /api/agents/:id/vm/tools. tools is absent until the first manifest refresh. */
export interface VmToolsInfo {
  agentId: string
  tools?: ToolManifest
  packages: string[]
  image: AgentVm['image']
  /** True when POST /vm/tools/rollback has a previous generation to go back to. */
  canRollback: boolean
  /** M2 contract (BE-P2-21, approved 2026-10-30): the build in progress (Rebuild / rollback answer 409 build_active meanwhile). */
  activeBuild?: ActiveToolBuild
}

export type ProbeCheckId = 'start' | 'bind_mount' | 'snapshot_mount' | 'network' | 'cgroup_limits' | 'exec' | 'chromium'
/** One probe check (§4 checks 1–7). 'skipped': not needed (e.g. chromium with no browser bots). */
export interface ProbeCheck {
  id: ProbeCheckId
  status: 'pass' | 'fail' | 'skipped'
  /** Plain-language detail on fail, e.g. "bind-mount ownership check failed". */
  message?: string
  durationMs?: number
}
/** GET /api/vm/probe (last result) and POST /api/vm/probe (re-check, 200 when done). */
export interface VmProbeResult {
  runsc: { installed: boolean; version?: string }
  /** null when runsc isn't installed (nothing probed). */
  checks: ProbeCheck[] | null
  /** All checks passed: gVisor can run here. */
  compatible: boolean
  uidMapping: 'idmap' | 'keep-id' | null
  snapshotDriver: SnapshotDriver | null
  checkedAt: string | null
  /** The cache key parts, for display/debug. */
  versions: { engine: string | null; runsc: string | null; image: string | null }
  /** BE-P2-8 (additive): the standard runtime (crun/runc) probed with the same test container. */
  standard?: {
    runtime: ContainerRuntime | null
    version: string | null
    /** Memory and process limits really stopped an over-limit allocation and fork. */
    limitsEnforced: boolean
    /** The engine accepted the limit flags (false: containers are created without them). */
    limitsAccepted: boolean
    checks: ProbeCheck[]
    /**
     * BE-P2-5: uid mapping whose bind_mount check passed for the standard runtime (null: none did,
     * Docker, or not checked). The top-level `uidMapping` is the same for runsc.
     */
    uidMapping?: 'idmap' | 'keep-id' | null
  } | null
  /** BE-P2-8 (additive): runtime flags runsc needed to start, e.g. ["--runtime-flag=ignore-cgroups", "--runtime-flag=network=none"]. */
  runscFlags?: string[]
  /** BE-P2-7 (additive, needs OK): optional checks this result covers (part of the cache key), e.g. ["chromium"]. */
  features?: string[]
  /** BE-P2-7 (additive, needs OK): how long the probe took (plan §4 budget: under 30 s). */
  durationMs?: number
}

/** GET /api/permissions?status=pending[&agentId=][&conversationId=]: newest first. */
export interface PermissionListResponse {
  requests: PermissionRequest[]
  /** M2 contract (approved 2026-10-30): server time, so the FE countdown from expiresAt ignores clock skew. */
  now?: string
}
/** POST /api/permissions/:requestId body. Requires header PERMISSION_CSRF_HEADER: '1' (403 without; 409 when already resolved). */
export interface PermissionAnswer {
  decision: PermissionDecision
}
export const PERMISSION_CSRF_HEADER = 'x-agentcontrol-confirm'

/* ───────────────────────── Phase 2 M2 contract (BE-P2-14/15/21): shapes only, approved with changes by Team lead 2026-10-30 ───────────────────────── */

/**
 * Why a queued run waits. Owned by BE-P2-22 (p2/be-22-build-queue, not merged here): the same definition as there,
 * so the two agree; keep one copy when merging (BE-P2-22 also adds ScriptRun.queuedReason).
 */
export type QueuedReason = 'slot' | 'tool_build'

/** ScriptRun.hostsContacted cap (blocked hosts first); ChatRunSummary keeps 20. */
export const SCRIPT_RUN_HOSTS_MAX = 200
export const CHAT_RUN_HOSTS_MAX = 20
/** "Expects to reach" on a vm_install card: display only, never enforced (plan default 2). */
export const VM_INSTALL_EXPECTED_HOSTS: readonly string[] = ['pypi.org', 'files.pythonhosted.org', 'registry.npmjs.org', 'deb.debian.org']
/** run_script hosts? / PermissionRequest.hosts: at most 10 names, each ≤ 253 chars, hostname or IP syntax. */
export const PERMISSION_HOSTS_MAX = 10

/** How a ScriptRun got (or didn't get) a permission. */
export interface ScriptRunPermission {
  type: PermissionType
  decision: PermissionDecision | 'timeout' | 'pending'
  /** The card's PermissionRequest; absent when no card was shown (policy Always, a user Rebuild click). */
  requestId?: string
  /**
   * 'card': answered on a card; 'policy': the bot's rule (Always, or browser already on); 'rebuild': a user click that
   * grants one build's internet: Rebuild, or turning the browser on/off (card enable, VM tab, create).
   */
  source?: 'card' | 'policy' | 'rebuild'
}

/** What a waiting_permission run waits for. */
export type RunWaitingFor = 'permission' | 'browser'

/** Card / history wording: "on (allowed once)", "on (always allowed)", "off". */
export type InternetUse = 'off' | 'once' | 'always'

/** Why the proxy refused a host (plan §5). 'port': not 80/443; 'reserved': multicast/240/4/broadcast/0/8. */
export type HostBlockReason = 'home_network' | 'tailscale' | 'this_computer' | 'model_server' | 'metadata' | 'private_name' | 'port' | 'reserved'
export const HOST_BLOCK_REASONS: readonly HostBlockReason[] = ['home_network', 'tailscale', 'this_computer', 'model_server', 'metadata', 'private_name', 'port', 'reserved']

/** One "Sites used" row. */
export interface HostContact {
  /** The name (or IP literal) the script asked for, without the port. */
  host: string
  /** Set when it isn't 443 (e.g. 8080 → "192.168.1.20:8080"). */
  port?: number
  /**
   * The resolved IP that was checked. Hosts refused before resolving (*.lan, *.ts.net, …) never carry this field
   * (no empty or guessed value; the FE shows no "→ IP" arrow; Charles, 2026-10-30).
   */
  ip?: string
  /** Requests (reached) or tries (blocked). */
  count: number
  blocked: boolean
  reason?: HostBlockReason
}

/** ScriptRun.build for kind 'tool_build'. */
export interface ToolBuildInfo {
  /** The generation this build makes ("version 3"). */
  generation: number
  /** The generation in use when it started; kept if the build fails or is stopped ("version 2"). */
  fromGeneration: number
  /** The full package list the new generation has. */
  packages: string[]
  /** Packages new in this build ("adds matplotlib, pandas"); removed only for a rebuild that drops some. */
  added: string[]
  removed?: string[]
  startedBy: 'user' | 'bot'
  /** 'rebuild': VM tab Rebuild; 'vm_install': the bot's tool ("Primary (vm_install)"); 'browser': rebuild onto the browser base. */
  via: 'rebuild' | 'vm_install' | 'browser'
  base: 'base' | 'browser'
  /** While running: "Step 4 of 6 · pip install". */
  progress?: { step: number; steps: number; label: string }
}

/**
 * VmInfo.activeBuild / VmToolsInfo.activeBuild. The VM tab's "Stop build" (Building tools header) and the chat
 * card's Stop both call POST /api/runs/:runId/stop with this runId (one route, same semantics).
 */
export interface ActiveToolBuild {
  runId: string
  status: 'queued' | 'waiting_permission' | 'running'
  startedAt?: string
  build: ToolBuildInfo
  internet: InternetUse
  /** Reached host names so far. */
  hosts: string[]
}

/** POST /api/agents/:id/vm/tools/rebuild → 202. */
export interface ToolBuildAccepted {
  run: ScriptRun
}
/** Build time limit (plan §8 risks): past it the build ends timed_out and the current generation is kept. */
export const TOOL_BUILD_TIMEOUT_MS = 20 * 60 * 1000

/** Per-bot browser state (plan: vm.browser). 'setting_up' = waiting for the shared download. */
export type BotBrowserState = 'off' | 'setting_up' | 'rebuilding' | 'waiting_idle' | 'ready' | 'error'

/** Why browser setup stopped. */
export type BrowserErrorReason = 'download_failed' | 'low_disk' | 'build_failed' | 'chromium_check_failed'
export interface BrowserError {
  reason: BrowserErrorReason
  /** Plain language, shown as is (e.g. "The Chromium download stopped at 840 MB (connection reset)."). */
  message: string
  at: string
  /** low_disk: what the download needs and what is free. */
  neededBytes?: number
  freeBytes?: number
  /** download_failed: how far it got. */
  bytes?: number
  /** Short plain cause for the card: "connection reset", "missing shared library". */
  cause?: string
  /** Longer detail for the VM tab: "the connection dropped at 840 MB", "libnss3.so missing". */
  detail?: string
}

/** VmInfo.browser. */
export interface BotBrowserInfo {
  state: BotBrowserState
  /** The latest setup (kept after ready for the "ready at …" line). */
  setup?: BrowserSetup
  error?: BrowserError
  /** state 'ready': from the chromium check ("Chromium 131 · checked today 9:54 AM"). */
  chromium?: { version: string; checkedAt: string }
}

/** One turn-on of the browser for a bot (the setup card's steps, mockups 04/05). */
export interface BrowserSetup {
  turnedOnAt: string
  turnedOnBy: 'user'
  /** The browser card that turned it on (absent when turned on in the VM tab or at create). */
  requestId?: string
  /** The run waiting for it ("snap_dashboard.py waits until it's ready"). */
  runId?: string
  /** Step 1 (shared download). Skipped (no times) when the download was already there. */
  download: { startedAt?: string; endedAt?: string; bytes?: number; totalBytes?: number; reused?: boolean }
  /** Step 2: the tool_build run onto the browser base. */
  rebuild: { runId?: string; startedAt?: string; endedAt?: string }
  /** Step 3: recreate the container when idle, then the chromium check. */
  check: { status: 'pending' | 'pass' | 'fail'; at?: string; message?: string }
  readyAt?: string
}

/** GET /api/vm/browser (plan: BrowserState object; renamed so the M1 BrowserState union keeps its name). */
export interface BrowserAddonInfo {
  /** Same values as VmInfo.permissions.browserState. */
  state: BrowserState
  /** 0–1 while downloading. */
  progress?: number
  bytes?: number
  /** About 1.3 GB (SHARED_IMAGE_APPROX_BYTES.browser until known). */
  totalBytes: number
  /** While downloading: seconds left, when it can be estimated ("about 1 min left"). */
  etaSec?: number
  /** state 'error' (download_failed / low_disk). */
  error?: BrowserError
  /** Bots with the browser on (also the "shared by 2 bots" count). Empty with state 'ready' → "Remove download". */
  usedBy: string[]
  readyAt?: string
}

/**
 * M2 error reasons (400/403/404/409; low_disk and proxy_unavailable are 409s; 5xx bodies carry no reason, as in M1).
 * Includes the M1 reasons these routes still return (run_active, no_previous_generation, files_missing).
 */
export type M2ErrorReason =
  | 'bad_decision' | 'egress_reserved' | 'confirm_required' | 'user_only' | 'not_found'
  | 'already_resolved' | 'browser_in_use' | 'browser_busy' | 'build_active' | 'run_active' | 'internet_never'
  | 'proxy_unavailable' | 'low_disk' | 'nothing_to_retry' | 'no_previous_generation' | 'files_missing'
/** M2 run end reasons (ScriptRun.reason / ChatRunSummary.reason). M1's internet_unavailable is retired. */
export type M2RunReason =
  | 'internet_never' | 'network_off' | 'permission_denied' | 'permission_timeout' | 'proxy_unavailable'
  | 'browser_unavailable' | 'chromium_check_failed' | 'host_blocked' | 'build_failed' | 'build_stopped'
/** 409 already_resolved body: Fastify's error shape plus the final request. */
export interface PermissionAlreadyResolved {
  statusCode: 409
  error: string
  message: string
  reason: 'already_resolved'
  request: PermissionRequest
}
/** Which decisions each request type takes (anything else → 400 bad_decision). */
export const PERMISSION_DECISIONS: Readonly<Record<PermissionType, readonly PermissionDecision[]>> = {
  internet: ['allow_once', 'always', 'deny'],
  browser: ['enable', 'deny'],
}
/** POST /api/vm/browser/retry body: no agentId retries the shared download; with agentId, that bot's failed step. */
export interface BrowserRetryRequest {
  agentId?: string
}
