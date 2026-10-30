/**
 * BE-P2-13: the egress proxy's host, address and port rules (M2 plan §5), pure and shared by the
 * proxy (ac-egressd, egressd.ts) and its tests. Node built-ins and type-only imports only: this
 * file is copied into the ac-egressd container as is.
 *
 * Order (plan §5): port (80/443 only) → names refused before resolving → address literals
 * normalised (inet_aton forms, IPv4-mapped/compatible/NAT64/6to4/Teredo IPv6) and checked → the
 * proxy resolves the name, checks every address and connects to a checked one (pinned).
 */
import type { HostBlockReason } from './shared/types.js'

export type { HostBlockReason }

/** Ports a bot may reach through the proxy. */
export const ALLOWED_PORTS: readonly number[] = [80, 443]

/** The gvproxy gateway on Mac/Windows Podman machines (the host). */
export const GVPROXY_GATEWAY = '192.168.127.254'

/**
 * Names refused before resolving (no IP is looked up or logged for them). Reasons per the
 * contract review (16160ae §4 item 10): this computer's names → this_computer, *.ts.net →
 * tailscale, other home-network names → private_name.
 */
export const THIS_COMPUTER_NAMES: readonly string[] = ['localhost', 'host.containers.internal', 'host.docker.internal', 'gateway', '_gateway', 'host-gateway', 'ip6-localhost', 'ip6-loopback']
export const THIS_COMPUTER_SUFFIXES: readonly string[] = ['.localhost']
export const TAILSCALE_SUFFIXES: readonly string[] = ['.ts.net']
export const PRIVATE_SUFFIXES: readonly string[] = ['.local', '.lan', '.internal', '.home', '.home.arpa', '.localdomain', '.intranet', '.corp', '.private', '.in-addr.arpa', '.ip6.arpa']

/** Settings the BE pushes to the proxy (config op). */
export interface EgressRulesConfig {
  /** This computer's own addresses (hostInterfaceAddresses(): interfaces, including ones that are down). */
  hostAddresses?: string[]
  /** The model server(s) and the BE: refused as model_server (names before resolving). */
  modelServers?: { host: string; port: number }[]
  /**
   * Test-only (AC_EGRESS_TEST_ALLOW): CIDRs let through although a rule would refuse them, so the
   * @vm tests can use local test servers. Never set by the app outside tests.
   */
  testAllow?: string[]
}

export interface Verdict {
  ok: boolean
  reason?: HostBlockReason
  /** The address (normalised) or name the verdict is about, for the "Blocked: …" text. */
  subject: string
}

// ---------------------------------------------------------------- address parsing

/** A parsed address: 4 bytes (IPv4) or 16 bytes (IPv6). */
export interface Addr {
  v: 4 | 6
  bytes: number[]
}

const PART = /^(0x[0-9a-f]*|0[0-7]*|[1-9][0-9]*)$/i

/**
 * inet_aton()-style IPv4: 1–4 dot-separated parts, each decimal, octal (leading 0) or hex (0x),
 * the last part filling the remaining bytes ("127.1", "2130706433", "0x7f.1", "0177.0.0.1").
 * null when it isn't one; 'invalid' when it looks numeric but is out of range.
 */
export function parseIPv4Loose(s: string): Addr | null | 'invalid' {
  const host = s.endsWith('.') ? s.slice(0, -1) : s
  const parts = host.split('.')
  if (parts.length < 1 || parts.length > 4 || parts.some((p) => !PART.test(p))) return null
  const nums: number[] = []
  for (const p of parts) {
    const low = p.toLowerCase()
    let n: number
    if (low.startsWith('0x')) n = low.length === 2 ? 0 : parseInt(low.slice(2), 16)
    else if (low.length > 1 && low.startsWith('0')) n = parseInt(low.slice(1), 8)
    else n = parseInt(low, 10)
    if (!Number.isFinite(n)) return 'invalid'
    nums.push(n)
  }
  const last = nums.pop()!
  if (nums.some((n) => n > 255)) return 'invalid'
  const restBytes = 4 - nums.length
  if (last >= 2 ** (8 * restBytes)) return 'invalid'
  const bytes = [...nums]
  for (let i = restBytes - 1; i >= 0; i--) bytes.push(Math.floor(last / 2 ** (8 * i)) % 256)
  return { v: 4, bytes }
}

