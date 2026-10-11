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
  /** Built-in tool names from a `tools:` field, in order, deduped; [] when absent. */
  tools: string[]
}

const TOOL_NAME = /^[A-Za-z0-9_-]+$/

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

  const meta: Record<string, string> = {}
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
    if (key) meta[key] = value
  }
  const badTool = tools.find((t) => !TOOL_NAME.test(t))
  if (badTool) throw new SkillMarkdownError(`SKILL.md "tools" has an invalid tool name: "${badTool.slice(0, 60)}".`)

  if (!meta.name) throw new SkillMarkdownError('SKILL.md frontmatter is missing a "name" field.')
  if (!meta.description) throw new SkillMarkdownError('SKILL.md frontmatter is missing a "description" field.')

  const content = text.slice(match[0].length).replace(/^\n+/, '').trimEnd()
  return { name: meta.name, description: meta.description, content, tools: [...new Set(tools)] }
}
