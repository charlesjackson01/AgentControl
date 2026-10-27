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

export function uid(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`
}

/** fail() with a machine-readable `reason` (409/410 bodies carry it, per the Phase 2 contract). */
export function failWithReason(status: number, reason: string, message: string): never {
  const err = new Error(message) as Error & { statusCode: number; reason: string }
  err.statusCode = status
  err.reason = reason
  throw err
}
