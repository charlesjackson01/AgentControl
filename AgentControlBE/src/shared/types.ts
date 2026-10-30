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
  /** Ask the server not to think (chat_template_kwargs.enable_thinking=false). */
  disableThinking?: boolean
  /** Tokens reserved for (and capping) each reply; 0 < n < contextWindow. Defaults to 4096. */
  maxOutputTokens?: number
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
  /** Optional. Omit to keep on update. */
  disableThinking?: boolean
  /** Optional integer, 0 < n < contextWindow. Omit to keep on update; null clears (back to the default). */
  maxOutputTokens?: number | null
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
  /** Where the skill comes from. Ids of core and vendored skills are `<sourceId>/<name>`. */
  sourceId: SkillSourceId
  /** Vendored skills: the upstream repo and pinned commit. */
  sourceRepo?: string
  sourceCommit?: string
  license?: string
  compatibility?: string
  metadata?: Record<string, string>
  /** The spec's `allowed-tools` (informational; never grants a tool). */
  allowedTools?: string[]
  /** True when the skill folder ships scripts. */
  hasScripts: boolean
  /** Paths relative to the skill folder, SKILL.md included; [] for store-only skills. */
  files: string[]
  /** On by default for new bots (BE-7 uses it). */
  defaultOn: boolean
}

export type SkillSourceId = 'core' | 'superpowers' | 'anthropics' | 'ecc' | 'custom'
export const SKILL_SOURCE_IDS: readonly SkillSourceId[] = ['core', 'superpowers', 'anthropics', 'ecc', 'custom']
/** Sources whose skills are vendored on disk and read-only. */
export const VENDORED_SKILL_SOURCES: readonly SkillSourceId[] = ['superpowers', 'anthropics', 'ecc']

/** GET /api/skills list item: a skill without its body. */
export type SkillSummary = Omit<Skill, 'content'>

/** GET /api/skills `sources` entry. */
export interface SkillSourceInfo {
  id: SkillSourceId
  repo: string | null
  commit: string | null
  license: string | null
  count: number
}

/** GET /api/skills response. */
export interface SkillListResponse {
  skills: SkillSummary[]
  sources: SkillSourceInfo[]
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

/**
 * How one attached skill went into a run's system prompt. 'catalog' (BE-7):
 * one catalog line, body loaded on demand with activate_skill. 'full' and
 * 'summary' appear only on runs recorded before BE-7.
 */
export type SkillPromptMode = 'full' | 'summary' | 'catalog'

/**
 * How a run prompt fits its endpoint (BE-7): skills listed as a catalog, or
 * 'too-large' when the catalog is over 25% of the window or the whole prompt
 * does not fit (the run may then be rejected with 413).
 */
export type PromptMode = 'catalog' | 'too-large'

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
  /** chars/4 estimate of the skill catalog section alone (0 without skills). */
  catalogTokens: number
  /** @deprecated Always [] since BE-7 (no summary mode); kept for older clients. */
  summarizedSkillIds: string[]
  /** Tools the run would offer, in the order sent upstream. */
  toolNames: string[]
  /** Tokens the agent's rules section adds (0 without rules). */
  rulesTokens: number
}

export interface AgentRun {
  id: string
  agentId: string
  /** BE-5: set on a run made for a group reply (its messages live in the group, not the DM). */
  groupId?: string
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
  /** Skills the model loaded with activate_skill, in first-use order (BE-7). */
  activatedSkills?: { id: string; name: string; source: string }[]
  /** Per-tool-call audit for runs that used the tool loop. */
  toolCalls?: { name: string; arguments: string; resultChars: number; ok: boolean }[]
  /** BE-3: file steps and files written this run (copied onto the reply's activity). */
  activity?: { steps: MessageActivity['steps']; filesChanged: FileChange[] }
  /** BE-3: files this run wrote, on every run (failed ones too); [] when none. Same entries as activity.filesChanged. */
  filesChanged?: FileChange[]
  /**
   * Set on runs made for a project task. Such runs only see earlier runs of
   * the same project as history, and the agent's own chat never sees them.
   */
  projectId?: string
}

