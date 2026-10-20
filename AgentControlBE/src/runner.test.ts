import { describe, expect, it } from 'vitest'
import { noopRunner, RUNNER_UNAVAILABLE } from './runner.js'

describe('noopRunner (BE-1 stub)', () => {
  it('is never available', async () => {
    await expect(noopRunner.available()).resolves.toBe(false)
  })

  it('reports every run as unavailable without running anything', async () => {
    const result = await noopRunner.run({
      agentId: 'agt_x',
      context: { kind: 'dm' },
      argv: ['python', 'scripts/a.py'],
      cwd: 'workspace',
      timeoutSec: 30,
      network: 'off',
    })
    expect(result).toEqual({ status: 'unavailable', durationMs: 0, stdout: '', stderr: RUNNER_UNAVAILABLE, filesChanged: [] })
  })
})
