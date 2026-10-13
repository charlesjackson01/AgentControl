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
