/* FE-3 compact Profile tab (03a): draft, model options, validation, PUT body. Pure; tests/profile-form.test.mjs */
import type { Agent, AgentInput, Endpoint, EndpointModel } from './types.ts'
import { agentPutBody } from './agent-put.ts'
import { MAX_RULE_LENGTH, MAX_RULES, normalizeRules } from './agent-profile.ts'

export type ProfileDraft = {
  name: string
  role: string
  description: string
  endpointId: string
  modelId: string
  color: string | null
  rules: string[]
  instructions: string
}

export function profileDraftFrom(a: Agent): ProfileDraft {
  return {
    name: a.name,
    role: a.role ?? '',
    description: a.description,
    endpointId: a.endpointId,
    modelId: a.modelId,
    color: a.color ?? null,
    rules: [...(a.rules ?? [])],
    instructions: a.instructions,
  }
}

const SEP = '\u001f'
export const modelValue = (endpointId: string, modelId: string) => `${endpointId}${SEP}${modelId}`
export function parseModelValue(v: string): { endpointId: string; modelId: string } {
  const i = v.indexOf(SEP)
  return i === -1 ? { endpointId: '', modelId: v } : { endpointId: v.slice(0, i), modelId: v.slice(i + 1) }
}

export type ModelOption = { value: string; label: string; endpointId: string; modelId: string }

/**
 * One select for endpoint + model ("Local llama · Qwen 3.8 Flash"). Each endpoint
 * lists its served models, else just its default; the current pick is always kept.
 */
export function modelOptions(
  endpoints: readonly Pick<Endpoint, 'id' | 'name' | 'defaultModel'>[],
  modelsByEndpoint: Readonly<Record<string, readonly EndpointModel[] | undefined>>,
  current: { endpointId: string; modelId: string },
): ModelOption[] {
  const out: ModelOption[] = []
  for (const ep of endpoints) {
    const served = modelsByEndpoint[ep.id]
    const models = served && served.length ? served : [{ id: ep.defaultModel, name: ep.defaultModel }]
    for (const m of models) {
      if (!m.id) continue
      out.push({ value: modelValue(ep.id, m.id), label: `${ep.name} · ${m.name || m.id}`, endpointId: ep.id, modelId: m.id })
    }
  }
  if (current.modelId && !out.some((o) => o.endpointId === current.endpointId && o.modelId === current.modelId)) {
    const ep = endpoints.find((e) => e.id === current.endpointId)
    out.unshift({
      value: modelValue(current.endpointId, current.modelId),
      label: `${ep?.name ?? 'Missing endpoint'} · ${current.modelId}`,
      endpointId: current.endpointId,
      modelId: current.modelId,
    })
  }
  return out
}

export type ProfileErrors = Partial<Record<'name' | 'model' | 'rules', string>>

export function validateProfile(d: ProfileDraft, endpoints: readonly Pick<Endpoint, 'id'>[]): ProfileErrors {
  const e: ProfileErrors = {}
  if (!d.name.trim()) e.name = 'Give the bot a name.'
  if (!d.endpointId || !endpoints.some((x) => x.id === d.endpointId)) e.model = 'Pick a model on an existing endpoint.'
  else if (!d.modelId.trim()) e.model = 'Pick a model.'
  // Count before normalizeRules, which caps at MAX_RULES.
  const rules = d.rules.map((r) => r.trim()).filter(Boolean)
  if (new Set(rules).size > MAX_RULES) e.rules = `At most ${MAX_RULES} rules.`
  else if (rules.some((r) => r.length > MAX_RULE_LENGTH)) e.rules = `Each rule can be at most ${MAX_RULE_LENGTH} characters.`
  return e
}

/** Full PUT body: the stored agent's core fields + this draft. skillIds stay the agent's current ones. */
export function profilePutBody(agent: Agent, d: ProfileDraft): AgentInput {
  return {
    ...agentPutBody(agent, {}),
    name: d.name.trim(),
    role: d.role.trim(),
    description: d.description.trim(),
    instructions: d.instructions.trim(),
    endpointId: d.endpointId,
    modelId: d.modelId.trim(),
    rules: normalizeRules(d.rules),
    color: d.color,
  }
}

export function profileDirty(d: ProfileDraft, agent: Agent): boolean {
  const a = profileDraftFrom(agent)
  return (
    d.name.trim() !== a.name.trim() ||
    d.role.trim() !== a.role.trim() ||
    d.description.trim() !== a.description.trim() ||
    d.instructions.trim() !== a.instructions.trim() ||
    d.endpointId !== a.endpointId ||
    d.modelId !== a.modelId ||
    (d.color ?? null) !== (a.color ?? null) ||
    normalizeRules(d.rules).join('\n') !== normalizeRules(a.rules).join('\n')
  )
}

/** The six colours in mockup 03a (pink, amber, teal, violet, slate, green). */
export const PROFILE_SWATCHES = ['#e5487f', '#e8940f', '#3a8a8c', '#7e5bc9', '#4f5b75', '#4a7a5c'] as const

/** Swatches to show: the six from 03a, plus the bot's current colour if it's something else. */
export function profileSwatches(current: string | null | undefined): string[] {
  const base: string[] = [...PROFILE_SWATCHES]
  if (current && !base.some((c) => c.toLowerCase() === current.toLowerCase())) base.push(current)
  return base
}
