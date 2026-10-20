// Registry facade first: it must load standalone (see registry.test.ts).
import { builtinTools, executeToolCall, type ToolContext } from '../tools.js'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Skill } from '../shared/types.js'
import { createStore, type WorkspaceStore } from '../store.js'
import { SCRIPTS_UNAVAILABLE, SKILL_PAGE_CHARS } from './skills.js'

let dir: string
let vendor: string
let store: WorkspaceStore
let ctx: ToolContext

const call = (name: string, args: object) => executeToolCall({ id: 'c', name, arguments: JSON.stringify(args) }, ctx)

function addSkill(partial: Partial<Skill> & { id: string }): Skill {
  const skill: Skill = { name: partial.id.split('/').pop() as string, description: 'd', tag: '', content: '', tools: [], sourceId: 'custom', hasScripts: false, files: [], defaultOn: false, ...partial }
  store.skills.push(skill)
  return skill
}

/** `head\n---\nbody`: the body may itself contain `---` lines. */
const split = (content: string) => {
  const cut = content.indexOf('\n---\n')
  return { head: content.slice(0, cut), body: content.slice(cut + 5) }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentcontrol-skill-tools-'))
  vendor = join(dir, 'vendor')
  mkdirSync(join(vendor, 'ecc', 'demo', 'references'), { recursive: true })
  vi.stubEnv('AGENTCONTROL_SKILLS_VENDOR_DIR', vendor)
  store = createStore(join(dir, 'store.json'))
  ctx = {
    store, agentId: 'a1', runId: 'r1', input: '', allowed: new Set(builtinTools.keys()),
    now: () => new Date('2026-10-20T07:00:00Z'), timeZone: 'UTC', writes: { count: 0 },
    catalogSkillIds: new Set(['custom-long', 'ecc/demo']), activatedSkills: new Map(),
  }
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

describe('activate_skill', () => {
  it('pages by 6,000 chars with `page`, and the pages rebuild the body exactly', async () => {
    const body = Array.from({ length: 1700 }, (_, i) => `line ${i} 😀`).join('\n')
    addSkill({ id: 'custom-long', content: body })
    let rebuilt = ''
    for (let page = 1; page <= Math.ceil(body.length / SKILL_PAGE_CHARS) + 1; page++) {
      const out = await call('activate_skill', { id: 'custom-long', page })
      expect(out.ok, out.content).toBe(true)
      const { head, body: text } = split(out.content)
      expect(text.length).toBeLessThanOrEqual(SKILL_PAGE_CHARS)
      rebuilt += text
      if (head.endsWith('the end.')) break
      expect(head).toContain('Next: activate_skill {"id":"custom-long","offset":')
    }
    expect(rebuilt).toBe(body)
    const past = await call('activate_skill', { id: 'custom-long', page: 99 })
    expect(past.ok).toBe(false)
    expect(past.content).toContain('past the end')
  })

  it('follows the Next offset exactly when the run has little room left', async () => {
    const body = 'abcdefghij'.repeat(1200)
    addSkill({ id: 'custom-long', content: body })
    ctx.resultMaxChars = 2_000
    let offset = 0
    let rebuilt = ''
    for (let i = 0; i < 20; i++) {
      const out = await call('activate_skill', { id: 'custom-long', offset })
      expect(out.content.length).toBeLessThanOrEqual(2_000)
      const { head, body: text } = split(out.content)
      rebuilt += text
      const next = /"offset":(\d+)\}$/.exec(head)
      if (!next) break
      offset = Number(next[1])
    }
    expect(rebuilt).toBe(body)
    ctx.resultMaxChars = 500
    expect((await call('activate_skill', { id: 'custom-long' })).content).toContain('Not enough room left')
  })

  it('resolves a bare name, records the skill once, and refuses skills outside the catalog', async () => {
    addSkill({ id: 'ecc/demo', sourceId: 'ecc', content: 'Demo steps.' })
    addSkill({ id: 'custom-secret', content: 'not yours' })
    expect((await call('activate_skill', { id: 'demo' })).ok).toBe(true)
    expect((await call('activate_skill', { id: 'ecc/demo' })).ok).toBe(true)
    const refused = await call('activate_skill', { id: 'custom-secret' })
    expect(refused.ok).toBe(false)
    expect(refused.content).toContain('No skill "custom-secret"')
    expect(refused.content).not.toContain('not yours')
    expect([...(ctx.activatedSkills?.values() ?? [])]).toEqual([{ id: 'ecc/demo', name: 'demo', source: 'ecc' }])
  })

  it('reads nothing when the run has no catalog', async () => {
    addSkill({ id: 'custom-long', content: 'x' })
    delete ctx.catalogSkillIds
    expect((await call('activate_skill', { id: 'custom-long' })).ok).toBe(false)
  })

  it('says script steps are unavailable and lists the readable files on the first page', async () => {
    addSkill({ id: 'ecc/demo', sourceId: 'ecc', hasScripts: true, files: ['SKILL.md', 'references/a.md', 'scripts/run.sh'], content: 'Run the script.' })
    const { head, body } = split((await call('activate_skill', { id: 'ecc/demo' })).content)
    expect(head).toContain(SCRIPTS_UNAVAILABLE)
    expect(head).toContain('Files (read with read_skill_file): references/a.md, scripts/run.sh')
    expect(body).toBe('Run the script.')
  })
})

describe('read_skill_file', () => {
  beforeEach(() => {
    writeFileSync(join(vendor, 'ecc', 'demo', 'references', 'a.md'), `# A\n${'ref '.repeat(2000)}`)
    writeFileSync(join(vendor, 'ecc', 'demo', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]))
    writeFileSync(join(dir, 'outside.txt'), 'outside')
    addSkill({ id: 'ecc/demo', sourceId: 'ecc', files: ['SKILL.md', 'references/a.md', 'logo.png', '../../../outside.txt'] })
  })

  it('reads a listed text file in pages', async () => {
    const first = await call('read_skill_file', { id: 'ecc/demo', path: 'references/a.md' })
    expect(first.ok, first.content).toBe(true)
    const { head, body } = split(first.content)
    expect(head).toMatch(/^File ecc\/demo\/references\/a\.md\. chars 1-6000 of 8004\. Next: read_skill_file/)
    expect(body.startsWith('# A\nref ')).toBe(true)
    const second = split((await call('read_skill_file', { id: 'ecc/demo', path: 'references/a.md', page: 2 })).content)
    expect(second.head).toContain('chars 6001-8004 of 8004, the end.')
  })

  it('refuses unlisted, binary and out-of-folder paths, and core or custom skills', async () => {
    const unlisted = await call('read_skill_file', { id: 'ecc/demo', path: 'nope.md' })
    expect(unlisted.content).toContain('No file "nope.md" in ecc/demo')
    expect((await call('read_skill_file', { id: 'ecc/demo', path: 'logo.png' })).content).toContain('not a text file')
    const escape = await call('read_skill_file', { id: 'ecc/demo', path: '../../../outside.txt' })
    expect(escape.ok).toBe(false)
    expect(escape.content).toContain('outside the skill folder')
    addSkill({ id: 'custom-long', files: ['notes.md'] })
    expect((await call('read_skill_file', { id: 'custom-long', path: 'notes.md' })).content).toContain('not available on this server')
  })
})
