import type { PromptBudget, Skill } from './types'

export type PromptBudgetMessage = {
  /** ok: fits in full · info: some skills go in as summaries · warn: runs are rejected. */
  tone: 'ok' | 'info' | 'warn'
  text: string
}

/** At most this many skill names are spelled out; the rest are counted. */
const MAX_NAMED_SKILLS = 5

const count = (n: number): string => Math.max(0, Math.round(n)).toLocaleString('en-US')

/** "A", "A and B", "A, B and C", "A, B, C, D, E and 2 more". */
function nameList(names: readonly string[]): string {
  const shown = names.slice(0, MAX_NAMED_SKILLS)
  const rest = names.length - shown.length
  if (rest > 0) return `${shown.join(', ')} and ${rest} more`
  if (shown.length <= 1) return shown[0] ?? ''
  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`
}

/**
 * The agent form's prompt-size line for a POST /api/prompt-budget result.
 * `skillNames` maps skill ids to display names; unknown ids show as the id.
 */
export function describePromptBudget(
  budget: PromptBudget,
  skillNames: ReadonlyMap<string, string> = new Map(),
): PromptBudgetMessage {
  const size = `About ${count(budget.estimatedTokens)} tokens of instructions and skills`
  const windowText = `${count(budget.contextWindow)}-token window`
  const reserve = `${count(budget.responseReserve)} kept for replies`
  const fits = `${size}, within the ${windowText} (${reserve}).`
  if (budget.mode === 'full') return { tone: 'ok', text: fits }

  const summarized = budget.summarizedSkillIds.map((id) => skillNames.get(id) ?? id)
  if (budget.mode === 'summary') {
    const one = summarized.length === 1
    const which = summarized.length > 0 ? nameList(summarized) : 'the largest skills'
    return {
      tone: 'info',
      text:
        `${fits} To fit, ${which} ${one ? 'is' : 'are'} sent as ${one ? 'a short summary' : 'short summaries'}; ` +
        `the agent reads ${one ? 'its' : 'their'} full text with get_skill when needed.`,
    }
  }

  const evenSummarized = summarized.length > 0 ? ' even with skills sent as summaries' : ''
  return {
    tone: 'warn',
    text:
      `Runs will be rejected: about ${count(budget.estimatedTokens)} tokens of instructions and skills, ` +
      `plus ${reserve}, do not fit the ${windowText}${evenSummarized}. ` +
      "Detach skills, shorten the instructions, or raise the endpoint's context window in Settings.",
  }
}

/** Tools the selected skills declare, in attachment order, each name once. */
export function grantedToolNames(
  skills: readonly Pick<Skill, 'id' | 'tools'>[],
  skillIds: readonly string[],
): string[] {
  const byId = new Map(skills.map((s) => [s.id, s]))
  const names = new Set<string>()
  for (const id of skillIds) {
    for (const tool of byId.get(id)?.tools ?? []) names.add(tool.name)
  }
  return [...names]
}