/** Strict dotted-quad (for IPv6 tails and resolver answers). */
function parseIPv4Strict(s: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s)
  if (!m) return null
  const b = m.slice(1).map(Number)
  return b.every((x) => x <= 255) ? b : null
}

/** IPv6 text (no brackets) to 16 bytes; zone ids ("%eth0") are not accepted. */
export function parseIPv6(s: string): Addr | null {
  if (!s.includes(':') || s.includes('%')) return null
  let text = s.toLowerCase()
  let tail: number[] = []
  const lastColon = text.lastIndexOf(':')
  if (text.slice(lastColon + 1).includes('.')) {
    const v4 = parseIPv4Strict(text.slice(lastColon + 1))
    if (!v4) return null
    tail = v4
    text = text.slice(0, lastColon + 1) + '0:0'
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const groups = (h: string) => (h === '' ? [] : h.split(':'))
  const head = groups(halves[0]!)
  const rest = halves.length === 2 ? groups(halves[1]!) : []
  const all = [...head, ...rest]
  if (all.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null
  const missing = 8 - all.length
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null
  const words = [...head.map((g) => parseInt(g, 16)), ...Array<number>(halves.length === 2 ? missing : 0).fill(0), ...rest.map((g) => parseInt(g, 16))]
  const bytes: number[] = []
  for (const w of words) bytes.push(w >> 8, w & 255)
  if (tail.length) bytes.splice(12, 4, ...tail)
  return { v: 6, bytes }
}

/**
 * A host as written in a URL or CONNECT line: "[::1]", "::1", "127.1", "example.com".
 * Returns the address for literals, 'invalid' for malformed literals, null for names.
 */
export function parseAddressLiteral(host: string): Addr | 'invalid' | null {
  let h = host.trim()
  if (h.startsWith('[') || h.endsWith(']')) {
    if (!(h.startsWith('[') && h.endsWith(']'))) return 'invalid'
    h = h.slice(1, -1)
    return parseIPv6(h) ?? 'invalid'
  }
  if (h.includes(':')) return parseIPv6(h) ?? 'invalid'
  const v4 = parseIPv4Loose(h)
  if (v4) return v4
  // "1.2.3.4.5" or "999.1": the last label numeric means a broken address, not a name.
  const lastLabel = (h.endsWith('.') ? h.slice(0, -1) : h).split('.').pop() ?? ''
  if (/^(0x[0-9a-f]*|\d+)$/i.test(lastLabel)) return 'invalid'
  return null
}

/**
 * The IPv4 address an IPv6 one carries, if any: IPv4-mapped ::ffff:a.b.c.d, IPv4-translated
 * ::ffff:0:a.b.c.d, IPv4-compatible ::a.b.c.d, NAT64 64:ff9b::/96 and 64:ff9b:1::/48, 6to4
 * 2002:AABB:CCDD::/16 and Teredo 2001:0::/32 (client address, inverted).
 */
export function embeddedIPv4(a: Addr): number[] | null {
  if (a.v !== 6) return null
  const b = a.bytes
  const zero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0)
  const last4 = b.slice(12, 16)
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return last4
  if (zero(0, 8) && b[8] === 0xff && b[9] === 0xff && zero(10, 12)) return last4
  if (zero(0, 12) && !(zero(12, 15) && (b[15] === 0 || b[15] === 1))) return last4
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && (zero(4, 12) || (b[4] === 0 && b[5] === 1))) return last4
  if (b[0] === 0x20 && b[1] === 0x02) return b.slice(2, 6)
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0 && b[3] === 0) return last4.map((x) => x ^ 0xff)
  return null
}

export function formatAddr(a: Addr): string {
  if (a.v === 4) return a.bytes.join('.')
  const words: number[] = []
  for (let i = 0; i < 16; i += 2) words.push((a.bytes[i]! << 8) | a.bytes[i + 1]!)
  // RFC 5952: compress the longest run (>= 2) of zero words.
  let best = -1
  let bestLen = 0
  for (let i = 0; i < 8; ) {
    if (words[i] !== 0) {
      i++
      continue
    }
    let j = i
    while (j < 8 && words[j] === 0) j++
    if (j - i > bestLen && j - i >= 2) {
      best = i
      bestLen = j - i
    }
    i = j
  }
  const hex = words.map((w) => w.toString(16))
  if (best < 0) return hex.join(':')
  return `${hex.slice(0, best).join(':')}::${hex.slice(best + bestLen).join(':')}`
}

