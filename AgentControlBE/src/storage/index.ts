/**
 * BE-P2-6: the storage backend for a workspace, and the volume marker.
 *
 * The marker (`.ac-volume-id` at the volume root) holds the id saved in
 * settings.vm.volumeId. At startup (checkVolume, called by buildApp):
 *  - no id in settings, no marker: first-ever start → write the marker, save the id;
 *  - no id in settings, marker present: adopt the marker's id (a start that
 *    crashed between the two writes, or a store.json restored without it) →
 *    nothing on the volume is touched;
 *  - id matches the marker: ok;
 *  - marker missing → 'missing', marker holds another id → 'mismatch'.
 * Missing or mismatched is the `files_missing` state: chats keep working,
 * every file operation (reads, writes, folder refreshes) and every run is
 * refused with a plain 409 (reason 'files_missing'), and nothing is ever
 * re-initialized on its own. M1 has no Start empty / Restore (M3).
 */
import { randomUUID } from 'node:crypto'
import { failWithReason } from '../http.js'
import type { WorkspaceStore } from '../store.js'
import { defaultVmSettings } from '../vm-defaults.js'
import { LocalFs } from './local-fs.js'
import type { StorageBackend, VolumeState } from './types.js'

export * from './types.js'
export { LocalFs } from './local-fs.js'
export { WslFs, podmanTransport, inProcessTransport, type AcfsTransport } from './wsl-fs.js'

export interface StorageState {
  backend: StorageBackend
  /** 'unchecked' until checkVolume runs (stores used without buildApp, e.g. unit tests). */
  volume: VolumeState | 'unchecked'
}

const states = new WeakMap<WorkspaceStore, StorageState>()

/**
 * M1 uses LocalFs at the data dir on every OS. WslFs (Windows) is wired in
 * once BE-P2-2 owns the distro and the one-time migration exists.
 */
function defaultBackend(store: WorkspaceStore): StorageBackend {
  return new LocalFs(store.dataDir)
}

export function storageFor(store: WorkspaceStore): StorageState {
  let state = states.get(store)
  if (!state) {
    state = { backend: defaultBackend(store), volume: 'unchecked' }
    states.set(store, state)
  }
  return state
}

/** Use another backend for this store (tests; WslFs later). Resets the volume check. */
export function useStorage(store: WorkspaceStore, backend: StorageBackend): StorageState {
  const state: StorageState = { backend, volume: 'unchecked' }
  states.set(store, state)
  return state
}

export function newVolumeId(): string {
  return `vol_${randomUUID()}`
}

/** Startup check of the volume marker (see the header). Never throws; logs and reports. */
export function checkVolume(store: WorkspaceStore, log: (msg: string) => void = console.warn): VolumeState {
  const state = storageFor(store)
  const { backend } = state
  const saved = store.settings.vm?.volumeId
  let marker: string | null
  try {
    marker = backend.readMarker()
  } catch (err) {
    log(`[storage] could not read the volume marker: ${err instanceof Error ? err.message : String(err)}`)
    marker = null
  }
  if (!saved) {
    let id = marker
    if (!id) {
      id = newVolumeId()
      try {
        backend.writeMarker(id)
      } catch (err) {
        // Could not even create the marker: treat as missing rather than run without one.
        log(`[storage] could not write the volume marker: ${err instanceof Error ? err.message : String(err)}`)
        state.volume = 'missing'
        return state.volume
      }
    }
    store.settings = { ...store.settings, vm: { ...(store.settings.vm ?? defaultVmSettings()), volumeId: id } }
    store.save()
    state.volume = 'ok'
    return state.volume
  }
  state.volume = marker === null ? 'missing' : marker === saved ? 'ok' : 'mismatch'
  if (state.volume !== 'ok') log(`[storage] bot files ${state.volume === 'missing' ? 'are missing (no volume marker)' : 'belong to another volume (marker mismatch)'}; files and runs are paused`)
  return state.volume
}

export function filesMissing(store: WorkspaceStore): boolean {
  const v = storageFor(store).volume
  return v === 'missing' || v === 'mismatch'
}

export const FILES_MISSING_TEXT =
  "AgentControl can't find the bots' files, so files and runs are paused to keep anything from being overwritten. Chats still work."
export const FILES_MISMATCH_TEXT =
  "The bots' files belong to a different AgentControl setup, so files and runs are paused to keep anything from being overwritten. Chats still work."

/** The plain-language reason files are unavailable, or null when they are fine. */
export function filesMissingMessage(store: WorkspaceStore): string | null {
  const v = storageFor(store).volume
  return v === 'missing' ? FILES_MISSING_TEXT : v === 'mismatch' ? FILES_MISMATCH_TEXT : null
}

/** 409 { reason: 'files_missing' } unless the volume is fine. For file routes, runs (BE-P2-12) and vm/start. */
export function assertFilesAvailable(store: WorkspaceStore): void {
  const message = filesMissingMessage(store)
  if (message) failWithReason(409, 'files_missing', message)
}

/** The backend, after assertFilesAvailable. */
export function storageReady(store: WorkspaceStore): StorageBackend {
  assertFilesAvailable(store)
  return storageFor(store).backend
}

/** True for the files_missing 409 (callers that refresh folders best-effort skip it quietly). */
export function isFilesMissingError(err: unknown): boolean {
  return (err as { reason?: unknown } | null)?.reason === 'files_missing'
}
