import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  budgetMeter, compactTokens, groupSkills, isVendored, normalizeSkillsResponse, shortCommit, skillDetailLine, skillIdsDiff, skillPath, skillSourceId, toggleSkillId, visibleSkills,
} from '../src/lib/skills-catalog.ts'

const sk = (id, extra = {}) => ({ id, name: id.split('/').pop(), description: `${id} desc`, tag: 'Core', content: '', tools: [], ...extra })
const be6 = [
  sk('superpowers/systematic-debugging', { sourceId: 'superpowers', hasScripts: true, license: 'MIT', sourceCommit: 'bb92a77741419a4ab5f06e711a283343f1ada0c3' }),
  sk('superpowers/brainstorming', { sourceId: 'superpowers' }),
  sk('superpowers/writing-plans', { sourceId: 'superpowers' }),
  sk('superpowers/tdd', { sourceId: 'superpowers' }),
  sk('core/summarization', { sourceId: 'core' }),
  sk('ecc/search-first', { sourceId: 'ecc' }),
  sk('anthropics/doc-coauthoring', { sourceId: 'anthropics' }),
]
const sources = [
  { id: 'superpowers', repo: 'obra/superpowers', commit: 'bb92a77741419a4ab5f06e711a283343f1ada0c3', license: 'MIT', count: 15 },
  { id: 'anthropics', repo: 'anthropics/skills', commit: 'dbd4588f9e1033efb41dad4bef2f7947c8993d44', license: 'Apache-2.0 (per skill)', count: 15 },
]

describe('GET /api/skills shapes', () => {
  it("today's Skill[] is legacy; BE-6 is { skills, sources }", () => {
    assert.deepEqual(normalizeSkillsResponse([sk('a')]), { skills: [sk('a')], sources: [], legacy: true })
    assert.equal(normalizeSkillsResponse({ skills: be6, sources }).legacy, false)
    assert.deepEqual(normalizeSkillsResponse(null), { skills: [], sources: [], legacy: false })
  })
  it('pre BE-6: grouped by provenance; "AgentControl" seeds are core', () => {
    assert.equal(skillSourceId({ source: 'seb1n/awesome-ai-agent-skills' }), 'seb1n/awesome-ai-agent-skills')
    assert.equal(skillSourceId({ source: 'AgentControl' }), 'core')
    assert.equal(skillSourceId({}), 'core')
    const g = groupSkills([sk('a', { source: 'AgentControl' }), sk('b', { source: 'seb1n/x' })], [], [])
    assert.deepEqual(g.map((x) => [x.id, x.title]), [['core', 'AgentControl core'], ['seb1n/x', 'seb1n/x']])
    assert.equal(skillSourceId({ sourceId: 'ecc' }), 'ecc')
  })
})

describe('grouping (03c)', () => {
  it('groups in 03c order with licence, short commit and on-counts', () => {
    const g = groupSkills(be6, sources, ['superpowers/brainstorming', 'core/summarization', 'gone/skill'])
    assert.deepEqual(g.map((x) => x.title), ['obra/superpowers', 'anthropics/skills', 'affaan-m/ECC', 'AgentControl core'])
    assert.equal(g[0].meta, 'MIT · pinned @ bb92a77')
    assert.equal(g[0].total, 15, 'source count wins over the loaded page')
    assert.equal(g[0].enabled, 1)
    assert.equal(g[0].skills[0].id, 'superpowers/brainstorming', 'enabled first')
    assert.equal(g[3].meta, 'Built in')
    assert.equal(g[2].meta, '', 'no licence/commit known')
  })

  it('keeps the order it opened with when a skill is toggled (no row jumps)', () => {
    const opened = ['superpowers/brainstorming']
    const before = groupSkills(be6, sources, opened, '', opened)[0].skills.map((s) => s.id)
    const later = groupSkills(be6, sources, [...opened, before.at(-1)], '', opened)
    assert.deepEqual(later[0].skills.map((s) => s.id), before)
    assert.equal(later[0].enabled, 2, 'counts still follow the live ids')
    assert.notEqual(groupSkills(be6, sources, [before.at(-1)])[0].skills[0].id, before[0], 'default orders by the live ids')
  })
  it('search filters rows and drops empty groups', () => {
    const g = groupSkills(be6, sources, [], 'DEBUG')
    assert.deepEqual(g.map((x) => [x.id, x.skills.map((s) => s.name)]), [['superpowers', ['systematic-debugging']]])
  })
  it('"＋ N more" preview of 3, unless expanded or searching', () => {
    const [g] = groupSkills(be6, sources, [])
    assert.deepEqual(visibleSkills(g, false).more, 1)
    assert.equal(visibleSkills(g, false).rows.length, 3)
    assert.equal(visibleSkills(g, true).more, 0)
    assert.equal(visibleSkills(g, false, 'x').rows.length, 4)
  })
  it('shortCommit', () => {
    assert.equal(shortCommit('35f57c80e6b7573755fd63136338ca0dc7a0bdb7'), '35f57c8')
    assert.equal(shortCommit(undefined), '')
  })
})

describe('skill toggle diffing', () => {
  it('turning on appends once; off removes; order and unknown ids are kept', () => {
    assert.deepEqual(toggleSkillId(['b', 'gone', 'a'], 'c', true), ['b', 'gone', 'a', 'c'])
    assert.deepEqual(toggleSkillId(['b', 'a'], 'a', true), ['b', 'a'])
    assert.deepEqual(toggleSkillId(['b', 'gone', 'a'], 'b', false), ['gone', 'a'])
  })
  it('skillIdsDiff', () => {
    assert.deepEqual(skillIdsDiff(['a', 'b'], ['b', 'c']), { added: ['c'], removed: ['a'], changed: true })
    assert.deepEqual(skillIdsDiff(['a'], ['a']), { added: [], removed: [], changed: false })
  })
})

