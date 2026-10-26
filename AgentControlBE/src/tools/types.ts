/**
 * Contract shared by every built-in tool module (src/tools/*.ts). Modules may
 * import store/app/upstream types only (`import type`) so the registry can be
 * loaded first without cycles (seed.ts resolves declarations at module load).
 */
import type { FileChange, MemoryItem } from '../shared/types.js'
import type { WorkspaceStore } from '../store.js'

export type ToolCategory = 'workspace' | 'memory' | 'time' | 'math' | 'text' | 'data' | 'files'
export type ToolEffect = 'read' | 'write'

export interface ToolContext {
  store: WorkspaceStore
  /** Agent whose run triggered the call (default target for agent lookups). */
  agentId: string
  /**
   * D-O10: set when the run belongs to a project task. read_run_log then
   * keeps only runs of the same project (the same rule executeRun's history
   * filter uses), so a run cannot read other projects' runs.
   */
  projectId?: string
  /** Id the run will be saved under (notes record it). */
  runId: string
  /** This run's user message; `"@input"` content refs resolve to it. */
  input: string
  /** Registry tool names offered in this run; every other name is refused. */
  allowed: ReadonlySet<string>
  now(): Date
  /** IANA zone used when a tool is not given one (the server's resolved zone). */
  timeZone: string
  /** Per-run counters shared by all calls of one run (save_note write cap). */
  writes: { count: number }
  /**
   * Result size the run's context window can still hold, set by the run loop
   * before each call. Paging tools shrink their page to it, so the loop never
   * has to cut their JSON (and nextOffset stays exact). Unset: RESULT_MAX_CHARS.
   */
  resultMaxChars?: number
  /**
   * Optional limit on the skill ids get_skill may read. Since BE-7 the run
   * loop leaves it unset: get_skill is an audit read of any library skill,
   * and activate_skill (catalogSkillIds) loads the agent's own skills.
   */
  skillScope?: ReadonlySet<string>
  /**
   * BE-7: the agent's catalog skill ids. activate_skill and read_skill_file
   * read only these (no access to skills the agent does not have).
   */
  catalogSkillIds?: ReadonlySet<string>
  /** BE-7: skills activate_skill loaded this run, in first-use order (keyed by id). */
  activatedSkills?: Map<string, { id: string; name: string; source: string }>
  /** BE-4: memory this run reads and writes (DM: the bot's; group: the group's). Unset: no memory tools. */
  memoryScope?: MemoryItem['scope']
  /** BE-4: memoryLearn for that scope; remember is offered only when true. */
  memoryLearn?: boolean
  /** BE-4: conversation the run belongs to (recorded as the memory source). */
  conversationId?: string
  /** BE-4: remember calls this run (capped per run). */
  memoryWrites?: { count: number }
  /** BE-3: set for a group run; file tools then also see the group's shared/ as `group:shared/...`. */
  group?: { id: string; slug: string }
  /** BE-3: this run's files (src/file-service.ts). Unset: file tools refuse. */
  files?: FileService
  /** BE-3: what this run did with files (shown on the reply's activity). */
  activity?: RunActivity
}

export interface FileItem { path: string; kind: 'file' | 'folder'; size?: number; modifiedAt: string }
export interface SearchHit { path: string; match: 'name' | 'text'; line?: number; text?: string }

/**
 * BE-3: what file tools may do on disk. Paths are the model's relative paths
 * ('workspace/a.md', 'group:shared/a.md'); errors are thrown as plain Error
 * messages meant for the model. Tests can pass a fake.
 */
export interface FileService {
  list(path: unknown, opts: { recursive: boolean; max: number }): { path: string; entries: FileItem[]; truncated: boolean }
  /** text is null for binary files and files over the read cap (tooLarge). */
  read(path: unknown): { path: string; size: number; mime: string; modifiedAt: string; text: string | null; tooLarge: boolean }
  search(query: string, path: unknown, opts: { maxHits: number }): { hits: SearchHit[]; truncated: boolean }
  write(path: unknown, content: string, mode: 'create' | 'overwrite' | 'append'): FileChange & { bytes: number; modifiedAt: string }
  makeFolder(path: unknown): { path: string; created: boolean }
}

/** BE-3: per-run activity the file tools add to (steps by the run loop, filesChanged by write tools). */
export interface RunActivity {
  steps: { tool: string; summary: string; ok: boolean; path?: string }[]
  filesChanged: FileChange[]
}

/**
 * Text-content parameters that accept `"@input"` (this run's message) or
 * nothing else (BE-4 retired `"@note:"`) instead of literal text. Refs are resolved centrally in
 * executeToolCall before the handler runs; handlers then apply their own caps.
 */
export interface ContentParams {
  names: string[]
  /** Param treated as `"@input"` when omitted (single-content tools). */
  defaultParam?: string
  /** JSON/CSV: `"@input"` resolves to the message's first fenced code block, if any. */
  structured?: boolean
}

export interface ToolEntry {
  name: string
  category: ToolCategory
  effect: ToolEffect
  /** ≤240 chars, includes one example argument object. */
  description: string
  /** Flat JSON Schema object (llama.cpp grammar-friendly). */
  parameters: object
  contentParams?: ContentParams
  /** Largest result the run loop keeps for this tool (default: its TOOL_RESULT_MAX_CHARS). */
  maxResultChars?: number
  /** Return a JSON-serializable value or a string; throw Error('…') for bad input. */
  handler(args: Record<string, unknown>, ctx: ToolContext): unknown
  /** BE-3: a step line for the reply's activity (e.g. "Read shared/x.pdf"); tools without it add no step. */
  /** BE-3: the step line for the reply's activity; `failed` is used when the call failed. */
  activity?(args: Record<string, unknown>): { summary: string; failed?: string; path?: string }
}
