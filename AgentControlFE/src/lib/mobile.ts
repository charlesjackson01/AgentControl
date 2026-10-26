/* FE-8 mobile (v3 mockups 05a / 05b). Pure helpers, tested in tests/mobile.test.mjs. */
import { unreadLabel } from './conversations.ts'

/** Below 760 px the app switches to the phone layouts. Same breakpoint as the CSS `@media (max-width: 759px)` blocks. */
export const MOBILE_MAX_WIDTH = 759
export const MOBILE_QUERY = `(max-width: ${MOBILE_MAX_WIDTH}px)`

export function isMobileWidth(width: number): boolean {
  return Number.isFinite(width) && width <= MOBILE_MAX_WIDTH
}

export type HomeTargetKind = 'chat' | 'setup' | 'empty'
export type HomeView = 'list' | 'redirect' | 'setup' | 'empty' | 'waiting'

/**
 * What `/` shows. Desktop: the newest chat (FE-1). Phone (05a): the chat list
 * screen, except first-run setup (no bots) still wins once loaded.
 */
export function homeView(opts: { narrow: boolean; loaded: boolean; target?: HomeTargetKind; error?: boolean }): HomeView {
  if (opts.narrow) return opts.loaded && opts.target === 'setup' && !opts.error ? 'setup' : 'list'
  if (!opts.loaded) return 'waiting'
  if (opts.target === 'chat') return 'redirect'
  if (opts.target === 'setup' && !opts.error) return 'setup'
  return 'empty'
}

/** 05b: "‹ 5" goes back to the chat list screen (`/`), not browser history, so deep links work. */
export const MOBILE_BACK_PATH = '/'

export function mobileBack(unread: number): { to: string; badge: string; label: string } {
  const badge = unreadLabel(unread)
  return { to: MOBILE_BACK_PATH, badge, label: badge ? `Back to chats, ${unread} unread` : 'Back to chats' }
}
