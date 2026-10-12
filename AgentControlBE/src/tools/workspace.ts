/**
 * Workspace introspection tools (read-only). Never return endpoint URLs,
 * cached model lists, API keys, the auth token, run system prompts or
 * tool-call arguments: results may be sent to a hosted provider.
 */
import { argError, findAgent, readNumber, readString } from './args.js'
import { clipText, fitJson } from './limits.js'
import type { ToolEntry } from './types.js'

const NO_PARAMS = { type: 'object', properties: {}, additionalProperties: false }

function clip(value: unknown): unknown {
  return typeof value === 'string' && value.length > 500 ? value.slice(0, 500) : value
}

export const workspaceTools: ToolEntry[] = [
  {
    name: 'list_agents',
    category: 'workspace',
    effect: 'read',
    description:
      'List every agent in the workspace: id, name, role, whether it is the Team Lead (isPrimary), status, and model id. Example: {}',
    parameters: NO_PARAMS,
    // No fitJson: the run loop's clip is the backstop (pinned by a test).
    handler: (_args, ctx) =>
      ctx.store.agents.map((a) => ({
        id: a.id,
        name: a.name,
        role: a.role,
        isPrimary: a.isPrimary,
        status: a.status,
        modelId: a.modelId,
      })),
  },
  {
    name: 'list_skills',
    category: 'workspace',
    effect: 'read',
    description: 'List every skill in the workspace with its id, name, and description. Example: {}',
    parameters: NO_PARAMS,
    handler: (_args, ctx) => fitJson(
      ctx.store.skills.map((s) => ({ id: s.id, name: s.name, description: clipText(s.description, 100) })),
    ),
  },
  {
    name: 'read_run_log',
    category: 'workspace',
    effect: 'read',
    description:
      'Read recent runs for an agent (default: you), newest first: status, timing, input, output, error. Example: {"agentId": "Researcher", "limit": 3}',
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Agent id or name. Defaults to the current agent.' },
        limit: { type: 'number', description: 'Max runs to return, 1-10 (default 5).' },
      },
      additionalProperties: false,
    },
    handler: (args, ctx) => {
      const example = { agentId: 'Researcher', limit: 3 }
      const ref = readString(args, 'agentId', { max: 200, example })?.trim()
      let agentId = ctx.agentId
      if (ref) {
        const agent = findAgent(ctx.store, ref)
        if (!agent) throw argError(`No agent "${ref.slice(0, 60)}". Use list_agents for ids and names.`, example)
        agentId = agent.id
      }
      const requested = readNumber(args, 'limit', { example }) ?? 5
      const limit = Math.min(Math.max(Math.floor(requested), 1), 10)
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
]
