/**
 * BE-P2-18 follow-up: what a restore does about the bot's tools, per type, from the backup's
 * manifest. Tool volumes are never in a backup (M3 default 6), so:
 * - apt: the manifest's packages become vm.packages and a Rebuild tool_build makes the layer
 *   (the same path as the user's Rebuild).
 * - pip / npm: an install script run in the bot's DM, the same way a bot installs them itself
 *   (`pip install --user`, `npm install -g` into ~/.local), through the PermissionGate for internet
 *   (an internet card under Ask, refused under Never). Runs queue behind the tool build (BE-P2-22).
 * - opt: /opt/bot/bin programs have no source to reinstall from; they're reported by name.
 * A type the bot already has in full (vm.tools still lists it: its volumes are still there) is not_needed.
 */
import type { BackupManifest } from './backup-service.js'
import type { Agent, BackupRestoreAgent, BackupRestoreTool, ScriptRun } from './shared/types.js'
import { APT_PACKAGE } from './vm-images.js'

/** `name==version` as pip freeze writes it (extras allowed); `-e` and `name @ url` lines are left out. */
export const PIP_PIN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})(?:\[[A-Za-z0-9._,-]{1,100}\])?==[A-Za-z0-9._+!-]{1,64}$/
/** `name@version` or `@scope/name@version` as refreshTools stores npm globals. */
export const NPM_PIN = /^(?:@[a-z0-9][a-z0-9._~-]{0,99}\/)?[a-z0-9][a-z0-9._~-]{0,213}@[0-9A-Za-z.+-]{1,64}$/
export const MAX_RESTORE_PINS = 200
export const PIP_HOSTS = ['pypi.org', 'files.pythonhosted.org']
export const NPM_HOSTS = ['registry.npmjs.org']
export const PIP_WHY = "Reinstall the bot's Python packages from the backup"
export const NPM_WHY = "Reinstall the bot's npm packages from the backup"

export const pipInstallArgv = (pins: readonly string[]): string[] => ['python3', '-m', 'pip', 'install', '--user', '--disable-pip-version-check', '--no-input', ...pins]
export const npmInstallArgv = (pins: readonly string[]): string[] => ['npm', 'install', '-g', '--no-fund', '--no-audit', ...pins]

/** A manifest's apt packages, cleaned (strings only, unique, sorted). */
export function restoredPackages(raw: unknown): string[] {
  return Array.isArray(raw) ? [...new Set(raw.filter((p): p is string => typeof p === 'string' && APT_PACKAGE.test(p)))].sort() : []
}
export const samePackages = (a: readonly string[], b: readonly string[]): boolean => {
  const x = [...a].sort()
  const y = [...b].sort()
  return x.length === y.length && x.every((p, i) => p === y[i])
}

const strings = (raw: unknown): string[] => (Array.isArray(raw) ? [...new Set(raw.filter((x): x is string => typeof x === 'string'))] : [])
const list = (xs: readonly string[], max = 5) => (xs.length > max ? `${xs.slice(0, max).join(', ')} and ${xs.length - max} more` : xs.join(', '))
const ENDED_BAD: readonly ScriptRun['status'][] = ['failed', 'denied', 'stopped', 'timed_out']

export interface RestoreToolsDeps {
  /** The bot as stored now (after the restore saved its packages). */
  current(agentId: string): Agent | undefined
  /** The Rebuild tool_build (startRebuildRun). */
  startRebuild(agent: Agent): Promise<ScriptRun>
  /** A script run in the bot's DM with internet on (RunService.start through the gate). */
  startInstall(agent: Agent, argv: string[], why: string, hosts: string[]): Promise<ScriptRun>
}

