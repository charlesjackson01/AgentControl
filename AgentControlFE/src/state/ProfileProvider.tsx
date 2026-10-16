import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { getProfile } from '../lib/profile-api'
import type { UserProfile } from '../lib/types'
import { ProfileContext, type ProfileState } from './profile-context'

export default function ProfileProvider({ children }: { children: ReactNode }) {
  const [profile, setProfileState] = useState<UserProfile | null | undefined>(undefined)
  const [error, setError] = useState<Error | undefined>(undefined)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let active = true
    getProfile().then(
      (p) => {
        if (!active) return
        setProfileState(p)
        setError(undefined)
      },
      (err: unknown) => {
        if (!active) return
        // Never block the app on a profile error: behave as "no profile".
        setError(err instanceof Error ? err : new Error(String(err)))
        setProfileState(null)
      },
    )
    return () => {
      active = false
    }
  }, [tick])

  const setProfile = useCallback((p: UserProfile) => setProfileState(p), [])
  const reload = useCallback(() => setTick((n) => n + 1), [])
  const value = useMemo<ProfileState>(() => ({ profile, error, setProfile, reload }), [profile, error, setProfile, reload])
  return <ProfileContext.Provider value={value}>{children}</ProfileContext.Provider>
}
