/*
 * Focus rules for <Dialog> (Team lead, after eb62d71): focus moves into a dialog
 * when it opens, Tab and Shift+Tab stay inside the topmost dialog, and closing
 * puts focus back where it was. Pure and DOM-free so it runs under node:test;
 * Dialog.tsx supplies the elements. tests/dialog-focus.test.mjs.
 */

/** Candidates for the Tab cycle. Dialog.tsx also drops hidden ones and tabIndex < 0. */
export const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  '[contenteditable="true"]',
  '[tabindex]',
].join(', ')

/** On open: `[data-autofocus]`, else the first focusable element, else the panel itself (tabindex=-1). */
export function initialFocus<T>(autofocus: T | null | undefined, focusable: readonly T[], panel: T): T {
  return autofocus ?? focusable[0] ?? panel
}

/**
 * Where Tab should go, or null to let the browser move focus normally.
 * `inside` is whether `active` is within the panel; focus that has escaped the
 * panel (the trigger behind it, <body>) is pulled back to the first element
 * (last for Shift+Tab). At either end of the cycle it wraps.
 */
export function tabTarget<T>(focusable: readonly T[], active: T | null | undefined, inside: boolean, shift: boolean, panel: T): T | null {
  if (focusable.length === 0) return panel
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (!inside || active == null) return shift ? last : first
  if (active === panel) return shift ? last : first
  const i = focusable.indexOf(active)
  // Focus on something inside the panel that isn't in the cycle (a tabindex=-1 node).
  if (i === -1) return null
  if (shift && i === 0) return last
  if (!shift && i === focusable.length - 1) return first
  return null
}

/**
 * On close: the element focused before the dialog opened if it is still in the
 * document, else the caller's fallback (a dialog opened from a menu item that is
 * gone by now: FilesTab's row ⋯ button, see rowFocusTarget), else the panel of the
 * dialog now on top (nested Edit inside Settings), else nothing.
 */
export function restoreTarget<T>(opener: T | null | undefined, openerConnected: boolean, panelBelow: T | null | undefined, fallback?: T | null): T | null {
  if (opener != null && openerConnected) return opener
  return fallback ?? panelBelow ?? null
}

/**
 * Fallback for a dialog opened from a row's menu (FilesTab Rename/Delete): the row's
 * own ⋯ button, found by its (new) key; if the row is gone, the next row's button
 * (the one that moved into its place), then the previous row's, then the list itself.
 * `rows` are the rows now in the list, in order; `index` is where the row was.
 */
export function rowFocusTarget<T>(rows: readonly { key: string; el: T | null }[], key: string, index: number, list: T | null): T | null {
  const same = rows.find((r) => r.key === key)?.el
  if (same) return same
  const at = (i: number) => (i >= 0 && i < rows.length ? rows[i].el : null)
  return at(index) ?? at(index - 1) ?? list
}

/**
 * Only move focus on close when it would otherwise be lost: it sits on <body>
 * (the panel was just removed) or still inside the closing panel. If the user
 * already focused something else, leave it there.
 */
export function shouldRestore(activeIsBody: boolean, activeInsidePanel: boolean, wasTop: boolean): boolean {
  return wasTop && (activeIsBody || activeInsidePanel)
}
