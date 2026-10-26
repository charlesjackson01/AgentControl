import { useSyncExternalStore } from 'react'
import { DARK_QUERY, createThemeController, type Theme, type ThemeController } from '../lib/theme'

export type { Theme }

let controller: ThemeController | null = null

/** Called once from main.tsx, before the first render, so every route gets the saved theme. */
export function startTheme(): ThemeController {
  controller ??= createThemeController({
    storage: window.localStorage,
    media: window.matchMedia(DARK_QUERY),
    root: document.documentElement,
  })
  return controller
}

/** Read/change the theme. Painting <html data-theme> is owned by the app-level controller. */
export function useTheme() {
  const c = startTheme()
  const theme = useSyncExternalStore(c.subscribe, c.get)
  return { theme, setTheme: c.set }
}
