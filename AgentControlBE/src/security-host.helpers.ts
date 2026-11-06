/**
 * BE-P2-19: shared bits for the @win / @mac security files (they run only on that OS, opted in).
 * Everything goes through the dedicated `agentcontrol` machine connection, never the default one.
 */
import { execFileSync } from 'node:child_process'
import { networkInterfaces } from 'node:os'
import { MACHINE_NAME } from './vm-host.js'
import { sharedImageRef } from './vm-images.js'

export const MACHINE_ARGS = ['--connection', MACHINE_NAME]
export const HOST_TEST_LABEL = 'io.agentcontrol.be19=1'

/** podman on the agentcontrol machine; null on failure. */
export function machinePodman(...args: string[]): string | null {
  try {
    return execFileSync('podman', [...MACHINE_ARGS, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 }).trim()
  } catch {
    return null
  }
}

/** A throwaway container hardened like a bot's (no network, read-only, no caps, uid 1000). */
export function botLikeRun(name: string, script: string, extra: string[] = []): string | null {
  return machinePodman('run', '--rm', '--name', name, '--label', HOST_TEST_LABEL, '--network', 'none', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--user', '1000:1000', '--userns', 'auto', ...extra, sharedImageRef('botvm'), 'sh', '-c', script)
}

/** This computer's own non-loopback addresses (LAN, Tailscale, VPN), as the egress rules must refuse them. */
export function localAddresses(): string[] {
  return Object.values(networkInterfaces()).flat().filter((i) => i && !i.internal).map((i) => i!.address.split('%')[0]!)
}

export function cleanupHostTests(): void {
  for (const id of (machinePodman('ps', '-a', '--filter', `label=${HOST_TEST_LABEL}`, '--format', '{{.ID}}') ?? '').split('\n').filter(Boolean)) machinePodman('rm', '--force', id)
  for (const v of (machinePodman('volume', 'ls', '--filter', `label=${HOST_TEST_LABEL}`, '--format', '{{.Name}}') ?? '').split('\n').filter(Boolean)) machinePodman('volume', 'rm', '--force', v)
}
