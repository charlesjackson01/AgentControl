import { describe, expect, it } from 'vitest'
import { seedSkills } from './db/seed.js'
import { DEFAULT_VENDOR_DIR, loadVendoredLibrary } from './db/vendored-skills.js'
import {
  attachedSkills,
  CATALOG_HEADER,
  catalogLine,
  estimateTokens,
  FOREIGN_TOOLS_NOTE,
  planPrompt,
  skillCatalog,
} from './prompt.js'
import type { Skill } from './shared/types.js'

function skill(id: string, contentChars: number, extra: Partial<Skill> = {}): Skill {
  return {
    id,
    name: id,
    description: `What ${id} does.`,
    tag: '',
    content: `${id}:`.padEnd(contentChars, 'x'),
    tools: [],
    sourceId: 'custom',
    hasScripts: false,
    files: [],
    defaultOn: false,
    ...extra,
  }
}

const names = (plan: ReturnType<typeof planPrompt>) => plan.toolDeclarations.map((t) => t.name)

describe('skill catalog', () => {
  it('is one `- <id>: <description>` line per skill under the header, then the foreign-tools note', () => {
    const a = skill('a', 10)
    const b = skill('b', 10)
    expect(skillCatalog([a, b])).toBe(`${CATALOG_HEADER}\n- a: What a does.\n- b: What b does.\n${FOREIGN_TOOLS_NOTE}`)
    expect(skillCatalog([])).toBe('')
  })

  it('clips the description to 300 chars on one line and drops an empty one', () => {
    const long = skill('long', 10, { description: `line one\nline two ${'y'.repeat(400)}` })
    const line = catalogLine(long)
    expect(line.startsWith('- long: line one line two ')).toBe(true)
    expect(line.length).toBe('- long: '.length + 300)
    expect(catalogLine(skill('bare', 10, { description: '  ' }))).toBe('- bare')
  })

  it('lists a repeated attachment once', () => {
    const a = skill('a', 10)
    expect(skillCatalog([a, a]).match(/- a:/g)).toHaveLength(1)
    expect(planPrompt({ instructions: '', skills: [a, a], input: '', contextWindow: 8192 }).catalogSkillIds).toEqual(['a'])
  })
})

describe('planPrompt catalog mode', () => {
  it('never puts a skill body in the prompt, however large', () => {
    const big = skill('big', 200_000)
    const plan = planPrompt({ instructions: 'Be brief.', skills: [big], input: '', contextWindow: 8192 })
    expect(plan.mode).toBe('catalog')
    expect(plan.system).toBe(`Be brief.\n\n${skillCatalog([big])}`)
    expect(plan.system).not.toContain('xxxx')
  })

  it('offers declared registry tools first, then activate_skill, and read_skill_file only when a skill has files', () => {
    const withTools = skill('t', 10, { tools: [{ name: 'list_skills', description: 'stored', parameters: {} }] })
    expect(names(planPrompt({ instructions: '', skills: [withTools], input: '', contextWindow: 8192 }))).toEqual([
      'list_skills',
      'activate_skill',
    ])
    const withFiles = skill('f', 10, { files: ['SKILL.md', 'references/a.md'] })
    expect(names(planPrompt({ instructions: '', skills: [withFiles], input: '', contextWindow: 8192 }))).toEqual([
      'activate_skill',
      'read_skill_file',
    ])
  })

  it('has no skill section and no tools without skills', () => {
    const plan = planPrompt({ instructions: 'Hi.', skills: [], input: 'q', contextWindow: 8192 })
    expect(plan).toMatchObject({ system: 'Hi.', toolDeclarations: [], catalogTokens: 0, mode: 'catalog' })
    expect(plan.estimatedTokens).toBe(estimateTokens(4))
  })

  it('counts system, input and tool schemas in estimatedTokens, and the catalog alone in catalogTokens', () => {
    const a = skill('a', 10)
    const plan = planPrompt({ instructions: 'Hi.', skills: [a], input: 'question', contextWindow: 8192 })
    const schema = JSON.stringify(plan.toolDeclarations).length
    expect(plan.estimatedTokens).toBe(estimateTokens(plan.system.length + 'question'.length + schema))
    expect(plan.catalogTokens).toBe(estimateTokens(skillCatalog([a]).length))
  })

  it('is too-large once the catalog passes 25% of the window', () => {
    const many = Array.from({ length: 40 }, (_, i) => skill(`s${i}`, 10, { description: 'd'.repeat(300) }))
    const catalogTokens = estimateTokens(skillCatalog(many).length)
    const fits = Math.ceil(catalogTokens / 0.25)
    expect(planPrompt({ instructions: '', skills: many, input: '', contextWindow: fits + 1000 }).mode).toBe('catalog')
    expect(planPrompt({ instructions: '', skills: many, input: '', contextWindow: fits - 8 }).mode).toBe('too-large')
  })

  it('is too-large when instructions alone overflow the window minus the reply reserve', () => {
    const plan = planPrompt({ instructions: 'x'.repeat(4 * 5000), skills: [], input: '', contextWindow: 8192 })
    expect(plan.mode).toBe('too-large')
  })

  it('lists the core seeds with their real ids', () => {
    const plan = planPrompt({ instructions: '', skills: seedSkills, input: '', contextWindow: 32_768 })
    for (const s of seedSkills) expect(plan.system).toContain(`\n- ${s.id}: `)
  })

  it('fits the 41 default skills in about 3.6k tokens on a 32k endpoint', () => {
    const library = loadVendoredLibrary(DEFAULT_VENDOR_DIR)
    const defaults = [...seedSkills, ...library.skills].filter((s) => s.defaultOn)
    expect(defaults).toHaveLength(41)
    const plan = planPrompt({ instructions: '', skills: defaults, input: '', contextWindow: 32_768 })
    expect(plan.mode).toBe('catalog')
    expect(plan.catalogTokens).toBeGreaterThan(2_500)
    expect(plan.catalogTokens).toBeLessThan(4_500)
    expect(plan.catalogTokens).toBeLessThan(32_768 * 0.25)
  })
})

describe('attachedSkills', () => {
  it('keeps attachment order and repeats, and skips unknown ids', () => {
    const a = skill('a', 10)
    const b = skill('b', 10)
    expect(attachedSkills([a, b], ['b', 'gone', 'a', 'b'])).toEqual([b, a, b])
    expect(attachedSkills([a, b], [])).toEqual([])
  })

  it('resolves a duplicated store id to the first skill, like Array.find', () => {
    const first = skill('dup', 10)
    const second = skill('dup', 20)
    expect(attachedSkills([first, second], ['dup'])[0]).toBe(first)
  })
})

describe('replyReserve and planPrompt responseReserve', () => {
  it('defaults to RESPONSE_RESERVE and moves the hard limit', async () => {
    const { replyReserve, RESPONSE_RESERVE } = await import('./prompt.js')
    expect(replyReserve({})).toBe(RESPONSE_RESERVE)
    expect(replyReserve({ maxOutputTokens: 512 })).toBe(512)
    const base = { instructions: 'x'.repeat(4 * 3000), skills: [], input: '', contextWindow: 8192 }
    expect(planPrompt({ ...base, responseReserve: 6000 }).mode).toBe('too-large')
    expect(planPrompt({ ...base, responseReserve: 1000 }).mode).not.toBe('too-large')
  })
})
