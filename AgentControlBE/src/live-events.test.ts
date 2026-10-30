import { describe, expect, it } from 'vitest'
import { createLiveEvents, frame, liveEventMatches } from './live-events.js'
import type { LiveEvent } from './shared/types.js'

/** BE-P2-12: the live event bus (ids, replay ring, reset) and the stream filters. */

const out = (runId: string, conversationId = 'c1'): LiveEvent => ({ type: 'run.output', conversationId, runId, stream: 'stdout', chunk: 'x' })

describe('createLiveEvents', () => {
  it('numbers events, replays what is newer, and resets when the ring lost some', () => {
    const bus = createLiveEvents({ replay: 3 })
    const seen: number[] = []
    const unsub = bus.subscribe((e) => seen.push(e.id))
    for (let i = 0; i < 5; i++) bus.publish(out(`r${i}`))
    expect(seen).toEqual([1, 2, 3, 4, 5])
    expect(bus.lastId()).toBe(5)
    expect(bus.since(3).events.map((e) => e.id)).toEqual([4, 5])
    expect(bus.since(2)).toMatchObject({ reset: false })
    expect(bus.since(1).reset).toBe(true)
    expect(bus.since(5)).toEqual({ reset: false, events: [] })
    expect(bus.since(9).reset).toBe(true)
    expect(bus.clients()).toBe(1)
    unsub()
    expect(bus.clients()).toBe(0)
  })

  it('frames are id / event / data', () => {
    expect(frame({ id: 7, event: out('r1') })).toBe(`id: 7\nevent: run.output\ndata: ${JSON.stringify(out('r1'))}\n\n`)
  })
})

describe('liveEventMatches', () => {
  it('filters by conversation and by bot (run.output via the run id)', () => {
    const vm = { type: 'vm.updated', agentId: 'a1', vm: {} } as unknown as LiveEvent
    expect(liveEventMatches(out('r1'), {})).toBe(true)
    expect(liveEventMatches(out('r1', 'c1'), { conversationId: 'c1' })).toBe(true)
    expect(liveEventMatches(out('r1', 'c2'), { conversationId: 'c1' })).toBe(false)
    expect(liveEventMatches(vm, { conversationId: 'c1' })).toBe(false)
    expect(liveEventMatches(vm, { agentId: 'a1' })).toBe(true)
    expect(liveEventMatches(vm, { agentId: 'a2' })).toBe(false)
    const runAgent = (id: string) => (id === 'r1' ? 'a1' : 'a2')
    expect(liveEventMatches(out('r1'), { agentId: 'a1', runAgent })).toBe(true)
    expect(liveEventMatches(out('r2'), { agentId: 'a1', runAgent })).toBe(false)
  })
})
