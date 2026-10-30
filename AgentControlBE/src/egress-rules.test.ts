import { describe, expect, it } from 'vitest'
import { blockedText, createEgressRules, DENY_CIDRS, DENY_TABLE, embeddedIPv4, formatAddr, normalizeHost, parseAddressLiteral, parseCidr, parseIPv4Loose, parseIPv6, testAllowCidr, toAddr } from './egress-rules.js'
import { HOST_BLOCK_REASONS } from './shared/types.js'

/** BE-P2-13: the proxy's pure host / IP / port rules (plan §5, M2 contract "Block reasons"). */
const rules = createEgressRules({
  hostAddresses: ['192.0.2.10', '2001:db8::10'],
  modelServers: [
    { host: 'llm.example.com', port: 8443 },
    { host: '192.168.1.50', port: 11434 },
    { host: 'models.example.org', port: 0 },
    { host: 'ollama', port: 11434 },
    { host: 'api.openai.com', port: 443 },
    { host: '127.0.0.1', port: 3001, always: true },
  ],
})
const reasonOf = (host: string, port = 443) => {
  const v = rules.checkTarget(host, port)
  return v.ok ? null : v.reason
}

describe('address parsing', () => {
  it('reads inet_aton-style IPv4 (decimal, octal, hex, short forms)', () => {
    for (const s of ['127.0.0.1', '127.1', '2130706433', '0x7f.1', '0177.0.0.1', '0x7f000001', '127.0.0.1.']) expect(formatAddr(parseIPv4Loose(s) as never)).toBe('127.0.0.1')
    expect(parseIPv4Loose('256.1.1.1')).toBe('invalid')
    expect(parseIPv4Loose('example.com')).toBeNull()
  })
  it('reads IPv6, with embedded IPv4 and compression', () => {
    expect(formatAddr(parseIPv6('::1')!)).toBe('::1')
    expect(formatAddr(parseIPv6('0:0:0:0:0:ffff:7f00:1')!)).toBe('::ffff:7f00:1')
    expect(parseIPv6('::ffff:127.0.0.1')!.bytes.slice(12)).toEqual([127, 0, 0, 1])
    expect(parseIPv6('fe80::1%eth0')).toBeNull()
    expect(parseIPv6('1::2::3')).toBeNull()
  })
  it('tells literals, broken literals and names apart', () => {
    expect(parseAddressLiteral('[::1]')).toMatchObject({ v: 6 })
    expect(parseAddressLiteral('[::1')).toBe('invalid')
    expect(parseAddressLiteral('1.2.3.4.5')).toBe('invalid')
    expect(parseAddressLiteral('999.1')).toBe('invalid')
    expect(parseAddressLiteral('pypi.org')).toBeNull()
  })
  it('finds the IPv4 inside mapped, translated, compatible, NAT64, 6to4 and Teredo addresses', () => {
    const v4 = (s: string) => embeddedIPv4(toAddr(s)!)?.join('.')
    expect(v4('::ffff:10.0.0.1')).toBe('10.0.0.1')
    expect(v4('::ffff:0:10.0.0.1')).toBe('10.0.0.1')
    expect(v4('::10.0.0.1')).toBe('10.0.0.1')
    expect(v4('64:ff9b::a00:1')).toBe('10.0.0.1')
    expect(v4('2002:c0a8:0101::1')).toBe('192.168.1.1')
    expect(v4('2001:0:4136:e378:8000:63bf:f5ff:fffe')).toBe('10.0.0.1')
    expect(v4('2606:4700::1111')).toBeUndefined()
  })
  it('normalises names', () => {
    expect(normalizeHost(' PyPI.org.. ')).toBe('pypi.org')
    expect(normalizeHost('[::1]')).toBe('::1')
  })
  it('the deny table matches its text form', () => {
    expect(DENY_TABLE.map(([c]) => c)).toEqual(DENY_CIDRS.map((c) => parseCidr(c)))
  })
})

