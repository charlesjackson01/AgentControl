import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Skill } from '../shared/types.js'
import { createStore } from '../store.js'
import { toolDeclaration } from '../tools.js'
import { seedSkills, vendoredSeedSkills } from './seed.js'
import { parseSkillMarkdown } from './skill-md.js'

const V1 = 'seed-skill-tools-v1'
const V2 = 'seed-skill-upgrade-v2'
const V3 = 'seed-skill-upgrade-v3'

/** The skills whose definition changed in seed-skill-upgrade-v2 (fixtures/v1 holds the version before). */
const UPGRADED = ['core/workspace-audit', 'core/date-arithmetic', 'core/text-cleanup', 'core/multi-agent-orchestration']
/** The skills whose definition changed in seed-skill-upgrade-v3 (fixtures/v2 holds the version before). */
const UPGRADED_V3 = [
  'core/code-review', 'core/debugging', 'core/deep-research', 'core/multi-agent-orchestration', 'core/summarization', 'core/technical-writing',
  'core/calculation-checker', 'core/unit-conversion', 'core/text-comparison', 'core/json-inspection', 'core/csv-analysis', 'core/workspace-audit',
]
/** Seeds first shipped with v3; older stores never offered them. */
const NEW_IN_V3 = ['core/encoding-and-hashing', 'core/release-notes']
/** Every seed id a v1 or v2 install offered, in seed order. */
const OLD_IDS = seedSkills.map((s) => s.id).filter((id) => !NEW_IN_V3.includes(id))

const seedOf = (id: string): Skill => seedSkills.find((s) => s.id === id)!

/** A seed skill exactly as a fixture file shipped it (tool names resolved against the registry). */
function fixtureSkill(version: 'v1' | 'v2', id: string): Skill {
  const parsed = parseSkillMarkdown(readFileSync(new URL(`./seed-upgrade-fixtures/${version}/${id.replace(/^core\//, '')}.md`, import.meta.url), 'utf8'))
  return {
    ...structuredClone(seedOf(id)),
    description: parsed.description,
    content: parsed.content,
    tools: parsed.tools.map((name) => toolDeclaration(name)!),
  }
}

/** A seed skill exactly as v1 (master before v2) shipped it. */
function v1Skill(id: string): Skill {
  // v1 shipped the vendored body without the tools line that v2 added.
  if (id === 'core/multi-agent-orchestration') return { ...fixtureSkill('v2', id), tools: [] }
  if (UPGRADED.includes(id)) return fixtureSkill('v1', id)
  // Every other seed v3 changed was the same in v1 and v2.
  if (UPGRADED_V3.includes(id)) return fixtureSkill('v2', id)
  return structuredClone(seedOf(id))
}

/** A seed skill exactly as v2 (master before v3) shipped it. */
function v2Skill(id: string): Skill {
  return UPGRADED_V3.includes(id) ? fixtureSkill('v2', id) : structuredClone(seedOf(id))
}

