/** BE-P2-12 test helper: a ContainerRunner whose runs end when the test says so. */
import type { ContainerRunner } from './podman-runner.js'
import type { RunScriptRequest, RunScriptResult } from './runner.js'

export interface PendingRun {
  req: RunScriptRequest
  end(result?: Partial<RunScriptResult>): void
  out(stream: 'stdout' | 'stderr', text: string | Buffer): void
}

export interface FakeRunner extends ContainerRunner {
  pending: PendingRun[]
  requests: RunScriptRequest[]
  refuse: RunScriptResult | null
}

export function fakeRunner(): FakeRunner {
  const counts = new Map<string, number>()
  const r: FakeRunner = {
    pending: [],
    requests: [],
    refuse: null,
    async available() {
      return true
    },
    check() {
      return r.refuse
    },
    run(req) {
      r.requests.push(req)
      counts.set(req.agentId, (counts.get(req.agentId) ?? 0) + 1)
      return new Promise<RunScriptResult>((resolve) => {
        let done = false
        const p: PendingRun = {
          req,
          end(result = {}) {
            if (done) return
            done = true
            counts.set(req.agentId, (counts.get(req.agentId) ?? 1) - 1)
            r.pending.splice(r.pending.indexOf(p), 1)
            resolve({ status: 'ok', outcome: 'succeeded', exitCode: 0, durationMs: 7, stdout: '', stderr: '', filesChanged: [], runtime: 'runsc', ...result })
          },
          out(stream, text) {
            req.onOutput?.(stream, typeof text === 'string' ? Buffer.from(text) : text)
          },
        }
        r.pending.push(p)
        req.signal?.addEventListener('abort', () => p.end({ status: 'error', outcome: 'stopped', exitCode: undefined, error: 'The run was stopped.' }))
      })
    },
    activeRuns: (agentId) => counts.get(agentId) ?? 0,
    exclusive: async (_agentId, fn) => fn(),
    stopRuns(agentId) {
      for (const p of [...r.pending]) if (p.req.agentId === agentId) p.end({ status: 'error', outcome: 'stopped', error: 'The run was stopped.' })
    },
    idleStopAt: () => undefined,
    idleSweep: async () => {},
    startIdleTimer: () => () => {},
  }
  return r
}

/** Wait until `cond` holds (polls on the macrotask queue). */
export async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('until: timed out')
    await new Promise((r) => setTimeout(r, 2))
  }
}
