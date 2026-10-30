import http from 'node:http'
import net from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BLOCK_HEADER, configHash, createCtlServer, createEgressProxy, ctlClient, EGRESS_VIA, handleCtl, NOT_READY_TEXT, parseAuthority, plainAddress, type EgressCredential, type EgressProxy } from './egressd.js'

/** BE-P2-13: ac-egressd in process (CONNECT and plain HTTP, credential, pinned connect, host log). */

const PUBLIC = '93.184.216.34'
const cred = (over: Partial<EgressCredential> = {}): EgressCredential => ({ id: 'acA', secret: 's3cret-a', proxyAddress: '127.0.0.1', slug: 'a', network: 'ac-egress-a', kind: 'run', ...over })
const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`

let upstream: http.Server
let upstreamPort = 0
let seen: { via?: string; auth?: string; path?: string; host?: string }[] = []
let proxy: EgressProxy
let proxyPort = 0
let resolved: string[] = []
let dialed: string[] = []
let answers: Record<string, string[][]> = {}

beforeEach(async () => {
  seen = []
  resolved = []
  dialed = []
  answers = { 'site.example.com': [[PUBLIC]], 'v6.example.com': [['2606:4700::1111']] }
  upstream = http.createServer((req, res) => {
    seen.push({ host: req.headers.host, via: req.headers.via as string | undefined, auth: req.headers['proxy-authorization'] as string | undefined, path: req.url })
    res.end('hello from upstream')
  })
  // A raw TCP echo of the first line for CONNECT tunnels goes through the same server (HTTP over the tunnel).
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r))
  upstreamPort = (upstream.address() as net.AddressInfo).port
  proxy = createEgressProxy({
    config: { hostAddresses: ['192.0.2.10'] },
    resolve: async (h) => {
      resolved.push(h)
      const list = answers[h]
      if (!list) throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' })
      return list.length > 1 ? list.shift()! : list[0]!
    },
    // Every checked public address is a stand-in for the local upstream.
    connect: (ip, port) => {
      dialed.push(`${ip}:${port}`)
      return net.connect({ host: '127.0.0.1', port: upstreamPort })
    },
    connectTimeoutMs: 2000,
  })
  proxy.grant(cred())
  await new Promise<void>((r) => proxy.server.listen(0, '0.0.0.0', r))
  proxyPort = (proxy.server.address() as net.AddressInfo).port
})

afterEach(async () => {
  await proxy.close()
  await new Promise<void>((r) => upstream.close(() => r()))
})

/** CONNECT through the proxy; resolves the status line and (when 200) a socket. */
function connectVia(target: string, auth: string | null, via = '127.0.0.1'): Promise<{ status: number; body: string; headers: string; sock: net.Socket }> {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: via, port: proxyPort })
    let buf = ''
    s.on('error', reject)
    s.on('connect', () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ''}\r\n`))
    const onData = (c: Buffer) => {
      buf += c.toString('latin1')
      const end = buf.indexOf('\r\n\r\n')
      if (end < 0) return
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(buf)?.[1])
      if (status === 200) {
        s.off('data', onData)
        return resolve({ status, body: '', headers: buf.slice(0, end), sock: s })
      }
      s.on('end', () => resolve({ status, body: buf.slice(end + 4), headers: buf.slice(0, end), sock: s }))
    }
    s.on('data', onData)
  })
}

/** Plain HTTP through the proxy (absolute-form). */
function getVia(url: string, auth: string | null, extra: Record<string, string> = {}): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, path: url, headers: { ...(auth ? { 'proxy-authorization': auth } : {}), ...extra }, agent: false }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }))
    })
    req.on('error', reject)
    req.end()
  })
}

const A = basic('acA', 's3cret-a')

