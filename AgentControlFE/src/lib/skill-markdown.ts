/** Mirrors AgentControlBE/src/db/skill-md.ts; parity cases live in tests/skills.test.mjs. */
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
  /** Optional `tag:` (the Skill Library's category label); '' when absent. */
  tag: string
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
  return { name, description, tag: meta.get('tag') ?? '', content, tools: [...new Set(tools)].slice(0, 64) }
}

export function parsePreview(markdown: string): ParsedSkillMarkdown | { error: string } {
  try {
    return parseSkillMarkdown(markdown)
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Could not parse SKILL.md.' }
  }
}

/* --------------------------------------------------------------------------
   Export (FE only, no BE mirror): a skill as a SKILL.md file that the parser
   above — and so POST /api/skills/import — reads back to the same name,
   description, tag, body and tools.
   -------------------------------------------------------------------------- */

/** What an export needs from a Skill (structural, so tests can pass plain objects). */
export type SkillMarkdownSource = {
  name: string
  description: string
  tag?: string
  content: string
  tools?: readonly { name: string }[]
}

/** Tool names the BE accepts; anything else would split or vanish in `tools:`. */
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/

/**
 * A single-line frontmatter value the parser reads back verbatim. Values are
 * never unquoted, so nothing can be escaped: line breaks fold to one space, and
 * a `#` that stripComment would take for a comment (first character, or after
 * whitespace, outside quotes) becomes a fullwidth `＃` instead of cutting the
 * value short. Same quote/escape walk as stripComment, so every other character
 * survives as-is.
 */
function frontmatterValue(text: string): string {
  const value = text.replace(/\s*[\r\n]+\s*/g, ' ').trim()
  let quote = ''
  let out = ''
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!
    if (quote === '"' && char === '\\') {
      out += value.slice(i, i + 2)
      i++
      continue
    }
    if (quote) {
      if (char === quote) quote = ''
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (char === '#' && (i === 0 || /\s/.test(value[i - 1]!))) {
      out += '＃'
      continue
    }
    out += char
  }
  return out
}

/** Serialize a skill as SKILL.md: `name`, `description`, optional `tag` and `tools`, then the body. */
export function serializeSkillMarkdown(skill: SkillMarkdownSource): string {
  const name = frontmatterValue(skill.name) || 'skill'
  // The importer requires a description; a skill saved without one exports its name.
  const description = frontmatterValue(skill.description) || name
  const tag = frontmatterValue(skill.tag ?? '')
  const tools = [...new Set((skill.tools ?? []).map((t) => t.name).filter((n) => TOOL_NAME.test(n)))].slice(0, 64)
  const header = ['---', `name: ${name}`, `description: ${description}`]
  if (tag) header.push(`tag: ${tag}`)
  if (tools.length > 0) header.push(`tools: ${tools.join(', ')}`)
  header.push('---')
  // The parser drops leading blank lines and trailing whitespace of the body.
  const body = skill.content.replace(/\r\n/g, '\n').trimEnd()
  return `${header.join('\n')}\n\n${body}\n`
}

/** Download name for an exported skill: `<id>.md`, limited to filename-safe characters. */
export function skillFileName(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 120)
  return `${safe || 'skill'}.md`
}
