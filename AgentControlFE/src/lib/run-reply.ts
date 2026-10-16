/* How a run's reply renders in chat (BE fix/empty-length-reply). Pure helpers, tested in tests/run-reply.test.mjs. */

export const DISABLE_THINKING_HINT = 'Sends enable_thinking: false, for reasoning models like Qwen that can spend the whole reply budget thinking'

/** Placeholder older backends stored for empty replies; never shown as a real answer. */
export const NO_TEXT_PLACEHOLDER = '(no text)'

export const EMPTY_REPLY_ERROR = 'The model returned an empty reply.'

/** True when a reply text carries nothing a reader can use. */
export function isEmptyReply(text: string | null | undefined): boolean {
  const t = (text ?? '').trim()
  return t === '' || t === NO_TEXT_PLACEHOLDER
}

/**
 * The bubble for a finished run: its error when it failed, its output when it
 * has one, else an explicit empty-reply error (never an empty bubble or "(no text)").
 */
export function runReplyView(run: { status?: string; output?: string | null; error?: string | null }): { kind: 'assistant' | 'error'; text: string } {
  const err = (run.error ?? '').trim()
  if (err) return { kind: 'error', text: err }
  if (run.status === 'failed') return { kind: 'error', text: isEmptyReply(run.output) ? 'The run failed without an error message.' : (run.output ?? '').trim() }
  if (isEmptyReply(run.output)) return { kind: 'error', text: EMPTY_REPLY_ERROR }
  return { kind: 'assistant', text: run.output ?? '' }
}

/** Text for a project task result; an empty or placeholder result reads as a failure. */
export function taskResultView(text: string, failed: boolean): { failed: boolean; text: string } {
  if (isEmptyReply(text)) return { failed: true, text: `Could not finish: ${EMPTY_REPLY_ERROR}` }
  return { failed, text }
}

/** The `disableThinking` part of an endpoint body. Create: only when on. Edit: only when changed. */
export function disableThinkingPatch(checked: boolean, stored: boolean | undefined, isEdit: boolean): { disableThinking?: boolean } {
  if (!isEdit) return checked ? { disableThinking: true } : {}
  if (checked === Boolean(stored)) return {}
  return { disableThinking: checked }
}

type MsgLike = { role: 'user' | 'assistant'; content: string; error?: boolean }

/** How a stored chat message renders: flagged failures and empty replies are errors. */
export function chatMessageView(m: MsgLike): { kind: 'user' | 'assistant' | 'error'; text: string } {
  if (m.role === 'user') return { kind: 'user', text: m.content }
  if (m.error === true) return { kind: 'error', text: isEmptyReply(m.content) ? 'The run failed without an error message.' : m.content.trim() }
  if (isEmptyReply(m.content)) return { kind: 'error', text: EMPTY_REPLY_ERROR }
  return { kind: 'assistant', text: m.content }
}

/** Text of the nearest user message before index `i`, for Retry; undefined when none. */
export function retryTextBefore(messages: readonly MsgLike[], i: number): string | undefined {
  for (let j = i - 1; j >= 0; j--) {
    const m = messages[j]
    if (m && m.role === 'user' && m.content.trim()) return m.content
  }
  return undefined
}

/**
 * After a live send: what extra error UI to show beyond the stored messages.
 * - 'pending': no usable assistant message came back; show the run error on the pending turn.
 * - 'banner': a normal-looking reply came back but the run failed (unflagged older backend).
 * - 'none': the reply is fine, or the stored message already renders as an error bubble.
 */
export function liveRunOutcome(
  run: { status?: string; error?: string | null },
  messages: readonly MsgLike[],
): { kind: 'pending' | 'banner' | 'none'; text?: string } {
  const replies = messages.filter((m) => m.role === 'assistant')
  if (replies.some((m) => m.error === true)) return { kind: 'none' }
  const answered = replies.some((m) => !isEmptyReply(m.content))
  if (!answered) return { kind: 'pending', text: runReplyView({ status: run.status, output: '', error: run.error }).text }
  if (run.status === 'failed') return { kind: 'banner', text: (run.error ?? '').trim() || 'The run failed.' }
  return { kind: 'none' }
}
