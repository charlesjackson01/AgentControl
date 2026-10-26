import { useEffect, useRef, useState, type RefObject } from 'react'
import { dialogStack } from '../lib/dialog-stack'
import { FOCUSABLE_SELECTOR, initialFocus, restoreTarget, shouldRestore, tabTarget } from '../lib/dialog-focus'

/** What each dialog puts on the stack, so a closing nested dialog can find the panel below it. */
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

/**
 * Shared by <Dialog> and <ConfirmDialog>: registers the dialog on the dialog stack
 * while open; only the topmost dialog handles Esc and the Tab trap. Focus moves
 * into the panel on open ([data-autofocus], first focusable, the panel itself) and
 * goes back to the opener on close, or to the dialog underneath if the opener is
 * gone. Pure rules: lib/dialog-focus.ts; tests/dialog-focus.test.mjs.
 */
export function useDialogFocus(
  open: boolean,
  panelRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  /** Where focus goes on close when the opener is gone (e.g. a menu item); looked up at close time. */
  returnFocus?: () => HTMLElement | null,
): void {
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
  const returnFocusRef = useRef(returnFocus)
  useEffect(() => {
    onCloseRef.current = onClose
    returnFocusRef.current = returnFocus
  })

  useEffect(() => {
    if (!open) return
    dialogStack.open(token)

    const onKey = (e: KeyboardEvent) => {
      // A dialog opened on top of this one owns the keyboard.
      if (!dialogStack.isTop(token)) return
      if (e.key === 'Escape') {
        // Stop here so a bot settings slide-over (window listener) stays open.
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
        const openerLive = !!opener?.isConnected
        restoreTarget(opener, openerLive, below?.panel(), openerLive ? null : (returnFocusRef.current?.() ?? null))?.focus()
      }
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previousOverflow
    }
  }, [open, token, opener, panelRef])
}
