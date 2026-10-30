/**
 * BE-P2-13: ac-egressd, AgentControl's egress proxy (M2 plan §5). It runs in its own hardened
 * container (no bot data), attached to every bot's internal `ac-egress-<slug>` network and to one
 * outbound network. Bots reach it only through HTTP(S)_PROXY; it is the only way out.
 *
 *   1. per-run credential (Proxy-Authorization: Basic), bound to the bot's network: the proxy
 *      address the connection arrived on must be the one the credential was granted for → 407
 *   2. ports 80/443 only; 3. names refused before resolving; 4. resolve here, check every
 *      address, connect to a checked one (pinned: no second lookup, so no DNS rebinding);
 *   5. hard-deny list (egress-rules.ts) → 403 "Blocked: …"; 6. a per-credential host log.
 *
 * The BE controls it through a unix socket inside the container only (`podman exec … ctl`, JSON
 * on stdin): no TCP control port, the same on Linux, Mac and Windows.
 *
 * Node built-ins and ./egress-rules.js only: this file is copied into the container as is.
 */
import http from 'node:http'
import net from 'node:net'
import dns from 'node:dns'
import { timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { blockedText, createEgressRules, formatAddr, normalizeHost, parseAddressLiteral, toAddr, type EgressRules, type EgressRulesConfig, type HostBlockReason } from './egress-rules.js'
import type { HostContact } from './shared/types.js'

export const EGRESS_PROXY_PORT = 3128
export const EGRESS_CTL_SOCKET = '/run/egressd/ctl.sock'
/** On every forwarded plain-HTTP request; the BE answers 403 user_only to requests carrying it. */
export const EGRESS_VIA = '1.1 ac-egressd'
/** Response header naming the block reason (403s). */
export const BLOCK_HEADER = 'x-agentcontrol-blocked'
/** Distinct host rows kept per credential (the BE caps runs at 200 rows). */
const MAX_HOST_ROWS = 2000

export interface EgressCredential {
  /** The Basic username. */
  id: string
  /** The Basic password (random, per run or build). Never logged. */
  secret: string
  /** The proxy's own address on the bot's network: connections must arrive on it. */
  proxyAddress: string
  /** The bot (slug) and network it is for (for the log). */
  slug: string
  network: string
  kind: 'run' | 'build' | 'probe'
}

export interface EgressProxyOptions {
  config?: EgressRulesConfig
  /** All addresses for a name (tests inject one; default dns.lookup all). */
  resolve?: (host: string) => Promise<string[]>
  /** Open a TCP connection to a checked address (tests may inject). */
  connect?: (ip: string, port: number) => net.Socket
  connectTimeoutMs?: number
  idleTimeoutMs?: number
  log?: (msg: string) => void
}

export interface EgressProxy {
  server: http.Server
  configure(cfg: EgressRulesConfig): void
  grant(c: EgressCredential): void
  /** Revoke a credential: closes its open tunnels, returns its host log. */
  revoke(id: string): HostContact[]
  hosts(id: string): HostContact[]
  health(): { ok: true; credentials: number; tunnels: number; uptimeSec: number }
  close(): Promise<void>
}

const defaultResolve = async (host: string): Promise<string[]> => {
  const all = await dns.promises.lookup(host, { all: true, verbatim: true })
  return all.map((a) => a.address)
}

/** "::ffff:10.89.0.1" → "10.89.0.1" (Node reports v4 on dual-stack sockets that way). */
export function plainAddress(a: string | undefined): string {
  if (!a) return ''
  const p = toAddr(a)
  if (!p) return a
  if (p.v === 6 && p.bytes.slice(0, 10).every((x) => x === 0) && p.bytes[10] === 0xff && p.bytes[11] === 0xff) return p.bytes.slice(12).join('.')
  return formatAddr(p)
}

/** "host:port" / "[v6]:port" (CONNECT authority) → parts, or null. */
export function parseAuthority(a: string): { host: string; port: number } | null {
  const m = /^\[([^\]]+)\]:(\d{1,5})$/.exec(a) ?? /^([^:[\]]+):(\d{1,5})$/.exec(a)
  if (!m) return null
  const port = Number(m[2])
  if (port < 1 || port > 65535) return null
  return { host: m[1]!.startsWith('[') ? m[1]! : /:/.test(m[1]!) ? `[${m[1]}]` : m[1]!, port }
}

interface CredState {
  c: EgressCredential
  rows: Map<string, HostContact>
  sockets: Set<net.Socket>
}

