import { describe, expect, it } from 'vitest'
import { spawnStreamRunner } from './stream-runner.js'

describe('spawnStreamRunner (no shell, streaming, killable)', () => {
  it('streams both outputs and returns the exit code', async () => {
    const out: string[] = []
    const err: string[] = []
    const h = spawnStreamRunner(process.execPath, ['-e', 'process.stdout.write("a$(x)"); process.stderr.write("b"); process.exit(3)'], { onStdout: (c) => out.push(c.toString()), onStderr: (c) => err.push(c.toString()) })
    expect(await h.done).toEqual({ code: 3 })
    expect(out.join('')).toBe('a$(x)')
    expect(err.join('')).toBe('b')
  })
  it('127 for a missing program; kill ends a hanging one', async () => {
    const miss = spawnStreamRunner('ac-no-such-program-xyz', [], { onStdout: () => {}, onStderr: () => {} })
    expect(await miss.done).toMatchObject({ code: 127, spawnError: 'ac-no-such-program-xyz: not found' })
    const h = spawnStreamRunner(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { onStdout: () => {}, onStderr: () => {} })
    setTimeout(() => h.kill(), 50)
    expect((await h.done).code).toBe(137)
  })
})