/** `before`: the bot before the restore; `manifest`: the backup's. */
export async function restoreTools(before: Agent, manifest: BackupManifest, deps: RestoreToolsDeps): Promise<Pick<BackupRestoreAgent, 'tools' | 'toolsMessage' | 'toolResults'>> {
  const results: BackupRestoreTool[] = []
  const fresh = () => deps.current(before.id) ?? before
  const errOf = (err: unknown) => (err instanceof Error ? err.message : String(err))

  // apt: the image layer.
  const packages = restoredPackages(manifest.packages)
  {
    const a = fresh()
    const r: BackupRestoreTool = { kind: 'apt', status: 'not_needed', items: packages }
    if (!samePackages(packages, a.vm.packages)) Object.assign(r, { status: 'failed', message: "Couldn't save the bot's package list from the backup." })
    else if (packages.length > 0 && !(a.vm.image.generation > 0 && samePackages(packages, before.vm.packages))) {
      try {
        const run = await deps.startRebuild(a)
        Object.assign(r, { status: 'started', runId: run.id })
      } catch (err) {
        Object.assign(r, { status: 'failed', message: errOf(err) })
      }
    }
    results.push(r)
  }

  // pip and npm: install runs.
  const tools = manifest.tools
  const kinds = [
    { kind: 'pip' as const, raw: tools?.pip, pin: PIP_PIN, argv: pipInstallArgv, why: PIP_WHY, hosts: PIP_HOSTS, have: (a: Agent) => a.vm.tools?.pip ?? [], key: (x: string) => x.toLowerCase().replace(/[-_.]+/g, '-') },
    { kind: 'npm' as const, raw: tools?.npm, pin: NPM_PIN, argv: npmInstallArgv, why: NPM_WHY, hosts: NPM_HOSTS, have: (a: Agent) => a.vm.tools?.npm ?? [], key: (x: string) => x },
  ]
  for (const k of kinds) {
    const items = strings(k.raw)
    const r: BackupRestoreTool = { kind: k.kind, status: 'not_needed', items }
    results.push(r)
    if (items.length === 0) continue
    const a = fresh()
    const have = new Set(k.have(a).map(k.key))
    const missing = items.filter((x) => !have.has(k.key(x)))
    if (missing.length === 0) continue
    const pins = missing.filter((x) => k.pin.test(x)).slice(0, MAX_RESTORE_PINS)
    const skipped = missing.filter((x) => !pins.includes(x))
    const skippedText = skipped.length ? ` Not reinstalled (not a plain name and version): ${list(skipped)}.` : ''
    if (pins.length === 0) {
      Object.assign(r, { status: 'failed', message: skippedText.trim() })
      continue
    }
    try {
      const run = await deps.startInstall(a, k.argv(pins), k.why, k.hosts)
      if (ENDED_BAD.includes(run.status)) Object.assign(r, { status: 'failed', runId: run.id, message: `${run.error ?? "The install didn't start."}${skippedText}` })
      else Object.assign(r, { status: 'started', runId: run.id, ...(skippedText ? { message: skippedText.trim() } : {}) })
    } catch (err) {
      Object.assign(r, { status: 'failed', message: `${errOf(err)}${skippedText}` })
    }
  }

  // opt: listed only.
  {
    const items = strings(tools?.optBin)
    const r: BackupRestoreTool = { kind: 'opt', status: 'not_needed', items }
    const have = new Set(fresh().vm.tools?.optBin ?? [])
    const missing = items.filter((x) => !have.has(x))
    if (missing.length) {
      Object.assign(r, { status: 'not_restorable', message: `These programs in /opt/bot/bin can't be reinstalled from a backup: ${list(missing)}. Ask the bot to set them up again.` })
    }
    results.push(r)
  }

  const tools_: BackupRestoreAgent['tools'] = results.some((r) => r.status === 'failed') ? 'failed' : results.some((r) => r.status === 'started') ? 'started' : 'not_needed'
  const messages = results.filter((r) => r.message && (r.status === 'failed' || r.status === 'not_restorable')).map((r) => r.message!)
  return { tools: tools_, ...(messages.length ? { toolsMessage: messages.join(' ') } : {}), toolResults: results }
}
