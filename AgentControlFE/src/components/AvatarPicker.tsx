import { useEffect, useMemo, type ReactNode } from 'react'
import Avatar from './Avatar'
import { AVATAR_EMOJI } from '../lib/agent-profile'
import {
  AVATAR_MIME_TYPES,
  avatarFileError,
  cleared,
  shownAvatar,
  withEmoji,
  withFile,
  type AvatarDraft,
} from '../lib/avatar-draft'
import type { AgentAvatar } from '../lib/types'

type AvatarPickerProps = {
  id: string
  name: string
  current: AgentAvatar | null | undefined
  /** URL of the stored uploaded image, if any (agent or user avatar route). */
  storedImageUrl?: string | null
  /** Seed for the fallback colour (agent id). */
  agentId?: string
  color?: string | null
  value: AvatarDraft
  onChange: (next: AvatarDraft) => void
  error: string | null
  onError: (message: string | null) => void
  /** Extra controls next to Upload/Use initials (e.g. the colour palette). */
  extra?: ReactNode
  label?: string
}

/** Emoji grid + image upload + "Use initials", with a live preview. */
export default function AvatarPicker({
  id,
  name,
  current,
  storedImageUrl,
  agentId,
  color,
  value,
  onChange,
  error,
  onError,
  extra,
  label = 'Avatar',
}: AvatarPickerProps) {
  // Object URL for a picked-but-unsaved image; revoked when replaced or on unmount.
  const fileUrl = useMemo(() => (value.file ? URL.createObjectURL(value.file) : null), [value.file])
  useEffect(() => () => {
    if (fileUrl) URL.revokeObjectURL(fileUrl)
  }, [fileUrl])
  const shown = shownAvatar(value, current)
  const previewUrl = fileUrl ?? (shown?.kind === 'image' && storedImageUrl ? storedImageUrl : null)

  return (
    <div className="field">
      <span className="field__label" id={`${id}-label`}>{label}</span>
      <div className="avatarpick" role="group" aria-labelledby={`${id}-label`}>
        <Avatar name={name || '?'} agentId={agentId} avatar={shown} previewUrl={previewUrl} color={color} size="xl" decorative />
        <div className="avatarpick__body">
          <div className="avatarpick__emoji" role="group" aria-label="Emoji avatar">
            {AVATAR_EMOJI.map((e) => (
              <button
                type="button"
                key={e}
                aria-pressed={value.emoji === e}
                aria-label={`Use ${e} as avatar`}
                onClick={() => {
                  onError(null)
                  onChange(withEmoji(value, e, current))
                }}
              >
                {e}
              </button>
            ))}
          </div>
          <div className="avatarpick__actions">
            <label className="btn btn--sm">
              Upload image…
              <input
                type="file"
                accept={AVATAR_MIME_TYPES.join(',')}
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  e.target.value = ''
                  if (!file) return
                  const err = avatarFileError(file)
                  onError(err)
                  if (!err) onChange(withFile(value, file))
                }}
              />
            </label>
            {(shown || value.file) && (
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => {
                  onError(null)
                  onChange(cleared(current))
                }}
              >
                Use initials
              </button>
            )}
            {extra}
          </div>
          {error ? (
            <p className="field__err" role="alert">{error}</p>
          ) : (
            <p className="field__hint">
              Pick an emoji or upload an image (PNG, JPEG, WebP or GIF, up to 1 MB). Without one, initials are shown.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
