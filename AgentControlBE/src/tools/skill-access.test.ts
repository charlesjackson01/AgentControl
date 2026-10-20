// Registry facade first: it must load standalone (see registry.test.ts).
import { builtinTools, executeToolCall, type ToolContext } from '../tools.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentRun, Note, Skill } from '../shared/types.js'
import { createStore } from '../store.js'
import { clipJsonText, pageText, RESULT_MAX_CHARS } from './limits.js'
import { REDACTED, redactSecrets } from './redact.js'

/**
 * A configured endpoint key. No 4-char fragment of it may reach any result:
 * the old clips leaked prefixes this short ("QzX9…"), which exact-match
 * redaction cannot find. Mixed case so no fragment occurs in ordinary output.
 */
const KEY = 'QzX9wK7vJm3TnR5pLb8Y'
const KEY_FRAGMENTS = Array.from({ length: KEY.length - 3 }, (_, i) => KEY.slice(i, i + 4))

let dir: string
let ctx: ToolContext

type Outcome = { ok: boolean; content: string }
type Json = Record<string, unknown>
const call = (name: string, args: object = {}): Promise<Outcome> =>
  executeToolCall({ id: 'c', name, arguments: JSON.stringify(args) }, ctx)

async function ok(name: string, args: object = {}): Promise<Json> {
  const out = await call(name, args)
  expect(out.ok, out.content).toBe(true)
  expect(out.content.length).toBeLessThanOrEqual(RESULT_MAX_CHARS)
  return JSON.parse(out.content) as Json
}

async function failure(name: string, args: object = {}): Promise<string> {
  const out = await call(name, args)
  expect(out.ok, out.content).toBe(false)
  return out.content
}

function exampleOf(message: string): Json {
  const match = /Example: (\{.*\})$/.exec(message)
  expect(match, message).not.toBeNull()
  return JSON.parse(match?.[1] ?? '{}') as Json
}

function expectNoKey(text: string, label = ''): void {
  for (const fragment of KEY_FRAGMENTS) expect(text.includes(fragment), `${label} leaks "${fragment}"`).toBe(false)
}

function makeSkill(partial: Partial<Skill> & { id: string; name: string }): Skill {
  return { description: '', tag: 'Ops', content: '', tools: [], sourceId: 'custom', hasScripts: false, files: [], defaultOn: false, ...partial }
}

const toolDecl = (name: string) => ({ name, description: `${name} tool`, parameters: {} })

function makeNote(partial: Partial<Note> & { title: string; body: string }): Note {
  return {
    id: `note_${partial.title.toLowerCase().replace(/\W+/g, '_')}`,
    tags: [],
    authorAgentId: 'a1',
    updatedByAgentId: 'a1',
    runId: 'r0',
    createdAt: '2026-10-12T05:00:00.000Z',
    updatedAt: '2026-10-12T05:00:00.000Z',
    ...partial,
  }
}

/** Every page of `tool` from offset 0, checking each result's shape and size. */
async function walk(tool: 'get_skill' | 'read_note', args: Json, field: 'content' | 'body'): Promise<Json[]> {
  const pages: Json[] = []
  let offset: number | null = 0
  let previous = ''
  for (let i = 0; offset !== null; i++) {
    if (i > 500) throw new Error('paging did not terminate')
    const page = await ok(tool, { ...args, offset })
    expect(page.truncated, `page at ${offset}`).toBeUndefined()
    expect(page.offset).toBe(offset)
    const text = page[field] as string
    const next = page.nextOffset as number | null
    if (next !== null) {
      expect(text.length, `page at ${offset}`).toBeGreaterThan(0)
      expect(next).toBe(offset + text.length)
    }
    // No page edge falls between the halves of a surrogate pair.
    const last = previous.charCodeAt(previous.length - 1)
    const first = text.charCodeAt(0)
    expect(last >= 0xd800 && last <= 0xdbff && first >= 0xdc00 && first <= 0xdfff, `page at ${offset}`).toBe(false)
    pages.push(page)
    previous = text
    offset = next
  }
  return pages
}

