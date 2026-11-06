/**
 * BE-P2-18: the archive formats behind backups and export, with no engine and no external tools.
 *
 * - `tar.zst` (backups): a POSIX ustar stream (PAX `path`/`size` records for long names and big
 *   files) compressed with Node's built-in zstd (`zlib.createZstdCompress`, Node ≥ 22.15).
 *   Only regular files and folders are written; symlinks, sockets and devices are skipped and
 *   never followed. Reading refuses anything but files and folders, absolute paths, `..`,
 *   backslashes and NUL, and only lets the caller's top-level names through.
 * - `zip` (export): streamed, deflate, data descriptors (sizes after the data), UTF-8 names.
 *   Zip32 only: an export over 4 GB (or with a file over 4 GB) fails with a plain error.
 *
 * Every walk is lstat-based (no-follow) and stays inside the folder it was given.
 */
import { closeSync, createReadStream, lstatSync, mkdirSync, openSync, readdirSync, writeSync, type Stats } from 'node:fs'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import zlib from 'node:zlib'

/** One file or folder to archive: `name` is the POSIX path inside the archive. */
export interface ArchiveEntry {
  name: string
  kind: 'file' | 'dir'
  /** Host path to read (files from disk), or absent with `data` (generated members). */
  hostPath?: string
  data?: Buffer
  size: number
  mode: number
  mtimeMs: number
}

const isTmpName = (n: string) => n.startsWith('.') && n.endsWith('.tmp')

/**
 * Regular files and folders under `dir` (lstat, no-follow), named `${prefix}/…`. Our own `.tmp`
 * write files and anything that isn't a file or a folder are skipped. A missing `dir` gives [].
 */
export function walkEntries(dir: string, prefix: string): ArchiveEntry[] {
  const out: ArchiveEntry[] = []
  let top: Stats
  try {
    top = lstatSync(dir)
  } catch {
    return out
  }
  if (!top.isDirectory()) return out
  out.push(dirEntry(prefix, top))
  const visit = (d: string, name: string) => {
    let names: string[]
    try {
      names = readdirSync(d).sort()
    } catch {
      return
    }
    for (const n of names) {
      if (isTmpName(n)) continue
      const full = join(d, n)
      let st: Stats
      try {
        st = lstatSync(full)
      } catch {
        continue
      }
      const child = `${name}/${n}`
      if (st.isDirectory()) {
        out.push(dirEntry(child, st))
        visit(full, child)
      } else if (st.isFile()) {
        out.push({ name: child, kind: 'file', hostPath: full, size: st.size, mode: st.mode & 0o777, mtimeMs: st.mtimeMs })
      }
    }
  }
  visit(dir, prefix)
  return out
}

/** One regular file (no-follow) as an entry named `name`, or null when it isn't a regular file. */
export function fileEntry(hostPath: string, name: string): ArchiveEntry | null {
  try {
    const st = lstatSync(hostPath)
    return st.isFile() ? { name, kind: 'file', hostPath, size: st.size, mode: st.mode & 0o777, mtimeMs: st.mtimeMs } : null
  } catch {
    return null
  }
}

export function dataEntry(name: string, data: Buffer | string, mtimeMs: number): ArchiveEntry {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
  return { name, kind: 'file', data: buf, size: buf.length, mode: 0o644, mtimeMs }
}

function dirEntry(name: string, st: Stats): ArchiveEntry {
  return { name, kind: 'dir', size: 0, mode: st.mode & 0o777, mtimeMs: st.mtimeMs }
}

/** The bytes of a file entry, exactly `size` long (a file that shrank meanwhile is padded with zeros, one that grew is cut). */
async function* entryBytes(e: ArchiveEntry, chunk = 256 * 1024): AsyncGenerator<Buffer> {
  if (e.data) {
    yield e.data
    return
  }
  let left = e.size
  if (left === 0) return
  const stream = createReadStream(e.hostPath!, { flags: 'r', highWaterMark: chunk })
  try {
    for await (const c of stream as AsyncIterable<Buffer>) {
      if (left <= 0) break
      const part = c.length > left ? c.subarray(0, left) : c
      left -= part.length
      yield part
    }
  } finally {
    stream.destroy()
  }
  if (left > 0) yield Buffer.alloc(left)
}

// --- tar ------------------------------------------------------------------------------------

const BLOCK = 512
const MAX_OCTAL_SIZE = 0o77777777777

function octal(n: number, len: number): string {
  return `${Math.max(0, Math.floor(n)).toString(8).padStart(len - 1, '0')}\0`
}

