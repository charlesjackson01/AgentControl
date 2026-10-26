import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Avatar from '../Avatar'
import AvatarPicker from '../AvatarPicker'
import { Confirm } from '../Confirm'
import { agentAvatarUrl, api } from '../../lib/api'
import { friendlyError as friendly } from '../../lib/chat-format'
import { INTERNET_POLICY_LABELS, agentChatFirstFields, botFolder } from '../../lib/agent-put'
import { MAX_RULE_LENGTH, MAX_RULES, addRule, moveRule, normalizeRules, removeRule, updateRule } from '../../lib/agent-profile'
import { avatarBaseline, avatarDirty, avatarSavePlan, shownAvatar, type AvatarDraft } from '../../lib/avatar-draft'
import {
  modelOptions, modelValue, parseModelValue, profileDirty, profileSwatches, profileDraftFrom, profilePutBody, validateProfile,
  type ProfileDraft, type ProfileErrors,
} from '../../lib/profile-form'
import type { Agent, Endpoint, EndpointModel } from '../../lib/types'
type Props = {
  agent: Agent
  endpoints: Endpoint[]
  onSaved: (a: Agent) => void
  onClose: () => void
  onCleared?: () => void
  onDeleted?: () => void
}

/** 03a: compact two-column profile (avatar | name, role, description, model, colour), then Rules and Instructions cards. */
export default function ProfileTab({ agent, endpoints, onSaved, onClose, onCleared, onDeleted }: Props) {
  const navigate = useNavigate()
  const [busy, setBusy] = useState<null | 'clear' | 'delete'>(null)
  const [confirm, setConfirm] = useState<null | 'clear' | 'delete'>(null)
  const [error, setError] = useState<string | null>(null)
  const { slug, internetPolicy } = agentChatFirstFields(agent)
  const folder = botFolder(slug)

  const [draft, setDraft] = useState<ProfileDraft>(() => profileDraftFrom(agent))
  const [errors, setErrors] = useState<ProfileErrors>({})
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savedNote, setSavedNote] = useState(false)
  const [avatarDraft, setAvatarDraft] = useState<AvatarDraft>(() => avatarBaseline(agent.avatar))
  const [avatarError, setAvatarError] = useState<string | null>(null)
  const [pickingAvatar, setPickingAvatar] = useState(false)
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [models, setModels] = useState<Record<string, EndpointModel[] | undefined>>({})

  // Served models per endpoint for the one Model select ("Local llama · Qwen 3.8 Flash").
  const endpointKey = endpoints.map((e) => e.id).join(',')
  useEffect(() => {
    let live = true
    for (const ep of endpoints) {
      api.listEndpointModels(ep.id).then(
        (list) => live && setModels((m) => ({ ...m, [ep.id]: list })),
        () => {},
      )
    }
    return () => {
      live = false
    }
  }, [endpointKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const options = useMemo(() => modelOptions(endpoints, models, draft), [endpoints, models, draft])
  const set = <K extends keyof ProfileDraft>(k: K, v: ProfileDraft[K]) => {
    setDraft((d) => ({ ...d, [k]: v }))
    setSavedNote(false)
    if (k === 'name' || k === 'rules') setErrors((e) => ({ ...e, [k]: undefined }))
  }
  const dirty = profileDirty(draft, agent) || avatarDirty(avatarDraft, avatarBaseline(agent.avatar))
  const rules = draft.rules
  const ruleCount = normalizeRules(rules).length
  const fileUrl = useMemo(() => (avatarDraft.file ? URL.createObjectURL(avatarDraft.file) : null), [avatarDraft.file])
  useEffect(() => () => {
    if (fileUrl) URL.revokeObjectURL(fileUrl)
  }, [fileUrl])
  const previewUrl = fileUrl ?? (agent.avatar?.kind === 'image' && !avatarDraft.removeImage ? agentAvatarUrl(agent.id, agent.avatar.updatedAt) : null)

  const save = async () => {
    const next = validateProfile(draft, endpoints)
    setErrors(next)
    if (Object.keys(next).length) return
    setSaving(true)
    setSaveError(null)
    try {
      const body = profilePutBody(agent, draft)
      const plan = avatarSavePlan(avatarDraft, agent.avatar)
      if (plan.avatar !== undefined) body.avatar = plan.avatar
      if (plan.deleteImage) await api.deleteAgentAvatar(agent.id)
      let saved = await api.updateAgent(agent.id, body)
      if (plan.upload && avatarDraft.file) saved = await api.uploadAgentAvatar(saved.id, avatarDraft.file)
      setAvatarDraft(avatarBaseline(saved.avatar))
      setDraft(profileDraftFrom(saved))
      setPickingAvatar(false)
      setSavedNote(true)
      onSaved(saved)
    } catch (err) {
      setSaveError(friendly(err, 'Could not save the profile.'))
    } finally {
      setSaving(false)
    }
  }

  const reset = () => {
    setDraft(profileDraftFrom(agent))
    setAvatarDraft(avatarBaseline(agent.avatar))
    setErrors({})
    setSaveError(null)
    setPickingAvatar(false)
  }

  const clearChat = useCallback(async () => {
    setBusy('clear')
    setError(null)
    try {
      await api.deleteAgentRuns(agent.id)
      onCleared?.()
      setConfirm(null)
      onClose()
    } catch (err) {
      setError(friendly(err, 'Could not clear the chat history.'))
    } finally {
      setBusy(null)
    }
  }, [agent.id, onClose, onCleared])

  const deleteAgent = useCallback(async () => {
    setBusy('delete')
    setError(null)
    try {
      await api.deleteAgent(agent.id)
      onDeleted?.()
      navigate('/', { replace: true })
    } catch (err) {
      setError(friendly(err, 'Could not delete this bot.'))
      setBusy(null)
    }
  }, [agent.id, navigate, onDeleted])

  return (
    <form
      className="cf-set__stack cf-prof"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
      noValidate
    >
      <div className="cf-prof__top">
        <div className="cf-prof__av">
          <Avatar name={draft.name || agent.name} agentId={agent.id} avatar={shownAvatar(avatarDraft, agent.avatar)} previewUrl={previewUrl} color={draft.color} size="xl" decorative />
          <button type="button" className="btn btn--sm" onClick={() => setPickingAvatar((v) => !v)} aria-expanded={pickingAvatar}>
            Change
          </button>
          <p className="cf-prof__hint">Emoji or image, up to 1 MB</p>
        </div>
        <div className="cf-prof__grid">
          <div className="field">
            <label className="field__label" htmlFor="pf-name">Name</label>
            <input id="pf-name" className={`input${errors.name ? ' input--invalid' : ''}`} value={draft.name} onChange={(e) => set('name', e.target.value)} aria-invalid={Boolean(errors.name)} />
            {errors.name && <p className="field__err">{errors.name}</p>}
          </div>
          <div className="field">
            <label className="field__label" htmlFor="pf-role">Role</label>
            <input id="pf-role" className="input" value={draft.role} onChange={(e) => set('role', e.target.value)} placeholder="e.g. Researcher" />
          </div>
          <div className="field cf-prof__wide">
            <label className="field__label" htmlFor="pf-desc">Description</label>
            <input id="pf-desc" className="input" value={draft.description} onChange={(e) => set('description', e.target.value)} placeholder="What this bot is for, in one line" />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="pf-model">Model</label>
            <select
              id="pf-model"
              className={`input${errors.model ? ' input--invalid' : ''}`}
              value={modelValue(draft.endpointId, draft.modelId)}
              onChange={(e) => {
                const v = parseModelValue(e.target.value)
                setDraft((d) => ({ ...d, ...v }))
                setErrors((x) => ({ ...x, model: undefined }))
              }}
            >
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            {errors.model && <p className="field__err">{errors.model}</p>}
          </div>
          <div className="field">
            <span className="field__label" id="pf-colour">Colour</span>
            <div className="cf-prof__swatches" role="group" aria-labelledby="pf-colour">
              {profileSwatches(agent.color).map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`cf-swatch${draft.color === c ? ' cf-swatch--on' : ''}`}
                  style={{ background: c }}
                  aria-label={`Colour ${c}`}
                  aria-pressed={draft.color === c}
                  onClick={() => set('color', draft.color === c ? null : c)}
                />
              ))}
            </div>
          </div>
        </div>
      </div>

      {pickingAvatar && (
        <div className="cf-card cf-prof__picker">
          <AvatarPicker
            id="pf-avatar"
            name={draft.name || agent.name}
            agentId={agent.id}
            current={agent.avatar}
            storedImageUrl={agent.avatar?.kind === 'image' ? agentAvatarUrl(agent.id, agent.avatar.updatedAt) : null}
            color={draft.color}
            value={avatarDraft}
            onChange={setAvatarDraft}
            error={avatarError}
            onError={setAvatarError}
          />
        </div>
      )}

      <section className="cf-card">
        <div className="cf-prof__cardhd">
          <h3 className="cf-card__title">Rules</h3>
          <span className="cf-prof__meta">
            Sent with every message · {ruleCount} of {MAX_RULES}
          </span>
          <span className="cf-grow" />
          <button type="button" className="btn btn--sm" onClick={() => set('rules', addRule(rules))} disabled={rules.length >= MAX_RULES}>
            ＋ Add rule
          </button>
        </div>
        {rules.length === 0 ? (
          <p className="cf-set__muted">No rules yet. Rules are short standing instructions, like &ldquo;Keep answers short.&rdquo;</p>
        ) : (
          <ol className="cf-rules">
            {rules.map((r, i) => (
              <li
                key={i}
                className={`cf-rule${dragFrom === i ? ' cf-rule--drag' : ''}`}
                onDragOver={(e) => dragFrom !== null && e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault()
                  if (dragFrom !== null && dragFrom !== i) set('rules', moveRule(rules, dragFrom, i - dragFrom))
                  setDragFrom(null)
                }}
              >
                <span
                  className="cf-rule__grip"
                  draggable
                  onDragStart={() => setDragFrom(i)}
                  onDragEnd={() => setDragFrom(null)}
                  aria-hidden="true"
                  title="Drag to reorder (or Alt+↑/↓ in the rule)"
                >
                  ⋮⋮
                </span>
                <input
                  className="cf-rule__in"
                  value={r}
                  maxLength={MAX_RULE_LENGTH}
                  onChange={(e) => set('rules', updateRule(rules, i, e.target.value))}
                  onKeyDown={(e) => {
                    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
                      e.preventDefault()
                      set('rules', moveRule(rules, i, e.key === 'ArrowUp' ? -1 : 1))
                    }
                  }}
                  aria-label={`Rule ${i + 1}`}
                  placeholder="A standing rule"
                />
                <button type="button" className="cf-iconbtn" onClick={() => set('rules', removeRule(rules, i))} aria-label={`Remove rule ${i + 1}`}>
                  ×
                </button>
              </li>
            ))}
          </ol>
        )}
        {errors.rules && <p className="field__err">{errors.rules}</p>}
      </section>

      <section className="cf-card">
        <h3 className="cf-card__title">
          <label htmlFor="pf-instr">Instructions</label>
        </h3>
        <textarea
          id="pf-instr"
          className="cf-prof__instr"
          value={draft.instructions}
          onChange={(e) => set('instructions', e.target.value)}
          rows={3}
          placeholder={`Who ${draft.name || 'this bot'} is and how it works.`}
        />
      </section>

      <div className="cf-prof__actions">
        {saveError && <p className="field__err cf-grow" role="alert">{saveError}</p>}
        {savedNote && !dirty && !saveError && <p className="cf-set__ok cf-grow" role="status">Saved. Changes apply from the next message.</p>}
        <button type="button" className="btn" onClick={reset} disabled={saving || !dirty}>
          Cancel
        </button>
        <button type="submit" className="btn btn--primary" disabled={saving || !dirty}>
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>

      <section className="cf-card">
        <h3 className="cf-card__title">Folder &amp; access</h3>
        <dl className="cf-kv">
          <dt>Private folder</dt>
          <dd>
            {folder ? <code>{folder}</code> : 'Not reported by this server yet'}
            <span className="cf-kv__note">Set when the bot is created; it can't be renamed.</span>
          </dd>
          <dt>Internet for scripts</dt>
          <dd>
            {INTERNET_POLICY_LABELS[internetPolicy]}
            <span className="cf-kv__note">Change it in the Sandbox tab (FE-4).</span>
          </dd>
        </dl>
      </section>

      <section className="cf-card cf-danger">
        <div className="cf-danger__row">
          <div>
            <p className="row__label">Clear chat history</p>
            <p className="row__hint">Empties this bot&apos;s transcript. Prior turns stop feeding context.</p>
          </div>
          <button type="button" className="btn" onClick={() => setConfirm('clear')} disabled={busy !== null}>
            Clear…
          </button>
        </div>
        {!agent.isPrimary && (
          <div className="cf-danger__row">
            <div>
              <p className="row__label">Delete bot</p>
              <p className="row__hint">Removes the bot and its run history. Cannot be undone.</p>
            </div>
            <button type="button" className="btn btn--danger" onClick={() => setConfirm('delete')} disabled={busy !== null}>
              Delete…
            </button>
          </div>
        )}
      </section>

      <Confirm
        open={confirm === 'clear'}
        title="Clear chat history?"
        subtitle={`This empties ${agent.name}'s transcript. It cannot be undone.`}
        confirmLabel="Clear history"
        loading={busy === 'clear'}
        onCancel={() => setConfirm(null)}
        onConfirm={() => void clearChat()}
      >
        <p className="prose">The bot keeps its settings, memory and skills; only the conversation is removed.</p>
        {error && <p className="field__err" role="alert">{error}</p>}
      </Confirm>
      {!agent.isPrimary && (
        <Confirm
          open={confirm === 'delete'}
          title={`Delete ${agent.name}?`}
          subtitle="This removes the bot and its run history. It cannot be undone."
          confirmLabel="Delete bot"
          loading={busy === 'delete'}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void deleteAgent()}
        >
          {error && <p className="field__err" role="alert">{error}</p>}
        </Confirm>
      )}
    </form>
  )
}
