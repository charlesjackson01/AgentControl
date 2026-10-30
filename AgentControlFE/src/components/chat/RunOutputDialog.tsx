import { useEffect, useState } from 'react'
import Dialog from '../Dialog'
import { api } from '../../lib/api'
import { outputErrorText } from '../../lib/run-card'
import type { ScriptRun } from '../../lib/types'
import { runWhen } from '../../lib/undo'
import type { RunOutputStream } from '../../lib/vm-api'

type OutputClient = { getRunOutput: (runId: string, stream?: RunOutputStream) => Promise<string> }

type Phase = { kind: 'loading' } | { kind: 'done'; stdout: string; stderr: string } | { kind: 'error'; text: string }

/**
 * GAP-R11: what "Full output" opens. No mockup; it follows the dialog pattern (mockup d) and shows
 * GET /api/runs/:id/output for stdout, then stderr. 404/410 mean the log was evicted (§7.1).
 */
export default function RunOutputDialog({
  run,
  name,
  botName,
  onClose,
  returnFocus,
  client = api.vm,
}: {
  run: ScriptRun
  name: string
  botName?: string
  onClose: () => void
  returnFocus?: () => HTMLElement | null
  client?: OutputClient
}) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const runId = run.id

  useEffect(() => {
    let live = true
    Promise.all([client.getRunOutput(runId, 'stdout'), client.getRunOutput(runId, 'stderr')]).then(
      ([stdout, stderr]) => live && setPhase({ kind: 'done', stdout, stderr }),
      (err: unknown) => live && setPhase({ kind: 'error', text: outputErrorText(err) }),
    )
    return () => {
      live = false
    }
  }, [client, runId, attempt])

  const subtitle = [name, runWhen(run.startedAt ?? run.queuedAt), botName].filter(Boolean).join(' · ')
  const gone = phase.kind === 'error' && /removed/.test(phase.text)

  return (
    <Dialog
      open
      size="lg"
      title="Full output"
      subtitle={subtitle}
      onClose={onClose}
      returnFocus={returnFocus}
      footer={
        <>
          {phase.kind === 'error' && !gone && (
            <button type="button" className="btn btn--ghost" onClick={() => {
                setPhase({ kind: 'loading' })
                setAttempt((n) => n + 1)
              }}>
              Try again
            </button>
          )}
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      {phase.kind === 'loading' && (
        <div className="rc-out" aria-busy="true">
          <p className="undo-intro" role="status">Loading the output…</p>
          <div className="undo-skel"><span className="skeleton" /><span className="skeleton" /></div>
        </div>
      )}
      {phase.kind === 'error' && <p className={gone ? 'undo-note-box' : 'notice notice--warn'} role="alert">{phase.text}</p>}
      {phase.kind === 'done' && (
        <div className="rc-out">
          {!phase.stdout.trim() && !phase.stderr.trim() && <p className="undo-intro">This run didn't print anything.</p>}
          {phase.stdout.trim() && (
            <section>
              <h4 className="rc-out__h">Output</h4>
              <pre className="rc-out__pre" tabIndex={0}>{phase.stdout}</pre>
            </section>
          )}
          {phase.stderr.trim() && (
            <section>
              <h4 className="rc-out__h">Errors</h4>
              <pre className="rc-out__pre rc-out__pre--err" tabIndex={0}>{phase.stderr}</pre>
            </section>
          )}
          {run.outputTruncated && <p className="undo-note-box">The output passed the 200 MB limit; the rest wasn't kept.</p>}
        </div>
      )}
    </Dialog>
  )
}
