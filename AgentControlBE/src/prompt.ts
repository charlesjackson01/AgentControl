/**
 * Run prompt planning: the system prompt and offered tools for an agent's
 * attached skills, shrunk to fit small context windows. The run route and
 * POST /api/prompt-budget both call planPrompt, so the budget preview is
 * exactly the plan a run would use.
 *
 * Full mode is the original construction, byte for byte, and is used whenever
 * it fits (prompt + RESPONSE_RESERVE within the window): anything a run
 * accepted before summaries existed is sent exactly as before. Only a prompt
 * that would be rejected has its largest skills turned into short summary
 * blocks, with get_skill offered so the model can read one on demand.
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
/**
 * Tokens a summarized plan aims to leave free for history turns and tool
 * results (so a summarized skill can actually be read). Full mode does not
 * need it: a full prompt that fits is never summarized.
 */
export const SKILL_HEADROOM = 1024
/** A summary block quotes at most this much of the skill's description. */
const SUMMARY_DESCRIPTION_MAX = 300
const GET_SKILL = 'get_skill'
const SKILLS_HEADER = 'Skills:\n\n'
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
  /** Skills sent as summaries, in attachment order, each id once. */
  summarizedSkillIds: string[]
  mode: PromptMode
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

function fullBlock(skill: Skill): string {
  return `## ${skill.name}\n${skill.content}`
}

/** `## name\ncontent`, measured without building it. */
function fullBlockLength(skill: Skill): number {
  return 4 + skill.name.length + skill.content.length
}

/** What a summarized skill leaves in the prompt: name, description and how to read the rest. */
export function summaryBlock(skill: Skill): string {
  const description = clipText((skill.description ?? '').trim(), SUMMARY_DESCRIPTION_MAX)
  return [
    `## ${skill.name} (summary)`,
    description,
    `The full procedure is not in this prompt. Read it with ${GET_SKILL} {"skill":${JSON.stringify(skill.id)}} before relying on it.`,
  ]
    .filter(Boolean)
    .join('\n')
}

export const RULES_HEADER = '## Rules\nAlways follow these rules:\n'

/**
 * The agent's own part of the system prompt: its instructions plus, when it
 * has any, its standing rules as their own section. With no rules the result
 * is exactly `instructions`, so existing prompts stay byte-identical.
 */
export function agentInstructions(instructions: string, rules?: readonly string[]): string {
  const list = (rules ?? []).map((r) => r.trim()).filter(Boolean)
  if (list.length === 0) return instructions
  const section = `${RULES_HEADER}${list.map((r) => `- ${r}`).join('\n')}`
  return instructions ? `${instructions}${BLOCK_SEPARATOR}${section}` : section
}

/** System prompt = instructions + the attached skill blocks. */
function buildSystem(instructions: string, blocks: string[]): string {
  return [instructions, blocks.length > 0 ? `${SKILLS_HEADER}${blocks.join(BLOCK_SEPARATOR)}` : '']
    .filter(Boolean)
    .join(BLOCK_SEPARATOR)
}

/** buildSystem(instructions, blocks).length from the block lengths alone. */
function systemLength(instructions: string, blockCount: number, blockChars: number): number {
  if (blockCount === 0) return instructions.length
  const skillsPart = SKILLS_HEADER.length + blockChars + BLOCK_SEPARATOR.length * (blockCount - 1)
  return instructions ? instructions.length + BLOCK_SEPARATOR.length + skillsPart : skillsPart
}

/**
 * Offered tools: names declared by attached skills that exist in the built-in
 * registry, deduped, with the registry's CURRENT description and schema
 * (stored copies are display-only). Only these may execute.
 */
function skillTools(skills: readonly Skill[]): ToolDeclaration[] {
  const declarations: ToolDeclaration[] = []
  const seen = new Set<string>()
  for (const s of skills) {
    for (const t of s.tools ?? []) {
      if (seen.has(t.name)) continue
      seen.add(t.name)
      const decl = toolDeclaration(t.name)
      if (decl) declarations.push(decl)
    }
  }
  return declarations
}

function schemaChars(tools: ToolDeclaration[]): number {
  return tools.length > 0 ? JSON.stringify(tools).length : 0
}

/**
 * Plan a run prompt for this context window. Full mode whenever
 * estimate + RESPONSE_RESERVE fits (the hard limit the run route enforces).
 * Otherwise skills are summarized largest first (ties: attachment order) until
 * the plan also leaves SKILL_HEADROOM, blocks staying in attachment order, and
 * get_skill joins the offered tools (its schema counts). A skill whose summary
 * would not be shorter stays full, and a summary plan that is not smaller than
 * the full one is dropped. 'too-large' means the plan still breaks the hard
 * limit, so the run would be rejected.
 */
export function planPrompt({ instructions, skills, input, contextWindow, responseReserve = RESPONSE_RESERVE }: PromptPlanInput): PromptPlan {
  const hardLimit = contextWindow - responseReserve
  const budget = hardLimit - SKILL_HEADROOM
  const baseTools = skillTools(skills)
  const getSkill = baseTools.some((t) => t.name === GET_SKILL) ? undefined : toolDeclaration(GET_SKILL)
  const summaryTools = getSkill ? [...baseTools, getSkill] : baseTools

  // Lengths only: nothing large is built until the plan is chosen.
  const fullLengths = skills.map(fullBlockLength)
  let blockChars = fullLengths.reduce((n, len) => n + len, 0)
  const fullSchema = schemaChars(baseTools)
  const summarySchema = schemaChars(summaryTools)
  const estimate = (toolChars: number): number =>
    estimateTokens(systemLength(instructions, skills.length, blockChars) + input.length + toolChars)

  const fullEstimate = estimate(fullSchema)
  const summaries = new Map<string, string>()
  if (fullEstimate > hardLimit) {
    // Each id is one candidate, ranked at its first attachment; a repeated id
    // is summarized at every attachment.
    const byId = new Map<string, { skill: Skill; index: number; count: number; fullChars: number }>()
    skills.forEach((skill, index) => {
      const seen = byId.get(skill.id)
      if (seen) {
        seen.count += 1
        seen.fullChars += fullLengths[index] as number
      } else {
        byId.set(skill.id, { skill, index, count: 1, fullChars: fullLengths[index] as number })
      }
    })
    const candidates = [...byId.values()].sort(
      (a, b) => b.skill.content.length - a.skill.content.length || a.index - b.index,
    )
    for (const { skill, count, fullChars } of candidates) {
      const summary = summaryBlock(skill)
      // A summary that is not shorter cannot help the prompt fit.
      if (summary.length >= fullBlockLength(skill)) continue
      summaries.set(skill.id, summary)
      blockChars -= fullChars - count * summary.length
      if (estimate(summarySchema) <= budget) break
    }
  }

  // Summaries plus the get_skill schema can outweigh what they save (small
  // skills): then the full plan is the better one to send or to reject.
  if (summaries.size > 0 && estimate(summarySchema) >= fullEstimate) summaries.clear()

  const blocks = skills.map((s) => summaries.get(s.id) ?? fullBlock(s))
  const system = buildSystem(instructions, blocks)
  const toolDeclarations = summaries.size > 0 ? summaryTools : baseTools
  const estimatedTokens = estimateTokens(system.length + input.length + schemaChars(toolDeclarations))
  const mode: PromptMode = estimatedTokens > hardLimit ? 'too-large' : summaries.size > 0 ? 'summary' : 'full'
  return {
    system,
    toolDeclarations,
    summarizedSkillIds: [...new Set(skills.map((s) => s.id))].filter((id) => summaries.has(id)),
    mode,
    estimatedTokens,
  }
}
