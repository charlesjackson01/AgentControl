/* Pure apart from the injected request: one-field agent saves. tests/agent-patch.test.mjs */
import type { Agent, AgentInput } from './types.ts'
import { agentPutBody } from './agent-put.ts'
import { isRouteMissing } from './route-missing.ts'

type Req = <T>(path: string, init?: RequestInit) => Promise<T>
export type AgentChange = Partial<Pick<AgentInput, 'skillIds' | 'memoryLearn' | 'internetPolicy'>>

/**
 * BE-4 `PATCH /api/agents/:id` takes any subset of the PUT fields and returns the
 * full agent. Until it lands (Fastify "Route … not found" 404, or 405), fall back
 * to today's PUT with the core fields resent. A real 404 (no such agent) throws.
 */
export async function saveAgentChange(request: Req, agent: Agent, change: AgentChange): Promise<{ agent: Agent; via: 'patch' | 'put' }> {
  const path = `/api/agents/${encodeURIComponent(agent.id)}`
  try {
    return { agent: await request<Agent>(path, { method: 'PATCH', body: JSON.stringify(change) }), via: 'patch' }
  } catch (err) {
    if (!isRouteMissing(err)) throw err
  }
  return { agent: await request<Agent>(path, { method: 'PUT', body: JSON.stringify(agentPutBody(agent, change)) }), via: 'put' }
}