describe('token meter', () => {
  const base = { contextWindow: 32768, responseReserve: 16384, estimatedTokens: 9000, summarizedSkillIds: [], toolNames: [] }
  it('BE-7 catalog: "Catalog 3.6k of 16k tokens" against the usable window', () => {
    const m = budgetMeter({ ...base, mode: 'catalog', catalogTokens: 3600 })
    assert.equal(m.label, 'Catalog 3.6k of 16k tokens')
    assert.equal(m.tone, 'ok')
    assert.ok(Math.abs(m.fraction - 3600 / 16384) < 1e-9)
  })
  it('catalog warns near the 25% cap; too-large is bad', () => {
    assert.equal(budgetMeter({ ...base, mode: 'catalog', catalogTokens: 7000 }).tone, 'warn')
    assert.equal(budgetMeter({ ...base, mode: 'too-large', catalogTokens: 9000 }).tone, 'bad')
  })
  it("pre BE-7: today's whole-prompt estimate", () => {
    assert.equal(budgetMeter({ ...base, mode: 'full' }).label, 'Prompt ≈9k of 16k tokens')
    assert.equal(budgetMeter({ ...base, mode: 'summary' }).tone, 'warn')
    assert.equal(budgetMeter({ ...base, estimatedTokens: 99999, mode: 'too-large' }).fraction, 1)
  })
  it('compactTokens', () => {
    assert.equal(compactTokens(950), '950')
    assert.equal(compactTokens(3612), '3.6k')
    assert.equal(compactTokens(16384), '16k')
  })
})

describe('BE-6 list rows (no content) vs legacy rows', () => {
  const be6Body = {
    skills: [
      { id: 'core/summarization', name: 'summarization', description: 'Summarize', tag: 'Core', tools: [], sourceId: 'core', defaultOn: true, hasScripts: false, files: [] },
      { id: 'superpowers/systematic-debugging', name: 'systematic-debugging', description: 'Debug', tag: 'Core', tools: [], sourceId: 'superpowers', sourceRepo: 'obra/superpowers', sourceCommit: 'bb92a77741419a4ab5f06e711a283343f1ada0c3', license: 'MIT', defaultOn: true, hasScripts: true, files: ['SKILL.md', 'scripts/find-polluter.sh'] },
      { id: 'custom/mine', name: 'mine', description: 'Mine', tag: 'Core', tools: [], sourceId: 'custom', defaultOn: false, hasScripts: false, files: ['SKILL.md'] },
    ],
    sources: [{ id: 'superpowers', repo: 'obra/superpowers', commit: 'bb92a77741419a4ab5f06e711a283343f1ada0c3', license: 'MIT', count: 15 }],
  }
  const legacyBody = [{ id: 'summarization', name: 'summarization', description: 'Summarize', tag: 'Core', content: '# Body', tools: [], source: 'AgentControl' }]
  it('both shapes normalize; only legacy rows carry content', () => {
    const a = normalizeSkillsResponse(be6Body)
    const b = normalizeSkillsResponse(legacyBody)
    assert.equal(a.legacy, false)
    assert.equal(a.skills.every((s) => s.content === undefined), true)
    assert.equal(b.legacy, true)
    assert.equal(b.skills[0].content, '# Body')
  })
  it('both shapes group: vendored groups are read-only, core and custom are not', () => {
    const g = groupSkills(normalizeSkillsResponse(be6Body).skills, be6Body.sources, [])
    assert.deepEqual(g.map((x) => [x.id, x.readOnly]), [['superpowers', true], ['core', false], ['custom', false]])
    const l = groupSkills(normalizeSkillsResponse(legacyBody).skills, [], [])
    assert.deepEqual(l.map((x) => [x.id, x.title, x.readOnly]), [['core', 'AgentControl core', false]])
  })
  it('skill ids with "/" are one encoded path segment', () => {
    assert.equal(skillPath('core/summarization'), '/api/skills/core%2Fsummarization')
    assert.equal(skillPath('summarization'), '/api/skills/summarization')
  })
  it('isVendored + detail line', () => {
    const [core, sp, mine] = be6Body.skills
    assert.equal(isVendored(sp), true)
    assert.equal(isVendored(core), false)
    assert.equal(isVendored({ source: 'seb1n/x' }), false)
    assert.equal(skillDetailLine(sp), 'Read-only · vendored from obra/superpowers @ bb92a77 · MIT · 2 files · on by default for new bots')
    assert.equal(skillDetailLine(core), 'Built in · on by default for new bots')
    assert.equal(skillDetailLine(mine), 'Imported · 1 file')
  })
})

describe('skillWriteError', async () => {
  const { skillWriteError } = await import('../src/lib/skills-catalog.ts')
  const e = (status, message) => Object.assign(new Error(message), { status })
  it('explains a vendored 403 when the server text is generic', () => {
    assert.match(skillWriteError(e(403, 'Forbidden'), 'x'), /^Vendored skills are read-only/)
    assert.match(skillWriteError(e(403, ''), 'x'), /^Vendored skills are read-only/)
  })
  it('keeps a specific server reason, and other errors', () => {
    assert.equal(skillWriteError(e(403, 'superpowers/brainstorming is vendored and read-only'), 'x'), 'superpowers/brainstorming is vendored and read-only')
    assert.equal(skillWriteError(e(400, 'SKILL.md needs a name'), 'x'), 'SKILL.md needs a name')
    assert.equal(skillWriteError(null, 'fallback'), 'fallback')
  })
})
