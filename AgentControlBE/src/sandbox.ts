/**
 * BE-8: sandbox settings stub (the bot VM arrives in Phase 2) and the setup
 * helpers behind the /new bot card: creation defaults and a model-written draft.
 */
import { existsSync } from 'node:fs'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { botRoot, folderUsage } from './files.js'
import { fail } from './http.js'
import { INTERNET_POLICIES, MAX_AGENT_RULE_CHARS, MAX_AGENT_RULES, type Agent, type InternetPolicy, type Skill } from './shared/types.js'
import { assignAgentSlug, type WorkspaceStore } from './store.js'
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
    usage: { bytes: existsSync(root) ? folderUsage(store, agent).bytes : 0 },
    runs: [],
  }
}

/** Chip labels for the /new card (as in mockup 02c and the skills page). */
export const SKILL_SOURCE_LABELS: Record<string, string> = {
  core: 'AgentControl core',
  superpowers: 'superpowers',
  anthropics: 'anthropics/skills',
  ecc: 'ECC essentials',
  custom: 'Custom',
}

export interface AgentDefaults {
  /** skillIds: the default-on skills of that source, so unticking a chip can drop exactly those. */
  skills: { sourceId: string; label: string; count: number; skillIds: string[] }[]
  internetPolicy: InternetPolicy
  endpointId: string
  modelId: string
}

/** Where a new bot starts: the default-on skills by source, and Primary's endpoint and model. */
export function agentDefaults(store: WorkspaceStore, defaultSkillIds: string[]): AgentDefaults {
  const bySource = new Map<string, string[]>()
  for (const id of defaultSkillIds) {
    const skill = store.skills.find((s: Skill) => s.id === id)
    if (skill) bySource.set(skill.sourceId, [...(bySource.get(skill.sourceId) ?? []), skill.id])
  }
  const primary = store.agents.find((a) => a.isPrimary)
  const endpoint = (primary && store.endpoints.find((e) => e.id === primary.endpointId)) ?? store.endpoints[0]
  const modelId = primary && endpoint && primary.endpointId === endpoint.id ? primary.modelId : (endpoint?.defaultModel ?? '')
  return {
    skills: [...bySource].map(([sourceId, skillIds]) => ({ sourceId, label: SKILL_SOURCE_LABELS[sourceId] ?? sourceId, count: skillIds.length, skillIds })),
    internetPolicy: 'ask',
    endpointId: endpoint?.id ?? '',
    modelId,
  }
}

export const MAX_DRAFT_PROMPT_CHARS = 2_000
/** Default when the endpoint sets no timeout; an endpoint's own timeoutMs wins. */
export const DRAFT_TIMEOUT_MS = 30_000
/** Room for a reasoning model to think before the JSON (muse-glimmer needed ~826). */
export const DRAFT_MAX_TOKENS = 2_500
/** One retry when the reply has no usable draft. */
export const DRAFT_ATTEMPTS = 2

export const AVATAR_CHOICES = 4
/** Used to fill avatarChoices up to 4 when the model offers fewer. */
const FILLER_EMOJI = ['🤖', '✨', '🧠', '📋', '💡']
const Emoji = z.string().trim().min(1).max(16).refine((v) => !/[\s<>]/.test(v), 'one emoji, no spaces')

/** What the model sends: avatarChoices (1-4) and/or avatarEmoji. */
const ModelDraftSchema = z.object({
  name: z.string().trim().min(1).max(60),
  role: z.string().trim().max(80),
  description: z.string().trim().max(300),
  avatarEmoji: Emoji.optional(),
  avatarChoices: z.array(Emoji).min(1).max(8).optional(),
  rules: z.array(z.string().trim().min(1).max(MAX_AGENT_RULE_CHARS)).max(MAX_AGENT_RULES),
}).refine((d) => d.avatarEmoji !== undefined || (d.avatarChoices?.length ?? 0) > 0, { message: 'needs avatarChoices', path: ['avatarChoices'] })

export const DraftSchema = z.object({
  name: z.string().trim().min(1).max(60),
  role: z.string().trim().max(80),
  description: z.string().trim().max(300),
  /** Always avatarChoices[0]. */
  avatarEmoji: Emoji,
  /** 4 distinct emoji for the card's picker. */
  avatarChoices: z.array(Emoji).length(AVATAR_CHOICES),
  rules: z.array(z.string().trim().min(1).max(MAX_AGENT_RULE_CHARS)).max(MAX_AGENT_RULES),
})
export type BotDraft = z.infer<typeof DraftSchema>
export type DraftWarningCode = 'no_primary' | 'upstream' | 'invalid_output' | 'cancelled'
/** The blank fallback has no emoji (avatarEmoji '', avatarChoices []). */
export type DraftResult = (BotDraft | (Omit<BotDraft, 'avatarEmoji' | 'avatarChoices'> & { avatarEmoji: ''; avatarChoices: [] })) & { warning?: string; warningCode?: DraftWarningCode }
export const BLANK_DRAFT = { name: '', role: '', description: '', avatarEmoji: '' as const, avatarChoices: [] as [], rules: [] as string[] }

