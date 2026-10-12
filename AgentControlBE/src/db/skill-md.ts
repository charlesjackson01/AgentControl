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

/** YAML-style comments outside quotes; a hash embedded in a token is literal. */
function stripComment(line: string): string {
  let quote = ''
  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (quote === '"' && char === '\\') { i++; continue }
    if (quote) {
      if (char === quote) quote = ''
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (char === '#' && (i === 0 || /\s/.test(line[i - 1]!))) {
      return line.slice(0, i).trimEnd()
    }
  }
  return line
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
  for (const rawLine of (match[1] ?? '').split('\n')) {
    const line = stripComment(rawLine)
    if (!line.trim()) continue
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
