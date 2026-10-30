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
 * Container-side addresses: netavark's default pool (podman network 10.88.0.0/16, then
 * 10.89.x.0/24 per created network, incl. ac-egress-*), the Podman machine's gvproxy subnet and
 * slirp4netns' default. Docker's 172.17/16 is left out: its gateway is a host address.
 */
export const CONTAINER_CIDRS: readonly string[] = ['10.88.0.0/16', '10.89.0.0/16', '192.168.127.0/24', '10.0.2.0/24']

export interface UserOnlyCheck {
  /** null: allowed; otherwise why it was refused (for the log). */
  check(remoteAddress: string | undefined, headers: Record<string, string | string[] | undefined>): string | null
}

const headerText = (v: string | string[] | undefined) => (Array.isArray(v) ? v.join(',') : v ?? '')

export function createUserOnlyCheck(extraCidrs: readonly string[] = []): UserOnlyCheck {
  const cidrs: Cidr[] = [...CONTAINER_CIDRS, ...extraCidrs].map((c) => parseCidr(c)).filter((c): c is Cidr => c !== null)
  const via = EGRESS_VIA.split(' ').pop()!.toLowerCase()
  return {
    check(remoteAddress, headers) {
      const v = headerText(headers.via).toLowerCase()
      if (v.includes(via)) return 'via the bot proxy'
      const ip = (remoteAddress ?? '').replace(/^::ffff:/i, '')
      const a = toAddr(ip)
      if (a && cidrs.some((c) => inCidr(a, c))) return `from container address ${ip}`
      return null
    },
  }
}
