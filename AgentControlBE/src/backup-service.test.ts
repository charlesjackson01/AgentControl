/**
 * BE-P2-18: BackupService on fake storage (a copy of a data folder under the test TMPDIR), a fake
 * clock and fake free space. No engine, no live data, nothing under /tmp unless TMPDIR says so.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readTar, readZip, zstdDecompress } from './backup-archive.js'
import { BACKUP_IN_PROGRESS_TEXT, backupsRootFor, backupStamp, createBackupService, lastScheduled, type BackupManifest, type BackupService, type BackupServiceDeps } from './backup-service.js'
import type { Agent, BackupInfo } from './shared/types.js'

let dir = ''
let data = ''
let clock = new Date(2026, 10, 6, 10, 0, 0)
let free: number | null = null
let active = 0
let events: { info: BackupInfo; agentIds: readonly string[] }[] = []
let agents: Agent[] = []

const agent = (id: string, slug: string, extra: Partial<Agent['vm']> = {}): Agent =>
  ({
    id,
    slug,
    name: slug[0]!.toUpperCase() + slug.slice(1),
    vm: { permissions: { browser: false }, gvisor: 'inherit', env: [], packages: [], image: { generation: 0, base: 'base' }, egress: { allow: [] }, ...extra },
  }) as unknown as Agent

const botDir = (slug: string) => join(data, 'bots', slug)
function seedBot(slug: string, tag = slug): void {
  const d = botDir(slug)
  mkdirSync(join(d, 'workspace', 'reports'), { recursive: true })
  mkdirSync(join(d, 'shared'), { recursive: true })
  mkdirSync(join(d, 'memory'), { recursive: true })
  writeFileSync(join(d, 'workspace', 'reports', 'q3.csv'), `a,b\n1,${tag}\n`)
  writeFileSync(join(d, 'workspace', 'notes.md'), `# notes ${tag}\n`)
  writeFileSync(join(d, 'shared', 'input.txt'), `input ${tag}\n`)
  writeFileSync(join(d, 'memory', 'MEMORY.md'), `- remembers ${tag}\n`)
  writeFileSync(join(d, 'BOT.md'), `# ${tag}\n`)
}

/** sha256 per file of workspace, shared, memory and BOT.md. */
function hashes(slug: string): Record<string, string> {
  const out: Record<string, string> = {}
  const visit = (abs: string, rel: string) => {
    for (const n of readdirSync(abs, { withFileTypes: true })) {
      const a = join(abs, n.name)
      const r = rel ? `${rel}/${n.name}` : n.name
      if (n.isDirectory()) visit(a, r)
      else out[r] = createHash('sha256').update(readFileSync(a)).digest('hex')
    }
  }
  for (const z of ['workspace', 'shared', 'memory']) if (existsSync(join(botDir(slug), z))) visit(join(botDir(slug), z), z)
  if (existsSync(join(botDir(slug), 'BOT.md'))) out['BOT.md'] = createHash('sha256').update(readFileSync(join(botDir(slug), 'BOT.md'))).digest('hex')
  return out
}

function service(extra: Partial<BackupServiceDeps> = {}): BackupService {
  return createBackupService({
    root: () => join(data, 'backups'),
    agents: () => agents,
    botDir: (a) => botDir(a.slug),
    keep: () => 7,
    freeBytes: () => free,
    activeRuns: () => active,
    onProgress: (info, agentIds) => events.push({ info, agentIds }),
    now: () => new Date(clock),
    ...extra,
  })
}

async function members(archive: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  let name = ''
  await readTar(Readable.from(readFileSync(archive)).pipe(zstdDecompress()) as AsyncIterable<Buffer>, {
    onMember: (m) => {
      name = m.name
      out.set(name, m.kind === 'dir' ? '<dir>' : '')
    },
    onData: (c) => {
      out.set(name, out.get(name)! + c.toString())
    },
  })
  return out
}

