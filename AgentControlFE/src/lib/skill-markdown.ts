/** Mirrors AgentControlBE/src/db/skill-md.ts (BE-6, 085be14); parity cases live in tests/skills.test.mjs. */
import { parse as parseYaml } from 'yaml'

/**
 * SKILL.md parser: a YAML frontmatter block (--- delimited) followed by the
 * skill body, read per the Agent Skills spec (agentskills.io/specification).
 *
 * The frontmatter is parsed as YAML (block scalars, quoting, the nested
 * `metadata` map). Frontmatter that isn't valid YAML still imports: it falls
 * back to a line reader that takes flat top-level `key: value` pairs, and a
 * warning says so. `tools:` (our extension, also used by Claude Code) is
 * always read by the line reader so its tokens stay raw: inline
 * (`tools: a, b` or `[a, b]`) or a block of `- name` items.
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
  license?: string
  compatibility?: string
  /** The spec's `metadata` map; non-string values are JSON-encoded. */
  metadata?: Record<string, string>
  /** `allowed-tools`, space-separated in the spec (commas tolerated). */
  allowedTools?: string[]
  /** Any other top-level frontmatter keys, kept as parsed. */
  extra?: Record<string, unknown>
  /** Spec problems that don't block loading (long body, long description, not-YAML). */
  warnings: string[]
}

export interface ParseSkillOptions {
  /**
   * The skill's folder name. When given, the spec's name rules are enforced
   * (a violation throws) and the name must equal the folder.
   */
  folder?: string
}

const KNOWN_KEYS = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools', 'tools', 'tag'])
export const MAX_SKILL_NAME_CHARS = 64
export const MAX_SKILL_DESCRIPTION_CHARS = 1024
export const MAX_SKILL_COMPATIBILITY_CHARS = 500
export const SKILL_BODY_WARN_LINES = 500

/** The spec's name rules; [] when the name is valid. */
export function skillNameViolations(name: string, folder?: string): string[] {
  const out: string[] = []
  if (name.length < 1 || name.length > MAX_SKILL_NAME_CHARS) out.push(`name must be 1-${MAX_SKILL_NAME_CHARS} characters`)
  if (!/^[a-z0-9-]*$/.test(name)) out.push('name may only contain lowercase letters, digits and hyphens')
  if (name.startsWith('-') || name.endsWith('-')) out.push('name must not start or end with a hyphen')
  if (name.includes('--')) out.push('name must not contain consecutive hyphens')
  if (folder !== undefined && name !== folder) out.push(`name "${name}" must match its folder "${folder}"`)
  return out
}

