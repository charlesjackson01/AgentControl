import { describe, expect, it } from 'vitest'
import { execCommandRunner } from './command-runner.js'

describe('execCommandRunner (no shell, bounded)', () => {
  it('returns stdout and exit codes; 127 for a missing program; 124 on timeout', async () => {
    expect(await execCommandRunner(process.execPath, ['-e', 'process.stdout.write("hi")'])).toEqual({ code: 0, stdout: 'hi', stderr: '' })
    expect((await execCommandRunner(process.execPath, ['-e', 'process.stderr.write("bad"); process.exit(3)'])).code).toBe(3)
    expect((await execCommandRunner('agentcontrol-no-such-binary-xyz', ['--version'])).code).toBe(127)
    expect((await execCommandRunner(process.execPath, ['-e', 'setTimeout(()=>{}, 10000)'], { timeoutMs: 200 })).code).toBe(124)
  })

  it('passes argv literally (no shell expansion)', async () => {
    const r = await execCommandRunner(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', '$(echo nope); ls *'])
    expect(r.stdout).toBe('$(echo nope); ls *')
  })

  it('review S2: env sets the program\'s environment (a value never in argv)', async () => {
    const r = await execCommandRunner(process.execPath, ['-e', 'process.stdout.write(String(process.env.AC_S2_PROBE) + "|" + process.argv.slice(1).join(","))'], { env: { ...process.env, AC_S2_PROBE: 'v-123' } })
    expect(r.stdout).toBe('v-123|')
  })
})
