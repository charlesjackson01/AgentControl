/**
 * BE-P2-19 @mac: the §13 rows that differ on macOS. Run on that OS only, with AC_MAC_TESTS=1 and
 * the agentcontrol machine running with the botvm image (M3 decision 1: nightly once a hosted
 * runner exists; not merge gates). Skipped everywhere else, including Linux @vm runs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createEgressRules } from './egress-rules.js'
import { MAC_TESTS } from './security-coverage.js'
import { botLikeRun, cleanupHostTests, localAddresses, machinePodman, HOST_TEST_LABEL } from './security-host.helpers.js'

describe.skipIf(!MAC_TESTS)('@mac BE-P2-19 security rows', () => {
  beforeAll(() => cleanupHostTests())
  afterAll(() => cleanupHostTests())

  it('bot ↔ bot: two bots in the agentcontrol machine', () => {
    for (const s of ['a', 'b']) expect(machinePodman('volume', 'create', '--label', HOST_TEST_LABEL, `ac-tools-be19${s}`)).not.toBeNull()
    const a = botLikeRun('ac-bot-be19a', 'echo secret-a > /home/bot/marker; cat /proc/self/uid_map; ls /proc | grep -c "^[0-9]"', ['-v', 'ac-tools-be19a:/home/bot'])
    const b = botLikeRun('ac-bot-be19b', 'cat /home/bot/marker 2>&1 || echo none; find / -name marker -path "*be19a*" 2>/dev/null | head -1; cat /proc/self/uid_map', ['-v', 'ac-tools-be19b:/home/bot'])
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    expect(b).toContain('none')
    expect(b).not.toContain('secret-a')
    // --userns auto: each container gets its own host uid range.
    const range = (out: string) => out.split('\n').find((l) => /^\s*0\s+\d+/.test(l))?.trim().split(/\s+/)[1]
    expect(range(a!)).not.toBe(range(b!))
  })

  it('network: LAN and Tailscale addresses of this Mac', () => {
    const rules = createEgressRules({ hostAddresses: localAddresses() })
    const mine = localAddresses()
    expect(mine.length).toBeGreaterThan(0)
    for (const ip of mine) expect(rules.checkAddress(ip, 443).ok, ip).toBe(false)
    for (const ip of ['100.64.0.1', 'fd7a:115c:a1e0::1', '192.168.1.1', '10.0.0.1', '169.254.169.254']) expect(rules.checkAddress(ip, 443).ok, ip).toBe(false)
    // A container with network none has no route to any of them (gvproxy included).
    const out = botLikeRun('ac-bot-be19net', `for ip in ${mine.filter((x) => !x.includes(':')).join(' ')} 192.168.127.1; do (echo > /dev/tcp/$ip/22) 2>/dev/null && echo "open $ip" || echo "closed $ip"; done`, ['--entrypoint', 'bash'])
    expect(out ?? '').not.toMatch(/^open /m)
  })
})
