import { useState, type FormEvent } from 'react'
import AvatarPicker from './AvatarPicker'
import { avatarBaseline, avatarDirty, avatarSavePlan, type AvatarDraft } from '../lib/avatar-draft'
import { friendlyError } from '../lib/chat-format'
import { MAX_PROFILE_NAME_CHARS, profileNameError } from '../lib/profile'
import { deleteProfileAvatar, profileAvatarUrl, updateProfile, uploadProfileAvatar } from '../lib/profile-api'
import type { UserProfile } from '../lib/types'

type Props = {
  profile: UserProfile
  /** First-run mode (the BE stamps onboardedAt on the first save with a name). */
  onboarding?: boolean
  submitLabel?: string
  onSaved: (p: UserProfile) => void
}

/** Name + avatar for the workspace owner; used by first-run setup and Settings. */
export default function UserProfileForm({ profile, onboarding = false, submitLabel, onSaved }: Props) {
  const [name, setName] = useState(profile.name ?? '')
  const [nameError, setNameError] = useState<string | null>(null)
  const [avatarDraft, setAvatarDraft] = useState<AvatarDraft>(() => avatarBaseline(profile.avatar))
  const [avatarError, setAvatarError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [savedNote, setSavedNote] = useState(false)

  const dirty = onboarding || name.trim() !== (profile.name ?? '').trim() || avatarDirty(avatarDraft, avatarBaseline(profile.avatar))

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const err = profileNameError(name)
    setNameError(err)
    if (err) {
      document.getElementById('up-name')?.focus()
      return
    }
    setSaving(true)
    setSubmitError(null)
    setSavedNote(false)
    try {
      const plan = avatarSavePlan(avatarDraft, profile.avatar)
      if (plan.deleteImage) await deleteProfileAvatar()
      let saved = await updateProfile({
        name: name.trim(),
        ...(plan.avatar !== undefined ? { avatar: plan.avatar } : {}),
      })
      if (plan.upload && avatarDraft.file) saved = await uploadProfileAvatar(avatarDraft.file)
      setAvatarDraft(avatarBaseline(saved.avatar))
      setSavedNote(!onboarding)
      onSaved(saved)
    } catch (error) {
      setSubmitError(friendlyError(error, 'Could not save your profile.'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="form" onSubmit={submit} noValidate>
      <div className="field">
        <label className="field__label" htmlFor="up-name">
          Your name <span className="field__req" aria-hidden="true">*</span>
        </label>
        <input
          id="up-name"
          className={`input${nameError ? ' input--invalid' : ''}`}
          value={name}
          maxLength={MAX_PROFILE_NAME_CHARS}
          onChange={(e) => {
            setName(e.target.value)
            setNameError(null)
          }}
          placeholder="e.g. Charles"
          autoComplete="name"
          autoFocus={onboarding}
          aria-invalid={Boolean(nameError)}
        />
        {nameError ? <p className="field__err">{nameError}</p> : <p className="field__hint">How your agents address you, and what shows in the sidebar.</p>}
      </div>

      <AvatarPicker
        id="up-avatar"
        name={name || 'You'}
        current={profile.avatar}
        storedImageUrl={profile.avatar?.kind === 'image' ? profileAvatarUrl(profile.avatar.updatedAt) : null}
        value={avatarDraft}
        onChange={setAvatarDraft}
        error={avatarError}
        onError={setAvatarError}
        label="Your avatar"
      />

      {submitError && (
        <p className="field__err" role="alert">
          {submitError}
        </p>
      )}
      <div className="formactions">
        {savedNote && !dirty && <span className="field__hint" role="status">Saved.</span>}
        <button type="submit" className="btn btn--primary" disabled={saving || !dirty}>
          {saving && <span className="spinner" aria-hidden="true" />}
          {saving ? 'Saving…' : (submitLabel ?? 'Save profile')}
        </button>
      </div>
    </form>
  )
}
