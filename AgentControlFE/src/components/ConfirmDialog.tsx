import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

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
}: ConfirmDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }

    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'

    const target = panelRef.current?.querySelector<HTMLElement>('[data-autofocus]')
    target?.focus()

    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = 'auto'
    }
  }, [open, onCancel])

  if (!open) return null

  return createPortal(
    <div
      className="dialog-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div
        ref={panelRef}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-autofocus
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
