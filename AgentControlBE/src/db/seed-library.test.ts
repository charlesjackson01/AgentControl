import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../app.js'
import { createStore } from '../store.js'
import type { Skill } from '../shared/types.js'
import { listToolInfo, toolDeclaration } from '../tools.js'
import { parseSkillMarkdown } from './skill-md.js'
import { seedSkills, vendoredSeedSkills } from './seed.js'

/** Vendored seeds: bodies are pinned, so only the frontmatter tools line is ours. */
const expectedVendoredTools: Record<string, string[]> = {
  'code-review': ['diff_text', 'process_lines', 'extract_entities'],
  debugging: ['process_lines', 'extract_entities', 'diff_text', 'read_run_log'],
  'deep-research': ['list_notes', 'read_note', 'save_note', 'extract_entities'],
  'multi-agent-orchestration': ['list_agents', 'get_agent', 'workspace_overview', 'read_run_log', 'get_skill'],
  summarization: ['text_stats', 'read_note', 'save_note'],
  'technical-writing': ['text_stats', 'diff_text', 'read_note', 'save_note'],
}

const expectedTools: Record<string, string[]> = {
  'calculation-checker': ['calculate'],
  'unit-conversion': ['convert_units', 'calculate'],
  'date-arithmetic': ['current_time', 'date_difference', 'add_date', 'resolve_date'],
  'text-cleanup': ['text_stats', 'transform_text', 'read_note', 'process_lines', 'extract_entities'],
  'text-comparison': ['diff_text', 'compare_text', 'read_note'],
  'json-inspection': ['json_query', 'read_note'],
  'csv-analysis': ['csv_summary', 'calculate', 'read_note'],
  'notes-organizer': ['list_notes', 'read_note', 'save_note'],
  'meeting-notes': ['list_notes', 'read_note', 'save_note'],
  'workspace-audit': ['list_agents', 'list_skills', 'read_run_log', 'get_agent', 'workspace_overview', 'get_skill'],
  'encoding-and-hashing': ['encode_text', 'read_note', 'save_note'],
  'release-notes': ['diff_text', 'extract_entities', 'read_note', 'save_note'],
}

const authored = seedSkills.filter((skill) => skill.source === 'AgentControl')
const markdown = (name: string) => readFileSync(new URL(`./seed-skills/${name}.md`, import.meta.url), 'utf8')

let dir: string
beforeEach(() => {
  vi.stubEnv('AGENTCONTROL_SECRET', 'seed-library-test-secret')
  vi.stubEnv('AGENTCONTROL_AUTH_TOKEN', '')
  dir = mkdtempSync(join(tmpdir(), 'agentcontrol-seed-library-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

describe('vendored seed library', () => {
  it.each(Object.entries(expectedVendoredTools))('%s declares its tools in frontmatter only', (name, tools) => {
    const parsed = parseSkillMarkdown(markdown(name))
    const seed = vendoredSeedSkills.find((skill) => skill.id === name)!
    expect(parsed.tools).toEqual(tools)
    expect(seed.tools).toEqual(tools.map((tool) => toolDeclaration(tool)))
    expect(seed.content).toBe(parsed.content)
    // Our line sits in the frontmatter, never in the vendored body.
    expect(seed.content).not.toMatch(/^tools:/m)
  })
})

describe('authored seed library', () => {
  it('adds exactly twelve distinct authored skills after the six vendored skills', () => {
    expect(vendoredSeedSkills.map((skill) => skill.id)).toEqual(Object.keys(expectedVendoredTools))
    expect(seedSkills).toHaveLength(18)
    expect(authored.map((skill) => skill.id)).toEqual(Object.keys(expectedTools))
    expect(new Set(seedSkills.map((skill) => skill.id)).size).toBe(seedSkills.length)
    expect(seedSkills.slice(0, 6)).toEqual(vendoredSeedSkills)
  })

  it('declares every registry tool an authored body tells the model to call', () => {
    const registry = listToolInfo().map((tool) => tool.name)
    for (const skill of authored) {
      const mentioned = registry.filter((name) => skill.content.includes(`\`${name}\``) || skill.content.includes(`${name}(`))
      const declared = skill.tools.map((tool) => tool.name)
      expect(mentioned.filter((name) => !declared.includes(name)), skill.id).toEqual([])
    }
  })

  it.each(Object.entries(expectedTools))('%s imports with the same content and canonical tool declarations', async (name, tools) => {
    const source = markdown(name)
    const parsed = parseSkillMarkdown(source)
    const seed = authored.find((skill) => skill.id === name)!
    expect(parsed.name).toBe(name)
    expect(parsed.tools).toEqual(tools)
    expect(seed.tools).toEqual(tools.map((tool) => toolDeclaration(tool)))
    expect(seed.tools.every(Boolean)).toBe(true)
    expect(seed.content).toBe(parsed.content)
    expect(parsed.content).toContain('## Workflow')
    expect(parsed.content).toContain('## Example')
    expect(parsed.content).toContain('## Limits')

    const store = createStore(join(dir, 'store.json'))
    store.skills = []
    const app = buildApp(store)
    try {
      const response = await app.inject({ method: 'POST', url: '/api/skills/import', payload: { markdown: source } })
      expect(response.statusCode).toBe(201)
      const imported = response.json() as Skill & { ignoredTools?: string[] }
      expect(imported).toMatchObject({ name, description: parsed.description, content: seed.content, tools: seed.tools })
      expect(imported.ignoredTools ?? []).toEqual([])
    } finally {
      await app.close()
    }
  })

  it('upgrades a six-seed store once and preserves edited and deleted skills across reloads', () => {
    const path = join(dir, 'store.json')
    const edited = { ...structuredClone(vendoredSeedSkills[0]!), content: 'My custom review instructions', tools: [] }
    const retained = [edited, ...structuredClone(vendoredSeedSkills.slice(1)).filter((skill) => skill.id !== 'debugging')]
    writeFileSync(path, JSON.stringify({
      skills: retained,
      meta: { migrations: ['seed-skill-tools-v1'], seededSkillIds: vendoredSeedSkills.map((skill) => skill.id) },
    }))

    const upgraded = createStore(path)
    expect(upgraded.skills).toEqual([...retained, ...authored])
    expect(upgraded.meta.seededSkillIds).toEqual(seedSkills.map((skill) => skill.id))
    expect(createStore(path).skills).toEqual(upgraded.skills)

    // A new seed the user edits stays edited, and a new seed the user deletes
    // stays absent; reloading never treats either as an unoffered seed.
    const newEdited = upgraded.skills.find((skill) => skill.id === 'notes-organizer')!
    newEdited.content = 'Keep my local notes workflow'
    newEdited.tools = []
    upgraded.skills = upgraded.skills.filter((skill) => skill.id !== 'csv-analysis')
    expect(upgraded.save()).toBe(true)
    const reopened = createStore(path)
    expect(reopened.skills).toEqual(upgraded.skills)
    expect(reopened.skills.find((skill) => skill.id === 'notes-organizer')).toMatchObject({
      content: 'Keep my local notes workflow', tools: [],
    })
    expect(reopened.skills.some((skill) => skill.id === 'csv-analysis' || skill.id === 'debugging')).toBe(false)
  })
})
