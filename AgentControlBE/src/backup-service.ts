/**
 * BE-P2-18: BackupService (M3 plan §3, decisions 5–7).
 *
 * - When: nightly at settings.vm.backups.time local (when enabled), before Reset VM, before a
 *   machine grow or a base image upgrade, and on Back up now (POST /api/vm/backups).
 * - What: per bot one `<slug>.tar.zst` with workspace/, shared/ (inputs), memory/, BOT.md and
 *   manifest.json (the tool manifest: apt packages, pip/npm/opt-bin, image base). Tool volumes
 *   are never included (decision 6: rebuilt from the manifest); snapshots are never included.
 *   No at-rest encryption (decision 7): the archives rely on the OS disk encryption.
 * - Where: `<root>/<id>/` with `backup.json` beside the archives. The root is
 *   `%LOCALAPPDATA%\AgentControl\backups` on Windows and `<data>/backups` elsewhere
 *   (backupsRootFor).
 * - Keep: each bot keeps its newest `backups.keep` (default 7) archives; older ones are removed
 *   after a successful backup, and a backup folder with no archives left goes too. At most
 *   `keep` failed records are kept.
 * - One backup or restore at a time: a second Back up now answers 409 backup_in_progress; the
 *   pre-reset / pre-upgrade backups wait for the one in progress; the nightly run skips a tick.
 * - Restore (POST /api/vm/backups/:id/restore with confirm): checks each archive's sha256,
 *   extracts it beside the bot's folder, then swaps the zones in (the old ones are removed only
 *   after every zone is in place; any failure puts the old ones back). The app's hooks stop the
 *   bot's computer first, keep its runs out meanwhile, and afterwards mark its kept snapshots
 *   'machine_restored' and rebuild its tools from the manifest.
 *
 * Only host paths are used (LocalFs). With no host path for the bots' files (WslFs, not wired
 * yet) create/restore/export answer 501.
 */
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, win32 } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { dataEntry, extractTar, fileEntry, tarStream, walkEntries, zipStream, zstdCompress, zstdDecompress, type ArchiveEntry } from './backup-archive.js'
import { fail, failWithReason } from './http.js'
import { RUN_BLOCK_FREE_MB, type Agent, type BackupInfo, type BackupRestoreAgent, type BackupRestoreResult, type BackupTrigger, type ToolManifest } from './shared/types.js'

export const BACKUP_FILE = 'backup.json'
export const BACKUP_ZONES = ['workspace', 'shared', 'memory'] as const
export const BACKUP_BOT_MD = 'BOT.md'
export const BACKUP_MANIFEST = 'manifest.json'
const ID_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z(-\d{1,3})?$/
const SLUG_RE = /^[a-z0-9-]{1,40}$/
const MB = 1024 * 1024
const FLOOR_BYTES = RUN_BLOCK_FREE_MB * MB

export const BACKUP_IN_PROGRESS_TEXT = 'A backup or restore is already running. Try again when it finishes.'
export const BACKUP_RUNS_ACTIVE_TEXT = 'Scripts are running. Wait for them to finish, then restore.'
export const BACKUP_NO_HOST_PATH_TEXT = "Backups aren't available for this storage yet."
export const BACKUP_NOT_FOUND_TEXT = (id: string) => `No backup with id "${id.slice(0, 80)}".`

/** The tool manifest inside each archive (manifest.json). */
export interface BackupManifest {
  version: 1
  agentId: string
  slug: string
  name: string
  createdAt: string
  /** apt packages (vm.packages): the bot's image layer is rebuilt from these on restore. */
  packages: string[]
  /** pip / npm / opt-bin as last read from the bot's tools volumes (listed only; not reinstalled). */
  tools?: ToolManifest
  image: { base: 'base' | 'browser'; generation: number }
  browser: boolean
}

/** What backup.json holds per bot. */
export interface BackupBotRecord {
  agentId: string
  slug: string
  name: string
  file: string
  bytes: number
  sha256: string
  files: number
}
interface BackupRecord {
  version: 1
  info: Omit<BackupInfo, 'path' | 'bytes' | 'agentIds'>
  bots: BackupBotRecord[]
}

