import http from 'node:http'
import net from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BLOCK_HEADER, createCtlServer, createEgressProxy, ctlClient, EGRESS_VIA, handleCtl, parseAuthority, plainAddress, type EgressCredential, type EgressProxy } from './egressd.js'

/** BE-P2-13: ac-egressd in process (CONNECT and plain HTTP, credential, pinned connect, host log). */

const PUBLIC = '93.184.216.34'
const cred = (over: Partial<EgressCredential> = {}): EgressCredential => ({ id: 'acA', secret: 's3cret-a', proxyAddress: '127.0.0.1', slug: 'a', network: 'ac-egress-a', kind: 'run', ...over })
const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`

let upstream: http.Server
let upstreamPort = 0
let seen: { via?: string; auth?: string; path?: string }[] = []
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
    seen.push({ via: req.headers.via as string | undefined, auth: req.headers['proxy-authorization'] as string | undefined, path: req.url })
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
    expect(seen[0]).toEqual({ via: EGRESS_VIA, auth: undefined, path: '/p?q=1' })
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
