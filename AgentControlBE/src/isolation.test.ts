/** BE-P2-5: uid-mapping argv helpers and the mount allow-list guard. */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bindMountOptions, checkBotMounts, MOUNT_REFUSED_REASON, usernsArgs, volumeMountOptions, type BotMount, type MountAllowList } from './isolation.js'

describe('uid mapping argv', () => {
  it('idmap = --userns auto + idmapped binds; keep-id = keep-id:uid=1000,gid=1000; volumes get U, binds never do', () => {
    expect(usernsArgs('idmap')).toEqual(['--userns', 'auto'])
    expect(usernsArgs('keep-id')).toEqual(['--userns', 'keep-id:uid=1000,gid=1000'])
    expect(usernsArgs(null)).toEqual([])
    expect(bindMountOptions('idmap')).toBe(',idmap')
    expect(bindMountOptions('keep-id')).toBe('')
    expect(bindMountOptions(null)).toBe('')
    for (const m of ['idmap', 'keep-id'] as const) expect(bindMountOptions(m)).not.toContain('U=')
    expect(volumeMountOptions('idmap')).toBe(',U=true')
    expect(volumeMountOptions('keep-id')).toBe(',U=true')
    expect(volumeMountOptions(null)).toBe('')
  })
})

describe('checkBotMounts', () => {
  let root = ''
  let allow: MountAllowList
  let mounts: BotMount[]
  const p = (...s: string[]) => join(root, ...s)
  const refused = (ms: BotMount[], a: MountAllowList = allow) => {
    try {
      checkBotMounts(ms, a)
    } catch (e) {
      const err = e as Error & { statusCode?: number; reason?: string }
      expect(err.statusCode).toBe(500)
      expect(err.reason).toBe(MOUNT_REFUSED_REASON)
      return err.message
    }
    throw new Error('expected the mount to be refused')
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ac-iso-'))
    for (const d of ['bots/a/workspace', 'bots/a/shared', 'bots/b/workspace', 'bots/b/shared', 'groups/g1/shared', 'groups/g2/shared', 'skills/a']) mkdirSync(p(d), { recursive: true })
    writeFileSync(p('bots/a/file.txt'), 'x')
    allow = { slug: 'a', workspace: p('bots/a/workspace'), inputs: p('bots/a/shared'), groups: { g1: p('groups/g1/shared') }, skills: p('skills/a'), botRoot: p('bots/a'), groupsRoot: p('groups') }
    mounts = [
      { source: p('bots/a/workspace'), target: '/bot/workspace', readonly: false },
      { source: p('bots/a/shared'), target: '/bot/shared', readonly: true },
      { source: p('groups/g1/shared'), target: '/bot/groups/g1', readonly: false },
      { source: p('skills/a'), target: '/bot/skills', readonly: true },
    ]
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('BE-P2-9 overlay: upper/work inside the bot\'s overlay folder pass; outside, missing, shared or read-only are refused', () => {
    for (const d of ['snap/a/.overlay/workspace/upper', 'snap/a/.overlay/workspace/work', 'snap/a/.overlay/group-g1/upper', 'snap/a/.overlay/group-g1/work', 'snap/b/.overlay/workspace/upper']) mkdirSync(p(d), { recursive: true })
    const ov = (z: string) => ({ upper: p(`snap/a/.overlay/${z}/upper`), work: p(`snap/a/.overlay/${z}/work`) })
    const a2 = { ...allow, overlayRoot: p('snap/a/.overlay') }
    const ok = [{ ...mounts[0]!, overlay: ov('workspace') }, mounts[1]!, { ...mounts[2]!, overlay: ov('group-g1') }]
    expect(checkBotMounts(ok, a2)).toEqual(ok)
    expect(refused([{ ...mounts[0]!, overlay: ov('workspace') }])).toContain('overlay folders aren\'t allowed')
    expect(refused([{ ...mounts[1]!, overlay: ov('workspace') }], a2)).toContain('read-only folder can\'t be an overlay')
    expect(refused([{ ...mounts[0]!, overlay: { upper: p('snap/b/.overlay/workspace/upper'), work: ov('workspace').work } }], a2)).toContain('outside the bot\'s own overlay folder')
    expect(refused([{ ...mounts[0]!, overlay: { upper: p('snap/a/.overlay/nope'), work: ov('workspace').work } }], a2)).toContain('outside the bot\'s own overlay folder')
    expect(refused([{ ...mounts[0]!, overlay: { upper: ov('workspace').upper, work: ov('workspace').upper } }], a2)).toContain('overlap')
    expect(refused([{ ...mounts[0]!, overlay: ov('workspace') }, { ...mounts[2]!, overlay: ov('workspace') }], a2)).toContain('used by another mount')
  })

  it('the bot\'s own folders, its groups and skills pass', () => {
    expect(checkBotMounts(mounts, allow)).toEqual(mounts)
    expect(checkBotMounts([], allow)).toEqual([])
    // A non-canonical spelling of the same folder resolves to it.
    expect(checkBotMounts([{ source: `${p('bots/a')}/../a/workspace/`, target: '/bot/workspace', readonly: false }], allow)).toHaveLength(1)
  })

  it('another bot\'s workspace or inputs is refused', () => {
    expect(refused([{ source: p('bots/b/workspace'), target: '/bot/workspace', readonly: false }])).toContain('it isn\'t this bot\'s folder')
    expect(refused([{ source: p('bots/b/shared'), target: '/bot/shared', readonly: true }])).toContain('it isn\'t this bot\'s folder')
    expect(refused([{ source: p('bots/a/../b/workspace'), target: '/bot/workspace', readonly: false }])).toContain('it isn\'t this bot\'s folder')
  })

  it('a group the bot isn\'t in, or another group\'s folder under a member group\'s name, is refused', () => {
    expect(refused([{ source: p('groups/g2/shared'), target: '/bot/groups/g2', readonly: false }])).toContain('isn\'t a member of group "g2"')
    expect(refused([{ source: p('groups/g2/shared'), target: '/bot/groups/g1', readonly: false }])).toContain('it isn\'t this bot\'s folder')
    expect(refused([{ source: p('groups/g1/shared'), target: '/bot/groups/__proto__', readonly: false }])).toContain('isn\'t a member')
  })

  it('symlink escapes are refused: a link inside the mount source, or the bot\'s own folder replaced by a link', () => {
    symlinkSync(p('bots/b/workspace'), p('bots/a/link'))
    expect(refused([{ source: p('bots/a/link'), target: '/bot/workspace', readonly: false }])).toContain('it isn\'t this bot\'s folder')
    // The allow-list itself points at a link to bot b: only the root containment catches it.
    rmSync(p('bots/a/workspace'), { recursive: true })
    symlinkSync(p('bots/b/workspace'), p('bots/a/workspace'))
    expect(refused([mounts[0]!])).toContain('outside the bot\'s own folders')
    rmSync(p('groups/g1/shared'), { recursive: true })
    symlinkSync(p('bots/b/workspace'), p('groups/g1/shared'))
    expect(refused([mounts[2]!])).toContain('outside the bot\'s own folders')
  })

  it('targets outside the fixed set, unclean targets, duplicates and wrong read-only flags are refused', () => {
    expect(refused([{ source: p('bots/a'), target: '/bot/memory', readonly: true }])).toContain('target isn\'t allowed')
    expect(refused([{ source: p('bots/a/workspace'), target: '/bot/groups/../workspace', readonly: false }])).toContain('clean path')
    expect(refused([{ source: p('groups/g1/shared'), target: '/bot/groups/g1/x', readonly: false }])).toContain('target isn\'t allowed')
    expect(refused([mounts[0]!, mounts[0]!])).toContain('mounted twice')
    expect(refused([{ ...mounts[1]!, readonly: false }])).toContain('must be read-only')
    expect(refused([{ ...mounts[3]!, readonly: false }])).toContain('must be read-only')
    expect(refused([{ ...mounts[0]!, readonly: true }])).toContain('must be writable')
  })

  it('missing folders, files and a skills mount without a skills dir are refused', () => {
    expect(refused([{ source: p('bots/a/nope'), target: '/bot/workspace', readonly: false }], { ...allow, workspace: p('bots/a/nope') })).toContain('doesn\'t exist')
    expect(refused([{ source: p('bots/a/file.txt'), target: '/bot/workspace', readonly: false }], { ...allow, workspace: p('bots/a/file.txt') })).toContain('isn\'t a folder')
    const { skills: _s, ...noSkills } = allow
    expect(refused([mounts[3]!], noSkills)).toContain('no such folder')
  })
})
