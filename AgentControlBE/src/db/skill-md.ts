/**
 * Minimal SKILL.md parser: a YAML frontmatter block (--- delimited) followed
 * by the skill body. Only flat top-level `key: value` pairs are read — nested
 * blocks (e.g. `metadata:`) and indented continuations are ignored, except a
 * `tools:` list, which may be inline (`tools: a, b` or `[a, b]`) or a block of
 * `- name` items. No YAML dependency.
 */

export class SkillMarkdownError extends Error {}

export type ParsedSkillMarkdown = {
  name: string
  description: string
  /** Body with the frontmatter block stripped. */
  content: string
  /**
   * Tokens from a `tools:` field, in order, deduped; [] when absent. Raw: the
   * caller decides which are built-in tools (import ignores the rest).
   */
  tools: string[]
}

function splitToolList(value: string): string[] {
  return value
    .replace(/^\[|\]$/g, '')
    .split(/[\s,]+/)
    .map((t) => t.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean)
}

export function parseSkillMarkdown(markdown: string): ParsedSkillMarkdown {
  const text = markdown.replace(/\r\n/g, '\n').trim()
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text)
  if (!match) {
    throw new SkillMarkdownError('SKILL.md has no frontmatter block — start the file with a "--- name … ---" header.')
  }

  // A Map, so a `__proto__:` key in untrusted frontmatter is just a key.
  const meta = new Map<string, string>()
  const tools: string[] = []
  let inToolsBlock = false
  for (const line of (match[1] ?? '').split('\n')) {
    if (/^\s/.test(line)) {
      // Indented continuation: only `- name` items under `tools:` are read.
      const item = inToolsBlock ? /^\s+-\s*(.+)$/.exec(line) : null
      if (item?.[1]) tools.push(...splitToolList(item[1]))
      continue
    }
    inToolsBlock = false
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim()
    if (key === 'tools') {
      if (value) tools.push(...splitToolList(value))
      else inToolsBlock = true
      continue
    }
    if (key) meta.set(key, value)
  }

  const name = meta.get('name')
  const description = meta.get('description')
  if (!name) throw new SkillMarkdownError('SKILL.md frontmatter is missing a "name" field.')
  if (!description) throw new SkillMarkdownError('SKILL.md frontmatter is missing a "description" field.')

  const content = text.slice(match[0].length).replace(/^\n+/, '').trimEnd()
  return { name, description, content, tools: [...new Set(tools)].slice(0, 64) }
}
