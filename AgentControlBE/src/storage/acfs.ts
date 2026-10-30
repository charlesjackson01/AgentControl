/**
 * BE-P2-6: the `acfs` protocol spoken between WslFs (Windows backend) and the
 * ac-storaged helper container (PHASE2_PLAN §6). One request per call:
 *   podman exec -i ac-storaged acfs        (JSON request on stdin)
 * The reply is one JSON object on stdout. File bodies travel base64 inside
 * the JSON (uploads are capped at 25 MB); the 'cat' op is the exception and
 * streams the raw bytes of a file on stdout.
 *
 * Inside the helper, `acfs` runs handleAcfs() on a LocalFs rooted at
 * /var/lib/agentcontrol, so the guard, the no-follow opens and the atomic
 * writes are the exact code Mac/Linux run in-process.
 */
import type { RestoreSource, StorageBackend, WriteMode } from './types.js'

export type AcfsRequest =
  | { op: 'ensureDir' | 'existsAt' | 'readTextAt' | 'du' | 'countFiles'; vol: string }
  | { op: 'writeTextAt'; vol: string; text: string }
  | { op: 'renameAt'; from: string; to: string }
  | { op: 'readMarker' }
  | { op: 'writeMarker'; volumeId: string }
  | { op: 'stat' | 'list' | 'mkdirs' | 'remove' | 'openRead' | 'cat'; root: string; parts: string[] }
  | { op: 'read'; root: string; parts: string[]; maxBytes: number }
  | { op: 'write'; root: string; parts: string[]; body: string; mode: WriteMode }
  | { op: 'writeIfChanged'; root: string; parts: string[]; text: string }
  | { op: 'move'; root: string; from: string[]; to: string[] }
  | { op: 'moveOut'; root: string; parts: string[]; dest: string }
  | { op: 'inspect'; root: string; parts: string[]; hash: boolean }
  | { op: 'restore'; root: string; parts: string[]; src: RestoreSource }

export type AcfsResponse = { ok: true; result: unknown } | { ok: false; error: { message: string; statusCode?: number; code?: string } }

export const ACFS_OPS = [
  'ensureDir', 'existsAt', 'readTextAt', 'writeTextAt', 'renameAt', 'du', 'countFiles', 'readMarker', 'writeMarker',
  'stat', 'list', 'read', 'openRead', 'cat', 'write', 'writeIfChanged', 'mkdirs', 'move', 'moveOut', 'remove',
  'inspect', 'restore',
] as const

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string')

/** Validate an untrusted request (the helper reads it from stdin). */
export function parseAcfsRequest(raw: unknown): AcfsRequest {
  const r = (raw ?? {}) as Record<string, unknown>
  if (typeof r.op !== 'string' || !(ACFS_OPS as readonly string[]).includes(r.op)) throw new Error('Unknown acfs op.')
  const str = (k: string) => { if (typeof r[k] !== 'string') throw new Error(`acfs ${r.op}: "${k}" must be a string.`) }
  const strs = (k: string) => { if (!isStrings(r[k])) throw new Error(`acfs ${r.op}: "${k}" must be a list of strings.`) }
  switch (r.op) {
    case 'ensureDir': case 'existsAt': case 'readTextAt': case 'du': case 'countFiles': str('vol'); break
    case 'writeTextAt': str('vol'); str('text'); break
    case 'renameAt': str('from'); str('to'); break
    case 'readMarker': break
    case 'writeMarker': str('volumeId'); break
    case 'read': str('root'); strs('parts'); if (typeof r.maxBytes !== 'number' || !(r.maxBytes >= 0)) throw new Error('acfs read: "maxBytes" must be a number.'); break
    case 'write': str('root'); strs('parts'); str('body'); if (r.mode !== 'replace' && r.mode !== 'create' && r.mode !== 'append') throw new Error('acfs write: bad "mode".'); break
    case 'writeIfChanged': str('root'); strs('parts'); str('text'); break
    case 'move': str('root'); strs('from'); strs('to'); break
    case 'moveOut': str('root'); strs('parts'); str('dest'); break
    case 'inspect': str('root'); strs('parts'); if (typeof r.hash !== 'boolean') throw new Error('acfs inspect: "hash" must be true or false.'); break
    case 'restore': {
      str('root'); strs('parts')
      const src = (r.src ?? {}) as Record<string, unknown>
      const ok = (src.kind === 'absent')
        || (src.kind === 'symlink' && typeof src.target === 'string')
        || (src.kind === 'file' && typeof src.from === 'string' && typeof src.mode === 'number' && Number.isInteger(src.mode) && src.mode >= 0)
      if (!ok) throw new Error('acfs restore: bad "src".')
      break
    }
    default: str('root'); strs('parts')
  }
  return r as unknown as AcfsRequest
}

/** Run one request against a backend (LocalFs inside the helper). 'cat' is streamed by the caller. */
export function handleAcfs(fs: StorageBackend, req: AcfsRequest): AcfsResponse {
  try {
    return { ok: true, result: dispatch(fs, req) }
  } catch (err) {
    const e = err as { message?: string; statusCode?: number; code?: string }
    return {
      ok: false,
      error: {
        message: e?.message ?? String(err),
        ...(typeof e?.statusCode === 'number' ? { statusCode: e.statusCode } : {}),
        ...(typeof e?.code === 'string' ? { code: e.code } : {}),
      },
    }
  }
}

function dispatch(fs: StorageBackend, req: AcfsRequest): unknown {
  switch (req.op) {
    case 'ensureDir': return fs.ensureDir(req.vol) ?? null
    case 'existsAt': return fs.existsAt(req.vol)
    case 'readTextAt': return fs.readTextAt(req.vol)
    case 'writeTextAt': return fs.writeTextAt(req.vol, req.text) ?? null
    case 'renameAt': return fs.renameAt(req.from, req.to) ?? null
    case 'du': return fs.du(req.vol)
    case 'countFiles': return fs.countFiles(req.vol)
    case 'readMarker': return fs.readMarker()
    case 'writeMarker': return fs.writeMarker(req.volumeId) ?? null
    case 'stat': return fs.stat(req.root, req.parts)
    case 'list': return fs.list(req.root, req.parts)
    case 'read': return fs.read(req.root, req.parts, req.maxBytes).toString('base64')
    case 'openRead': {
      const { size, stream } = fs.openRead(req.root, req.parts)
      stream.destroy()
      return { size }
    }
    case 'cat': throw new Error('acfs cat streams; it has no JSON reply.')
    case 'write': return fs.write(req.root, req.parts, Buffer.from(req.body, 'base64'), req.mode)
    case 'writeIfChanged': return fs.writeIfChanged(req.root, req.parts, req.text) ?? null
    case 'mkdirs': return fs.mkdirs(req.root, req.parts) ?? null
    case 'move': return fs.move(req.root, req.from, req.to) ?? null
    case 'moveOut': return fs.moveOut(req.root, req.parts, req.dest) ?? null
    case 'remove': return fs.remove(req.root, req.parts) ?? null
    case 'inspect': return fs.inspect(req.root, req.parts, { hash: req.hash })
    case 'restore': return fs.restore(req.root, req.parts, req.src) ?? null
  }
}