export function createEgressProxy(opts: EgressProxyOptions = {}): EgressProxy {
  const started = Date.now()
  let rules: EgressRules = createEgressRules(opts.config)
  const resolve = opts.resolve ?? defaultResolve
  const connect = opts.connect ?? ((ip: string, port: number) => net.connect({ host: ip, port }))
  const connectTimeoutMs = opts.connectTimeoutMs ?? 15_000
  const idleTimeoutMs = opts.idleTimeoutMs ?? 120_000
  const log = opts.log ?? (() => {})
  const creds = new Map<string, CredState>()
  let tunnels = 0

  function record(st: CredState, host: string, port: number, ip: string | undefined, blocked: boolean, reason?: HostBlockReason): void {
    const key = `${host}|${port}|${ip ?? ''}|${blocked ? reason ?? 'blocked' : ''}`
    const row = st.rows.get(key)
    if (row) {
      row.count++
      return
    }
    if (st.rows.size >= MAX_HOST_ROWS) return
    st.rows.set(key, { host, ...(port !== 443 ? { port } : {}), ...(ip ? { ip } : {}), count: 1, blocked, ...(reason ? { reason } : {}) })
  }

  function rowsOf(st: CredState | undefined): HostContact[] {
    return st ? [...st.rows.values()].map((r) => ({ ...r })) : []
  }

  /** Check Proxy-Authorization against the credential granted for this proxy address. */
  function authenticate(req: http.IncomingMessage): CredState | null {
    const h = req.headers['proxy-authorization']
    if (typeof h !== 'string') return null
    const m = /^basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(h)
    if (!m) return null
    const text = Buffer.from(m[1]!, 'base64').toString('utf8')
    const i = text.indexOf(':')
    if (i < 1) return null
    const st = creds.get(text.slice(0, i))
    if (!st) return null
    const a = Buffer.from(text.slice(i + 1))
    const b = Buffer.from(st.c.secret)
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null
    // Bound to the bot's network: bot A's credential arriving on bot B's network is refused.
    if (plainAddress(req.socket.localAddress) !== plainAddress(st.c.proxyAddress)) return null
    return st
  }

  type Decision = { ok: true; ips: string[] } | { ok: false; status: number; reason?: HostBlockReason; text: string; ip?: string }

  /** Rules 2–5 for one target. Names are resolved here, and every answer is checked. */
  async function decide(st: CredState, rawHost: string, port: number): Promise<Decision & { host: string }> {
    const lit = parseAddressLiteral(rawHost)
    const host = lit && lit !== 'invalid' ? formatAddr(lit) : normalizeHost(rawHost)
    const t = rules.checkTarget(rawHost, port)
    if (!t.ok) {
      const reason = t.reason!
      record(st, host, port, t.addr ? formatAddr(t.addr) : undefined, true, reason)
      return { ok: false, status: 403, reason, text: blockedText(t.subject, reason, port), host, ...(t.addr ? { ip: formatAddr(t.addr) } : {}) }
    }
    if (t.addr) {
      const ip = formatAddr(t.addr)
      record(st, host, port, ip, false)
      return { ok: true, ips: [ip], host }
    }
    let answers: string[]
    try {
      answers = await resolve(host)
    } catch (err) {
      return { ok: false, status: 502, text: `Couldn't find ${host} (${(err as NodeJS.ErrnoException).code ?? 'DNS error'})`, host }
    }
    if (!answers.length) return { ok: false, status: 502, text: `Couldn't find ${host}`, host }
    // Every answer must pass (a name that resolves to public and private addresses is refused).
    for (const a of answers) {
      const v = rules.checkAddress(a, port)
      if (!v.ok) {
        record(st, host, port, v.subject, true, v.reason)
        return { ok: false, status: 403, reason: v.reason!, text: blockedText(v.subject, v.reason!, port), host, ip: v.subject }
      }
    }
    const ips = answers.map((a) => formatAddr(toAddr(a)!))
    record(st, host, port, ips[0], false)
    return { ok: true, ips, host }
  }

  /** Connect to the first checked address that answers (pinned: never re-resolved). */
  function dial(ips: string[], port: number): Promise<net.Socket> {
    return new Promise((resolveP, reject) => {
      let i = 0
      const next = (lastErr?: Error) => {
        const ip = ips[i++]
        if (ip === undefined) return reject(lastErr ?? new Error('no address'))
        const s = connect(ip, port)
        const timer = setTimeout(() => s.destroy(new Error('connect timeout')), connectTimeoutMs)
        s.once('connect', () => {
          clearTimeout(timer)
          s.removeAllListeners('error')
          resolveP(s)
        })
        s.once('error', (err) => {
          clearTimeout(timer)
          s.destroy()
          next(err)
        })
      }
      next()
    })
  }

  function track(st: CredState, ...socks: net.Socket[]): void {
    tunnels++
    for (const s of socks) {
      st.sockets.add(s)
      s.setTimeout(idleTimeoutMs, () => s.destroy())
      s.on('error', () => s.destroy())
    }
    let closed = 0
    for (const s of socks)
      s.once('close', () => {
        st.sockets.delete(s)
        for (const o of socks) o.destroy()
        if (++closed === 1) tunnels--
      })
  }

  const plain = (status: number, text: string, extra: Record<string, string> = {}): string => {
    const body = `${text}\n`
    const head = Object.entries({ 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': String(Buffer.byteLength(body)), Connection: 'close', ...extra })
      .map(([k, v]) => `${k}: ${v}`)
      .join('\r\n')
    return `HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? ''}\r\n${head}\r\n\r\n${body}`
  }
  const AUTH_TEXT = 'AgentControl\'s internet proxy needs this run\'s credential (it ends with the run).'
  const AUTH_HEADERS = { 'Proxy-Authenticate': 'Basic realm="AgentControl"' }

  const server = http.createServer()
  server.headersTimeout = 20_000
  server.requestTimeout = 0

  // CONNECT host:port (TLS, and anything else tunnelled).
  server.on('connect', (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    client.on('error', () => client.destroy())
    const st = authenticate(req)
    if (!st) return void client.end(plain(407, AUTH_TEXT, AUTH_HEADERS))
    const target = parseAuthority(req.url ?? '')
    if (!target) return void client.end(plain(400, 'CONNECT needs host:port.'))
    void (async () => {
      const d = await decide(st, target.host, target.port)
      if (!d.ok) return void client.end(plain(d.status, d.text, d.reason ? { [BLOCK_HEADER]: d.reason } : {}))
      if (!creds.has(st.c.id)) return void client.end(plain(407, AUTH_TEXT, AUTH_HEADERS))
      let upstream: net.Socket
      try {
        upstream = await dial(d.ips, target.port)
      } catch (err) {
        return void client.end(plain(502, `Couldn't connect to ${d.host}: ${(err as Error).message}`))
      }
      if (!creds.has(st.c.id) || client.destroyed) {
        upstream.destroy()
        return void client.destroy()
      }
      track(st, client, upstream)
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      client.pipe(upstream)
      upstream.pipe(client)
    })().catch((err: Error) => {
      log(`egressd: CONNECT failed: ${err.message}`)
      client.destroy()
    })
  })

  // Absolute-form plain HTTP (http://host/path).
  const HOP = new Set(['proxy-authorization', 'proxy-connection', 'connection', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'via'])
  server.on('request', (req: http.IncomingMessage, res: http.ServerResponse) => {
    const send = (status: number, text: string, extra: Record<string, string> = {}) => {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close', ...extra })
      res.end(`${text}\n`)
    }
    const st = authenticate(req)
    if (!st) return send(407, AUTH_TEXT, AUTH_HEADERS)
    let url: URL
    try {
      url = new URL(req.url ?? '')
    } catch {
      return send(400, 'Send absolute URLs (http://host/path) to the proxy; use CONNECT for https.')
    }
    if (url.protocol !== 'http:') return send(400, 'Only http:// URLs here; https goes through CONNECT.')
    const port = url.port ? Number(url.port) : 80
    void (async () => {
      const d = await decide(st, url.hostname, port)
      if (!d.ok) return send(d.status, d.text, d.reason ? { [BLOCK_HEADER]: d.reason } : {})
      let sock: net.Socket
      try {
        sock = await dial(d.ips, port)
      } catch (err) {
        return send(502, `Couldn't connect to ${d.host}: ${(err as Error).message}`)
      }
      if (!creds.has(st.c.id)) {
        sock.destroy()
        return send(407, AUTH_TEXT, AUTH_HEADERS)
      }
      const headers: http.OutgoingHttpHeaders = {}
      for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && v !== undefined) headers[k] = v
      headers['via'] = EGRESS_VIA
      headers['connection'] = 'close'
      // No `agent` (agent:false would make a fresh Agent that ignores createConnection and dials
      // on its own): the request goes over the pinned, checked socket only.
      const up = http.request({ createConnection: () => sock, method: req.method, path: `${url.pathname}${url.search}`, headers, setHost: false })
      track(st, req.socket, sock)
      up.on('response', (r) => {
        const out: http.OutgoingHttpHeaders = {}
        for (const [k, v] of Object.entries(r.headers)) if (!HOP.has(k) && v !== undefined) out[k] = v
        out['connection'] = 'close'
        res.writeHead(r.statusCode ?? 502, out)
        r.pipe(res)
      })
      up.on('error', (err) => {
        if (!res.headersSent) send(502, `Couldn't reach ${d.host}: ${err.message}`)
        else res.destroy()
      })
      req.pipe(up)
    })().catch((err: Error) => {
      log(`egressd: request failed: ${err.message}`)
      if (!res.headersSent) send(502, 'The proxy failed.')
    })
  })

  return {
    server,
    configure(cfg) {
      rules = createEgressRules(cfg)
    },
    grant(c) {
      if (!c.id || !c.secret || !c.proxyAddress) throw new Error('credential needs id, secret and proxyAddress')
      const old = creds.get(c.id)
      creds.set(c.id, { c: { ...c, proxyAddress: plainAddress(c.proxyAddress) }, rows: old?.rows ?? new Map(), sockets: old?.sockets ?? new Set() })
    },
    revoke(id) {
      const st = creds.get(id)
      creds.delete(id)
      if (st) for (const s of st.sockets) s.destroy()
      return rowsOf(st)
    },
    hosts: (id) => rowsOf(creds.get(id)),
    health: () => ({ ok: true, credentials: creds.size, tunnels, uptimeSec: Math.round((Date.now() - started) / 1000) }),
    close: () =>
      new Promise<void>((r) => {
        for (const st of creds.values()) for (const s of st.sockets) s.destroy()
        server.close(() => r())
        server.closeAllConnections?.()
      }),
  }
}

// ---------------------------------------------------------------- control socket

export type CtlRequest =
  | { op: 'health' }
  | { op: 'config'; config: EgressRulesConfig }
  | { op: 'grant'; credential: EgressCredential }
  | { op: 'revoke'; id: string }
  | { op: 'hosts'; id: string }

export function handleCtl(proxy: EgressProxy, req: CtlRequest): unknown {
  switch (req.op) {
    case 'health':
      return proxy.health()
    case 'config':
      proxy.configure(req.config ?? {})
      return { ok: true }
    case 'grant':
      proxy.grant(req.credential)
      return { ok: true }
    case 'revoke':
      return { ok: true, hosts: proxy.revoke(req.id) }
    case 'hosts':
      return { ok: true, hosts: proxy.hosts(req.id) }
    default:
      throw new Error(`unknown op ${(req as { op?: string }).op ?? ''}`)
  }
}

/** One JSON request per connection, one JSON answer back. */
export function createCtlServer(proxy: EgressProxy, socketPath: string): net.Server {
  mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 })
  rmSync(socketPath, { force: true })
  const srv = net.createServer((s) => {
    let buf = ''
    s.setEncoding('utf8')
    s.on('error', () => s.destroy())
    s.on('data', (chunk: string) => {
      buf += chunk
      if (buf.length > 64 * 1024) return void s.end(JSON.stringify({ ok: false, error: 'too big' }))
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      let out: unknown
      try {
        out = handleCtl(proxy, JSON.parse(buf.slice(0, nl)) as CtlRequest)
      } catch (err) {
        out = { ok: false, error: (err as Error).message }
      }
      s.end(`${JSON.stringify(out)}\n`)
    })
  })
  srv.listen(socketPath, () => chmodSync(socketPath, 0o600))
  return srv
}