describe('credential (rule 1)', () => {
  it('407 without, with a wrong secret, or an unknown id', async () => {
    expect((await connectVia('site.example.com:443', null)).status).toBe(407)
    expect((await connectVia('site.example.com:443', basic('acA', 'nope'))).status).toBe(407)
    expect((await connectVia('site.example.com:443', basic('acZ', 's3cret-a'))).status).toBe(407)
    expect((await getVia('http://site.example.com/', null)).status).toBe(407)
    expect(resolved).toEqual([])
  })
  it('is bound to the proxy address of its bot network: bot A\'s credential on another address gets 407', async () => {
    proxy.grant(cred({ id: 'acB', secret: 's3cret-b', proxyAddress: '127.0.0.2', slug: 'b', network: 'ac-egress-b' }))
    expect((await connectVia('site.example.com:443', A, '127.0.0.2')).status).toBe(407)
    const ok = await connectVia('site.example.com:443', basic('acB', 's3cret-b'), '127.0.0.2')
    expect(ok.status).toBe(200)
    ok.sock.destroy()
  })
  it('revoke closes open tunnels, refuses the credential afterwards and returns the host log', async () => {
    const t = await connectVia('site.example.com:443', A)
    expect(t.status).toBe(200)
    const closed = new Promise<void>((r) => t.sock.on('close', () => r()))
    const rows = proxy.revoke('acA')
    await closed
    expect(rows).toEqual([{ host: 'site.example.com', ip: PUBLIC, count: 1, blocked: false }])
    expect((await connectVia('site.example.com:443', A)).status).toBe(407)
    expect(proxy.hosts('acA')).toEqual([])
  })
})

describe('CONNECT', () => {
  it('tunnels to a checked address and logs the host', async () => {
    const t = await connectVia('site.example.com:443', A)
    expect(t.status).toBe(200)
    const reply = await new Promise<string>((r) => {
      let b = ''
      t.sock.on('data', (c) => (b += c))
      t.sock.on('end', () => r(b))
      t.sock.write('GET /through HTTP/1.1\r\nHost: site.example.com\r\nConnection: close\r\n\r\n')
    })
    expect(reply).toContain('hello from upstream')
    expect(seen[0]).toMatchObject({ path: '/through', auth: undefined })
    expect(dialed).toEqual([`${PUBLIC}:443`])
    expect(proxy.hosts('acA')).toEqual([{ host: 'site.example.com', ip: PUBLIC, count: 1, blocked: false }])
  })
  it('IPv6 literals and answers are checked too', async () => {
    const t = await connectVia('v6.example.com:443', A)
    expect(t.status).toBe(200)
    t.sock.destroy()
    const r = await connectVia('[::1]:443', A)
    expect(r.status).toBe(403)
    expect(r.body).toContain('Blocked: ::1 is this computer')
    expect((await connectVia('[::ffff:192.168.1.1]:443', A)).headers).toContain(`${BLOCK_HEADER}: home_network`)
  })
  it('refused names never resolve and carry no ip', async () => {
    const r = await connectVia('nas.tail1234.ts.net:443', A)
    expect(r.status).toBe(403)
    expect(r.body.trim()).toBe('Blocked: nas.tail1234.ts.net is on your Tailscale network')
    expect((await connectVia('host.containers.internal:3001', A)).headers).toContain(`${BLOCK_HEADER}: this_computer`)
    expect((await connectVia('metrics.internal.lan:443', A)).headers).toContain(`${BLOCK_HEADER}: private_name`)
    expect(resolved).toEqual([])
    const rows = proxy.hosts('acA')
    expect(rows.every((h) => h.blocked && !('ip' in h))).toBe(true)
    expect(rows.find((h) => h.host === 'host.containers.internal')).toEqual({ host: 'host.containers.internal', port: 3001, count: 1, blocked: true, reason: 'this_computer' })
  })
  it('a public name on a bad port is refused as port, without resolving', async () => {
    const r = await connectVia('site.example.com:22', A)
    expect(r.status).toBe(403)
    expect(r.headers).toContain(`${BLOCK_HEADER}: port`)
    expect(resolved).toEqual([])
    expect(proxy.hosts('acA')).toEqual([{ host: 'site.example.com', port: 22, count: 1, blocked: true, reason: 'port' }])
  })
  it('an IP literal on a bad port is refused for the address, not the port', async () => {
    expect((await connectVia('192.168.1.20:8080', A)).headers).toContain(`${BLOCK_HEADER}: home_network`)
    expect(proxy.hosts('acA')).toEqual([{ host: '192.168.1.20', port: 8080, ip: '192.168.1.20', count: 1, blocked: true, reason: 'home_network' }])
  })
  it('a name with any private answer is refused (every answer is checked)', async () => {
    answers['mixed.example.com'] = [[PUBLIC, '10.0.0.5']]
    const r = await connectVia('mixed.example.com:443', A)
    expect(r.status).toBe(403)
    expect(r.body).toContain('Blocked: 10.0.0.5 is on your home network')
    expect(dialed).toEqual([])
    expect(proxy.hosts('acA')).toEqual([{ host: 'mixed.example.com', ip: '10.0.0.5', count: 1, blocked: true, reason: 'home_network' }])
  })
  it('DNS rebinding: one lookup, and the connection goes to the address that was checked', async () => {
    answers['rebind.example.com'] = [[PUBLIC], ['127.0.0.1']]
    const t = await connectVia('rebind.example.com:443', A)
    expect(t.status).toBe(200)
    t.sock.destroy()
    expect(resolved).toEqual(['rebind.example.com'])
    expect(dialed).toEqual([`${PUBLIC}:443`])
    // The next lookup returns the local address: refused before any connect.
    expect((await connectVia('rebind.example.com:443', A)).status).toBe(403)
    expect(dialed).toEqual([`${PUBLIC}:443`])
  })
  it('obfuscated loopback, metadata and the gvproxy gateway are refused', async () => {
    for (const [t, reason] of [['2130706433:443', 'this_computer'], ['0x7f.1:443', 'this_computer'], ['169.254.169.254:80', 'metadata'], ['192.168.127.254:443', 'this_computer'], ['192.0.2.10:443', 'this_computer'], ['[fe80::1]:443', 'home_network']] as const) {
      expect((await connectVia(t, A)).headers).toContain(`${BLOCK_HEADER}: ${reason}`)
    }
    expect(dialed).toEqual([])
  })
  it('unknown names: 502 and nothing dialed', async () => {
    const r = await connectVia('nx.example.com:443', A)
    expect(r.status).toBe(502)
    expect(dialed).toEqual([])
  })
  it('a malformed CONNECT target is 400', async () => {
    expect((await connectVia('site.example.com', A)).status).toBe(400)
  })
})

