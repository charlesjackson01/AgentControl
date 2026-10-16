import { useState, type FormEvent } from 'react'
import PageShell from '../components/PageShell'
import Dialog from '../components/Dialog'
import { EmptyState, ErrorState, Skeleton } from '../components/States'
import { useTheme, type Theme } from '../hooks/useTheme'
import { useAsync } from '../hooks/useAsync'
import { api, DEFAULT_ENDPOINT_BASE_URL, ENDPOINT_KIND_LABELS, ENDPOINT_STATUS_LABELS, OPENROUTER_DEFAULT_BASE_URL } from '../lib/api'
import type { Endpoint, EndpointInput, EndpointKind } from '../lib/types'
import { DISABLE_THINKING_HINT, disableThinkingPatch } from '../lib/run-reply'
import { PROXY_URL_HINT, proxyUrlPatch, validateProxyUrl } from '../lib/endpoint-proxy'
import UserProfileForm from '../components/UserProfileForm'
import { useProfile } from '../state/profile-context'

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      className={`switch${on ? ' switch--on' : ''}`}
      onClick={() => onChange(!on)}
      role="switch"
      aria-checked={on}
      aria-label={label}
    />
  )
}

const themes: { value: Theme; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
]

const ENDPOINT_STATUS_CLASS: Record<Endpoint['status'], string> = {
  unknown: 'status',
  reachable: 'status status--running',
  unreachable: 'status status--error',
}

