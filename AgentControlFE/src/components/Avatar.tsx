import { useState } from 'react'
import { agentAvatarUrl } from '../lib/api'
import { initialsOf, paletteColor } from '../lib/agent-profile'
import type { AgentAvatar } from '../lib/types'

export type AvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl'

type AvatarProps = {
  /** Display name: drives initials and the accessible label. */
  name: string
  /** Agent id: needed for image avatars and seeds the fallback colour. */
  agentId?: string
  avatar?: AgentAvatar | null
  /** Accent colour; defaults to a stable palette colour from the id/name. */
  color?: string | null
  size?: AvatarSize
  /** Local preview URL (e.g. an object URL of a file about to be uploaded). Wins over `avatar`. */
  previewUrl?: string | null
  className?: string
  /** Decorative when a visible name sits next to it. */
  decorative?: boolean
}

/** Agent avatar: uploaded image, emoji, or initials on a colour fallback. */
export default function Avatar({
  name,
  agentId,
  avatar,
  color,
  size = 'md',
  previewUrl,
  className,
  decorative = false,
}: AvatarProps) {
  const imageSrc = previewUrl ?? (avatar?.kind === 'image' && agentId ? agentAvatarUrl(agentId, avatar.value) : null)
  // Remember which src failed so a new src gets a fresh try without an effect.
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const showImage = imageSrc !== null && failedSrc !== imageSrc
  const showEmoji = !showImage && avatar?.kind === 'emoji' && avatar.value.trim() !== ''
  const bg = color || paletteColor(agentId ?? name)

  const a11y = decorative ? { 'aria-hidden': true as const } : { role: 'img', 'aria-label': `${name || 'Agent'} avatar` }

  return (
    <span
      className={`avatar avatar--${size}${showImage ? ' avatar--image' : showEmoji ? ' avatar--emoji' : ''}${className ? ` ${className}` : ''}`}
      style={showImage ? undefined : { ['--avatar-bg' as string]: bg }}
      title={decorative ? undefined : name}
      {...a11y}
    >
      {showImage ? (
        <img src={imageSrc} alt="" onError={() => setFailedSrc(imageSrc)} draggable={false} />
      ) : showEmoji ? (
        avatar.value
      ) : (
        initialsOf(name)
      )}
    </span>
  )
}
