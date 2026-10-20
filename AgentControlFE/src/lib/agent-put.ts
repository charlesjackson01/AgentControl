/* Pure: full PUT /api/agents/:id body from the stored agent plus a change. (tests/bot-settings.test.mjs) */
import type { Agent, AgentInput } from './types.ts'

/**
 * PUT requires name, endpointId, modelId and resets `skillIds` to [] when it's
 * missing, so a one-field change (a skill toggle, "Learn from chat") must resend
 * the core fields from the stored agent. Optional profile fields are omitted, so
 * the BE keeps them (avatar, colour, rules, pinned, hidden, internetPolicy…).
 */
export function agentPutBody(agent: Agent, change: Partial<Pick<AgentInput, 'skillIds' | 'memoryLearn' | 'internetPolicy'>>): AgentInput {
  const body = {
    name: agent.name,
    role: agent.role ?? '',
    description: agent.description,
    instructions: agent.instructions,
    modelId: agent.modelId,
    endpointId: agent.endpointId,
    // Only resend a temperature the agent has; omitted lets the BE keep its default.
    ...(agent.temperature !== undefined ? { temperature: agent.temperature } : {}),
    skillIds: [...agent.skillIds],
    ...change,
  }
  return body as AgentInput
}

/** BE-1 fields with their contract defaults when an older BE leaves them out. */
export function agentChatFirstFields(agent: Pick<Agent, 'slug' | 'internetPolicy' | 'memoryLearn'>) {
  return {
    slug: agent.slug ?? null,
    internetPolicy: agent.internetPolicy ?? 'ask',
    memoryLearn: agent.memoryLearn ?? true,
  }
}

export const INTERNET_POLICY_LABELS = { ask: 'Ask each time', always: 'Always allow', never: 'Never' } as const

/** "bots/primary/" for the header; null before BE-1 sends a slug. */
export function botFolder(slug: string | null | undefined): string | null {
  return slug ? `bots/${slug}/` : null
}