const day = (n: number) => new Date(2026, 10, 6 + n, 10, 0, 0)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ac-be18-svc-'))
  data = join(dir, 'data-copy')
  mkdirSync(data)
  clock = day(0)
  free = null
  active = 0
  events = []
  agents = [agent('a_1', 'analyst', { packages: ['jq'], tools: { pip: ['pandas==2.2.3'], npm: [], optBin: [], updatedAt: '2026-11-01T00:00:00.000Z' } }), agent('a_2', 'writer')]
  seedBot('analyst')
  seedBot('writer')
  // Undo snapshots live beside the bots; they must never be in a backup.
  mkdirSync(join(data, 'snapshots', 'analyst', 'r1', 'files'), { recursive: true })
  writeFileSync(join(data, 'snapshots', 'analyst', 'r1', 'files', 'old.txt'), 'snapshot')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('paths and clock helpers', () => {
  it('uses %LOCALAPPDATA%\\AgentControl\\backups on Windows and <data>/backups elsewhere', () => {
    expect(backupsRootFor('win32', 'C:\\data', { LOCALAPPDATA: 'C:\\Users\\cole\\AppData\\Local' })).toBe('C:\\Users\\cole\\AppData\\Local\\AgentControl\\backups')
    expect(backupsRootFor('win32', 'C:\\data', {}, () => 'C:\\Users\\cole')).toBe('C:\\Users\\cole\\AppData\\Local\\AgentControl\\backups')
    expect(backupsRootFor('linux', '/srv/ac/data', {})).toBe('/srv/ac/data/backups')
    expect(backupsRootFor('darwin', '/Users/cole/ac/data', {})).toBe('/Users/cole/ac/data/backups')
  })
  it('stamps ids in UTC to the second, and finds the last local schedule', () => {
    expect(backupStamp(new Date('2026-11-06T09:00:00.123Z'))).toBe('2026-11-06T09-00-00Z')
    expect(lastScheduled(new Date(2026, 10, 6, 3, 0), '03:00').getTime()).toBe(new Date(2026, 10, 6, 3, 0).getTime())
    expect(lastScheduled(new Date(2026, 10, 6, 2, 59), '03:00').getTime()).toBe(new Date(2026, 10, 5, 3, 0).getTime())
  })
})

