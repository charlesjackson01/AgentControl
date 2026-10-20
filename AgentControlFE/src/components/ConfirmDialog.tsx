import { useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useDialogFocus } from '../hooks/useDialogFocus'

type ConfirmDialogProps = {
  open: boolean
  title: string
  subtitle?: string
  /** Label for the confirm button, e.g. "Delete agent". */
  confirmLabel?: string
  onCancel: () => void
  onConfirm: () => void
  loading?: boolean
  children?: ReactNode
  /** Focus target on close when the opener is gone (see useDialogFocus). */
  returnFocus?: () => HTMLElement | null
}

export default function ConfirmDialog({
  open,
  title,
  subtitle,
  confirmLabel = 'Confirm',
  onCancel,
  onConfirm,
  loading = false,
  children,
  returnFocus,
}: ConfirmDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  // Same stack, focus and Esc rules as <Dialog>: nested in Settings, Esc closes only this.
  useDialogFocus(open, panelRef, onCancel, returnFocus)

  if (!open) return null

  return createPortal(
    <div
      className="dialog-backdrop"
      onMouseDown={(e) => {
        if (e.target !== e.currentTarget) return
        // Don't let the press blur to <body> after close restored focus to the opener.
        e.preventDefault()
        onCancel()
      }}
    >
      <div
        ref={panelRef}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <div className="dialog__head">
          <div>
            <p className="dialog__title">{title}</p>
            {subtitle && <p className="dialog__sub">{subtitle}</p>}
          </div>
          <button
            type="button"
            className="btn btn--ghost btn--icon dialog__close"
            onClick={onCancel}
            aria-label="Close dialog"
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>

        <div className="dialog__body">{children}</div>

        <div className="dialog__foot">
          <button
            type="button"
            className="btn"
            data-autofocus
            onClick={onCancel}
            disabled={loading}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--danger"
            onClick={onConfirm}
            disabled={loading}
          >
            {loading ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
