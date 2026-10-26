/* Bot settings panel (FE-3): tabs and URL state. Pure; tests/bot-settings.test.mjs. */
import type { SettingsTab } from './commands.ts'

/** `comingSoon`: shown but disabled (Sandbox needs BE-8). */
export const SETTINGS_TABS: readonly { id: SettingsTab; label: string; owner: 'FE-3' | 'FE-4'; comingSoon?: boolean }[] = [
  { id: 'profile', label: 'Profile', owner: 'FE-3' },
  { id: 'memory', label: 'Memory', owner: 'FE-3' },
  { id: 'skills', label: 'Skills', owner: 'FE-3' },
  { id: 'files', label: 'Files', owner: 'FE-4' },
  { id: 'sandbox', label: 'Sandbox', owner: 'FE-4', comingSoon: true },
]

type ParamsLike = { get(name: string): string | null }

/** The panel is open when `?panel=settings`. */
export function settingsOpen(params: ParamsLike): boolean {
  return params.get('panel') === 'settings'
}

/** `?tab=` when it names a tab, else Profile. */
export function settingsTab(params: ParamsLike): SettingsTab {
  const t = params.get('tab')
  return SETTINGS_TABS.some((x) => x.id === t) ? (t as SettingsTab) : 'profile'
}

/** Params with the panel open on `tab` (Profile drops `tab`, the default). Other params are kept. */
export function withSettingsTab(params: URLSearchParams, tab: SettingsTab): URLSearchParams {
  const next = new URLSearchParams(params)
  next.set('panel', 'settings')
  next.delete('path')
  if (tab === 'profile') next.delete('tab')
  else next.set('tab', tab)
  return next
}

/** Params with every panel key removed (close). */
export function withoutPanel(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params)
  for (const k of ['panel', 'tab', 'path']) next.delete(k)
  return next
}