function EndpointForm({
  initial,
  saving,
  serverError,
  onSubmit,
}: {
  initial: Endpoint | null
  saving: boolean
  serverError: string | null
  onSubmit: (input: EndpointInput) => void
}) {
  const [name, setName] = useState(initial?.name ?? '')
  const [kind, setKind] = useState<EndpointKind>(initial?.kind ?? 'openai-compatible')
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? DEFAULT_ENDPOINT_BASE_URL)
  // The URL is the user's once typed (or saved, when editing); only an untouched
  // prefill may be swapped when the kind changes.
  const [urlTouched, setUrlTouched] = useState(initial !== null)
  const [defaultModel, setDefaultModel] = useState(initial?.defaultModel ?? '')
  const [contextWindow, setContextWindow] = useState(String(initial?.contextWindow ?? 8192))
  const [apiKey, setApiKey] = useState('')
  const [proxyUrl, setProxyUrl] = useState(initial?.proxyUrl ?? '')
  const [disableThinking, setDisableThinking] = useState(Boolean(initial?.disableThinking))
  const [errors, setErrors] = useState<{ name?: string; baseUrl?: string; defaultModel?: string; contextWindow?: string; apiKey?: string; proxyUrl?: string }>({})

  const pickKind = (next: EndpointKind) => {
    setKind(next)
    // Swap to the new kind's prefill unless the URL is the user's; never clobber
    // a typed or saved URL (an emptied field gets the prefill again).
    if (urlTouched && baseUrl.trim() !== '') return
    setBaseUrl(next === 'openrouter' ? OPENROUTER_DEFAULT_BASE_URL : DEFAULT_ENDPOINT_BASE_URL)
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const next: typeof errors = {}
    if (!name.trim()) next.name = 'Give the endpoint a name.'
    const resolvedUrl = baseUrl.trim() === '' && kind === 'openrouter' ? OPENROUTER_DEFAULT_BASE_URL : baseUrl.trim()
    if (!resolvedUrl) next.baseUrl = `Set the server origin, e.g. ${DEFAULT_ENDPOINT_BASE_URL}.`
    else {
      try {
        const url = new URL(resolvedUrl.replace(/\/+$/, ''))
        if (url.protocol !== 'http:' && url.protocol !== 'https:') next.baseUrl = 'Must start with http:// or https://.'
      } catch {
        next.baseUrl = 'Must be a valid URL, e.g. http://192.168.1.20:8000.'
      }
    }
    if (!defaultModel.trim()) next.defaultModel = 'Set the default model id from GET /v1/models.'
    const ctx = Number(contextWindow)
    if (!Number.isFinite(ctx) || ctx <= 0) next.contextWindow = 'Must be a positive token count.'
    if (kind === 'openrouter' && !apiKey && !initial?.apiKeySet) {
      next.apiKey = 'OpenRouter endpoints require an API key.'
    }
    const proxyErr = validateProxyUrl(proxyUrl)
    if (proxyErr) next.proxyUrl = proxyErr
    setErrors(next)
    if (Object.keys(next).length > 0) return
    onSubmit({
      kind,
      name: name.trim(),
      baseUrl: baseUrl.trim(),
      defaultModel: defaultModel.trim(),
      contextWindow: Math.floor(ctx),
      // Omit when blank so a stored key survives edits; the key itself is never read back.
      ...(apiKey ? { apiKey } : {}),
      ...proxyUrlPatch(proxyUrl, initial?.proxyUrl, Boolean(initial)),
      ...disableThinkingPatch(disableThinking, initial?.disableThinking, Boolean(initial)),
    })
  }

  return (
    <form className="form" onSubmit={submit} noValidate>
      <div className="field">
        <label className="field__label" htmlFor="ep-name">
          Name
        </label>
        <input id="ep-name" className={`input${errors.name ? ' input--invalid' : ''}`} value={name} onChange={(e) => setName(e.target.value)} placeholder="Local llama.cpp" />
        {errors.name ? <p className="field__err">{errors.name}</p> : <p className="field__hint">Shown in the agent form picker.</p>}
      </div>
      <div className="field">
        <label className="field__label" htmlFor="ep-kind">
          Kind
        </label>
        <select id="ep-kind" className="select" value={kind} onChange={(e) => pickKind(e.target.value as EndpointKind)}>
          <option value="openai-compatible">{ENDPOINT_KIND_LABELS['openai-compatible']} — llama.cpp / vLLM</option>
          <option value="openrouter">{ENDPOINT_KIND_LABELS.openrouter}</option>
        </select>
        <p className="field__hint">Both speak OpenAI-compatible /v1 chat. Keys stay server-side.</p>
      </div>
      <div className="field">
        <label className="field__label" htmlFor="ep-url">
          Base URL
        </label>
        <input id="ep-url" className={`input${errors.baseUrl ? ' input--invalid' : ''}`} value={baseUrl} onChange={(e) => { setBaseUrl(e.target.value); setUrlTouched(true) }} placeholder={kind === 'openrouter' ? OPENROUTER_DEFAULT_BASE_URL : DEFAULT_ENDPOINT_BASE_URL} inputMode="url" />
        {errors.baseUrl ? <p className="field__err">{errors.baseUrl}</p> : <p className="field__hint">Origin only — the backend calls {(baseUrl.trim() || (kind === 'openrouter' ? OPENROUTER_DEFAULT_BASE_URL : '…')).replace(/\/+$/, '')}/v1/models server-side.</p>}
      </div>
      <div className="field">
        <label className="field__label" htmlFor="ep-key">
          API key{kind === 'openrouter' ? <span className="field__req" aria-hidden="true"> *</span> : ''}
        </label>
        <input id="ep-key" className={`input${errors.apiKey ? ' input--invalid' : ''}`} value={apiKey} onChange={(e) => setApiKey(e.target.value)} type="password" autoComplete="new-password" placeholder={initial?.apiKeySet ? '•••••• (stored — blank keeps it)' : 'sk-…'} />
        {errors.apiKey ? <p className="field__err">{errors.apiKey}</p> : <p className="field__hint">{initial?.apiKeySet ? 'A key is stored server-side. Leave blank to keep it.' : kind === 'openrouter' ? 'Required. Stored server-side, never shown again.' : 'Optional bearer for --api-key servers. Stored server-side.'}</p>}
      </div>
      <div className="field">
        <label className="field__label" htmlFor="ep-proxy">Proxy URL</label>
        <input id="ep-proxy" className={`input${errors.proxyUrl ? ' input--invalid' : ''}`} value={proxyUrl} onChange={(e) => { setProxyUrl(e.target.value); setErrors((er) => ({ ...er, proxyUrl: undefined })) }} placeholder="http://localhost:1055" inputMode="url" aria-invalid={Boolean(errors.proxyUrl)} />
        {errors.proxyUrl ? <p className="field__err">{errors.proxyUrl}</p> : <p className="field__hint">{PROXY_URL_HINT}</p>}
      </div>
      <div className="field">
        <label className="field__check" htmlFor="ep-disable-thinking">
          <input id="ep-disable-thinking" type="checkbox" checked={disableThinking} onChange={(e) => setDisableThinking(e.target.checked)} />
          <span>Disable thinking</span>
        </label>
        <p className="field__hint">{DISABLE_THINKING_HINT}</p>
      </div>
      <div className="field">
        <label className="field__label" htmlFor="ep-model">
          Default model
        </label>
        <input id="ep-model" className={`input${errors.defaultModel ? ' input--invalid' : ''}`} value={defaultModel} onChange={(e) => setDefaultModel(e.target.value)} placeholder="llama-3-8b" />
        {errors.defaultModel ? <p className="field__err">{errors.defaultModel}</p> : <p className="field__hint">Prefilled on new agents; each agent can override it.</p>}
      </div>
      <div className="field">
        <label className="field__label" htmlFor="ep-ctx">
          Context window
        </label>
        <input id="ep-ctx" className={`input${errors.contextWindow ? ' input--invalid' : ''}`} value={contextWindow} onChange={(e) => setContextWindow(e.target.value)} inputMode="numeric" type="number" min={1} />
        {errors.contextWindow && <p className="field__err">{errors.contextWindow}</p>}
      </div>
      {serverError && (
        <p className="field__err" role="alert">
          {serverError}
        </p>
      )}
      <div className="formactions">
        <button type="submit" className="btn btn--primary" disabled={saving}>
          {saving && <span className="spinner" aria-hidden="true" />}
          {saving ? 'Saving…' : initial ? 'Save changes' : 'Add endpoint'}
        </button>
      </div>
    </form>
  )
}

