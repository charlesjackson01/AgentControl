/*
 * FE-P2-6: try the live /api, and fall back to the in-memory store when the route is not there yet
 * (BE-P2-18) or the dev proxy is down. A real JSON error is rethrown so the page can show it.
 */
import { ApiError, request } from './api.ts'
import { currentFakeVms, fakeVmsDispatch } from './vms-fake.ts'

function fakeable(err: unknown): boolean {
  if (!(err instanceof ApiError)) return true
  if (err.status === 404 && err.message.startsWith('Route ')) return true
  if (err.status >= 500 && err.body === undefined) return true
  return false
}

function messageOf(body: unknown, fallback: string): string {
  if (body && typeof body === 'object' && typeof (body as { message?: unknown }).message === 'string') return (body as { message: string }).message
  return fallback
}

export async function vmsRequest<T>(path: string, init?: RequestInit): Promise<T> {
  try {
    return await request<T>(path, init)
  } catch (err) {
    if (!fakeable(err)) throw err
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
    if (reply.status >= 400) throw new ApiError(messageOf(reply.body, 'Request failed.'), reply.status, reply.body)
    return reply.body as T
  }
}