describe('hard-deny list (private ranges, IPv4 and IPv6)', () => {
  const rows: [string, string][] = [
    ['169.254.169.254', 'metadata'],
    ['fd00:ec2::254', 'metadata'],
    ['127.0.0.1', 'this_computer'],
    ['127.255.255.254', 'this_computer'],
    ['::1', 'this_computer'],
    ['192.168.127.254', 'this_computer'],
    ['192.0.2.10', 'this_computer'],
    ['2001:db8::10', 'this_computer'],
    ['100.101.7.3', 'tailscale'],
    ['fd7a:115c:a1e0::1', 'tailscale'],
    ['10.0.0.12', 'home_network'],
    ['172.16.5.4', 'home_network'],
    ['172.31.255.255', 'home_network'],
    ['192.168.1.20', 'home_network'],
    ['169.254.1.1', 'home_network'],
    ['fe80::1', 'home_network'],
    ['fec0::1', 'home_network'],
    ['fd12:3456::1', 'home_network'],
    ['0.0.0.0', 'reserved'],
    ['224.0.0.251', 'reserved'],
    ['255.255.255.255', 'reserved'],
    ['::', 'reserved'],
    ['ff02::1', 'reserved'],
    ['100::1', 'reserved'],
  ]
  it.each(rows)('%s → %s', (ip, reason) => {
    expect(rules.checkAddress(ip, 443)).toMatchObject({ ok: false, reason })
  })
  it('every block reason is reachable', () => {
    const seen = new Set([...rows.map(([, r]) => r), reasonOf('pypi.org', 22), reasonOf('nas.lan'), reasonOf('192.168.1.50', 11434)])
    expect([...seen].sort()).toEqual([...HOST_BLOCK_REASONS].sort())
  })
  it('lets public addresses through, IPv4 and IPv6', () => {
    for (const ip of ['93.184.216.34', '1.1.1.1', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111']) expect(rules.checkAddress(ip, 443).ok).toBe(true)
  })
  it('checks the IPv4 carried in an IPv6 address', () => {
    expect(rules.checkAddress('::ffff:127.0.0.1', 443)).toMatchObject({ ok: false, reason: 'this_computer' })
    expect(rules.checkAddress('::ffff:192.168.1.1', 443)).toMatchObject({ ok: false, reason: 'home_network' })
    expect(rules.checkAddress('64:ff9b::a9fe:a9fe', 443)).toMatchObject({ ok: false, reason: 'metadata' })
    expect(rules.checkAddress('2002:7f00:0001::', 443)).toMatchObject({ ok: false, reason: 'this_computer' })
    expect(rules.checkAddress('::ffff:93.184.216.34', 443).ok).toBe(true)
  })
  it('refuses obfuscated literals of local addresses', () => {
    for (const h of ['127.1', '2130706433', '0x7f.0.0.1', '0177.0.0.1', '[::1]', '[::ffff:7f00:1]', '[0:0:0:0:0:0:0:1]']) expect(reasonOf(h)).toBe('this_computer')
    expect(reasonOf('0xa9fea9fe')).toBe('metadata')
    expect(reasonOf('1.2.3.4.5')).toBe('reserved')
  })
  it('model server: a local address on its port is model_server; on another port its own reason', () => {
    expect(rules.checkAddress('192.168.1.50', 11434)).toMatchObject({ ok: false, reason: 'model_server' })
    expect(rules.checkAddress('192.168.1.50', 443)).toMatchObject({ ok: false, reason: 'home_network' })
    expect(rules.checkAddress('::ffff:192.168.1.50', 11434)).toMatchObject({ ok: false, reason: 'home_network' })
  })
  it('item 3: a public model endpoint is reached like any site; a local one is model_server', () => {
    // api.openai.com resolving to a public address: allowed on 443.
    expect(rules.checkTarget('api.openai.com', 443)).toMatchObject({ ok: true })
    expect(rules.checkAddress('104.18.33.45', 443, 'api.openai.com')).toMatchObject({ ok: true })
    expect(rules.checkAddress('104.18.33.45', 8443, 'llm.example.com')).toMatchObject({ ok: true })
    // The same names resolving to a local address: model_server (not home_network).
    expect(rules.checkAddress('192.168.1.9', 443, 'api.openai.com')).toMatchObject({ ok: false, reason: 'model_server', subject: '192.168.1.9' })
    expect(rules.checkAddress('100.100.1.2', 8443, 'LLM.example.com.')).toMatchObject({ ok: false, reason: 'model_server' })
    // A local name (refused before resolving anyway) on its port: model_server.
    expect(reasonOf('ollama', 11434)).toBe('model_server')
    expect(reasonOf('ollama', 443)).toBe('private_name')
    // Metadata stays metadata even if someone configures it as a model server.
    expect(createEgressRules({ modelServers: [{ host: '169.254.169.254', port: 80 }] }).checkAddress('169.254.169.254', 80)).toMatchObject({ reason: 'metadata' })
  })
  it("item 3: the BE's own HOST:PORT is always blocked, whatever the address", () => {
    expect(reasonOf('127.0.0.1', 3001)).toBe('model_server')
    const pub = createEgressRules({ modelServers: [{ host: '93.184.216.34', port: 443, always: true }, { host: 'be.example.net', port: 443, always: true }] })
    expect(pub.checkAddress('93.184.216.34', 443)).toMatchObject({ ok: false, reason: 'model_server' })
    expect(pub.checkTarget('be.example.net', 443)).toMatchObject({ ok: false, reason: 'model_server' })
    expect(pub.checkAddress('93.184.216.34', 80).ok).toBe(true)
  })
  it('review S5: benchmarking, protocol-assignment, 6to4-relay and documentation ranges are reserved', () => {
    for (const ip of ['198.18.0.1', '198.19.255.254', '192.0.0.8', '192.88.99.1', '192.0.2.1', '198.51.100.1', '203.0.113.1', '2001:db8::1', '2001:db8:ffff::1']) expect([ip, rules.checkAddress(ip, 443).reason]).toEqual([ip, 'reserved'])
    expect(rules.checkAddress('198.20.0.1', 443).ok).toBe(true)
  })
  it('review S8: trailing dots on a literal are dropped before the check', () => {
    for (const h of ['127.0.0.1.', '127.0.0.1..', '127.1...']) expect([h, reasonOf(h)]).toEqual([h, 'this_computer'])
    expect(rules.checkTarget('10.1.2.3..', 443)).toMatchObject({ reason: 'home_network', addr: { v: 4 } })
  })
})

describe('names refused before resolving', () => {
  it.each([
    ['localhost', 'this_computer'],
    ['host.containers.internal', 'this_computer'],
    ['host.docker.internal', 'this_computer'],
    ['gateway', 'this_computer'],
    ['app.localhost', 'this_computer'],
    ['nas.tail1234.ts.net', 'tailscale'],
    ['metrics.internal.lan', 'private_name'],
    ['printer.local', 'private_name'],
    ['db.corp.internal', 'private_name'],
    ['router', 'private_name'],
    ['bad_label-.example.com', 'private_name'],
  ])('%s → %s', (name, reason) => {
    const port = name.toLowerCase().startsWith('llm') ? 8443 : 443
    const v = rules.checkTarget(name, port)
    expect(v).toMatchObject({ ok: false, reason })
    expect(v.addr).toBeUndefined()
  })
  it('a public model server name is not refused before resolving (item 3), on any port', () => {
    expect(reasonOf('models.example.org', 443)).toBeNull()
    expect(reasonOf('llm.example.com', 443)).toBeNull()
    expect(reasonOf('LLM.example.com.', 8443)).toBe('port')
  })
  it('public names pass (resolving happens next)', () => {
    expect(rules.checkTarget('pypi.org', 443)).toMatchObject({ ok: true })
    expect(rules.checkTarget('deb.debian.org', 80)).toMatchObject({ ok: true })
  })
})

describe('ports and precedence', () => {
  it('80 and 443 only', () => {
    expect(rules.checkPort(80).ok).toBe(true)
    expect(rules.checkPort(443).ok).toBe(true)
    for (const p of [22, 25, 8080, 3128, 0]) expect(rules.checkPort(p)).toMatchObject({ ok: false, reason: 'port' })
  })
  it('an address or refused name beats port; a public name on a bad port is port', () => {
    expect(reasonOf('192.168.1.20', 8080)).toBe('home_network')
    expect(reasonOf('nas.tail1234.ts.net', 22)).toBe('tailscale')
    expect(reasonOf('localhost', 3001)).toBe('this_computer')
    expect(reasonOf('pypi.org', 8080)).toBe('port')
    expect(reasonOf('93.184.216.34', 8080)).toBe('port')
  })
})

describe('test allow-list', () => {
  it('lets only the listed CIDRs through, IPv4-in-IPv6 included', () => {
    const r = createEgressRules({ testAllow: ['10.89.5.0/24'] })
    expect(r.checkAddress('10.89.5.7', 80).ok).toBe(true)
    expect(r.checkAddress('::ffff:10.89.5.7', 80).ok).toBe(true)
    expect(r.checkAddress('10.89.6.7', 80).ok).toBe(false)
    expect(createEgressRules().checkAddress('10.89.5.7', 80).ok).toBe(false)
  })
  it('review B2: no wider than /24 or /120; wider entries are ignored', () => {
    const r = createEgressRules({ testAllow: ['10.0.0.0/8', '10.89.0.0/23', '192.168.0.0/16', 'fc00::/7', 'fd00::/119', '10.89.7.0/24', 'fd00::100/120', '100.64.1.1'] })
    expect(r.checkAddress('10.1.2.3', 80).ok).toBe(false)
    expect(r.checkAddress('10.89.1.3', 80).ok).toBe(false)
    expect(r.checkAddress('192.168.1.1', 80).ok).toBe(false)
    expect(r.checkAddress('fd00::1', 80).ok).toBe(false)
    expect(r.checkAddress('10.89.7.9', 80).ok).toBe(true)
    expect(r.checkAddress('fd00::1ff', 80).ok).toBe(true)
    expect(r.checkAddress('100.64.1.1', 80).ok).toBe(true)
    expect(testAllowCidr('10.0.0.0/8')).toBeNull()
    expect(testAllowCidr('10.0.0.0/24')).not.toBeNull()
  })
  it('review B2: never opens metadata, this_computer or model_server; only home_network, reserved, tailscale', () => {
    const r = createEgressRules({
      hostAddresses: ['10.89.9.2'],
      modelServers: [{ host: '10.89.9.3', port: 80 }],
      testAllow: ['169.254.169.0/24', '127.0.0.0/24', '10.89.9.0/24', '::1/128', 'fd00:ec2::200/120', '192.0.2.0/24', '100.64.5.0/24'],
    })
    expect(r.checkAddress('169.254.169.254', 80)).toMatchObject({ ok: false, reason: 'metadata' })
    expect(r.checkAddress('fd00:ec2::254', 80)).toMatchObject({ ok: false, reason: 'metadata' })
    expect(r.checkAddress('127.0.0.1', 80)).toMatchObject({ ok: false, reason: 'this_computer' })
    expect(r.checkAddress('::1', 80)).toMatchObject({ ok: false, reason: 'this_computer' })
    expect(r.checkAddress('::ffff:127.0.0.1', 80)).toMatchObject({ ok: false, reason: 'this_computer' })
    expect(r.checkAddress('10.89.9.2', 80)).toMatchObject({ ok: false, reason: 'this_computer' })
    expect(r.checkAddress('10.89.9.3', 80)).toMatchObject({ ok: false, reason: 'model_server' })
    expect(r.checkAddress('10.89.9.4', 80).ok).toBe(true)
    expect(r.checkAddress('192.0.2.5', 80).ok).toBe(true)
    expect(r.checkAddress('100.64.5.5', 80).ok).toBe(true)
  })
})

describe('refusal text (M2 contract)', () => {
  it('names the address, or the name when refused before resolving', () => {
    expect(blockedText('100.101.7.3', 'tailscale')).toBe('Blocked: 100.101.7.3 is on your Tailscale network')
    expect(blockedText('nas.tail1234.ts.net', 'tailscale')).toBe('Blocked: nas.tail1234.ts.net is on your Tailscale network')
    expect(blockedText('192.168.1.20', 'home_network')).toBe('Blocked: 192.168.1.20 is on your home network')
    expect(blockedText('8080', 'port', 8080)).toContain('port 8080')
    for (const r of HOST_BLOCK_REASONS) expect(blockedText('x', r)).toMatch(/^Blocked: /)
  })
})