describe('plain HTTP', () => {
  it('forwards with Via, strips Proxy-Authorization, logs port 80', async () => {
    const r = await getVia('http://site.example.com/p?q=1', A)
    expect(r.body).toBe('hello from upstream')
    expect(r.status).toBe(200)
    expect(r.body).toBe('hello from upstream')
    expect(seen[0]).toEqual({ host: 'site.example.com', via: EGRESS_VIA, auth: undefined, path: '/p?q=1' })
    expect(dialed).toEqual([`${PUBLIC}:80`])
    expect(proxy.hosts('acA')).toEqual([{ host: 'site.example.com', port: 80, ip: PUBLIC, count: 1, blocked: false }])
  })
  it('a forged Via from the script is replaced, not passed along', async () => {
    await getVia('http://site.example.com/', A, { via: '1.1 something-else' })
    expect(seen[0]!.via).toBe(EGRESS_VIA)
  })
  it('refuses blocked targets with the contract text and the reason header', async () => {
    const r = await getVia('http://10.0.0.12/', A)
    expect(r.status).toBe(403)
    expect(r.body.trim()).toBe('Blocked: 10.0.0.12 is on your home network')
    expect(r.headers[BLOCK_HEADER]).toBe('home_network')
    expect((await getVia('http://localhost:3001/api/permissions', A)).headers[BLOCK_HEADER]).toBe('this_computer')
  })
  it('only absolute http:// URLs', async () => {
    expect((await getVia('/relative', A)).status).toBe(400)
  })
  it('counts repeats on one row', async () => {
    await getVia('http://site.example.com/1', A)
    await getVia('http://site.example.com/2', A)
    expect(proxy.hosts('acA')).toEqual([{ host: 'site.example.com', port: 80, ip: PUBLIC, count: 2, blocked: false }])
  })
})

describe('control socket', () => {
  it('health, config, grant, hosts, revoke; errors are ok:false', async () => {
    expect(handleCtl(proxy, { op: 'health' })).toMatchObject({ ok: true, credentials: 1 })
    expect(() => handleCtl(proxy, { op: 'nope' } as never)).toThrow(/unknown op/)
    expect(() => handleCtl(proxy, { op: 'grant', credential: { ...cred(), secret: '' } })).toThrow(/needs/)
    const dir = mkdtempSync(join(tmpdir(), 'be13-ctl-'))
    const sock = join(dir, 'ctl.sock')
    const srv = createCtlServer(proxy, sock)
    await new Promise((r) => srv.once('listening', r))
    const out: string[] = []
    const write = process.stdout.write
    process.stdout.write = ((c: string) => (out.push(String(c)), true)) as never
    try {
      expect(await ctlClient(sock, JSON.stringify({ op: 'grant', credential: cred({ id: 'acC', secret: 'c' }) }))).toBe(0)
      expect(await ctlClient(sock, JSON.stringify({ op: 'revoke', id: 'acC' }))).toBe(0)
      expect(await ctlClient(sock, '{"op":"bogus"}')).toBe(1)
      expect(await ctlClient(sock, 'not json')).toBe(1)
    } finally {
      process.stdout.write = write
      srv.close()
      rmSync(dir, { recursive: true, force: true })
    }
    expect(out.join('')).toContain('"hosts":[]')
    expect(out.join('')).not.toContain('"c"')
  })
  it('config is replaced as a whole', async () => {
    handleCtl(proxy, { op: 'config', config: { testAllow: ['10.0.0.0/24'] } })
    answers['lab.example.com'] = [['10.0.0.9']]
    expect((await connectVia('lab.example.com:443', A)).status).toBe(200)
    handleCtl(proxy, { op: 'config', config: {} })
    expect((await connectVia('lab.example.com:443', A)).status).toBe(403)
  })
})

