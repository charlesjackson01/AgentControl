import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { LEAD_SKILL_IDS, createSkillIds, defaultSkillIds, newBotSkillIds, starterSkillIds } from '../src/lib/starter-skills.ts'

const ids = (...xs) => xs.map((id) => ({ id }))

describe('Team Lead starter skills', () => {
  it('uses BE-6 core/<name> ids', () => {
    assert.deepEqual([...LEAD_SKILL_IDS], ['core/deep-research', 'core/summarization', 'core/multi-agent-orchestration'])
  })
  it('pre-checks all three on a BE-6 server', () => {
    const be6 = ids('core/code-review', 'core/deep-research', 'core/multi-agent-orchestration', 'core/summarization', 'superpowers/brainstorming')
    assert.deepEqual(starterSkillIds(LEAD_SKILL_IDS, be6), [...LEAD_SKILL_IDS])
  })
  it('falls back to bare ids on a pre-BE-6 server, and skips missing ones', () => {
    assert.deepEqual(starterSkillIds(LEAD_SKILL_IDS, ids('summarization', 'deep-research')), ['deep-research', 'summarization'])
    assert.deepEqual(starterSkillIds(LEAD_SKILL_IDS, ids('superpowers/brainstorming')), [])
  })
})

// Guard: no source file hardcodes a bare core skill id in a string literal.
const CORE = ['calculation-checker', 'code-review', 'csv-analysis', 'date-arithmetic', 'debugging', 'deep-research', 'encoding-and-hashing', 'json-inspection', 'meeting-notes', 'multi-agent-orchestration', 'notes-organizer', 'release-notes', 'summarization', 'technical-writing', 'text-cleanup', 'text-comparison', 'unit-conversion', 'workspace-audit']
const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : /\.tsx?$/.test(f) ? [join(d, f)] : []))
describe('no bare core skill ids in src', () => {
  it('every core id literal is core/<name>', () => {
    const hits = []
    for (const f of walk(new URL('../src', import.meta.url).pathname)) {
      const text = readFileSync(f, 'utf8')
      for (const n of CORE) if (new RegExp(`['"\`]${n}['"\`]`).test(text)) hits.push(`${f}: ${n}`)
    }
    assert.deepEqual(hits, [])
  })
})

describe('new-bot skills (BE-7 defaults)', () => {
  const lib = [
    { id: 'core/deep-research', defaultOn: true },
    { id: 'core/summarization', defaultOn: true },
    { id: 'core/multi-agent-orchestration', defaultOn: false },
    { id: 'core/code-review' },
    { id: 'superpowers/brainstorming', defaultOn: true },
  ]
  it('defaults are the defaultOn skills in library order', () => {
    assert.deepEqual(defaultSkillIds(lib), ['core/deep-research', 'core/summarization', 'superpowers/brainstorming'])
    assert.deepEqual(defaultSkillIds([{ id: 'legacy' }]), [], 'pre-BE-6 skills have no defaultOn')
  })
  it('Team Lead: defaults, then the missing starters', () => {
    assert.deepEqual(newBotSkillIds(lib, true), ['core/deep-research', 'core/summarization', 'superpowers/brainstorming', 'core/multi-agent-orchestration'])
    assert.deepEqual(newBotSkillIds(lib, false), ['core/deep-research', 'core/summarization', 'superpowers/brainstorming'])
  })
  it('untouched normal bot leaves skillIds out (backend defaults)', () => {
    assert.deepEqual(createSkillIds({ selected: newBotSkillIds(lib, false), touched: false, lead: false }), {})
    assert.deepEqual(createSkillIds({ selected: [], touched: false, lead: false }), {})
  })
  it('untouched Team Lead sends defaults + starters in the create', () => {
    const selected = newBotSkillIds(lib, true)
    assert.deepEqual(createSkillIds({ selected, touched: false, lead: true }), { skillIds: selected })
    assert.deepEqual(createSkillIds({ selected: [], touched: false, lead: true }), {}, 'never [] when skills did not load')
  })
  it('a changed selection is sent as is; [] only when the user turned everything off', () => {
    assert.deepEqual(createSkillIds({ selected: ['core/code-review'], touched: true, lead: false }), { skillIds: ['core/code-review'] })
    assert.deepEqual(createSkillIds({ selected: [], touched: true, lead: false }), { skillIds: [] })
    assert.deepEqual(createSkillIds({ selected: [], touched: true, lead: true }), { skillIds: [] })
  })
})
