import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { chatCompletion, fetchModels } from './upstream.js'

/** Hermetic: a fake upstream plus a tiny forward proxy, both on 127.0.0.1. */
const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))))
})

async function listen(server: Server): Promise<string> {
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