function header(name: string, type: '0' | '5' | 'x', size: number, mode: number, mtimeSec: number): Buffer {
  const b = Buffer.alloc(BLOCK)
  b.write(name.slice(0, 100), 0, 100, 'utf8')
  b.write(octal(mode, 8), 100, 8, 'ascii')
  b.write(octal(0, 8), 108, 8, 'ascii')
  b.write(octal(0, 8), 116, 8, 'ascii')
  b.write(octal(Math.min(size, MAX_OCTAL_SIZE), 12), 124, 12, 'ascii')
  b.write(octal(mtimeSec, 12), 136, 12, 'ascii')
  b.fill(' ', 148, 156)
  b.write(type, 156, 1, 'ascii')
  b.write('ustar\0', 257, 6, 'ascii')
  b.write('00', 263, 2, 'ascii')
  let sum = 0
  for (const x of b) sum += x
  b.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  return b
}

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`
  let len = Buffer.byteLength(body) + 1
  while (String(len).length + Buffer.byteLength(body) !== len) len = String(len).length + Buffer.byteLength(body)
  return `${len}${body}`
}

const pad = (n: number) => (n % BLOCK === 0 ? 0 : BLOCK - (n % BLOCK))

/** A tar stream of `entries` (folders end with '/'). */
export async function* tarStream(entries: readonly ArchiveEntry[]): AsyncGenerator<Buffer> {
  for (const e of entries) {
    const name = e.kind === 'dir' ? `${e.name}/` : e.name
    const mtime = Math.floor(e.mtimeMs / 1000)
    const records: string[] = []
    if (Buffer.byteLength(name) > 100 || /[^\x20-\x7e]/.test(name)) records.push(paxRecord('path', name))
    if (e.size > MAX_OCTAL_SIZE) records.push(paxRecord('size', String(e.size)))
    if (records.length) {
      const pax = Buffer.from(records.join(''), 'utf8')
      yield header('PaxHeader', 'x', pax.length, 0o644, mtime)
      yield Buffer.concat([pax, Buffer.alloc(pad(pax.length))])
    }
    yield header(asciiName(name), e.kind === 'dir' ? '5' : '0', e.kind === 'dir' ? 0 : e.size, e.mode, mtime)
    if (e.kind === 'file') {
      for await (const c of entryBytes(e)) yield c
      const p = pad(e.size)
      if (p) yield Buffer.alloc(p)
    }
  }
  yield Buffer.alloc(BLOCK * 2)
}

/** The ustar name field for a name that also has a PAX path (ASCII, cut to fit). */
function asciiName(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_')
  return ascii.length > 100 ? ascii.slice(ascii.length - 100) : ascii
}

export interface TarMember {
  name: string
  kind: 'file' | 'dir'
  size: number
  mode: number
  mtimeMs: number
}

/** Thrown for an archive that isn't one we'd write (bad header, unsafe name, unknown type). */
export class ArchiveFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArchiveFormatError'
  }
}

/** A safe relative POSIX name: no absolute path, `.`/`..`, empty segment, backslash or NUL. */
export function safeMemberName(raw: string): string {
  const name = raw.replace(/\/+$/, '')
  if (!name || name.startsWith('/') || name.includes('\\') || name.includes('\0')) throw new ArchiveFormatError(`Unsafe name in the archive: ${JSON.stringify(raw.slice(0, 120))}`)
  for (const seg of name.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') throw new ArchiveFormatError(`Unsafe name in the archive: ${JSON.stringify(raw.slice(0, 120))}`)
  }
  return name
}

/** A pull reader over an async byte stream. */
function byteReader(src: AsyncIterable<Buffer>) {
  const it = src[Symbol.asyncIterator]()
  let buf: Buffer = Buffer.alloc(0)
  let done = false
  async function fill(n: number): Promise<boolean> {
    while (buf.length < n && !done) {
      const r = await it.next()
      if (r.done) done = true
      else buf = buf.length ? Buffer.concat([buf, r.value]) : r.value
    }
    return buf.length >= n
  }
  return {
    async take(n: number): Promise<Buffer> {
      if (!(await fill(n))) throw new ArchiveFormatError('The archive ends early.')
      const out = buf.subarray(0, n)
      buf = buf.subarray(n)
      return out
    },
    /** Up to `max` bytes (at least 1 unless the stream ended). */
    async some(max: number): Promise<Buffer> {
      if (!buf.length) await fill(1)
      if (!buf.length) throw new ArchiveFormatError('The archive ends early.')
      const out = buf.subarray(0, Math.min(max, buf.length))
      buf = buf.subarray(out.length)
      return out
    },
  }
}

function parseOctal(b: Buffer): number {
  const s = b.toString('ascii').replace(/\0.*$/s, '').trim()
  if (!s) return 0
  if (!/^[0-7]+$/.test(s)) throw new ArchiveFormatError('Bad number in the archive header.')
  return parseInt(s, 8)
}

function parsePax(b: Buffer): Record<string, string> {
  const out: Record<string, string> = {}
  let i = 0
  while (i < b.length) {
    const sp = b.indexOf(0x20, i)
    if (sp < 0) break
    const len = Number(b.subarray(i, sp).toString('ascii'))
    if (!Number.isInteger(len) || len <= 0 || i + len > b.length) throw new ArchiveFormatError('Bad PAX record in the archive.')
    const rec = b.subarray(sp + 1, i + len - 1).toString('utf8')
    const eq = rec.indexOf('=')
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1)
    i += len
  }
  return out
}

/**
 * Read a tar stream: `onMember` gets each file or folder (checked names); a file's body comes as
 * chunks through `onData` before the next member. Anything other than files, folders and PAX
 * records is refused.
 */
export async function readTar(
  src: AsyncIterable<Buffer>,
  handlers: { onMember(m: TarMember): void | Promise<void>; onData(chunk: Buffer): void | Promise<void>; onEnd?(m: TarMember): void | Promise<void> },
): Promise<number> {
  const r = byteReader(src)
  let pax: Record<string, string> = {}
  let count = 0
  for (;;) {
    let h: Buffer
    try {
      h = await r.take(BLOCK)
    } catch {
      throw new ArchiveFormatError('The archive ends without its end marker.')
    }
    if (h.every((x) => x === 0)) return count
    const stored = parseOctal(h.subarray(148, 156))
    let sum = 0
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i]!
    if (sum !== stored) throw new ArchiveFormatError('Bad checksum in the archive header.')
    const type = String.fromCharCode(h[156]!)
    let size = parseOctal(h.subarray(124, 136))
    if (type === 'x') {
      pax = parsePax(await r.take(size))
      const p = pad(size)
      if (p) await r.take(p)
      continue
    }
    if (pax.size !== undefined) size = Number(pax.size)
    const ustarName = h.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '')
    const prefix = h.subarray(257, 263).toString('ascii').startsWith('ustar') ? h.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '') : ''
    const raw = pax.path ?? (prefix ? `${prefix}/${ustarName}` : ustarName)
    pax = {}
    let kind: TarMember['kind']
    if (type === '0' || type === '\0') kind = 'file'
    else if (type === '5') kind = 'dir'
    else throw new ArchiveFormatError(`The archive holds something that isn't a file or a folder (${JSON.stringify(raw.slice(0, 120))}).`)
    const m: TarMember = { name: safeMemberName(raw), kind, size: kind === 'dir' ? 0 : size, mode: parseOctal(h.subarray(100, 108)) & 0o777, mtimeMs: parseOctal(h.subarray(136, 148)) * 1000 }
    await handlers.onMember(m)
    let left = m.size
    while (left > 0) {
      const c = await r.some(Math.min(left, 256 * 1024))
      left -= c.length
      await handlers.onData(c)
    }
    const p = pad(m.size)
    if (p) await r.take(p)
    await handlers.onEnd?.(m)
    count++
  }
}

