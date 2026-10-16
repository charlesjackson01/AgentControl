import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { AgentsIcon, ChevronLeftIcon } from './icons'
import { agentAvatarUrl, api, DEFAULT_ENDPOINT_BASE_URL, ENDPOINT_KIND_LABELS } from '../lib/api'
import AvatarPicker from './AvatarPicker'
import { avatarBaseline, avatarDirty, avatarSavePlan, type AvatarDraft } from '../lib/avatar-draft'
import {
  AVATAR_PALETTE,
  MAX_RULE_LENGTH,
  MAX_RULES,
  addRule,
  moveRule,
  normalizeRules,
  removeRule,
  rulesEqual,
  describeRulesCost,
  rulesTokenCost,
  updateRule,
} from '../lib/agent-profile'
import type { Agent, AgentInput, Endpoint, PromptBudget, PromptBudgetInput, Skill } from '../lib/types'
import { describePromptBudget, grantedToolNames } from '../lib/prompt-budget'
import { matchesSkillQuery } from '../lib/skill-search'
import { useAsync } from '../hooks/useAsync'
import Dialog from './Dialog'

const MODELS_LOADING = 'Models are still loading — wait a moment.'

/** Quiet period after the last endpoint/skills/instructions edit before the prompt-size preview refetches. */
const BUDGET_DEBOUNCE_MS = 300

const EMPTY: AgentInput = { name: '', role: '', description: '', instructions: '', modelId: '', endpointId: '', temperature: 0, skillIds: [], rules: [], color: null }

/** DD-7 bootstrap: the lead's identity is set up for the user, not asked. */
const LEAD_INSTRUCTIONS =
  'You are the Team Lead. Coordinate the other agents, review their work, and keep projects moving.'
// The three starter skills the BE seeds in the Skill Library.
const LEAD_SKILL_IDS = ['deep-research', 'summarization', 'multi-agent-orchestration']

function toInput(agent: Agent): AgentInput {
  return {
    name: agent.name,
    role: agent.role ?? '',
    description: agent.description,
    instructions: agent.instructions,
    modelId: agent.modelId,
    endpointId: agent.endpointId,
    temperature: agent.temperature ?? 0,
    skillIds: [...agent.skillIds],
    rules: [...(agent.rules ?? [])],
    color: agent.color ?? null,
  }
}

function isDirty(a: AgentInput, b: AgentInput): boolean {
  return (
    a.name.trim() !== b.name.trim() ||
    a.role.trim() !== b.role.trim() ||
    a.description.trim() !== b.description.trim() ||
    a.instructions.trim() !== b.instructions.trim() ||
    a.modelId.trim() !== b.modelId.trim() ||
    a.endpointId !== b.endpointId ||
    a.skillIds.length !== b.skillIds.length ||
    a.skillIds.some((id) => !b.skillIds.includes(id)) ||
    !rulesEqual(a.rules ?? [], b.rules ?? []) ||
    (a.color ?? null) !== (b.color ?? null)
  )
}

type FormProps = {
  initial: Agent | null
  isEdit: boolean
  endpoints: Endpoint[]
  skills: Skill[]
  /** The Team Lead's endpoint — preselected (and labeled) for new agents. */
  defaultEndpointId?: string | null
  /** Bootstrap mode: creates the workspace's first agent with isPrimary: true. */
  isBootstrap?: boolean
  /** Drawer / bootstrap mode: the bare form, no page chrome around it. */
  compact?: boolean
  /** Hide the Cancel action (bootstrap has nowhere to cancel to). */
  noCancel?: boolean
  /** Called with the saved agent; when omitted the form navigates itself. */
  onSaved?: (saved: Agent) => void
  /** Cancel handler; when omitted the form navigates to backTo. */
  onCancel?: () => void
}

