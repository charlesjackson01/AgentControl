/**
 * BE-P2-8: a streaming, killable process runner (no shell) for script runs. The buffered
 * CommandRunner stays for short engine calls; script output can be hundreds of MB, so it is
 * streamed chunk by chunk and never buffered here.
 */
import { spawn } from 'node:child_process'

export interface StreamOptions {
  onStdout(chunk: Buffer): void
  onStderr(chunk: Buffer): void
}
export interface StreamExit {
  /** Exit code; 127 when the program isn't installed; 137 after kill(). */
  code: number
  /** Set when the program couldn't be started at all. */
  spawnError?: string
}
export interface StreamHandle {
  done: Promise<StreamExit>
  /** Kill the client process (SIGKILL). The caller stops the container to end the work inside it. */
  kill(): void
}
export type StreamRunner = (cmd: string, args: readonly string[], opts: StreamOptions) => StreamHandle

export const spawnStreamRunner: StreamRunner = (cmd, args, opts) => {
  const child = spawn(cmd, [...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  child.stdout.on('data', (c: Buffer) => opts.onStdout(c))
  child.stderr.on('data', (c: Buffer) => opts.onStderr(c))
  const done = new Promise<StreamExit>((resolve) => {
    let settled = false
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return
      settled = true
      resolve({ code: err.code === 'ENOENT' ? 127 : 1, spawnError: err.code === 'ENOENT' ? `${cmd}: not found` : err.message })
    })
    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      resolve({ code: code ?? (signal === 'SIGKILL' ? 137 : 128 + 15) })
    })
  })
  return {
    done,
    kill: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    },
  }
}