// --- zstd -----------------------------------------------------------------------------------

type ZstdZlib = typeof zlib & { createZstdCompress?: () => Transform; createZstdDecompress?: () => Transform }

export function zstdAvailable(): boolean {
  const z = zlib as ZstdZlib
  return typeof z.createZstdCompress === 'function' && typeof z.createZstdDecompress === 'function'
}

export function zstdCompress(): Transform {
  const z = zlib as ZstdZlib
  if (!z.createZstdCompress) throw new Error('This Node.js has no zstd support (Node 22.15 or later is needed for backups).')
  return z.createZstdCompress()
}

export function zstdDecompress(): Transform {
  const z = zlib as ZstdZlib
  if (!z.createZstdDecompress) throw new Error('This Node.js has no zstd support (Node 22.15 or later is needed for backups).')
  return z.createZstdDecompress()
}

/**
 * Extract a tar stream into `dest` (created; must not exist). Folders and files are created
 * exclusively (`wx`), so nothing outside `dest` and nothing already there is ever written.
 * `allowTop` limits the first path segment (e.g. workspace, shared, memory, BOT.md).
 */
export async function extractTar(src: AsyncIterable<Buffer>, dest: string, allowTop: (top: string) => boolean): Promise<{ files: number; bytes: number }> {
  mkdirSync(dest, { recursive: false, mode: 0o700 })
  let fd: number | null = null
  let files = 0
  let bytes = 0
  try {
    await readTar(src, {
      onMember(m) {
        const top = m.name.split('/')[0]!
        if (!allowTop(top)) throw new ArchiveFormatError(`Unexpected item in the archive: ${JSON.stringify(m.name.slice(0, 120))}`)
        const full = join(dest, ...m.name.split('/'))
        if (m.kind === 'dir') {
          mkdirSync(full, { recursive: true, mode: 0o700 })
          return
        }
        mkdirSync(join(full, '..'), { recursive: true, mode: 0o700 })
        fd = openSync(full, 'wx', (m.mode & 0o777) | 0o600)
        files++
      },
      onData(c) {
        if (fd === null) throw new ArchiveFormatError('File data without a file in the archive.')
        writeSync(fd, c)
        bytes += c.length
      },
      onEnd() {
        if (fd !== null) {
          closeSync(fd)
          fd = null
        }
      },
    })
  } finally {
    if (fd !== null) closeSync(fd)
  }
  return { files, bytes }
}

