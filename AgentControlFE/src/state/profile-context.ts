import { createContext, useContext } from 'react'
import type { UserProfile } from '../lib/types'

export type ProfileState = {
  /** undefined while loading; null when the BE has no profile route. */
  profile: UserProfile | null | undefined
  error: Error | undefined
  setProfile: (p: UserProfile) => void
  reload: () => void
}

export const ProfileContext = createContext<ProfileState | null>(null)

export function useProfile(): ProfileState {
  const ctx = useContext(ProfileContext)
  if (!ctx) throw new Error('useProfile must be used inside <ProfileProvider>')
  return ctx
}
