/**
 * Helpers shared by the routes and the services they call (runs, projects).
 * A thrown `fail()` error carries `statusCode`; the app's error handler turns
 * it into the HTTP status and `{ message }` body.
 */

export function fail(status: number, message: string): never {
  const err = new Error(message) as Error & { statusCode: number }
  err.statusCode = status
  throw err
}

/** BE-P2-11: extra fields a reasoned error body may carry (UndoConflict's `conflicts`). */
export interface ReasonExtra {
  conflicts?: { path: string; root: 'agent' | 'group'; groupId?: string; groupName?: string }[]
}

/**
 * fail() with a machine-readable `reason` (409/410 bodies carry it, per the Phase 2 contract).
 * BE-P2-11: `extra.conflicts` is sent in the body too (undo's 409 'conflicts').
 */
export function failWithReason(status: number, reason: string, message: string, extra: ReasonExtra = {}): never {
  const err = new Error(message) as Error & { statusCode: number; reason: string; conflicts?: ReasonExtra['conflicts'] }
  err.statusCode = status
  err.reason = reason
  if (extra.conflicts) err.conflicts = extra.conflicts
  throw err
}

export function uid(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`
}

/** The one 409 `internet_never` text (approved mockup / FE-9 run card), word for word. */
export function internetNeverText(botName: string): string {
  return `Internet is set to Never for ${botName}, so this run didn't start. Change it in Settings › VM.`
}
