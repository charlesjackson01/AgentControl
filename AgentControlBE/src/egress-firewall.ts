/**
 * BE-P2-13 (Charles, M2 steering): the nftables layer under the egress proxy. A one-shot helper
 * container joins ac-egressd's network namespace (`--network container:ac-egressd`) with only
 * NET_ADMIN, loads the `inet ac_egressd` table below and exits; the proxy itself stays
 * `--cap-drop ALL`. The table drops every NEW outbound connection from the proxy's namespace to
 * the always-blocked ranges (this computer, loopback, home network, Tailscale, metadata, reserved,
 * local model servers), so a bug in the proxy's own rules can't reach them. Replies on connections
 * the bots opened to the proxy (established) and DNS (port 53, to the proxy's resolvers and the
 * outbound network's gateway only) still pass. AC_EGRESS_TEST_ALLOW never changes this table.
 *
 * Every address is parsed and re-printed from its bytes before it goes in the ruleset, so nothing
 * but addresses and prefix lengths reaches nft.
 */
import { DENY_CIDRS, parseCidr, type Cidr, type EgressRulesConfig } from './egress-rules.js'
import { BOTVM_VERSION, egressdNftImageRef } from './vm-images.js'

export const FIREWALL_TABLE = 'ac_egressd'
/** The helper image (vm/build-images.sh --only egressd-nft): botvm + nftables. */
export function firewallImageRef(version: string = BOTVM_VERSION): string {
  return egressdNftImageRef(version)
}

/** Canonical text of a CIDR (host bits cleared), or the bare address when it is a single host. */
export function cidrText(c: Cidr): string {
  const bytes = c.bytes.map((b, i) => {
    const keep = Math.max(0, Math.min(8, c.bits - i * 8))
    return b & ((0xff << (8 - keep)) & 0xff)
  })
  const max = c.v === 4 ? 32 : 128
  const ip =
    c.v === 4
      ? bytes.join('.')
      : Array.from({ length: 8 }, (_, i) => ((bytes[2 * i]! << 8) | bytes[2 * i + 1]!).toString(16)).join(':')
  return c.bits === max ? ip : `${ip}/${c.bits}`
}

/** An address from dns.getServers() (`1.2.3.4`, `1.2.3.4:5353`, `[::1]:53`, `::1`), or null. */
function serverAddress(text: string): Cidr | null {
  const t = text.trim()
  const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(t)
  if (bracket) return parseCidr(bracket[1]!)
  const v4port = /^(\d+\.\d+\.\d+\.\d+):\d+$/.exec(t)
  if (v4port) return parseCidr(v4port[1]!)
  return t.includes('/') ? null : parseCidr(t)
}

export interface FirewallInput {
  /** The proxy's rules config: host addresses and model servers are added to the drop sets. */
  config: EgressRulesConfig
  /** The proxy's resolvers (its health `dns`) and the outbound network's gateway(s): port 53 only. */
  dns: readonly string[]
}

/** The drop sets: the deny table + this computer's addresses + local model servers given as addresses. */
export function firewallDrops(config: EgressRulesConfig): { v4: string[]; v6: string[] } {
  const v4 = new Set<string>()
  const v6 = new Set<string>()
  const add = (text: string) => {
    const c = parseCidr(text.replace(/%.*$/, ''))
    if (c) (c.v === 4 ? v4 : v6).add(cidrText(c))
  }
  for (const c of DENY_CIDRS) add(c)
  for (const a of config.hostAddresses ?? []) add(a)
  // Model servers named by address (names resolve into the ranges above when local; a public
  // address is not local and stays reachable, as in the proxy's own rule).
  for (const m of config.modelServers ?? []) {
    const c = parseCidr(m.host.replace(/^\[|\]$/g, ''))
    if (c && (m.always || isDenied(c))) add(cidrText(c))
  }
  return { v4: [...v4], v6: [...v6] }
}

function isDenied(c: Cidr): boolean {
  return DENY_CIDRS.some((d) => {
    const r = parseCidr(d)!
    if (r.v !== c.v) return false
    for (let i = 0; i < r.bits; i++) {
      const bit = (b: number[]) => (b[i >> 3]! >> (7 - (i & 7))) & 1
      if (bit(r.bytes) !== bit(c.bytes)) return false
    }
    return true
  })
}

/**
 * The whole ruleset for `nft -f -`: replaces the table atomically (add + delete + define in one
 * transaction), so a reload never leaves a gap.
 */
export function firewallRuleset(input: FirewallInput): string {
  const drops = firewallDrops(input.config)
  const dns4 = new Set<string>()
  const dns6 = new Set<string>()
  for (const s of input.dns) {
    const c = serverAddress(s)
    if (c) (c.v === 4 ? dns4 : dns6).add(cidrText(c))
  }
  const set = (name: string, type: string, els: Iterable<string>) => {
    const list = [...els]
    return [
      `  set ${name} {`,
      `    type ${type}`,
      '    flags interval',
      '    auto-merge',
      ...(list.length ? [`    elements = { ${list.join(', ')} }`] : []),
      '  }',
    ]
  }
  return [
    `add table inet ${FIREWALL_TABLE}`,
    `delete table inet ${FIREWALL_TABLE}`,
    `table inet ${FIREWALL_TABLE} {`,
    ...set('drop4', 'ipv4_addr', drops.v4),
    ...set('drop6', 'ipv6_addr', drops.v6),
    ...set('dns4', 'ipv4_addr', dns4),
    ...set('dns6', 'ipv6_addr', dns6),
    '  chain output {',
    '    type filter hook output priority 0; policy accept;',
    '    ct state established,related accept',
    '    ip daddr @dns4 meta l4proto { tcp, udp } th dport 53 accept',
    '    ip6 daddr @dns6 meta l4proto { tcp, udp } th dport 53 accept',
    '    ip daddr @drop4 counter drop',
    '    ip6 daddr @drop6 counter drop',
    '  }',
    '}',
    '',
  ].join('\n')
}
