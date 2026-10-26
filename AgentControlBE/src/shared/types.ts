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
  filesChanged: { path: string; change: 'added' | 'modified' }[]
}

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
  /** 'system' = a server-written line such as "You created Harbor team…". Absent = 'message'. */
  kind?: 'message' | 'system'
  /** The agent that wrote an assistant message (required in groups). */
  authorAgentId?: string
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
  usage: { bytes: number; quotaBytes: number }
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
