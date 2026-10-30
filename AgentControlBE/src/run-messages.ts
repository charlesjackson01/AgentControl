import type { ChatRunSummary, ScriptRunStatus } from './shared/types.js'

const SUFFIX: Partial<Record<ScriptRunStatus, string>> = {
  failed: 'failed',
  timed_out: 'timed out',
  stopped: 'stopped',
  denied: 'denied',
  undone: 'undone',
}

/** BE-P2-21: the tool build card's name. */
export const TOOL_BUILD_CARD_NAME = 'Rebuild tools'

/**
 * Short plain text for a kind 'run' ChatMessage (sidebar and notification previews).
 * BE-P2-21: a tool build ("Building <Bot>'s tools (version N)") needs `build` and the bot's name.
 */
export function runMessageContent(summary: Pick<ChatRunSummary, 'status' | 'kind' | 'name' | 'scriptName'> & Partial<Pick<ChatRunSummary, 'build'>>, botName?: string): string {
  if (summary.kind === 'tool_build' && summary.build) {
    const bot = botName?.trim() || 'the bot'
    if (summary.status === 'succeeded') return `Built ${bot}'s tools (version ${summary.build.generation})`
    if (summary.status === 'queued' || summary.status === 'running' || summary.status === 'waiting_permission') return `Building ${bot}'s tools (version ${summary.build.generation})`
    return `Tool build (${SUFFIX[summary.status] ?? summary.status})`
  }
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
