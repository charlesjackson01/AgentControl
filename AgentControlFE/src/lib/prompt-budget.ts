import type { PromptBudget, Skill, SkillPromptMode } from './types'

export type PromptBudgetMessage = {
  /** ok: the prompt fits · warn: runs are rejected. */
  tone: 'ok' | 'warn'
  text: string
}

const count = (n: number): string => Math.max(0, Math.round(n)).toLocaleString('en-US')

/**
 * The agent form's prompt-size line for a POST /api/prompt-budget result.
 * BE-7 answers 'catalog' or 'too-large'. Older backends' 'full' and 'summary'
 * both mean the prompt fits, so they read the same as 'catalog' minus the catalog note.
 */
export function describePromptBudget(budget: PromptBudget): PromptBudgetMessage {
  const windowText = `${count(budget.contextWindow)}-token window`
  const reserve = `${count(budget.responseReserve)} kept for replies`
  if (budget.mode === 'too-large') {
    return {
      tone: 'warn',
      text:
        `Runs will be rejected: about ${count(budget.estimatedTokens)} tokens of instructions and skills, ` +
        `plus ${reserve}, do not fit the ${windowText}. ` +
        "Detach skills, shorten the instructions, or raise the endpoint's context window in Settings.",
    }
  }
  const fits = `About ${count(budget.estimatedTokens)} tokens of instructions and skills, within the ${windowText} (${reserve}).`
  const catalog =
    typeof budget.catalogTokens === 'number' && budget.catalogTokens > 0
      ? ` Skills are listed in a ${count(budget.catalogTokens)}-token catalog and loaded only when a task needs them.`
      : ''
  return { tone: 'ok', text: fits + catalog }
}

/** Label for how a past run's skill went into its prompt (skillSnapshot[].mode). */
export function skillPromptModeLabel(mode: SkillPromptMode | undefined): string {
  if (mode === 'catalog') return 'Catalog (loaded on demand)'
  if (mode === 'summary') return 'Summary'
  return 'Full text' // 'full', or runs recorded before modes existed
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

/**
 * BE-4 memory fields for POST /api/prompt-budget, so the meter matches what a run sends.
 * Saved bot: `agentId` (memory block, recall, its own memoryLearn), plus `memoryLearn`
 * only when the form changed it from the saved value. New bot: `memoryLearn` (default on).
 */
export function budgetMemoryFields(o: { agentId?: string | null; savedLearn?: boolean; formLearn?: boolean }): { agentId?: string; memoryLearn?: boolean } {
  if (o.agentId) {
    const saved = o.savedLearn ?? true
    return { agentId: o.agentId, ...(o.formLearn !== undefined && o.formLearn !== saved ? { memoryLearn: o.formLearn } : {}) }
  }
  return { memoryLearn: o.formLearn ?? true }
}
