import { useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useDialogFocus } from '../hooks/useDialogFocus'

type DialogProps = {
  open: boolean
  title: string
  subtitle?: string
  size?: 'sm' | 'md' | 'lg'
  onClose: () => void
  footer?: ReactNode
  children: ReactNode
}

export default function Dialog({ open, title, subtitle, size = 'md', onClose, footer, children }: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  useDialogFocus(open, panelRef, onClose)

  if (!open) return null

  return createPortal(
    <div
      className="dialog-backdrop"
      onMouseDown={(e) => {
        if (e.target !== e.currentTarget) return
        // Don't let the press blur to <body> after close restored focus to the opener.
        e.preventDefault()
        onClose()
      }}
    >
      <div className={`dialog${size === 'sm' ? ' dialog--sm' : size === 'lg' ? ' dialog--lg' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={panelRef} tabIndex={-1}>
        <div className="dialog__head">
          <div>
            <p className="dialog__title">{title}</p>
            {subtitle && <p className="dialog__sub">{subtitle}</p>}
          </div>
          <button type="button" className="btn btn--ghost btn--icon dialog__close" onClick={onClose} aria-label="Close dialog">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>

        <div className="dialog__body">{children}</div>

        {footer && <div className="dialog__foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}