describe('create', () => {
  it('answers in_progress, then writes one tar.zst per bot with the manifest, and no snapshots', async () => {
    const svc = service()
    const first = svc.start({ trigger: 'manual' })
    expect(first).toMatchObject({ status: 'in_progress', trigger: 'manual', agentIds: ['a_1', 'a_2'], progress: { done: 0, total: 2 } })
    expect(first.path).toBe(join(data, 'backups', first.id))
    expect(() => svc.start({ trigger: 'manual' })).toThrow(BACKUP_IN_PROGRESS_TEXT)
    await svc.idle()
    const done = svc.get(first.id)!
    expect(done).toMatchObject({ status: 'complete', agentIds: ['a_1', 'a_2'] })
    expect(done.progress).toBeUndefined()
    expect(done.bytes).toBeGreaterThan(0)
    expect(readdirSync(done.path).sort()).toEqual(['analyst.tar.zst', 'backup.json', 'writer.tar.zst'])
    const m = await members(join(done.path, 'analyst.tar.zst'))
    expect([...m.keys()].sort()).toEqual([
      'BOT.md', 'manifest.json', 'memory', 'memory/MEMORY.md', 'shared', 'shared/input.txt',
      'workspace', 'workspace/notes.md', 'workspace/reports', 'workspace/reports/q3.csv',
    ])
    expect([...m.keys()].some((k) => k.includes('snapshot') || k.includes('old.txt'))).toBe(false)
    const manifest = JSON.parse(m.get('manifest.json')!) as BackupManifest
    expect(manifest).toMatchObject({ version: 1, agentId: 'a_1', slug: 'analyst', packages: ['jq'], tools: { pip: ['pandas==2.2.3'] }, image: { base: 'base', generation: 0 }, browser: false })
    expect(m.get('workspace/reports/q3.csv')).toBe('a,b\n1,analyst\n')
    // Progress: start (both bots), one per bot, the end (both bots).
    expect(events.map((e) => [e.info.status, e.info.progress?.done ?? null, e.agentIds])).toEqual([
      ['in_progress', 0, ['a_1', 'a_2']],
      ['in_progress', 1, ['a_1']],
      ['in_progress', 2, ['a_2']],
      ['complete', null, ['a_1', 'a_2']],
    ])
    expect(svc.lastBackupAt('a_1')).toBe(done.createdAt)
  })

  it('backs up only the bots asked for; 400 for unknown bots or none at all', async () => {
    const svc = service()
    svc.start({ trigger: 'manual', agentIds: ['a_2'] })
    await svc.idle()
    expect(svc.list()[0]!.agentIds).toEqual(['a_2'])
    expect(svc.lastBackupAt('a_1')).toBeUndefined()
    expect(() => svc.start({ trigger: 'manual', agentIds: ['nope'] })).toThrow(/No bot with id "nope"/)
    agents = []
    expect(() => svc.start({ trigger: 'manual' })).toThrow(expect.objectContaining({ statusCode: 400, reason: 'no_bots' }))
  })

  it('507 when the disk is too full, before anything is written', () => {
    free = 1024
    const svc = service()
    expect(() => svc.start({ trigger: 'manual' })).toThrow(expect.objectContaining({ statusCode: 507, reason: 'low_disk', message: expect.stringMatching(/Not enough free disk space for a backup.*Free some space, then try again\./) }))
    expect(existsSync(join(data, 'backups')) ? readdirSync(join(data, 'backups')) : []).toEqual([])
  })

  it('run() waits for the backup in progress (pre-reset / pre-upgrade)', async () => {
    const svc = service()
    const manual = svc.start({ trigger: 'manual' })
    clock = new Date(clock.getTime() + 1000)
    const pre = await svc.run({ trigger: 'pre_reset', agentIds: ['a_1'] })
    expect(svc.get(manual.id)!.status).toBe('complete')
    expect(pre).toMatchObject({ status: 'complete', trigger: 'pre_reset', agentIds: ['a_1'] })
    expect(svc.list().map((b) => b.id)).toEqual([pre.id, manual.id])
  })

  it('refuses to start when the backups folder can\'t be made, and marks a backup a crash left in progress as interrupted', () => {
    writeFileSync(join(data, 'backups-file'), 'not a folder')
    const failing = service({ root: () => join(data, 'backups-file') })
    expect(() => failing.start({ trigger: 'manual' })).toThrow(/EEXIST|ENOTDIR/)
    const root = join(data, 'backups')
    mkdirSync(join(root, '2026-11-01T09-00-00Z'), { recursive: true })
    writeFileSync(join(root, '2026-11-01T09-00-00Z', 'backup.json'), JSON.stringify({ version: 1, info: { id: '2026-11-01T09-00-00Z', createdAt: '2026-11-01T09:00:00.000Z', trigger: 'nightly', status: 'in_progress' }, bots: [] }))
    expect(service().list()[0]).toMatchObject({ id: '2026-11-01T09-00-00Z', status: 'failed', error: expect.stringMatching(/interrupted/) })
  })

  it('a failing archive write leaves a failed record and no partial archive', async () => {
    const svc = service({
      onProgress: (info) => {
        // After the first bot, the writer's archive name is taken by a folder, so its rename fails.
        if (info.progress?.done === 1) mkdirSync(join(info.path, 'writer.tar.zst', 'x'), { recursive: true })
      },
    })
    const b = svc.start({ trigger: 'manual' })
    await svc.idle()
    const got = svc.get(b.id)!
    expect(got.status).toBe('failed')
    expect(got.error).toMatch(/^The backup didn't finish: /)
    expect(readdirSync(got.path).filter((n) => n.endsWith('.tmp'))).toEqual([])
    expect(svc.lastBackupAt('a_1')).toBeUndefined()
    // A failed backup can't be restored.
    await expect(svc.restore(b.id)).rejects.toMatchObject({ statusCode: 409, reason: 'backup_incomplete' })
  })
})

describe('keep', () => {
  it('keeps each bot\'s newest 7: the 8th daily backup removes the oldest', async () => {
    const svc = service()
    const made: string[] = []
    for (let i = 0; i < 8; i++) {
      clock = day(i)
      made.push((await svc.run({ trigger: 'nightly' })).id)
    }
    const ids = svc.list().map((b) => b.id)
    expect(ids).toHaveLength(7)
    expect(ids).not.toContain(made[0])
    expect(existsSync(join(data, 'backups', made[0]!))).toBe(false)
    expect(ids[0]).toBe(made[7])
  })

  it('counts per bot: one bot\'s pre-reset backups never prune another bot\'s archives', async () => {
    const svc = service({ keep: () => 2 })
    clock = day(0)
    const nightly = await svc.run({ trigger: 'nightly' })
    for (let i = 1; i <= 3; i++) {
      clock = day(i)
      await svc.run({ trigger: 'pre_reset', agentIds: ['a_1'] })
    }
    // The nightly lost analyst (2 newer analyst archives) but still has writer.
    const n = svc.get(nightly.id)!
    expect(n.agentIds).toEqual(['a_2'])
    expect(readdirSync(n.path).sort()).toEqual(['backup.json', 'writer.tar.zst'])
    expect(svc.list().filter((b) => b.agentIds.includes('a_1'))).toHaveLength(2)
  })
})

describe('restore', () => {
  it('puts workspace, inputs, memory and BOT.md back with identical hashes, then runs the hooks', async () => {
    const calls: string[] = []
    const svc = service({
      restore: {
        before: async (a) => {
          calls.push(`stop ${a.slug}`)
        },
        after: async (a, manifest) => {
          calls.push(`after ${a.slug} ${manifest.packages.join(',')}`)
        },
        rebuildTools: async (a, manifest) => {
          calls.push(`tools ${a.slug}`)
          return { tools: manifest.packages.length ? 'started' : 'not_needed', toolResults: [] }
        },
        exclusive: async (id, fn) => {
          calls.push(`slot ${id}`)
          return fn()
        },
      },
    })
    const before = { analyst: hashes('analyst'), writer: hashes('writer') }
    const b = await svc.run({ trigger: 'manual' })
    // Lose and change things after the backup.
    rmSync(join(botDir('analyst'), 'workspace'), { recursive: true })
    writeFileSync(join(botDir('analyst'), 'memory', 'MEMORY.md'), 'changed')
    rmSync(join(botDir('analyst'), 'BOT.md'))
    writeFileSync(join(botDir('writer'), 'workspace', 'new.txt'), 'added later')
    rmSync(botDir('writer'), { recursive: true }) // a fresh machine: the folder is gone
    const res = await svc.restore(b.id)
    expect(res).toEqual({
      backupId: b.id,
      agents: [
        { agentId: 'a_1', files: 5, tools: 'started', toolResults: [] },
        { agentId: 'a_2', files: 5, tools: 'not_needed', toolResults: [] },
      ],
    })
    expect(hashes('analyst')).toEqual(before.analyst)
    expect(hashes('writer')).toEqual(before.writer)
    expect(calls).toEqual(['slot a_1', 'stop analyst', 'after analyst jq', 'tools analyst', 'slot a_2', 'stop writer', 'after writer ', 'tools writer'])
    // Nothing left over beside the bots.
    expect(readdirSync(join(data, 'bots')).sort()).toEqual(['analyst', 'writer'])
  })

  it('restores one bot only when asked', async () => {
    const svc = service()
    const b = await svc.run({ trigger: 'manual' })
    writeFileSync(join(botDir('analyst'), 'workspace', 'notes.md'), 'later A')
    writeFileSync(join(botDir('writer'), 'workspace', 'notes.md'), 'later W')
    await svc.restore(b.id, ['a_2'])
    expect(readFileSync(join(botDir('analyst'), 'workspace', 'notes.md'), 'utf8')).toBe('later A')
    expect(readFileSync(join(botDir('writer'), 'workspace', 'notes.md'), 'utf8')).toBe('# notes writer\n')
  })

  it('404 unknown id, 400 bot not in the backup, 409 runs_active, 409 for a failed backup', async () => {
    const svc = service()
    await expect(svc.restore('2026-01-01T00-00-00Z')).rejects.toMatchObject({ statusCode: 404, reason: 'not_found' })
    await expect(svc.restore('../../etc')).rejects.toMatchObject({ statusCode: 404 })
    const b = await svc.run({ trigger: 'pre_reset', agentIds: ['a_1'] })
    await expect(svc.restore(b.id, ['a_2'])).rejects.toMatchObject({ statusCode: 400 })
    active = 1
    await expect(svc.restore(b.id)).rejects.toMatchObject({ statusCode: 409, reason: 'runs_active', message: 'Scripts are running. Wait for them to finish, then restore.' })
    active = 0
    const rec = JSON.parse(readFileSync(join(b.path, 'backup.json'), 'utf8'))
    rec.info.status = 'failed'
    writeFileSync(join(b.path, 'backup.json'), JSON.stringify(rec))
    const fresh = service()
    await expect(fresh.restore(b.id)).rejects.toMatchObject({ statusCode: 409, reason: 'backup_incomplete' })
  })

  it('refuses a damaged archive and leaves the bot\'s files alone', async () => {
    const svc = service()
    const b = await svc.run({ trigger: 'manual', agentIds: ['a_1'] })
    writeFileSync(join(b.path, 'analyst.tar.zst'), 'garbage')
    writeFileSync(join(botDir('analyst'), 'workspace', 'notes.md'), 'current')
    await expect(svc.restore(b.id)).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/damaged/) })
    expect(readFileSync(join(botDir('analyst'), 'workspace', 'notes.md'), 'utf8')).toBe('current')
  })

  it('409 backup_in_progress while a backup runs', async () => {
    const svc = service()
    const done = await svc.run({ trigger: 'manual' })
    svc.start({ trigger: 'manual' })
    await expect(svc.restore(done.id)).rejects.toMatchObject({ statusCode: 409, reason: 'backup_in_progress' })
    await svc.idle()
  })
})

