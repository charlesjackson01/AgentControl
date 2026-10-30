/**
 * Script runner contract (BE-1 stub). Phase 2 runs skill scripts in a
 * per-bot VM; until then every run reports `unavailable`.
 */
import type { FileChange, SnapshotDriver } from './shared/types.js'

export interface RunScriptRequest {
  agentId: string
  context: { kind: 'dm' } | { kind: 'group'; groupId: string }
  skillId?: string
  argv: string[]
  /** Relative to the bot's folder, forward slashes. */
  cwd: string
  timeoutSec: number
  network: 'off' | 'on'
  /** BE-P2-8 (optional): run id, passed to the script as AC_RUN_ID. */
  runId?: string
  /** BE-P2-8 (optional): every output chunk within the 200 MB cap, for the full log on disk (BE-P2-12). */
  onOutput?: (stream: 'stdout' | 'stderr', chunk: Buffer) => void
  /** BE-P2-8 (optional): abort = stop the run (the container is stopped too). */
  signal?: AbortSignal
  /** BE-P2-8 (optional): extra env set by AgentControl (wins over the bot's env). */
  extraEnv?: { name: string; value: string }[]
}

export interface RunScriptResult {
  status: 'ok' | 'error' | 'unavailable'
  exitCode?: number
  durationMs: number
  stdout: string
  stderr: string
  /** BE-P2-9: what the run changed in the bot's workspace and group folders (from its snapshot diff). */
  filesChanged: FileChange[]
  /**
   * BE-P2-9 (optional): the run's undo snapshot (ScriptRun.snapshot); null when none was taken
   * (snapshots off, or taking/finishing it failed). Absent from runners without snapshots.
   */
  snapshot?: { id: string; driver: SnapshotDriver; retainedBytes: number } | null
  /** BE-P2-8 (optional) fields from the VM runner. */
  outcome?: 'succeeded' | 'failed' | 'timed_out' | 'stopped'
  /** Plain-language reason when not succeeded. */
  error?: string
  /** Machine-readable reason when the run was refused before starting (e.g. 'limits_unenforced'). */
  reason?: string
  /** Bytes the script wrote (both streams, counted up to the cap). */
  outputBytes?: number
  outputTruncated?: boolean
  runtime?: 'runsc' | 'crun' | 'runc' | null
  oomKilled?: boolean
  pidsLimited?: boolean
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
