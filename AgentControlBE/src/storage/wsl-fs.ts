/**
 * BE-P2-6: WslFs, the Windows StorageBackend (PHASE2_PLAN §6). Bot files live
 * at /var/lib/agentcontrol inside the WSL distro `podman-agentcontrol`; every
 * operation is one `podman exec -i ac-storaged acfs` call speaking the acfs
 * protocol (acfs.ts). The helper runs the same LocalFs code, so the guard and
 * the atomic writes are identical on every OS.
 *
 * Status (M1): the backend and the protocol are complete and pass the shared
 * file-ops suite over an in-process transport (storage.test.ts). Not done yet:
 * selecting it on Windows (needs BE-P2-2's machine and the ac-storaged image
 * from BE-P2-3), the one-time migration of Phase 1 files into the distro, and
 * a real @win run. It is synchronous like the rest of the file code, so each
 * call blocks the event loop for one podman exec (~tens of ms); reads of file
 * bodies stream.
 */
import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { PassThrough, type Readable } from 'node:stream'
import { handleAcfs, type AcfsRequest, type AcfsResponse } from './acfs.js'
import {
  StorageNotImplementedError,
  type SnapshotRef, type StorageBackend, type StorageDirent, type StorageStat, type VolPath, type WriteMode,
} from './types.js'

export const WSL_VOLUME_ROOT = '/var/lib/agentcontrol'
export const STORAGE_HELPER = 'ac-storaged'

/** How WslFs reaches acfs: podman exec in production, in-process in tests. */
export interface AcfsTransport {
  call(req: AcfsRequest): AcfsResponse
  /** The raw bytes of a 'cat' request. */
  stream(req: AcfsRequest & { op: 'cat' }): Readable
}

type SpawnSyncFn = (cmd: string, args: string[], opts: { input: string; encoding: 'utf8'; maxBuffer: number; timeout: number; windowsHide: boolean }) => SpawnSyncReturns<string>

/** `podman exec -i ac-storaged acfs` (podman on PATH or AGENTCONTROL_PODMAN). */
export function podmanTransport(opts: { podman?: string; container?: string; spawnSyncFn?: SpawnSyncFn; timeoutMs?: number } = {}): AcfsTransport {
  const podman = opts.podman ?? process.env.AGENTCONTROL_PODMAN ?? 'podman'
  const container = opts.container ?? STORAGE_HELPER
  const run = opts.spawnSyncFn ?? (spawnSync as unknown as SpawnSyncFn)
  const args = ['exec', '-i', container, 'acfs']
  return {
    call(req) {
      const out = run(podman, args, { input: JSON.stringify(req), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: opts.timeoutMs ?? 60_000, windowsHide: true })
      if (out.error) return { ok: false, error: { message: `The files helper could not be reached (${out.error.message}).`, statusCode: 503 } }
      try {
        return JSON.parse(out.stdout) as AcfsResponse
      } catch {
        return { ok: false, error: { message: 'The files helper gave an unreadable answer.', statusCode: 502 } }
      }
    },
    stream(req) {
      const child = spawn(podman, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
      const out = new PassThrough()
      child.stdout.pipe(out)
      child.on('error', (err) => out.destroy(err))
      child.on('close', (code) => { if (code) out.destroy(new Error('The files helper could not read that file.')) })
      child.stdin.end(JSON.stringify(req))
      return out
    },
  }
}

/** acfs over a backend in this process, through JSON (tests: proves the protocol round-trips). */
export function inProcessTransport(fs: StorageBackend): AcfsTransport {
  return {
    call(req) {
      const wire = JSON.parse(JSON.stringify(req)) as AcfsRequest
      return JSON.parse(JSON.stringify(handleAcfs(fs, wire))) as AcfsResponse
    },
    stream(req) {
      return fs.openRead(req.root, req.parts).stream
    },
  }
}

export class WslFs implements StorageBackend {
  readonly kind = 'wsl' as const

  constructor(private readonly transport: AcfsTransport, readonly location: string = WSL_VOLUME_ROOT) {}

  private call<T>(req: AcfsRequest): T {
    const res = this.transport.call(req)
    if (res.ok) return res.result as T
    const err = new Error(res.error.message) as Error & { statusCode?: number; code?: string }
    if (res.error.statusCode !== undefined) err.statusCode = res.error.statusCode
    if (res.error.code !== undefined) err.code = res.error.code
    throw err
  }

  hostPath(_vol: VolPath): null {
    return null
  }

  ensureDir(vol: VolPath): void { this.call({ op: 'ensureDir', vol }) }
  existsAt(vol: VolPath): boolean { return this.call({ op: 'existsAt', vol }) }
  readTextAt(vol: VolPath): string | null { return this.call({ op: 'readTextAt', vol }) }
  writeTextAt(vol: VolPath, text: string): void { this.call({ op: 'writeTextAt', vol, text }) }
  renameAt(from: VolPath, to: VolPath): void { this.call({ op: 'renameAt', from, to }) }
  du(vol: VolPath): number { return this.call({ op: 'du', vol }) }
  countFiles(vol: VolPath): number { return this.call({ op: 'countFiles', vol }) }
  readMarker(): string | null { return this.call({ op: 'readMarker' }) }
  writeMarker(volumeId: string): void { this.call({ op: 'writeMarker', volumeId }) }

  stat(root: VolPath, parts: readonly string[]): StorageStat | null { return this.call({ op: 'stat', root, parts: [...parts] }) }
  list(root: VolPath, parts: readonly string[]): StorageDirent[] { return this.call({ op: 'list', root, parts: [...parts] }) }
  read(root: VolPath, parts: readonly string[], maxBytes: number): Buffer {
    return Buffer.from(this.call<string>({ op: 'read', root, parts: [...parts], maxBytes }), 'base64')
  }
  openRead(root: VolPath, parts: readonly string[]): { size: number; stream: Readable } {
    const { size } = this.call<{ size: number }>({ op: 'openRead', root, parts: [...parts] })
    return { size, stream: this.transport.stream({ op: 'cat', root, parts: [...parts] }) }
  }
  write(root: VolPath, parts: readonly string[], body: Buffer, mode: WriteMode): StorageStat {
    return this.call({ op: 'write', root, parts: [...parts], body: body.toString('base64'), mode })
  }
  writeIfChanged(root: VolPath, parts: readonly string[], text: string): void { this.call({ op: 'writeIfChanged', root, parts: [...parts], text }) }
  mkdirs(root: VolPath, parts: readonly string[]): void { this.call({ op: 'mkdirs', root, parts: [...parts] }) }
  move(root: VolPath, from: readonly string[], to: readonly string[]): void { this.call({ op: 'move', root, from: [...from], to: [...to] }) }
  moveOut(root: VolPath, parts: readonly string[], dest: VolPath): void { this.call({ op: 'moveOut', root, parts: [...parts], dest }) }
  remove(root: VolPath, parts: readonly string[]): void { this.call({ op: 'remove', root, parts: [...parts] }) }

  snapshot(_root: VolPath, _runId: string): SnapshotRef { throw new StorageNotImplementedError('Run snapshots', 'BE-P2-9') }
  diff(_ref: SnapshotRef): never { throw new StorageNotImplementedError('Snapshot diff', 'BE-P2-9') }
  undo(_ref: SnapshotRef): never { throw new StorageNotImplementedError('Undo', 'BE-P2-11') }
  exportZip(_root: VolPath): Readable { throw new StorageNotImplementedError('Export', 'BE-P2-17') }
}
