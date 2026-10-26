/* Pure apart from the injected request: one-field agent saves. tests/agent-patch.test.mjs */
import type { Agent, AgentInput } from './types.ts'

type Req = <T>(path: string, init?: RequestInit) => Promise<T>
export type AgentChange = Partial<Pick<AgentInput, 'skillIds' | 'memoryLearn' | 'internetPolicy' | 'temperature'>>

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

/**
 * "Learn from chat" toggle (MemoryTab): PATCH `{ memoryLearn: <boolean> }` (BE-4 c4d4f52
 * answers a wrong type with 400). On failure the toggle goes back to where it was and the
 * server's message is shown.
 */
export async function saveLearnToggle(
  save: (change: AgentChange) => Promise<{ agent: Agent }>,
  on: boolean,
  messageOf: (err: unknown) => string,
): Promise<{ learn: boolean; agent: Agent | null; error: string | null }> {
  try {
    const { agent } = await save({ memoryLearn: on === true })
    return { learn: agent.memoryLearn ?? on, agent, error: null }
  } catch (err) {
    return { learn: !on, agent: null, error: messageOf(err) }
  }
}

/**
 * Edit save: PUT the form (no `temperature` key, so the stored value is kept), then,
 * only when the temperature changed, PATCH `{ temperature }` (a number, or null to go
 * back to the endpoint default). Returns the final agent.
 */
export async function saveAgentEdit(
  request: Req,
  agentId: string,
  put: Omit<AgentInput, 'temperature'>,
  temperaturePatch: { temperature: number | null } | null,
): Promise<Agent> {
  const path = `/api/agents/${encodeURIComponent(agentId)}`
  const saved = await request<Agent>(path, { method: 'PUT', body: JSON.stringify(put) })
  if (!temperaturePatch) return saved
  return (await saveAgentChange(request, saved, temperaturePatch)).agent
}
