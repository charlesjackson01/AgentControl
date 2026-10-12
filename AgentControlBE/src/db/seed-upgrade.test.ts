import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Skill } from '../shared/types.js'
import { createStore } from '../store.js'
import { toolDeclaration } from '../tools.js'
import { seedSkills, vendoredSeedSkills } from './seed.js'
import { parseSkillMarkdown } from './skill-md.js'

/** The skills whose definition changed in seed-skill-upgrade-v2. */
const UPGRADED = ['workspace-audit', 'date-arithmetic', 'text-cleanup', 'multi-agent-orchestration']

/** A seed skill exactly as v1 (master before v2) shipped it. */
function v1Skill(id: string): Skill {
  const current = seedSkills.find((s) => s.id === id)!
  if (id === 'multi-agent-orchestration') return { ...structuredClone(current), tools: [] }
  const parsed = parseSkillMarkdown(readFileSync(new URL(`./seed-upgrade-fixtures/v1/${id}.md`, import.meta.url), 'utf8'))
  return {
    ...structuredClone(current),
    description: parsed.description,
    content: parsed.content,
    tools: parsed.tools.map((name) => toolDeclaration(name)!),
  }
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

/** A store as a v1 install wrote it: all 16 seeds offered, v1 migration applied. */
function writeV1Store(path: string, override: (skills: Skill[]) => Skill[] = (s) => s): void {
  const skills = seedSkills.map((s) => (UPGRADED.includes(s.id) ? v1Skill(s.id) : structuredClone(s)))
  writeFileSync(path, JSON.stringify({
    skills: override(skills),
    meta: { migrations: ['seed-skill-tools-v1'], seededSkillIds: seedSkills.map((s) => s.id) },
  }))
}

describe('seed-skill-upgrade-v2', () => {
  it('the v1 fixtures differ from the current seeds (otherwise this migration is a no-op)', () => {
    for (const id of UPGRADED) {
      const current = seedSkills.find((s) => s.id === id)!
      expect(v1Skill(id).tools.map((t) => t.name), id).not.toEqual(current.tools.map((t) => t.name))
    }
  })

  it('upgrades untouched v1 copies to the current seed, once, and leaves other skills alone', () => {
    const path = join(dir, 'store.json')
    writeV1Store(path)
    const upgraded = createStore(path)
    for (const id of UPGRADED) {
      const seed = seedSkills.find((s) => s.id === id)!
      expect(upgraded.skills.find((s) => s.id === id), id).toEqual(seed)
    }
    for (const seed of seedSkills.filter((s) => !UPGRADED.includes(s.id))) {
      expect(upgraded.skills.find((s) => s.id === seed.id)).toEqual(seed)
    }
    expect(upgraded.meta.migrations).toEqual(['seed-skill-tools-v1', 'seed-skill-upgrade-v2'])
    expect(createStore(path).skills).toEqual(upgraded.skills)
  })

  it('leaves copies the user edited (body or tools) exactly as they were', () => {
    const path = join(dir, 'store.json')
    writeV1Store(path, (skills) =>
      skills.map((s) => {
        if (s.id === 'workspace-audit') return { ...s, tools: [] }
        if (s.id === 'date-arithmetic') return { ...s, content: `${s.content}\n\nMy team uses ISO week numbers.` }
        if (s.id === 'multi-agent-orchestration') return { ...s, tools: [toolDeclaration('list_agents')!] }
        return s
      }),
    )
    const before = JSON.parse(readFileSync(path, 'utf8')) as { skills: Skill[] }
    const loaded = createStore(path)
    for (const id of ['workspace-audit', 'date-arithmetic', 'multi-agent-orchestration']) {
      expect(loaded.skills.find((s) => s.id === id), id).toEqual(before.skills.find((s) => s.id === id))
    }
    // The untouched one still upgrades.
    expect(loaded.skills.find((s) => s.id === 'text-cleanup')).toEqual(seedSkills.find((s) => s.id === 'text-cleanup'))
  })

  it('runs once: tools a user clears after the upgrade stay cleared', () => {
    const path = join(dir, 'store.json')
    writeV1Store(path)
    const upgraded = createStore(path)
    const audit = upgraded.skills.find((s) => s.id === 'workspace-audit')!
    audit.tools = []
    expect(upgraded.save()).toBe(true)
    expect(createStore(path).skills.find((s) => s.id === 'workspace-audit')?.tools).toEqual([])
  })

  it('does not resurrect an upgraded seed the user deleted', () => {
    const path = join(dir, 'store.json')
    writeV1Store(path, (skills) => skills.filter((s) => s.id !== 'text-cleanup'))
    expect(createStore(path).skills.some((s) => s.id === 'text-cleanup')).toBe(false)
  })

  it('fresh stores are born with the migration applied', () => {
    const fresh = createStore(join(dir, 'fresh.json'))
    expect(fresh.meta.migrations).toContain('seed-skill-upgrade-v2')
    expect(fresh.skills.map((s) => s.id)).toEqual(seedSkills.map((s) => s.id))
    expect(vendoredSeedSkills.find((s) => s.id === 'multi-agent-orchestration')?.tools.length).toBeGreaterThan(0)
  })
})