let dir: string
beforeEach(() => {
  vi.stubEnv('AGENTCONTROL_SECRET', 'seed-upgrade-test-secret')
  dir = mkdtempSync(join(tmpdir(), 'agentcontrol-seed-upgrade-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

/** Write a store as an older install left it: its seeds offered and its migrations applied. */
function writeStore(path: string, skills: Skill[], migrations: string[], seededSkillIds = OLD_IDS): void {
  writeFileSync(path, JSON.stringify({ skills, meta: { migrations, seededSkillIds } }))
}

/** A store as a v1 install wrote it: the sixteen v1 seeds offered, v1 migration applied. */
function writeV1Store(path: string, override: (skills: Skill[]) => Skill[] = (s) => s): void {
  writeStore(path, override(OLD_IDS.map(v1Skill)), [V1])
}

/** A store as a v2 install wrote it: the sixteen v2 seeds offered, v1 and v2 applied. */
function writeV2Store(path: string, override: (skills: Skill[]) => Skill[] = (s) => s): void {
  writeStore(path, override(OLD_IDS.map(v2Skill)), [V1, V2])
}

const storedSkills = (path: string): Skill[] => (JSON.parse(readFileSync(path, 'utf8')) as { skills: Skill[] }).skills

describe('seed upgrade fixtures', () => {
  it('the v1 fixtures differ from the current seeds (otherwise this migration is a no-op)', () => {
    for (const id of UPGRADED) {
      const current = seedOf(id)
      expect(v1Skill(id).tools.map((t) => t.name), id).not.toEqual(current.tools.map((t) => t.name))
    }
  })

  it('the v2 fixtures differ from the current seeds in body or tools', () => {
    for (const id of UPGRADED_V3) {
      const old = fixtureSkill('v2', id)
      const current = seedOf(id)
      const same = old.content === current.content && JSON.stringify(old.tools) === JSON.stringify(current.tools)
      expect(same, id).toBe(false)
    }
  })

  it('the vendored v2 fixtures carry the same pinned bodies: only their tools changed', () => {
    for (const seed of vendoredSeedSkills) {
      const old = fixtureSkill('v2', seed.id)
      expect(old.content, seed.id).toBe(seed.content)
      expect(old.description, seed.id).toBe(seed.description)
      expect(old.tools.map((t) => t.name), seed.id).toEqual(seed.id === 'core/multi-agent-orchestration'
        ? ['list_agents', 'get_agent', 'workspace_overview', 'read_run_log']
        : [])
      expect(seed.tools.length, seed.id).toBeGreaterThan(0)
    }
  })

  it('pins the seeds v3 leaves unchanged: editing one needs a new upgrade batch', () => {
    // sha256 of [description, content, tool names] as v2 shipped them.
    const pinned: Record<string, string> = {
      'core/date-arithmetic': 'e503ed0ca8f5c7be2fc12fd030933a350c617bfbc7a3b405219fd0e17751c08c',
      'core/text-cleanup': 'e89b67879ea3df911421885f363d198e258089d843833bbe18f4b12d5c66ea82',
      'core/notes-organizer': 'eaa97f3955d0cc3d368975390ff9116474821e14e123e29d45a71ed90bf2ef2d',
      'core/meeting-notes': '0ec00f3142fb9a05e73c569d8641107d633793e6b73e32197e147dc65371470c',
    }
    expect(Object.keys(pinned)).toEqual(OLD_IDS.filter((id) => !UPGRADED_V3.includes(id)))
    for (const [id, sha] of Object.entries(pinned)) {
      const s = seedOf(id)
      const key = JSON.stringify([s.description, s.content, s.tools.map((t) => t.name)])
      expect(createHash('sha256').update(key).digest('hex'), id).toBe(sha)
    }
  })
})

describe('seed-skill-upgrade-v2', () => {
  it('upgrades untouched v1 copies to the current seed, once, and leaves other skills alone', () => {
    const path = join(dir, 'store.json')
    writeV1Store(path)
    const upgraded = createStore(path)
    // v2 and then v3 bring every v1 copy to the current seed; the new seeds are appended.
    expect(upgraded.skills).toEqual(seedSkills)
    expect(upgraded.meta.migrations.filter((m) => m.startsWith('seed-'))).toEqual([V1, V2, V3])
    expect(upgraded.meta.seededSkillIds).toEqual(seedSkills.map((s) => s.id))
    expect(createStore(path).skills).toEqual(upgraded.skills)
  })

  it('leaves copies the user edited (body or tools) exactly as they were', () => {
    const path = join(dir, 'store.json')
    writeV1Store(path, (skills) =>
      skills.map((s) => {
        if (s.id === 'core/workspace-audit') return { ...s, tools: [] }
        if (s.id === 'core/date-arithmetic') return { ...s, content: `${s.content}\n\nMy team uses ISO week numbers.` }
        if (s.id === 'core/multi-agent-orchestration') return { ...s, tools: [toolDeclaration('list_agents')!] }
        return s
      }),
    )
    const before = storedSkills(path)
    const loaded = createStore(path)
    for (const id of ['core/workspace-audit', 'core/date-arithmetic', 'core/multi-agent-orchestration']) {
      expect(loaded.skills.find((s) => s.id === id), id).toEqual(before.find((s) => s.id === id))
    }
    // The untouched one still upgrades.
    expect(loaded.skills.find((s) => s.id === 'core/text-cleanup')).toEqual(seedOf('core/text-cleanup'))
  })

  it('runs once: tools a user clears after the upgrade stay cleared', () => {
    const path = join(dir, 'store.json')
    writeV1Store(path)
    const upgraded = createStore(path)
    const audit = upgraded.skills.find((s) => s.id === 'core/workspace-audit')!
    audit.tools = []
    expect(upgraded.save()).toBe(true)
    expect(createStore(path).skills.find((s) => s.id === 'core/workspace-audit')?.tools).toEqual([])
  })

  it('does not resurrect an upgraded seed the user deleted', () => {
    const path = join(dir, 'store.json')
    writeV1Store(path, (skills) => skills.filter((s) => s.id !== 'core/text-cleanup'))
    expect(createStore(path).skills.some((s) => s.id === 'core/text-cleanup')).toBe(false)
  })

  it('fresh stores are born with the migration applied', () => {
    const fresh = createStore(join(dir, 'fresh.json'))
    expect(fresh.meta.migrations).toContain(V2)
    expect(fresh.skills.map((s) => s.id)).toEqual(seedSkills.map((s) => s.id))
    expect(vendoredSeedSkills.find((s) => s.id === 'core/multi-agent-orchestration')?.tools.length).toBeGreaterThan(0)
  })
})

describe('seed-skill-upgrade-v3', () => {
  it('upgrades every untouched v2 copy to the current seed and adds the new seeds, once', () => {
    const path = join(dir, 'store.json')
    writeV2Store(path)
    const upgraded = createStore(path)
    for (const id of UPGRADED_V3) expect(upgraded.skills.find((s) => s.id === id), id).toEqual(seedOf(id))
    // Unchanged seeds stay as they were; the two new seeds are appended in seed order.
    expect(upgraded.skills).toEqual(seedSkills)
    expect(upgraded.skills.slice(-2).map((s) => s.id)).toEqual(NEW_IN_V3)
    expect(upgraded.meta.migrations.filter((m) => m.startsWith('seed-'))).toEqual([V1, V2, V3])
    expect(upgraded.meta.seededSkillIds).toEqual(seedSkills.map((s) => s.id))
    // The upgrade was saved: a reload reads it back without migrating again.
    expect(storedSkills(path)).toEqual(seedSkills)
    expect(createStore(path).skills).toEqual(upgraded.skills)
  })

  it('leaves edited copies and copies with changed tools exactly as they were', () => {
    const path = join(dir, 'store.json')
    writeV2Store(path, (skills) =>
      skills.map((s) => {
        // Body edits, vendored and authored.
        if (s.id === 'core/summarization') return { ...s, content: `${s.content}\n\nAlways cite line numbers.` }
        if (s.id === 'core/json-inspection') return { ...s, content: s.content.replace('JSON Inspection', 'Payload checks') }
        // Tool changes: cleared, one removed, one added, reordered.
        if (s.id === 'core/multi-agent-orchestration') return { ...s, tools: [] }
        if (s.id === 'core/workspace-audit') return { ...s, tools: s.tools.filter((t) => t.name !== 'get_agent') }
        if (s.id === 'core/code-review') return { ...s, tools: [toolDeclaration('compare_text')!] }
        if (s.id === 'core/csv-analysis') return { ...s, tools: [...s.tools].reverse() }
        return s
      }),
    )
    const before = storedSkills(path)
    const edited = ['core/summarization', 'core/json-inspection', 'core/multi-agent-orchestration', 'core/workspace-audit', 'core/code-review', 'core/csv-analysis']
    const loaded = createStore(path)
    for (const id of edited) {
      expect(loaded.skills.find((s) => s.id === id), id).toEqual(before.find((s) => s.id === id))
    }
    // The untouched ones still upgrade.
    for (const id of UPGRADED_V3.filter((id) => !edited.includes(id))) {
      expect(loaded.skills.find((s) => s.id === id), id).toEqual(seedOf(id))
    }
    expect(loaded.meta.migrations.filter((m) => m.startsWith('seed-'))).toEqual([V1, V2, V3])
  })

  it('runs once: a vendored seed whose tools the user clears after the upgrade stays cleared', () => {
    const path = join(dir, 'store.json')
    writeV2Store(path)
    const upgraded = createStore(path)
    // A cleared vendored copy matches its v2 definition again (same body, no
    // tools); only the recorded migration keeps it from being re-upgraded.
    const review = upgraded.skills.find((s) => s.id === 'core/code-review')!
    expect(review.tools.length).toBeGreaterThan(0)
    review.tools = []
    expect(upgraded.save()).toBe(true)
    const reopened = createStore(path)
    expect(reopened.skills.find((s) => s.id === 'core/code-review')?.tools).toEqual([])
    expect(reopened.meta.migrations.filter((m) => m.startsWith('seed-'))).toEqual([V1, V2, V3])
  })

  it('does not resurrect a changed seed or a new seed the user deleted', () => {
    const path = join(dir, 'store.json')
    writeV2Store(path, (skills) => skills.filter((s) => s.id !== 'core/debugging' && s.id !== 'core/csv-analysis'))
    const upgraded = createStore(path)
    expect(upgraded.skills.some((s) => s.id === 'core/debugging' || s.id === 'core/csv-analysis')).toBe(false)
    expect(upgraded.skills.map((s) => s.id)).toEqual(seedSkills.map((s) => s.id).filter((id) => id !== 'core/debugging' && id !== 'core/csv-analysis'))

    // A new seed is offered once: deleted afterwards, it stays deleted.
    upgraded.skills = upgraded.skills.filter((s) => s.id !== 'core/release-notes')
    expect(upgraded.save()).toBe(true)
    const reopened = createStore(path)
    expect(reopened.skills.some((s) => s.id === 'core/release-notes')).toBe(false)
    expect(reopened.skills.find((s) => s.id === 'core/encoding-and-hashing')).toEqual(seedOf('core/encoding-and-hashing'))
    expect(reopened.meta.seededSkillIds).toEqual(seedSkills.map((s) => s.id))
  })

  it('appends the new seeds to an existing store without touching custom skills', () => {
    const path = join(dir, 'store.json')
    const custom: Skill = { id: 'skl_custom', name: 'Custom', description: 'Mine.', tag: 'Core', content: 'Do it my way.', tools: [], sourceId: 'custom', hasScripts: false, files: [], defaultOn: false }
    writeV2Store(path, (skills) => [custom, ...skills])
    const loaded = createStore(path)
    expect(loaded.skills[0]).toEqual(custom)
    expect(loaded.skills.slice(-2)).toEqual(NEW_IN_V3.map(seedOf))
    for (const id of NEW_IN_V3) expect(loaded.skills.filter((s) => s.id === id), id).toHaveLength(1)
  })

  it('brings a store from before any migration to the current seeds', () => {
    // The original six vendored seeds, without tools or meta.
    const path = join(dir, 'store.json')
    writeFileSync(path, JSON.stringify({ skills: vendoredSeedSkills.map((s) => ({ ...structuredClone(s), tools: [] })) }))
    const loaded = createStore(path)
    expect(loaded.skills).toEqual(seedSkills)
    expect(loaded.meta.migrations.filter((m) => m.startsWith('seed-'))).toEqual([V1, V2, V3])
  })

  it('fresh stores are born with v3 applied and never run it', () => {
    const path = join(dir, 'fresh.json')
    const fresh = createStore(path)
    expect(fresh.meta.migrations.filter((m) => m.startsWith('seed-'))).toEqual([V1, V2, V3])
    expect(fresh.skills).toEqual(seedSkills)
    // Revert two seeds to their v2 definitions: a fresh store must not re-upgrade them.
    fresh.skills = fresh.skills.map((s) => (s.id === 'core/summarization' || s.id === 'core/text-comparison' ? v2Skill(s.id) : s))
    expect(fresh.save()).toBe(true)
    const reopened = createStore(path)
    expect(reopened.skills.find((s) => s.id === 'core/summarization')).toEqual(v2Skill('core/summarization'))
    expect(reopened.skills.find((s) => s.id === 'core/text-comparison')).toEqual(v2Skill('core/text-comparison'))
    expect(reopened.meta.migrations.filter((m) => m.startsWith('seed-'))).toEqual([V1, V2, V3])
  })
})
