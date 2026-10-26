export type Theme = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

export const THEME_KEY = 'agentcontrol.theme'
export const DARK_QUERY = '(prefers-color-scheme: dark)'

export function parseTheme(raw: string | null | undefined): Theme {
  return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'system'
}

export function resolveTheme(theme: Theme, systemDark: boolean): ResolvedTheme {
  return theme === 'system' ? (systemDark ? 'dark' : 'light') : theme
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>
type MediaLike = {
  matches: boolean
  addEventListener: (type: 'change', fn: (e: { matches: boolean }) => void) => void
  removeEventListener: (type: 'change', fn: (e: { matches: boolean }) => void) => void
}

export interface ThemeEnv {
  storage: StorageLike
  media: MediaLike
  /** Element that carries data-theme (document.documentElement in the app). */
  root: { dataset: Record<string, string | undefined> }
}

export interface ThemeController {
  get: () => Theme
  set: (theme: Theme) => void
  subscribe: (fn: () => void) => () => void
  dispose: () => void
}

/**
 * B9: one app-level owner for the theme. It reads the saved preference, paints
 * <html data-theme> immediately, and keeps it in sync with the OS setting —
 * independent of which route or dialog is mounted.
 */
export function createThemeController(env: ThemeEnv): ThemeController {
  let theme: Theme
  try {
    theme = parseTheme(env.storage.getItem(THEME_KEY))
  } catch {
    theme = 'system'
  }
  let systemDark = env.media.matches
  const listeners = new Set<() => void>()

  const paint = () => {
    env.root.dataset.theme = resolveTheme(theme, systemDark)
  }
  const onMedia = (e: { matches: boolean }) => {
    systemDark = e.matches
    paint()
  }
  env.media.addEventListener('change', onMedia)
  paint()

  return {
    get: () => theme,
    set(next) {
      if (next === theme) return
      theme = next
      try {
        env.storage.setItem(THEME_KEY, next)
      } catch {
        /* storage unavailable: keep the in-memory choice */
      }
      paint()
      listeners.forEach((fn) => fn())
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    dispose() {
      env.media.removeEventListener('change', onMedia)
      listeners.clear()
    },
  }
}