/** Where backups live: `%LOCALAPPDATA%\AgentControl\backups` on Windows, `<data>/backups` elsewhere. */
export function backupsRootFor(platform: NodeJS.Platform, dataDir: string, env: NodeJS.ProcessEnv = process.env, home: () => string = homedir): string {
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA?.trim() || win32.join(home(), 'AppData', 'Local')
    return win32.join(base, 'AgentControl', 'backups')
  }
  return join(dataDir, 'backups')
}

/** File-name safe UTC stamp to the second: 2026-11-06T09-00-00Z. */
export function backupStamp(at: Date): string {
  return at.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-')
}

/** The most recent local "HH:MM" instant at or before `now`. */
export function lastScheduled(now: Date, time: string): Date {
  const [h, m] = time.split(':').map(Number) as [number, number]
  const s = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0)
  if (s.getTime() > now.getTime()) s.setDate(s.getDate() - 1)
  return s
}

export interface RestoreHooks {
  /** Before any file changes: stop the bot's computer (its folders are bind-mounted). */
  before?(agent: Agent): Promise<void>
  /** Still in the bot's run slot, after the files are in place: snapshots → machine_restored, the manifest's packages saved. */
  after?(agent: Agent, manifest: BackupManifest): Promise<void>
  /** Out of the run slot (a tool build takes the slot itself): rebuild the tools from the manifest. */
  rebuildTools?(agent: Agent, manifest: BackupManifest): Promise<Pick<BackupRestoreAgent, 'tools' | 'toolsMessage'>>
  /** Run the restore of one bot in its run slot (ContainerRunner.exclusive), so no run starts meanwhile. */
  exclusive?<T>(agentId: string, fn: () => Promise<T>): Promise<T>
}

export interface BackupServiceDeps {
  /** The backups folder (backupsRootFor in the app; a temp folder in tests). */
  root: () => string
  agents: () => readonly Agent[]
  /** Host path of the bot's folder (bots/<slug>), or null when there is none (WslFs). */
  botDir: (agent: Agent) => string | null
  /** Group shared folders for the full export (host paths). */
  groupDirs?: () => { slug: string; name: string; dir: string }[]
  keep: () => number
  /** Free bytes where backups are written; null: unknown (the check is skipped). */
  freeBytes?: (path: string) => number | null
  /** Script runs queued/running for a bot (restore: 409 runs_active). */
  activeRuns?: (agentId: string) => number
  /** Backup progress and the end (vm.updated per bot). */
  onProgress?: (info: BackupInfo, agentIds: readonly string[]) => void
  restore?: RestoreHooks
  now?: () => Date
  log?: (msg: string) => void
}

export interface CreateOptions {
  trigger: BackupTrigger
  agentIds?: readonly string[]
}

export interface BackupService {
  /** Newest first. */
  list(): BackupInfo[]
  get(id: string): BackupInfo | null
  /**
   * Start a backup and answer at once with status 'in_progress' (POST /api/vm/backups → 202).
   * 400 for unknown bots or none at all, 409 backup_in_progress, 507 low disk, 501 no host path.
   */
  start(opts: CreateOptions): BackupInfo
  /** A backup that waits for one in progress first and resolves when it ends (pre-reset / pre-upgrade). */
  run(opts: CreateOptions): Promise<BackupInfo>
  /** 400/404/409 as in the plan; resolves when every bot is restored. */
  restore(id: string, agentIds?: readonly string[]): Promise<BackupRestoreResult>
  /** ISO time of the bot's newest complete backup (VmInfo.storage.lastBackupAt). */
  lastBackupAt(agentId: string): string | undefined
  /** True while a backup or restore runs. */
  busy(): boolean
  /** Resolves when nothing is running (tests). */
  idle(): Promise<void>
  /** GET /api/agents/:id/export: that bot's personal data + tool manifest. */
  exportAgent(agent: Agent): Readable
  /** GET /api/vm/export: every bot, plus group shared folders and an index. */
  exportAll(): Readable
  /** Nightly check (fake clock in tests): starts the nightly backup when its time has come. */
  nightlyTick(settings: { enabled: boolean; time: string }): BackupInfo | null
  /** Check every `ms` (default 60 s); returns stop. */
  startNightly(settings: () => { enabled: boolean; time: string }, ms?: number): () => void
}

