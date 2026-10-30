/**
 * Test-only (BE-P2-13, moved here from egress-service.test.ts for the M2 build-grant tests): a fake
 * Podman for EgressService whose `exec … ctl` talks to a real in-process egress proxy. Not used at run time.
 */
import type { CommandResult, CommandRunner } from './command-runner.js'
import { EgressUnavailableError, PROXY_UNAVAILABLE, type EgressService } from './egress-service.js'
import { createEgressProxy, handleCtl, type CtlRequest, type EgressProxy, type EgressProxyOptions } from './egressd.js'

export interface FakePodmanOptions {
  /** Extra options for every proxy process it starts (a clock, resolve/connect for a real CONNECT). */
  proxy?: () => EgressProxyOptions
  /** The proxy's address on every bot network (default 10.89.N.2; 127.0.0.1 lets a test CONNECT to it). */
  botIp?: string
}

export const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' })
export const fail = (stderr: string, code = 125): CommandResult => ({ code, stdout: '', stderr })

export function fakePodman(fo: FakePodmanOptions = {}) {
  const calls: string[][] = []
  const inputs: string[] = []
  const networks = new Map<string, string[]>()
  let daemon: { running: boolean; hash: string; startedAt: string; nets: Record<string, string>; args: string[] } | null = null
  let proxy: EgressProxy = createEgressProxy({ sweepMs: 0, ...fo.proxy?.() })
  let starts = 0
  const stamp = () => `2026-10-30 12:00:${String(starts++).padStart(2, '0')} -0500 CDT`
  let nextIp = 2
  const state = {
    ctlDown: false, runFails: false, lsFails: false, rootlessNet: 'pasta', probeOut: '{"noAuth":"407","blocked":"403","direct":"error:ENETUNREACH"}',
    // The nftables helper: its image is there, loads work; `tables` = startedAt → loaded ruleset.
    fwImage: true, fwFails: false, tables: new Map<string, string>(),
  }
  const exec: CommandRunner = async (cmd, args, opts) => {
    const a = [...args]
    calls.push(a)
    if (opts?.input !== undefined) inputs.push(opts.input)
    const flag = (n: string) => a[a.indexOf(n) + 1]
    const [verb, sub] = a
    if (verb === 'container' && sub === 'inspect') {
      if (!daemon) return fail('Error: no such container ac-egressd')
      const nets = Object.fromEntries(Object.entries(daemon.nets).map(([k, v]) => [k, { IPAddress: v, ...(k === 'ac-egress-out' ? { Gateway: '10.89.0.1' } : {}) }]))
      return ok(`${daemon.running}|${daemon.hash}|${daemon.startedAt}|${JSON.stringify(nets)}\n`)
    }
    if (verb === 'network' && sub === 'exists') return networks.has(a[2]!) ? ok() : fail('', 1)
    if (verb === 'network' && sub === 'create') {
      networks.set(a[a.length - 1]!, a)
      return ok()
    }
    if (verb === 'network' && sub === 'connect') {
      daemon!.nets[a[2]!] = fo.botIp ?? `10.89.${nextIp++}.2`
      return ok()
    }
    if (verb === 'network' && sub === 'disconnect') {
      if (daemon) delete daemon.nets[a[3]!]
      return ok()
    }
    if (verb === 'network' && sub === 'ls') {
      if (state.lsFails) return fail('Error: engine gone')
      return ok([...networks.keys()].map((_n, i) => `10.89.${100 + i}.0/24 `).join('\n') + '\n')
    }
    if (verb === 'info') return ok(`${state.rootlessNet}\n`)
    if (verb === 'network' && sub === 'rm') return networks.delete(a[2]!) ? ok() : fail('Error: unable to find network')
    if (verb === 'rm') {
      daemon = null
      void proxy.close()
      proxy = createEgressProxy({ sweepMs: 0, ...fo.proxy?.() })
      return ok()
    }
    if (verb === 'start') {
      // A restarted proxy is a new process: no settings, no credentials.
      daemon!.running = true
      daemon!.startedAt = stamp()
      void proxy.close()
      proxy = createEgressProxy({ sweepMs: 0, ...fo.proxy?.() })
      return ok()
    }
    if (verb === 'run' && a.includes('--detach')) {
      if (state.runFails) return fail('Error: image not known')
      const hash = a.find((x) => x.startsWith('io.agentcontrol.egressd.hash='))!.split('=')[1]!
      daemon = { running: true, hash, startedAt: stamp(), nets: { [flag('--network')!]: '10.89.0.2' }, args: a }
      return ok('id\n')
    }
    if (verb === 'image' && sub === 'exists') return state.fwImage ? ok() : fail('', 1)
    if (verb === 'run' && flag('--entrypoint') === 'nft') {
      if (!state.fwImage) return fail('Error: localhost/agentcontrol/egressd-nft:1.0.0: image not known')
      if (!daemon?.running) return fail('Error: cannot join network namespace of a stopped container')
      if (a.includes('-f')) {
        if (state.fwFails) return fail('Error: Could not process rule: Operation not permitted', 1)
        state.tables.set(daemon.startedAt, opts!.input!)
        return ok()
      }
      const t = state.tables.get(daemon.startedAt)
      return t ? ok(t) : fail('Error: No such file or directory\nlist table inet ac_egressd', 1)
    }
    if (verb === 'run' && a.includes('--rm')) return ok(`${state.probeOut}\n`)
    if (verb === 'exec') {
      if (state.ctlDown || !daemon?.running) return fail('Error: can only exec into running containers')
      try {
        const out = handleCtl(proxy, JSON.parse(opts!.input!) as CtlRequest) as { ok?: boolean }
        return ok(`${JSON.stringify({ ok: true, ...out })}\n`)
      } catch (err) {
        return { code: 1, stdout: `${JSON.stringify({ ok: false, error: (err as Error).message })}\n`, stderr: '' }
      }
    }
    return fail(`fake: unexpected ${a.join(' ')}`)
  }
  return { exec, calls, inputs, networks, state, get daemon() { return daemon }, get proxy() { return proxy }, stop() { if (daemon) daemon.running = false } }
}

/**
 * CI fix (PR #31): an egress proxy that is down, with no engine behind it. Unit tests that build the
 * app pass this (or their own fake) so `available()` never reaches a real Podman on the host (on a
 * GitHub runner the real service creates ac-egress-out and starts ac-egressd). Everything fails closed.
 */
export function downEgress(message = PROXY_UNAVAILABLE): EgressService {
  const down = async (): Promise<never> => {
    throw new EgressUnavailableError(message)
  }
  return {
    available: async () => ({ ok: false, message }),
    networkFor: (slug) => `ac-egress-${slug}`,
    grant: down,
    revoke: async () => [],
    hosts: async () => [],
    removeNetwork: async () => {},
    shutdown: async () => {},
    connectCheck: async () => ({ status: 'fail', message }),
    userOnlyCidrs: () => [],
    refreshSubnets: async () => {},
  }
}