/** Any address text (resolver answer or literal) to an Addr, or null. */
export function toAddr(text: string): Addr | null {
  const a = parseAddressLiteral(text)
  return a && a !== 'invalid' ? a : null
}

// ---------------------------------------------------------------- CIDR tables

export interface Cidr {
  v: 4 | 6
  bytes: number[]
  bits: number
}

export function parseCidr(text: string): Cidr | null {
  const [ip, bitsText] = text.split('/')
  const a = toAddr(ip ?? '')
  if (!a) return null
  const max = a.v === 4 ? 32 : 128
  const bits = bitsText === undefined ? max : Number(bitsText)
  if (!Number.isInteger(bits) || bits < 0 || bits > max) return null
  return { v: a.v, bytes: a.bytes, bits }
}

export function inCidr(a: Addr, c: Cidr): boolean {
  if (a.v !== c.v) return false
  let bits = c.bits
  for (let i = 0; bits > 0; i++, bits -= 8) {
    const mask = bits >= 8 ? 0xff : (0xff << (8 - bits)) & 0xff
    if (((a.bytes[i] ?? 0) & mask) !== ((c.bytes[i] ?? 0) & mask)) return false
  }
  return true
}

const table = (rows: [string, HostBlockReason][]): [Cidr, HostBlockReason][] => rows.map(([c, r]) => [parseCidr(c)!, r])

/** Fixed hard-deny list (plan §5), most specific first: the first match names the reason. */
export const DENY_TABLE: readonly [Cidr, HostBlockReason][] = table([
  ['169.254.169.254/32', 'metadata'],
  ['fd00:ec2::254/128', 'metadata'],
  ['127.0.0.0/8', 'this_computer'],
  ['::1/128', 'this_computer'],
  [`${GVPROXY_GATEWAY}/32`, 'this_computer'],
  ['100.64.0.0/10', 'tailscale'],
  ['fd7a:115c:a1e0::/48', 'tailscale'],
  ['10.0.0.0/8', 'home_network'],
  ['172.16.0.0/12', 'home_network'],
  ['192.168.0.0/16', 'home_network'],
  ['169.254.0.0/16', 'home_network'],
  ['fe80::/10', 'home_network'],
  ['fec0::/10', 'home_network'],
  ['fc00::/7', 'home_network'],
  ['0.0.0.0/8', 'reserved'],
  ['224.0.0.0/4', 'reserved'],
  ['240.0.0.0/4', 'reserved'],
  ['::/128', 'reserved'],
  ['ff00::/8', 'reserved'],
  ['100::/64', 'reserved'],
])

/** The deny-table rows as text (for the docs and table tests). */
export const DENY_CIDRS: readonly string[] = [
  '169.254.169.254/32', 'fd00:ec2::254/128', '127.0.0.0/8', '::1/128', `${GVPROXY_GATEWAY}/32`, '100.64.0.0/10', 'fd7a:115c:a1e0::/48',
  '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', 'fe80::/10', 'fec0::/10', 'fc00::/7', '0.0.0.0/8', '224.0.0.0/4', '240.0.0.0/4', '::/128', 'ff00::/8', '100::/64',
]

// ---------------------------------------------------------------- the rules

export interface EgressRules {
  /** Port rule: 80 and 443 only. */
  checkPort(port: number): Verdict
  /** Name rule, before resolving (names only; literals go through checkAddress). */
  checkName(host: string, port: number): Verdict
  /** Address rule, for literals and every resolver answer. */
  checkAddress(ip: string | Addr, port: number): Verdict
  /**
   * The whole pre-resolve check for a request target: port, then literal address or name.
   * `addr` is set for literals (no resolving needed; connect to it).
   */
  checkTarget(host: string, port: number): Verdict & { addr?: Addr }
}

/** Lower-case, no trailing dot, no brackets. */
export function normalizeHost(host: string): string {
  let h = host.trim().toLowerCase()
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1)
  while (h.endsWith('.')) h = h.slice(0, -1)
  return h
}

const LABEL = /^(?!-)[a-z0-9_-]{1,63}(?<!-)$/

