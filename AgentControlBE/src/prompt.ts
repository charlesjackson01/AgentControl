/**
 * Run prompt planning: the system prompt and offered tools for an agent's
 * attached skills. The run route and POST /api/prompt-budget both call
 * planPrompt, so the budget preview is exactly the plan a run would use.
 *
 * BE-7 catalog mode: skill bodies never go into the prompt. Each enabled
 * skill is one catalog line (`- <id>: <description clipped to 300>`) and the
 * model loads a body on demand with activate_skill (files with
 * read_skill_file). The catalog counts as 'too-large' past 25% of the window.
 */
import type { PromptMode, Skill } from './shared/types.js'
import { clipText } from './tools/limits.js'
import { toolDeclaration } from './tools.js'
import type { ToolDeclaration } from './upstream.js'

/** Tokens kept free for the model's reply (the upstream max_tokens ceiling). */
export const RESPONSE_RESERVE = 4096

/** The endpoint's reply budget: its maxOutputTokens, else RESPONSE_RESERVE. */
export function replyReserve(endpoint: { maxOutputTokens?: number }): number {
  return endpoint.maxOutputTokens ?? RESPONSE_RESERVE
}

/** A catalog line quotes at most this much of the skill's description. */
export const CATALOG_DESCRIPTION_MAX = 300
/** The catalog is 'too-large' when it takes more than this share of the window. */
export const CATALOG_WINDOW_SHARE = 0.25
export const ACTIVATE_SKILL = 'activate_skill'
export const READ_SKILL_FILE = 'read_skill_file'
export const CATALOG_HEADER = 'Skills (call activate_skill to use one):'
/** Phase 1 only: vendored skills may name Claude Code tools (Task, TodoWrite, Bash). */
export const FOREIGN_TOOLS_NOTE = "Skills may name tools you don't have; use your own tools instead."
const BLOCK_SEPARATOR = '\n\n'

export interface PromptPlanInput {
  instructions: string
  /** Resolved attached skills, in attachment order (see attachedSkills). */
  skills: readonly Skill[]
  /** The user's message ('' for a budget preview). */
  input: string
  contextWindow: number
  /** Tokens kept free for the reply (replyReserve(endpoint)); defaults to RESPONSE_RESERVE. */
  responseReserve?: number
}

export interface PromptPlan {
  /** The exact system message ('' when there is none). */
  system: string
  /** Offered tools in the order sent upstream; empty means no `tools` key. */
  toolDeclarations: ToolDeclaration[]
  /** Skills listed in the catalog, in attachment order, each id once. */
  catalogSkillIds: string[]
  mode: PromptMode
  /** chars/4 estimate of the catalog section alone (0 without skills). */
  catalogTokens: number
  /** chars/4 estimate of system + input + tool schema JSON, as the run budget counts it. */
  estimatedTokens: number
}

/** The crude chars/4 token estimate the run budget uses (no tokenizer dependency). */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4)
}

/** Look up attached skill ids in order; ids of deleted skills are skipped, repeats kept. */
export function attachedSkills(skills: readonly Skill[], skillIds: readonly string[]): Skill[] {
  const byId = new Map<string, Skill>()
  for (const s of skills) if (!byId.has(s.id)) byId.set(s.id, s)
  const out: Skill[] = []
  for (const id of skillIds) {
    const skill = byId.get(id)
    if (skill) out.push(skill)
  }
  return out
}

/** One catalog line: `- <id>: <description>` (description on one line, clipped). */
export function catalogLine(skill: Skill): string {
  const description = clipText((skill.description ?? '').replace(/\s+/g, ' ').trim(), CATALOG_DESCRIPTION_MAX)
  return description ? `- ${skill.id}: ${description}` : `- ${skill.id}`
}

/** The catalog section for these skills, each id once ('' without skills). */
export function skillCatalog(skills: readonly Skill[]): string {
  const unique = uniqueSkills(skills)
  if (unique.length === 0) return ''
  return [CATALOG_HEADER, ...unique.map(catalogLine), FOREIGN_TOOLS_NOTE].join('\n')
}

function uniqueSkills(skills: readonly Skill[]): Skill[] {
  const seen = new Set<string>()
  return skills.filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)))
}

export const RULES_HEADER = '## Rules\nAlways follow these rules:\n'

/**
 * The agent's own part of the system prompt: its instructions plus, when it
 * has any, its standing rules as their own section. With no rules the result
 * is exactly `instructions`.
 */
export function agentInstructions(instructions: string, rules?: readonly string[]): string {
  const list = (rules ?? []).map((r) => r.trim()).filter(Boolean)
  if (list.length === 0) return instructions
  const section = `${RULES_HEADER}${list.map((r) => `- ${r}`).join('\n')}`
  return instructions ? `${instructions}${BLOCK_SEPARATOR}${section}` : section
}

/**
 * Offered tools: names declared by attached skills that exist in the built-in
 * registry, deduped, with the registry's CURRENT description and schema
 * (stored copies are display-only), then activate_skill (and read_skill_file
 * when a skill has files). Only these may execute.
 */
function offeredTools(skills: readonly Skill[]): ToolDeclaration[] {
  const declarations: ToolDeclaration[] = []
  const seen = new Set<string>()
  const add = (name: string): void => {
    if (seen.has(name)) return
    seen.add(name)
    const decl = toolDeclaration(name)
    if (decl) declarations.push(decl)
  }
  for (const s of skills) for (const t of s.tools ?? []) add(t.name)
  if (skills.length > 0) add(ACTIVATE_SKILL)
  if (skills.some((s) => (s.files ?? []).length > 0)) add(READ_SKILL_FILE)
  return declarations
}

/**
 * Plan a run prompt: instructions, then the skill catalog. 'too-large' means
 * the catalog is over CATALOG_WINDOW_SHARE of the window, or the whole plan
 * plus the reply reserve does not fit (the run route rejects that with 413).
 */
export function planPrompt({ instructions, skills, input, contextWindow, responseReserve = RESPONSE_RESERVE }: PromptPlanInput): PromptPlan {
  const catalog = skillCatalog(skills)
  const system = [instructions, catalog].filter(Boolean).join(BLOCK_SEPARATOR)
  const toolDeclarations = offeredTools(skills)
  const schema = toolDeclarations.length > 0 ? JSON.stringify(toolDeclarations).length : 0
  const estimatedTokens = estimateTokens(system.length + input.length + schema)
  const catalogTokens = estimateTokens(catalog.length)
  const tooLarge = catalogTokens > contextWindow * CATALOG_WINDOW_SHARE || estimatedTokens > contextWindow - responseReserve
  return {
    system,
    toolDeclarations,
    catalogSkillIds: uniqueSkills(skills).map((s) => s.id),
    mode: tooLarge ? 'too-large' : 'catalog',
    catalogTokens,
    estimatedTokens,
  }
}
