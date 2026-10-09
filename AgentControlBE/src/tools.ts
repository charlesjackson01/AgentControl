/**
 * Built-in workspace tool registry. Skills declare tool names; execution
 * resolves against this Map. Adding a tool later = one entry (phase 2 adds
 * user-defined handlers).
 */
import type { WorkspaceStore } from './store.js'
import type { ToolCall } from './upstream.js'

export interface ToolContext {
  store: WorkspaceStore
  /** Agent whose run triggered the call; read_run_log defaults to it. */
  agentId: string
}

export interface ToolDefinition {
  description: string
  parameters: object
  handler(args: Record<string, unknown>, ctx: ToolContext): unknown
}

export interface ToolOutcome {
  content: string
  ok: boolean
}

/** Handlers are in-process, but keep the discipline anyway. */
export const TOOL_TIMEOUT_MS = 5_000

const NO_PARAMS = { type: 'object', properties: {}, additionalProperties: false }

function clip(value: unknown): unknown {
  return typeof value === 'string' && value.length > 500 ? value.slice(0, 500) : value
}

export const builtinTools = new Map<string, ToolDefinition>([
  [
    'list_agents',
    {
      description: 'List every agent in the workspace with its id, name, and model id.',
      parameters: NO_PARAMS,
      handler: (_args, ctx) =>
        ctx.store.agents.map((a) => ({ id: a.id, name: a.name, modelId: a.modelId })),
    },
  ],
  [
    'list_skills',
    {
      description: 'List every skill in the workspace with its id, name, and description.',
      parameters: NO_PARAMS,
      handler: (_args, ctx) =>
        ctx.store.skills.map((s) => ({ id: s.id, name: s.name, description: s.description })),
    },
  ],
  [
    'read_run_log',
    {
      description:
        'Read the most recent runs for an agent (defaults to the current one), newest first.',
      parameters: {
        type: 'object',
        properties: {
          agentId: {
            type: 'string',
            description: 'Agent id to read runs for. Defaults to the current agent.',
          },
          limit: { type: 'number', description: 'Max runs to return, 1-10 (default 5).' },
        },
      },
      handler: (args, ctx) => {
        const agentId =
          typeof args.agentId === 'string' && args.agentId.trim() !== ''
            ? args.agentId.trim()
            : ctx.agentId
        const requested =
          typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.floor(args.limit) : 5
        const limit = Math.min(Math.max(requested, 1), 10)
        return ctx.store.runs
          .filter((r) => r.agentId === agentId)
          .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
          .slice(0, limit)
          .map((r) => ({
            id: r.id,
            status: r.status,
            startedAt: r.startedAt,
            durationMs: r.durationMs,
            input: clip(r.input),
            output: clip(r.output),
            error: clip(r.error),
          }))
      },
    },
  ],
])

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
 * Execute one model-requested call. Never throws: unknown tools, bad JSON,
 * and timeouts all come back as error text so the model can recover.
 */
export async function executeToolCall(call: ToolCall, ctx: ToolContext): Promise<ToolOutcome> {
  const definition = builtinTools.get(call.name)
  if (!definition) {
    return {
      content: `Unknown tool "${call.name}". Available: ${[...builtinTools.keys()].join(', ')}`,
      ok: false,
    }
  }

  let args: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(call.arguments.trim() === '' ? '{}' : call.arguments)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        content: `Tool arguments must be a JSON object, got: ${call.arguments.slice(0, 200)}`,
        ok: false,
      }
    }
    args = parsed as Record<string, unknown>
  } catch {
    return {
      content: `Invalid JSON in tool arguments: ${call.arguments.slice(0, 200)}`,
      ok: false,
    }
  }

  try {
    const value = await withTimeout(
      Promise.resolve().then(() => definition.handler(args, ctx)),
      TOOL_TIMEOUT_MS,
    )
    return { content: typeof value === 'string' ? value : JSON.stringify(value), ok: true }
  } catch (err) {
    return {
      content: `Tool "${call.name}" failed: ${err instanceof Error ? err.message : String(err)}`,
      ok: false,
    }
  }
}