/** A previous draft sent back for "Reply to change the draft": every field optional, same limits. */
export const PreviousDraftSchema = z.object({
  name: z.string().max(60).optional(),
  role: z.string().max(80).optional(),
  description: z.string().max(300).optional(),
  avatarEmoji: z.string().max(16).optional(),
  avatarChoices: z.array(z.string().max(16)).max(8).optional(),
  rules: z.array(z.string().max(MAX_AGENT_RULE_CHARS)).max(MAX_AGENT_RULES).optional(),
})
export type PreviousDraft = z.infer<typeof PreviousDraftSchema>

const DRAFT_SYSTEM = [
  'You design chat assistant bots. Reply with one JSON object and nothing else, with exactly these keys:',
  '{"name": string (1-60 chars), "role": string (<= 80 chars), "description": string (<= 300 chars),',
  ` "avatarChoices": string[] (${AVATAR_CHOICES} different single emoji that fit the bot, best first),`,
  ` "rules": string[] (0-${MAX_AGENT_RULES} short rules for how the bot behaves)}`,
  'When you are given a current draft, return the whole draft with the requested changes and keep everything else.',
].join('\n')

/** 4 distinct choices: the model's (avatarEmoji first when it sent one), then fillers. */
function avatarChoicesOf(d: { avatarEmoji?: string; avatarChoices?: string[] }): string[] {
  const out: string[] = []
  for (const e of [...(d.avatarEmoji ? [d.avatarEmoji] : []), ...(d.avatarChoices ?? []), ...FILLER_EMOJI]) {
    if (!out.includes(e)) out.push(e)
    if (out.length === AVATAR_CHOICES) break
  }
  return out
}

/**
 * The JSON object in a reply: the whole text, a ```json fence, or the outermost
 * {...}. Some models stop with finish_reason "stop" one closing brace short, so
 * each candidate is also tried with its open strings, brackets and braces closed.
 */
export function extractJson(text: string): unknown {
  const candidates = [text.trim()]
  const fence = /```(?:json)?\s*\n([\s\S]*?)(?:```|$)/i.exec(text)
  if (fence?.[1]) candidates.push(fence[1].trim())
  const open = text.indexOf('{')
  const close = text.lastIndexOf('}')
  if (open !== -1 && close > open) candidates.push(text.slice(open, close + 1))
  if (open !== -1) candidates.push(text.slice(open).trim())
  for (const c of candidates) {
    try { return JSON.parse(c) } catch { /* next */ }
  }
  for (const c of candidates) {
    const repaired = closeOpenJson(c)
    if (repaired === null) continue
    try { return JSON.parse(repaired) } catch { /* next */ }
  }
  return undefined
}

/**
 * `text` (starting at its first "{") with any unterminated string and every
 * open [ or { closed, a dangling "," dropped. null when nothing is open or
 * the brackets do not nest.
 */
export function closeOpenJson(text: string): string | null {
  const start = text.indexOf('{')
  if (start === -1) return null
  const body = text.slice(start)
  const stack: string[] = []
  let inString = false
  let escaped = false
  for (const ch of body) {
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']')
    else if (ch === '}' || ch === ']') {
      if (stack.pop() !== ch) return null
      if (stack.length === 0) return null // already balanced: nothing to repair
    }
  }
  if (stack.length === 0) return null
  let out = inString ? `${body}${escaped ? '\\' : ''}"` : body.trimEnd()
  out = out.replace(/,\s*$/, '')
  return out + stack.reverse().join('')
}

export type DraftLog = (msg: string) => void

