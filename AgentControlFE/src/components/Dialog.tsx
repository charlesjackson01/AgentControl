import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { dialogStack } from '../lib/dialog-stack'
import { FOCUSABLE_SELECTOR, initialFocus, restoreTarget, shouldRestore, tabTarget } from '../lib/dialog-focus'

type DialogProps = {
  open: boolean
  title: string
  subtitle?: string
  size?: 'sm' | 'md' | 'lg'
  onClose: () => void
  footer?: ReactNode
  children: ReactNode
}

/** What each <Dialog> puts on the stack, so a closing nested dialog can find the panel below it. */
type DialogToken = { panel: () => HTMLElement | null }

/** Tab-able elements in the panel, in DOM order, skipping hidden and tabindex=-1 ones. */
function focusableIn(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.tabIndex >= 0 && el.getClientRects().length > 0,
  )
}

function activeElement(): HTMLElement | null {
  const a = document.activeElement
  return a instanceof HTMLElement ? a : null
}

export default function Dialog({ open, title, subtitle, size = 'md', onClose, footer, children }: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  // Identity for the dialog stack; onClose via a ref so a new callback each render
  // doesn't re-register this dialog (which would move it back to the top).
  const [token] = useState<DialogToken>(() => ({ panel: () => panelRef.current }))
  // The element focused before this dialog opened, captured during the render that
  // opens it: before React's autoFocus or our effect moves focus into the panel.
  const [opener, setOpener] = useState<HTMLElement | null>(() => (open ? activeElement() : null))
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setOpener(activeElement())
  }
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
      // Keep Tab inside the dialog, and pull it back in if focus got out.
      const panel = panelRef.current
      if (e.key !== 'Tab' || !panel) return
      const active = activeElement()
      const target = tabTarget(focusableIn(panel), active, active !== null && panel.contains(active), e.shiftKey, panel)
      if (target) {
        e.preventDefault()
        target.focus()
      }
    }

    document.addEventListener('keydown', onKey)
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    // Move focus into the panel, unless an autoFocus child already put it there.
    const panel = panelRef.current
    if (panel) {
      const active = activeElement()
      if (!active || !panel.contains(active)) {
        initialFocus(panel.querySelector<HTMLElement>('[data-autofocus]'), focusableIn(panel), panel).focus()
      }
    }

    return () => {
      const wasTop = dialogStack.isTop(token)
      dialogStack.close(token)
      // By now React has removed the panel, so focus is usually on <body>.
      const active = document.activeElement
      const activeIsBody = !active || active === document.body
      const activeInside = !!panel && !!active && panel.contains(active)
      if (shouldRestore(activeIsBody, activeInside, wasTop)) {
        const below = dialogStack.top() as DialogToken | undefined
        restoreTarget(opener, !!opener?.isConnected, below?.panel())?.focus()
      }
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previousOverflow
    }
  }, [open, token, opener])

  if (!open) return null

  return createPortal(
    <div
      className="dialog-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
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