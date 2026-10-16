/* Shared avatar editing state for the agent profile and the user profile (pure; tested). */
import { MAX_AVATAR_BYTES, type AgentAvatar } from './types.ts'

export const AVATAR_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/** Avatar edits, applied on save: emoji rides in the PUT body, images via the avatar routes. */
export type AvatarDraft = {
  emoji: string | null
  /** New image picked but not uploaded yet. */
  file: File | null
  /** Drop the currently stored uploaded image. */
  removeImage: boolean
}

export function avatarBaseline(current: AgentAvatar | null | undefined): AvatarDraft {
  return { emoji: current?.kind === 'emoji' ? current.value : null, file: null, removeImage: false }
}

export function avatarDirty(a: AvatarDraft, b: AvatarDraft): boolean {
  return a.emoji !== b.emoji || a.file !== null || a.removeImage !== b.removeImage
}

/** Toggle an emoji; picking one replaces (and schedules removal of) a stored image. */
export function withEmoji(d: AvatarDraft, emoji: string, current: AgentAvatar | null | undefined): AvatarDraft {
  return { emoji: d.emoji === emoji ? null : emoji, file: null, removeImage: d.removeImage || current?.kind === 'image' }
}

export function withFile(d: AvatarDraft, file: File): AvatarDraft {
  return { ...d, emoji: null, file }
}

export function cleared(current: AgentAvatar | null | undefined): AvatarDraft {
  return { emoji: null, file: null, removeImage: current?.kind === 'image' }
}

/** Error text for a picked file, or null when it can be uploaded. */
export function avatarFileError(file: { type: string; size: number }, maxBytes = MAX_AVATAR_BYTES): string | null {
  if (!AVATAR_MIME_TYPES.includes(file.type)) return 'Use a PNG, JPEG, WebP or GIF image.'
  if (file.size > maxBytes) return `Images must be ${Math.round(maxBytes / 1024 / 1024)} MB or smaller.`
  return null
}

/** What the preview should show (before any local file preview). */
export function shownAvatar(d: AvatarDraft, current: AgentAvatar | null | undefined): AgentAvatar | null {
  if (d.emoji) return { kind: 'emoji', value: d.emoji }
  if (current?.kind === 'image' && !d.removeImage) return current
  return null
}

/**
 * Save plan: `avatar` for the PUT body (undefined = leave untouched), whether to
 * DELETE the stored image first, and whether to upload `d.file` afterwards.
 */
export function avatarSavePlan(
  d: AvatarDraft,
  current: AgentAvatar | null | undefined,
): { avatar?: { kind: 'emoji'; value: string } | null; deleteImage: boolean; upload: boolean } {
  const deleteImage = d.removeImage && current?.kind === 'image'
  const upload = d.file !== null
  if (d.emoji) return { avatar: { kind: 'emoji', value: d.emoji }, deleteImage, upload: false }
  const keepsImage = current?.kind === 'image' && !d.removeImage
  if (!keepsImage && !upload && current) return { avatar: null, deleteImage, upload }
  return { deleteImage, upload }
}