function EndpointsSection() {
  const endpoints = useAsync(api.listEndpoints, [])
  const agents = useAsync(api.listAgents, [])
  const [dialog, setDialog] = useState<{ mode: 'add' } | { mode: 'edit'; endpoint: Endpoint } | { mode: 'delete'; endpoint: Endpoint } | null>(null)
  const [saving, setSaving] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [testNote, setTestNote] = useState<Record<string, string>>({})
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ type: 'success'; text: string } | null>(null)

  const save = async (input: EndpointInput) => {
    setSaving(true)
    setServerError(null)
    try {
      if (dialog?.mode === 'edit') await api.updateEndpoint(dialog.endpoint.id, input)
      else await api.createEndpoint(input)
      setDialog(null)
      await endpoints.reload()
    } catch (err) {
      setServerError(err instanceof Error ? err.message : 'Could not save the endpoint.')
    } finally {
      setSaving(false)
    }
  }

  const test = async (id: string) => {
    setTestingId(id)
    try {
      const res = await api.testEndpoint(id)
      setTestNote((n) => ({ ...n, [id]: res.ok ? `Reachable · ${res.latencyMs}ms · [${res.models.join(', ')}]` : 'Unreachable' }))
      await endpoints.reload()
    } catch (err) {
      setTestNote((n) => ({ ...n, [id]: err instanceof Error ? err.message : 'Test failed' }))
    } finally {
      setTestingId(null)
    }
  }

  const remove = async (ep: Endpoint) => {
    setDeletingId(ep.id)
    setServerError(null)
    try {
      const result = await api.deleteEndpoint(ep.id)
      setDialog(null)
      const movedCount = result.reassignedAgents?.length ?? 0
      if (movedCount > 0) {
        setNotice({
          type: 'success',
          text: `${movedCount} agent${movedCount === 1 ? '' : 's'} moved to the Team Lead's endpoint.`,
        })
        setTimeout(() => setNotice(null), 5000)
      }
      await endpoints.reload()
      await agents.reload()
    } catch (err) {
      setServerError(err instanceof Error ? err.message : 'Could not delete the endpoint.')
    } finally {
      setDeletingId(null)
    }
  }

  const affected = (ep: Endpoint) => {
    return (agents.data ?? []).filter((a) => a.endpointId === ep.id)
  }
  // The BE refuses (409) to delete the Team Lead's own endpoint; say so up front.
  const isTeamLeadEndpoint = (ep: Endpoint) =>
    (agents.data ?? []).some((a) => a.isPrimary && a.endpointId === ep.id)

  return (
    <section className="section">
      <div className="section__head">
        <h2 className="section__title">Endpoints</h2>
        <div style={{ marginLeft: 'auto' }}>
          <button type="button" className="btn" onClick={() => { setServerError(null); setDialog({ mode: 'add' }) }}>
            New endpoint
          </button>
        </div>
      </div>
      <p className="field__hint" style={{ marginBottom: 10 }}>
        OpenAI-compatible servers (llama.cpp <code>--server</code>, vLLM) and OpenRouter. Keys stay server-side; the browser never calls these URLs directly.
      </p>

      {notice && (
        <div className="card" role="status" style={{ marginBottom: 12 }}>
          <p className="run__meta" style={{ margin: 0, marginBottom: 2 }}>{notice.text}</p>
        </div>
      )}

      {endpoints.loading ? (
        <div className="rows">
          <div className="row"><Skeleton width="40%" height={12} /></div>
        </div>
      ) : endpoints.error ? (
        <ErrorState error={endpoints.error} onRetry={endpoints.reload} />
      ) : (endpoints.data ?? []).length === 0 ? (
        <EmptyState
          icon={<span aria-hidden="true">⌁</span>}
          title="No custom endpoints"
          text="Add your llama.cpp / vLLM server or OpenRouter account to run agents on it."
          actions={<button type="button" className="btn btn--primary" onClick={() => setDialog({ mode: 'add' })}>Add endpoint</button>}
        />
      ) : (
        <div className="rows">
          {(endpoints.data ?? []).map((ep) => (
            <div className="row" key={ep.id}>
              <div className="row__text" style={{ minWidth: 0 }}>
                <p className="row__label">{ep.name}</p>
                <p className="row__hint meta__v--mono">{ep.baseUrl} · {ep.defaultModel} · {ep.contextWindow.toLocaleString()} ctx · {ep.apiKeySet ? 'key set' : 'no key'}{ep.proxyUrl ? ` · via ${ep.proxyUrl}` : ''}{ep.disableThinking ? ' · thinking off' : ''}</p>
                {testNote[ep.id] && <p className="field__hint">{testNote[ep.id]}</p>}
              </div>
              <div className="row__control" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                <span className="pill">{ENDPOINT_KIND_LABELS[ep.kind]}</span>
                <span className={ENDPOINT_STATUS_CLASS[ep.status]}>{ENDPOINT_STATUS_LABELS[ep.status]}</span>
                <button type="button" className="btn" onClick={() => void test(ep.id)} disabled={testingId === ep.id}>
                  {testingId === ep.id ? 'Testing…' : 'Test'}
                </button>
                <button type="button" className="btn" onClick={() => { setServerError(null); setDialog({ mode: 'edit', endpoint: ep }) }}>
                  Edit
                </button>
                <button type="button" className="btn btn--danger" onClick={() => { setServerError(null); setDialog({ mode: 'delete', endpoint: ep }) }} disabled={deletingId === ep.id}>
                  {deletingId === ep.id ? 'Removing…' : 'Delete'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {serverError && !dialog && (
        <p className="field__err" role="alert" style={{ marginTop: 10 }}>
          {serverError}
        </p>
      )}

      <Dialog
        open={dialog !== null}
        title={dialog?.mode === 'edit' ? `Edit ${dialog.endpoint.name}` : dialog?.mode === 'delete' ? `Delete ${dialog.endpoint.name}?` : 'New endpoint'}
        subtitle={dialog?.mode === 'delete' ? (isTeamLeadEndpoint(dialog.endpoint) ? 'The Team Lead\u2019s endpoint can\u2019t be deleted.' : 'Agents using this endpoint move to the Team Lead\u2019s endpoint.') : 'OpenAI-compatible chat server (llama.cpp --server, vLLM) or OpenRouter.'}
        onClose={() => { if (!saving && !deletingId) { setDialog(null); setServerError(null) } }}
      >
        {dialog?.mode === 'delete' ? (
          <>
            {isTeamLeadEndpoint(dialog.endpoint) ? (
              <p className="field__err" style={{ margin: 0 }}>
                This is the Team Lead's endpoint, the default for every agent. Move the Team Lead to another endpoint before deleting it.
              </p>
            ) : affected(dialog.endpoint).length === 0 ? (
              <p className="prose">No agent references this endpoint, so deleting it cannot affect anyone.</p>
            ) : (
              <>
                <p className="field__err" style={{ margin: 0, marginBottom: 10 }}>This endpoint is used by {affected(dialog.endpoint).length} agent{affected(dialog.endpoint).length === 1 ? '' : 's'}:</p>
                <ul style={{ margin: 0, paddingLeft: 20 }}>
                  {affected(dialog.endpoint).map((a) => <li key={a.id}>{a.name}</li>)}
                </ul>
                <p className="field__hint">These agents move to the Team Lead's endpoint and keep working. Deletion cannot be undone.</p>
              </>
            )}
            {serverError && (
              <p className="field__err" role="alert" style={{ marginTop: 10 }}>
                {serverError}
              </p>
            )}
            <div className="dialog__foot">
              <button type="button" className="btn" onClick={() => setDialog(null)} disabled={deletingId === dialog.endpoint.id}>
                Cancel
              </button>
              <button type="button" className="btn btn--danger" onClick={() => void remove(dialog.endpoint)} disabled={deletingId === dialog.endpoint.id || isTeamLeadEndpoint(dialog.endpoint)}>
                {deletingId === dialog.endpoint.id ? 'Removing…' : 'Delete endpoint'}
              </button>
            </div>
          </>
        ) : (
          <EndpointForm initial={dialog?.mode === 'edit' ? dialog.endpoint : null} saving={saving} serverError={serverError} onSubmit={(input) => void save(input)} />
        )}
      </Dialog>
    </section>
   )
 }

 function ProfileSection() {
  const { profile, setProfile } = useProfile()
  return (
    <section className="section" id="profile">
      <div className="section__head">
        <h2 className="section__title">Your profile</h2>
      </div>
      {profile === undefined ? (
        <p className="field__hint">Loading…</p>
      ) : profile === null ? (
        <p className="field__hint">This server does not support profiles yet.</p>
      ) : (
        <div className="formcard">
          <div className="formsection">
            <UserProfileForm profile={profile} onSaved={setProfile} />
          </div>
        </div>
      )}
    </section>
  )
}

export default function Settings() {
  const { theme, setTheme } = useTheme()
  const [autoRun, setAutoRun] = useState(true)
  const [notify, setNotify] = useState(true)
  const [telemetry, setTelemetry] = useState(false)

  return (
    <PageShell eyebrow="Workspace" title="Settings" subtitle="Workspace defaults, appearance, and runtime behavior.">
      <ProfileSection />
      <EndpointsSection />

      <section className="section">
        <div className="section__head">
          <h2 className="section__title">Appearance</h2>
        </div>
        <div className="rows">
          <div className="row">
            <div className="row__text">
              <p className="row__label">Theme</p>
              <p className="row__hint">System follows your operating system setting.</p>
            </div>
            <div className="row__control">
              <div className="segmented" role="group" aria-label="Theme">
                {themes.map((t) => (
                  <button
                    key={t.value}
                    type="button"
                    className={`segmented__opt${theme === t.value ? ' segmented__opt--on' : ''}`}
                    onClick={() => setTheme(t.value)}
                    aria-pressed={theme === t.value}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="row">
            <div className="row__text">
              <p className="row__label">Reduce motion</p>
              <p className="row__hint">Respects your system accessibility preference automatically.</p>
            </div>
            <div className="row__control">
              <span className="pill">Automatic</span>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section__head">
          <h2 className="section__title">Runtime</h2>
        </div>
        <div className="rows">
          <div className="row">
            <div className="row__text">
              <p className="row__label">Auto-run scheduled agents</p>
              <p className="row__hint">Start cron-triggered agents without manual approval.</p>
            </div>
            <div className="row__control">
              <Toggle on={autoRun} onChange={setAutoRun} label="Auto-run scheduled agents" />
            </div>
          </div>
          <div className="row">
            <div className="row__text">
              <p className="row__label">Run notifications</p>
              <p className="row__hint">Notify when an agent finishes, fails, or needs input.</p>
            </div>
            <div className="row__control">
              <Toggle on={notify} onChange={setNotify} label="Run notifications" />
            </div>
          </div>
          <div className="row">
            <div className="row__text">
              <p className="row__label">Share anonymous usage data</p>
              <p className="row__hint">Helps prioritize fixes. Never includes prompts or outputs.</p>
            </div>
            <div className="row__control">
              <Toggle on={telemetry} onChange={setTelemetry} label="Share anonymous usage data" />
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section__head">
          <h2 className="section__title">Danger zone</h2>
        </div>
        <div className="rows">
          <div className="row">
            <div className="row__text">
              <p className="row__label">Reset workspace</p>
              <p className="row__hint">Removes all agents, projects, and skills. This cannot be undone.</p>
            </div>
            <div className="row__control">
              <button type="button" className="btn btn--danger">
                Reset…
              </button>
            </div>
          </div>
        </div>
      </section>
    </PageShell>
  )
}