describe('nightly', () => {
  it('fires at backups.time local once per day (fake clock), and never when disabled', async () => {
    clock = new Date(2026, 10, 6, 2, 0)
    const svc = service()
    const on = { enabled: true, time: '03:00' }
    clock = new Date(2026, 10, 6, 2, 59)
    expect(svc.nightlyTick(on)).toBeNull()
    clock = new Date(2026, 10, 6, 3, 0)
    const first = svc.nightlyTick(on)
    expect(first).toMatchObject({ trigger: 'nightly', status: 'in_progress', agentIds: ['a_1', 'a_2'] })
    await svc.idle()
    clock = new Date(2026, 10, 6, 3, 1)
    expect(svc.nightlyTick(on)).toBeNull()
    clock = new Date(2026, 10, 6, 23, 0)
    expect(svc.nightlyTick(on)).toBeNull()
    // Disabled: the next night passes without a backup.
    clock = new Date(2026, 10, 7, 3, 0)
    expect(svc.nightlyTick({ ...on, enabled: false })).toBeNull()
    // Turned back on after 3:00: not until the next night.
    clock = new Date(2026, 10, 7, 9, 0)
    expect(svc.nightlyTick(on)).toBeNull()
    clock = new Date(2026, 10, 8, 3, 0, 30)
    expect(svc.nightlyTick(on)).toMatchObject({ trigger: 'nightly' })
    await svc.idle()
    expect(svc.list().filter((b) => b.trigger === 'nightly')).toHaveLength(2)
  })

  it('a computer asleep at 3:00 backs up at the first check after waking; a busy tick retries', async () => {
    clock = new Date(2026, 10, 6, 22, 0)
    const svc = service()
    const on = { enabled: true, time: '03:00' }
    svc.start({ trigger: 'manual' })
    clock = new Date(2026, 10, 7, 7, 30) // woke up
    expect(svc.nightlyTick(on)).toBeNull() // the manual backup is still running
    await svc.idle()
    expect(svc.nightlyTick(on)).toMatchObject({ trigger: 'nightly' })
    await svc.idle()
  })

  it('does not run on a server that started after today\'s time', () => {
    clock = new Date(2026, 10, 6, 10, 0)
    const svc = service()
    expect(svc.nightlyTick({ enabled: true, time: '03:00' })).toBeNull()
  })
})

