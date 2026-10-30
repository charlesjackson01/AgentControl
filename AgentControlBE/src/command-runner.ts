/**
 * BE-P2-2: every podman/docker/wsl CLI call goes through a CommandRunner so
 * tests (and the Mac/Windows logic on a Linux CI box) can swap in a fake.
 * No shell is involved: argv is passed as is.
 */
import { execFile } from 'node:child_process'

export interface CommandResult {
  /** Exit code; 127 when the program isn't installed, 124 on timeout. */
  code: number
  stdout: string
  stderr: string
}

export interface CommandOptions {
  timeoutMs?: number
}

export type CommandRunner = (cmd: string, args: readonly string[], opts?: CommandOptions) => Promise<CommandResult>

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_BUFFER = 8 * 1024 * 1024

/** The real runner: execFile without a shell, bounded time and output. */
export const execCommandRunner: CommandRunner = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      [...args],
      { timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (!err) return resolve({ code: 0, stdout, stderr })
        const e = err as NodeJS.ErrnoException & { code?: string | number; killed?: boolean; signal?: string | null }
        if (e.code === 'ENOENT') return resolve({ code: 127, stdout: '', stderr: `${cmd}: not found` })
        if (e.killed || e.signal === 'SIGTERM') return resolve({ code: 124, stdout, stderr: stderr || `${cmd}: timed out` })
        resolve({ code: typeof e.code === 'number' ? e.code : 1, stdout, stderr: stderr || e.message })
      },
    )
  })
