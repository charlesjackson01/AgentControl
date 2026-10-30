/**
 * Which requests are API calls, for the onRequest gates (BE-P2-13 review B1). The router
 * (find-my-way) matches the percent-decoded path, so a prefix test on the raw URL is not enough:
 * `GET /%61pi/agents` is routed to /api/agents. A request counts as an API call when its matched
 * route is under /api, or when its path, decoded up to a few times and normalized (duplicate
 * slashes, dot segments, case), is. Fail closed: anything that looks like /api at any decoding
 * level is gated, even if it ends up a 404.
 */
import { posix } from 'node:path'

const API = /^\/api(\/|$)/i

/** The path part of a raw request URL, each decoding level normalized. */
export function pathVariants(rawUrl: string): string[] {
  const out: string[] = []
  let p = rawUrl.split(/[?#]/, 1)[0] ?? ''
  for (let i = 0; i < 4; i++) {
    const norm = posix.normalize(`/${p.replace(/\\/g, '/')}`).replace(/\/{2,}/g, '/')
    out.push(p, norm)
    let next: string
    try {
      next = decodeURIComponent(p)
    } catch {
      next = p.replace(/%([0-9a-f]{2})/gi, (_m, h: string) => String.fromCharCode(parseInt(h, 16)))
    }
    if (next === p) break
    p = next
  }
  return out
}

export interface RoutedRequest {
  url: string
  routeOptions?: { url?: string | undefined } | undefined
}

/** True when the request is (or could be routed as) an /api call. */
export function isApiRequest(request: RoutedRequest): boolean {
  const routed = request.routeOptions?.url
  if (typeof routed === 'string' && API.test(routed)) return true
  return pathVariants(request.url).some((p) => API.test(p))
}
