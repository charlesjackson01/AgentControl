/* FE-5: the /new bot draft card (mockup 02c, gap states S1–S9). Pure: no React or DOM,
   so tests/new-bot.test.mjs can import it. The requests take a `request` function
   (lib/api.ts `request` in the app, a mocked fetch in tests). */
import { MAX_AGENT_RULE_CHARS, MAX_AGENT_RULES, type Endpoint, type InternetPolicy } from './types.ts'

/** BE-8: POST /api/agents/draft rejects a prompt over this many characters (raw, before trimming). */
export const MAX_DRAFT_PROMPT_CHARS = 2000
/** S1 → S2: after this long the bubble reads "Still writing the draft…". */
export const LONG_WAIT_MS = 30_000
export const MAX_NAME_CHARS = 60
export const MAX_ROLE_CHARS = 80
export const MAX_DESCRIPTION_CHARS = 300
/** Picker emoji for a blank card (gap S4). */
export const BLANK_AVATAR_CHOICES = ['🤖', '✨', '📋']

export type DraftWarningCode = 'no_primary' | 'upstream' | 'invalid_output' | 'cancelled'

/** GET /api/agents/defaults (BE-8b). */
export type SkillSource = { sourceId: string; label: string; count: number; skillIds: string[] }
export type AgentDefaults = { skills: SkillSource[]; internetPolicy: InternetPolicy; endpointId: string; modelId: string }

/** POST /api/agents/draft → 200 (a fallback adds warning + warningCode, with avatarEmoji '' and avatarChoices []). */
export type DraftResponse = {
  name: string
  role: string
  description: string
  avatarEmoji: string
  avatarChoices: string[]
  rules: string[]
  warning?: string
  warningCode?: DraftWarningCode
}

/** What the card shows (and edits). `previous` for a reply is built from this. */
export type CardDraft = {
  name: string
  role: string
  description: string
  avatarEmoji: string
  avatarChoices: string[]
  rules: string[]
  endpointId: string
  modelId: string
  internetPolicy: InternetPolicy
  /** sourceIds whose chips are on. */
  sourcesOn: string[]
  /** FE-P2-7: "Browser for scripts (Playwright)". Off by default (mockup 15). */
  browser: boolean
}

export type PreviousDraft = Partial<Pick<CardDraft, 'name' | 'role' | 'description' | 'avatarEmoji' | 'avatarChoices' | 'rules'>>
export type DraftRequest = { prompt: string; previous?: PreviousDraft }

export type Phase =
  | { kind: 'ask' } // S6
  | { kind: 'drafting'; startedAt: number } // S1, S2 after LONG_WAIT_MS
  | { kind: 'cancelled' } // S3
  | { kind: 'failed'; message: string } // S5
  | { kind: 'card'; warning?: string; creating?: boolean; error?: string } // finished card, S4, S8, S9

export type RequestFn = <T>(path: string, init?: RequestInit) => Promise<T>

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

/** Tolerant read of /api/agents/defaults: a missing label is the sourceId, missing skillIds are []. */
export function normalizeDefaults(raw: unknown): AgentDefaults {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const skills = (Array.isArray(o.skills) ? o.skills : [])
    .filter((s): s is Record<string, unknown> => Boolean(s) && typeof s === 'object' && typeof (s as Record<string, unknown>).sourceId === 'string')
    .map((s) => {
      const skillIds = strings(s.skillIds)
      const sourceId = s.sourceId as string
      return {
        sourceId,
        label: str(s.label).trim() || sourceId,
        count: typeof s.count === 'number' ? s.count : skillIds.length,
        skillIds,
      }
    })
  const policy = o.internetPolicy
  return {
    skills,
    internetPolicy: policy === 'always' || policy === 'never' ? policy : 'ask',
    endpointId: str(o.endpointId),
    modelId: str(o.modelId),
  }
}

/** Tolerant read of a draft: missing avatarChoices fall back to [avatarEmoji]. */
export function normalizeDraft(raw: unknown): DraftResponse {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const avatarEmoji = str(o.avatarEmoji)
  let avatarChoices = [...new Set(strings(o.avatarChoices).filter(Boolean))]
  if (avatarChoices.length === 0 && avatarEmoji) avatarChoices = [avatarEmoji]
  const code = o.warningCode
  const out: DraftResponse = {
    name: str(o.name),
    role: str(o.role),
    description: str(o.description),
    avatarEmoji: avatarEmoji || avatarChoices[0] || '',
    avatarChoices,
    rules: strings(o.rules),
  }
  if (typeof o.warning === 'string' && o.warning) out.warning = o.warning
  if (code === 'no_primary' || code === 'upstream' || code === 'invalid_output' || code === 'cancelled') out.warningCode = code
  return out
}