beforeEach(() => {
  vi.stubEnv('AGENTCONTROL_SECRET', 'skill-access-test-secret')
  vi.stubEnv('AGENTCONTROL_AUTH_TOKEN', '')
  dir = mkdtempSync(join(tmpdir(), 'skill-access-'))
  const store = createStore(join(dir, 'store.json'))
  store.agents.push({ id: 'a1', name: 'Author', role: '', description: '', instructions: '', modelId: 'm',
    endpointId: 'ep_local_llama', skillIds: [], isPrimary: true, status: 'idle', createdAt: '', lastRunAt: null, runCount: 0,
    slug: 'author', internetPolicy: 'ask', memoryLearn: true })
  store.skills = [
    makeSkill({
      id: 'core/code-review',
      name: 'Code Review',
      description: 'Review a diff for bugs.',
      content: 'Read the diff. Report bugs first.',
      tools: [toolDecl('list_notes'), toolDecl('read_note'), toolDecl('list_notes')],
    }),
    makeSkill({ id: 'core/summarization', name: 'Summarization', content: 'Summarize.' }),
  ]
  store.notes = []
  store.endpointKeys.ep_local_llama = KEY
  ctx = { store, agentId: 'a1', runId: 'r1', input: 'hello', allowed: new Set(builtinTools.keys()),
    now: () => new Date('2026-10-12T06:00:00Z'), timeZone: 'UTC', writes: { count: 0 } }
})
afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }) })

describe('pageText', () => {
  /** Deterministic text mixing plain chars, escapes, control chars, emoji and lone surrogates. */
  function mixed(length: number, seed: number): string {
    const alphabet = ['a', 'b', ' ', '"', '\\', '\n', '\t', '\u0001', '\u001f', '😀', '👍🏽', '\ud800', '\udc00', 'é', '/', ' ']
    let s = seed
    let out = ''
    while (out.length < length) {
      s = (s * 1103515245 + 12345) % 2147483648
      out += alphabet[s % alphabet.length]
    }
    return out
  }

  it('keeps every page within its char and JSON budgets, maximal, and exact end to end', () => {
    for (const [seed, pageChars, budget] of [[1, 2500, 3200], [2, 100, 60], [3, 2, 8], [4, 37, 9], [5, 5000, 400]] as const) {
      const text = mixed(3000, seed)
      let joined = ''
      let offset: number | null = 0
      for (let i = 0; offset !== null; i++) {
        expect(i).toBeLessThan(3001)
        const page = pageText(text, offset, pageChars, budget)
        expect(page.offset).toBe(offset)
        expect(page.totalChars).toBe(text.length)
        expect(page.content.length).toBeGreaterThan(0)
        expect(page.content.length).toBeLessThanOrEqual(pageChars)
        expect(JSON.stringify(page.content).length).toBeLessThanOrEqual(budget)
        if (page.nextOffset !== null) {
          // Maximal: the next code point would break a budget.
          const after = text.codePointAt(page.nextOffset)!
          const grown = page.content + String.fromCodePoint(after)
          const pairOrUnit = after > 0xffff ? grown : page.content + text[page.nextOffset]
          expect(pairOrUnit.length > pageChars || JSON.stringify(pairOrUnit).length > budget).toBe(true)
        }
        joined += page.content
        offset = page.nextOffset
      }
      expect(joined).toBe(text)
    }
  })

  it('returns an empty last page for empty text and rejects bad offsets', () => {
    expect(pageText('', 0, 10, 20)).toEqual({ content: '', offset: 0, nextOffset: null, totalChars: 0 })
    expect(() => pageText('abc', 3, 10, 20)).toThrow(RangeError)
    expect(() => pageText('abc', 3, 10, 20)).toThrow(/past the end of the text \(3 chars\)/)
    expect(() => pageText('', 1, 10, 20)).toThrow(RangeError)
    expect(() => pageText('abc', -1, 10, 20)).toThrow(RangeError)
    expect(() => pageText('abc', 1.5, 10, 20)).toThrow(RangeError)
    expect(() => pageText('abc', 0, 1, 20)).toThrow(/at least 2/)
    expect(() => pageText('abc', 0, 10, 7)).toThrow(/at least 8/)
  })

  it('starts an offset that lands inside a surrogate pair at the pair', () => {
    const page = pageText('😀😀😀', 1, 10, 100)
    expect(page.offset).toBe(0)
    expect(page.content).toBe('😀😀😀')
    // A lone low surrogate is its own char, not half of a pair.
    expect(pageText('a\udc00b', 1, 10, 100).content).toBe('\udc00b')
  })
})

