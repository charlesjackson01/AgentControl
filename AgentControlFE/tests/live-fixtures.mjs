// FE-P2-1 test fixtures: fake Phase 2 data (shapes from AgentControlBE/src/shared/types.ts @ 6e4291b).
export const run = (id, extra = {}) => ({
  id, agentId: 'a1', conversationId: 'c1', messageId: `m-${id}`, context: 'dm', kind: 'script', argv: ['python3', 'scripts/clean.py'],
  cwd: 'workspace', network: 'off', browser: false, runtime: 'runsc', permissions: [], status: 'running',
  queuedAt: '2026-10-27T10:00:00.000Z', stdoutTail: '', stderrTail: '', outputBytes: 0, filesChanged: [],
  snapshot: null, undo: { state: 'available' }, ...extra,
})
export const summary = (extra = {}) => ({ status: 'running', kind: 'script', name: 'clean.py', files: { added: 0, modified: 0, deleted: 0 }, undo: { state: 'available' }, ...extra })
export const vm = (agentId = 'a1', extra = {}) => ({
  agentId, state: 'running', host: { engine: 'podman', provider: 'native' },
  runtime: { effective: 'runsc', status: 'active', mode: 'inherit', globalMode: 'auto' }, internetPolicy: 'ask',
  permissions: { browser: false, browserState: 'absent' },
  limits: { memoryMb: 4096, personalDiskMb: 10240, cpus: 2, timeoutSec: 600, pids: 256, outputMb: 200 },
  usage: { memoryMb: 0, personalBytes: 0, personalQuotaBytes: 10737418240, breakdown: { workspace: 0, inputs: 0, memory: 0, tools: 0, opt: 0, imageLayer: 0 }, snapshots: { bytes: 0, budgetBytes: 2147483648, runsWithUndo: 0 } },
  env: [], packages: [], image: { generation: 0, base: 'base' }, storage: { backend: 'local', driver: 'reflink', location: '~/.agentcontrol' }, runs: [], ...extra,
})
export const permission = (id, extra = {}) => ({
  id, runId: 'r1', agentId: 'a1', conversationId: 'c1', type: 'internet', hosts: ['pypi.org'], status: 'pending',
  createdAt: '2026-10-27T10:00:00.000Z', expiresAt: '2026-10-27T10:10:00.000Z', ...extra,
})

/** One SSE frame as the BE writes it. */
export const frame = (id, ev) => `id: ${id}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`

/**
 * A fake fetch for GET /api/events. Each call takes the next scripted connection:
 * { status?, frames: string[], end?: boolean } — frames are pushed, then the stream ends
 * (end !== false) or stays open until aborted. Records each call's headers.
 */
export function fakeEventsFetch(connections) {
  const calls = []
  const fn = async (url, init) => {
    calls.push({ url, headers: { ...init.headers } })
    const c = connections.shift() ?? { frames: [], end: false }
    if (c.throws) throw new Error('network down')
    const body = new ReadableStream({
      start(ctrl) {
        const enc = new TextEncoder()
        for (const f of c.frames ?? []) ctrl.enqueue(enc.encode(f))
        if (c.end !== false) ctrl.close()
        init.signal?.addEventListener('abort', () => {
          try {
            ctrl.error(new DOMException('aborted', 'AbortError'))
          } catch {
            // already closed
          }
        })
      },
    })
    return new Response(c.status && c.status >= 400 ? 'nope' : body, { status: c.status ?? 200, headers: { 'Content-Type': 'text/event-stream' } })
  }
  return { fetch: fn, calls }
}

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

/** Wait until `pred()` holds (polls every 2 ms, fails after `ms`). */
export async function until(pred, ms = 1000) {
  const end = Date.now() + ms
  while (!pred()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await tick(2)
  }
}
