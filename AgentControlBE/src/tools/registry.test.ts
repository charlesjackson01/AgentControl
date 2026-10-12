// First import is the registry facade on purpose: it must load standalone
// (seed.ts resolves declarations at module load, so a runtime import cycle
// through store.ts would crash here).
import { builtinTools, listToolInfo, resolveToolDeclarations, toolDeclaration } from '../tools.js'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const CATEGORIES = new Set(['workspace', 'notes', 'time', 'math', 'text', 'data'])

describe('tool registry', () => {
  it('keeps the original three tools first, in order', () => {
    expect([...builtinTools.keys()].slice(0, 3)).toEqual(['list_agents', 'list_skills', 'read_run_log'])
  })

  it('gives every tool a valid category, effect, snake_case name and flat object schema', () => {
    for (const [name, t] of builtinTools) {
      expect(name).toMatch(/^[a-z][a-z0-9_]{1,63}$/)
      expect(t.name).toBe(name)
      expect(CATEGORIES.has(t.category)).toBe(true)
      expect(['read', 'write']).toContain(t.effect)
      expect((t.parameters as { type?: string }).type).toBe('object')
    }
  })

  it('keeps descriptions short with an example, and declarations small (small-model budgets)', () => {
    for (const t of builtinTools.values()) {
      expect(t.description.length, t.name).toBeLessThanOrEqual(240)
      expect(t.description, t.name).toContain('Example:')
      expect(JSON.stringify({ description: t.description, parameters: t.parameters }).length, t.name).toBeLessThanOrEqual(1200)
    }
  })

  it('declares content params that exist in the schema', () => {
    for (const t of builtinTools.values()) {
      const props = (t.parameters as { properties?: Record<string, unknown> }).properties ?? {}
      for (const p of t.contentParams?.names ?? []) expect(Object.hasOwn(props, p), `${t.name}.${p}`).toBe(true)
      if (t.contentParams?.defaultParam) expect(t.contentParams.names).toContain(t.contentParams.defaultParam)
    }
  })

  it('lists tool info for the API and resolves declarations', () => {
    expect(listToolInfo().map((t) => t.name)).toEqual([...builtinTools.keys()])
    expect(toolDeclaration('nope')).toBeUndefined()
    const { tools, ignored } = resolveToolDeclarations(['list_skills', 'Read', 'list_skills', 'list_agents'], { max: 1 })
    expect(tools.map((t) => t.name)).toEqual(['list_skills'])
    expect(ignored).toEqual(['Read', 'list_agents'])
    expect(() => resolveToolDeclarations(['Read'], { strict: true })).toThrow(/Unknown built-in tool/)
  })
})

describe('tool module source rules', () => {
  const dir = dirname(fileURLToPath(import.meta.url))
  const sources = readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => ({ file: f, text: readFileSync(join(dir, f), 'utf8') }))

  it('never touches the network, filesystem, shell, workers or eval', () => {
    const banned = [
      /from ['"]node:(fs|child_process|net|http|https|dgram|worker_threads|vm)['"]/,
      /from ['"](fs|child_process|net|http|https|dgram|worker_threads|vm)['"]/,
      /\bfetch\s*\(/,
      /\beval\s*\(/,
      /new\s+Function\s*\(/,
      /new\s+RegExp\s*\(/,
    ]
    for (const { file, text } of sources) {
      for (const pattern of banned) expect(pattern.test(text), `${file} matches ${pattern}`).toBe(false)
    }
  })

  it('imports store/app/upstream as types only (no runtime cycle)', () => {
    for (const { file, text } of sources) {
      expect(/^import\s+(?!type)[^;]*from ['"]\.\.\/(store|app|upstream)\.js['"]/m.test(text), file).toBe(false)
    }
  })
})
