/**
 * BE-P2-18: tar / zstd / zip helpers. Temp folders under the test TMPDIR only; no engine.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ArchiveFormatError, dataEntry, extractTar, readTar, readZip, safeMemberName, tarStream, walkEntries, zipStream, zstdAvailable, zstdCompress, zstdDecompress, type TarMember } from './backup-archive.js'

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ac-be18-archive-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

async function collect(gen: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = []
  for await (const c of gen) parts.push(c)
  return Buffer.concat(parts)
}

function tarHeader(name: string, type: string, size = 0): Buffer {
  const b = Buffer.alloc(512)
  b.write(name, 0)
  b.write('0000644\0', 100)
  b.write('0000000\0', 108)
  b.write('0000000\0', 116)
  b.write(`${size.toString(8).padStart(11, '0')}\0`, 124)
  b.write('00000000000\0', 136)
  b.fill(' ', 148, 156)
  b.write(type, 156)
  b.write('ustar\0', 257)
  b.write('00', 263)
  let sum = 0
  for (const x of b) sum += x
  b.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
  return b
}

describe('tar', () => {
  it('round-trips files and folders, long and non-ASCII names, empty files; skips symlinks and .tmp files', async () => {
    const src = join(dir, 'src')
    const long = `${'deep/'.repeat(30)}file-with-a-long-name.txt`
    mkdirSync(join(src, ...long.split('/').slice(0, -1)), { recursive: true })
    writeFileSync(join(src, ...long.split('/')), 'long')
    writeFileSync(join(src, 'résumé ✓.md'), 'unicode')
    writeFileSync(join(src, 'empty'), '')
    writeFileSync(join(src, 'big.bin'), Buffer.alloc(700_000, 7))
    writeFileSync(join(src, '.half.123.tmp'), 'temp')
    symlinkSync('/etc/passwd', join(src, 'link'))
    const entries = walkEntries(src, 'workspace')
    expect(entries.map((e) => e.name)).not.toContain('workspace/link')
    expect(entries.map((e) => e.name)).not.toContain('workspace/.half.123.tmp')
    const members: TarMember[] = []
    const bodies = new Map<string, Buffer[]>()
    const tar = await collect(tarStream(entries))
    expect(tar.length % 512).toBe(0)
    await readTar(Readable.from([tar]), {
      onMember: (m) => {
        members.push(m)
        bodies.set(m.name, [])
      },
      onData: (c) => {
        bodies.get(members.at(-1)!.name)!.push(Buffer.from(c))
      },
    })
    const body = (n: string) => Buffer.concat(bodies.get(n) ?? []).toString()
    expect(members.find((m) => m.name === `workspace/${long}`)?.kind).toBe('file')
    expect(body(`workspace/${long}`)).toBe('long')
    expect(body('workspace/résumé ✓.md')).toBe('unicode')
    expect(body('workspace/empty')).toBe('')
    expect(Buffer.concat(bodies.get('workspace/big.bin')!).equals(Buffer.alloc(700_000, 7))).toBe(true)
    expect(members.find((m) => m.name === 'workspace/deep')?.kind).toBe('dir')
  })

  it('refuses unsafe names and anything but files and folders', async () => {
    for (const bad of ['../x', '/etc/x', 'a/../b', 'a\\b', 'a//b', '.']) expect(() => safeMemberName(bad)).toThrow(ArchiveFormatError)
    const end = Buffer.alloc(1024)
    const noop = { onMember: () => {}, onData: () => {} }
    await expect(readTar(Readable.from([Buffer.concat([tarHeader('../evil', '0'), end])]), noop)).rejects.toThrow(/Unsafe name/)
    await expect(readTar(Readable.from([Buffer.concat([tarHeader('workspace/link', '2'), end])]), noop)).rejects.toThrow(/isn't a file or a folder/)
    const corrupt = tarHeader('workspace/a', '0')
    corrupt[0] = 0x57
    await expect(readTar(Readable.from([Buffer.concat([corrupt, end])]), noop)).rejects.toThrow(/checksum/)
    await expect(readTar(Readable.from([tarHeader('workspace/a', '0', 10)]), noop)).rejects.toThrow(/ends/)
  })

  it('extracts only allowed top-level names, into a new folder', async () => {
    const tar = await collect(tarStream([dataEntry('workspace/a.txt', 'A', 0), dataEntry('secrets/x', 'nope', 0)]))
    await expect(extractTar(Readable.from([tar]), join(dir, 'out'), (t) => t === 'workspace')).rejects.toThrow(/Unexpected item/)
    const ok = await collect(tarStream([dataEntry('workspace/a.txt', 'A', 0), dataEntry('BOT.md', '# bot', 0)]))
    const res = await extractTar(Readable.from([ok]), join(dir, 'out2'), (t) => t === 'workspace' || t === 'BOT.md')
    expect(res).toEqual({ files: 2, bytes: 6 })
    expect(readFileSync(join(dir, 'out2', 'workspace', 'a.txt'), 'utf8')).toBe('A')
    // The destination must be new.
    await expect(extractTar(Readable.from([ok]), join(dir, 'out2'), () => true)).rejects.toThrow(/EEXIST/)
  })

  it.runIf(zstdAvailable())('compresses with zstd and reads back', async () => {
    const tar = await collect(tarStream([dataEntry('memory/MEMORY.md', 'x'.repeat(100_000), 0)]))
    const z = await collect(Readable.from([tar]).pipe(zstdCompress()))
    expect(z.length).toBeLessThan(tar.length / 10)
    expect(z.readUInt32LE(0)).toBe(0xfd2fb528) // zstd frame magic
    const back = await collect(Readable.from([z]).pipe(zstdDecompress()))
    expect(back.equals(tar)).toBe(true)
  })
})

describe('zip', () => {
  it('streams a zip with the expected members and bodies', async () => {
    const src = join(dir, 'z')
    mkdirSync(join(src, 'sub'), { recursive: true })
    writeFileSync(join(src, 'sub', 'a.txt'), 'hello')
    writeFileSync(join(src, 'b.bin'), Buffer.alloc(300_000, 1))
    const zip = await collect(zipStream([...walkEntries(src, 'analyst/workspace'), dataEntry('analyst/manifest.json', '{"version":1}', Date.now())]))
    const files = readZip(zip)
    expect([...files.keys()].sort()).toEqual(['analyst/manifest.json', 'analyst/workspace/b.bin', 'analyst/workspace/sub/a.txt'])
    expect(files.get('analyst/workspace/sub/a.txt')!.toString()).toBe('hello')
    expect(files.get('analyst/workspace/b.bin')!.equals(Buffer.alloc(300_000, 1))).toBe(true)
    expect(zip.length).toBeLessThan(50_000) // deflated
  })

  it('writes an empty zip when there is nothing', async () => {
    const zip = await collect(zipStream([]))
    expect(zip.length).toBe(22)
    expect(readZip(zip).size).toBe(0)
  })
})
