import { createServer, request as httpRequest, type Server } from 'node:http'
import { connect as netConnect, createServer as createNetServer, isIP, type AddressInfo, type Server as NetServer } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { buildApp } from './app.js'
import { createStore } from './store.js'
import { chatCompletion, fetchModels } from './upstream.js'

/** Hermetic: a fake upstream plus a tiny forward proxy, both on 127.0.0.1. */
const servers: (Server | NetServer)[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))))
})

async function listen(server: Server | NetServer): Promise<string> {
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

function fakeUpstream() {
  return createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url?.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'm1' }] }))
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () =>
      res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: `echo ${JSON.parse(body).model}` } }] })),
    )
  })
}

/** Plain-HTTP forward proxy: records each absolute-form request it relays. */
function forwardProxy(seen: string[]) {
  return createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`)
    const target = new URL(req.url ?? '')
    const out = httpRequest(target, { method: req.method, headers: req.headers }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers)
      up.pipe(res)
    })
    req.pipe(out)
  }).on('connect', (req, socket) => {
    // undici tunnels through CONNECT; relay raw bytes.
    seen.push(`CONNECT ${req.url}`)
    const [host, port] = (req.url ?? '').split(':')
    import('node:net').then(({ connect }) => {
      const upstream = connect(Number(port), host, () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        upstream.pipe(socket)
        socket.pipe(upstream)
      })
    })
  })
}

describe('endpoint proxyUrl', () => {
  it('sends chat and model calls through the proxy when set', async () => {
    const upstream = await listen(fakeUpstream())
    const seen: string[] = []
    const proxy = await listen(forwardProxy(seen))

    const models = await fetchModels(upstream, undefined, proxy)
    expect(models).toMatchObject({ ok: true, models: ['m1'] })
    const chat = await chatCompletion(upstream, undefined, 'm1', [{ role: 'user', content: 'hi' }], 5000,
      undefined, undefined, undefined, undefined, proxy)
    expect(chat).toMatchObject({ ok: true, content: 'echo m1' })
    expect(seen.length).toBeGreaterThanOrEqual(2)
    expect(seen.every((line) => line.includes(new URL(upstream).host))).toBe(true)
  })

  it('goes direct without a proxy', async () => {
    const upstream = await listen(fakeUpstream())
    const chat = await chatCompletion(upstream, undefined, 'm1', [{ role: 'user', content: 'hi' }], 5000)
    expect(chat).toMatchObject({ ok: true, content: 'echo m1' })
  })

  it('reports an unreachable proxy as a failed call', async () => {
    const upstream = await listen(fakeUpstream())
    const chat = await chatCompletion(upstream, undefined, 'm1', [{ role: 'user', content: 'hi' }], 3000,
      undefined, undefined, undefined, undefined, 'http://127.0.0.1:9')
    expect(chat.ok).toBe(false)
  })
})

/**
 * Minimal SOCKS5 server (no auth, CONNECT only). It records the address type
 * and target each client asks for, then always dials the fake upstream on
 * 127.0.0.1, so the test does not depend on how "localhost" resolves.
 */
function socks5Server(seen: { atyp: number; host: string; port: number }[], upstreamPort: () => number) {
  return createNetServer((socket) => {
    let stage = 0
    socket.once('data', function greet(chunk) {
      if (chunk[0] !== 5) return socket.destroy()
      socket.write(Buffer.from([5, 0]))
      stage = 1
      socket.once('data', (req) => {
        const atyp = req[3]!
        let host = ''
        let offset = 4
        if (atyp === 1) { host = [...req.subarray(4, 8)].join('.'); offset = 8 }
        else if (atyp === 3) { const len = req[4]!; host = req.subarray(5, 5 + len).toString(); offset = 5 + len }
        else if (atyp === 4) { host = 'ipv6'; offset = 20 }
        const port = req.readUInt16BE(offset)
        seen.push({ atyp, host, port })
        const out = netConnect(upstreamPort(), '127.0.0.1', () => {
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]))
          out.pipe(socket)
          socket.pipe(out)
        })
        out.on('error', () => socket.destroy())
      })
    })
    socket.on('error', () => undefined)
    void stage
  })
}

describe('endpoint SOCKS5 proxy (BE-11)', () => {
  async function setup() {
    const upstreamServer = fakeUpstream()
    const upstream = await listen(upstreamServer)
    const port = Number(new URL(upstream).port)
    const seen: { atyp: number; host: string; port: number }[] = []
    const socks = await listen(socks5Server(seen, () => port))
    const socksPort = new URL(socks).port
    // Use a name, not an IP, so socks5 and socks5h differ in what they send.
    return { target: `http://localhost:${port}`, port, seen, socksPort }
  }

  it('socks5h:// sends the target name for the proxy to resolve, for models and chat', async () => {
    const { target, port, seen, socksPort } = await setup()
    const proxy = `socks5h://127.0.0.1:${socksPort}`
    expect(await fetchModels(target, undefined, proxy)).toMatchObject({ ok: true, models: ['m1'] })
    const chat = await chatCompletion(target, undefined, 'm1', [{ role: 'user', content: 'hi' }], 5000,
      undefined, undefined, undefined, undefined, proxy)
    expect(chat).toMatchObject({ ok: true, content: 'echo m1' })
    expect(seen.length).toBeGreaterThanOrEqual(1)
    expect(seen.every((s) => s.atyp === 3 && s.host === 'localhost' && s.port === port)).toBe(true)
  })

  it('socks5:// resolves the target here and sends the proxy an IP', async () => {
    const { target, port, seen, socksPort } = await setup()
    const proxy = `socks5://127.0.0.1:${socksPort}`
    expect(await fetchModels(target, undefined, proxy)).toMatchObject({ ok: true, models: ['m1'] })
    const chat = await chatCompletion(target, undefined, 'm1', [{ role: 'user', content: 'hi' }], 5000,
      undefined, undefined, undefined, undefined, proxy)
    expect(chat).toMatchObject({ ok: true, content: 'echo m1' })
    expect(seen.length).toBeGreaterThanOrEqual(1)
    expect(seen.every((s) => s.atyp !== 3 && s.port === port)).toBe(true)
    expect(seen.every((s) => s.atyp === 4 || isIP(s.host) !== 0)).toBe(true)
  })

  it('routes the endpoint test and model listing routes through the SOCKS proxy', async () => {
    const { target, seen, socksPort } = await setup()
    vi.stubEnv('AGENTCONTROL_SECRET', 'proxy-test-secret')
    vi.stubEnv('AGENTCONTROL_AUTH_TOKEN', '')
    const dir = mkdtempSync(join(tmpdir(), 'agentcontrol-proxy-'))
    const app = buildApp(createStore(join(dir, 'store.json')))
    try {
      const created = await app.inject({ method: 'POST', url: '/api/endpoints', payload: {
        kind: 'openai-compatible', name: 'Via SOCKS', baseUrl: target, defaultModel: 'm1', contextWindow: 8192,
        proxyUrl: `socks5h://127.0.0.1:${socksPort}`,
      } })
      expect(created.statusCode).toBe(201)
      const id = (created.json() as { id: string }).id
      const test = await app.inject({ method: 'POST', url: `/api/endpoints/${id}/test` })
      expect(test.json()).toMatchObject({ ok: true })
      const models = await app.inject({ method: 'GET', url: `/api/endpoints/${id}/models` })
      expect(models.statusCode).toBe(200)
      expect(seen.length).toBeGreaterThanOrEqual(2)
    } finally {
      await app.close()
      rmSync(dir, { recursive: true, force: true })
      vi.unstubAllEnvs()
    }
  })

  it('reports an unreachable SOCKS proxy as a failed call', async () => {
    const upstream = await listen(fakeUpstream())
    const chat = await chatCompletion(upstream, undefined, 'm1', [{ role: 'user', content: 'hi' }], 3000,
      undefined, undefined, undefined, undefined, 'socks5h://127.0.0.1:9')
    expect(chat.ok).toBe(false)
  })
})
