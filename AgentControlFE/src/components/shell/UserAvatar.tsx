import Avatar from '../Avatar'
import { profileAvatarUrl } from '../../lib/profile-api'
import type { UserProfile } from '../../lib/types'

export default function UserAvatar({ profile, name, size = 'sm' }: { profile: UserProfile | null | undefined; name: string; size?: 'sm' | 'md' }) {
  const avatar = profile?.avatar
  return (
    <Avatar
      name={name}
      avatar={avatar}
      previewUrl={avatar?.kind === 'image' ? profileAvatarUrl(avatar.updatedAt) : null}
      color="#55677d"
      size={size}
      decorative
    />
  )
}
