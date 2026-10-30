import { describe, expect, it } from 'vitest'
import { blockedText, createEgressRules, DENY_CIDRS, DENY_TABLE, embeddedIPv4, formatAddr, normalizeHost, parseAddressLiteral, parseCidr, parseIPv4Loose, parseIPv6, toAddr } from './egress-rules.js'
import { HOST_BLOCK_REASONS } from './shared/types.js'

/** BE-P2-13: the proxy's pure host / IP / port rules (plan §5, M2 contract "Block reasons"). */
const rules = createEgressRules({
  hostAddresses: ['192.0.2.10', '2001:db8::10'],
  modelServers: [{ host: 'llm.example.com', port: 8443 }, { host: '203.0.113.7', port: 11434 }, { host: 'models.example.org', port: 0 }],
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
    const seen = new Set([...rows.map(([, r]) => r), reasonOf('pypi.org', 22), reasonOf('nas.lan'), reasonOf('203.0.113.7', 11434)])
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
  it('model server: the address on its port only; this computer on any port', () => {
    expect(rules.checkAddress('203.0.113.7', 11434)).toMatchObject({ ok: false, reason: 'model_server' })
    expect(rules.checkAddress('203.0.113.7', 443).ok).toBe(true)
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
    ['LLM.example.com.', 'model_server'],
  ])('%s → %s', (name, reason) => {
    const port = name.toLowerCase().startsWith('llm') ? 8443 : 443
    const v = rules.checkTarget(name, port)
    expect(v).toMatchObject({ ok: false, reason })
    expect(v.addr).toBeUndefined()
  })
  it('a model server name with port 0 is refused on every port; with a port, only there', () => {
    expect(reasonOf('models.example.org', 443)).toBe('model_server')
    expect(reasonOf('llm.example.com', 443)).toBeNull()
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
