import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { api } from '../../lib/api'
import { runOutput, runSummaryFor, scriptName } from '../../lib/live-store'
import { runCardView, stopErrorText } from '../../lib/run-card'
import { renderRunCard, type RunCardHandlers } from '../../lib/run-card-render'
import type { RunCardView } from '../../lib/run-card'
import type { ChatMessage, ScriptRun, UndoResult } from '../../lib/types'
import { useLive } from '../../state/live-context'
import UndoDialog from './UndoDialog'
import RunOutputDialog from './RunOutputDialog'

type RunCardClient = {
  stopRun: (runId: string) => Promise<ScriptRun>
}

type RunCardProps = {
  /** A ChatMessage of kind 'run' (scriptRunId + scriptRun). */
  message: Pick<ChatMessage, 'id' | 'scriptRunId' | 'scriptRun'>
  /** The bot that ran it (dialog subtitles, "Analyst's 2 GB undo space"). */
  botName?: string
  agentId?: string
  /** groupId → name, for the undo dialog's group-folder rows. */
  groupNames?: Readonly<Record<string, string>>
  client?: RunCardClient
}

/** The markup (lib/run-card-render.ts) as a component, so refs pass as props. */
function RunCardMarkup({ view, x }: { view: RunCardView; x: RunCardHandlers }) {
  return renderRunCard(view, x)
}

const DETAILS_ERROR = "Couldn't load this run's details."

/**
 * FE-P2-2: one script run in the chat (mockup a). Updates in place from run.updated (by messageId)
 * and run.output; Undo opens the undo dialog (FE-P2-4); Stop while active. Logic: lib/run-card.ts.
 */
export default function RunCard({ message, botName, agentId, groupNames, client = api.vm }: RunCardProps) {
  const { state, loadRun, trackRuns, putRun } = useLive()
  const runId = message.scriptRunId ?? ''
  const summary = runSummaryFor(state, message)
  const run: ScriptRun | undefined = runId ? state.runs[runId] : undefined
  const output = runId ? runOutput(state, runId) : undefined
  const undoOf = run?.kind === 'undo' && run.undoOfRunId ? state.runs[run.undoOfRunId] : undefined
  const budgetBytes = agentId ? state.vms[agentId]?.usage.snapshots.budgetBytes : undefined

  const status = run?.status ?? summary?.status
  const active = status === 'queued' || status === 'waiting_permission' || status === 'running'
  // Contract 146cd18: the card renders from the message's summary; GET /api/runs/:id only once the
  // details or the full output are opened. A run that's going on opens (live output); others start
  // collapsed (GAP-R15).
  const [open, setOpen] = useState(active)
  const [now, setNow] = useState(() => Date.now())
  const [loadError, setLoadError] = useState<string | null>(null)
  const [stopping, setStopping] = useState(false)
  const [stopError, setStopError] = useState<string | null>(null)
  const [dialog, setDialog] = useState<'undo' | 'output' | null>(null)
  const bodyId = useId()
  const undoBtn = useRef<HTMLButtonElement | null>(null)
  const outputBtn = useRef<HTMLButtonElement | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)

  const load = useCallback(() => {
    if (!runId) return
    void loadRun(runId).then((r) => setLoadError(r ? null : DETAILS_ERROR))
  }, [loadRun, runId])
  const retry = () => {
    setLoadError(null)
    load()
  }

  // The details need the run (argv, meta, files, output tails): fetched when the card is open.
  const haveRun = Boolean(run)
  useEffect(() => {
    if (open && !haveRun) load()
  }, [open, haveRun, load])

  // Active runs: make sure a reconnect's resync covers this one even before it's loaded.
  useEffect(() => {
    if (runId && active) trackRuns([runId])
  }, [runId, active, trackRuns])

  // The undone run's name for an undo card.
  const undoOfId = run?.kind === 'undo' ? run.undoOfRunId : undefined
  const haveUndoOf = Boolean(undoOf)
  useEffect(() => {
    if (undoOfId && !haveUndoOf) void loadRun(undoOfId)
  }, [undoOfId, haveUndoOf, loadRun])

  // The running clock.
  useEffect(() => {
    if (status !== 'running') return
    const tick = () => setNow(Date.now())
    const first = window.setTimeout(tick, 0)
    const t = window.setInterval(tick, 1000)
    return () => {
      window.clearTimeout(first)
      window.clearInterval(t)
    }
  }, [status])

  // A stop that's on its way ends when the run does.
  const busy = stopping && active

  const stop = () => {
    if (!runId || busy) return
    setStopping(true)
    setStopError(null)
    client.stopRun(runId).then(
      // Stays "Stopping…" until run.updated (or this reply) says the run ended.
      (r) => putRun(r),
      (err: unknown) => {
        setStopping(false)
        const text = stopErrorText(err)
        if (text) setStopError(text)
        // 409: it already ended; fetch where it is now.
        else void loadRun(runId)
      },
    )
  }

  const onUndone = (result: UndoResult) => {
    putRun(result.run)
    putRun(result.undoRun)
  }

  const view = runCardView({
    summary,
    run,
    output,
    now,
    undoOfName: undoOf ? scriptName(undoOf) : undefined,
    botName,
    budgetBytes,
    groupNames,
  })

  // Focus goes back to the button that opened a dialog, or the card's header when that button is gone (undone).
  const headOf = () => cardRef.current?.querySelector<HTMLElement>('.rc-head') ?? null
  const undoFocus = () => (undoBtn.current?.isConnected ? undoBtn.current : headOf())
  const outputFocus = () => (outputBtn.current?.isConnected ? outputBtn.current : headOf())

  return (
    <div className="rc-wrap" ref={cardRef} data-run-id={runId}>
      <RunCardMarkup
        view={view}
        x={{
          open,
          onToggle: () => setOpen((o) => !o),
          bodyId,
          onStop: stop,
          stopping: busy,
          stopError,
          onUndo: () => setDialog('undo'),
          onOutput: () => setDialog('output'),
          loadError,
          onRetry: retry,
          undoRef: undoBtn,
          outputRef: outputBtn,
        }}
      />
      {run && dialog === 'undo' && (
        <UndoDialog
          open
          run={run}
          botName={botName}
          groupNames={groupNames}
          budgetBytes={budgetBytes}
          onClose={() => setDialog(null)}
          onUndone={onUndone}
          returnFocus={undoFocus}
        />
      )}
      {run && dialog === 'output' && (
        <RunOutputDialog run={run} name={view.name} botName={botName} onClose={() => setDialog(null)} returnFocus={outputFocus} />
      )}
    </div>
  )
}
