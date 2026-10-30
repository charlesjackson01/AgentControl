/* Pure: the text to show for a failed API response (tests/api-error.test.mjs). */

/** Placeholder `error` values that carry no detail (the BE error handler, Fastify reason phrases). */
const GENERIC_ERRORS = new Set([
  'request error',
  'internal server error',
  'bad request',
  'unauthorized',
  'forbidden',
  'not found',
  'method not allowed',
  'conflict',
  'gone',
  'payload too large',
  'unsupported media type',
  'unprocessable entity',
  'too many requests',
  'bad gateway',
  'service unavailable',
  'gateway timeout',
  // Fastify's 507 phrase. M2 ruling (CONTRACT_REVIEW_16160ae blocker 1): low_disk is a 409 (`Conflict`, above),
  // never a 507, so `message` shows either way.
  'insufficient storage',
])

export const DEFAULT_ERROR_MESSAGE = 'Request failed'

function text(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
}

export function isGenericError(error: string): boolean {
  return GENERIC_ERRORS.has(error.trim().toLowerCase())
}

/**
 * Contract errors are `{ error: string }`; the BE's error handler sends
 * `{ error: 'Request Error', message: '<detail>' }`. A specific `error` wins;
 * a generic one defers to `message`; either alone is used as-is.
 */
export function errorMessageFrom(body: unknown): string {
  if (typeof body !== 'object' || body === null) return DEFAULT_ERROR_MESSAGE
  const error = text((body as { error?: unknown }).error)
  const message = text((body as { message?: unknown }).message)
  if (error && !isGenericError(error)) return error
  return message ?? error ?? DEFAULT_ERROR_MESSAGE
}
