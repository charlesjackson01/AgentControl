/**
 * BE-P2-13: the BE side of the egress proxy (M2 plan §5). Owns the `ac-egressd` container, the
 * outbound network `ac-egress-out`, each bot's internal network `ac-egress-<slug>` and the per-run
 * (or per-build) proxy credentials. Everything goes through the engine CLI (`podman exec … ctl`
 * with the request on stdin for control): no TCP between the BE and the proxy, so it works the
 * same through `--connection` on Mac/Windows.
 *
 * Network design (Linux rootless, and inside the Podman machine on Mac/Windows):
 * - `ac-egress-<slug>`: `--internal --disable-dns --ipv6=false`. Only the bot's container (and its
 *   tool builds) and ac-egressd are on it. No gateway, no DNS: the proxy is the only peer.
 * - `ac-egress-out`: a normal bridge only ac-egressd is on; its traffic leaves through the engine
 *   (pasta/netavark). The proxy's hard-deny list keeps it off this computer and the home network.
 * - The bot container is never on `host` or the default network.
 */
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execCommandRunner, type CommandResult, type CommandRunner } from './command-runner.js'
import type { EngineRef } from './bot-env.js'
import { testAllowCidr, type EgressRulesConfig } from './egress-rules.js'
import { EGRESS_PROXY_PORT, type EgressCredential } from './egressd.js'
import { SCRIPT_RUN_HOSTS_MAX, type EnvVar, type HostContact } from './shared/types.js'
import { GVPROXY_CIDR, SLIRP_CIDR } from './user-only.js'
import { sharedImageRef } from './vm-images.js'

export const EGRESS_DAEMON_NAME = 'ac-egressd'
export const EGRESS_OUT_NETWORK = 'ac-egress-out'
export const EGRESS_LABEL = 'io.agentcontrol.egress'
const HASH_LABEL = 'io.agentcontrol.egressd.hash'
/** Where the daemon's code is mounted (read-only) in its container. */
const APP_DIR = '/opt/egressd'

/** M2 contract: the run/route text when the proxy can't be used (409 proxy_unavailable). */
export const PROXY_UNAVAILABLE = 'AgentControl\'s internet proxy isn\'t running, so this run couldn\'t get the internet. Try again; if it keeps failing, re-check in Settings › VM.'
export const PROXY_UNAVAILABLE_REASON = 'proxy_unavailable'
/**
 * Test-only: comma-separated CIDRs the proxy lets through (local @vm test servers). Review B2:
 * honoured only with NODE_ENV=test or AC_VM_TESTS=1 (otherwise ignored, with one warning), each at
 * most /24 or /120, and only for home_network / reserved / tailscale (egress-rules.ts).
 */
export const EGRESS_TEST_ALLOW_ENV = 'AC_EGRESS_TEST_ALLOW'
export function egressNetworkName(slug: string): string {
  return `ac-egress-${slug}`
}

export class EgressUnavailableError extends Error {
  readonly reason = PROXY_UNAVAILABLE_REASON
  readonly statusCode = 409
  constructor(readonly detail: string) {
    super(PROXY_UNAVAILABLE)
  }
}

export interface EgressGrant {
  /** Credential id (the Basic username); revoke with it. */
  id: string
  slug: string
  network: string
  /** The proxy's address on the bot's network. */
  proxyAddress: string
  /** HTTP(S)_PROXY and friends, for the run's exec env or a build's --build-arg. */
  env: EnvVar[]
  /** Values to redact from run output and logs (the credential). Never stored. */
  secrets: string[]
}

export interface EgressServiceDeps {
  exec?: CommandRunner
  engine: () => Promise<EngineRef | null>
  /** The proxy's image (default: the shared botvm image, which has node). */
  image?: () => string
  /** Folder for the daemon's code (mounted read-only). */
  stateDir: () => string
  /** Host addresses, model servers / BE, test allow-list. Read on every grant. */
  config?: () => EgressRulesConfig
  /** Test-only: `--add-host name:ip` for the daemon (a test name resolving to a local test server). */
  addHosts?: string[]
  /** Test-only name overrides (so a test never touches the real daemon/networks). */
  names?: { daemon?: string; outNetwork?: string; networkPrefix?: string }
  log?: (msg: string) => void
  /** Review item 7: true when a bot or build uses the engine's default (pasta/slirp) network. */
  defaultNetworkInUse?: () => boolean
}

