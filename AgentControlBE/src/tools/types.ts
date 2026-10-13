/**
 * Contract shared by every built-in tool module (src/tools/*.ts). Modules may
 * import store/app/upstream types only (`import type`) so the registry can be
 * loaded first without cycles (seed.ts resolves declarations at module load).
 */
import type { WorkspaceStore } from '../store.js'

export type ToolCategory = 'workspace' | 'notes' | 'time' | 'math' | 'text' | 'data'
export type ToolEffect = 'read' | 'write'

export interface ToolContext {
  store: WorkspaceStore
  /** Agent whose run triggered the call (default target for agent lookups). */
  agentId: string
  /** Id the run will be saved under (notes record it). */
  runId: string
  /**
   * D-O10: the project of a project task run; unset for an agent's own chat.
   * Tools that read runs see only runs with this same projectId (undefined
   * matching undefined), the rule executeRun's history uses.
   */
  projectId?: string
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
   * Skill ids get_skill may read. Set when the prompt planner offered
   * get_skill on its own to read the agent's summarized skills; unset when an
   * attached skill declares get_skill (then any skill is readable).
   */
  skillScope?: ReadonlySet<string>
}

/**
 * Text-content parameters that accept `"@input"` (this run's message) or
 * `"@note:<id|title>"` instead of literal text. Refs are resolved centrally in
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
  /** Return a JSON-serializable value or a string; throw Error('…') for bad input. */
  handler(args: Record<string, unknown>, ctx: ToolContext): unknown
}
