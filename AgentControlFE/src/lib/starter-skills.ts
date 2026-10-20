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