export interface EgressService {
  /** Proxy health (starts the daemon if needed). PermissionGate checks this before an internet card. */
  available(): Promise<{ ok: true } | { ok: false; message: string }>
  /** The bot's internal network name. */
  networkFor(slug: string): string
  /** Mint a credential bound to the bot's network (creates the network, attaches the proxy). Throws EgressUnavailableError. */
  grant(slug: string, kind: EgressCredential['kind']): Promise<EgressGrant>
  /** Revoke it (closes its tunnels) and return its host log. Best effort: [] when the proxy is gone. */
  revoke(id: string): Promise<HostContact[]>
  /** The live host log of a credential. */
  hosts(id: string): Promise<HostContact[]>
  /** Remove the bot's network (reset / delete). The proxy is disconnected first. */
  removeNetwork(slug: string): Promise<void>
  /** Remove the daemon and the outbound network (tests, uninstall). */
  shutdown(): Promise<void>
  /**
   * The probe's CONNECT check (plan: "the network probe CONNECT check becomes real"): a throwaway
   * container on a probe egress network, with the given runtime flags, must get 407 from the proxy
   * without a credential, 403 for this computer with one, and no direct connection at all.
   */
  connectCheck(opts?: { runtimeFlags?: readonly string[]; image?: string }): Promise<{ status: 'pass' | 'fail'; message?: string }>
  /**
   * Review item 7: the container-side CIDRs for the user-only wall, from what AgentControl uses:
   * the subnets of its own networks (last read from the engine), gvproxy's subnet on the Podman
   * machine, slirp's when slirp is in use. Synchronous (read on every request).
   */
  userOnlyCidrs(): string[]
  /** Re-read the subnets of AgentControl's networks (BE start, after a network is created). */
  refreshSubnets(): Promise<void>
}

/** Slug of the probe's own egress network (never a bot: agent slugs are [a-z0-9-] only). */
export const PROBE_SLUG = '_probe'

/** Runs in the probe container: three socket tries, one JSON line. Plain node, no shell input. */
export const CONNECT_CHECK_SCRIPT = String.raw`
const net = require('net')
const [host, port, auth] = [process.env.P_HOST, Number(process.env.P_PORT), process.env.P_AUTH]
const tryConnect = (h, p, line) => new Promise((done) => {
  const s = net.connect({ host: h, port: p })
  let buf = ''
  const end = (v) => { s.destroy(); done(v) }
  s.setTimeout(4000, () => end('timeout'))
  s.on('connect', () => { if (!line) end('connected'); else s.write(line) })
  s.on('data', (c) => { buf += c; const m = /^HTTP\/1\.[01] (\d{3})/.exec(buf); if (m) end(m[1]) })
  s.on('error', (e) => end('error:' + e.code))
})
const connect = (a) => 'CONNECT 127.0.0.1:443 HTTP/1.1\r\nHost: 127.0.0.1:443\r\n' + (a ? 'Proxy-Authorization: Basic ' + Buffer.from(a).toString('base64') + '\r\n' : '') + '\r\n'
;(async () => {
  const noAuth = await tryConnect(host, port, connect(null))
  const blocked = await tryConnect(host, port, connect(auth))
  const direct = await tryConnect('192.0.2.1', 80, null)
  console.log(JSON.stringify({ noAuth, blocked, direct }))
})()
`