/** Agent picture: one emoji, or an uploaded image stored under data/avatars/. */
export type InternetPolicy = 'ask' | 'always' | 'never'
export const INTERNET_POLICIES: readonly InternetPolicy[] = ['ask', 'always', 'never']
export const AGENT_SLUG = /^[a-z0-9-]{1,40}$/

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
  /** Immutable folder name, [a-z0-9-]{1,40}, unique; 'primary' for the Primary agent. Set by the server. */
  slug: string
  /** Phase 2 sandbox network rule; stored now. Default 'ask'. */
  internetPolicy: InternetPolicy
  /** "Learn from chat" toggle. Default true. */
  memoryLearn: boolean
  /** Phase 2 (BE-P2-1): the bot's own VM settings. Always present (load and create fill the defaults). */
  vm: AgentVm
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
  /** Optional since BE-8b (FE-5's card has none); defaults to ''. */
  instructions?: string
  modelId: string
  endpointId: string
  /** Create: honored only when no primary exists. Update: true transfers the role. */
  isPrimary?: boolean
  role: string
  /** 0–2. Omitted keeps the stored value (unset on create); null clears it back to the endpoint default. */
  temperature?: number | null
  skillIds: string[]
  /** Omitted keeps the stored value on update. */
  rules?: string[]
  /** null clears it. */
  color?: string | null
  pinned?: boolean
  hidden?: boolean
  /** Emoji only; images go through PUT /api/agents/:id/avatar. null clears it. */
  avatar?: { kind: 'emoji'; value: string } | null
  /** Omitted keeps the stored value (create: 'ask'). */
  internetPolicy?: InternetPolicy
  /**
   * M2 contract (BE-P2-15, Needs OK): create only. true turns the browser on for the new bot, the
   * same as PATCH /api/agents/:id/vm {permissions:{browser:true}} (download/rebuild start). Default false.
   */
  browser?: boolean
  /** Omitted keeps the stored value (create: true). */
  memoryLearn?: boolean
}

/** Retired (BE-1): kept only to describe what data/archive/projects-*.json holds. */
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
  /** Phase 2 global VM settings. Server-side; GET /api/settings leaves it out (use /api/vm/settings). */
  vm?: VmSettings
}

export const MAX_USER_NAME_CHARS = 80

/** The person using the workspace. onboardedAt stays null until first-run setup saves a name. */
export interface UserProfile {
  name: string
  avatar?: AgentAvatar
  onboardedAt: string | null
}

export interface UserProfileInput {
  name: string
  /** Emoji only; null clears; omitted keeps. Upload images with PUT /api/profile/avatar. */
  avatar?: { kind: 'emoji'; value: string } | null
}

export const OPENROUTER_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1'

/**
 * Testing placeholder for the default OpenAI-compatible endpoint: the seeded
 * endpoint points here (and the FE prefills it). Every endpoint stays editable
 * (OpenAI-compatible or OpenRouter); replace this for the final build.
 */
export const DEFAULT_ENDPOINT_BASE_URL = 'http://100.79.242.24:8791'

export interface Attachment {
  root: 'agent' | 'group'
  /** Relative to the root, forward slashes. */
  path: string
  name: string
  size: number
  mime: string
}

export interface MessageActivity {
  /** Skills activated during the run. */
  skills: { id: string; name: string; source: string }[]
  /** At most 20, server-written, redacted. */
  steps: { tool: string; summary: string; ok: boolean; path?: string }[]
  filesChanged: FileChange[]
}

/**
 * BE-3: one file a run wrote. bytes/modifiedAt are the file after the write (optional on old messages).
 * Phase 2: script runs and undo also report 'deleted' (bytes/modifiedAt then absent).
 */
export interface FileChange {
  path: string
  change: 'added' | 'modified' | 'deleted'
  bytes?: number
  modifiedAt?: string
  /** Phase 2 run diffs: which folder `path` is relative to (same shape as UndoPreview). Missing means 'agent' (Phase 1 shape). */
  root?: 'agent' | 'group'
  /** root 'group': the group the file belongs to, and its display name. */
  groupId?: string
  groupName?: string
}

export type ChatMessageKind = 'message' | 'system' | 'run' | 'permission'

/** One message in a chat-first conversation (independent of run pruning). */
export interface ChatMessage {
  id: string
  conversationId: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  /** The run that produced this message, when there was one. */
  runId?: string
  /** Set on an assistant message that is a failed run's error text (content holds the error). */
  error?: true
  /**
   * 'system' = a server-written line such as "You created Harbor team…". Absent = 'message'.
   * Phase 2: 'run' is a script-run card (scriptRunId set), 'permission' an internet or
   * browser request card (permissionRequestId set). Both are role 'assistant' with authorAgentId.
   */
  kind?: ChatMessageKind
  /** kind 'run': the ScriptRun this card shows (full run: GET /api/runs/:runId). */
  scriptRunId?: string
  /** kind 'run': a small summary kept in step with the run (also pushed as run.updated). */
  scriptRun?: ChatRunSummary
  /** kind 'permission': the PermissionRequest this card shows. */
  permissionRequestId?: string
  /** The agent that wrote an assistant message (required in groups). */
  authorAgentId?: string
  /** BE-5: on the lead's reply, the @mentioned bots left out by the 4-reply cap, in mention order. */
  skippedAgentIds?: string[]
  attachments?: Attachment[]
  activity?: MessageActivity
}