describe('export', () => {
  it('zips one bot\'s personal data and tool manifest, and nothing of the other bot', async () => {
    const svc = service()
    const chunks: Buffer[] = []
    for await (const c of svc.exportAgent(agents[0]!)) chunks.push(c as Buffer)
    const zip = readZip(Buffer.concat(chunks))
    expect([...zip.keys()].sort()).toEqual(['analyst/BOT.md', 'analyst/manifest.json', 'analyst/memory/MEMORY.md', 'analyst/shared/input.txt', 'analyst/workspace/notes.md', 'analyst/workspace/reports/q3.csv'])
    expect(JSON.parse(zip.get('analyst/manifest.json')!.toString())).toMatchObject({ agentId: 'a_1', packages: ['jq'] })
  })

  it('zips every bot, group shared folders and an index', async () => {
    mkdirSync(join(data, 'groups', 'team', 'shared'), { recursive: true })
    writeFileSync(join(data, 'groups', 'team', 'shared', 'plan.md'), 'plan')
    const svc = service({ groupDirs: () => [{ slug: 'team', name: 'Team', dir: join(data, 'groups', 'team', 'shared') }] })
    const chunks: Buffer[] = []
    for await (const c of svc.exportAll()) chunks.push(c as Buffer)
    const zip = readZip(Buffer.concat(chunks))
    const names = [...zip.keys()]
    expect(names).toContain('bots/analyst/workspace/notes.md')
    expect(names).toContain('bots/writer/BOT.md')
    expect(names).toContain('groups/team/shared/plan.md')
    expect(names.some((n) => n.includes('snapshots') || n.includes('backups'))).toBe(false)
    expect(JSON.parse(zip.get('agentcontrol-export.json')!.toString())).toMatchObject({ version: 1, bots: [{ agentId: 'a_1' }, { agentId: 'a_2' }], groups: [{ slug: 'team' }] })
  })
})
