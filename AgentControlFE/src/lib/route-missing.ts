/* Pure: does a failed call mean "this server doesn't have the route yet"? (tests/route-missing.test.mjs) */

/**
 * 405/501, or Fastify's own 404 for an unregistered route ("Route GET:/api/… not found").
 * A 404 from a real route (e.g. "No agent with id …") is a genuine error, not a missing feature.
 */
export function isRouteMissing(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status
  if (status === 405 || status === 501) return true
  if (status !== 404) return false
  const msg = err instanceof Error ? err.message : ''
  return /^Route [A-Z]+:\S+ not found$/i.test(msg.trim())
}