export function manifestOf(agent: Agent, now: Date): BackupManifest {
  return {
    version: 1,
    agentId: agent.id,
    slug: agent.slug,
    name: agent.name,
    createdAt: now.toISOString(),
    packages: [...agent.vm.packages],
    ...(agent.vm.tools ? { tools: agent.vm.tools } : {}),
    image: { base: agent.vm.image.base, generation: agent.vm.image.generation },
    browser: agent.vm.permissions.browser,
  }
}

/** The members of one bot's archive (and export): zones, BOT.md, then the manifest. */
export function botEntries(dir: string, manifest: BackupManifest, prefix = ''): ArchiveEntry[] {
  const p = (n: string) => (prefix ? `${prefix}/${n}` : n)
  const out: ArchiveEntry[] = []
  for (const z of BACKUP_ZONES) out.push(...walkEntries(join(dir, z), p(z)))
  const md = fileEntry(join(dir, BACKUP_BOT_MD), p(BACKUP_BOT_MD))
  if (md) out.push(md)
  out.push(dataEntry(p(BACKUP_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, Date.parse(manifest.createdAt)))
  return out
}

function folderBytes(dir: string): number {
  let total = 0
  const visit = (d: string) => {
    let names: string[]
    try {
      names = readdirSync(d)
    } catch {
      return
    }
    for (const n of names) {
      try {
        const st = lstatSync(join(d, n))
        if (st.isDirectory()) visit(join(d, n))
        else if (st.isFile()) total += st.size
      } catch {
        // gone meanwhile
      }
    }
  }
  visit(dir)
  return total
}

const readJson = <T>(file: string): T | null => {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, file)
}

async function sha256File(file: string): Promise<string> {
  const h = createHash('sha256')
  for await (const c of createReadStream(file) as AsyncIterable<Buffer>) h.update(c)
  return h.digest('hex')
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300)