export default function AgentProfile({
  initial,
  isEdit,
  endpoints,
  skills,
  defaultEndpointId = null,
  isBootstrap = false,
  compact = false,
  noCancel = false,
  onSaved,
  onCancel,
}: FormProps) {
  const navigate = useNavigate()
  const baseline = initial
    ? toInput(initial)
    : isBootstrap
      ? {
          ...EMPTY,
          role: 'Team Lead',
          // Preselect the default endpoint (else the first); still changeable. The
          // Team Lead's endpoint then becomes every later agent's default.
          endpointId: (endpoints.find((ep) => ep.baseUrl === DEFAULT_ENDPOINT_BASE_URL) ?? endpoints[0])?.id ?? '',
          instructions: LEAD_INSTRUCTIONS,
          temperature: 0.7,
          // Pre-check the starter skills that exist in this workspace.
          skillIds: LEAD_SKILL_IDS.filter((id) => skills.some((s) => s.id === id)),
        }
      : { ...EMPTY, endpointId: defaultEndpointId ?? '' }

  const [draft, setDraft] = useState<AgentInput>(baseline)
  const [errors, setErrors] = useState<Partial<Record<'name' | 'modelId' | 'endpointId' | 'temperature', string>>>({})
  const [skillQuery, setSkillQuery] = useState('')
  const [saving, setSaving] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [avatarDraft, setAvatarDraft] = useState<AvatarDraft>(() => avatarBaseline(initial?.avatar))
  const [avatarError, setAvatarError] = useState<string | null>(null)
  // Endpoint/skills/parameters sit in a collapsible Advanced block; open for new agents.
  const [advancedOpen, setAdvancedOpen] = useState(!isEdit)
  const rules = draft.rules ?? []
  const setRules = (next: string[]) => setDraft((d) => ({ ...d, rules: next }))

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

  const filteredSkills = useMemo(() => skills.filter((s) => matchesSkillQuery(s, skillQuery)), [skills, skillQuery])

  // Tools the selected skills declare, derived locally so the chips follow every toggle.
  const grantedTools = useMemo(() => grantedToolNames(skills, draft.skillIds), [skills, draft.skillIds])
  const skillNames = useMemo(() => new Map(skills.map((s) => [s.id, s.name])), [skills])

  // Prompt-size preview (POST /api/prompt-budget), debounced. Only the current
  // request's response lands (superseded ones are aborted and ignored); a
  // failed request just hides the line, so the form never shows a budget error.
  const budgetRequest = useMemo<PromptBudgetInput | null>(() => {
    if (isBootstrap || !draft.endpointId) return null
    const savedRules = normalizeRules(draft.rules ?? [])
    if (draft.skillIds.length === 0 && !draft.instructions.trim() && savedRules.length === 0) return null
    return { endpointId: draft.endpointId, skillIds: draft.skillIds, instructions: draft.instructions, rules: savedRules }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the normalized rules text
  }, [isBootstrap, draft.endpointId, draft.skillIds, draft.instructions, normalizeRules(draft.rules ?? []).join('\n')])
  const [budget, setBudget] = useState<{ request: PromptBudgetInput; value: PromptBudget; rulesCost: number | null } | null>(null)
  useEffect(() => {
    if (!budgetRequest) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      const opts = { signal: controller.signal }
      api.getPromptBudget(budgetRequest, opts).then(
        (value) => {
          if (!controller.signal.aborted) {
            setBudget({ request: budgetRequest, value, rulesCost: rulesTokenCost(value) })
          }
        },
        () => {
          if (!controller.signal.aborted) setBudget(null)
        },
      )
    }, BUDGET_DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [budgetRequest])
  // The last answer stays up (dimmed) while a newer request is in flight.
  const shownBudget = budgetRequest ? budget : null
  const budgetStale = shownBudget !== null && shownBudget.request !== budgetRequest
  const budgetMessage = useMemo(
    () => (shownBudget ? describePromptBudget(shownBudget.value, skillNames) : null),
    [shownBudget, skillNames],
  )

  const selectedEndpoint = endpoints.find((e) => e.id === draft.endpointId) ?? null

  // Models served by the chosen endpoint (GET /api/endpoints/:id/models).
  // Never free-texted: the agent can only reference a served model id.
  const loadEpModels = useCallback(
    () => (draft.endpointId ? api.listEndpointModels(draft.endpointId) : Promise.resolve([])),
    [draft.endpointId],
  )
  const epModels = useAsync(loadEpModels, [draft.endpointId])

  // Derive the selectable model during render (covers endpoint switches and
  // edits whose model vanished upstream): prefer the draft when served,
  // else the endpoint default, else the first served model.
  // "Still loading" describes a moment, not the form: drop it once models arrive.
  const modelError = errors.modelId === MODELS_LOADING && !epModels.loading ? undefined : errors.modelId

  const servedIds = useMemo(() => (epModels.data ?? []).map((m) => m.id), [epModels.data])
  const effectiveModelId =
    selectedEndpoint && servedIds.length > 0 && !servedIds.includes(draft.modelId)
      ? (servedIds.includes(selectedEndpoint.defaultModel) ? selectedEndpoint.defaultModel : servedIds[0])
      : draft.modelId

  const pickEndpoint = (endpointId: string) => {
    const ep = endpoints.find((e) => e.id === endpointId)
    setDraft((d) => ({ ...d, endpointId, modelId: ep ? ep.defaultModel : '' }))
    setErrors((e) => ({ ...e, endpointId: undefined, modelId: undefined }))
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()

    const next: typeof errors = {}
    if (!draft.name.trim()) next.name = 'Give the agent a name.'
    if (!draft.endpointId) {
      next.endpointId = 'Pick an endpoint to run this agent on.'
    } else if (!selectedEndpoint) {
      next.endpointId = 'This endpoint no longer exists. Pick another one.'
    } else {
      if (epModels.loading) next.modelId = MODELS_LOADING
      else if (epModels.error) next.modelId = 'Could not load models for this endpoint. Try again.'
      else if (servedIds.length === 0) next.modelId = 'This endpoint serves no models.'
      else if (!effectiveModelId.trim()) next.modelId = 'Pick a model from this endpoint.'
      else if (!servedIds.includes(effectiveModelId)) {
        next.modelId = 'Pick a model from this endpoint.'
      }
    }
    const temperature = draft.temperature
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
      next.temperature = 'Set temperature between 0 and 2.'
    }
    setErrors(next)
    if (next.endpointId || next.modelId || next.temperature) setAdvancedOpen(true)
    if (Object.keys(next).length > 0) {
      document.getElementById(next.name ? 'af-name' : next.endpointId ? 'af-endpoint' : 'af-model-name')?.focus()
      return
    }

    setSaving(true)
    setSubmitError(null)
    try {
      const payload: AgentInput = {
        ...draft,
        role: draft.role.trim(),
        modelId: effectiveModelId.trim(),
        rules: normalizeRules(rules),
        ...(isBootstrap ? { isPrimary: true } : {}),
      }
      // Emoji rides in the agent body; images go through the avatar routes.
      const plan = avatarSavePlan(avatarDraft, initial?.avatar)
      if (plan.avatar !== undefined) payload.avatar = plan.avatar
      if (initial && plan.deleteImage) await api.deleteAgentAvatar(initial.id)
      let saved = initial ? await api.updateAgent(initial.id, payload) : await api.createAgent(payload)
      if (plan.upload && avatarDraft.file) saved = await api.uploadAgentAvatar(saved.id, avatarDraft.file)
      if (onSaved) onSaved(saved)
      else navigate(isEdit && initial ? `/agents/${initial.id}` : `/agents/${saved.id}`, { replace: true })
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Could not save the agent.')
      setSaving(false)
    }
  }

  const finish = () => {
    if (onCancel) onCancel()
    else navigate(backTo)
  }

  const leave = () => {
    if (isDirty(draft, baseline) || avatarDirty(avatarDraft, avatarBaseline(initial?.avatar))) setConfirmDiscard(true)
    else finish()
  }

  const form = (
        <form className={compact ? 'form' : 'form form--page'} onSubmit={submit} noValidate>
          <section className="formcard">
            <div className="formsection">
              <h2 className="formsection__title">Basics</h2>
              <p className="formsection__hint">What this agent is called and what it is for.</p>

              <AvatarPicker
                id="af-avatar"
                name={draft.name || 'New agent'}
                agentId={initial?.id}
                current={initial?.avatar}
                storedImageUrl={initial?.avatar?.kind === 'image' ? agentAvatarUrl(initial.id, initial.avatar.updatedAt) : null}
                color={draft.color}
                value={avatarDraft}
                onChange={setAvatarDraft}
                error={avatarError}
                onError={setAvatarError}
                extra={
                  <div className="avatarpick__colors" role="group" aria-label="Avatar colour">
                    {AVATAR_PALETTE.map((c) => (
                      <button
                        type="button"
                        key={c}
                        style={{ background: c }}
                        aria-pressed={draft.color === c}
                        aria-label={`Colour ${c}`}
                        onClick={() => set('color', draft.color === c ? null : c)}
                      />
                    ))}
                  </div>
                }
              />

              <div className="field">
                <label className="field__label" htmlFor="af-name">
                  Name <span className="field__req" aria-hidden="true">*</span>
                </label>
                <input
                  id="af-name"
                  className={`input${errors.name ? ' input--invalid' : ''}`}
                  value={draft.name}
                  onChange={(e) => set('name', e.target.value)}
                  placeholder={isBootstrap ? 'Team Lead' : 'Support Triage'}
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

              {!isBootstrap && (
                <div className="field">
                  <label className="field__label" htmlFor="af-role">
                    Role
                  </label>
                  <input
                    id="af-role"
                    className="input"
                    value={draft.role}
                    onChange={(e) => set('role', e.target.value)}
                    placeholder="e.g. Code Reviewer"
                    aria-describedby="af-role-hint"
                  />
                  <p className="field__hint" id="af-role-hint">
                    Shown under the agent's name on cards and in chat.
                  </p>
                </div>
              )}

              {!isBootstrap && (
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
              )}
            </div>

            {!isBootstrap && (
              <>
            <div className="formsection">
              <h2 className="formsection__title">Persona</h2>
              <p className="formsection__hint">Who this agent is and how it talks. Sent as the system prompt on every run.</p>
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

            <div className="formsection">
              <div className="formsection__bar">
                <div>
                  <h2 className="formsection__title">Rules</h2>
                  <p className="formsection__hint">
                    Standing rules the agent always follows, one per line item. Kept apart from the persona.
                  </p>
                </div>
                <span className="pill">{normalizeRules(rules).length} / {MAX_RULES}</span>
              </div>
              <p className="field__hint" role="status" aria-live="polite">
                {describeRulesCost({
                  ruleCount: normalizeRules(rules).length,
                  hasEndpoint: Boolean(draft.endpointId),
                  cost: shownBudget && !budgetStale ? shownBudget.rulesCost : null,
                  pending: budgetStale || (Boolean(budgetRequest) && !shownBudget),
                })}
                {shownBudget
                  ? ` Prompt ≈${shownBudget.value.estimatedTokens.toLocaleString()} of ${(shownBudget.value.contextWindow - shownBudget.value.responseReserve).toLocaleString()} tokens available.`
                  : ''}
              </p>
              {rules.length > 0 && (
                <ol className="rules" aria-label="Rules">
                  {rules.map((rule, i) => (
                    <li className="rules__row" key={i}>
                      <span className="rules__num" aria-hidden="true">{i + 1}.</span>
                      <textarea
                        id={`af-rule-${i}`}
                        className="textarea"
                        rows={1}
                        value={rule}
                        maxLength={MAX_RULE_LENGTH}
                        onChange={(e) => setRules(updateRule(rules, i, e.target.value))}
                        placeholder="e.g. Always cite the file you changed."
                        aria-label={`Rule ${i + 1}`}
                      />
                      <span className="rules__tools">
                        <button type="button" className="btn btn--sm" aria-label={`Move rule ${i + 1} up`} disabled={i === 0} onClick={() => setRules(moveRule(rules, i, -1))}>↑</button>
                        <button type="button" className="btn btn--sm" aria-label={`Move rule ${i + 1} down`} disabled={i === rules.length - 1} onClick={() => setRules(moveRule(rules, i, 1))}>↓</button>
                        <button type="button" className="btn btn--sm" aria-label={`Remove rule ${i + 1}`} onClick={() => setRules(removeRule(rules, i))}>×</button>
                      </span>
                    </li>
                  ))}
                </ol>
              )}
              <div>
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={rules.length >= MAX_RULES}
                  onClick={() => {
                    const next = addRule(rules)
                    setRules(next)
                    requestAnimationFrame(() => document.getElementById(`af-rule-${next.length - 1}`)?.focus())
                  }}
                >
                  + Add rule
                </button>
              </div>
            </div>

            <div className="formsection">
              <h2 className="formsection__title">Memory</h2>
              <p className="formsection__hint">Facts this agent remembers about you and its work.</p>
              <p className="memorystub">Coming in Part 3: memory facts the agent saves, and ones you add or remove here.</p>
            </div>

            <details
              className="formsection formsection--advanced"
              open={advancedOpen}
              onToggle={(e) => setAdvancedOpen(e.currentTarget.open)}
            >
              <summary>
                <h2 className="formsection__title">Advanced</h2>
                <p className="formsection__hint">Endpoint, model, skills and parameters.</p>
              </summary>
            <div className="formsection">
              <h2 className="formsection__title">Endpoint & model</h2>
              <p className="formsection__hint">
                Every agent runs on an endpoint. New agents start on the Team Lead's endpoint.
              </p>

              <div className="field">
                <label className="field__label" htmlFor="af-endpoint">
                  Endpoint <span className="field__req" aria-hidden="true">*</span>
                </label>
                <select
                  id="af-endpoint"
                  className={`select${errors.endpointId ? ' input--invalid' : ''}`}
                  value={draft.endpointId}
                  onChange={(e) => pickEndpoint(e.target.value)}
                  aria-invalid={Boolean(errors.endpointId)}
                  aria-describedby={errors.endpointId ? 'af-endpoint-err' : 'af-endpoint-hint'}
                >
                  {defaultEndpointId ? (
                    <option value={defaultEndpointId}>Default — Team Lead's endpoint</option>
                  ) : (
                    <option value="">Select an endpoint…</option>
                  )}
                  {endpoints
                    .filter((ep) => ep.id !== defaultEndpointId)
                    .map((ep) => (
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
                      : 'Add a server in Settings → Endpoints.'}
                  </p>
                )}
              </div>

              {draft.endpointId && selectedEndpoint ? (
                <div className="field">
                  <label className="field__label" htmlFor="af-model-name">
                    Model <span className="field__req" aria-hidden="true">*</span>
                  </label>
                  <select
                    id="af-model-name"
                    className={`select${modelError ? ' input--invalid' : ''}`}
                    value={effectiveModelId}
                    onChange={(e) => set('modelId', e.target.value)}
                    disabled={epModels.loading || Boolean(epModels.error) || (epModels.data ?? []).length === 0}
                    aria-invalid={Boolean(modelError)}
                    aria-describedby={modelError ? 'af-model-err' : 'af-model-hint'}
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
                  {modelError ? (
                    <p className="field__err" id="af-model-err">
                      {modelError}
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
                  <label className="field__label" htmlFor="af-model-name">
                    Model <span className="field__req" aria-hidden="true">*</span>
                  </label>
                  <select id="af-model-name" className="select" value="" disabled aria-describedby="af-model-hint">
                    <option value="">Pick an endpoint first…</option>
                  </select>
                  <p className="field__hint" id="af-model-hint">
                    The model list comes from the selected endpoint.
                  </p>
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

              {grantedTools.length > 0 && (
                <div className="grantedtools">
                  <p className="field__label" id="af-granted-tools">
                    Tools these skills grant
                  </p>
                  <div className="chips" role="list" aria-labelledby="af-granted-tools">
                    {grantedTools.map((name) => (
                      <span className="pill" role="listitem" key={name}>
                        {name}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <div className="promptbudget" role="status">
                {budgetMessage && (
                  <p
                    className={`notice notice--${budgetMessage.tone}${budgetStale ? ' notice--stale' : ''}`}
                    aria-busy={budgetStale || undefined}
                  >
                    {budgetMessage.text}
                  </p>
                )}
              </div>
            </div>

            <div className="formsection">
              <h2 className="formsection__title">Parameters</h2>
              <p className="formsection__hint">Control how the agent reasons on each run.</p>
              <div className="field">
                <label className="field__label" htmlFor="af-temperature">
                  Temperature <span className="field__req" aria-hidden="true">*</span>
                </label>
                <input
                  id="af-temperature"
                  className={`input${errors.temperature ? ' input--invalid' : ''}`}
                  type="number"
                  min={0}
                  max={2}
                  step={0.1}
                  value={draft.temperature}
                  onChange={(e) => set('temperature', Number(e.target.value))}
                  placeholder="1.0"
                  aria-invalid={Boolean(errors.temperature)}
                  aria-describedby={errors.temperature ? 'af-temperature-err' : undefined}
                />
                {errors.temperature ? (
                  <p className="field__err" id="af-temperature-err">{errors.temperature}</p>
                ) : (
                  <p className="field__hint">Sampling temperature (0 = deterministic, 2 = very creative).</p>
                )}
              </div>
            </div>
            </details>
              </>
            )}
            {isBootstrap && (
            <div className="formsection">
              <h2 className="formsection__title">Endpoint & model</h2>
              <p className="formsection__hint">
                Every agent runs on an endpoint. New agents start on the Team Lead's endpoint.
              </p>

              <div className="field">
                <label className="field__label" htmlFor="af-endpoint">
                  Endpoint <span className="field__req" aria-hidden="true">*</span>
                </label>
                <select
                  id="af-endpoint"
                  className={`select${errors.endpointId ? ' input--invalid' : ''}`}
                  value={draft.endpointId}
                  onChange={(e) => pickEndpoint(e.target.value)}
                  aria-invalid={Boolean(errors.endpointId)}
                  aria-describedby={errors.endpointId ? 'af-endpoint-err' : 'af-endpoint-hint'}
                >
                  {defaultEndpointId ? (
                    <option value={defaultEndpointId}>Default — Team Lead's endpoint</option>
                  ) : (
                    <option value="">Select an endpoint…</option>
                  )}
                  {endpoints
                    .filter((ep) => ep.id !== defaultEndpointId)
                    .map((ep) => (
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
                      : 'Add a server in Settings → Endpoints.'}
                  </p>
                )}
              </div>

              {draft.endpointId && selectedEndpoint ? (
                <div className="field">
                  <label className="field__label" htmlFor="af-model-name">
                    Model <span className="field__req" aria-hidden="true">*</span>
                  </label>
                  <select
                    id="af-model-name"
                    className={`select${modelError ? ' input--invalid' : ''}`}
                    value={effectiveModelId}
                    onChange={(e) => set('modelId', e.target.value)}
                    disabled={epModels.loading || Boolean(epModels.error) || (epModels.data ?? []).length === 0}
                    aria-invalid={Boolean(modelError)}
                    aria-describedby={modelError ? 'af-model-err' : 'af-model-hint'}
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
                  {modelError ? (
                    <p className="field__err" id="af-model-err">
                      {modelError}
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
                  <label className="field__label" htmlFor="af-model-name">
                    Model <span className="field__req" aria-hidden="true">*</span>
                  </label>
                  <select id="af-model-name" className="select" value="" disabled aria-describedby="af-model-hint">
                    <option value="">Pick an endpoint first…</option>
                  </select>
                  <p className="field__hint" id="af-model-hint">
                    The model list comes from the selected endpoint.
                  </p>
                </div>
              )}
            </div>

            )}

            {submitError && (
              <p className="field__err formpage__error" role="alert">
                {submitError}
              </p>
            )}
          </section>

          <div className="formactions">
            {!noCancel && (
              <button type="button" className="btn" onClick={leave} disabled={saving}>
                Cancel
              </button>
            )}
            <button type="submit" className="btn btn--primary" disabled={saving}>
              {saving && <span className="spinner" aria-hidden="true" />}
              {saving ? 'Saving…' : isEdit ? 'Save changes' : isBootstrap ? 'Create Team Lead' : 'Create agent'}
            </button>
          </div>
        </form>
  )

  const discardDialog = (
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
          <button type="button" className="btn btn--danger" onClick={finish}>
            Discard
          </button>
        </>
      }
    >
      <p className="prose">Your changes to this agent will be lost.</p>
    </Dialog>
  )

  if (compact) {
    return (
      <>
        {form}
        {discardDialog}
      </>
    )
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
                : 'Name it, pick an endpoint and model, and give it the skills it needs.'}
            </p>
          </div>
        </div>

        {form}
        {discardDialog}
      </div>
    </main>
  )
}