export function createEgressRules(config: EgressRulesConfig = {}): EgressRules {
  const allow = (config.testAllow ?? []).map(parseCidr).filter((c): c is Cidr => c !== null)
  const hostAddrs = (config.hostAddresses ?? []).map(toAddr).filter((a): a is Addr => a !== null)
  const models = (config.modelServers ?? []).map((m) => ({ host: normalizeHost(m.host), addr: toAddr(m.host), port: m.port }))
  const sameAddr = (a: Addr, b: Addr) => a.v === b.v && a.bytes.every((x, i) => x === b.bytes[i])
  const allowed = (a: Addr) => allow.some((c) => inCidr(a, c))

  function checkPort(port: number): Verdict {
    return ALLOWED_PORTS.includes(port) ? { ok: true, subject: String(port) } : { ok: false, reason: 'port', subject: String(port) }
  }

  function checkName(host: string, port: number): Verdict {
    const h = normalizeHost(host)
    const v = nameReason(h, port)
    return v ? { ok: false, reason: v, subject: h || host } : { ok: true, subject: h }
  }

  function nameReason(h: string, port: number): HostBlockReason | null {
    // The model server and BE names: on every port (the BE answers on one, the model server on another).
    if (models.some((m) => !m.addr && m.host === h && (m.port === port || m.port === 0))) return 'model_server'
    if (THIS_COMPUTER_NAMES.includes(h) || THIS_COMPUTER_SUFFIXES.some((s) => h.endsWith(s))) return 'this_computer'
    if (TAILSCALE_SUFFIXES.some((s) => h.endsWith(s))) return 'tailscale'
    const labels = h.split('.')
    if (!h || labels.some((l) => !LABEL.test(l))) return 'private_name'
    // Single-label names ("router", "nas") only exist on the home network.
    if (labels.length < 2) return 'private_name'
    if (PRIVATE_SUFFIXES.some((s) => h.endsWith(s))) return 'private_name'
    return null
  }

  function classify(a: Addr, port: number): HostBlockReason | null {
    for (const m of models) if (m.addr && sameAddr(m.addr, a) && m.port === port) return 'model_server'
    if (hostAddrs.some((h) => sameAddr(h, a))) return 'this_computer'
    for (const [c, r] of DENY_TABLE) if (inCidr(a, c)) return r
    return null
  }

  function checkAddress(ip: string | Addr, port: number): Verdict {
    const a = typeof ip === 'string' ? toAddr(ip) : ip
    if (!a) return { ok: false, reason: 'reserved', subject: String(ip) }
    const subject = formatAddr(a)
    if (allowed(a)) return { ok: true, subject }
    let reason = classify(a, port)
    const inner = embeddedIPv4(a)
    if (!reason && inner) {
      const v4: Addr = { v: 4, bytes: inner }
      if (!allowed(v4)) reason = classify(v4, port)
    }
    return reason ? { ok: false, reason, subject } : { ok: true, subject }
  }

  /**
   * Precedence (contract review §4 item 9): for an address literal or a name refused before
   * resolving, the address/name reason wins over `port` ("192.168.1.20:8080" is home_network).
   * A public name on a bad port is refused as `port` without resolving.
   */
  function checkTarget(host: string, port: number): Verdict & { addr?: Addr } {
    const lit = parseAddressLiteral(host)
    if (lit === 'invalid') return { ok: false, reason: 'reserved', subject: normalizeHost(host) }
    const first = lit ? { ...checkAddress(lit, port), addr: lit } : checkName(host, port)
    if (!first.ok) return first
    const p = checkPort(port)
    return p.ok ? first : { ...p, subject: first.subject }
  }

  return { checkPort, checkName, checkAddress, checkTarget }
}

/** The proxy's refusal text (M2 contract): "Blocked: 100.101.7.3 is on your Tailscale network". */
export function blockedText(subject: string, reason: HostBlockReason, port?: number): string {
  switch (reason) {
    case 'home_network':
      return `Blocked: ${subject} is on your home network`
    case 'private_name':
      return `Blocked: ${subject} is on your home network`
    case 'tailscale':
      return `Blocked: ${subject} is on your Tailscale network`
    case 'this_computer':
      return `Blocked: ${subject} is this computer`
    case 'model_server':
      return `Blocked: ${subject} is your model server`
    case 'metadata':
      return `Blocked: ${subject} is a cloud metadata address`
    case 'port':
      return `Blocked: port ${port ?? subject} isn't allowed (only 80 and 443)`
    case 'reserved':
      return `Blocked: ${subject} is a reserved address`
  }
}
