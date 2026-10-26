import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from './app.js'
import { createStore } from './store.js'
import { chatCompletion, describeFetchError, fetchModels, redactUrlCredentials } from './upstream.js'

/** Upstream errors never repeat credentials from a baseUrl or proxyUrl. */

const SECRET = 'hunter2-pw'

describe('redactUrlCredentials', () => {
  it('masks user:pass@ and token@ in any URL scheme, and leaves the rest', () => {
    expect(redactUrlCredentials(`GET http://bob:${SECRET}@llm.lan:8080/v1/models failed`)).toBe('GET http://***@llm.lan:8080/v1/models failed')
    expect(redactUrlCredentials(`socks5h://u:${SECRET}@10.0.0.2:1080 and https://tok@x.io/a`)).toBe('socks5h://***@10.0.0.2:1080 and https://***@x.io/a')
    expect(redactUrlCredentials('http://llm.lan/v1?email=a@b.c')).toBe('http://llm.lan/v1?email=a@b.c')
    expect(redactUrlCredentials('mail me at a@b.c')).toBe('mail me at a@b.c')
  })

  it('describeFetchError redacts the message and every cause', () => {
    const err = new TypeError(`Request cannot be constructed from a URL that includes credentials: http://bob:${SECRET}@h/v1`, {
      cause: { code: 'X', message: `proxy socks5://u:${SECRET}@p:1 refused` },
    })
    const text = describeFetchError(err)
    expect(text).not.toContain(SECRET)
    expect(text).toContain('http://***@h/v1')
  })
})

describe('upstream calls with credentials in baseUrl', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('fetchModels and chatCompletion errors carry no password (real fetch rejects such URLs)', async () => {
    const base = `http://bob:${SECRET}@127.0.0.1:9`
    const models = await fetchModels(base)
    expect(models.ok).toBe(false)
    expect(models.error).not.toContain(SECRET)
    const chat = await chatCompletion(base, undefined, 'm', [{ role: 'user', content: 'hi' }], 2_000)
    expect(chat.ok).toBe(false)
    expect(chat.error).not.toContain(SECRET)
  })

  it('an upstream body that echoes the URL is redacted too', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 502, text: async () => `bad gateway for http://bob:${SECRET}@h/v1`, json: async () => ({}) })))
    const chat = await chatCompletion('http://h', undefined, 'm', [{ role: 'user', content: 'hi' }], 2_000)
    expect(chat.error).toContain('502')
    expect(chat.error).not.toContain(SECRET)
  })
})

describe('POST /api/endpoints/:id/test', () => {
  let dir = ''
  let app: ReturnType<typeof buildApp>
  beforeEach(() => {
    vi.stubEnv('AGENTCONTROL_SECRET', 'redact-test-secret')
    vi.stubEnv('AGENTCONTROL_AUTH_TOKEN', '')
    dir = mkdtempSync(join(tmpdir(), 'agentcontrol-redact-'))
    app = buildApp(createStore(join(dir, 'store.json')))
  })
  afterEach(async () => {
    await app.close()
    vi.unstubAllEnvs()
    rmSync(dir, { recursive: true, force: true })
  })

  it('reports unreachable without the password', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/endpoints',
      payload: { kind: 'openai-compatible', name: 'e', baseUrl: `http://bob:${SECRET}@127.0.0.1:9`, defaultModel: 'm', contextWindow: 8192 },
    })
    expect(created.statusCode).toBe(201)
    const res = await app.inject({ method: 'POST', url: `/api/endpoints/${created.json().id}/test` })
    expect(res.json().ok).toBe(false)
    expect(res.body).not.toContain(SECRET)
  })
})
