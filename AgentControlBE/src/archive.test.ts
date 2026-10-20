import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from './app.js'
import { ARCHIVE_MIGRATION, PROJECTS_RETIRED, type ProjectArchive } from './archive.js'
import { assignAgentSlug, createStore } from './store.js'
import type { Agent } from './shared/types.js'

/** BE-1: store schema v2 and the projects archive (chat-first-archive-v1). */

let dir = ''

beforeEach(() => {
  vi.stubEnv('AGENTCONTROL_SECRET', 'archive-test-secret')
  vi.stubEnv('AGENTCONTROL_AUTH_TOKEN', '')
  dir = mkdtempSync(join(tmpdir(), 'agentcontrol-archive-'))
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

const agent = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, name, description: '', instructions: '', modelId: 'llama-3-8b', endpointId: 'ep_local_llama',
  role: '', skillIds: [], status: 'idle', createdAt: '2026-01-01T00:00:00.000Z', lastRunAt: null, runCount: 0, ...extra,
})

/** A pre-chat-first store: projects, a project chat, a project run, a tagged agent and a note. */
function legacyFixture() {
  const projectFolder = join(dir, 'projects', 'docs-refresh')
  mkdirSync(projectFolder, { recursive: true })
  writeFileSync(join(projectFolder, 'keep.txt'), 'untouched', 'utf8')
  return {
    agents: [
      agent('agt_lead', 'Team Lead', { isPrimary: true }),
      agent('agt_r1', 'Researcher', { projectId: 'proj_1', hidden: true }),
      agent('agt_r2', 'Researcher'),
      agent('agt_p', 'Primary'),
    ],
    runs: [
      { id: 'run_chat', agentId: 'agt_lead', startedAt: '2026-01-02T00:00:00.000Z', status: 'succeeded', durationMs: 5, steps: 1, input: 'hi', output: 'hello', error: null },
      { id: 'run_task', agentId: 'agt_r1', startedAt: '2026-01-03T00:00:00.000Z', status: 'succeeded', durationMs: 5, steps: 1, input: 'task', output: 'done', error: null, projectId: 'proj_1' },
    ],
    projects: [
      { id: 'proj_1', name: 'Docs Refresh', desc: 'd', folder: projectFolder, teamAgentIds: ['agt_r1'], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-03T00:00:00.000Z', somethingOld: 42 },
    ],
    projectMessages: [
      { id: 'pm_1', projectId: 'proj_1', author: 'user', text: 'go', kind: 'message', createdAt: '2026-01-03T00:00:00.000Z' },
    ],
    notes: [
      { id: 'note_1', title: 'T', body: 'B', tags: [], authorAgentId: 'agt_lead', updatedByAgentId: 'agt_lead', runId: 'run_chat', createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' },
    ],
    meta: { migrations: ['seed-skill-tools-v1', 'seed-skill-upgrade-v2', 'seed-skill-upgrade-v3'], seededSkillIds: [] },
  }
}

const archiveFiles = () => (existsSync(join(dir, 'archive')) ? readdirSync(join(dir, 'archive')) : [])

describe('chat-first-archive-v1', () => {
  it('archives the project data exactly, then drops it from the live store', () => {
    const fixture = legacyFixture()
    const path = join(dir, 'store.json')
    writeFileSync(path, JSON.stringify(fixture), 'utf8')

    const store = createStore(path)
    const files = archiveFiles()
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^projects-\d{4}-\d{2}-\d{2}T[\d-]+Z\.json$/)
    const archive = JSON.parse(readFileSync(join(dir, 'archive', files[0]!), 'utf8')) as ProjectArchive
    expect(archive.projects).toEqual(fixture.projects)
    expect(archive.projectMessages).toEqual(fixture.projectMessages)
    expect(archive.projectRuns.map((r) => r.id)).toEqual(['run_task'])
    expect(archive.notes.map((n) => n.id)).toEqual(['note_1'])
    expect(archive.folders).toEqual([fixture.projects[0]!.folder])
    expect(store.meta.archive).toEqual([{ name: files[0], createdAt: archive.createdAt, projectCount: 1 }])
    expect(store.meta.migrations).toContain(ARCHIVE_MIGRATION)

    // Project folders stay on disk; no temp file is left behind.
    expect(readFileSync(join(fixture.projects[0]!.folder, 'keep.txt'), 'utf8')).toBe('untouched')
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false)

    // Tagged agents become normal bots (hidden kept); project runs keep the field.
    const r1 = store.agents.find((a) => a.id === 'agt_r1') as Agent & { projectId?: string }
    expect(r1.projectId).toBeUndefined()
    expect(r1.hidden).toBe(true)
    expect(store.runs.find((r) => r.id === 'run_task')?.projectId).toBe('proj_1')
    expect(store.notes).toHaveLength(1)
    expect(store.memories).toEqual([])

    const saved = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    expect('projects' in saved).toBe(false)
    expect('projectMessages' in saved).toBe(false)
    expect((saved.agents as Record<string, unknown>[]).some((a) => 'projectId' in a)).toBe(false)
  })

  it('does nothing the second time', () => {
    const path = join(dir, 'store.json')
    writeFileSync(path, JSON.stringify(legacyFixture()), 'utf8')
    createStore(path)
    const before = readFileSync(path, 'utf8')
    const again = createStore(path)
    expect(archiveFiles()).toHaveLength(1)
    expect(again.meta.archive).toHaveLength(1)
    expect(again.meta.migrations.filter((m) => m === ARCHIVE_MIGRATION)).toHaveLength(1)
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it('aborts on a failed write and leaves the store unchanged, then succeeds on a later boot', () => {
    const path = join(dir, 'store.json')
    const raw = JSON.stringify(legacyFixture())
    writeFileSync(path, raw, 'utf8')
    // A file where the archive folder should be makes the write fail.
    writeFileSync(join(dir, 'archive'), 'not a folder', 'utf8')
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const store = createStore(path)
    expect(spy).toHaveBeenCalledWith(expect.stringContaining(`${ARCHIVE_MIGRATION} aborted`))
    expect(readFileSync(path, 'utf8')).toBe(raw)
    expect(store.meta.migrations).not.toContain(ARCHIVE_MIGRATION)
    expect(store.meta.archive).toEqual([])
    expect((store.agents.find((a) => a.id === 'agt_r1') as Agent & { projectId?: string }).projectId).toBe('proj_1')

    // A later save still carries the project data, so nothing is lost.
    expect(store.save()).toBe(true)
    const saved = JSON.parse(readFileSync(path, 'utf8')) as { projects: unknown[]; projectMessages: unknown[] }
    expect(saved.projects).toHaveLength(1)
    expect(saved.projectMessages).toHaveLength(1)
    spy.mockRestore()

    rmSync(join(dir, 'archive'))
    const retried = createStore(path)
    expect(retried.meta.migrations).toContain(ARCHIVE_MIGRATION)
    expect(archiveFiles()).toHaveLength(1)
  })

  it('marks the migration without writing a file when there were no projects', () => {
    const path = join(dir, 'store.json')
    writeFileSync(path, JSON.stringify({ ...legacyFixture(), projects: [], projectMessages: [] }), 'utf8')
    const store = createStore(path)
    expect(store.meta.migrations).toContain(ARCHIVE_MIGRATION)
    expect(archiveFiles()).toEqual([])
  })

  it('fresh stores are born migrated and seed no projects', () => {
    const store = createStore(join(dir, 'store.json'))
    expect(store.meta.migrations).toContain(ARCHIVE_MIGRATION)
    expect(store.meta.archive).toEqual([])
    expect('projects' in store).toBe(false)
  })
})

describe('agent slugs, internet policy and memoryLearn', () => {
  it('migrates agents to unique slugs with Primary as `primary`', () => {
    const path = join(dir, 'store.json')
    writeFileSync(path, JSON.stringify(legacyFixture()), 'utf8')
    const store = createStore(path)
    const slug = (id: string) => store.agents.find((a) => a.id === id)?.slug
    expect(slug('agt_lead')).toBe('primary')
    expect(slug('agt_r1')).toBe('researcher')
    expect(slug('agt_r2')).toBe('researcher-2')
    expect(slug('agt_p')).toBe('primary-2')
    for (const a of store.agents) {
      expect(a.internetPolicy).toBe('ask')
      expect(a.memoryLearn).toBe(true)
    }
    // Slugs are kept on reload.
    expect(createStore(path).agents.map((a) => a.slug)).toEqual(store.agents.map((a) => a.slug))
  })

  it('assignAgentSlug fits the pattern, falls back to `bot`, and keeps suffixes within 40 chars', () => {
    const taken = new Set<string>()
    const long = 'A'.repeat(60)
    const first = assignAgentSlug(long, false, taken)
    const second = assignAgentSlug(long, false, taken)
    expect(first).toBe('a'.repeat(40))
    expect(second).toBe(`${'a'.repeat(38)}-2`)
    expect(assignAgentSlug('!!!', false, taken)).toBe('bot')
    expect(assignAgentSlug('Café Ünïcode', false, taken)).toBe('cafe-unicode')
    expect(assignAgentSlug('Lead', true, taken)).toBe('primary')
    expect(assignAgentSlug('Lead', true, taken)).toBe('lead')
    for (const s of taken) expect(s).toMatch(/^[a-z0-9-]{1,40}$/)
  })

  it('POST /api/agents assigns a slug and defaults; PUT keeps the slug and validates the new fields', async () => {
    const app = buildApp(createStore(join(dir, 'store.json')))
    const body = { name: 'Writer', endpointId: 'ep_local_llama', modelId: 'llama-3-8b' }
    const lead = (await app.inject({ method: 'POST', url: '/api/agents', payload: body })).json() as Agent
    expect(lead).toMatchObject({ slug: 'primary', isPrimary: true, internetPolicy: 'ask', memoryLearn: true })
    const writer = (await app.inject({ method: 'POST', url: '/api/agents', payload: body })).json() as Agent
    expect(writer.slug).toBe('writer')
    const dup = (await app.inject({ method: 'POST', url: '/api/agents', payload: body })).json() as Agent
    expect(dup.slug).toBe('writer-2')

    const put = await app.inject({
      method: 'PUT', url: `/api/agents/${writer.id}`,
      payload: { ...body, name: 'Renamed', slug: 'hacked', internetPolicy: 'never', memoryLearn: false },
    })
    expect(put.statusCode).toBe(200)
    expect(put.json()).toMatchObject({ slug: 'writer', name: 'Renamed', internetPolicy: 'never', memoryLearn: false })
    const kept = await app.inject({ method: 'PUT', url: `/api/agents/${writer.id}`, payload: { ...body, name: 'Renamed' } })
    expect(kept.json()).toMatchObject({ internetPolicy: 'never', memoryLearn: false })

    const bad = await app.inject({ method: 'PUT', url: `/api/agents/${writer.id}`, payload: { ...body, internetPolicy: 'sometimes' } })
    expect(bad.statusCode).toBe(400)
    const badLearn = await app.inject({ method: 'PUT', url: `/api/agents/${writer.id}`, payload: { ...body, memoryLearn: 'yes' } })
    expect(badLearn.statusCode).toBe(400)
    await app.close()
  })
})

describe('retired project routes', () => {
  it.each([
    ['GET', '/api/projects'],
    ['POST', '/api/projects'],
    ['PATCH', '/api/projects/proj_1'],
    ['DELETE', '/api/projects/proj_1'],
    ['GET', '/api/projects/proj_1/messages'],
    ['POST', '/api/projects/proj_1/team-plan'],
    ['POST', '/api/projects/proj_1/team-plan/apply'],
    ['POST', '/api/projects/proj_1/tasks/m1/retry'],
    ['GET', '/api/projects/proj_1/runs/run_1'],
  ] as const)('%s %s answers 410', async (method, url) => {
    const app = buildApp(createStore(join(dir, 'store.json')))
    const res = await app.inject({ method, url, payload: method === 'GET' || method === 'DELETE' ? undefined : {} })
    expect(res.statusCode).toBe(410)
    expect(res.json()).toEqual({ error: PROJECTS_RETIRED })
    await app.close()
  })

  it('GET /api/archive/projects lists the archive files without server paths', async () => {
    const path = join(dir, 'store.json')
    writeFileSync(path, JSON.stringify(legacyFixture()), 'utf8')
    const app = buildApp(createStore(path))
    const res = await app.inject({ method: 'GET', url: '/api/archive/projects' })
    expect(res.statusCode).toBe(200)
    const { files } = res.json() as { files: { name: string; createdAt: string; projectCount: number }[] }
    expect(files).toHaveLength(1)
    expect(files[0]).toEqual({ name: archiveFiles()[0], createdAt: expect.any(String), projectCount: 1 })
    expect(res.body).not.toContain(dir)
    await app.close()
  })
})