describe('clipJsonText', () => {
  it('bounds chars and JSON size, never splitting a pair before the ellipsis', () => {
    expect(clipJsonText('short', 10, 20)).toBe('short')
    expect(clipJsonText('"'.repeat(10), 10, 22)).toBe('"'.repeat(10))
    const quoted = clipJsonText('"'.repeat(10), 10, 12)
    expect(JSON.stringify(quoted).length).toBeLessThanOrEqual(12)
    expect(quoted.endsWith('…')).toBe(true)
    for (let max = 2; max <= 12; max++) {
      const clipped = clipJsonText('😀'.repeat(10), max, 100)
      expect(clipped.length).toBeLessThanOrEqual(max)
      const body = clipped.slice(0, -1)
      const last = body.charCodeAt(body.length - 1)
      expect(last >= 0xd800 && last <= 0xdbff, `max=${max}`).toBe(false)
    }
  })
})

describe('get_skill', () => {
  it('is a read-only workspace tool appended after the original three, with a short declaration', () => {
    const entry = builtinTools.get('get_skill')!
    expect([...builtinTools.keys()].slice(0, 3)).toEqual(['list_agents', 'list_skills', 'read_run_log'])
    expect(entry).toMatchObject({ category: 'workspace', effect: 'read' })
    expect(entry.contentParams).toBeUndefined()
    expect(entry.description.length).toBeLessThanOrEqual(240)
    expect(entry.description).toContain('Example: {"skill":"code-review"}')
    expect(entry.parameters).toMatchObject({ required: ['skill'], additionalProperties: false })
  })

  it('reads a skill by id, by name (any case) and by every alias small models send', async () => {
    const expected = {
      id: 'core/code-review',
      name: 'Code Review',
      description: 'Review a diff for bugs.',
      tools: ['list_notes', 'read_note'],
      totalChars: 33,
      offset: 0,
      content: 'Read the diff. Report bugs first.',
      nextOffset: null,
    }
    expect(await ok('get_skill', { skill: 'core/code-review' })).toEqual(expected)
    expect(await ok('get_skill', { skill: ' code review ' })).toEqual(expected)
    for (const key of ['skillId', 'skill_id', 'id', 'name']) {
      expect(await ok('get_skill', { [key]: 'Code Review' }), key).toEqual(expected)
    }
    // A blank "skill" falls through to the alias.
    expect((await ok('get_skill', { skill: ' ', name: 'summarization' })).id).toBe('core/summarization')
    // A bare BE-6 name resolves to its <source>/<name> id.
    expect(await ok('get_skill', { skill: 'code-review' })).toEqual(expected)
  })

  it('walks long content exactly, through emoji and heavy JSON escapes', async () => {
    const parts = ['plain text ', '😀👍🏽', '"quoted"', '\\path\\', '\n\t', '\u0001\u001f', '\ud800', 'x\udc00', 'é/ ']
    let content = ''
    for (let i = 0; content.length < 12_000; i++) content += parts[i % parts.length]
    ctx.store.skills[0]!.content = content
    const pages = await walk('get_skill', { skill: 'core/code-review' }, 'content')
    expect(pages.map((p) => p.content).join('')).toBe(content)
    expect(pages.every((p) => p.totalChars === content.length)).toBe(true)
    // Escapes shrink pages below 2,500 chars, so more pages than the plain count.
    expect(pages.length).toBeGreaterThan(Math.ceil(content.length / 2500))

    ctx.store.skills[0]!.content = '"\\\n\u0001'.repeat(3000)
    const escaped = await walk('get_skill', { skill: 'core/code-review' }, 'content')
    expect(escaped.map((p) => p.content).join('')).toBe(ctx.store.skills[0]!.content)

    ctx.store.skills[0]!.content = '😀'.repeat(5000)
    const emoji = await walk('get_skill', { skill: 'core/code-review' }, 'content')
    expect(emoji.map((p) => p.content).join('')).toBe(ctx.store.skills[0]!.content)
    expect(emoji[0]!.content).toHaveLength(2500)
  })

  it('pages exactly with worst-case metadata (control-char names, 16 long tool names)', async () => {
    const skill = ctx.store.skills[0]!
    skill.id = '\u0001'.repeat(150)
    skill.name = '"'.repeat(150)
    skill.description = '\u0002'.repeat(400)
    skill.tools = Array.from({ length: 20 }, (_, i) => toolDecl(`${String(i).padStart(2, '0')}${'t'.repeat(62)}`))
    skill.content = 'abc\n'.repeat(4000)
    const pages = await walk('get_skill', { skill: '"'.repeat(150) }, 'content')
    expect(pages.map((p) => p.content).join('')).toBe(skill.content)
    expect((pages[0]!.tools as string[]).length).toBe(16)
  })

  it('accepts a lenient offset and starts mid-pair at the pair', async () => {
    ctx.store.skills[0]!.content = '😀'.repeat(3000)
    const page = await ok('get_skill', { skill: 'core/code-review', offset: '2501' })
    expect(page.offset).toBe(2500)
    expect(page.nextOffset).toBe(5000)
    expect((await ok('get_skill', { skill: 'core/code-review', offset: 2500.9 })).offset).toBe(2500)
  })

  it('rejects an offset past the end or below zero with a usable example', async () => {
    const past = await failure('get_skill', { skill: 'Code Review', offset: 33 })
    expect(past).toContain('Offset 33 is past the end of the text (33 chars)')
    expect(exampleOf(past)).toEqual({ skill: 'core/code-review', offset: 0 })
    expect(await failure('get_skill', { skill: 'core/code-review', offset: 1e308 })).toContain('past the end')
    expect(await failure('get_skill', { skill: 'core/code-review', offset: -1 })).toContain('"offset" must be at least 0')
    expect(await failure('get_skill', { skill: 'core/code-review', offset: 'soon' })).toContain('"offset" must be a number')
    // Offset 0 of empty content is a valid (empty, last) page.
    ctx.store.skills[1]!.content = ''
    expect(await ok('get_skill', { skill: 'core/summarization' })).toMatchObject({ content: '', nextOffset: null, totalChars: 0 })
  })

  it('names a bounded list of known skills when the skill is unknown or missing', async () => {
    const unknown = await failure('get_skill', { skill: 'nope' })
    expect(unknown).toContain('No skill "nope". Known skills: "Code Review", "Summarization".')
    expect(exampleOf(unknown)).toEqual({ skill: 'Code Review' })
    const missing = await failure('get_skill', {})
    expect(missing).toContain('"skill" is required')
    expect(exampleOf(missing)).toEqual({ skill: 'Code Review' })

    for (let i = 0; i < 40; i++) ctx.store.skills.push(makeSkill({ id: `s${i}`, name: `Extra ${i}` }))
    const many = await failure('get_skill', { skill: 'nope' })
    expect(many.match(/"Extra \d+"/g)).toHaveLength(8)
    expect(many).toContain('"Extra 7", ….')

    // An example never names a skill whose name redaction or clipping changed.
    ctx.store.skills = [makeSkill({ id: 'k', name: `Uses ${KEY}` }), makeSkill({ id: 'l', name: 'L'.repeat(60) })]
    const fallback = await failure('get_skill', { skill: 'nope' })
    expectNoKey(fallback)
    expect(exampleOf(fallback)).toEqual({ skill: 'code-review' })
    ctx.store.skills = []
    expect(await failure('get_skill', { skill: 'nope' })).toContain('Known skills: none.')
  })

  it('redacts a configured key across a page boundary, at the clip edge and in metadata', async () => {
    const skill = ctx.store.skills[0]!
    // Raw positions: across the 2,500 page edge, near later edges, and at the very end.
    skill.content = `${'.'.repeat(2490)}${KEY}${'.'.repeat(2480)}${KEY}${'-'.repeat(2470)}${KEY}`
    skill.description = `${'.'.repeat(295)}${KEY}`
    skill.name = `Name ${KEY}`
    const pages = await walk('get_skill', { skill: 'core/code-review' }, 'content')
    const redacted = redactSecrets(skill.content, ctx.store)
    expect(pages.map((p) => p.content).join('')).toBe(redacted)
    expect(redacted.split(REDACTED)).toHaveLength(4)
    for (const page of pages) expectNoKey(JSON.stringify(page), `page at ${page.offset}`)
    expect(pages[0]!.name).toBe(`Name ${REDACTED}`)
    expect((pages[0]!.description as string).length).toBeLessThanOrEqual(300)

    // Every start offset, including ones a page never returned, stays clean.
    for (let offset = 2480; offset < 2530; offset++) {
      expectNoKey((await call('get_skill', { skill: 'core/code-review', offset })).content, `offset ${offset}`)
    }
  })

  it('pages 1 MB of content quickly', async () => {
    ctx.store.skills[0]!.content = `${KEY} ${'word '.repeat(200_000)}${KEY}`
    const started = performance.now()
    const first = await ok('get_skill', { skill: 'core/code-review' })
    const total = first.totalChars as number
    const last = await ok('get_skill', { skill: 'core/code-review', offset: total - 10 })
    expect(performance.now() - started).toBeLessThan(1_000)
    expect(last.nextOffset).toBeNull()
    expect(last.content).toBe(REDACTED)
    expectNoKey(JSON.stringify([first, last]))
  })
})

