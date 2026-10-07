import { useCallback, useMemo, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import Dialog from '../components/Dialog'
import { AgentsIcon, ChevronLeftIcon } from '../components/icons'
import { ErrorState, Skeleton } from '../components/States'
import { api, ENDPOINT_KIND_LABELS, TIER_LABELS } from '../lib/api'
import type { Agent, AgentInput, Endpoint, Model, Skill } from '../lib/types'
import { useAsync } from '../hooks/useAsync'

const EMPTY: AgentInput = { name: '', description: '', instructions: '', modelId: '', endpointId: null, temperature: 0, skillIds: [] }

function toInput(agent: Agent): AgentInput {
  return {
    name: agent.name,
    description: agent.description,
    instructions: agent.instructions,
    modelId: agent.modelId,
    endpointId: agent.endpointId ?? null,
    temperature: agent.temperature ?? 0,
    skillIds: [...agent.skillIds],
  }
}

function isDirty(a: AgentInput, b: AgentInput): boolean {
  return (
    a.name.trim() !== b.name.trim() ||
    a.description.trim() !== b.description.trim() ||
    a.instructions.trim() !== b.instructions.trim() ||
    a.modelId.trim() !== b.modelId.trim() ||
    (a.endpointId ?? null) !== (b.endpointId ?? null) ||
    a.skillIds.length !== b.skillIds.length ||
    a.skillIds.some((id) => !b.skillIds.includes(id))
  )
}

type FormProps = {
  initial: Agent | null
  isEdit: boolean
  models: Model[]
  endpoints: Endpoint[]
  skills: Skill[]
}

function AgentForm({ initial, isEdit, models, endpoints, skills }: FormProps) {
  const navigate = useNavigate()
  const baseline = initial ? toInput(initial) : EMPTY

  const [draft, setDraft] = useState<AgentInput>(baseline)
  const [errors, setErrors] = useState<Partial<Record<'name' | 'modelId' | 'endpointId', string>>>({})
  const [skillQuery, setSkillQuery] = useState('')
  const [saving, setSaving] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [confirmDiscard, setConfirmDiscard] = useState(false)

  const backTo = isEdit && initial ? `/agents/${initial.id}` : '/agents'

  const set = <K extends keyof AgentInput>(key: K, value: AgentInput[K]) => {
    setDraft((d) => ({ ...d, [key]: value }))
    setErrors((e) => ({ ...e, [key]: undefined }))
  }

  const toggleSkill = (id: string) => {
    setDraft((d) => ({
      ...d,
      skillIds: d.skillIds.includes(id) ? d.skillIds.filter((s) => s !== id) : [...d.skillIds, id],
    }))
  }

  const filteredSkills = useMemo(() => {
    const q = skillQuery.trim().toLowerCase()
    if (!q) return skills
    return skills.filter(
      (s) =>
        s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q) || s.tag.toLowerCase().includes(q),
    )
  }, [skills, skillQuery])

  const providers = useMemo(() => [...new Set(models.map((m) => m.provider))], [models])
  const selectedModel = models.find((m) => m.id === draft.modelId)
  const selectedEndpoint = endpoints.find((e) => e.id === draft.endpointId) ?? null
  const usingCustom = selectedEndpoint !== null

  // Models served by the chosen endpoint (GET /api/endpoints/:id/models).
  // Never free-texted: the agent can only reference a served model id.
  const loadEpModels = useCallback(
    () => (draft.endpointId ? api.listEndpointModels(draft.endpointId) : Promise.resolve([])),
    [draft.endpointId],
  )
  const epModels = useAsync(loadEpModels, [draft.endpointId ?? ''])

  // Derive the selectable model during render (covers endpoint switches and
  // edits whose model vanished upstream): prefer the draft when served,
  // else the endpoint default, else the first served model.
  const servedIds = useMemo(() => (epModels.data ?? []).map((m) => m.id), [epModels.data])
  const effectiveModelId =
    usingCustom && selectedEndpoint && servedIds.length > 0 && !servedIds.includes(draft.modelId)
      ? (servedIds.includes(selectedEndpoint.defaultModel) ? selectedEndpoint.defaultModel : servedIds[0])
      : draft.modelId

  const pickEndpoint = (endpointId: string) => {
    if (!endpointId) {
      setDraft((d) => ({ ...d, endpointId: null, modelId: '' }))
    } else {
      const ep = endpoints.find((e) => e.id === endpointId)
      setDraft((d) => ({ ...d, endpointId, modelId: ep ? ep.defaultModel : d.modelId }))
    }
    setErrors((e) => ({ ...e, endpointId: undefined, modelId: undefined }))
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()

    const next: typeof errors = {}
    if (!draft.name.trim()) next.name = 'Give the agent a name.'
    if (draft.endpointId !== null && !selectedEndpoint) {
      next.endpointId = 'This endpoint no longer exists. Pick another one.'
    } else if (usingCustom && selectedEndpoint) {
      if (epModels.loading) next.modelId = 'Models are still loading — wait a moment.'
      else if (epModels.error) next.modelId = 'Could not load models for this endpoint. Try again.'
      else if (servedIds.length === 0) next.modelId = 'This endpoint serves no models.'
      else if (!effectiveModelId.trim()) next.modelId = 'Pick a model from this endpoint.'
      else if (!servedIds.includes(effectiveModelId)) {
        next.modelId = 'Pick a model from this endpoint.'
      }
    } else if (!draft.modelId.trim()) {
      next.modelId = 'Pick a model to run this agent on.'
    }
    setErrors(next)
    if (Object.keys(next).length > 0) {
      document.getElementById(next.name ? 'af-name' : usingCustom ? 'af-model-name' : 'af-model')?.focus()
      return
    }

    setSaving(true)
    setSubmitError(null)
    try {
      const payload: AgentInput = { ...draft, modelId: usingCustom ? effectiveModelId : draft.modelId.trim() }
      const saved = initial ? await api.updateAgent(initial.id, payload) : await api.createAgent(payload)
      navigate(isEdit && initial ? `/agents/${initial.id}` : `/agents/${saved.id}`, { replace: true })
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Could not save the agent.')
      setSaving(false)
    }
  }

  const leave = () => {
    if (isDirty(draft, baseline)) setConfirmDiscard(true)
    else navigate(backTo)
  }

  return (
    <main className="page">
      <div className="page__inner page__inner--narrow">
        <Link to={backTo} className="detail__back">
          <ChevronLeftIcon size={14} />
          {isEdit ? 'Back to agent' : 'Back to agents'}
        </Link>

        <div className="formpage__head">
          <span className="detail__icon">
            <AgentsIcon size={22} />
          </span>
          <div>
            <p className="page__eyebrow">{isEdit ? 'Agents' : 'New'}</p>
            <h1 className="detail__name">{isEdit ? 'Edit agent' : 'New agent'}</h1>
            <p className="page__sub">
              {isEdit
                ? 'Changes take effect on the next run. In-flight runs keep the old configuration.'
                : 'Name it, choose a model, and give it the skills it needs.'}
            </p>
          </div>
        </div>

        <form className="form form--page" onSubmit={submit} noValidate>
          <section className="formcard">
            <div className="formsection">
              <h2 className="formsection__title">Basics</h2>
              <p className="formsection__hint">What this agent is called and what it is for.</p>

              <div className="field">
                <label className="field__label" htmlFor="af-name">
                  Name <span className="field__req" aria-hidden="true">*</span>
                </label>
                <input
                  id="af-name"
                  className={`input${errors.name ? ' input--invalid' : ''}`}
                  value={draft.name}
                  onChange={(e) => set('name', e.target.value)}
                  placeholder="Support Triage"
                  aria-invalid={Boolean(errors.name)}
                  aria-describedby={errors.name ? 'af-name-err' : undefined}
                />
                {errors.name ? (
                  <p className="field__err" id="af-name-err">
                    {errors.name}
                  </p>
                ) : (
                  <p className="field__hint">Unique within the workspace.</p>
                )}
              </div>

              <div className="field">
                <label className="field__label" htmlFor="af-desc">
                  Description
                </label>
                <input
                  id="af-desc"
                  className="input"
                  value={draft.description}
                  onChange={(e) => set('description', e.target.value)}
                  placeholder="What this agent is for, in one line."
                />
                <p className="field__hint">Shown on the agent card and in search results.</p>
              </div>
            </div>

            <div className="formsection">
              <h2 className="formsection__title">Model & endpoint</h2>
              <p className="formsection__hint">Run on a hosted model, a self-hosted llama.cpp / vLLM server, or OpenRouter.</p>

              <div className="field">
                <label className="field__label" htmlFor="af-endpoint">
                  Endpoint
                </label>
                <select
                  id="af-endpoint"
                  className={`select${errors.endpointId ? ' input--invalid' : ''}`}
                  value={draft.endpointId ?? ''}
                  onChange={(e) => pickEndpoint(e.target.value)}
                  aria-invalid={Boolean(errors.endpointId)}
                  aria-describedby={errors.endpointId ? 'af-endpoint-err' : 'af-endpoint-hint'}
                >
                  <option value="">Hosted models (default)</option>
                  {endpoints.map((ep) => (
                    <option key={ep.id} value={ep.id}>
                      {ep.name} ({ENDPOINT_KIND_LABELS[ep.kind]})
                    </option>
                  ))}
                </select>
                {errors.endpointId ? (
                  <p className="field__err" id="af-endpoint-err">
                    {errors.endpointId}
                  </p>
                ) : (
                  <p className="field__hint" id="af-endpoint-hint">
                    {selectedEndpoint
                      ? `${selectedEndpoint.baseUrl} · ${selectedEndpoint.contextWindow.toLocaleString()} ctx`
                      : 'Need a custom server? Add it in Settings → Endpoints.'}
                  </p>
                )}
              </div>

              {usingCustom && selectedEndpoint ? (
                <div className="field">
                  <label className="field__label" htmlFor="af-model-name">
                    Model <span className="field__req" aria-hidden="true">*</span>
                  </label>
                  <select
                    id="af-model-name"
                    className={`select${errors.modelId ? ' input--invalid' : ''}`}
                    value={effectiveModelId}
                    onChange={(e) => set('modelId', e.target.value)}
                    disabled={epModels.loading || Boolean(epModels.error) || (epModels.data ?? []).length === 0}
                    aria-invalid={Boolean(errors.modelId)}
                    aria-describedby={errors.modelId ? 'af-model-err' : 'af-model-hint'}
                  >
                    {epModels.loading ? (
                      <option value="">Loading models…</option>
                    ) : (
                      <>
                        <option value="">Select a model…</option>
                        {(epModels.data ?? []).map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                      </>
                    )}
                  </select>
                  {errors.modelId ? (
                    <p className="field__err" id="af-model-err">
                      {errors.modelId}
                      {epModels.error && (
                        <>
                          {' '}
                          <button type="button" className="btn" onClick={epModels.reload} style={{ marginLeft: 8 }}>
                            Retry
                          </button>
                        </>
                      )}
                    </p>
                  ) : (
                    <p className="field__hint" id="af-model-hint">
                      Served by {selectedEndpoint.name} · {selectedEndpoint.baseUrl}
                      {selectedEndpoint.apiKeySet ? ' · key set' : ''}
                    </p>
                  )}
                </div>
              ) : (
                <div className="field">
                  <label className="field__label" htmlFor="af-model">
                    Model <span className="field__req" aria-hidden="true">*</span>
                  </label>
                  <select
                    id="af-model"
                    className={`select${errors.modelId ? ' input--invalid' : ''}`}
                    value={draft.modelId}
                    onChange={(e) => set('modelId', e.target.value)}
                    aria-invalid={Boolean(errors.modelId)}
                    aria-describedby={errors.modelId ? 'af-model-err' : 'af-model-hint'}
                  >
                    <option value="">Select a model…</option>
                    {providers.map((provider) => (
                      <optgroup key={provider} label={provider}>
                        {models
                          .filter((m) => m.provider === provider)
                          .map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.name} — {TIER_LABELS[m.tier]}
                            </option>
                          ))}
                      </optgroup>
                    ))}
                  </select>
                  {errors.modelId ? (
                    <p className="field__err" id="af-model-err">
                      {errors.modelId}
                    </p>
                  ) : (
                    <p className="field__hint" id="af-model-hint">
                      {selectedModel
                        ? `${selectedModel.provider} · ${TIER_LABELS[selectedModel.tier]} · ${selectedModel.contextWindow.toLocaleString()} token context`
                        : 'Pick the provider that hosts this agent.'}
                    </p>
                  )}
                </div>
              )}
            </div>

            <div className="formsection">
              <div className="formsection__bar">
                <div>
                  <h2 className="formsection__title">Skills</h2>
                  <p className="formsection__hint">
                    Capabilities this agent can call. They stay shared with the Skill Library.
                  </p>
                </div>
                <span className="pill">{draft.skillIds.length} selected</span>
              </div>

              <div className="search skillpick__search">
                <span className="search__icon">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
                    <circle cx="11" cy="11" r="6.5" />
                    <path d="m16 16 4 4" />
                  </svg>
                </span>
                <input
                  value={skillQuery}
                  onChange={(e) => setSkillQuery(e.target.value)}
                  placeholder="Filter skills…"
                  aria-label="Filter skills"
                  type="search"
                />
              </div>

              {filteredSkills.length === 0 ? (
                <p className="field__hint skillpick__none">No skills match “{skillQuery.trim()}”.</p>
              ) : (
                <div className="skillpick">
                  {filteredSkills.map((s) => {
                    const on = draft.skillIds.includes(s.id)
                    return (
                      <label className={`skillrow${on ? ' skillrow--on' : ''}`} key={s.id}>
                        <input type="checkbox" checked={on} onChange={() => toggleSkill(s.id)} />
                        <span className="skillrow__text">
                          <span className="skillrow__name">
                            {s.name}
                            <span className="pill skillrow__tag">{s.tag}</span>
                          </span>
                          <span className="skillrow__desc">{s.description}</span>
                        </span>
                      </label>
                    )
                  })}
                </div>
              )}
            </div>

            <div className="formsection">
              <h2 className="formsection__title">Instructions</h2>
              <p className="formsection__hint">Sent as the system prompt on every run.</p>
              <div className="field">
                <textarea
                  id="af-instructions"
                  className="textarea"
                  value={draft.instructions}
                  onChange={(e) => set('instructions', e.target.value)}
                  placeholder="How it should behave, what to avoid, when to stop and ask."
                  rows={7}
                />
              </div>
            </div>

            {submitError && (
              <p className="field__err formpage__error" role="alert">
                {submitError}
              </p>
            )}
          </section>

          <div className="formactions">
            <button type="button" className="btn" onClick={leave} disabled={saving}>
              Cancel
            </button>
            <button type="submit" className="btn btn--primary" disabled={saving}>
              {saving && <span className="spinner" aria-hidden="true" />}
              {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create agent'}
            </button>
          </div>
        </form>

        <Dialog
          open={confirmDiscard}
          size="sm"
          title="Discard changes?"
          subtitle="This agent has unsaved edits."
          onClose={() => setConfirmDiscard(false)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setConfirmDiscard(false)}>
                Keep editing
              </button>
              <button type="button" className="btn btn--danger" onClick={() => navigate(backTo)}>
                Discard
              </button>
            </>
          }
        >
          <p className="prose">Your changes to this agent will be lost.</p>
        </Dialog>
      </div>
    </main>
  )
}

