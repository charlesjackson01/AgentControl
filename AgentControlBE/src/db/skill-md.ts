/**
 * Minimal SKILL.md parser: a YAML frontmatter block (--- delimited) followed
 * by the skill body. Only flat top-level `key: value` pairs are read — nested
 * blocks (e.g. `metadata:`) and indented continuations are ignored. No YAML
 * dependency; the six seed files and hand-written SKILL.md files are flat.
 */

export class SkillMarkdownError extends Error {}

export type ParsedSkillMarkdown = {
  name: string
  description: string
  /** Body with the frontmatter block stripped. */
  content: string
}

export function parseSkillMarkdown(markdown: string): ParsedSkillMarkdown {
  const text = markdown.replace(/\r\n/g, '\n').trim()
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text)
  if (!match) {
    throw new SkillMarkdownError('SKILL.md has no frontmatter block — start the file with a "--- name … ---" header.')
  }

  const meta: Record<string, string> = {}
  for (const line of (match[1] ?? '').split('\n')) {
    if (/^\s/.test(line)) continue
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim()
    if (key) meta[key] = value
  }

  if (!meta.name) throw new SkillMarkdownError('SKILL.md frontmatter is missing a "name" field.')
  if (!meta.description) throw new SkillMarkdownError('SKILL.md frontmatter is missing a "description" field.')

  const content = text.slice(match[0].length).replace(/^\n+/, '').trimEnd()
  return { name: meta.name, description: meta.description, content }
}