describe('list_skills redaction', () => {
  it('redacts a key at the old 100-char description clip edge', async () => {
    ctx.store.skills[0]!.description = `${'.'.repeat(95)}${KEY} more`
    const out = await call('list_skills')
    expect(out.ok).toBe(true)
    expectNoKey(out.content)
    const rows = JSON.parse(out.content) as { id: string; description: string }[]
    expect(rows[0]!.description).toBe(`${'.'.repeat(95)}[red…`)
    expect(rows.map((r) => r.id)).toEqual(['core/code-review', 'core/summarization'])
  })

  it('redacts names and ids before fitJson can clip them', async () => {
    for (let i = 0; i < 80; i++) {
      ctx.store.skills.push(makeSkill({ id: `id-${'i'.repeat(70)}${KEY}-${i}`, name: `${'n'.repeat(75)}${KEY} ${i}`, description: 'd'.repeat(100) }))
    }
    const out = await call('list_skills')
    expect(out.ok).toBe(true)
    expect(out.content.length).toBeLessThanOrEqual(RESULT_MAX_CHARS)
    expect(out.content).toContain('"truncated":true')
    expectNoKey(out.content)
  })
})

describe('list_notes and read_run_log redaction', () => {
  it('redacts a key at the old 500-char read_run_log clip edge', async () => {
    const run: AgentRun = { id: 'run1', agentId: 'a1', startedAt: '2026-10-12T05:00:00.000Z', status: 'failed',
      durationMs: 1, steps: 1, input: `${'.'.repeat(496)}${KEY}`, output: `${'.'.repeat(490)}${KEY}`, error: null }
    ctx.store.runs = [run]
    const out = await call('read_run_log')
    expect(out.ok).toBe(true)
    expectNoKey(out.content)
    const rows = JSON.parse(out.content) as { input: string; error: unknown }[]
    expect(rows[0]!.input).toBe(`${'.'.repeat(496)}[re…`)
    expect(rows[0]!.error).toBeNull()
  })
})