// --- zip ------------------------------------------------------------------------------------

const ZIP32_MAX = 0xffffffff

function dosTime(ms: number): { time: number; date: number } {
  const d = new Date(ms)
  const year = Math.max(1980, d.getFullYear())
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}

/** A streamed zip of the file entries (folders are implied by the names). */
export async function* zipStream(entries: readonly ArchiveEntry[]): AsyncGenerator<Buffer> {
  const central: Buffer[] = []
  let offset = 0
  let count = 0
  const tooBig = () => new Error('The export is larger than 4 GB, which a zip file can\'t hold here. Export one bot at a time instead.')
  for (const e of entries) {
    if (e.kind !== 'file') continue
    const name = Buffer.from(e.name, 'utf8')
    const { time, date } = dosTime(e.mtimeMs)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0808, 6) // data descriptor + UTF-8 names
    local.writeUInt16LE(8, 8) // deflate
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt16LE(name.length, 26)
    const start = offset
    yield local
    yield name
    offset += local.length + name.length
    let crc = 0
    let size = 0
    let compressed = 0
    const deflate = zlib.createDeflateRaw({ level: 6 })
    const source = Readable.from(entryBytes(e))
    const counted = source.pipe(
      new Transform({
        transform(chunk: Buffer, _enc, cb) {
          crc = zlib.crc32(chunk, crc)
          size += chunk.length
          cb(null, chunk)
        },
      }),
    ).pipe(deflate)
    for await (const c of counted as AsyncIterable<Buffer>) {
      compressed += c.length
      yield c
    }
    offset += compressed
    if (size > ZIP32_MAX || compressed > ZIP32_MAX || offset > ZIP32_MAX) throw tooBig()
    const dd = Buffer.alloc(16)
    dd.writeUInt32LE(0x08074b50, 0)
    dd.writeUInt32LE(crc >>> 0, 4)
    dd.writeUInt32LE(compressed, 8)
    dd.writeUInt32LE(size, 12)
    yield dd
    offset += dd.length
    const c = Buffer.alloc(46)
    c.writeUInt32LE(0x02014b50, 0)
    c.writeUInt16LE(0x0314, 4) // made by: unix, 2.0
    c.writeUInt16LE(20, 6)
    c.writeUInt16LE(0x0808, 8)
    c.writeUInt16LE(8, 10)
    c.writeUInt16LE(time, 12)
    c.writeUInt16LE(date, 14)
    c.writeUInt32LE(crc >>> 0, 16)
    c.writeUInt32LE(compressed, 20)
    c.writeUInt32LE(size, 24)
    c.writeUInt16LE(name.length, 28)
    c.writeUInt32LE(((0o100000 | (e.mode & 0o777)) << 16) >>> 0, 38)
    c.writeUInt32LE(start, 42)
    central.push(c, name)
    count++
    if (count > 0xffff) throw new Error('The export has more than 65,535 files, which a zip file can\'t hold here. Export one bot at a time instead.')
  }
  const cd = Buffer.concat(central)
  if (offset + cd.length > ZIP32_MAX) throw tooBig()
  yield cd
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(count, 8)
  end.writeUInt16LE(count, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  yield end
}

/** Test/read helper: the members of a zip (names, inflated bodies) from a whole buffer. */
export function readZip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>()
  const endAt = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (endAt < 0) throw new ArchiveFormatError('Not a zip file.')
  const count = buf.readUInt16LE(endAt + 10)
  let p = buf.readUInt32LE(endAt + 16)
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new ArchiveFormatError('Bad zip central directory.')
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    const csize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const at = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    const lNameLen = buf.readUInt16LE(at + 26)
    const lExtraLen = buf.readUInt16LE(at + 28)
    const data = buf.subarray(at + 30 + lNameLen + lExtraLen, at + 30 + lNameLen + lExtraLen + csize)
    const body = method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data)
    if ((zlib.crc32(body) >>> 0) !== crc) throw new ArchiveFormatError(`Bad CRC for ${name} in the zip.`)
    out.set(name, body)
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}