/* ---- composer ---- */

/**
 * `/new <text>` → the raw text after "/new" and its one separating space (not trimmed:
 * the BE counts the raw string). `/new` alone → ''. Anything else → null.
 */
export function newCommandPrompt(text: string): string | null {
  const m = /^\/new(?=\s|$)/i.exec(text)
  if (!m) return null
  return text.slice(m[0].length).replace(/^\s/, '')
}

/** S7 hint, or null when the prompt fits. Counts the raw length. */
export function tooLongNotice(prompt: string): string | null {
  if (prompt.length <= MAX_DRAFT_PROMPT_CHARS) return null
  return `Describe the bot in ${MAX_DRAFT_PROMPT_CHARS.toLocaleString('en-US')} characters or fewer (${prompt.length.toLocaleString('en-US')} now).`
}

export function placeholderFor(phase: Phase | null, botName: string): string {
  if (phase?.kind === 'ask') return 'Describe the new bot…'
  if (phase?.kind === 'drafting') return 'Primary is writing the draft…'
  if (phase?.kind === 'card') return 'Reply to change the draft, e.g. "call it Wanderer"…'
  return `Message ${botName}…`
}

/** S1, S8 and the drafting part of S2 disable the composer. */
export function composerLocked(phase: Phase | null): boolean {
  return phase?.kind === 'drafting' || (phase?.kind === 'card' && phase.creating === true)
}

/* ---- S1 / S2 status ---- */

