import type { AgentStatus, RunStatus } from '../lib/types'
import { STATUS_LABELS } from '../lib/api'

const DOT_CLASS: Record<AgentStatus | RunStatus, string> = {
  running: '',
  idle: ' dot--idle',
  queued: ' dot--warn',
  error: ' dot--danger',
  succeeded: '',
  failed: ' dot--danger',
}

export function StatusPill({ status }: { status: AgentStatus }) {
  return (
    <span className={`status status--${status}`}>
      <span className={`dot${DOT_CLASS[status]}`} />
      {STATUS_LABELS[status]}
    </span>
  )
}