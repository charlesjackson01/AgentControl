/**
 * BE-P2-13 (M2 contract review, user-only routes): the BE refuses anything that comes from a bot's
 * side of the fence. The proxy already denies the BE on every interface (this_computer /
 * model_server rules); this is the second wall, for a request that got here anyway:
 * - from a Podman / egress network address or the Podman machine gateway, or
 * - carrying the proxy's forwarding header (`Via: … ac-egressd`).
 * Answer: 403 with reason `user_only`.
 *
 * Rootless pasta (Linux) and gvproxy (Mac/Windows) make a container's connection to the host look
 * like it comes from this computer itself, so the address check can't catch every path; the
 * proxy's deny list is the main wall and the Via check catches anything relayed by the proxy.
 */
import { inCidr, parseCidr, toAddr, type Cidr } from './egress-rules.js'
import { EGRESS_VIA } from './egressd.js'

export const USER_ONLY_REASON = 'user_only'
export const USER_ONLY_MESSAGE = 'Only you can do this, from AgentControl itself. Bots and their scripts can\'t.'

/**
 * Review item 7: the container-side address list is built from what AgentControl actually uses,
 * not from fixed engine defaults (a LAN that happens to be 10.89.x.x must not be locked out):
 * - the subnets of the networks AgentControl creates (ac-egress-out, ac-egress-<slug>), read
 *   from the engine (EgressService.subnets());
 * - gvproxy's 192.168.127.0/24 only when the Podman machine (Mac/Windows) is in use;
 * - slirp4netns' 10.0.2.0/24 only when slirp is the bot/build network;
 * - AC_USER_ONLY_EXTRA_CIDRS (comma-separated), for setups the above misses.
 */
export const GVPROXY_CIDR = '192.168.127.0/24'
export const SLIRP_CIDR = '10.0.2.0/24'
export const USER_ONLY_EXTRA_ENV = 'AC_USER_ONLY_EXTRA_CIDRS'

/** CIDRs from AC_USER_ONLY_EXTRA_CIDRS; bad entries are dropped (and logged by the caller). */
export function userOnlyExtraCidrs(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env[USER_ONLY_EXTRA_ENV] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
}

export interface UserOnlyCheck {
  /** null: allowed; otherwise why it was refused (for the log). */
  check(remoteAddress: string | undefined, headers: Record<string, string | string[] | undefined>): string | null
}

const headerText = (v: string | string[] | undefined) => (Array.isArray(v) ? v.join(',') : v ?? '')

/**
 * `cidrs` is read on every check (it changes as networks are created); parsing is cached per
 * distinct list. Unparseable entries are reported once through `onBadCidr`.
 */
export function createUserOnlyCheck(cidrs: readonly string[] | (() => readonly string[]) = [], onBadCidr?: (cidr: string) => void): UserOnlyCheck {
  const source = typeof cidrs === 'function' ? cidrs : () => cidrs
  const via = EGRESS_VIA.split(' ').pop()!.toLowerCase()
  let key = ''
  let parsed: Cidr[] = []
  const bad = new Set<string>()
  const current = (): Cidr[] => {
    const list = source()
    const k = list.join(',')
    if (k !== key) {
      key = k
      parsed = []
      for (const c of list) {
        const p = parseCidr(c)
        if (p) parsed.push(p)
        else if (!bad.has(c)) {
          bad.add(c)
          onBadCidr?.(c)
        }
      }
    }
    return parsed
  }
  return {
    check(remoteAddress, headers) {
      const v = headerText(headers.via).toLowerCase()
      if (v.includes(via)) return 'via the bot proxy'
      const ip = (remoteAddress ?? '').replace(/^::ffff:/i, '')
      const a = toAddr(ip)
      if (a && current().some((c) => inCidr(a, c))) return `from container address ${ip}`
      return null
    },
  }
}
