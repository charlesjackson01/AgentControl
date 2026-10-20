/* Starter skills a new bot gets pre-checked. Pure; tests/starter-skills.test.mjs */

/** The Team Lead's starters. Since BE-6 core skill ids are `core/<name>`. */
export const LEAD_SKILL_IDS = ['core/deep-research', 'core/summarization', 'core/multi-agent-orchestration'] as const

/**
 * The starters this workspace actually has, in order. A pre-BE-6 server still
 * uses bare core ids (summarization), so fall back to those when `core/…` is absent.
 */
export function starterSkillIds(wanted: readonly string[], skills: readonly { id: string }[]): string[] {
  const have = new Set(skills.map((s) => s.id))
  const out: string[] = []
  for (const id of wanted) {
    const bare = id.startsWith('core/') ? id.slice('core/'.length) : id
    const pick = have.has(id) ? id : have.has(bare) ? bare : null
    if (pick && !out.includes(pick)) out.push(pick)
  }
  return out
}

/** The library's defaultOn skills, in library order (what BE-7 gives a new bot). */
export function defaultSkillIds(skills: readonly { id: string; defaultOn?: boolean }[]): string[] {
  return [...new Set(skills.filter((s) => s.defaultOn === true).map((s) => s.id))]
}

/**
 * Skills pre-checked in the new-bot form: the defaults, plus the Team Lead's
 * starters for the lead (defaults first, then the missing starters).
 */
export function newBotSkillIds(skills: readonly { id: string; defaultOn?: boolean }[], lead: boolean): string[] {
  const out = defaultSkillIds(skills)
  if (lead) for (const id of starterSkillIds(LEAD_SKILL_IDS, skills)) if (!out.includes(id)) out.push(id)
  return out
}

/**
 * The `skillIds` part of POST /api/agents.
 * - The user changed the selection: send it as is ([] only if they turned everything off).
 * - Untouched, normal bot: leave it out, so the backend applies its defaults (BE-7).
 * - Untouched Team Lead: send defaults + starters in one request (nothing to
 *   patch afterwards); leave it out if that list is empty (skills didn't load).
 */
export function createSkillIds(input: { selected: readonly string[]; touched: boolean; lead: boolean }): { skillIds?: string[] } {
  if (input.touched) return { skillIds: [...input.selected] }
  if (input.lead && input.selected.length > 0) return { skillIds: [...input.selected] }
  return {}
}
