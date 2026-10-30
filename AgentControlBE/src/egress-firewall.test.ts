import { describe, expect, it } from 'vitest'
import { cidrText, FIREWALL_TABLE, firewallDrops, firewallImageRef, firewallRuleset } from './egress-firewall.js'
import { DENY_CIDRS, parseCidr } from './egress-rules.js'

/** BE-P2-13 (Charles, M2): the nftables table under the proxy. */
describe('egress firewall ruleset', () => {
  const rs = firewallRuleset({
    config: {
      hostAddresses: ['172.30.0.2', 'fe80::1%eth0', 'not-an-ip'],
      modelServers: [{ host: '127.0.0.1', port: 3001, always: true }, { host: '192.168.1.9', port: 11434 }, { host: '8.8.4.4', port: 443 }, { host: 'ollama.lan', port: 11434 }],
      testAllow: ['10.89.251.0/24'],
    },
    dns: ['10.89.0.1', '[fd00::1]:53', '1.1.1.1:5353', 'bogus; drop'],
  })
  it('replaces the table in one transaction, drops new outbound connections to the blocked sets, keeps replies and DNS', () => {
    expect(rs.split('\n').slice(0, 3)).toEqual([`add table inet ${FIREWALL_TABLE}`, `delete table inet ${FIREWALL_TABLE}`, `table inet ${FIREWALL_TABLE} {`])
    const chain = rs.slice(rs.indexOf('chain output'))
    const lines = chain.split('\n').map((l) => l.trim())
    expect(lines.slice(1, 7)).toEqual([
      'type filter hook output priority 0; policy accept;',
      'ct state established,related accept',
      'ip daddr @dns4 meta l4proto { tcp, udp } th dport 53 accept',
      'ip6 daddr @dns6 meta l4proto { tcp, udp } th dport 53 accept',
      'ip daddr @drop4 counter drop',
      'ip6 daddr @drop6 counter drop',
    ])
  })
  it('drops every deny-table range, this computer, and local model servers given as addresses', () => {
    const d = firewallDrops({ hostAddresses: ['172.30.0.2'], modelServers: [{ host: '127.0.0.1', port: 3001, always: true }, { host: '192.168.1.9', port: 11434 }, { host: '8.8.4.4', port: 443 }] })
    for (const c of DENY_CIDRS) expect([...d.v4, ...d.v6]).toContain(cidrText(parseCidr(c)!))
    expect(d.v4).toEqual(expect.arrayContaining(['172.30.0.2', '127.0.0.1', '192.168.1.9']))
    // A public model API is not local: reachable, as in the proxy's rule.
    expect(d.v4).not.toContain('8.8.4.4')
    expect(rs).toContain('fe80:0:0:0:0:0:0:1')
    expect(rs).not.toContain('not-an-ip')
    expect(rs).not.toContain('ollama')
  })
  it('the test allow list never opens anything here', () => {
    expect(rs).not.toContain('10.89.251')
    expect(rs).toContain('10.0.0.0/8')
  })
  it('DNS exemption: only the resolvers and the gateway, ports stripped, junk ignored', () => {
    expect(rs).toMatch(/set dns4 \{[^}]*elements = \{ 10\.89\.0\.1, 1\.1\.1\.1 \}/)
    expect(rs).toMatch(/set dns6 \{[^}]*elements = \{ fd00:0:0:0:0:0:0:1 \}/)
    expect(rs).not.toMatch(/bogus|;\s*drop\b(?! *$)/m)
  })
  it('empty sets have no elements line (nft rejects `elements = { }`)', () => {
    const r = firewallRuleset({ config: {}, dns: [] })
    expect(r).not.toContain('elements = {  }')
    expect(r).toMatch(/set dns4 \{\n {4}type ipv4_addr\n {4}flags interval\n {4}auto-merge\n {2}\}/)
  })
  it('cidrText re-prints from bytes and clears host bits', () => {
    expect(cidrText(parseCidr('10.1.2.3/8')!)).toBe('10.0.0.0/8')
    expect(cidrText(parseCidr('fd7a:115c:a1e0::/48')!)).toBe('fd7a:115c:a1e0:0:0:0:0:0/48')
    expect(cidrText(parseCidr('169.254.169.254')!)).toBe('169.254.169.254')
  })
  it('helper image ref', () => {
    expect(firewallImageRef('9.9.9')).toBe('localhost/agentcontrol/egressd-nft:9.9.9')
  })
})
