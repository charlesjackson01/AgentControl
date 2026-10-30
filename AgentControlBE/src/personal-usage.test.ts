import { describe, expect, it } from 'vitest'
import type { Agent } from './shared/types.js'
import { createPersonalUsage, personalBlockMessage, sumBreakdown, type EngineParts } from './personal-usage.js'

const GB = 1024 ** 3
const agent = { id: 'a1', slug: 'analyst', name: 'Analyst' } as Agent

describe('personalBlockMessage', () => {
  it('is exactly the plan text', () => {
    expect(personalBlockMessage('Analyst', 10.2 * GB, 10 * GB)).toBe('Analyst\'s files and tools use 10.2 of 10 GB. Free space in Files or remove tools in Settings › VM.')
  })
})

describe('createPersonalUsage', () => {
  const setup = (folder = { workspace: 4 * GB, inputs: 1 * GB, memory: 0.1 * GB }, engineParts: EngineParts = { tools: 3 * GB, opt: 1 * GB, imageLayer: 1.1 * GB }) => {
    const clock = { t: 0 }
    let calls = 0
    let parts = engineParts
    let fail = false
    const p = createPersonalUsage({
      folder: () => folder,
      engine: async () => {
        calls++
        if (fail) throw new Error('engine down')
        return parts
      },
      quotaBytes: () => 10 * GB,
      ttlMs: 1000,
      now: () => new Date(clock.t),
    })
    return { p, clock, calls: () => calls, setParts: (x: EngineParts) => (parts = x), setFail: (x: boolean) => (fail = x) }
  }

  it('over 10 GB (folder + tools + opt + layer) blocks with the exact message', async () => {
    const s = setup()
    const c = await s.p.check(agent)
    expect(c.usedBytes).toBeCloseTo(10.2 * GB, -3)
    expect(c.quotaBytes).toBe(10 * GB)
    expect(c.blocked).toBe('Analyst\'s files and tools use 10.2 of 10 GB. Free space in Files or remove tools in Settings › VM.')
    expect(sumBreakdown(c.breakdown)).toBe(c.usedBytes)
    expect(s.p.engineBytes(agent)).toBeCloseTo(5.1 * GB, -3)
  })

  it('at or under the limit: not blocked', async () => {
    const s = setup({ workspace: 5 * GB, inputs: 0, memory: 0 }, { tools: 5 * GB, opt: 0, imageLayer: 0 })
    expect((await s.p.check(agent)).blocked).toBeNull()
  })

  it('the folder alone can block (no engine)', async () => {
    const p = createPersonalUsage({ folder: () => ({ workspace: 11 * GB, inputs: 0, memory: 0 }), quotaBytes: () => 10 * GB })
    expect((await p.check(agent)).blocked).toMatch(/^Analyst's files and tools use 11 of 10 GB\./)
    expect(p.engineBytes(agent)).toBe(0)
  })

  it('engine values are cached for the TTL, refreshed once stale, and forced on demand', async () => {
    const s = setup()
    await s.p.check(agent)
    await s.p.check(agent)
    expect(s.calls()).toBe(1)
    s.clock.t = 1500
    s.setParts({ tools: 0 })
    await s.p.check(agent)
    expect(s.calls()).toBe(2)
    // Parts it didn't return keep their last value.
    expect(s.p.breakdown(agent)).toMatchObject({ tools: 0, opt: 1 * GB, imageLayer: 1.1 * GB })
    await s.p.refresh(agent, { force: true })
    expect(s.calls()).toBe(3)
    s.p.forget(agent)
    expect(s.p.engineBytes(agent)).toBe(0)
  })

  it('concurrent refreshes share one engine call; an engine failure keeps the old values', async () => {
    const s = setup()
    await Promise.all([s.p.refresh(agent), s.p.refresh(agent), s.p.check(agent)])
    expect(s.calls()).toBe(1)
    s.setFail(true)
    await s.p.refresh(agent, { force: true })
    expect(s.p.engineBytes(agent)).toBeCloseTo(5.1 * GB, -3)
  })
})