export function elapsedLabel(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** The spinner bubble's two lines. Never states the timeout. */
export function draftingStatus(elapsedMs: number): { title: string; sub: string; long: boolean } {
  const t = elapsedLabel(elapsedMs)
  if (elapsedMs >= LONG_WAIT_MS) {
    return { title: 'Still writing the draft…', sub: `${t} · the model is slow right now. You can keep waiting, cancel, or fill it in yourself.`, long: true }
  }
  return { title: 'Writing a draft…', sub: `${t} · usually about 10 seconds, slow models can take a few minutes`, long: false }
}

/* ---- card ---- */

export function blankCard(defaults: AgentDefaults | null): CardDraft {
  return {
    name: '',
    role: '',
    description: '',
    avatarEmoji: '',
    avatarChoices: [],
    rules: [],
    endpointId: defaults?.endpointId ?? '',
    modelId: defaults?.modelId ?? '',
    internetPolicy: defaults?.internetPolicy ?? 'ask',
    sourcesOn: (defaults?.skills ?? []).map((s) => s.sourceId),
    browser: false,
  }
}

/**
 * A draft response onto the card: the draft's fields replace the card's; model, internet, skills and browser stay.
 * M2 ruling: the model's draft can never pre-set browser:true; only the user's toggle does (a new card starts off).
 */
export function cardFromDraft(current: CardDraft | null, draft: DraftResponse, defaults: AgentDefaults | null): CardDraft {
  const base = current ?? blankCard(defaults)
  if (draft.warning) return { ...blankCard(defaults), endpointId: base.endpointId, modelId: base.modelId, internetPolicy: base.internetPolicy, sourcesOn: base.sourcesOn, browser: base.browser }
  return {
    ...base,
    name: draft.name.slice(0, MAX_NAME_CHARS),
    role: draft.role.slice(0, MAX_ROLE_CHARS),
    description: draft.description.slice(0, MAX_DESCRIPTION_CHARS),
    avatarEmoji: draft.avatarEmoji,
    avatarChoices: draft.avatarChoices,
    rules: draft.rules.slice(0, MAX_AGENT_RULES),
  }
}

/**
 * A card with no model yet takes the defaults' model, internet and chips (a card built before
 * GET /api/agents/defaults landed). A card that has a model is returned as is.
 */
export function withMissingDefaults(card: CardDraft, defaults: AgentDefaults | null): CardDraft {
  if (!defaults || card.endpointId) return card
  return { ...card, endpointId: defaults.endpointId, modelId: defaults.modelId, internetPolicy: defaults.internetPolicy, sourcesOn: defaults.skills.map((s) => s.sourceId) }
}

/** What a draft response becomes: the card (S4 when it carries a warning), or S3 for a server-side cancel. */
export function phaseAfterDraft(draft: DraftResponse): Phase {
  if (draft.warningCode === 'cancelled') return { kind: 'cancelled' }
  return draft.warning ? { kind: 'card', warning: draft.warning } : { kind: 'card' }
}

/** Retry makes no sense without a Primary that can write drafts. */
export function canRetry(code: DraftWarningCode | undefined): boolean {
  return code !== 'no_primary'
}

/** The small picker: the choices other than the one shown big (blank card: the S4 placeholders). */
export function pickerChoices(card: Pick<CardDraft, 'avatarEmoji' | 'avatarChoices'>): string[] {
  if (card.avatarChoices.length === 0 && !card.avatarEmoji) return BLANK_AVATAR_CHOICES
  return card.avatarChoices.filter((e) => e !== card.avatarEmoji).slice(0, 3)
}

const cleanRules = (rules: readonly string[]): string[] =>
  rules.map((r) => r.trim()).filter(Boolean).slice(0, MAX_AGENT_RULES).map((r) => r.slice(0, MAX_AGENT_RULE_CHARS))

/** `previous` for "Reply to change the draft": the card as shown, inside the BE's limits. */
export function previousOf(card: CardDraft): PreviousDraft {
  const out: PreviousDraft = {
    name: card.name.slice(0, MAX_NAME_CHARS),
    role: card.role.slice(0, MAX_ROLE_CHARS),
    description: card.description.slice(0, MAX_DESCRIPTION_CHARS),
    rules: cleanRules(card.rules),
  }
  if (card.avatarEmoji) out.avatarEmoji = card.avatarEmoji.slice(0, 16)
  if (card.avatarChoices.length) out.avatarChoices = card.avatarChoices.slice(0, 8).map((e) => e.slice(0, 16))
  return out
}

export function draftRequestBody(prompt: string, previous?: PreviousDraft): DraftRequest {
  return previous ? { prompt, previous } : { prompt }
}

export function startingSkillsTotal(defaults: AgentDefaults | null): number {
  return (defaults?.skills ?? []).reduce((n, s) => n + s.count, 0)
}

export function canCreate(card: CardDraft): boolean {
  return card.name.trim().length > 0
}

export function nameError(card: CardDraft, touched: boolean): string | null {
  return touched && !card.name.trim() ? 'Give the bot a name.' : null
}

export type CreateBody = {
  name: string
  role: string
  description: string
  endpointId: string
  modelId: string
  rules: string[]
  internetPolicy: InternetPolicy
  avatar?: { kind: 'emoji'; value: string }
  skillIds?: string[]
  /**
   * FE-P2-7 (M2 contract 16160ae as ruled in CONTRACT_REVIEW_16160ae, BE-P2-15): AgentInput.browser, create only.
   * true turns the browser on for the new bot (download/rebuild start); 409 reason `low_disk` creates nothing and
   * its `message` shows inline (S9). Sent only when the user switched it on: the model's /new draft never sets it
   * (normalizeDraft drops any browser field). Master ignores the key (the bot starts with it off).
   */
  browser?: true
}

/**
 * POST /api/agents body. No `instructions` (optional, BE-8b) and no `temperature` (blank = endpoint default).
 * Every chip on: skillIds left out, so the BE applies its defaults; otherwise the on sources' skills.
 */
export function createBody(card: CardDraft, defaults: AgentDefaults | null): CreateBody {
  const body: CreateBody = {
    name: card.name.trim(),
    role: card.role.trim(),
    description: card.description.trim(),
    endpointId: card.endpointId,
    modelId: card.modelId,
    rules: cleanRules(card.rules),
    internetPolicy: card.internetPolicy,
  }
  if (card.avatarEmoji) body.avatar = { kind: 'emoji', value: card.avatarEmoji }
  const sources = defaults?.skills ?? []
  if (sources.some((s) => !card.sourcesOn.includes(s.sourceId))) {
    body.skillIds = [...new Set(sources.filter((s) => card.sourcesOn.includes(s.sourceId)).flatMap((s) => s.skillIds))]
  }
  if (card.browser) body.browser = true
  return body
}

/** Model select: one option per endpoint, "Endpoint · model" (the defaults' model on Primary's endpoint). */
export function modelOptions(endpoints: readonly Pick<Endpoint, 'id' | 'name' | 'defaultModel'>[], defaults: AgentDefaults | null): { endpointId: string; modelId: string; label: string }[] {
  return endpoints.map((ep) => {
    const modelId = defaults && ep.id === defaults.endpointId && defaults.modelId ? defaults.modelId : ep.defaultModel
    return { endpointId: ep.id, modelId, label: `${ep.name} · ${modelId}` }
  })
}

export function folderLabel(slug: string | null): string {
  return slug ? `bots/${slug}/` : ''
}

/* ---- FE-P2-7: browser for scripts ---- */

/** Measured `botvm-browser` is 1343 MB (M2 plan, open question 8). */
export const BROWSER_DOWNLOAD_SIZE = 'about 1.3 GB'

/** The row's sub-line. Off is mockup 15's copy; On has no mockup (GAP-P2-7a). */
export function browserCopy(card: Pick<CardDraft, 'name' | 'browser'>): string {
  const name = card.name.trim()
  if (card.browser) {
    return `On. Chromium downloads once when ${name || 'the bot'} is created (${BROWSER_DOWNLOAD_SIZE}, shared by all bots). Web pages still follow the Internet rule.`
  }
  return `Off. ${name || 'The bot'} asks in chat if a script needs a browser. Turning it on downloads Chromium once (${BROWSER_DOWNLOAD_SIZE}, shared by all bots).`
}

/* ---- errors ---- */

const statusOf = (err: unknown): number | undefined => {
  const s = (err as { status?: unknown } | null)?.status
  return typeof s === 'number' ? s : undefined
}

export function isAbort(err: unknown): boolean {
  return (err as { name?: unknown } | null)?.name === 'AbortError'
}

export const DRAFT_NETWORK_ERROR = "Couldn't reach AgentControl to write the draft. Check that the server is running, then try again."

/** S5 text: fetch rejected, non-JSON or 5xx → the gap copy; a 4xx → the BE's `message`. */
export function draftFailureText(err: unknown): string {
  const status = statusOf(err)
  if (status !== undefined && status >= 400 && status < 500 && err instanceof Error && err.message) return err.message
  return DRAFT_NETWORK_ERROR
}

const lowerFirst = (s: string) => (s ? s[0].toLowerCase() + s.slice(1) : s)

/** S9 text: "Couldn’t create Trip Planner: the setting could not be saved. Please retry." */
export function createFailureText(name: string, err: unknown): string {
  const raw = err instanceof Error ? err.message : ''
  const msg = !raw || raw === 'Failed to fetch' || raw === 'fetch failed' ? 'could not reach AgentControl. Check that the server is running.' : raw
  return `Couldn\u2019t create ${name.trim() || 'the bot'}: ${lowerFirst(msg)}`
}

/* ---- requests ---- */

export function newBotApi(request: RequestFn) {
  return {
    async defaults(): Promise<AgentDefaults> {
      return normalizeDefaults(await request<unknown>('/api/agents/defaults'))
    },
    async draft(body: DraftRequest, signal?: AbortSignal): Promise<DraftResponse> {
      return normalizeDraft(await request<unknown>('/api/agents/draft', { method: 'POST', body: JSON.stringify(body), ...(signal ? { signal } : {}) }))
    },
    /** Never called with a blank name (the BE answers 400). */
    async slugPreview(name: string, signal?: AbortSignal): Promise<string | null> {
      if (!name.trim()) return null
      const res = await request<{ slug?: unknown }>(`/api/agents/slug-preview?name=${encodeURIComponent(name)}`, signal ? { signal } : undefined)
      return typeof res?.slug === 'string' && res.slug ? res.slug : null
    },
    async create<T = { id: string; name: string }>(body: CreateBody): Promise<T> {
      return request<T>('/api/agents', { method: 'POST', body: JSON.stringify(body) })
    },
  }
}

/** "Open full settings": the card for the full New bot form (AgentProfile `prefill`). */
export function profilePrefill(card: CardDraft, defaults: AgentDefaults | null): {
  name: string; role: string; description: string; endpointId: string; modelId: string; rules: string[]
  internetPolicy: InternetPolicy; avatarEmoji?: string; skillIds?: string[]
} {
  const body = createBody(card, defaults)
  const out: ReturnType<typeof profilePrefill> = {
    name: card.name, role: card.role, description: card.description, endpointId: card.endpointId, modelId: card.modelId,
    rules: body.rules, internetPolicy: card.internetPolicy,
  }
  if (card.avatarEmoji) out.avatarEmoji = card.avatarEmoji
  if (body.skillIds) out.skillIds = body.skillIds
  return out
}

/* ---- routing: "＋ New bot" / palette /new open Primary's chat with this router state ---- */

export type NewBotNav = { prompt: string; nonce: string }
let navSeq = 0
export function newBotNavState(prompt: string): NewBotNav {
  navSeq += 1
  return { prompt, nonce: `${Date.now()}-${navSeq}` }
}
/** `location.state.newBot`, if it is one. */
export function readNewBotNav(state: unknown): NewBotNav | null {
  const nb = (state as { newBot?: unknown } | null)?.newBot as Partial<NewBotNav> | undefined
  return nb && typeof nb.prompt === 'string' && typeof nb.nonce === 'string' ? { prompt: nb.prompt, nonce: nb.nonce } : null
}
