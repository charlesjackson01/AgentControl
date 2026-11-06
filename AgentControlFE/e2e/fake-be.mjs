/*
 * FE-P2-8 fake runner / fake backend for Playwright.
 * Speaks the routes the chat, the per-bot VM tab and Settings › VMs call.
 * Never starts podman. The opt-in @vm smoke does not use this process.
 *
 *   AC_E2E_PORT=3099 node e2e/fake-be.mjs
 *
 * Cookie `ac-e2e-scene` is `mac` (default), `linux`, or `windows` (storage.backend === 'wsl').
 * Cookie `ac-e2e-restore=tools-fail` makes each restore agent a mixed toolResults:
 * apt started, pip failed, npm not_needed, opt not_restorable.
 * POST /__e2e/reset restores the in-memory world between tests.
 */
import http from 'node:http'
import {
  AGENT_ID, CONV_ID, agent, backups, browser, conversation, createWorld, historyRow, hostFor, messagesFor,
  probe, profile, settings, vmFor,
} from './world.mjs'

const port = Number(process.env.AC_E2E_PORT || 3099)

let world = createWorld()

function reset() {
  world = createWorld()
}

function sceneOf(req) {
  const cookie = req.headers.cookie ?? ''
  const match = /(?:^|;\s*)ac-e2e-scene=([^;]+)/.exec(cookie)
  const value = match ? decodeURIComponent(match[1]) : 'mac'
  if (value === 'linux' || value === 'windows' || value === 'mac') return value
  return 'mac'
}

/** Settings › VMs specs set this so a restore mixes started, failed, and not_restorable tools. */
function restoreToolsFail(req) {
  const cookie = req.headers.cookie ?? ''
  return /(?:^|;\s*)ac-e2e-restore=tools-fail(?:;|$)/.test(cookie)
}

const PIP_FAIL = "Internet is set to Never for Analyst, so this build didn't start. Change it in Settings › VM."
const OPT_FAIL = "These programs in /opt/bot/bin can't be reinstalled from a backup: ffmpeg, yt-dlp. Ask the bot to set them up again."

/** Always apt, pip, npm, opt. The quiet path is all not_needed; the cookie path is mixed. */
function toolResultsFor(fail) {
  if (!fail) {
    return [
      { kind: 'apt', status: 'not_needed', items: [] },
      { kind: 'pip', status: 'not_needed', items: [] },
      { kind: 'npm', status: 'not_needed', items: [] },
      { kind: 'opt', status: 'not_needed', items: [] },
    ]
  }
  return [
    { kind: 'apt', status: 'started', items: ['curl', 'git'], runId: 'run-apt' },
    { kind: 'pip', status: 'failed', items: ['requests==2.32.0'], message: PIP_FAIL },
    { kind: 'npm', status: 'not_needed', items: [] },
    { kind: 'opt', status: 'not_restorable', items: ['ffmpeg', 'yt-dlp'], message: OPT_FAIL },
  ]
}

function restoreAgent(agentId, fail) {
  const toolResults = toolResultsFor(fail)
  if (!fail) return { agentId, files: 4, tools: 'not_needed', toolResults }
  return { agentId, files: 4, tools: 'failed', toolsMessage: `${PIP_FAIL} ${OPT_FAIL}`, toolResults }
}

/** Settings › VMs specs set this so a waiting permission doesn't count as an active run. */
function shownRuns(req) {
  const cookie = req.headers.cookie ?? ''
  if (!/(?:^|;\s*)ac-e2e-runs=idle(?:;|$)/.test(cookie)) return world.runs
  return Object.fromEntries(
    Object.entries(world.runs).filter(([, row]) => row.status !== 'waiting_permission' && row.status !== 'queued' && row.status !== 'running'),
  )
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve(null)
      try {
        resolve(JSON.parse(raw))
      } catch {
        resolve(null)
      }
    })
    req.on('error', reject)
  })
}

function send(res, status, body) {
  const json = JSON.stringify(body ?? null)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(json),
  })
  res.end(json)
}

function missing(res, method, path) {
  send(res, 404, { error: 'Not Found', message: `Route ${method}:${path} not found` })
}

function confirmed(req) {
  return req.headers['x-agentcontrol-confirm'] === '1'
}

function runsPage() {
  const runs = Object.values(world.runs)
    .filter((row) => row.kind === 'script' && (row.status === 'succeeded' || row.status === 'undone'))
    .sort((a, b) => b.queuedAt.localeCompare(a.queuedAt))
    .map(historyRow)
  return { runs, hasMore: false }
}

