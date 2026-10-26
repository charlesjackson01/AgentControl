/**
 * BE-8: sandbox settings stub (the bot VM arrives in Phase 2) and the setup
 * helpers behind the /new bot card: creation defaults and a model-written draft.
 */
import { existsSync } from 'node:fs'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { botRoot, folderBytes } from './files.js'
import { fail } from './http.js'
import { INTERNET_POLICIES, MAX_AGENT_RULE_CHARS, MAX_AGENT_RULES, type Agent, type InternetPolicy, type Skill } from './shared/types.js'
import type { WorkspaceStore } from './store.js'
import { chatCompletion } from './upstream.js'

export const SANDBOX_LIMITS = { cpus: 2, memoryMb: 1024, timeoutSec: 60, pids: 256, outputMb: 200, diskQuotaMb: 500 } as const
export const VM_NOT_AVAILABLE = { status: 'not-available', phase: 2, message: 'Bot VM arrives in Phase 2' } as const

export interface SandboxInfo {
  internetPolicy: InternetPolicy
  vm: typeof VM_NOT_AVAILABLE
  limits: typeof SANDBOX_LIMITS
  usage: { bytes: number }
  runs: never[]
}

export function sandboxInfo(store: WorkspaceStore, agent: Agent): SandboxInfo {
  const root = botRoot(store, agent)
  return {
    internetPolicy: agent.internetPolicy,
    vm: VM_NOT_AVAILABLE,
    limits: SANDBOX_LIMITS,
    usage: { bytes: existsSync(root) ? folderBytes(root) : 0 },
    runs: [],
  }
}

export interface AgentDefaults {
  skills: { sourceId: string; count: number }[]
  internetPolicy: InternetPolicy
  endpointId: string
  modelId: string
}

/** Where a new bot starts: the default-on skills by source, and Primary's endpoint and model. */
export function agentDefaults(store: WorkspaceStore, defaultSkillIds: string[]): AgentDefaults {
  const counts = new Map<string, number>()
  for (const id of defaultSkillIds) {
    const skill = store.skills.find((s: Skill) => s.id === id)
    if (skill) counts.set(skill.sourceId, (counts.get(skill.sourceId) ?? 0) + 1)
  }
  const primary = store.agents.find((a) => a.isPrimary)
  const endpoint = (primary && store.endpoints.find((e) => e.id === primary.endpointId)) ?? store.endpoints[0]
  const modelId = primary && endpoint && primary.endpointId === endpoint.id ? primary.modelId : (endpoint?.defaultModel ?? '')
  return {
    skills: [...counts].map(([sourceId, count]) => ({ sourceId, count })),
    internetPolicy: 'ask',
    endpointId: endpoint?.id ?? '',
    modelId,
  }
}

export const MAX_DRAFT_PROMPT_CHARS = 2_000
const DRAFT_TIMEOUT_MS = 30_000
const DRAFT_MAX_TOKENS = 600

export const DraftSchema = z.object({
  name: z.string().trim().min(1).max(60),
  role: z.string().trim().max(80),
  description: z.string().trim().max(300),
  avatarEmoji: z.string().trim().max(16).refine((v) => !/[\s<>]/.test(v), 'one emoji, no spaces'),
  rules: z.array(z.string().trim().min(1).max(MAX_AGENT_RULE_CHARS)).max(MAX_AGENT_RULES),
})
export type BotDraft = z.infer<typeof DraftSchema>
export const BLANK_DRAFT: BotDraft = { name: '', role: '', description: '', avatarEmoji: '', rules: [] }

const DRAFT_SYSTEM = [
  'You design chat assistant bots. Reply with one JSON object and nothing else, with exactly these keys:',
  '{"name": string (1-60 chars), "role": string (<= 80 chars), "description": string (<= 300 chars),',
  ` "avatarEmoji": string (one emoji), "rules": string[] (0-${MAX_AGENT_RULES} short rules for how the bot behaves)}`,
].join('\n')

