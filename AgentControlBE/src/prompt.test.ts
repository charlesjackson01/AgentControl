import { describe, expect, it } from 'vitest'
import { seedSkills } from './db/seed.js'
import {
  attachedSkills,
  estimateTokens,
  planPrompt,
  RESPONSE_RESERVE,
  SKILL_HEADROOM,
  summaryBlock,
} from './prompt.js'
import type { Skill } from './shared/types.js'
import { toolDeclaration } from './tools.js'
import type { ToolDeclaration } from './upstream.js'

/** Reply reserve + headroom: what a plan must leave free in the window. */
const OVERHEAD = RESPONSE_RESERVE + SKILL_HEADROOM
const HUGE_WINDOW = 1_000_000

/** The run route's construction before planPrompt existed, verbatim. */
function legacy(instructions: string, injectedSkills: Skill[]): { system: string; toolDeclarations: ToolDeclaration[] } {
  const skillBlocks = injectedSkills.map((s) => `## ${s.name}\n${s.content}`)
  const system = [
    instructions,
    skillBlocks.length > 0 ? `Skills:\n\n${skillBlocks.join('\n\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
  const toolDeclarations: ToolDeclaration[] = []
  {
    const seen = new Set<string>()
    for (const s of injectedSkills) {
      for (const t of s.tools ?? []) {
        if (seen.has(t.name)) continue
        seen.add(t.name)
        const decl = toolDeclaration(t.name)
        if (decl) toolDeclarations.push(decl)
      }
    }
  }
  return { system, toolDeclarations }
}

function skill(id: string, contentChars: number, extra: Partial<Skill> = {}): Skill {
  return {
    id,
    name: id,
    description: `What ${id} does.`,
    tag: '',
    content: `${id}:`.padEnd(contentChars, 'x'),
    tools: [],
    ...extra,
  }
}

/** A stored tool declaration (display-only copy; the registry's is sent). */
const stored = (...names: string[]) => names.map((name) => ({ name, description: 'stored copy', parameters: {} }))
const decl = (name: string): ToolDeclaration => toolDeclaration(name) as ToolDeclaration
const schemaChars = (tools: ToolDeclaration[]): number => (tools.length > 0 ? JSON.stringify(tools).length : 0)
const estimateOf = (system: string, input: string, tools: ToolDeclaration[]): number =>
  Math.ceil((system.length + input.length + schemaChars(tools)) / 4)
/** instructions + "Skills:" + blocks, the shape every plan uses. */
const systemOf = (instructions: string, blocks: string[]): string =>
  [instructions, `Skills:\n\n${blocks.join('\n\n')}`].filter(Boolean).join('\n\n')
const full = (s: Skill): string => `## ${s.name}\n${s.content}`
const seed = (id: string): Skill => seedSkills.find((s) => s.id === id) as Skill

describe('planPrompt full mode', () => {
  const toolA = skill('tool-a', 900, { tools: stored('list_agents', 'calculate') })
  const toolB = skill('tool-b', 700, { tools: stored('calculate', 'read_note', 'not_a_registry_tool') })
  const declaresGetSkill = skill('reader', 400, { tools: stored('get_skill', 'list_skills') })
  const leadSkills = ['deep-research', 'summarization', 'multi-agent-orchestration'].map(seed)

  const cases: [string, string, Skill[]][] = [
    ['no skills', 'Only instructions.', []],
    ['no skills, no instructions', '', []],
    ['one seed skill', 'Be brief.', [seed('summarization')]],
    ['the Team Lead starter skills', 'You are the Team Lead.', leadSkills],
    ['every seed skill', 'All of them.', seedSkills],
    ['overlapping and unknown tool names', 'Tools.', [toolA, toolB]],
    ['a skill that declares get_skill', 'Reader.', [toolA, declaresGetSkill]],
    ['skills without instructions', '', [toolA, toolB]],
    ['a repeated attachment', 'Twice.', [toolA, toolB, toolA]],
  ]

  it.each(cases)('is byte-identical to the old construction: %s', (_label, instructions, skills) => {
    const input = 'hi'
    const old = legacy(instructions, skills)
    const plan = planPrompt({ instructions, skills, input, contextWindow: HUGE_WINDOW })
    expect(plan.mode).toBe('full')
    expect(plan.system).toBe(old.system)
    expect(plan.toolDeclarations).toEqual(old.toolDeclarations)
    expect(plan.toolDeclarations.map((t) => t.name)).toEqual(old.toolDeclarations.map((t) => t.name))
    expect(plan.summarizedSkillIds).toEqual([])
    expect(plan.estimatedTokens).toBe(estimateOf(old.system, input, old.toolDeclarations))
    // get_skill is only ever offered in full mode when a skill declares it.
    const declared = skills.some((s) => s.tools.some((t) => t.name === 'get_skill'))
    expect(plan.toolDeclarations.some((t) => t.name === 'get_skill')).toBe(declared)
  })

  it('stays full exactly up to the hard limit (no headroom needed), then summarizes', () => {
    const skills = [skill('one', 3000), skill('two', 2000)]
    const old = legacy('Lead.', skills)
    const needed = estimateOf(old.system, 'q', old.toolDeclarations) + RESPONSE_RESERVE
    const atBoundary = planPrompt({ instructions: 'Lead.', skills, input: 'q', contextWindow: needed })
    expect(atBoundary.mode).toBe('full')
    expect(atBoundary.system).toBe(old.system)
    expect(atBoundary.estimatedTokens + RESPONSE_RESERVE).toBe(needed)

    // One token short: summarize largest first until the headroom is there too.
    const below = planPrompt({ instructions: 'Lead.', skills, input: 'q', contextWindow: needed - 1 })
    expect(below.mode).toBe('summary')
    expect(below.summarizedSkillIds).toEqual(['one', 'two'])
    expect(below.estimatedTokens + OVERHEAD).toBeLessThanOrEqual(needed - 1)
  })

  it('counts the input toward the estimate', () => {
    const skills = [skill('one', 3000)]
    const old = legacy('', skills)
    const window = estimateOf(old.system, '', []) + RESPONSE_RESERVE
    expect(planPrompt({ instructions: '', skills, input: '', contextWindow: window }).mode).toBe('full')
    expect(planPrompt({ instructions: '', skills, input: 'x'.repeat(40), contextWindow: window }).mode).toBe('summary')
  })
})

describe('summary blocks', () => {
  it('names the skill, quotes its description and says how to read the rest', () => {
    const block = summaryBlock(skill('deep-research', 10, { description: 'Research a topic across sources.' }))
    expect(block).toBe(
      '## deep-research (summary)\nResearch a topic across sources.\n' +
        'The full procedure is not in this prompt. Read it with get_skill {"skill":"deep-research"} before relying on it.',
    )
  })

  it('uses the display name in the heading and the id in the get_skill call', () => {
    const block = summaryBlock(skill('skl_1234abcd', 10, { name: 'Release checklist', description: 'Ship safely.' }))
    expect(block.startsWith('## Release checklist (summary)\nShip safely.\n')).toBe(true)
    expect(block).toContain('get_skill {"skill":"skl_1234abcd"}')
  })

  it('skips an empty description and clips a long one', () => {
    expect(summaryBlock(skill('bare', 10, { description: '  ' }))).toBe(
      '## bare (summary)\nThe full procedure is not in this prompt. Read it with get_skill {"skill":"bare"} before relying on it.',
    )
    const long = summaryBlock(skill('long', 10, { description: 'd'.repeat(5000) }))
    const description = long.split('\n')[1] as string
    expect(description).toHaveLength(300)
    expect(description.endsWith('…')).toBe(true)
  })
})

describe('planPrompt summary mode', () => {
  // Attached as c, a, b; sizes put b first, then c, then a.
  const c = skill('c', 4500)
  const a = skill('a', 3000)
  const b = skill('b', 6000)
  const skills = [c, a, b]
  const getSkill = decl('get_skill')

  it('summarizes the largest skill first and keeps blocks in attachment order', () => {
    const system = systemOf('Lead.', [full(c), full(a), summaryBlock(b)])
    const window = estimateOf(system, '', [getSkill]) + OVERHEAD
    // Premise: the full prompt does not fit this window.
    const old = legacy('Lead.', skills)
    expect(estimateOf(old.system, '', []) + OVERHEAD).toBeGreaterThan(window)

    const plan = planPrompt({ instructions: 'Lead.', skills, input: '', contextWindow: window })
    expect(plan.mode).toBe('summary')
    expect(plan.summarizedSkillIds).toEqual(['b'])
    expect(plan.system).toBe(system)
    expect(plan.toolDeclarations).toEqual([getSkill])
    expect(plan.estimatedTokens).toBe(estimateOf(system, '', [getSkill]))
    expect(plan.estimatedTokens + OVERHEAD).toBeLessThanOrEqual(window)
  })

  it('summarizes the next largest only when the first is not enough, reporting attachment order', () => {
    const oneSummarized = systemOf('Lead.', [full(c), full(a), summaryBlock(b)])
    const window = estimateOf(oneSummarized, '', [getSkill]) + OVERHEAD - 1
    const plan = planPrompt({ instructions: 'Lead.', skills, input: '', contextWindow: window })
    expect(plan.mode).toBe('summary')
    // c (4500) goes before a (3000); ids are listed in attachment order.
    expect(plan.summarizedSkillIds).toEqual(['c', 'b'])
    expect(plan.system).toBe(systemOf('Lead.', [summaryBlock(c), full(a), summaryBlock(b)]))
  })

  it('appends get_skill once, after the tools the skills declare, which stay offered', () => {
    const big = skill('big', 8000, { tools: stored('calculate', 'list_agents') })
    const small = skill('small', 200, { tools: stored('list_agents', 'read_note') })
    const plan = planPrompt({ instructions: '', skills: [big, small], input: '', contextWindow: 6000 })
    expect(plan.mode).toBe('summary')
    expect(plan.summarizedSkillIds).toEqual(['big'])
    expect(plan.toolDeclarations).toEqual([decl('calculate'), decl('list_agents'), decl('read_note'), getSkill])
    // The get_skill schema counts toward the estimate.
    expect(plan.estimatedTokens).toBe(estimateOf(plan.system, '', plan.toolDeclarations))
  })

  it('does not add a second get_skill when a skill already declares it', () => {
    const big = skill('big', 8000, { tools: stored('get_skill', 'calculate') })
    const plan = planPrompt({ instructions: '', skills: [big], input: '', contextWindow: 6000 })
    expect(plan.mode).toBe('summary')
    expect(plan.toolDeclarations.map((t) => t.name)).toEqual(['get_skill', 'calculate'])
  })

  it('summarizes a repeated attachment everywhere and lists it once', () => {
    const big = skill('big', 6000)
    const small = skill('small', 100)
    const plan = planPrompt({ instructions: '', skills: [big, small, big], input: '', contextWindow: 6000 })
    expect(plan.mode).toBe('summary')
    expect(plan.summarizedSkillIds).toEqual(['big'])
    expect(plan.system).toBe(systemOf('', [summaryBlock(big), full(small), summaryBlock(big)]))
  })

  it('fits the fresh-install Team Lead on the seeded 8192-token endpoint', () => {
    const leadSkills = ['deep-research', 'summarization', 'multi-agent-orchestration'].map(seed)
    const instructions =
      'You are the Team Lead. Coordinate the other agents, review their work, and keep projects moving.'
    // Premise: the full prompt alone overflows 8192 with the reply reserve (the old 413).
    const old = legacy(instructions, leadSkills)
    expect(estimateOf(old.system, 'hi', old.toolDeclarations) + RESPONSE_RESERVE).toBeGreaterThan(8192)

    const plan = planPrompt({ instructions, skills: leadSkills, input: 'hi', contextWindow: 8192 })
    expect(plan.mode).toBe('summary')
    expect(plan.estimatedTokens + OVERHEAD).toBeLessThanOrEqual(8192)
    const largest = [...leadSkills].sort((x, y) => y.content.length - x.content.length)[0] as Skill
    expect(plan.summarizedSkillIds).toContain(largest.id)
    expect(plan.toolDeclarations.filter((t) => t.name === 'get_skill')).toHaveLength(1)
    for (const s of leadSkills) {
      if (plan.summarizedSkillIds.includes(s.id)) {
        expect(plan.system).toContain(summaryBlock(s))
        expect(plan.system).not.toContain(s.content)
      } else {
        expect(plan.system).toContain(full(s))
      }
    }
  })
})

describe('planPrompt too-large', () => {
  it('returns the all-summarized plan when even that does not fit', () => {
    const a = skill('a', 6000, { tools: stored('calculate') })
    const b = skill('b', 5000)
    const plan = planPrompt({ instructions: 'Lead.', skills: [a, b], input: 'hi', contextWindow: 4150 })
    expect(plan.mode).toBe('too-large')
    expect(plan.summarizedSkillIds).toEqual(['a', 'b'])
    expect(plan.system).toBe(systemOf('Lead.', [summaryBlock(a), summaryBlock(b)]))
    expect(plan.toolDeclarations.map((t) => t.name)).toEqual(['calculate', 'get_skill'])
    expect(plan.estimatedTokens).toBe(estimateOf(plan.system, 'hi', plan.toolDeclarations))
    expect(plan.estimatedTokens + RESPONSE_RESERVE).toBeGreaterThan(4150)
  })

  it('keeps a skill full when its summary would not be shorter', () => {
    const tiny = skill('tiny', 9, { content: 'Be terse.' })
    const instructions = 'i'.repeat(40_000)
    const plan = planPrompt({ instructions, skills: [tiny], input: '', contextWindow: 8192 })
    const old = legacy(instructions, [tiny])
    expect(plan.mode).toBe('too-large')
    expect(plan.summarizedSkillIds).toEqual([])
    expect(plan.system).toBe(old.system)
    // Nothing was summarized, so get_skill is not offered.
    expect(plan.toolDeclarations).toEqual([])
  })

  it('reports too-large with no skills when the instructions alone overflow', () => {
    const instructions = 'i'.repeat(20_000)
    const plan = planPrompt({ instructions, skills: [], input: '', contextWindow: 8192 })
    expect(plan).toEqual({
      system: instructions,
      toolDeclarations: [],
      summarizedSkillIds: [],
      mode: 'too-large',
      estimatedTokens: estimateTokens(20_000),
    })
  })
})

describe('planPrompt determinism', () => {
  const p = skill('p', 5000)
  const q = skill('q', 5000)
  const r = skill('r', 100)
  const window = estimateOf(systemOf('', [summaryBlock(p), full(q), full(r)]), '', [decl('get_skill')]) + OVERHEAD

  it('breaks size ties by attachment order', () => {
    expect(planPrompt({ instructions: '', skills: [p, q, r], input: '', contextWindow: window }).summarizedSkillIds).toEqual(['p'])
    expect(planPrompt({ instructions: '', skills: [q, p, r], input: '', contextWindow: window }).summarizedSkillIds).toEqual(['q'])
  })

  it('returns the same plan for the same input', () => {
    const args = { instructions: 'Same.', skills: [p, q, r], input: 'x', contextWindow: window }
    expect(planPrompt(args)).toEqual(planPrompt(args))
  })

  it('plans hundreds of large skills quickly', () => {
    const many = Array.from({ length: 500 }, (_, i) => skill(`s${i}`, 20_000))
    const started = Date.now()
    const plan = planPrompt({ instructions: 'Many.', skills: many, input: '', contextWindow: 8192 })
    expect(Date.now() - started).toBeLessThan(1000)
    expect(plan.mode).toBe('too-large')
    expect(plan.summarizedSkillIds).toHaveLength(500)
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
    const { replyReserve, RESPONSE_RESERVE, planPrompt } = await import('./prompt.js')
    expect(replyReserve({})).toBe(RESPONSE_RESERVE)
    expect(replyReserve({ maxOutputTokens: 512 })).toBe(512)
    const base = { instructions: 'x'.repeat(4 * 3000), skills: [], input: '', contextWindow: 8192 }
    expect(planPrompt({ ...base, responseReserve: 6000 }).mode).toBe('too-large')
    expect(planPrompt({ ...base, responseReserve: 1000 }).mode).not.toBe('too-large')
  })
})