interface ConversationBase {
  id: string
  createdAt: string
  /** Time of the newest message (or creation). */
  updatedAt: string
  /** Assistant messages newer than this are unread; null = never opened. */
  lastReadAt: string | null
}

/** A 1:1 chat with one agent. One per agent, created lazily. */
export interface DmConversation extends ConversationBase {
  kind: 'dm'
  agentId: string
}

/** A group chat (BE-5). */
export interface GroupConversation extends ConversationBase {
  kind: 'group'
  name: string
  slug: string
  /** Includes the lead; 2–8 agents. */
  memberAgentIds: string[]
  /** Always the Primary agent's id (server-enforced). */
  leadAgentId: string
  memoryLearn: boolean
  /** Set when the group is deleted; archived groups are kept in the store but never listed or served. Server-only. */
  archivedAt?: string
}

export type Conversation = DmConversation | GroupConversation

export type ConversationSummary = Conversation & {
  lastMessage: ChatMessage | null
  unreadCount: number
  /** Agent currently producing a reply (groups and DMs), else null. */
  typingAgentId: string | null
}

export type FileZone = 'shared' | 'workspace' | 'memory' | 'skills' | 'meta'

export interface FileEntry {
  path: string
  name: string
  kind: 'file' | 'dir'
  size: number
  mime?: string
  modifiedAt: string
  /** UI badges: workspace "scripts write", memory/meta "managed", skills "read-only". */
  zone: FileZone
  /** Files the user sent in chat. */
  sharedAt?: string
  sharedInConversationId?: string
  /** 'user' or an agent id; group folders only. */
  addedBy?: 'user' | string
}

export interface FileListing {
  /** e.g. 'bots/primary/' */
  root: string
  path: string
  entries: FileEntry[]
  /** bytes includes the bot's trash (BE-3), which also counts toward the quota; trashBytes is that part. */
  usage: { bytes: number; quotaBytes: number; trashBytes: number }
  /** Files in the whole bot folder (not folders, not trash); the same for every path. */
  totalFiles: number
}

export type MemoryCategory = 'about-you' | 'preferences' | 'work' | 'other'
export const MEMORY_CATEGORIES: readonly MemoryCategory[] = ['about-you', 'preferences', 'work', 'other']
export const MAX_MEMORY_TEXT_CHARS = 500

export interface MemoryItem {
  id: string
  scope: { kind: 'agent'; agentId: string } | { kind: 'group'; groupId: string }
  /** 1–500 chars. */
  text: string
  category: MemoryCategory
  source: { kind: 'user' } | { kind: 'chat'; conversationId: string; runId: string; agentId: string }
  createdAt: string
  updatedAt: string
}

/** One entry of GET /api/archive/projects. */
export interface ProjectArchiveFile {
  name: string
  createdAt: string
  projectCount: number
}

export const CONVERSATION_PAGE_SIZE = 50
export const MAX_CONVERSATION_PAGE_SIZE = 200

