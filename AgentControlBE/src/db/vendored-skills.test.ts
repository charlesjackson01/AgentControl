import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../app.js'
import { createStore, VENDOR_SKILLS_MIGRATION } from '../store.js'
import type { Agent, Skill, SkillListResponse } from '../shared/types.js'
import { coreSkillId, seedSkills, vendoredSeedSkills } from './seed.js'
import { DEFAULT_VENDOR_DIR, PROPRIETARY_SKILLS, loadVendoredLibrary } from './vendored-skills.js'

const manifest = JSON.parse(readFileSync(join(DEFAULT_VENDOR_DIR, 'manifest.json'), 'utf8')) as {
  sources: { id: string; exclude?: string[] }[]
  defaults: Record<string, string[] | '*'>
}

let dir: string
beforeEach(() => {
  vi.stubEnv('AGENTCONTROL_SECRET', 'vendored-skills-test-secret')
  vi.stubEnv('AGENTCONTROL_AUTH_TOKEN', '')
  dir = mkdtempSync(join(tmpdir(), 'agentcontrol-vendored-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

describe('vendor manifest', () => {
  it('excludes every proprietary skill and lists no proprietary default', () => {
    for (const [source, names] of Object.entries(PROPRIETARY_SKILLS)) {
      expect(manifest.sources.find((s) => s.id === source)?.exclude).toEqual(expect.arrayContaining(names))
      const defaults = manifest.defaults[source]
      expect(Array.isArray(defaults) ? defaults.filter((n) => names.includes(n)) : []).toEqual([])
    }
  })
})

describe('vendored library on disk', () => {
  const library = loadVendoredLibrary(DEFAULT_VENDOR_DIR)

  it('loads all 341 locked skills with no problems and no proprietary skills', () => {
    expect(library.problems).toEqual([])
    expect(library.skills).toHaveLength(341)
    expect(library.sources.map((s) => [s.id, s.count])).toEqual([
      ['superpowers', library.skills.filter((s) => s.sourceId === 'superpowers').length],
      ['anthropics', library.skills.filter((s) => s.sourceId === 'anthropics').length],
      ['ecc', library.skills.filter((s) => s.sourceId === 'ecc').length],
    ])
    for (const name of PROPRIETARY_SKILLS.anthropics!) expect(library.skills.some((s) => s.id === `anthropics/${name}`)).toBe(false)
    for (const s of library.skills) {
      expect(s.id).toBe(`${s.sourceId}/${s.name}`)
      expect(s.tools).toEqual([])
      expect(s.sourceCommit).toMatch(/^[0-9a-f]{40}$/)
      expect(s.content.length).toBeGreaterThan(0)
    }
  })

  it('marks 35 vendored skills default-on, 41 with the 6 core defaults', () => {
    const vendoredOn = library.skills.filter((s) => s.defaultOn)
    const coreOn = seedSkills.filter((s) => s.defaultOn)
    expect(coreOn.map((s) => s.id)).toEqual(expect.arrayContaining(
      (manifest.defaults.core as string[]).map(coreSkillId),
    ))
    expect(vendoredOn.length + coreOn.length).toBe(41)
    expect(library.skills.filter((s) => s.sourceId === 'superpowers').every((s) => s.defaultOn)).toBe(true)
  })

  it('returns an empty library when the folder is off or missing', () => {
    expect(loadVendoredLibrary(null).skills).toEqual([])
    expect(loadVendoredLibrary(join(dir, 'nope')).skills).toEqual([])
  })
})

describe('vendored skills in the store', () => {
  beforeEach(() => vi.stubEnv('AGENTCONTROL_SKILLS_VENDOR_DIR', DEFAULT_VENDOR_DIR))

  it('seeds core plus vendored skills, writes vendored bodies as empty and rehydrates them from disk', () => {
    const path = join(dir, 'store.json')
    const store = createStore(path)
    expect(store.skills).toHaveLength(seedSkills.length + 341)
    expect(store.skills.filter((s) => s.defaultOn)).toHaveLength(41)
    expect(store.save()).toBe(true)
    const written = JSON.parse(readFileSync(path, 'utf8')) as { skills: Skill[] }
    const vendoredWritten = written.skills.filter((s) => s.sourceId !== 'core' && s.sourceId !== 'custom')
    expect(vendoredWritten).toHaveLength(341)
    expect(vendoredWritten.every((s) => s.content === '')).toBe(true)
    const reopened = createStore(path)
    expect(reopened.skills).toEqual(store.skills)
  })

  it('serves summaries with filters and keeps vendored skills read-only', async () => {
    const store = createStore(join(dir, 'store.json'))
    const app = buildApp(store)
    try {
      const all = (await app.inject({ method: 'GET', url: '/api/skills' })).json() as SkillListResponse
      expect(all.skills).toHaveLength(store.skills.length)
      expect(all.skills.every((s) => !('content' in s))).toBe(true)
      expect(all.sources.map((s) => s.id)).toEqual(['core', 'superpowers', 'anthropics', 'ecc', 'custom'])
      expect(all.sources.find((s) => s.id === 'core')?.count).toBe(seedSkills.length)

      const anthropic = (await app.inject({ method: 'GET', url: '/api/skills?source=anthropics' })).json() as SkillListResponse
      expect(anthropic.skills.length).toBeGreaterThan(0)
      expect(anthropic.skills.every((s) => s.sourceId === 'anthropics')).toBe(true)
      const on = (await app.inject({ method: 'GET', url: '/api/skills?defaultOn=true' })).json() as SkillListResponse
      expect(on.skills).toHaveLength(41)
      const q = (await app.inject({ method: 'GET', url: '/api/skills?q=SKILL-CREATOR' })).json() as SkillListResponse
      expect(q.skills.map((s) => s.id)).toContain('anthropics/skill-creator')
      expect((await app.inject({ method: 'GET', url: '/api/skills?source=nope' })).statusCode).toBe(400)
      expect((await app.inject({ method: 'GET', url: '/api/skills?defaultOn=yes' })).statusCode).toBe(400)

      const id = encodeURIComponent('anthropics/skill-creator')
      const one = await app.inject({ method: 'GET', url: `/api/skills/${id}` })
      expect(one.statusCode).toBe(200)
      expect((one.json() as Skill).content.length).toBeGreaterThan(100)
      const patch = await app.inject({ method: 'PATCH', url: `/api/skills/${id}`, payload: { name: 'x' } })
      expect(patch.statusCode).toBe(403)
      expect(patch.json()).toMatchObject({ message: 'Vendored skills are read-only.' })
      expect((await app.inject({ method: 'DELETE', url: `/api/skills/${id}` })).statusCode).toBe(403)
      // Core seeds stay editable.
      const core = encodeURIComponent('core/summarization')
      expect((await app.inject({ method: 'PATCH', url: `/api/skills/${core}`, payload: { description: 'Mine.' } })).statusCode).toBe(200)
    } finally {
      await app.close()
    }
  })

  it('imports SKILL.md as an editable, default-off custom skill', async () => {
    const app = buildApp(createStore(join(dir, 'store.json')))
    try {
      const markdown = '---\nname: my-flow\ndescription: Mine.\nlicense: MIT\nallowed-tools: Read Grep\n---\nDo it.'
      const res = await app.inject({ method: 'POST', url: '/api/skills/import', payload: { markdown } })
      expect(res.statusCode).toBe(201)
      expect(res.json()).toMatchObject({ sourceId: 'custom', defaultOn: false, hasScripts: false, license: 'MIT', allowedTools: ['Read', 'Grep'] })
      const id = encodeURIComponent((res.json() as Skill).id)
      expect((await app.inject({ method: 'PATCH', url: `/api/skills/${id}`, payload: { description: 'Edited.' } })).statusCode).toBe(200)
    } finally {
      await app.close()
    }
  })
})

describe('vendor-skills-v1 id migration', () => {
  it('moves seeds to core/<name>, rewrites agent skillIds, and leaves a same-named custom skill alone', () => {
    const path = join(dir, 'store.json')
    const bare = vendoredSeedSkills.map((s) => ({ ...structuredClone(s), id: s.name }))
    const legacy = bare.filter((s) => s.id !== 'debugging')
    // The user deleted the debugging seed and imported their own skill with that slug.
    const custom = { id: 'debugging', name: 'debugging', description: 'Mine.', tag: 'Custom', content: 'My way.', tools: [] }
    const agent = { id: 'agt_one', name: 'One', skillIds: ['summarization', 'debugging', 'summarization'] } as unknown as Agent
    writeFileSync(path, JSON.stringify({
      skills: [...legacy, custom],
      agents: [agent],
      meta: { migrations: ['seed-skill-tools-v1', 'seed-skill-upgrade-v2', 'seed-skill-upgrade-v3', 'chat-first-archive-v1'], seededSkillIds: seedSkills.map((s) => s.name) },
    }))
    const store = createStore(path)
    expect(store.meta.migrations).toContain(VENDOR_SKILLS_MIGRATION)
    expect(store.skills.some((s) => s.id === 'core/summarization')).toBe(true)
    expect(store.skills.some((s) => s.id === 'summarization')).toBe(false)
    expect(store.skills.find((s) => s.id === 'debugging')).toMatchObject({ content: 'My way.', sourceId: 'custom' })
    // The deleted seed stays deleted.
    expect(store.skills.some((s) => s.id === 'core/debugging')).toBe(false)
    expect(store.agents.find((a) => a.id === 'agt_one')?.skillIds).toEqual(['core/summarization', 'debugging'])
    expect(store.meta.seededSkillIds).toEqual(seedSkills.map((s) => s.id))
    // Runs once.
    expect(createStore(path).skills).toEqual(store.skills)
  })
})
