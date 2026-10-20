import type { CommandName } from '../lib/commands'
import { createContext, useContext } from 'react'

export type ShellState = {
  /** The chat list panel is showing (fully hidden otherwise). */
  listOpen: boolean
  toggleList: () => void
  closeListIfOverlay: () => void
  /** Below 760 px the list is an overlay drawer and its state isn't persisted (FE-8 owns mobile). */
  narrow: boolean
  /** Bot/group switcher popover (02a), from the header title. */
  switcherOpen: boolean
  openSwitcher: () => void
  closeSwitcher: () => void
  /** ⌘K command palette (02b), from ⌘K / the header search. */
  paletteOpen: boolean
  openPalette: () => void
  closePalette: () => void
  /**
   * Run a slash command (composer or palette). Returns why it can't run, or null
   * once it has run (dialog opened / navigated).
   */
  runCommand: (name: CommandName, args?: string) => string | null
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