/** Proxy env for a client: upper and lower case (curl reads lower), pip and npm too. NO_PROXY cleared. */
export function proxyEnv(url: string): EnvVar[] {
  return [
    ...['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'PIP_PROXY', 'npm_config_proxy', 'npm_config_https_proxy'].map((name) => ({ name, value: url })),
    { name: 'NO_PROXY', value: '' },
    { name: 'no_proxy', value: '' },
  ]
}

/**
 * M2 contract: at most SCRIPT_RUN_HOSTS_MAX rows, blocked ones first; each group keeps the proxy's
 * first-seen order, so the first blocked row is the first blocked host by time (the host_blocked
 * line). `total` only when the list was cut.
 */
export function capHostContacts(rows: readonly HostContact[], max = SCRIPT_RUN_HOSTS_MAX): { hosts: HostContact[]; total?: number } {
  const sorted = [...rows.filter((r) => r.blocked), ...rows.filter((r) => !r.blocked)]
  return sorted.length > max ? { hosts: sorted.slice(0, max), total: sorted.length } : { hosts: sorted }
}

/** This computer's own addresses (all interfaces), for the this_computer rule. */
export function hostInterfaceAddresses(readProc: (file: string) => string | null = readProcFile): string[] {
  const out: string[] = []
  for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) out.push(a.address.replace(/%.*$/, ''))
  // os.networkInterfaces() skips interfaces that are down or have no carrier (docker0 with nothing
  // attached), but their addresses still answer on this computer. On Linux read the kernel's lists.
  out.push(...localAddressesFromProc(readProc('/proc/net/fib_trie'), readProc('/proc/net/if_inet6')))
  // Review S5: the default gateways (the router, or the VM host) are this computer's side too.
  out.push(...defaultGatewaysFromProc(readProc('/proc/net/route'), readProc('/proc/net/ipv6_route')))
  return [...new Set(out)]
}

/** Default-route gateways from /proc/net/route (little-endian hex) and /proc/net/ipv6_route. */
export function defaultGatewaysFromProc(route: string | null, ipv6Route: string | null): string[] {
  const out: string[] = []
  for (const line of (route ?? '').split('\n').slice(1)) {
    const f = line.trim().split(/\s+/)
    // Iface Destination Gateway Flags RefCnt Use Metric Mask ...
    if (f.length < 8 || f[1] !== '00000000' || f[7] !== '00000000' || !/^[0-9a-f]{8}$/i.test(f[2]!) || f[2] === '00000000') continue
    const n = parseInt(f[2]!, 16)
    out.push([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255].join('.'))
  }
  for (const line of (ipv6Route ?? '').split('\n')) {
    const f = line.trim().split(/\s+/)
    // dest destPrefix src srcPrefix nextHop metric refcnt use flags iface
    if (f.length < 10 || f[0] !== '0'.repeat(32) || f[1] !== '00' || !/^[0-9a-f]{32}$/i.test(f[4]!) || f[4] === '0'.repeat(32)) continue
    out.push(f[4]!.match(/.{4}/g)!.map((g) => parseInt(g, 16).toString(16)).join(':'))
  }
  return [...new Set(out)]
}

function readProcFile(file: string): string | null {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/** IPv4 "/32 host LOCAL" entries of /proc/net/fib_trie and every address in /proc/net/if_inet6. */
export function localAddressesFromProc(fibTrie: string | null, ifInet6: string | null): string[] {
  const out: string[] = []
  if (fibTrie) {
    let prev = ''
    for (const line of fibTrie.split('\n')) {
      if (/\/32 host LOCAL/.test(line) && /^\d+\.\d+\.\d+\.\d+$/.test(prev)) out.push(prev)
      const m = /^\s*\|--\s+(\S+)/.exec(line)
      if (m) prev = m[1]!
    }
  }
  if (ifInet6) {
    for (const line of ifInet6.split('\n')) {
      const hex = line.trim().split(/\s+/)[0]
      if (!hex || !/^[0-9a-f]{32}$/i.test(hex)) continue
      const groups = hex.match(/.{4}/g)!.map((g) => parseInt(g, 16).toString(16))
      out.push(groups.join(':'))
    }
  }
  return [...new Set(out)]
}

/**
 * The user's model servers (openai-compatible endpoints) plus the BE's own HOST:PORT, for the
 * model_server rule. Item 3 (Charles): an endpoint is refused only when it is local (the proxy
 * decides from the name / resolved address: egress-rules.ts); the BE (`always`) on its port
 * whatever the address. With HOST=0.0.0.0 the BE answers on this computer's addresses, which are
 * this_computer on every port anyway.
 */
export function modelServersOf(endpoints: readonly { kind: string; baseUrl: string }[], env: NodeJS.ProcessEnv = process.env): { host: string; port: number; always?: boolean }[] {
  const out: { host: string; port: number; always?: boolean }[] = []
  for (const e of endpoints) {
    if (e.kind !== 'openai-compatible') continue
    try {
      const u = new URL(e.baseUrl)
      out.push({ host: u.hostname.replace(/^\[|\]$/g, ''), port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)) })
    } catch {
      // not a URL: nothing to refuse
    }
  }
  const host = env.HOST ?? '127.0.0.1'
  if (host && host !== '0.0.0.0' && host !== '::') out.push({ host, port: Number(env.PORT ?? 3001), always: true })
  return out
}