export async function draftBot(
  store: WorkspaceStore,
  prompt: string,
  log: DraftLog = () => {},
  signal?: AbortSignal,
  previous?: PreviousDraft,
): Promise<DraftResult> {
  const blank = (warningCode: DraftWarningCode, warning: string, reason: string): DraftResult => {
    log(`POST /api/agents/draft fell back to a blank draft (${warningCode}): ${reason}`)
    return { ...BLANK_DRAFT, avatarChoices: [], rules: [], warning, warningCode }
  }
  const primary = store.agents.find((a) => a.isPrimary)
  const endpoint = primary && store.endpoints.find((e) => e.id === primary.endpointId)
  if (!primary || !endpoint) return blank('no_primary', 'No Primary bot with an endpoint to write the draft. Fill it in by hand.', 'no Primary bot with an endpoint')
  const timeoutMs = endpoint.timeoutMs ?? DRAFT_TIMEOUT_MS
  const messages = [{ role: 'system' as const, content: DRAFT_SYSTEM }, { role: 'user' as const, content: draftRequest(prompt, previous) }]
  // An unusable reply (no JSON, or the wrong shape) gets one more try.
  for (let attempt = 1; ; attempt++) {
    let result: Awaited<ReturnType<typeof chatCompletion>>
    try {
      result = await chatCompletion(
        endpoint.baseUrl,
        store.endpointKeys[endpoint.id],
        primary.modelId,
        messages,
        timeoutMs,
        DRAFT_MAX_TOKENS,
        undefined,
        0.2,
        signal,
        endpoint.proxyUrl,
        { disableThinking: endpoint.disableThinking === true },
      )
    } catch (err) {
      if (signal?.aborted) return blank('cancelled', 'The draft was cancelled.', 'cancelled by the client')
      return blank('upstream', "Primary couldn't write a draft right now. Fill it in by hand.", `upstream threw: ${err instanceof Error ? err.message : String(err)}`)
    }
    const where = `endpoint ${endpoint.id}, model ${primary.modelId}, attempt ${attempt}, ${result.latencyMs}ms, timeout ${timeoutMs}ms, finish_reason ${result.finishReason ?? 'none'}`
    if (!result.ok && signal?.aborted) return blank('cancelled', 'The draft was cancelled.', `cancelled by the client (${where})`)
    if (!result.ok) return blank('upstream', "Primary couldn't write a draft right now. Fill it in by hand.", `${result.error ?? 'upstream error'} (${where})`)
    let problem: string
    const cut = result.finishReason === 'length' ? `; the reply hit max_tokens ${DRAFT_MAX_TOKENS}` : ''
    const json = extractJson(result.content)
    if (json === undefined) {
      problem = `no JSON object in the reply${cut} (${where})`
    } else {
      const parsed = ModelDraftSchema.safeParse(json)
      if (parsed.success) {
        const { avatarEmoji: _one, avatarChoices: _many, ...fields } = parsed.data
        const avatarChoices = avatarChoicesOf(parsed.data)
        return { ...fields, avatarEmoji: avatarChoices[0]!, avatarChoices }
      }
      const issue = parsed.error.issues[0]
      problem = `draft failed validation at "${issue?.path.join('.') ?? ''}": ${issue?.message ?? 'invalid'}${cut} (${where})`
    }
    if (attempt >= DRAFT_ATTEMPTS || signal?.aborted) return blank('invalid_output', "Primary's draft wasn't usable. Fill it in by hand.", problem)
    log(`POST /api/agents/draft is retrying once: ${problem}`)
  }
}

/** The user turn: the prompt alone, or the current draft plus the requested change. */
export function draftRequest(prompt: string, previous?: PreviousDraft): string {
  if (!previous || Object.keys(previous).length === 0) return prompt
  return `Current draft:\n${JSON.stringify(previous)}\n\nChange it like this:\n${prompt}`
}

/** GET /api/agents/slug-preview: the folder name POST /api/agents would give this name now. */
export function slugPreview(store: WorkspaceStore, name: string): string {
  const isPrimary = !store.agents.some((a) => a.isPrimary)
  return assignAgentSlug(name, isPrimary, new Set(store.agents.map((a) => a.slug)))
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

  app.get('/api/agents/slug-preview', async (request) => {
    const name = (request.query as Record<string, unknown>).name
    if (typeof name !== 'string' || !name.trim()) fail(400, 'Send the bot name, e.g. /api/agents/slug-preview?name=Trip%20Planner.')
    if (name.length > 200) fail(400, '"name" is too long.')
    return { slug: slugPreview(store, name.trim()) }
  })

  app.post('/api/agents/draft', async (request, reply) => {
    const body = request.body
    if (body === null || typeof body !== 'object' || Array.isArray(body)) fail(400, 'Send a JSON object, e.g. {"prompt":"A bot that plans trips"}.')
    const prompt = (body as Record<string, unknown>).prompt
    if (typeof prompt !== 'string' || !prompt.trim()) fail(400, 'Describe the bot in "prompt".')
    if (prompt.length > MAX_DRAFT_PROMPT_CHARS) fail(400, `"prompt" can be at most ${MAX_DRAFT_PROMPT_CHARS} characters.`)
    const rawPrevious = (body as Record<string, unknown>).previous
    let previous: PreviousDraft | undefined
    if (rawPrevious !== undefined && rawPrevious !== null) {
      const p = PreviousDraftSchema.safeParse(rawPrevious)
      if (!p.success) fail(400, `"previous" must be the draft object the card shows (problem at "${p.error.issues[0]?.path.join('.') ?? ''}").`)
      previous = p.data
    }
    // FE-5 Cancel: when the client drops the request, stop the upstream call too.
    const cancel = new AbortController()
    const onClose = () => { if (!reply.raw.writableFinished) cancel.abort() }
    reply.raw.on('close', onClose)
    try {
      return await draftBot(store, prompt.trim(), (msg) => request.log.warn(msg), cancel.signal, previous)
    } finally {
      reply.raw.off('close', onClose)
    }
  })
}
