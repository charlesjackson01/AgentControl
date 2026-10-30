import type { ChatRunSummary, ScriptRunStatus } from './shared/types.js'

const SUFFIX: Partial<Record<ScriptRunStatus, string>> = {
  failed: 'failed',
  timed_out: 'timed out',
  stopped: 'stopped',
  denied: 'denied',
  undone: 'undone',
}

/** Short plain text for a kind 'run' ChatMessage (sidebar and notification previews). */
export function runMessageContent(summary: Pick<ChatRunSummary, 'status' | 'kind' | 'name' | 'scriptName'>): string {
  const label = (summary.scriptName || summary.name || 'script').trim() || 'script'
  if (summary.kind === 'undo') {
    if (summary.status === 'succeeded') return `Undid ${label}`
    if (summary.status === 'queued' || summary.status === 'running' || summary.status === 'waiting_permission') return `Undoing ${label}`
    return `Undo of ${label} (${SUFFIX[summary.status] ?? summary.status})`
  }
  if (summary.status === 'queued') return `Queued ${label}`
  if (summary.status === 'running' || summary.status === 'waiting_permission') return `Running ${label}`
  const suffix = SUFFIX[summary.status]
  return suffix ? `Ran ${label} (${suffix})` : `Ran ${label}`
}