function undoResult(row) {
  const at = '2026-11-06T15:00:00.000Z'
  const undoId = `undo-${row.id}`
  const undone = {
    ...row,
    status: 'undone',
    undo: { state: 'done', at, undoRunId: undoId },
  }
  const undoRun = {
    ...row,
    id: undoId,
    kind: 'undo',
    argv: [],
    status: 'succeeded',
    exitCode: 0,
    undoOfRunId: row.id,
    undo: { state: 'unavailable' },
    filesChanged: row.filesChanged.map((file) => ({ ...file, change: file.change === 'added' ? 'deleted' : 'modified' })),
    snapshot: null,
    stdoutTail: '',
    stderrTail: '',
    queuedAt: at,
    startedAt: at,
    endedAt: at,
    durationMs: 200,
  }
  world.runs[row.id] = undone
  world.runs[undoId] = undoRun
  return { run: undone, undoRun }
}

async function handle(req, res) {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const path = url.pathname
  const method = req.method ?? 'GET'
  const scene = sceneOf(req)

  if (method === 'POST' && path === '/__e2e/reset') {
    reset()
    return send(res, 200, { ok: true })
  }

  if (method === 'GET' && path === '/api/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    res.write('retry: 60000\n\n')
    const timer = setInterval(() => {
      res.write(': ping\n\n')
    }, 10_000)
    req.on('close', () => clearInterval(timer))
    return
  }

  if (method === 'GET' && path === '/api/profile') return send(res, 200, profile)
  if (method === 'GET' && path === '/api/agents') return send(res, 200, [agent])
  if (method === 'GET' && path === `/api/agents/${AGENT_ID}`) return send(res, 200, agent)
  const runs = shownRuns(req)
  if (method === 'GET' && path === '/api/conversations') return send(res, 200, [conversation(runs)])
  if (method === 'GET' && path === '/api/endpoints') {
    return send(res, 200, [{
      id: 'ep1',
      kind: 'openai-compatible',
      name: 'Local',
      baseUrl: 'http://127.0.0.1:9',
      defaultModel: 'local',
      contextWindow: 8192,
      apiKeySet: false,
      status: 'unknown',
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    }])
  }

  if (method === 'GET' && path === `/api/conversations/${CONV_ID}/messages`) {
    return send(res, 200, { conversation: conversation(runs), messages: messagesFor(runs), hasMore: false })
  }
  if (method === 'POST' && path === `/api/conversations/${CONV_ID}/read`) {
    return send(res, 200, conversation(runs))
  }

  if (method === 'GET' && path === `/api/agents/${AGENT_ID}/memory`) {
    return send(res, 200, { items: [], total: 0, promptTokens: 0 })
  }
  if (method === 'GET' && path === `/api/agents/${AGENT_ID}/files`) {
    return send(res, 200, {
      root: 'bots/analyst/',
      path: url.searchParams.get('path') ?? '',
      entries: [],
      usage: { bytes: 0, quotaBytes: 10 * 1024 ** 3, trashBytes: 0 },
      totalFiles: 0,
    })
  }

  if (method === 'GET' && path === `/api/agents/${AGENT_ID}/vm`) return send(res, 200, vmFor(scene, world.runs))
  if (method === 'GET' && path === `/api/agents/${AGENT_ID}/script-runs`) return send(res, 200, runsPage())
  if (method === 'GET' && path === '/api/vm/host') return send(res, 200, hostFor(scene))
  if (method === 'GET' && path === '/api/vm/settings') return send(res, 200, settings)
  if (method === 'PATCH' && path === '/api/vm/settings') {
    const body = await readBody(req)
    return send(res, 200, {
      gvisor: body?.gvisor ?? settings.gvisor,
      backups: { ...settings.backups, ...(body?.backups ?? {}) },
      snapshotBudget: { ...settings.snapshotBudget, ...(body?.snapshotBudget ?? {}) },
    })
  }
  if (method === 'GET' && path === '/api/vm/probe') return send(res, 200, probe)
  if (method === 'POST' && path === '/api/vm/probe') return send(res, 200, probe)
  if (method === 'GET' && path === '/api/vm/browser') return send(res, 200, browser)
  if (method === 'GET' && path === '/api/vm/backups') return send(res, 200, backups)
  if (method === 'POST' && path === '/api/vm/backups') {
    return send(res, 202, {
      id: 'bk-manual',
      createdAt: '2026-11-06T15:00:00.000Z',
      trigger: 'manual',
      agentIds: [AGENT_ID],
      bytes: 0,
      path: 'data/backups/manual',
      status: 'in_progress',
      progress: { done: 0, total: 1 },
    })
  }
  const restore = /^\/api\/vm\/backups\/([^/]+)\/restore$/.exec(path)
  if (restore && method === 'POST') {
    const body = await readBody(req)
    if (body?.confirm !== true) return send(res, 400, { error: 'Request Error', reason: 'confirm_required', message: 'Restoring a backup needs confirm: true.' })
    const found = backups.find((row) => row.id === decodeURIComponent(restore[1]))
    if (!found) return send(res, 404, { error: 'Not Found', reason: 'not_found', message: 'That backup is gone.' })
    const fail = restoreToolsFail(req)
    const agentIds = found.agentIds?.length ? found.agentIds : [AGENT_ID]
    return send(res, 200, {
      backupId: found.id,
      agents: agentIds.map((agentId) => restoreAgent(agentId, fail)),
    })
  }

  if (method === 'GET' && path === '/api/permissions') {
    const requests = Object.values(world.permissions).filter((row) => row.status === 'pending')
    return send(res, 200, { requests, now: '2026-11-06T15:00:00.000Z' })
  }

  const onePermission = /^\/api\/permissions\/([^/]+)$/.exec(path)
  if (onePermission && method === 'GET') {
    const row = world.permissions[decodeURIComponent(onePermission[1])]
    if (!row) return send(res, 404, { error: 'Not Found', message: 'No permission' })
    return send(res, 200, row)
  }
  if (onePermission && method === 'POST') {
    if (!confirmed(req)) return send(res, 403, { error: 'Forbidden', message: 'Confirm header required.' })
    const id = decodeURIComponent(onePermission[1])
    const row = world.permissions[id]
    if (!row) return send(res, 404, { error: 'Not Found', message: 'No permission' })
    if (row.status !== 'pending') return send(res, 409, { error: 'Request Error', reason: 'already_resolved', message: 'Already answered.' })
    const body = await readBody(req)
    const decision = body?.decision
    const allowed = row.type === 'browser' ? decision === 'enable' || decision === 'deny' : decision === 'allow_once' || decision === 'always' || decision === 'deny'
    if (!allowed) return send(res, 400, { error: 'Request Error', message: 'That answer does not fit this request.' })
    const status = decision === 'allow_once' ? 'allowed_once' : decision === 'always' ? 'always' : decision === 'enable' ? 'enabled' : 'denied'
    const next = { ...row, status, resolvedAt: '2026-11-06T15:00:00.000Z', resolvedBy: 'user' }
    world.permissions[id] = next
    return send(res, 200, next)
  }

  const oneRun = /^\/api\/runs\/([^/]+)$/.exec(path)
  if (oneRun && method === 'GET') {
    const row = world.runs[decodeURIComponent(oneRun[1])]
    if (!row) return send(res, 404, { error: 'Not Found', message: 'No run' })
    return send(res, 200, row)
  }
  const preview = /^\/api\/runs\/([^/]+)\/undo\/preview$/.exec(path)
  if (preview && method === 'GET') {
    const row = world.runs[decodeURIComponent(preview[1])]
    if (!row) return send(res, 404, { error: 'Not Found', message: 'No run' })
    if (row.undo?.state === 'unavailable') {
      return send(res, 410, {
        error: 'Request Error',
        reason: row.undo.reason ?? 'expired',
        message: 'Undo no longer available.',
      })
    }
    return send(res, 200, {
      runId: row.id,
      changes: row.filesChanged.map((file) => ({
        path: file.path,
        action: file.change === 'added' ? 'delete' : 'restore',
        root: 'agent',
        afterBytes: file.change === 'deleted' ? null : file.bytes ?? null,
        beforeBytes: file.change === 'added' ? null : file.bytes ?? null,
      })),
      conflicts: [],
      caveats: row.network === 'on' ? ['internet'] : [],
      budget: { usedBytes: 4096, limitBytes: 2 * 1024 ** 3 },
    })
  }
  const undo = /^\/api\/runs\/([^/]+)\/undo$/.exec(path)
  if (undo && method === 'POST') {
    const row = world.runs[decodeURIComponent(undo[1])]
    if (!row) return send(res, 404, { error: 'Not Found', message: 'No run' })
    if (row.undo?.state === 'unavailable') {
      return send(res, 410, { error: 'Request Error', reason: row.undo.reason ?? 'expired', message: 'Undo no longer available.' })
    }
    if (row.undo?.state === 'done') {
      return send(res, 409, { error: 'Request Error', reason: 'already_undone', message: 'Already undone.' })
    }
    return send(res, 200, undoResult(row))
  }

  return missing(res, method, path)
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (res.headersSent) return
    send(res, 500, { error: 'Internal Server Error', message: err instanceof Error ? err.message : 'fake runner failed' })
  })
})

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`fake-be listening on 127.0.0.1:${port}\n`)
})