export default function AgentFormPage() {
  const { id } = useParams()
  const isEdit = id !== undefined

  const loadAgent = useCallback(
    () => (isEdit ? api.getAgent(id) : Promise.resolve(null)),
    [id, isEdit],
  )

  const models = useAsync(api.listModels, [])
  const endpoints = useAsync(api.listEndpoints, [])
  const skills = useAsync(api.listSkills, [])
  const agent = useAsync(loadAgent, [id ?? ''])

  const error = models.error ?? endpoints.error ?? skills.error ?? agent.error

  if (!error && (models.loading || endpoints.loading || skills.loading || agent.loading)) {
    return (
      <main className="page">
        <div className="page__inner page__inner--narrow">
          <div className="formpage__head">
            <span className="skeleton" style={{ display: 'block', width: 44, height: 44, borderRadius: 15 }} />
            <div style={{ flex: 1, minWidth: 180 }}>
              <Skeleton width="38%" height={20} />
              <div style={{ height: 10 }} />
              <Skeleton width="66%" height={10} />
            </div>
          </div>
          <div className="formcard">
            {[0, 1, 2].map((i) => (
              <div className="formsection" key={i}>
                <Skeleton width="22%" height={12} />
                <div style={{ height: 16 }} />
                <Skeleton height={38} />
              </div>
            ))}
          </div>
        </div>
      </main>
    )
  }

  if (error) {
    return (
      <main className="page">
        <div className="page__inner page__inner--narrow">
          <ErrorState error={error} onRetry={() => void 0} />
        </div>
      </main>
    )
  }

  if (isEdit && !agent.data) {
    return (
      <main className="page">
        <div className="page__inner page__inner--narrow">
          <ErrorState title="Agent not found" error={new Error('This agent may have been deleted.')} />
        </div>
      </main>
    )
  }

  return (
    <AgentForm
      key={id ?? 'new'}
      initial={agent.data ?? null}
      isEdit={isEdit}
      models={models.data ?? []}
      endpoints={endpoints.data ?? []}
      skills={skills.data ?? []}
    />
  )
}