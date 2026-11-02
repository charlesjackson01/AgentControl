/**
 * Test-only (vitest `setupFiles`; follow-up to the PR #31 CI fix): unit tests must never reach the
 * host's container engine. On a machine with a real Podman/Docker (a GitHub runner) such a call is
 * slow and can create real networks, containers or images; with the usual stub it "passes" by luck.
 *
 * Every child-process start whose program is `podman` or `docker` (any path, `.exe` allowed;
 * `sh -c "podman …"` and `exec('docker …')` by their first word) throws `EngineCallInUnitTestError`
 * and is recorded; any test (or file) that made one fails, even if the code under test swallowed
 * the throw. Covers spawn/execFile/exec/fork and their promisified forms (all go through
 * ChildProcess.prototype.spawn) plus spawnSync/execFileSync/execSync.
 *
 * Off when AC_VM_TESTS=1 and in the `*.vm.test.ts` files (the @vm gating convention). Not used at
 * run time. Programs a child script starts on its own are not seen.
 */
import childProcess, { ChildProcess } from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { afterAll, afterEach, expect } from 'vitest'

export class EngineCallInUnitTestError extends Error {
  constructor(readonly command: string) {
    super(`unit test called the host's container engine: ${command} (inject a fake engine, or make it an @vm test)`)
  }
}

const ENGINES = new Set(['podman', 'docker'])
const SHELLS = new Set(['sh', 'bash', 'dash', 'zsh', 'cmd', 'cmd.exe'])
const KEY = Symbol.for('agentcontrol.engineGuard')

interface GuardState {
  /** Engine calls since the last check, newest last. */
  calls: string[]
  /** Paused by the guard's own test while it proves the guard trips. */
  paused: boolean
}

const program = (file: string): string => (String(file).split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.exe$/, '')

/** The engine command line when `file args` would start podman/docker, else null. */
export function engineCommand(file: string, args: readonly unknown[] = []): string | null {
  const p = program(file)
  if (ENGINES.has(p)) return [p, ...args.map(String)].join(' ')
  if (SHELLS.has(p)) {
    const i = args.findIndex((a) => a === '-c' || a === '/c' || a === '/d /s /c')
    const line = i >= 0 ? String(args[i + 1] ?? '') : ''
    const first = line.trim().replace(/^["']/, '').split(/[\s"']/)[0] ?? ''
    if (first && ENGINES.has(program(first))) return line.trim()
  }
  return null
}

const activeFor = (file: string | undefined): boolean =>
  process.env.AC_VM_TESTS !== '1' && !(file ?? '').endsWith('.vm.test.ts')

const currentFile = (): string | undefined => expect.getState().testPath

function state(): GuardState {
  const g = globalThis as unknown as Record<symbol, GuardState | undefined>
  return (g[KEY] ??= { calls: [], paused: false })
}

/** For the guard's own test: run `fn` with the trip recorded but not failing the test. */
export async function withEngineGuardTrips<T>(fn: () => T | Promise<T>): Promise<{ result?: T; error?: unknown; calls: string[] }> {
  const s = state()
  const before = s.calls.length
  s.paused = true
  try {
    return { result: await fn(), calls: s.calls.slice(before) }
  } catch (error) {
    return { error, calls: s.calls.slice(before) }
  } finally {
    s.calls.length = before
    s.paused = false
  }
}

function check(file: string, args: readonly unknown[]): void {
  if (!activeFor(currentFile())) return
  const cmd = engineCommand(file, args)
  if (cmd === null) return
  state().calls.push(cmd)
  throw new EngineCallInUnitTestError(cmd)
}

function install(): void {
  const cp = childProcess as unknown as Record<string, unknown> & { [KEY]?: true }
  if (cp[KEY]) return
  cp[KEY] = true
  // Async forms: spawn, execFile, exec, fork (and util.promisify of them) all end here.
  const proto = ChildProcess.prototype as unknown as { spawn(o: { file: string; args?: readonly unknown[] }): unknown }
  const spawnAsync = proto.spawn
  proto.spawn = function (this: unknown, o) {
    check(o.file, (o.args ?? []).slice(1))
    return spawnAsync.call(this, o)
  }
  // Sync forms (they don't use the prototype).
  const { spawnSync, execFileSync, execSync } = childProcess
  cp.spawnSync = (file: string, args?: unknown, opts?: unknown) => {
    const list = Array.isArray(args) ? args : []
    check(file, list)
    return (spawnSync as (...a: unknown[]) => unknown)(file, args, opts)
  }
  cp.execFileSync = (file: string, args?: unknown, opts?: unknown) => {
    check(file, Array.isArray(args) ? args : [])
    return (execFileSync as (...a: unknown[]) => unknown)(file, args, opts)
  }
  cp.execSync = (command: string, opts?: unknown) => {
    check('/bin/sh', ['-c', command])
    return (execSync as (...a: unknown[]) => unknown)(command, opts)
  }
  syncBuiltinESMExports()
}

install()

function flush(): void {
  const s = state()
  if (s.paused || s.calls.length === 0) return
  const calls = s.calls.splice(0)
  throw new EngineCallInUnitTestError(calls.join('; '))
}
// Per test, and per file for calls made while the file loads (a module-level engine probe).
afterEach(flush)
afterAll(flush)
