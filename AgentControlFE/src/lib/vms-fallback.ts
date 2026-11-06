/*
 * Fake-data path for Settings › VMs. The app loads this module only from inside
 * `if (import.meta.env.VITE_VMS_FAKE === '1')` (see vms-client.ts), so a normal dev
 * run and a production build never include it. Node tests import it directly and
 * pass the flag themselves.
 */
import { currentFakeVms, fakeVmsDispatch } from './vms-fake.ts'

/** True only for the string "1". Anything else, including unset, is off. */
export function vmsFakeEnabled(flag: string | undefined): boolean {
  return flag === '1'
}

type Live = (path: string, init?: RequestInit) => Promise<unknown>

function apiFields(err: unknown): { status: number; message: string; body?: unknown } | null {
  if (!(err instanceof Error)) return null
  const status = (err as { status?: unknown }).status
  if (typeof status !== 'number') return null
  const body = (err as { body?: unknown }).body
  return { status, message: err.message, ...(body !== undefined ? { body } : {}) }
}

/** A missing route, a dead proxy, or a 5xx with no JSON body. A JSON 4xx/5xx is a real error. */
export function vmsErrorIsFallback(err: unknown): boolean {
  const api = apiFields(err)
  if (!api) return true
  if (api.status === 404 && api.message.startsWith('Route ')) return true
  if (api.status >= 500 && api.body === undefined) return true
  return false
}

function messageOf(body: unknown): string {
  if (body && typeof body === 'object' && typeof (body as { message?: unknown }).message === 'string') return (body as { message: string }).message
  return 'Request failed.'
}

function errorFromFake(status: number, body: unknown): Error {
  const err = new Error(messageOf(body))
  err.name = 'ApiError'
  const withStatus = err as Error & { status: number; body?: unknown }
  withStatus.status = status
  if (body !== undefined) withStatus.body = body
  return err
}

/**
 * One call. `fakeFlag` is the VITE_VMS_FAKE value (`'1'` on). `live` is the transport.
 * A 2xx from `live` is returned as-is. Flag off rethrows every failure.
 */
export async function vmsRequestWith<T>(path: string, init: RequestInit | undefined, live: Live, fakeFlag: string | undefined): Promise<T> {
  try {
    return (await live(path, init)) as T
  } catch (err) {
    if (!vmsFakeEnabled(fakeFlag) || !vmsErrorIsFallback(err)) throw err
    let parsed: unknown
    if (typeof init?.body === 'string' && init.body) {
      try {
        parsed = JSON.parse(init.body)
      } catch {
        parsed = undefined
      }
    }
    const reply = fakeVmsDispatch(currentFakeVms(), init?.method ?? 'GET', path, parsed)
    if (!reply) throw err
    if (reply.status >= 400) throw errorFromFake(reply.status, reply.body)
    return reply.body as T
  }
}
