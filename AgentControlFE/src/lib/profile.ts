/* Pure profile helpers (tests/profile.test.mjs). */
import type { UserProfile } from './types.ts'

export const MAX_PROFILE_NAME_CHARS = 80

/** Error for the name field, or null when it can be saved. */
export function profileNameError(name: string): string | null {
  const v = name.trim()
  if (!v) return 'Tell us what to call you.'
  if (v.length > MAX_PROFILE_NAME_CHARS) return `Keep it under ${MAX_PROFILE_NAME_CHARS} characters.`
  return null
}

/** First-run setup shows when the BE has a profile and it was never saved. No route -> never block. */
export function needsOnboarding(profile: UserProfile | null | undefined): boolean {
  return profile != null && profile.onboardedAt == null
}

/** Name for the sidebar footer and chat. */
export function displayName(profile: UserProfile | null | undefined): string {
  return profile?.name?.trim() || 'You'
}
