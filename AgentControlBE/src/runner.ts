/**
 * Script runner contract (BE-1 stub). Phase 2 runs skill scripts in a
 * per-bot VM; until then every run reports `unavailable`.
 */
export interface RunScriptRequest {
  agentId: string
  context: { kind: 'dm' } | { kind: 'group'; groupId: string }
  skillId?: string
  argv: string[]
  /** Relative to the bot's folder, forward slashes. */
  cwd: string
  timeoutSec: number
  network: 'off' | 'on'
}

export interface RunScriptResult {
  status: 'ok' | 'error' | 'unavailable'
  exitCode?: number
  durationMs: number
  stdout: string
  stderr: string
  filesChanged: { path: string; change: 'added' | 'modified' }[]
}

export interface Runner {
  available(): Promise<boolean>
  run(req: RunScriptRequest): Promise<RunScriptResult>
}

export const RUNNER_UNAVAILABLE = 'Script runs arrive in Phase 2; this bot has no VM yet.'

/** Phase 1 runner: never available, never runs anything. */
export const noopRunner: Runner = {
  async available() {
    return false
  },
  async run() {
    return { status: 'unavailable', durationMs: 0, stdout: '', stderr: RUNNER_UNAVAILABLE, filesChanged: [] }
  },
}
