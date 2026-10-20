/**
 * BE-7 on-demand skill loading. The prompt lists each enabled skill as one
 * catalog line; activate_skill returns a skill's body in 6,000-char pages and
 * records it in the run's activity, and read_skill_file reads text files in a
 * vendored skill's folder. Both read only the agent's own catalog skills.
 */
import { readFile, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { vendoredLibrary } from '../db/vendored-skills.js'
import type { Skill } from '../shared/types.js'
import { argError, findSkillIn, readNumber } from './args.js'
import type { ToolContext, ToolEntry } from './types.js'

/** Characters of skill text per page (activate_skill and read_skill_file). */
export const SKILL_PAGE_CHARS = 6_000
/** Room for the page plus its header lines; the run loop keeps results up to this. */
export const SKILL_RESULT_MAX_CHARS = 7_000
/** read_skill_file refuses files larger than this. */
export const SKILL_FILE_MAX_BYTES = 1024 * 1024
export const SCRIPTS_UNAVAILABLE = 'Script steps are unavailable in this version; follow the other steps with your own tools.'

const ACTIVATE_EXAMPLE = { id: 'superpowers/systematic-debugging' }
const FILE_EXAMPLE = { id: 'anthropics/skill-creator', path: 'references/schemas.md' }

function readString(args: Record<string, unknown>, keys: string[], example: Record<string, unknown>): string {
  for (const key of keys) {
    const v = args[key]
    if (typeof v === 'string' && v.trim() !== '') return v.trim().slice(0, 300)
  }
  throw argError(`"${keys[0]}" is required.`, example)
}

/** The agent's catalog skill for this reference, or an error listing a few real ids. */
function catalogSkill(ctx: ToolContext, ref: string, example: Record<string, unknown>): Skill {
  const scope = ctx.catalogSkillIds ?? new Set<string>()
  const pool = ctx.store.skills.filter((s) => scope.has(s.id))
  const skill = findSkillIn(pool, ref)
  if (skill) return skill
  const ids = pool.slice(0, 10).map((s) => s.id)
  const known = ids.length === 0 ? 'none' : `${ids.join(', ')}${pool.length > 10 ? ', …' : ''}`
  throw argError(`No skill "${ref.slice(0, 80)}" in this agent's skills list. Known: ${known}.`, ids[0] ? { id: ids[0] } : example)
}

interface Page {
  start: number
  end: number
  total: number
  text: string
}

/** Header lines and separator take at most this much of a result. */
const HEADER_ROOM = 700

/**
 * One slice of `text`: `page` (1-based, 6,000 chars each) or an exact
 * `offset` from a previous Next hint. The slice shrinks to the room the run
 * has left (ctx.resultMaxChars), so the run loop never cuts it, and the
 * Next hint carries the exact offset to continue from. Never splits a
 * surrogate pair.
 */
export function skillPage(text: string, args: Record<string, unknown>, ctx: ToolContext, example: Record<string, unknown>): Page {
  const offset = readNumber(args, 'offset', { min: 0, integer: true, example: { ...example, offset: 0 } })
  const page = readNumber(args, 'page', { min: 1, integer: true, example: { ...example, page: 1 } })
  const start = offset ?? ((page ?? 1) - 1) * SKILL_PAGE_CHARS
  const total = text.length
  if (start > 0 && start >= total) {
    const pages = Math.max(1, Math.ceil(total / SKILL_PAGE_CHARS))
    throw argError(`That is past the end (${total} chars, ${pages === 1 ? '1 page' : `${pages} pages`}).`, { ...example, page: 1 })
  }
  const room = Math.min(SKILL_PAGE_CHARS, (ctx.resultMaxChars ?? SKILL_RESULT_MAX_CHARS) - HEADER_ROOM)
  if (room < 200) throw new Error('Not enough room left in this conversation to read more. Answer with what you have.')
  let end = Math.min(total, start + room)
  const c = text.charCodeAt(end - 1)
  if (end < total && c >= 0xd800 && c <= 0xdbff) end -= 1
  return { start, end, total, text: text.slice(start, end) }
}

function pageHeader(p: Page, tool: string, args: Record<string, unknown>): string {
  const range = p.total === 0 ? 'empty' : `chars ${p.start + 1}-${p.end} of ${p.total}`
  return p.end < p.total ? `${range}. Next: ${tool} ${JSON.stringify({ ...args, offset: p.end })}` : `${range}, the end.`
}

/** Where a vendored skill's folder is on disk, or null (core and custom skills have no folder). */
function skillFolder(skill: Skill): string | null {
  const slash = skill.id.indexOf('/')
  if (!skill.sourceId || skill.sourceId === 'core' || skill.sourceId === 'custom' || slash < 0) return null
  const dir = vendoredLibrary().dir
  return dir ? join(dir, skill.sourceId, skill.id.slice(slash + 1)) : null
}

export const skillTools: ToolEntry[] = [
  {
    name: 'activate_skill',
    category: 'workspace',
    effect: 'read',
    description:
      'Load one of your skills (an id from the Skills list) and get its full instructions, in pages of 6,000 characters. Example: {"id":"superpowers/systematic-debugging"}',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Skill id from the Skills list in your instructions.' },
        page: { type: 'number', description: 'Page to read, starting at 1. Default 1.' },
        offset: { type: 'number', description: 'Exact character offset from a previous Next hint (instead of page).' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    maxResultChars: SKILL_RESULT_MAX_CHARS,
    handler: (args, ctx) => {
      const skill = catalogSkill(ctx, readString(args, ['id', 'skill', 'name'], ACTIVATE_EXAMPLE), ACTIVATE_EXAMPLE)
      const p = skillPage(skill.content ?? '', args, ctx, { id: skill.id })
      if (ctx.activatedSkills && !ctx.activatedSkills.has(skill.id)) {
        ctx.activatedSkills.set(skill.id, { id: skill.id, name: skill.name, source: skill.sourceId ?? 'custom' })
      }
      const files = (skill.files ?? []).filter((f) => f !== 'SKILL.md')
      const lines = [`Skill ${skill.id} (${skill.name}). ${pageHeader(p, 'activate_skill', { id: skill.id })}`]
      if (p.start === 0 && skill.hasScripts) lines.push(SCRIPTS_UNAVAILABLE)
      if (p.start === 0 && files.length > 0) {
        const shown = files.slice(0, 30).join(', ')
        lines.push(`Files (read with read_skill_file): ${shown}${files.length > 30 ? `, … (${files.length} in all)` : ''}`)
      }
      return `${lines.join('\n')}\n---\n${p.text}`
    },
  },
  {
    name: 'read_skill_file',
    category: 'workspace',
    effect: 'read',
    description:
      "Read a text file inside one of your skills' folders (paths are listed by activate_skill), in pages of 6,000 characters. Example: {\"id\":\"anthropics/skill-creator\",\"path\":\"references/schemas.md\"}",
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Skill id from the Skills list.' },
        path: { type: 'string', description: 'File path inside the skill folder, as activate_skill lists it.' },
        page: { type: 'number', description: 'Page to read, starting at 1. Default 1.' },
        offset: { type: 'number', description: 'Exact character offset from a previous Next hint (instead of page).' },
      },
      required: ['id', 'path'],
      additionalProperties: false,
    },
    maxResultChars: SKILL_RESULT_MAX_CHARS,
    handler: async (args, ctx) => {
      const skill = catalogSkill(ctx, readString(args, ['id', 'skill', 'name'], FILE_EXAMPLE), FILE_EXAMPLE)
      const path = readString(args, ['path', 'file'], { ...FILE_EXAMPLE, id: skill.id }).replace(/^\.\//, '')
      const files = skill.files ?? []
      if (!files.includes(path)) {
        const known = files.length === 0 ? 'this skill has no files' : `known: ${files.slice(0, 15).join(', ')}${files.length > 15 ? ', …' : ''}`
        throw argError(`No file "${path.slice(0, 120)}" in ${skill.id} (${known}).`, { id: skill.id, path: files[0] ?? 'SKILL.md' })
      }
      const folder = skillFolder(skill)
      if (!folder) throw new Error(`The files of ${skill.id} are not available on this server.`)
      // files[] comes from a folder listing, but resolve anyway so nothing outside the folder is read.
      const full = resolve(folder, path)
      if (!full.startsWith(resolve(folder) + sep)) throw new Error('That path is outside the skill folder.')
      const info = await stat(full)
      if (info.size > SKILL_FILE_MAX_BYTES) throw new Error(`"${path}" is too large to read (${info.size} bytes, max ${SKILL_FILE_MAX_BYTES}).`)
      const bytes = await readFile(full)
      let text: string
      try {
        if (bytes.includes(0)) throw new Error('binary')
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      } catch {
        throw new Error(`"${path}" is not a text file; only text files can be read.`)
      }
      const p = skillPage(text, args, ctx, { id: skill.id, path })
      return `File ${skill.id}/${path}. ${pageHeader(p, 'read_skill_file', { id: skill.id, path })}\n---\n${p.text}`
    },
  },
]
