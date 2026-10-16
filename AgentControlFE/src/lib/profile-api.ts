/* --------------------------------------------------------------------------
   Chat-first: the workspace owner's profile. Isolated here so the contract is
   easy to adjust once the BE lands it. Spec (Team lead):
     GET    /api/profile          -> UserProfile { name, avatar?, onboardedAt }
     PUT    /api/profile          -> UserProfile  body: UserProfileInput
     GET    /api/profile/avatar   -> image bytes (404 when none); ?v=<updatedAt>
     PUT    /api/profile/avatar   -> UserProfile  raw image body
     DELETE /api/profile/avatar   -> UserProfile
   -------------------------------------------------------------------------- */
import { ApiError, apiUrl, putAvatarImage, request } from './api'
import type { UserProfile, UserProfileInput } from './types'

export function profileAvatarUrl(version?: string): string {
  const base = apiUrl('/api/profile/avatar')
  return version ? `${base}?v=${encodeURIComponent(version)}` : base
}

/** The profile, or null when this BE has no profile route yet (404 from the router). */
export async function getProfile(): Promise<UserProfile | null> {
  try {
    return await request<UserProfile>('/api/profile')
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null
    throw err
  }
}

export function updateProfile(input: UserProfileInput): Promise<UserProfile> {
  return request<UserProfile>('/api/profile', { method: 'PUT', body: JSON.stringify(input) })
}

export function uploadProfileAvatar(file: Blob): Promise<UserProfile> {
  return putAvatarImage<UserProfile>('/api/profile/avatar', file)
}

export function deleteProfileAvatar(): Promise<UserProfile> {
  return request<UserProfile>('/api/profile/avatar', { method: 'DELETE' })
}