export function createBackupService(deps: BackupServiceDeps): BackupService {
  const now = deps.now ?? (() => new Date())
  const log = deps.log ?? (() => {})
  let running: Promise<unknown> | null = null
  let current: BackupInfo | null = null
  let lastNightlyCheck = now().getTime()
  let cache: BackupInfo[] | null = null
  let swept = false

  const root = () => deps.root()
  const dirOf = (id: string) => join(root(), id)

  function readRecord(id: string): BackupRecord | null {
    if (!ID_RE.test(id)) return null
    const r = readJson<BackupRecord>(join(dirOf(id), BACKUP_FILE))
    return r && r.version === 1 && r.info?.id === id && Array.isArray(r.bots) ? r : null
  }

  function infoOf(r: BackupRecord): BackupInfo {
    return {
      ...r.info,
      agentIds: r.bots.map((b) => b.agentId),
      bytes: r.bots.reduce((n, b) => n + b.bytes, 0),
      path: dirOf(r.info.id),
    }
  }

  /** A record a crash left 'in_progress' (no backup running now) becomes 'failed'. */
  function sweepInterrupted(): void {
    if (swept) return
    swept = true
    for (const id of ids()) {
      if (current?.id === id) continue
      const r = readRecord(id)
      if (r?.info.status !== 'in_progress') continue
      r.info = { ...r.info, status: 'failed', error: 'The backup was interrupted (AgentControl stopped while it ran).', finishedAt: now().toISOString() }
      delete r.info.progress
      try {
        writeJsonAtomic(join(dirOf(id), BACKUP_FILE), r)
      } catch (err) {
        log(`backups: couldn't mark ${id} as interrupted: ${errText(err)}`)
      }
    }
  }

  function ids(): string[] {
    try {
      return readdirSync(root()).filter((n) => ID_RE.test(n))
    } catch {
      return []
    }
  }

  function list(): BackupInfo[] {
    sweepInterrupted()
    if (!cache) {
      cache = ids()
        .map(readRecord)
        .filter((r): r is BackupRecord => r !== null)
        .map(infoOf)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : -1))
    }
    const out = cache.map((b) => (current && b.id === current.id ? { ...current } : structuredClone(b)))
    return out
  }

  const invalidate = () => {
    cache = null
  }

  function lastBackupAt(agentId: string): string | undefined {
    return list().find((b) => b.status === 'complete' && b.agentIds.includes(agentId))?.createdAt
  }

  function scope(agentIds: readonly string[] | undefined): Agent[] {
    const all = deps.agents()
    if (agentIds === undefined || agentIds.length === 0) return [...all]
    const out: Agent[] = []
    for (const id of new Set(agentIds)) {
      const a = all.find((x) => x.id === id)
      if (!a) fail(400, `No bot with id "${String(id).slice(0, 80)}".`)
      out.push(a)
    }
    return out
  }

  function newId(at: Date): string {
    const base = backupStamp(at)
    let id = base
    for (let n = 2; existsSync(dirOf(id)); n++) id = `${base}-${n}`
    return id
  }

  function prepare(opts: CreateOptions): { info: BackupInfo; bots: { agent: Agent; dir: string }[] } {
    const agents = scope(opts.agentIds)
    if (agents.length === 0) failWithReason(400, 'no_bots', 'There are no bots to back up yet.')
    const bots = agents.map((agent) => {
      if (!SLUG_RE.test(agent.slug)) fail(400, `${agent.name} has no valid folder name, so it can't be backed up.`)
      const dir = deps.botDir(agent)
      if (dir === null) fail(501, BACKUP_NO_HOST_PATH_TEXT)
      return { agent, dir }
    })
    const backupsRoot = root()
    mkdirSync(backupsRoot, { recursive: true, mode: 0o700 })
    const need = bots.reduce((n, b) => n + folderBytes(b.dir), 0) + FLOOR_BYTES
    const free = deps.freeBytes?.(backupsRoot) ?? null
    if (free !== null && free < need) {
      fail(507, `Not enough free disk space for a backup: it needs about ${Math.ceil(need / 1024 ** 3)} GB free and ${Math.floor(free / 1024 ** 3)} GB is free. Free some space, then try again.`)
    }
    const at = now()
    const id = newId(at)
    const info: BackupInfo = {
      id,
      createdAt: at.toISOString(),
      trigger: opts.trigger,
      agentIds: bots.map((b) => b.agent.id),
      bytes: 0,
      path: dirOf(id),
      status: 'in_progress',
      progress: { done: 0, total: bots.length },
    }
    mkdirSync(info.path, { mode: 0o700 })
    writeJsonAtomic(join(info.path, BACKUP_FILE), { version: 1, info: { id, createdAt: info.createdAt, trigger: info.trigger, status: 'in_progress', progress: info.progress }, bots: [] } satisfies BackupRecord)
    invalidate()
    return { info, bots }
  }

  const publish = (info: BackupInfo, agentIds: readonly string[]) => {
    try {
      deps.onProgress?.({ ...info, ...(info.progress ? { progress: { ...info.progress } } : {}) }, agentIds)
    } catch (err) {
      log(`backups: progress event failed: ${errText(err)}`)
    }
  }

  async function execute(info: BackupInfo, bots: { agent: Agent; dir: string }[]): Promise<BackupInfo> {
    current = info
    const records: BackupBotRecord[] = []
    const save = () => {
      const { path: _p, bytes: _b, agentIds: _a, ...rest } = info
      writeJsonAtomic(join(info.path, BACKUP_FILE), { version: 1, info: rest, bots: records } satisfies BackupRecord)
    }
    publish(info, info.agentIds)
    try {
      for (const { agent, dir } of bots) {
        const file = `${agent.slug}.tar.zst`
        const target = join(info.path, file)
        const tmp = `${target}.tmp`
        const entries = botEntries(dir, manifestOf(agent, now()))
        await pipeline(Readable.from(tarStream(entries)), zstdCompress(), createWriteStream(tmp, { mode: 0o600 }))
        renameSync(tmp, target)
        records.push({
          agentId: agent.id,
          slug: agent.slug,
          name: agent.name,
          file,
          bytes: statSync(target).size,
          sha256: await sha256File(target),
          files: entries.filter((e) => e.kind === 'file').length - 1,
        })
        info.bytes = records.reduce((n, r) => n + r.bytes, 0)
        info.progress = { done: records.length, total: bots.length }
        save()
        invalidate()
        publish(info, [agent.id])
      }
      info.status = 'complete'
      delete info.progress
      info.finishedAt = now().toISOString()
      save()
      log(`backups: ${info.id} (${info.trigger}) complete: ${records.length} bot(s), ${info.bytes} bytes`)
    } catch (err) {
      info.status = 'failed'
      info.error = `The backup didn't finish: ${errText(err)}`
      delete info.progress
      info.finishedAt = now().toISOString()
      try {
        for (const n of readdirSync(info.path)) if (n.endsWith('.tmp')) rmSync(join(info.path, n), { force: true })
      } catch {
        // the folder itself is gone
      }
      try {
        save()
      } catch (e) {
        log(`backups: couldn't record the failure of ${info.id}: ${errText(e)}`)
      }
      log(`backups: ${info.id} (${info.trigger}) failed: ${errText(err)}`)
    } finally {
      current = null
      invalidate()
    }
    if (info.status === 'complete') prune(info.agentIds)
    invalidate()
    const done = list().find((b) => b.id === info.id) ?? info
    publish(done, done.status === 'complete' ? done.agentIds : bots.map((b) => b.agent.id))
    return done
  }

  /** Keep each bot's newest `keep` archives (complete backups); keep at most `keep` failed records. */
  function prune(agentIds: readonly string[]): void {
    const keep = Math.max(1, deps.keep())
    const all = list()
    for (const agentId of agentIds) {
      const withBot = all.filter((b) => b.status === 'complete' && b.agentIds.includes(agentId))
      for (const old of withBot.slice(keep)) {
        const r = readRecord(old.id)
        if (!r) continue
        const bot = r.bots.find((b) => b.agentId === agentId)
        if (!bot) continue
        try {
          rmSync(join(dirOf(old.id), bot.file), { force: true })
          r.bots = r.bots.filter((b) => b.agentId !== agentId)
          if (r.bots.length === 0) rmSync(dirOf(old.id), { recursive: true, force: true })
          else writeJsonAtomic(join(dirOf(old.id), BACKUP_FILE), r)
          log(`backups: pruned ${bot.slug} from ${old.id} (keep ${keep})`)
        } catch (err) {
          log(`backups: couldn't prune ${old.id}: ${errText(err)}`)
        }
        old.agentIds = old.agentIds.filter((a) => a !== agentId)
      }
    }
    for (const f of all.filter((b) => b.status === 'failed').slice(keep)) {
      try {
        rmSync(dirOf(f.id), { recursive: true, force: true })
      } catch (err) {
        log(`backups: couldn't remove failed ${f.id}: ${errText(err)}`)
      }
    }
    invalidate()
  }

  function track<T>(p: Promise<T>): Promise<T> {
    const t = p.finally(() => {
      if (running === t) running = null
    })
    running = t
    return t
  }

  function start(opts: CreateOptions): BackupInfo {
    if (running) failWithReason(409, 'backup_in_progress', BACKUP_IN_PROGRESS_TEXT)
    const { info, bots } = prepare(opts)
    const first = structuredClone(info)
    void track(execute(info, bots))
    return first
  }

  async function run(opts: CreateOptions): Promise<BackupInfo> {
    while (running) await running.catch(() => {})
    const { info, bots } = prepare(opts)
    return track(execute(info, bots))
  }

  async function restoreOne(r: BackupRecord, bot: BackupBotRecord, agent: Agent): Promise<{ files: number; manifest: BackupManifest }> {
    const archive = join(dirOf(r.info.id), bot.file)
    if (!existsSync(archive)) fail(409, `${agent.name}'s archive in this backup is missing, so nothing was restored.`)
    if ((await sha256File(archive)) !== bot.sha256) fail(409, `${agent.name}'s archive in this backup is damaged (its checksum doesn't match), so nothing was restored.`)
    const dir = deps.botDir(agent)
    if (dir === null) fail(501, BACKUP_NO_HOST_PATH_TEXT)
    await deps.restore?.before?.(agent)
    const parent = join(dir, '..')
    mkdirSync(parent, { recursive: true })
    const tag = randomBytes(4).toString('hex')
    const staging = join(parent, `.restore-${agent.slug}-${tag}`)
    const old = join(parent, `.pre-restore-${agent.slug}-${tag}`)
    const names = [...BACKUP_ZONES, BACKUP_BOT_MD] as string[]
    const allowed = new Set([...names, BACKUP_MANIFEST])
    let files = 0
    try {
      const src = createReadStream(archive).pipe(zstdDecompress())
      files = (await extractTar(src as AsyncIterable<Buffer>, staging, (top) => allowed.has(top))).files
      const manifest = readJson<BackupManifest>(join(staging, BACKUP_MANIFEST))
      if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.packages)) fail(409, `${agent.name}'s archive in this backup has no readable tool manifest, so nothing was restored.`)
      files -= 1
      mkdirSync(dir, { recursive: true })
      mkdirSync(old, { mode: 0o700 })
      for (const z of BACKUP_ZONES) if (!existsSync(join(staging, z))) mkdirSync(join(staging, z))
      const moved: string[] = []
      const placed: string[] = []
      try {
        for (const n of names) {
          if (existsSync(join(dir, n)) || isLink(join(dir, n))) {
            renameSync(join(dir, n), join(old, n))
            moved.push(n)
          }
          if (existsSync(join(staging, n))) {
            renameSync(join(staging, n), join(dir, n))
            placed.push(n)
          }
        }
      } catch (err) {
        // Put everything back as it was.
        for (const n of placed) {
          try { renameSync(join(dir, n), join(staging, n)) } catch { /* keep going */ }
        }
        for (const n of moved) {
          try { renameSync(join(old, n), join(dir, n)) } catch (e) { log(`backups: restore rollback of ${agent.slug}/${n} failed: ${errText(e)}`) }
        }
        throw err
      }
      await deps.restore?.after?.(agent, manifest)
      return { files, manifest }
    } finally {
      rmSync(staging, { recursive: true, force: true })
      rmSync(old, { recursive: true, force: true })
    }
  }

  async function restore(id: string, agentIds?: readonly string[]): Promise<BackupRestoreResult> {
    const r = readRecord(id)
    if (!r) failWithReason(404, 'not_found', BACKUP_NOT_FOUND_TEXT(id))
    if (r.info.status !== 'complete') failWithReason(409, 'backup_incomplete', r.info.status === 'in_progress' ? 'This backup is still running. Restore it when it finishes.' : "This backup didn't finish, so it can't be restored. Pick another one.")
    if (running) failWithReason(409, 'backup_in_progress', BACKUP_IN_PROGRESS_TEXT)
    const all = deps.agents()
    const wanted = agentIds && agentIds.length ? [...new Set(agentIds)] : r.bots.map((b) => b.agentId)
    const pairs: { bot: BackupBotRecord; agent: Agent }[] = []
    for (const agentId of wanted) {
      const bot = r.bots.find((b) => b.agentId === agentId)
      if (!bot) fail(400, `This backup has no files for the bot "${String(agentId).slice(0, 80)}".`)
      const agent = all.find((a) => a.id === agentId)
      if (!agent) fail(400, `${bot.name} no longer exists here, so its files can't be restored.`)
      pairs.push({ bot, agent })
    }
    if (pairs.length === 0) fail(400, 'This backup has no bots to restore.')
    if (pairs.some((p) => (deps.activeRuns?.(p.agent.id) ?? 0) > 0)) failWithReason(409, 'runs_active', BACKUP_RUNS_ACTIVE_TEXT)
    return track((async () => {
      const agents: BackupRestoreAgent[] = []
      for (const { bot, agent } of pairs) {
        const job = () => restoreOne(r, bot, agent)
        const done = await (deps.restore?.exclusive ? deps.restore.exclusive(agent.id, job) : job())
        log(`backups: restored ${agent.slug} from ${id}`)
        let tools: Pick<BackupRestoreAgent, 'tools' | 'toolsMessage'> = { tools: 'not_needed' }
        if (deps.restore?.rebuildTools) {
          try {
            tools = await deps.restore.rebuildTools(agent, done.manifest)
          } catch (err) {
            tools = { tools: 'failed', toolsMessage: errText(err) }
          }
        } else if (done.manifest.packages.length) {
          tools = { tools: 'failed', toolsMessage: "The bot's tools weren't rebuilt." }
        }
        agents.push({ agentId: agent.id, files: done.files, ...tools })
      }
      return { backupId: id, agents }
    })())
  }

  function exportAgent(agent: Agent): Readable {
    const dir = deps.botDir(agent)
    if (dir === null) fail(501, BACKUP_NO_HOST_PATH_TEXT)
    return Readable.from(zipStream(botEntries(dir, manifestOf(agent, now()), agent.slug)))
  }

  function exportAll(): Readable {
    const at = now()
    const entries: ArchiveEntry[] = []
    const bots: { agentId: string; slug: string; name: string }[] = []
    for (const agent of deps.agents()) {
      if (!SLUG_RE.test(agent.slug)) continue
      const dir = deps.botDir(agent)
      if (dir === null) fail(501, BACKUP_NO_HOST_PATH_TEXT)
      entries.push(...botEntries(dir, manifestOf(agent, at), `bots/${agent.slug}`))
      bots.push({ agentId: agent.id, slug: agent.slug, name: agent.name })
    }
    const groups: { slug: string; name: string }[] = []
    for (const g of deps.groupDirs?.() ?? []) {
      if (!SLUG_RE.test(g.slug)) continue
      entries.push(...walkEntries(g.dir, `groups/${g.slug}/shared`))
      groups.push({ slug: g.slug, name: g.name })
    }
    entries.unshift(dataEntry('agentcontrol-export.json', `${JSON.stringify({ version: 1, createdAt: at.toISOString(), bots, groups }, null, 2)}\n`, at.getTime()))
    return Readable.from(zipStream(entries))
  }

  function nightlyTick(settings: { enabled: boolean; time: string }): BackupInfo | null {
    const t = now()
    if (!settings.enabled) {
      lastNightlyCheck = t.getTime()
      return null
    }
    const due = lastScheduled(t, settings.time).getTime()
    if (lastNightlyCheck >= due) return null
    if (running) return null // try again next tick
    lastNightlyCheck = t.getTime()
    if (deps.agents().length === 0) return null
    try {
      return start({ trigger: 'nightly' })
    } catch (err) {
      log(`backups: the nightly backup didn't start: ${errText(err)}`)
      return null
    }
  }

  function startNightly(settings: () => { enabled: boolean; time: string }, ms = 60_000): () => void {
    const timer = setInterval(() => {
      try {
        nightlyTick(settings())
      } catch (err) {
        log(`backups: nightly check failed: ${errText(err)}`)
      }
    }, ms)
    timer.unref?.()
    return () => clearInterval(timer)
  }

  return {
    list,
    get: (id) => list().find((b) => b.id === id) ?? null,
    start,
    run,
    restore,
    lastBackupAt,
    busy: () => running !== null,
    idle: async () => {
      while (running) await running.catch(() => {})
    },
    exportAgent,
    exportAll,
    nightlyTick,
    startNightly,
  }
}

function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}
