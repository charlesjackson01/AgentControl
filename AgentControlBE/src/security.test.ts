/**
 * BE-P2-19: plain (fake-engine) checks for §13 rows that need no real engine.
 * - permissions: no model tool can answer, approve or change a permission (the card's answer route
 *   is user-only and needs the confirm header: permission-routes.test.ts)
 * - memory/profile: the product's mounts never include memory, BOT.md, another bot's folder or
 *   snapshots; only the workspace (and group folders with room) are writable
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from './app.js'
import { botMounts } from './bot-env-routes.js'
import type { Agent, Endpoint } from './shared/types.js'
import { createStore, type WorkspaceStore } from './store.js'
import { builtinTools } from './tools.js'

let dir = ''
let store: WorkspaceStore
let app: FastifyInstance

beforeEach(() => {
  process.env.AGENTCONTROL_SECRET = 'be19-unit-secret'
  dir = mkdtempSync(join(tmpdir(), 'ac-be19-unit-'))
  store = createStore(join(dir, 'store.json'))
  app = buildApp(store)
})
afterEach(async () => {
  await app.close()
  rmSync(dir, { recursive: true, force: true })
  delete process.env.AGENTCONTROL_SECRET
})

const post = async <T>(url: string, payload: object): Promise<T> => {
  const r = await app.inject({ method: 'POST', url, payload })
  expect(r.statusCode, r.body).toBeLessThan(300)
  return r.json() as T
}

describe('BE-P2-19 security (plain)', () => {
  it('permissions: no model tool answers, approves or changes a permission', () => {
    const names = [...builtinTools.keys()]
    expect(names.length).toBeGreaterThan(10)
    for (const t of builtinTools.values()) {
      expect(t.name, t.name).not.toMatch(/permission|approve|grant|confirm|policy/i)
      const props = Object.keys((t.parameters as { properties?: Record<string, unknown> }).properties ?? {})
      expect(props.join(','), t.name).not.toMatch(/permission|decision|approve|grant|confirm|internetPolicy/i)
      expect(t.description, t.name).not.toMatch(/\b(approve|answer) (a |the )?(permission|card)/i)
    }
  })

  it('memory/profile: the product mounts never include memory, BOT.md, another bot or snapshots', async () => {
    const ep = await post<Endpoint>('/api/endpoints', { kind: 'openai-compatible', name: 'E', baseUrl: 'http://127.0.0.1:9', defaultModel: 'm', contextWindow: 8192 })
    const mk = (name: string) => post<Agent>('/api/agents', { name, description: 'd', instructions: 'i', modelId: 'm', endpointId: ep.id, skillIds: [], rules: [] })
    const a = await mk('Be19 Alpha')
    const b = await mk('Be19 Beta')
    const mounts = botMounts(store, a)
    expect(mounts.map((m) => m.target).sort()).toEqual(['/bot/shared', '/bot/workspace'])
    expect(mounts.filter((m) => !m.readonly).map((m) => m.target)).toEqual(['/bot/workspace'])
    for (const m of mounts) {
      expect(m.source).not.toMatch(/memory|BOT\.md|snapshots|store\.json/)
      expect(m.source.split(sep)).not.toContain(b.slug)
      expect(m.source.split(sep)).toContain(a.slug)
    }
  })
})
