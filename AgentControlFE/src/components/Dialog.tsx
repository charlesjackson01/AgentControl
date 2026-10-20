import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { dialogStack } from '../lib/dialog-stack'

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
  // Identity for the dialog stack; onClose via a ref so a new callback each render
  // doesn't re-register this dialog (which would move it back to the top).
  const [token] = useState(() => ({}))
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  })

  useEffect(() => {
    if (!open) return
    dialogStack.open(token)

    const onKey = (e: KeyboardEvent) => {
      // A dialog opened on top of this one owns the keyboard.
      if (!dialogStack.isTop(token)) return
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCloseRef.current()
        return
      }
      // Keep Tab inside the dialog.
      if (e.key !== 'Tab' || !panelRef.current) return
      const focusable = panelRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKey)
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const target = panelRef.current?.querySelector<HTMLElement>('[data-autofocus]')
    target?.focus()

    return () => {
      dialogStack.close(token)
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previousOverflow
    }
  }, [open, token])

  if (!open) return null

  return createPortal(
    <div
      className="dialog-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className={`dialog${size === 'sm' ? ' dialog--sm' : size === 'lg' ? ' dialog--lg' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={panelRef}>
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