describe('helpers', () => {
  it('parseAuthority / plainAddress', () => {
    expect(parseAuthority('pypi.org:443')).toEqual({ host: 'pypi.org', port: 443 })
    expect(parseAuthority('[::1]:443')).toEqual({ host: '[::1]', port: 443 })
    expect(parseAuthority('pypi.org')).toBeNull()
    expect(parseAuthority('a:70000')).toBeNull()
    expect(plainAddress('::ffff:10.89.0.1')).toBe('10.89.0.1')
    expect(plainAddress('10.89.0.1')).toBe('10.89.0.1')
  })
})

describe('review B3: credential lifetime and the connection cap', () => {
  let clock = 1_000_000
  let p: EgressProxy
  let port = 0
  const logs: string[] = []
  const conn = (target: string, auth: string | null) =>
    new Promise<{ status: number; sock: net.Socket }>((resolve, reject) => {
      const s = net.connect({ host: '127.0.0.1', port })
      let buf = ''
      s.on('error', reject)
      s.on('connect', () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ''}\r\n`))
      s.on('data', (c) => {
        buf += c.toString('latin1')
        if (buf.includes('\r\n\r\n')) resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(buf)?.[1]), sock: s })
      })
    })
  beforeEach(async () => {
    clock = 1_000_000
    logs.length = 0
    p = createEgressProxy({
      config: {},
      now: () => clock,
      sweepMs: 0,
      maxConnectionsPerCredential: 3,
      resolve: async () => [PUBLIC],
      connect: () => net.connect({ host: '127.0.0.1', port: upstreamPort }),
      log: (m) => logs.push(m),
    })
    p.grant(cred({ ttlMs: 60_000 }))
    await new Promise<void>((r) => p.server.listen(0, '127.0.0.1', r))
    port = (p.server.address() as net.AddressInfo).port
  })
  afterEach(async () => {
    await p.close()
  })
  it('an expired credential gets 407 even before the sweep', async () => {
    const ok = await conn('site.example.com:443', A)
    expect(ok.status).toBe(200)
    ok.sock.destroy()
    clock += 60_000
    expect((await conn('site.example.com:443', A)).status).toBe(407)
  })
  it('the sweep revokes expired credentials and closes their sockets; the host log stays for the BE', async () => {
    const t = await conn('site.example.com:443', A)
    expect(t.status).toBe(200)
    const closed = new Promise<void>((r) => t.sock.on('close', () => r()))
    clock += 59_999
    expect(p.sweep()).toBe(0)
    clock += 1
    expect(p.sweep()).toBe(1)
    await closed
    expect(logs.join('\n')).toMatch(/acA \(a, run\) expired; revoked and its connections closed/)
    expect(p.health().credentials).toBe(0)
    expect(p.revoke('acA')).toEqual([{ host: 'site.example.com', ip: PUBLIC, count: 1, blocked: false }])
  })
  it('a missing ttl means 90 s (never forever)', async () => {
    p.grant(cred({ id: 'acN', secret: 'n0ttl', ttlMs: undefined }))
    clock += 89_999
    const t = await conn('site.example.com:443', basic('acN', 'n0ttl'))
    expect(t.status).toBe(200)
    t.sock.destroy()
    clock += 1
    expect((await conn('site.example.com:443', basic('acN', 'n0ttl'))).status).toBe(407)
  })
  it('at most N open connections per credential: 429 and a log line; a closed one frees a slot', async () => {
    const open = [await conn('site.example.com:443', A), await conn('site.example.com:443', A), await conn('site.example.com:443', A)]
    expect(open.map((o) => o.status)).toEqual([200, 200, 200])
    expect((await conn('site.example.com:443', A)).status).toBe(429)
    expect(logs.join('\n')).toMatch(/acA \(a, run\) hit the 3-connection cap; refused with 429/)
    const gone = new Promise<void>((r) => open[0]!.sock.on('close', () => r()))
    open[0]!.sock.destroy()
    await gone
    await new Promise((r) => setTimeout(r, 50))
    const again = await conn('site.example.com:443', A)
    expect(again.status).toBe(200)
    for (const o of [...open, again]) o.sock.destroy()
  })
  it('refused attempts (blocked hosts) do not use up slots', async () => {
    for (let i = 0; i < 6; i++) expect((await conn('127.0.0.1:443', A)).status).toBe(403)
    const t = await conn('site.example.com:443', A)
    expect(t.status).toBe(200)
    t.sock.destroy()
  })
  it('revokeAll (ctl) drops every credential and closes its sockets', async () => {
    const t = await conn('site.example.com:443', A)
    const closed = new Promise<void>((r) => t.sock.on('close', () => r()))
    expect(handleCtl(p, { op: 'revokeAll' })).toEqual({ ok: true, revoked: 1 })
    await closed
    expect((await conn('site.example.com:443', A)).status).toBe(407)
  })
})

describe('review S1: no settings, no traffic; health reports the settings hash', () => {
  it('503 "isn\'t ready" until configured; then the hash matches configHash()', async () => {
    const p = createEgressProxy({ resolve: async () => [PUBLIC], connect: () => net.connect({ host: '127.0.0.1', port: upstreamPort }), sweepMs: 0 })
    p.grant(cred())
    await new Promise<void>((r) => p.server.listen(0, '127.0.0.1', r))
    const port = (p.server.address() as net.AddressInfo).port
    try {
      expect(p.health()).toMatchObject({ configured: false, configHash: null })
      const r = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: 'http://site.example.com/', headers: { 'proxy-authorization': A }, agent: false }, (res) => {
          let body = ''
          res.on('data', (c) => (body += c))
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
        })
        req.on('error', reject)
        req.end()
      })
      expect(r).toEqual({ status: 503, body: `${NOT_READY_TEXT}\n` })
      const cfg = { hostAddresses: ['192.0.2.10'] }
      handleCtl(p, { op: 'config', config: cfg })
      expect(p.health()).toMatchObject({ configured: true, configHash: configHash(cfg) })
      expect(Array.isArray(p.health().dns)).toBe(true)
    } finally {
      await p.close()
    }
  })
})

describe('review S6: plain HTTP Host is the checked target', () => {
  it('a client Host for another site is replaced by the URL\'s host', async () => {
    const r = await getVia('http://site.example.com:80/x', A, { host: 'evil.example.net' })
    expect(r.status).toBe(200)
    expect(seen.at(-1)).toMatchObject({ host: 'site.example.com', path: '/x' })
  })
})

describe('item 3: model servers through the proxy', () => {
  it('a public model API is reached; the same name resolving locally is model_server', async () => {
    const p = createEgressProxy({
      config: { modelServers: [{ host: 'api.openai.com', port: 443 }] },
      resolve: async (h) => (h === 'api.openai.com' ? [answers.model![0]![0]!] : [PUBLIC]),
      connect: () => net.connect({ host: '127.0.0.1', port: upstreamPort }),
      sweepMs: 0,
    })
    p.grant(cred())
    await new Promise<void>((r) => p.server.listen(0, '127.0.0.1', r))
    const port = (p.server.address() as net.AddressInfo).port
    const conn = () =>
      new Promise<{ status: number; head: string; sock: net.Socket }>((resolve, reject) => {
        const s = net.connect({ host: '127.0.0.1', port })
        let buf = ''
        s.on('error', reject)
        s.on('connect', () => s.write(`CONNECT api.openai.com:443 HTTP/1.1\r\nProxy-Authorization: ${A}\r\n\r\n`))
        s.on('data', (c) => {
          buf += c.toString('latin1')
          if (buf.includes('\r\n\r\n')) resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(buf)?.[1]), head: buf, sock: s })
        })
      })
    try {
      answers.model = [['104.18.33.45']]
      const pub = await conn()
      expect(pub.status).toBe(200)
      pub.sock.destroy()
      answers.model = [['192.168.1.9']]
      const local = await conn()
      expect(local.status).toBe(403)
      expect(local.head).toContain(`${BLOCK_HEADER}: model_server`)
      expect(local.head).toContain('Blocked: 192.168.1.9 is your model server')
      local.sock.destroy()
    } finally {
      await p.close()
    }
  })
})
