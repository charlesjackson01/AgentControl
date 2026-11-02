/**
 * The unit-test engine guard (engine-guard.test-setup.ts) trips on podman/docker in every
 * child-process form, and leaves other programs alone. Off when AC_VM_TESTS=1.
 */
import childProcess, { exec, execFile, execFileSync, execSync, spawn, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { execCommandRunner } from './command-runner.js'
import { spawnStreamRunner } from './stream-runner.js'
import { EngineCallInUnitTestError, engineCommand, withEngineGuardTrips } from './engine-guard.test-setup.js'

describe.skipIf(process.env.AC_VM_TESTS === '1')('unit-test engine guard', () => {
  it('names podman/docker by basename, .exe, and as a shell command’s first word', () => {
    expect(engineCommand('podman', ['ps'])).toBe('podman ps')
    expect(engineCommand('/usr/bin/docker', ['--version'])).toBe('docker --version')
    expect(engineCommand('C:\\Tools\\PODMAN.EXE', ['info'])).toBe('podman info')
    expect(engineCommand('/bin/sh', ['-c', 'podman image exists x'])).toBe('podman image exists x')
    expect(engineCommand('/bin/sh', ['-c', 'echo podman'])).toBeNull()
    expect(engineCommand('podman-remote-helper', [])).toBeNull()
    expect(engineCommand('node', ['--version'])).toBeNull()
  })

  it('throws on every child_process form (sync, async, promisified) and records each call', async () => {
    const forms: [string, () => unknown][] = [
      ['spawn', () => spawn('podman', ['ps'])],
      ['execFile', () => execFile('docker', ['ps'], () => {})],
      ['exec', () => exec('podman ps', () => {})],
      ['promisify(execFile)', () => promisify(execFile)('/usr/bin/podman', ['info'])],
      ['promisify(exec)', () => promisify(exec)('docker info')],
      ['spawnSync', () => spawnSync('podman', ['--version'])],
      ['execFileSync', () => execFileSync('docker', ['--version'])],
      ['execSync', () => execSync('podman --version')],
      ['module object', () => childProcess.execFileSync('podman', ['--version'])],
    ]
    for (const [name, fn] of forms) {
      const r = await withEngineGuardTrips(fn)
      expect(r.error, name).toBeInstanceOf(EngineCallInUnitTestError)
      expect(r.calls, name).toHaveLength(1)
    }
  })

  it('trips through the app’s own runners even though they turn errors into results', async () => {
    const viaExec = await withEngineGuardTrips(() => execCommandRunner('podman', ['container', 'inspect', 'ac-egressd']))
    expect(viaExec.calls).toEqual(['podman container inspect ac-egressd'])
    const viaStream = await withEngineGuardTrips(async () => spawnStreamRunner('docker', ['exec', 'x', 'true'], { onStdout() {}, onStderr() {} }).done)
    expect(viaStream.calls).toEqual(['docker exec x true'])
  })

  it('leaves other programs alone', async () => {
    const r = await withEngineGuardTrips(() => execFileSync(process.execPath, ['-e', 'process.stdout.write("ok")'], { encoding: 'utf8' }))
    expect(r).toEqual({ result: 'ok', calls: [] })
    expect((await promisify(execFile)(process.execPath, ['-e', 'process.stdout.write("ok")'])).stdout).toBe('ok')
  })
})
