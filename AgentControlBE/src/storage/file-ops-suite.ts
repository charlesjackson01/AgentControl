/**
 * BE-P2-6: the shared file-ops suite. Every StorageBackend must pass it:
 * storage.test.ts runs it against LocalFs and against WslFs (over the acfs
 * protocol, in-process). A real @win run can reuse it with podmanTransport().
 */
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { StorageNotImplementedError, type StorageBackend } from './types.js'

export interface SuiteFixture {
  fs: StorageBackend
  /** Host path of the volume root, to plant hostile entries (symlinks) the API refuses to create. */
  hostRoot: string
}

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const c of stream) chunks.push(Buffer.from(c as Buffer))
  return Buffer.concat(chunks)
}

const errorOf = (fn: () => unknown): { message: string; statusCode?: number; code?: string } => {
  try {
    fn()
  } catch (err) {
    return err as { message: string; statusCode?: number; code?: string }
  }
  throw new Error('expected an error')
}

export function fileOpsSuite(name: string, make: () => SuiteFixture): void {
  describe(`file ops: ${name}`, () => {
    const bot = 'bots/ada'

    it('mkdirs, write (create/replace/append), stat, read and list', () => {
      const { fs } = make()
      fs.ensureDir(bot)
      expect(fs.existsAt(bot)).toBe(true)
      fs.mkdirs(bot, ['workspace', 'notes'])
      expect(fs.stat(bot, ['workspace', 'notes'])).toMatchObject({ kind: 'dir' })
      const made = fs.write(bot, ['workspace', 'notes', 'a.txt'], Buffer.from('hello'), 'create')
      expect(made).toMatchObject({ kind: 'file', size: 5 })
      expect(errorOf(() => fs.write(bot, ['workspace', 'notes', 'a.txt'], Buffer.from('x'), 'create')).code).toBe('EEXIST')
      fs.write(bot, ['workspace', 'notes', 'a.txt'], Buffer.from(' world'), 'append')
      expect(fs.read(bot, ['workspace', 'notes', 'a.txt'], 100).toString()).toBe('hello world')
      expect(fs.read(bot, ['workspace', 'notes', 'a.txt'], 5).toString()).toBe('hello')
      expect(fs.write(bot, ['workspace', 'notes', 'a.txt'], Buffer.from('new'), 'replace').size).toBe(3)
      expect(fs.read(bot, ['workspace', 'notes', 'a.txt'], 100).toString()).toBe('new')
      fs.write(bot, ['workspace', 'b.bin'], Buffer.from([0, 1, 2, 255]), 'create')
      expect([...fs.read(bot, ['workspace', 'b.bin'], 10)]).toEqual([0, 1, 2, 255])
      const names = fs.list(bot, ['workspace']).map((d) => `${d.name}:${d.kind}`).sort()
      expect(names).toEqual(['b.bin:file', 'notes:dir'])
      expect(fs.stat(bot, ['workspace', 'nope'])).toBeNull()
      // no temp files left behind
      expect(fs.list(bot, ['workspace', 'notes']).map((d) => d.name)).toEqual(['a.txt'])
    })

    it('openRead streams the bytes with the size', async () => {
      const { fs } = make()
      fs.ensureDir(bot)
      const body = Buffer.alloc(200_000, 7)
      fs.write(bot, ['big.bin'], body, 'create')
      const { size, stream } = fs.openRead(bot, ['big.bin'])
      expect(size).toBe(200_000)
      expect((await readAll(stream)).equals(body)).toBe(true)
    })

    it('move, moveOut, remove, du and countFiles', () => {
      const { fs } = make()
      fs.ensureDir(bot)
      fs.mkdirs(bot, ['workspace'])
      fs.write(bot, ['workspace', 'a.txt'], Buffer.from('12345'), 'create')
      fs.write(bot, ['workspace', 'b.txt'], Buffer.from('123'), 'create')
      expect(fs.du(bot)).toBe(8)
      expect(fs.countFiles(bot)).toBe(2)
      fs.move(bot, ['workspace', 'a.txt'], ['workspace', 'c.txt'])
      expect(fs.stat(bot, ['workspace', 'a.txt'])).toBeNull()
      expect(fs.read(bot, ['workspace', 'c.txt'], 10).toString()).toBe('12345')
      fs.moveOut(bot, ['workspace', 'c.txt'], 'archive/trash/ada/c.txt')
      expect(fs.existsAt('archive/trash/ada/c.txt')).toBe(true)
      expect(fs.du(bot)).toBe(3)
      fs.remove(bot, ['workspace'])
      expect(fs.stat(bot, ['workspace'])).toBeNull()
      expect(fs.countFiles(bot)).toBe(0)
    })

    it('volume-level text files and renames (sidecars, archive)', () => {
      const { fs } = make()
      expect(fs.readTextAt('bots/ada.shared.json')).toBeNull()
      fs.writeTextAt('bots/ada.shared.json', '{"a":1}')
      expect(fs.readTextAt('bots/ada.shared.json')).toBe('{"a":1}')
      fs.ensureDir(bot)
      fs.renameAt(bot, 'archive/bots/ada-1')
      expect(fs.existsAt(bot)).toBe(false)
      expect(fs.existsAt('archive/bots/ada-1')).toBe(true)
    })

    it('writeIfChanged writes only differences', () => {
      const { fs } = make()
      fs.ensureDir(bot)
      fs.writeIfChanged(bot, ['BOT.md'], 'v1')
      const first = fs.stat(bot, ['BOT.md'])!
      fs.writeIfChanged(bot, ['BOT.md'], 'v1')
      expect(fs.stat(bot, ['BOT.md'])!.mtimeMs).toBe(first.mtimeMs)
      fs.writeIfChanged(bot, ['BOT.md'], 'v2')
      expect(fs.read(bot, ['BOT.md'], 10).toString()).toBe('v2')
    })

    it('refuses symlinks and escapes', () => {
      const { fs, hostRoot } = make()
      fs.ensureDir(bot)
      mkdirSync(join(hostRoot, 'outside'), { recursive: true })
      writeFileSync(join(hostRoot, 'outside', 'secret.txt'), 'nope')
      symlinkSync(join(hostRoot, 'outside'), join(hostRoot, 'bots', 'ada', 'link'))
      expect(errorOf(() => fs.read(bot, ['link', 'secret.txt'], 10)).statusCode).toBe(400)
      expect(errorOf(() => fs.write(bot, ['link', 'x.txt'], Buffer.from('x'), 'create')).statusCode).toBe(400)
      expect(errorOf(() => fs.list(bot, ['link'])).statusCode).toBe(400)
      expect(errorOf(() => fs.read(bot, ['..', '..', 'outside', 'secret.txt'], 10)).statusCode).toBe(400)
      expect(() => fs.existsAt('bots/../outside')).toThrow()
      expect(() => fs.ensureDir('/etc')).toThrow()
      // the symlink itself is reported, never followed
      expect(fs.list(bot, []).find((d) => d.name === 'link')?.kind).toBe('symlink')
    })

    it('volume marker: absent, written atomically, read back', () => {
      const { fs } = make()
      expect(fs.readMarker()).toBeNull()
      fs.writeMarker('vol_test-1')
      expect(fs.readMarker()).toBe('vol_test-1')
      fs.writeMarker('vol_test-2')
      expect(fs.readMarker()).toBe('vol_test-2')
    })

    it('BE-P2-11 inspect: files (hashed on request), symlinks never followed, folders, absent', () => {
      const { fs, hostRoot } = make()
      fs.ensureDir(bot)
      fs.mkdirs(bot, ['workspace'])
      fs.write(bot, ['workspace', 'a.txt'], Buffer.from('hello'), 'create')
      symlinkSync('/etc/passwd', join(hostRoot, bot, 'workspace', 'ln'))
      const plain = fs.inspect(bot, ['workspace', 'a.txt'])
      expect(plain).toMatchObject({ kind: 'file', size: 5 })
      expect(plain && 'sha256' in plain ? plain.sha256 : undefined).toBeUndefined()
      expect(fs.inspect(bot, ['workspace', 'a.txt'], { hash: true })).toMatchObject({
        kind: 'file', sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
      })
      expect(fs.inspect(bot, ['workspace', 'ln'], { hash: true })).toEqual({ kind: 'symlink', target: '/etc/passwd' })
      expect(fs.inspect(bot, ['workspace'])).toEqual({ kind: 'dir' })
      expect(fs.inspect(bot, ['workspace', 'nope'])).toBeNull()
      // a symlink in a parent segment is refused
      expect(errorOf(() => fs.inspect(bot, ['workspace', 'ln', 'x'])).statusCode).toBe(400)
      expect(() => fs.inspect(bot, ['workspace', '..', '..', 'x'])).toThrow()
    })

    it('BE-P2-11 restore: file (bytes + mode, parents made), symlink, absent; folders refused', () => {
      const { fs, hostRoot } = make()
      fs.ensureDir(bot)
      fs.mkdirs(bot, ['workspace'])
      mkdirSync(join(hostRoot, 'snapshots', 'ada', 'r1'), { recursive: true })
      writeFileSync(join(hostRoot, 'snapshots', 'ada', 'r1', 'orig'), 'original bytes')
      fs.restore(bot, ['workspace', 'deep', 'er', 'a.txt'], { kind: 'file', from: 'snapshots/ada/r1/orig', mode: 0o750 })
      expect(fs.read(bot, ['workspace', 'deep', 'er', 'a.txt'], 100).toString()).toBe('original bytes')
      expect(fs.inspect(bot, ['workspace', 'deep', 'er', 'a.txt'])).toMatchObject({ kind: 'file', mode: 0o750 })
      // replaces an existing file atomically, no temp files left
      fs.write(bot, ['workspace', 'b.txt'], Buffer.from('later'), 'create')
      fs.restore(bot, ['workspace', 'b.txt'], { kind: 'file', from: 'snapshots/ada/r1/orig', mode: 0o644 })
      expect(fs.read(bot, ['workspace', 'b.txt'], 100).toString()).toBe('original bytes')
      expect(fs.list(bot, ['workspace']).map((d) => d.name).sort()).toEqual(['b.txt', 'deep'])
      // a symlink is put back as a link (never followed), and replaces a file
      fs.restore(bot, ['workspace', 'b.txt'], { kind: 'symlink', target: '../elsewhere' })
      expect(fs.inspect(bot, ['workspace', 'b.txt'])).toEqual({ kind: 'symlink', target: '../elsewhere' })
      // absent removes a link or a file, and is fine when nothing is there
      fs.restore(bot, ['workspace', 'b.txt'], { kind: 'absent' })
      expect(fs.inspect(bot, ['workspace', 'b.txt'])).toBeNull()
      fs.restore(bot, ['workspace', 'b.txt'], { kind: 'absent' })
      // a folder is never replaced or removed
      expect(errorOf(() => fs.restore(bot, ['workspace', 'deep'], { kind: 'absent' })).statusCode).toBe(409)
      expect(errorOf(() => fs.restore(bot, ['workspace', 'deep'], { kind: 'symlink', target: 'x' })).statusCode).toBe(409)
      // the source must be a regular file (no-follow)
      symlinkSync('/etc/passwd', join(hostRoot, 'snapshots', 'ada', 'r1', 'evil'))
      expect(() => fs.restore(bot, ['workspace', 'c.txt'], { kind: 'file', from: 'snapshots/ada/r1/evil', mode: 0o644 })).toThrow()
      expect(fs.inspect(bot, ['workspace', 'c.txt'])).toBeNull()
      // no escapes through the target or the source
      symlinkSync('/tmp', join(hostRoot, bot, 'workspace', 'out'))
      expect(errorOf(() => fs.restore(bot, ['workspace', 'out', 'x'], { kind: 'absent' })).statusCode).toBe(400)
      expect(() => fs.restore(bot, ['workspace', 'd.txt'], { kind: 'file', from: 'snapshots/../../etc/passwd', mode: 0o644 })).toThrow()
      expect(() => fs.restore(bot, ['workspace', '..'], { kind: 'absent' })).toThrow()
    })

    it('snapshot, diff and export are clear stubs for now', () => {
      const { fs } = make()
      const e = errorOf(() => fs.snapshot(bot, 'run_1'))
      expect(e.statusCode).toBe(501)
      expect(e.message).toMatch(/not implemented yet/i)
      expect(() => fs.diff({ root: bot, snapshotId: 's' })).toThrow(StorageNotImplementedError)
      expect(() => fs.exportZip(bot)).toThrow(StorageNotImplementedError)
    })
  })
}