/** `node egressd.js ctl` with the JSON request on stdin: prints the answer, exit 1 when not ok. */
export async function ctlClient(socketPath: string, input: string): Promise<number> {
  return new Promise((resolveP) => {
    const s = net.connect(socketPath)
    let out = ''
    s.setEncoding('utf8')
    s.on('connect', () => s.write(`${input.trim()}\n`))
    s.on('data', (c: string) => (out += c))
    s.on('error', (err) => {
      process.stdout.write(`${JSON.stringify({ ok: false, error: err.message })}\n`)
      resolveP(1)
    })
    s.on('end', () => {
      process.stdout.write(out)
      try {
        resolveP((JSON.parse(out) as { ok?: boolean }).ok === false ? 1 : 0)
      } catch {
        resolveP(1)
      }
    })
  })
}

async function readStdin(): Promise<string> {
  let s = ''
  for await (const c of process.stdin) s += String(c)
  return s
}

/** Entry point in the container: `node egressd.js serve` or `node egressd.js ctl < request.json`. */
export async function main(argv: string[]): Promise<void> {
  const cmd = argv[0]
  const sock = process.env.AC_EGRESS_CTL ?? EGRESS_CTL_SOCKET
  if (cmd === 'ctl') {
    process.exitCode = await ctlClient(sock, await readStdin())
    return
  }
  if (cmd !== 'serve') {
    process.stderr.write('usage: egressd.js serve | ctl < request.json\n')
    process.exitCode = 2
    return
  }
  const proxy = createEgressProxy({ log: (m) => process.stderr.write(`${m}\n`) })
  proxy.server.listen(Number(process.env.AC_EGRESS_PORT ?? EGRESS_PROXY_PORT), '0.0.0.0')
  createCtlServer(proxy, sock)
  process.stderr.write(`ac-egressd listening on :${EGRESS_PROXY_PORT}\n`)
  const stop = () => void proxy.close().then(() => process.exit(0))
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}

if (process.argv[1] && /egressd\.(js|mjs)$/.test(process.argv[1]) && process.env.AC_EGRESSD_MAIN === '1') void main(process.argv.slice(2))
