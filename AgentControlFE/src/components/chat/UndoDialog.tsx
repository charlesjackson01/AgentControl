import { useCallback, useEffect, useReducer, useRef } from 'react'
import Dialog from '../Dialog'
import { api } from '../../lib/api'
import type { ScriptRun, UndoPreview, UndoResult } from '../../lib/types'
import { initialUndoPhase, undoFooter, undoReducer, undoSubtitle } from '../../lib/undo'
import { renderUndoBody } from '../../lib/undo-render'
import { friendlyError } from '../../lib/chat-format'
import { undoErrorOf, type UndoError } from '../../lib/vm-api'

/** The contract's error, with "Could not reach the API server" in place of a bare fetch failure. */
const errorOf = (err: unknown): UndoError => ({ ...undoErrorOf(err), message: friendlyError(err, 'Undo failed.') })

type UndoClient = {
  getUndoPreview: (runId: string) => Promise<UndoPreview>
  /** force: "Undo anyway". */
  undoRun: (runId: string, force?: boolean) => Promise<UndoResult>
}

type UndoDialogProps = {
  open: boolean
  run: ScriptRun
  /** The bot that ran it (subtitle, "Analyst's 2 GB undo space", the run_active line). */
  botName?: string
  /** groupId → name, so group-folder rows say which folder (§7.3.5). */
  groupNames?: Readonly<Record<string, string>>
  /** Fallback undo budget (VmInfo usage.snapshots.budgetBytes) for budget_bot; the preview's budget.limitBytes wins. */
  budgetBytes?: number
  onClose: () => void
  /** 200: the caller puts result.run and result.undoRun into the live store (putRun). */
  onUndone?: (result: UndoResult) => void
  returnFocus?: () => HTMLElement | null
  /** Defaults to the app's API; tests and screenshots pass a fake. */
  client?: UndoClient
}

/** FE-P2-4: "Undo this run?" (mockup d), with conflicts / Undo anyway, run_active and 410 states. */
export default function UndoDialog({ open, run, botName, groupNames, budgetBytes, onClose, onUndone, returnFocus, client = api.vm }: UndoDialogProps) {
  const [phase, dispatch] = useReducer(undoReducer, initialUndoPhase)
  const seq = useRef(0)
  const runId = run.id

  const load = useCallback(() => {
    const mine = ++seq.current
    dispatch({ type: 'load' })
    client.getUndoPreview(runId).then(
      (preview) => mine === seq.current && dispatch({ type: 'preview', preview }),
      (err: unknown) => mine === seq.current && dispatch({ type: 'preview_failed', error: errorOf(err) }),
    )
  }, [client, runId])

  useEffect(() => {
    // Closing drops any reply still on its way; opening fetches a fresh preview.
    if (!open) {
      seq.current++
      return
    }
    load()
  }, [open, load])

  const submit = () => {
    if (phase.kind !== 'ready' && phase.kind !== 'conflicts') return
    // "Undo anyway" (force) exists only while there are conflicts.
    const force = phase.kind === 'conflicts'
    const mine = ++seq.current
    dispatch({ type: 'submit' })
    client.undoRun(runId, force).then(
      (result) => {
        if (mine !== seq.current) return
        dispatch({ type: 'undone' })
        onUndone?.(result)
        onClose()
      },
      (err: unknown) => mine === seq.current && dispatch({ type: 'undo_failed', error: errorOf(err) }),
    )
  }

  const footer = undoFooter(phase)
  // The pressed button can vanish or go disabled (submitting, 410, 409): hand focus to the
  // dismiss button so it isn't left on <body> under the open dialog.
  const dismissRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const dismiss = dismissRef.current
    if (!open || footer.busy || !dismiss) return
    const active = document.activeElement
    if (!active || active === document.body) dismiss.focus()
  }, [open, phase.kind, footer.busy])

  const close = footer.busy ? () => {} : onClose

  return (
    <Dialog
      open={open}
      title="Undo this run?"
      subtitle={undoSubtitle(run, botName)}
      onClose={close}
      returnFocus={returnFocus}
      footer={
        <>
          <button ref={dismissRef} type="button" className="btn" data-autofocus onClick={onClose} disabled={footer.busy}>
            {footer.dismiss}
          </button>
          {footer.primary && (
            <button
              type="button"
              className={`btn${footer.primary.danger ? ' btn--danger' : ' btn--primary'}`}
              disabled={footer.primary.disabled}
              onClick={footer.primary.action === 'retry' ? load : submit}
            >
              {footer.primary.label}
            </button>
          )}
        </>
      }
    >
      {renderUndoBody(phase, { run, botName, groupNames, budgetBytes })}
    </Dialog>
  )
}
