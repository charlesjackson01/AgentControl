import type { Skill } from './types'

type SearchableSkill = Pick<Skill, 'name' | 'description' | 'tag'> & { tools?: readonly { name: string }[] }

/** Case-insensitive match on the name, description, tag, or any declared tool name. */
export function matchesSkillQuery(skill: SearchableSkill, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return [skill.name, skill.description, skill.tag, ...(skill.tools ?? []).map((t) => t.name)]
    .some((value) => (value ?? '').toLowerCase().includes(q))
}

/** Library filter: with tags selected, keep skills tagged with one of them; then the text query. Keeps server order. */
export function filterSkills<T extends SearchableSkill>(skills: readonly T[], query: string, activeTags: readonly string[] = []): T[] {
  return skills.filter((s) => (activeTags.length === 0 || activeTags.includes(s.tag)) && matchesSkillQuery(s, query))
}
