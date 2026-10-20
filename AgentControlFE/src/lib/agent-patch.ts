/* Pure apart from the injected request: one-field agent saves. tests/agent-patch.test.mjs */
import type { Agent, AgentInput } from './types.ts'

type Req = <T>(path: string, init?: RequestInit) => Promise<T>
export type AgentChange = Partial<Pick<AgentInput, 'skillIds' | 'memoryLearn' | 'internetPolicy'>>

/**
 * BE-4 `PATCH /api/agents/:id`: any subset of the PUT fields; returns the full
 * agent. PATCH only (BE-4 4c35e03 has it); errors, including 404, are thrown.
 */
export async function saveAgentChange(request: Req, agent: Pick<Agent, 'id'>, change: AgentChange): Promise<{ agent: Agent }> {
  const path = `/api/agents/${encodeURIComponent(agent.id)}`
  return { agent: await request<Agent>(path, { method: 'PATCH', body: JSON.stringify(change) }) }
}

/**
 * Create: send `memoryLearn` only when the form changed it from the default (on),
 * so the server's default-on still applies otherwise.
 */
export function createLearnField(formLearn: boolean | undefined): { memoryLearn?: boolean } {
  return formLearn === false ? { memoryLearn: false } : {}
}
