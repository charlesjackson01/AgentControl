import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { LEAD_SKILL_IDS, starterSkillIds } from '../src/lib/starter-skills.ts'

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