function readYaml(frontmatter: string): Record<string, unknown> | null {
  try {
    const value: unknown = parseYaml(frontmatter, { maxAliasCount: 50, uniqueKeys: false })
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const asText = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : undefined

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

export function parseSkillMarkdown(markdown: string, options: ParseSkillOptions = {}): ParsedSkillMarkdown {
  const text = markdown.replace(/\r\n/g, '\n').trim()
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text)
  if (!match) {
    throw new SkillMarkdownError('SKILL.md has no frontmatter block — start the file with a "--- name … ---" header.')
  }
  const frontmatter = match[1] ?? ''
  const warnings: string[] = []

  // Line reader: the fallback for non-YAML frontmatter, and always the source
  // of `tools:`. A Map, so a `__proto__:` key in untrusted frontmatter is just a key.
  const lines = new Map<string, string>()
  const tools: string[] = []
  let inToolsBlock = false
  for (const rawLine of frontmatter.split('\n')) {
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
    if (key) lines.set(key, value)
  }

  const yaml = readYaml(frontmatter)
  if (!yaml) warnings.push('frontmatter is not valid YAML; read line by line')
  const field = (key: string): string | undefined => {
    if (yaml) return Object.prototype.hasOwnProperty.call(yaml, key) ? asText(yaml[key]) : undefined
    return lines.get(key)
  }

  const name = field('name')?.trim()
  const description = field('description')?.trim()
  if (!name) throw new SkillMarkdownError('SKILL.md frontmatter is missing a "name" field.')
  if (!description) throw new SkillMarkdownError('SKILL.md frontmatter is missing a "description" field.')

  if (options.folder !== undefined) {
    const violations = skillNameViolations(name, options.folder)
    if (violations.length > 0) throw new SkillMarkdownError(`SKILL.md name is invalid: ${violations.join('; ')}.`)
  }
  if (description.length > MAX_SKILL_DESCRIPTION_CHARS) {
    warnings.push(`description is ${description.length} characters (spec limit ${MAX_SKILL_DESCRIPTION_CHARS})`)
  }

  const parsed: ParsedSkillMarkdown = {
    name,
    description,
    tag: field('tag')?.trim() ?? '',
    content: text.slice(match[0].length).replace(/^\n+/, '').trimEnd(),
    tools: [...new Set(tools)].slice(0, 64),
    warnings,
  }

  const license = field('license')?.trim()
  if (license) parsed.license = license
  const compatibility = field('compatibility')?.trim()
  if (compatibility) {
    parsed.compatibility = compatibility
    if (compatibility.length > MAX_SKILL_COMPATIBILITY_CHARS) {
      warnings.push(`compatibility is ${compatibility.length} characters (spec limit ${MAX_SKILL_COMPATIBILITY_CHARS})`)
    }
  }
  const allowed = field('allowed-tools')
  if (allowed?.trim()) parsed.allowedTools = allowed.split(/[\s,]+/).filter(Boolean)

  if (yaml) {
    const metadata = yaml.metadata
    if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
      const map: Record<string, string> = Object.create(null) as Record<string, string>
      for (const [key, value] of Object.entries(metadata as Record<string, unknown>)) {
        map[key] = asText(value) ?? JSON.stringify(value ?? null)
      }
      parsed.metadata = { ...map }
    }
    const extra: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(yaml)) {
      if (!KNOWN_KEYS.has(key) && key !== '__proto__') extra[key] = value
    }
    if (Object.keys(extra).length > 0) parsed.extra = extra
  } else {
    const extra: Record<string, unknown> = {}
    for (const [key, value] of lines) {
      if (!KNOWN_KEYS.has(key) && key !== '__proto__' && value) extra[key] = value
    }
    if (Object.keys(extra).length > 0) parsed.extra = extra
  }

  const bodyLines = parsed.content.split('\n').length
  if (bodyLines > SKILL_BODY_WARN_LINES) warnings.push(`body is ${bodyLines} lines (spec recommends under ${SKILL_BODY_WARN_LINES})`)
  return parsed
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
   description, tag, body and tools, with no warnings.
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
 * A single-line frontmatter value the parser reads back verbatim. Line breaks
 * fold to one space, and a `#` that a line reader would take for a comment
 * (first character, or after whitespace, outside quotes) becomes a fullwidth
 * `＃`, so the value also survives the importer's line-by-line fallback. Same
 * quote/escape walk as stripComment, so every other character is kept as-is.
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

/** Plain YAML scalars that read back unchanged; anything else is double-quoted. */
const PLAIN_SCALAR = /^[A-Za-z0-9][A-Za-z0-9 _.,()/+-]*$/
const PLAIN_RESERVED = /^(?:true|false|yes|no|on|off|null|~|[-+]?(?:\.inf|\.nan|[0-9][0-9_.,eE+-]*|0x[0-9a-fA-F]+|0o[0-7]+))$/i

/**
 * Emit a value for the importer's YAML read (BE-6): plain when that reads back
 * as the same string, else a double-quoted scalar. JSON string escapes are
 * valid YAML double-quoted escapes; U+0085/U+2028/U+2029 are escaped too so no
 * YAML version can take them for line breaks.
 */
function yamlScalar(value: string): string {
  if (PLAIN_SCALAR.test(value) && !/\s$/.test(value) && !PLAIN_RESERVED.test(value)) return value
  return JSON.stringify(value).replace(/[\u0085\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

/** Serialize a skill as SKILL.md: `name`, `description`, optional `tag` and `tools`, then the body. */
export function serializeSkillMarkdown(skill: SkillMarkdownSource): string {
  const name = frontmatterValue(skill.name) || 'skill'
  // The importer requires a description; a skill saved without one exports its name.
  const description = frontmatterValue(skill.description) || name
  const tag = frontmatterValue(skill.tag ?? '')
  const tools = [...new Set((skill.tools ?? []).map((t) => t.name).filter((n) => TOOL_NAME.test(n)))].slice(0, 64)
  const header = ['---', `name: ${yamlScalar(name)}`, `description: ${yamlScalar(description)}`]
  if (tag) header.push(`tag: ${yamlScalar(tag)}`)
  // `tools:` is always read line by line (raw tokens); names match TOOL_NAME, so the line is valid YAML too.
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