/** The JSON object in a reply: the whole text, a ```json fence, or the outermost {...}. */
export function extractJson(text: string): unknown {
  const candidates = [text.trim()]
  const fence = /```(?:json)?\s*\n([\s\S]*?)```/i.exec(text)
  if (fence?.[1]) candidates.push(fence[1].trim())
  const open = text.indexOf('{')
  const close = text.lastIndexOf('}')
  if (open !== -1 && close > open) candidates.push(text.slice(open, close + 1))
  for (const c of candidates) {
    try { return JSON.parse(c) } catch { /* next */ }
  }
  return undefined
}

export async function draftBot(store: WorkspaceStore, prompt: string): Promise<BotDraft & { warning?: string }> {
  const blank = (warning: string) => ({ ...BLANK_DRAFT, rules: [], warning })
  const primary = store.agents.find((a) => a.isPrimary)
  const endpoint = primary && store.endpoints.find((e) => e.id === primary.endpointId)
  if (!primary || !endpoint) return blank('No Primary bot with an endpoint to write the draft. Fill it in by hand.')
  const result = await chatCompletion(
    endpoint.baseUrl,
    store.endpointKeys[endpoint.id],
    primary.modelId,
    [{ role: 'system', content: DRAFT_SYSTEM }, { role: 'user', content: prompt }],
    Math.min(endpoint.timeoutMs ?? DRAFT_TIMEOUT_MS, DRAFT_TIMEOUT_MS),
    DRAFT_MAX_TOKENS,
    undefined,
    0.2,
    undefined,
    endpoint.proxyUrl,
    { disableThinking: endpoint.disableThinking === true },
  ).catch(() => null)
  if (!result?.ok) return blank("Primary couldn't write a draft right now. Fill it in by hand.")
  const parsed = DraftSchema.safeParse(extractJson(result.content))
  if (!parsed.success) return blank("Primary's draft wasn't usable. Fill it in by hand.")
  return parsed.data
}

export function registerSandboxRoutes(app: FastifyInstance, store: WorkspaceStore, deps: { defaultSkillIds: () => string[] }): void {
  const agentOf = (id: string): Agent => {
    const agent = store.agents.find((a) => a.id === id)
    if (!agent) fail(404, `No agent with id "${id}"`)
    return agent
  }

  app.get('/api/agents/:id/sandbox', async (request) => sandboxInfo(store, agentOf((request.params as { id: string }).id)))

  app.patch('/api/agents/:id/sandbox', async (request) => {
    const agent = agentOf((request.params as { id: string }).id)
    const body = request.body
    if (body === null || typeof body !== 'object' || Array.isArray(body)) fail(400, 'Send a JSON object, e.g. {"internetPolicy":"ask"}.')
    const raw = body as Record<string, unknown>
    const extra = Object.keys(raw).filter((k) => k !== 'internetPolicy')
    if (extra.length > 0) fail(400, `Only "internetPolicy" can change here (got "${extra[0]!.slice(0, 40)}"). Limits are fixed until Phase 2.`)
    if (raw.internetPolicy !== undefined) {
      if (!INTERNET_POLICIES.includes(raw.internetPolicy as InternetPolicy)) fail(400, '"internetPolicy" must be "ask", "always" or "never".')
      const next: Agent = { ...agent, internetPolicy: raw.internetPolicy as InternetPolicy }
      const previous = store.agents
      store.agents = store.agents.map((a) => (a.id === agent.id ? next : a))
      if (!store.save()) {
        store.agents = previous
        fail(500, 'The setting could not be saved. Please retry.')
      }
      return sandboxInfo(store, next)
    }
    return sandboxInfo(store, agent)
  })

  app.get('/api/agents/defaults', async () => agentDefaults(store, deps.defaultSkillIds()))

  app.post('/api/agents/draft', async (request) => {
    const body = request.body
    if (body === null || typeof body !== 'object' || Array.isArray(body)) fail(400, 'Send a JSON object, e.g. {"prompt":"A bot that plans trips"}.')
    const prompt = (body as Record<string, unknown>).prompt
    if (typeof prompt !== 'string' || !prompt.trim()) fail(400, 'Describe the bot in "prompt".')
    if (prompt.length > MAX_DRAFT_PROMPT_CHARS) fail(400, `"prompt" can be at most ${MAX_DRAFT_PROMPT_CHARS} characters.`)
    return draftBot(store, prompt.trim())
  })
}
