/**
 * BE-P2-2: every podman/docker/wsl CLI call goes through a CommandRunner so
 * tests (and the Mac/Windows logic on a Linux CI box) can swap in a fake.
 * No shell is involved: argv is passed as is.
 */
import { execFile } from 'node:child_process'

export interface CommandResult {
  /** Exit code; 127 when the program isn't installed, 124 on timeout, 130 when stopped through `signal` (BE-P2-21). */
  code: number
  stdout: string
  stderr: string
}

export interface CommandOptions {
  timeoutMs?: number
  /** BE-P2-13: written to the program's stdin (then closed), e.g. a secret that mustn't be in argv. */
  input?: string
  /** BE-P2-21: stop the program (SIGTERM, then SIGKILL after 5 s); the result has code 130. */
  signal?: AbortSignal
  /** BE-P2-21: output as it arrives (the result still carries it all, bounded as before). */
  onOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void
}

/** BE-P2-21: CommandResult.code of a program stopped through CommandOptions.signal. */
export const STOPPED_CODE = 130

export type CommandRunner = (cmd: string, args: readonly string[], opts?: CommandOptions) => Promise<CommandResult>

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_BUFFER = 8 * 1024 * 1024

/** The real runner: execFile without a shell, bounded time and output. */
export const execCommandRunner: CommandRunner = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    if (opts.signal?.aborted) return resolve({ code: STOPPED_CODE, stdout: '', stderr: `${cmd}: stopped` })
    let stopped = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const onAbort = () => {
      stopped = true
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5_000)
      killTimer.unref?.()
    }
    const child = execFile(
      cmd,
      [...args],
      { timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true, encoding: 'utf8' },
      (err, stdout, stderr) => {
        opts.signal?.removeEventListener('abort', onAbort)
        if (killTimer) clearTimeout(killTimer)
        if (stopped) return resolve({ code: STOPPED_CODE, stdout, stderr: stderr || `${cmd}: stopped` })
        if (!err) return resolve({ code: 0, stdout, stderr })
        const e = err as NodeJS.ErrnoException & { code?: string | number; killed?: boolean; signal?: string | null }
        if (e.code === 'ENOENT') return resolve({ code: 127, stdout: '', stderr: `${cmd}: not found` })
        if (e.killed || e.signal === 'SIGTERM') return resolve({ code: 124, stdout, stderr: stderr || `${cmd}: timed out` })
        resolve({ code: typeof e.code === 'number' ? e.code : 1, stdout, stderr: stderr || e.message })
      },
    )
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    if (opts.onOutput) {
      const on = opts.onOutput
      child.stdout?.on('data', (d: string | Buffer) => on('stdout', String(d)))
      child.stderr?.on('data', (d: string | Buffer) => on('stderr', String(d)))
    }
    if (opts.input !== undefined) {
      child.stdin?.on('error', () => {})
      child.stdin?.end(opts.input)
    }
  })
