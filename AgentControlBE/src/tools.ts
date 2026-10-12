/**
 * Built-in tool registry. Tools live in src/tools/<category>.ts (see
 * src/tools/types.ts for the contract); this facade builds the name → entry
 * Map in a fixed order (the original three first), resolves skill tool
 * declarations against it, and executes model-requested calls safely.
 */
import type { SkillTool } from './shared/types.js'
import type { ToolCall } from './upstream.js'
import { dataTools } from './tools/data.js'
import { mathTools } from './tools/math.js'
import { notesTools } from './tools/notes.js'
import { resolveContentRefs } from './tools/refs.js'
import { redactSecrets } from './tools/redact.js'
import { clipText, RESULT_MAX_CHARS } from './tools/limits.js'
import { textTools } from './tools/text.js'
import { timeTools } from './tools/time.js'
import type { ToolCategory, ToolContext, ToolEffect, ToolEntry } from './tools/types.js'
import { workspaceTools } from './tools/workspace.js'

export type { ToolCategory, ToolContext, ToolEffect, ToolEntry } from './tools/types.js'

export interface ToolOutcome {
  content: string
  ok: boolean
}

/** Handlers are in-process; this cannot interrupt a synchronous loop, so handlers cap their inputs. */
export const TOOL_TIMEOUT_MS = 5_000
/** Raw `arguments` larger than this are refused before JSON.parse. */
export const MAX_TOOL_ARGUMENT_CHARS = 64_000

export const builtinTools: ReadonlyMap<string, ToolEntry> = (() => {
  const map = new Map<string, ToolEntry>()
  for (const entry of [...workspaceTools, ...notesTools, ...timeTools, ...mathTools, ...textTools, ...dataTools]) {
    if (map.has(entry.name)) throw new Error(`Duplicate built-in tool "${entry.name}"`)
    map.set(entry.name, entry)
  }
  return map
})()

/** A registry tool as served by GET /api/tools. */
export interface ToolInfo extends SkillTool {
  category: ToolCategory
  effect: ToolEffect
}

export function listToolInfo(): ToolInfo[] {
  return [...builtinTools.values()].map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
    category: t.category,
    effect: t.effect,
  }))
}

/** The declaration a skill stores (and the run sends upstream) for a registry tool. */
export function toolDeclaration(name: string): SkillTool | undefined {
  const entry = builtinTools.get(name)
  return entry ? { name: entry.name, description: entry.description, parameters: entry.parameters } : undefined
}

/**
 * Map tool names to registry declarations, deduped in order. Unknown names
 * (and names past `max`) are returned in `ignored`; `strict` throws instead
 * (seed loading, where an unknown name is a bug).
 */
export function resolveToolDeclarations(
  names: string[],
  opts: { strict?: boolean; max?: number } = {},
): { tools: SkillTool[]; ignored: string[] } {
  const tools: SkillTool[] = []
  const ignored: string[] = []
  for (const name of [...new Set(names)]) {
    const decl = toolDeclaration(name)
    if (!decl || (opts.max !== undefined && tools.length >= opts.max)) ignored.push(name)
    else tools.push(decl)
  }
  if (opts.strict && ignored.length > 0) {
    throw new Error(`Unknown built-in tool(s): ${ignored.join(', ')}. Available: ${[...builtinTools.keys()].join(', ')}`)
  }
  return { tools, ignored }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

/**
 * Execute one model-requested call. Never throws: names outside this run's
 * offered tools, oversized or bad JSON, handler errors and timeouts all come
 * back as `ok: false` text the model can act on. Output is redacted.
 */
export async function executeToolCall(call: ToolCall, ctx: ToolContext): Promise<ToolOutcome> {
  const fail = (content: string): ToolOutcome => ({ content: clipText(redactSecrets(content, ctx.store), RESULT_MAX_CHARS), ok: false })
  const name = call.name.slice(0, 64)
  const offered = [...ctx.allowed].join(', ') || 'none'

  const entry = builtinTools.get(call.name)
  if (!entry) return fail(`Unknown tool "${name}". Available: ${offered}`)
  if (!ctx.allowed.has(entry.name)) return fail(`Tool "${name}" is not enabled for this agent. Available: ${offered}`)

  if (call.arguments.length > MAX_TOOL_ARGUMENT_CHARS) {
    return fail(
      `Tool arguments are too large (${call.arguments.length} chars, max ${MAX_TOOL_ARGUMENT_CHARS}). ` +
        'Pass "@input" or "@note:<id>" instead of pasting the text.',
    )
  }

  let args: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(call.arguments.trim() === '' ? '{}' : call.arguments)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return fail(`Tool arguments must be a JSON object, got: ${call.arguments.slice(0, 200)}`)
    }
    args = parsed as Record<string, unknown>
  } catch {
    return fail(`Invalid JSON in tool arguments: ${call.arguments.slice(0, 200)}`)
  }

  try {
    const { args: resolved, sources } = resolveContentRefs(entry.contentParams, args, ctx)
    let value = await withTimeout(
      Promise.resolve().then(() => entry.handler(resolved, ctx)),
      TOOL_TIMEOUT_MS,
    )
    if (Object.keys(sources).length > 0 && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      value = { ...(value as Record<string, unknown>), sources }
    }
    // JSON.stringify(undefined) is undefined; never hand the loop a non-string.
    const content = typeof value === 'string' ? value : (JSON.stringify(value) ?? 'null')
    return { content: redactSecrets(content, ctx.store), ok: true }
  } catch (err) {
    return fail(`Tool "${name}" failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}
