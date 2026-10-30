/**
 * BE-P2-5: isolation between bots and the host (plan §2.3, §13).
 *
 * uid mapping: the bot runs as uid 1000 inside its container. Files it writes in its bind mounts
 * (workspace, group folders) must land on the host owned by the AgentControl server user, and it
 * must be able to write files the server created. Two mappings do that; the probe picks one:
 *
 * - 'idmap':   `--userns auto` (each bot its own host uid range) + idmapped bind mounts. Best
 *              isolation, but rootless Podman can't create idmapped bind mounts on most kernels
 *              (mount_setattr → EPERM) and Mac/Windows Podman machines are rootless by default.
 *              Used only where the probe proved writes and host ownership with these exact flags.
 * - 'keep-id': `--userns keep-id:uid=1000,gid=1000`: the server user (rootless: the user that runs
 *              Podman, in the machine on Mac/Windows) is uid 1000 inside every bot container. Works
 *              on Linux, Mac and Windows Podman alike; bots are kept apart by their mounts, PID and
 *              network namespaces and volumes (plan §2.3 fallback), and the VM tab says so.
 *
 * Named volumes (tools, opt) get `U=true` so Podman re-owns them to uid 1000 of the current
 * mapping (a mapping change after a recreate would otherwise leave them unwritable). Bind mounts
 * never get `U`: that would chown the user's files on the host.
 *
 * Mount guard: every bind mount a bot container gets is checked against that bot's allow-list
 * (its own workspace and inputs, the shared folder of each group it is a member of, the skills
 * dir) after resolving symlinks, before the engine is called.
 */
import { realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { failWithReason } from './http.js'
import { BOT_GID, BOT_PATHS, BOT_UID } from './vm-images.js'

export type UidMapping = 'idmap' | 'keep-id'
/** Probe order: the stronger mapping first. */
export const UID_MAPPINGS: readonly UidMapping[] = ['idmap', 'keep-id']

export const KEEP_ID_NOTE =
  'Bots on this computer use the same user ID for their files (separate user IDs need idmapped mounts, which this computer doesn\'t support). Each bot still only sees its own folders and processes.'
export const MOUNT_REFUSED_REASON = 'mount_refused'

/** `--userns …` for a mapping (Podman). */
export function usernsArgs(m: UidMapping | null): string[] {
  if (m === 'idmap') return ['--userns', 'auto']
  if (m === 'keep-id') return ['--userns', `keep-id:uid=${BOT_UID},gid=${BOT_GID}`]
  return []
}
/** Extra `--mount type=bind` options for a mapping. */
export function bindMountOptions(m: UidMapping | null): string {
  return m === 'idmap' ? ',idmap' : ''
}
/** Extra `--mount type=volume` options for a mapping (only named volumes, never binds). */
export function volumeMountOptions(m: UidMapping | null): string {
  return m ? ',U=true' : ''
}
/** BE-P2-9: extra `-v …:O,…` (overlay) options for a mapping. */
export function overlayMountOptions(m: UidMapping | null): string {
  return m === 'idmap' ? ',idmap' : ''
}

export interface BotMount {
  source: string
  target: string
  readonly: boolean
  /**
   * BE-P2-9 (overlay snapshot driver): mount `source` as the lower layer of a Podman overlay
   * mount with these upper/work folders (the bot's writes land in `upper` until committed).
   * Writable mounts only; both must resolve inside the bot's overlay folder (`overlayRoot`).
   */
  overlay?: { upper: string; work: string }
}

/** What one bot may mount (host paths). */
export interface MountAllowList {
  slug: string
  workspace: string
  inputs: string
  /** group slug → that group's shared folder; only groups the bot is a member of. */
  groups: Record<string, string>
  /** Effective skills dir (read-only), when the bot has one. */
  skills?: string
  /** When set, workspace and inputs must also resolve inside this folder (the bot's own root). */
  botRoot?: string
  /** When set, group folders must also resolve inside this folder (all groups' root). */
  groupsRoot?: string
  /** BE-P2-9: overlay upper/work folders must resolve inside this folder (the bot's own snapshot overlay folder). */
  overlayRoot?: string
}

const real = (p: string): string | null => {
  try {
    return realpathSync(p)
  } catch {
    return null
  }
}
function refuse(slug: string, m: BotMount, why: string): never {
  failWithReason(500, MOUNT_REFUSED_REASON, `Refusing to mount ${JSON.stringify(m.source.slice(0, 200))} at ${m.target} for ${slug}: ${why}.`)
}

/**
 * Throws (500, reason mount_refused) unless every mount is on the bot's allow-list:
 * /bot/workspace (rw), /bot/shared (ro), /bot/skills (ro) and /bot/groups/<g> (rw, member groups
 * only), each source resolving (symlinks followed) to exactly the allowed folder.
 */
export function checkBotMounts(mounts: readonly BotMount[], allow: MountAllowList): BotMount[] {
  const seen = new Set<string>()
  for (const m of mounts) {
    if (path.posix.normalize(m.target) !== m.target) refuse(allow.slug, m, 'the target isn\'t a clean path')
    if (seen.has(m.target)) refuse(allow.slug, m, 'the target is mounted twice')
    seen.add(m.target)
    let allowed: string | undefined
    let readonly: boolean
    let within: string | undefined
    if (m.target === BOT_PATHS.workspace) [allowed, readonly, within] = [allow.workspace, false, allow.botRoot]
    else if (m.target === BOT_PATHS.inputs) [allowed, readonly, within] = [allow.inputs, true, allow.botRoot]
    else if (m.target === BOT_PATHS.skills) [allowed, readonly] = [allow.skills, true]
    else if (m.target.startsWith(`${BOT_PATHS.groups}/`) && !m.target.slice(BOT_PATHS.groups.length + 1).includes('/')) {
      const g = m.target.slice(BOT_PATHS.groups.length + 1)
      allowed = Object.prototype.hasOwnProperty.call(allow.groups, g) ? allow.groups[g] : undefined
      readonly = false
      within = allow.groupsRoot
      if (allowed === undefined) refuse(allow.slug, m, `the bot isn't a member of group ${JSON.stringify(g.slice(0, 60))}`)
    } else refuse(allow.slug, m, 'that target isn\'t allowed')
    if (allowed === undefined) refuse(allow.slug, m, 'the bot has no such folder')
    if (m.readonly !== readonly) refuse(allow.slug, m, readonly ? 'it must be read-only' : 'it must be writable')
    const src = real(m.source)
    const want = real(allowed)
    if (!src || !want) refuse(allow.slug, m, 'the folder doesn\'t exist')
    if (src !== want) refuse(allow.slug, m, 'it isn\'t this bot\'s folder')
    if (within !== undefined) {
      const root = real(within)
      if (!root || (src !== root && !src.startsWith(root.endsWith(path.sep) ? root : root + path.sep))) refuse(allow.slug, m, 'it resolves outside the bot\'s own folders')
    }
    if (!statSync(src).isDirectory()) refuse(allow.slug, m, 'it isn\'t a folder')
    if (m.overlay) {
      if (m.readonly) refuse(allow.slug, m, 'a read-only folder can\'t be an overlay')
      const root = allow.overlayRoot !== undefined ? real(allow.overlayRoot) : null
      if (!root) refuse(allow.slug, m, 'overlay folders aren\'t allowed for this bot')
      const seenDirs = new Set<string>()
      for (const d of [m.overlay.upper, m.overlay.work]) {
        const r = real(d)
        if (!r || !r.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) refuse(allow.slug, m, 'its overlay folders resolve outside the bot\'s own overlay folder')
        if (!statSync(r).isDirectory()) refuse(allow.slug, m, 'an overlay folder isn\'t a folder')
        if (seenDirs.has(r) || r === src) refuse(allow.slug, m, 'its overlay folders overlap')
        seenDirs.add(r)
      }
      for (const other of mounts) {
        if (other === m || !other.overlay) continue
        const o = [real(other.overlay.upper), real(other.overlay.work)]
        if (o.includes(real(m.overlay.upper)) || o.includes(real(m.overlay.work))) refuse(allow.slug, m, 'its overlay folders are used by another mount')
      }
    }
  }
  return [...mounts]
}