/** BE-10: GET /api/search?q=&limit= (palette). Each list is capped at `limit`. */
export interface SearchResults {
  agents: { id: string; name: string }[]
  groups: { id: string; name: string }[]
  /** Newest first. `snippet` is ~120 chars around the first match. */
  messages: { conversationId: string; messageId: string; snippet: string; authorAgentId?: string; createdAt: string }[]
  /** Files only (no folders), newest first. `ownerId` is the agent id, or the group's conversation id. Paths are relative to that root. */
  files: { root: 'agent' | 'group'; ownerId: string; path: string; name: string; modifiedAt: string }[]
}

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
  /** M2 contract (Needs OK): see ScriptRunPermission (requestId is absent for grants without a card). */
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
  /** M2 contract (BE-P2-13/14, Needs OK): every host the run's proxy saw ("Sites used"); blocked ones always listed. */
  hostsContacted?: HostContact[]
  snapshot: { id: string; driver: SnapshotDriver; retainedBytes: number } | null
  undo: ScriptRunUndo
  /** kind 'undo': the run it reversed. */
  undoOfRunId?: string
  /** M2 contract (BE-P2-14, Needs OK): status 'waiting_permission' only: what it waits for. */
  waitingFor?: RunWaitingFor
  /** M2 contract (BE-P2-14, Needs OK): waitingFor 'permission': the pending request (its own, or another run's of the same bot while that one is pending). */
  waitingOnRequestId?: string
  /** M2 contract (BE-P2-21, Needs OK): kind 'tool_build' only. */
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
  /** M2 contract (Needs OK): history row "internet once" / "internet always". */
  internet?: InternetUse
  /** M2 contract (Needs OK): up to 3 reached host names, for the history row. */
  hosts?: string[]
  /** M2 contract (BE-P2-21, Needs OK): kind 'tool_build' only. */
  build?: ToolBuildInfo
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
  /** M2 contract (BE-P2-14, Needs OK): status 'waiting_permission': "Waiting for permission" / "Waiting for the browser". */
  waitingFor?: RunWaitingFor
  /** M2 contract (Needs OK): card meta "Internet" and "Browser" rows. */
  network?: ScriptRun['network']
  browser?: boolean
  internet?: InternetUse
  /** M2 contract (Needs OK): "Sites used" (blocked hosts first, at most 20 entries). */
  hostsContacted?: HostContact[]
  /** M2 contract (Needs OK): failed / denied runs: ScriptRun.reason, so the card can pick its error row. */
  reason?: string
  /** M2 contract (Needs OK): failed / denied / stopped runs: ScriptRun.error (shown as is). */
  error?: string
  /** M2 contract (BE-P2-21, Needs OK): kind 'tool_build' only. */
  build?: ToolBuildInfo
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
  /** M2 contract (BE-P2-14, Needs OK): 'user' when the user answered; absent for 'timeout' and when the run ended first. */
  resolvedBy?: 'user'
  /** M2 contract (Needs OK): status 'denied' without an answer: the run was stopped (or ended) while the card was pending. */
  closedBy?: 'run_stopped' | 'run_ended'
  /** M2 contract (Needs OK): what the card names: "To run fetch_rates.py" / "the tool build". */
  runKind?: ScriptRunKind
  scriptName?: string
  /** M2 contract (Needs OK): group chats: the group (the card says "in <group>"). */
  groupId?: string
  /** M2 contract (Needs OK): type 'browser': the run also needs the internet and the policy is ask ("Next: internet"). */
  internetNext?: boolean
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
  /** M2 contract (BE-P2-15, Needs OK): this bot's browser setup (absent = off with no history). */
  browser?: BotBrowserInfo
  /** M2 contract (BE-P2-21, Needs OK): the bot's tool build in progress ("Building tools" head). */
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
  | { type: 'vm.updated'; agentId: string; vm: VmInfo }
  /** M2 contract (BE-P2-15, Needs OK): the shared Chromium download; sent to every subscriber (no filter applies). */
  | { type: 'browser.updated'; browser: BrowserAddonInfo }

/** GET /api/agents/:id/vm/tools. tools is absent until the first manifest refresh. */
export interface VmToolsInfo {
  agentId: string
  tools?: ToolManifest
  packages: string[]
  image: AgentVm['image']
  /** True when POST /vm/tools/rollback has a previous generation to go back to. */
  canRollback: boolean
  /** M2 contract (BE-P2-21, Needs OK): the build in progress (Rebuild / rollback answer 409 build_active meanwhile). */
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
}
/** POST /api/permissions/:requestId body. Requires header PERMISSION_CSRF_HEADER: '1' (403 without; 409 when already resolved). */
export interface PermissionAnswer {
  decision: PermissionDecision
}
export const PERMISSION_CSRF_HEADER = 'x-agentcontrol-confirm'

/* ───────────────────────── Phase 2 M2 contract (BE-P2-14/15/21): shapes only, every item Needs OK ───────────────────────── */

/** How a ScriptRun got (or didn't get) a permission. */
export interface ScriptRunPermission {
  type: PermissionType
  decision: PermissionDecision | 'timeout' | 'pending'
  /** The card's PermissionRequest; absent when no card was shown (policy Always, a user Rebuild click). */
  requestId?: string
  /** 'card': answered on a card; 'policy': the bot's rule (Always, or browser already on); 'rebuild': the user's Rebuild click (one-build grant). */
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
  /** The resolved IP that was checked; absent for names refused before resolving (*.lan, *.ts.net, …). */
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

/** VmInfo.activeBuild / VmToolsInfo.activeBuild. */
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

/** M2 error reasons (409/400/403/404/507; 5xx bodies keep no reason, as in M1). */
export type M2ErrorReason =
  | 'bad_decision' | 'egress_reserved' | 'confirm_required' | 'user_only' | 'not_found'
  | 'already_resolved' | 'browser_in_use' | 'browser_busy' | 'build_active' | 'run_active' | 'internet_never'
  | 'proxy_unavailable' | 'low_disk' | 'nothing_to_retry'
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
