import { createContext, useContext } from 'react'

export type ShellState = {
  /** The chat list panel is showing (fully hidden otherwise). */
  listOpen: boolean
  toggleList: () => void
  closeListIfOverlay: () => void
  /** Below 760 px the list is an overlay drawer and its state isn't persisted (FE-8 owns mobile). */
  narrow: boolean
  /** Bot/group switcher popover (02a); `search` focuses it from ⌘K / the header search. */
  switcherOpen: boolean
  openSwitcher: () => void
  closeSwitcher: () => void
  openSettings: () => void
  openNewBot: () => void
  /** Sum for the ☰ badge. */
  unread: number
}

export const ShellContext = createContext<ShellState | null>(null)

export function useShell(): ShellState {
  const ctx = useContext(ShellContext)
  if (!ctx) throw new Error('useShell must be used inside the app shell')
  return ctx
}