let testAllowWarned = false
/** Test runs only (review B2): NODE_ENV=test or AC_VM_TESTS=1. */
export function testAllowHonoured(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === 'test' || env.AC_VM_TESTS === '1'
}
/**
 * CIDRs from AC_EGRESS_TEST_ALLOW (review B2): only in test runs; outside them the variable is
 * ignored with one warning. Entries wider than /24 (/120) or unreadable are dropped (one warning).
 */
export function testAllowFromEnv(env: NodeJS.ProcessEnv = process.env, warn: (msg: string) => void = (m) => process.stderr.write(`${m}\n`)): string[] {
  const raw = (env[EGRESS_TEST_ALLOW_ENV] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (!raw.length) return []
  const once = (msg: string) => {
    if (testAllowWarned) return
    testAllowWarned = true
    warn(msg)
  }
  if (!testAllowHonoured(env)) {
    once(`egress: ${EGRESS_TEST_ALLOW_ENV} is set but ignored: it only works in test runs (NODE_ENV=test or AC_VM_TESTS=1).`)
    return []
  }
  const ok = raw.filter((c) => testAllowCidr(c) !== null)
  if (ok.length !== raw.length) once(`egress: ${EGRESS_TEST_ALLOW_ENV}: ignored ${raw.filter((c) => !ok.includes(c)).join(', ')} (at most /24 or /120 each).`)
  return ok
}
/** Test hook: let the next ignored AC_EGRESS_TEST_ALLOW warn again. */
export function resetTestAllowWarning(): void {
  testAllowWarned = false
}

/** The daemon's code: dist .js as is, or src .ts transpiled (dev/tests). */
async function daemonFiles(): Promise<Record<string, string>> {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const names = ['egressd', 'egress-rules']
  const files: Record<string, string> = { 'package.json': '{"type":"module"}\n' }
  const js = names.every((n) => existsSync(path.join(here, `${n}.js`)))
  if (js) {
    for (const n of names) files[`${n}.js`] = readFileSync(path.join(here, `${n}.js`), 'utf8')
    return files
  }
  const ts = (await import('typescript')).default
  for (const n of names) {
    const src = readFileSync(path.join(here, `${n}.ts`), 'utf8')
    files[`${n}.js`] = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  }
  return files
}

const lastLine = (r: CommandResult) => (r.stderr || r.stdout).trim().split('\n').filter(Boolean).pop()?.slice(0, 300) ?? `exit code ${r.code}`
const noSuch = (r: CommandResult) => /no such|not found|not known|does not exist|no container with|unable to find network/i.test(r.stderr + r.stdout)

export function createEgressService(deps: EgressServiceDeps): EgressService {
  const run = deps.exec ?? execCommandRunner
  const log = deps.log ?? (() => {})
  const daemon = deps.names?.daemon ?? EGRESS_DAEMON_NAME
  const outNet = deps.names?.outNetwork ?? EGRESS_OUT_NETWORK
  const prefix = deps.names?.networkPrefix ?? 'ac-egress-'
  const networkFor = (slug: string) => `${prefix}${slug}`
  const image = () => deps.image?.() ?? sharedImageRef('botvm')
  let lock: Promise<unknown> = Promise.resolve()
  let pushedConfig = ''
  let subnets: string[] = []
  const subnetsRead = new Set<string>()
  let onMachine = false
  let slirp = false

  /** One engine sequence at a time (daemon create, network connect). */
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = lock.catch(() => {}).then(fn)
    lock = next
    return next
  }

  async function engine(): Promise<EngineRef> {
    const e = await deps.engine()
    if (!e) throw new EgressUnavailableError('no container engine')
    if (e.cli !== 'podman') throw new EgressUnavailableError('the egress proxy needs Podman')
    return e
  }
  async function cli(args: string[], opts: { timeoutMs?: number; input?: string } = {}): Promise<CommandResult> {
    const e = await engine()
    return run(e.command ?? e.cli, [...e.globalArgs, ...args], { timeoutMs: opts.timeoutMs ?? 60_000, ...(opts.input !== undefined ? { input: opts.input } : {}) })
  }
  async function must(args: string[], what: string, timeoutMs?: number): Promise<CommandResult> {
    const r = await cli(args, { timeoutMs })
    if (r.code !== 0) throw new EgressUnavailableError(`couldn't ${what}: ${lastLine(r)}`)
    return r
  }

  async function ctl<T>(req: unknown): Promise<T> {
    const r = await cli(['exec', '-i', daemon, 'node', `${APP_DIR}/egressd.js`, 'ctl'], { input: JSON.stringify(req), timeoutMs: 20_000 })
    let out: { ok?: boolean; error?: string } | null = null
    try {
      out = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as { ok?: boolean; error?: string }
    } catch {
      out = null
    }
    if (r.code !== 0 || !out || out.ok === false) throw new EgressUnavailableError(`proxy control failed: ${out?.error ?? lastLine(r)}`)
    return out as T
  }

  function currentConfig(): EgressRulesConfig {
    return deps.config?.() ?? { hostAddresses: hostInterfaceAddresses() }
  }
  async function pushConfig(force = false): Promise<void> {
    const cfg = currentConfig()
    const text = JSON.stringify(cfg)
    if (!force && text === pushedConfig) return
    await ctl({ op: 'config', config: cfg })
    pushedConfig = text
  }

  async function writeApp(): Promise<{ dir: string; hash: string }> {
    const files = await daemonFiles()
    const hash = createHash('sha256').update(JSON.stringify(files)).update(image()).update(JSON.stringify(deps.addHosts ?? [])).digest('hex').slice(0, 16)
    const dir = path.join(deps.stateDir(), 'egressd', hash)
    mkdirSync(dir, { recursive: true, mode: 0o755 })
    for (const [name, text] of Object.entries(files)) {
      const p = path.join(dir, name)
      const tmp = `${p}.${randomBytes(4).toString('hex')}.tmp`
      writeFileSync(tmp, text, { mode: 0o644 })
      renameSync(tmp, p)
    }
    return { dir, hash }
  }

  async function daemonState(): Promise<{ state: 'missing' | 'running' | 'stopped'; hash?: string; networks: Record<string, string> }> {
    const r = await cli(['container', 'inspect', '--format', `{{.State.Running}}|{{index .Config.Labels "${HASH_LABEL}"}}|{{json .NetworkSettings.Networks}}`, daemon])
    if (r.code !== 0) {
      if (noSuch(r)) return { state: 'missing', networks: {} }
      throw new EgressUnavailableError(`couldn't inspect the proxy: ${lastLine(r)}`)
    }
    const [running, hash, nets] = r.stdout.trim().split('|')
    const networks: Record<string, string> = {}
    try {
      for (const [k, v] of Object.entries(JSON.parse(nets ?? '{}') as Record<string, { IPAddress?: string }>)) networks[k] = v?.IPAddress ?? ''
    } catch {
      // older engines: no networks map
    }
    return { state: running === 'true' ? 'running' : 'stopped', hash, networks }
  }

  async function networkExists(name: string): Promise<boolean> {
    const r = await cli(['network', 'exists', name])
    return r.code === 0
  }

  async function waitHealthy(): Promise<void> {
    let last = ''
    for (let i = 0; i < 40; i++) {
      try {
        await ctl({ op: 'health' })
        return
      } catch (err) {
        last = (err as EgressUnavailableError).detail ?? (err as Error).message
      }
      await new Promise((r) => setTimeout(r, 250))
    }
    throw new EgressUnavailableError(`the proxy didn't come up: ${last}`)
  }

  /** Daemon up with the current code; returns its networks. */
  async function ensureDaemon(): Promise<Record<string, string>> {
    const app = await writeApp()
    let st = await daemonState()
    if (st.state !== 'missing' && st.hash !== app.hash) {
      log(`egress: recreating ${daemon} (new version)`)
      await must(['rm', '--force', '--time', '2', daemon], 'remove the old proxy')
      st = { state: 'missing', networks: {} }
    }
    if (st.state === 'missing') {
      if (!(await networkExists(outNet))) {
        await must(['network', 'create', '--ipv6=false', '--label', `${EGRESS_LABEL}=out`, outNet], 'create the proxy\'s outbound network')
      }
      await must(
        [
          'run', '--detach', '--name', daemon,
          '--label', `${EGRESS_LABEL}=daemon`, '--label', `${HASH_LABEL}=${app.hash}`,
          '--network', outNet,
          '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
          '--user', '1000:1000', '--memory', '256m', '--pids-limit', '256',
          '--tmpfs', '/run/egressd:rw,size=1m,mode=1777',
          '--mount', `type=bind,source=${app.dir},target=${APP_DIR},readonly`,
          '--env', 'AC_EGRESSD_MAIN=1',
          ...(deps.addHosts ?? []).flatMap((h) => ['--add-host', h]),
          image(), 'node', `${APP_DIR}/egressd.js`, 'serve',
        ],
        'start the proxy',
        120_000,
      )
      pushedConfig = ''
      st = await daemonState()
    } else if (st.state === 'stopped') {
      await must(['start', daemon], 'start the proxy')
      pushedConfig = ''
      st = await daemonState()
    }
    await waitHealthy()
    await pushConfig()
    return st.networks
  }

  async function ensureNetwork(slug: string): Promise<string> {
    const name = networkFor(slug)
    if (!/^[a-z0-9][a-z0-9_.-]*$/.test(name)) throw new EgressUnavailableError(`bad network name ${name}`)
    const nets = await ensureDaemon()
    if (!(await networkExists(name))) {
      await must(['network', 'create', '--internal', '--disable-dns', '--ipv6=false', '--label', `${EGRESS_LABEL}=${slug}`, name], 'create the bot\'s egress network')
    }
    if (!subnetsRead.has(name)) {
      await refreshSubnets()
      subnetsRead.add(name)
    }
    if (!nets[name]) {
      await must(['network', 'connect', name, daemon], 'attach the proxy to the bot\'s network')
    }
    const after = await daemonState()
    const ip = after.networks[name]
    if (!ip) throw new EgressUnavailableError(`the proxy has no address on ${name}`)
    return ip
  }

  async function refreshSubnets(): Promise<void> {
    try {
      const e = await engine()
      onMachine = e.globalArgs.includes('--connection')
      const r = await cli(['network', 'ls', '--filter', `label=${EGRESS_LABEL}`, '--format', '{{range .Subnets}}{{.Subnet}} {{end}}'])
      if (r.code !== 0) throw new Error(lastLine(r))
      const found = r.stdout.split(/\s+/).filter((c) => /^[0-9a-f.:]+\/\d+$/i.test(c))
      // The test outbound network (names override) has no label: read it by name.
      if (deps.names?.outNetwork) {
        const o = await cli(['network', 'inspect', '--format', '{{range .Subnets}}{{.Subnet}} {{end}}', outNet])
        if (o.code === 0) found.push(...o.stdout.split(/\s+/).filter((c) => /^[0-9a-f.:]+\/\d+$/i.test(c)))
      }
      subnets = [...new Set(found)]
      if (deps.defaultNetworkInUse?.()) {
        const i = await cli(['info', '--format', '{{.Host.RootlessNetworkCmd}}'])
        slirp = i.code === 0 && i.stdout.trim() === 'slirp4netns'
      } else slirp = false
    } catch (err) {
      log(`user_only: couldn't read the subnets of AgentControl's networks, so the address check uses the last known list (${subnets.join(', ') || 'none'}): ${(err as EgressUnavailableError).detail ?? (err as Error).message}`)
    }
  }

  return {
    networkFor,

    userOnlyCidrs: () => [...subnets, ...(onMachine ? [GVPROXY_CIDR] : []), ...(slirp ? [SLIRP_CIDR] : [])],
    refreshSubnets,

    async available() {
      try {
        await serial(() => ensureDaemon())
        return { ok: true }
      } catch (err) {
        return { ok: false, message: (err as EgressUnavailableError).detail ?? (err as Error).message }
      }
    },

    grant: (slug, kind) =>
      serial(async () => {
        try {
          const proxyAddress = await ensureNetwork(slug)
          await pushConfig()
          const id = `ac${randomBytes(9).toString('hex')}`
          const secret = randomBytes(24).toString('hex')
          await ctl({ op: 'grant', credential: { id, secret, proxyAddress, slug, network: networkFor(slug), kind } satisfies EgressCredential })
          const url = `http://${id}:${secret}@${proxyAddress}:${EGRESS_PROXY_PORT}`
          return { id, slug, network: networkFor(slug), proxyAddress, env: proxyEnv(url), secrets: [secret, url] }
        } catch (err) {
          if (err instanceof EgressUnavailableError) {
            log(`egress: ${slug}: ${err.detail}`)
            throw err
          }
          log(`egress: ${slug}: ${(err as Error).message}`)
          throw new EgressUnavailableError((err as Error).message)
        }
      }),

    async revoke(id) {
      try {
        return (await ctl<{ hosts?: HostContact[] }>({ op: 'revoke', id })).hosts ?? []
      } catch (err) {
        log(`egress: revoking ${id} failed: ${(err as EgressUnavailableError).detail ?? (err as Error).message}`)
        return []
      }
    },

    async hosts(id) {
      try {
        return (await ctl<{ hosts?: HostContact[] }>({ op: 'hosts', id })).hosts ?? []
      } catch {
        return []
      }
    },

    removeNetwork: (slug) =>
      serial(async () => {
        const name = networkFor(slug)
        const r = await cli(['network', 'disconnect', '--force', name, daemon])
        if (r.code !== 0 && !noSuch(r)) log(`egress: disconnect ${name}: ${lastLine(r)}`)
        const rm = await cli(['network', 'rm', name])
        if (rm.code !== 0 && !noSuch(rm)) log(`egress: remove ${name}: ${lastLine(rm)}`)
      }),

    async connectCheck(opts = {}) {
      let grant: EgressGrant | null = null
      try {
        grant = await this.grant(PROBE_SLUG, 'probe')
        const r = await cli(
          [
            ...(opts.runtimeFlags ?? []), 'run', '--rm', '--network', grant.network,
            '--label', 'io.agentcontrol.probe=1', '--label', `${EGRESS_LABEL}=probe`,
            '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '1000:1000',
            '--env', `P_HOST=${grant.proxyAddress}`, '--env', `P_PORT=${EGRESS_PROXY_PORT}`, '--env', `P_AUTH=${grant.id}:${grant.secrets[0]}`,
            opts.image ?? image(), 'node', '-e', CONNECT_CHECK_SCRIPT,
          ],
          { timeoutMs: 60_000 },
        )
        let res: { noAuth?: string; blocked?: string; direct?: string } = {}
        try {
          res = JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}')
        } catch {
          return { status: 'fail', message: `The proxy check container failed: ${lastLine(r)}` }
        }
        const bad: string[] = []
        if (res.noAuth !== '407') bad.push(`no credential gave ${res.noAuth}, expected 407`)
        if (res.blocked !== '403') bad.push(`this computer gave ${res.blocked}, expected 403`)
        if (res.direct === 'connected') bad.push('a direct connection got out without the proxy')
        return bad.length ? { status: 'fail', message: `Egress proxy check: ${bad.join('; ')}.` } : { status: 'pass', message: 'Internet goes only through the proxy (407 without a credential, 403 for this computer, no direct route).' }
      } catch (err) {
        return { status: 'fail', message: `The egress proxy isn't available: ${(err as EgressUnavailableError).detail ?? (err as Error).message}` }
      } finally {
        if (grant) await this.revoke(grant.id)
      }
    },

    shutdown: () =>
      serial(async () => {
        await cli(['rm', '--force', '--time', '2', daemon])
        const r = await cli(['network', 'rm', outNet])
        if (r.code !== 0 && !noSuch(r)) log(`egress: remove ${outNet}: ${lastLine(r)}`)
        pushedConfig = ''
      }),
  }
}
