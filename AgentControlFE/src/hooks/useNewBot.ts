import { useEffect, useRef, useState } from 'react'
import { api, request } from '../lib/api'
import { avatarFileError } from '../lib/avatar-draft'
import type { Endpoint } from '../lib/types'
import {
  blankCard,
  cardFromDraft,
  draftFailureText,
  draftRequestBody,
  isAbort,
  newBotApi,
  phaseAfterDraft,
  previousOf,
  type AgentDefaults,
  type CardDraft,
  type DraftRequest,
  type DraftWarningCode,
  type Phase,
} from '../lib/new-bot'

const nb = newBotApi(request)
const SLUG_DEBOUNCE_MS = 300

export type NewBotSession = {
  /** The user bubble for the current turn ("/new …", or the reply). */
  userText: string
  userTs: string
  /** The request Try again / Retry repeats; null for S6 and hand-filled cards. */
  request: DraftRequest | null
  phase: Phase
  /** The card (kept across replies, Cancel and errors so Fill it in by hand keeps it). */
  card: CardDraft | null
  warningCode?: DraftWarningCode
  /** Bumped per turn so the thread re-anchors to the bottom. */
  turn: number
}

type Extras = {
  defaults: AgentDefaults | null
  endpoints: Endpoint[]
  catalogCount: number | null
}

/**
 * FE-5: the /new flow in Primary's DM. Local only (Phase 1 never saves the draft card).
 * The composer drives it through start / answer / reply; the thread renders <NewBotTurn>.
 */
export function useNewBot(conversationId: string) {
  const [session, setSession] = useState<NewBotSession | null>(null)
  const [extras, setExtras] = useState<Extras>({ defaults: null, endpoints: [], catalogCount: null })
  const [file, setFile] = useState<{ file: File; url: string } | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [nameTouched, setNameTouched] = useState(false)
  const [slug, setSlug] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const abortRef = useRef<AbortController | null>(null)
  const extrasRef = useRef(extras)
  useEffect(() => {
    extrasRef.current = extras
  }, [extras])
  const loadedRef = useRef(false)
  const cancelledRef = useRef<AbortController | null>(null)

  // Defaults, endpoints and the catalogue size, once per mount, on the first /new.
  const loadExtras = () => {
    if (loadedRef.current) return
    loadedRef.current = true
    nb.defaults().then(
      (defaults) => {
        setExtras((x) => ({ ...x, defaults }))
        // A card opened before the defaults landed picks them up (model, chips).
        setSession((s) => (s?.card && !s.card.endpointId ? { ...s, card: { ...s.card, ...pickDefaults(defaults) } } : s))
      },
      () => {},
    )
    api.listEndpoints().then((endpoints) => setExtras((x) => ({ ...x, endpoints })), () => {})
    api.listSkills().then((skills) => setExtras((x) => ({ ...x, catalogCount: skills.length })), () => {})
  }

  const stopDraft = () => {
    abortRef.current?.abort()
    abortRef.current = null
  }

  const runDraft = (req: DraftRequest) => {
    stopDraft()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    const startedAt = Date.now()
    setNow(startedAt)
    setSession((s) => (s ? { ...s, request: req, phase: { kind: 'drafting', startedAt }, turn: s.turn + 1 } : s))
    nb.draft(req, ctrl.signal).then(
      (draft) => {
        if (abortRef.current !== ctrl) return
        abortRef.current = null
        const phase = phaseAfterDraft(draft)
        if (draft.warning) setNameTouched(false)
        setSession((s) => {
          if (!s) return s
          if (phase.kind === 'cancelled') return { ...s, phase, turn: s.turn + 1 }
          return { ...s, phase, card: cardFromDraft(s.card, draft, extrasRef.current.defaults), warningCode: draft.warningCode, turn: s.turn + 1 }
        })
      },
      (err: unknown) => {
        // Cancel → S3. Aborts for other reasons (a new /new, Fill it in by hand, leaving the chat) are silent.
        const userCancel = isAbort(err) && cancelledRef.current === ctrl
        if (!userCancel && abortRef.current !== ctrl) return
        if (abortRef.current === ctrl) abortRef.current = null
        cancelledRef.current = null
        setSession((s) => (s ? { ...s, phase: userCancel ? { kind: 'cancelled' } : { kind: 'failed', message: draftFailureText(err) }, turn: s.turn + 1 } : s))
      },
    )
  }

  /** `/new <raw>` (or "＋ New bot" with ''). */
  const start = (raw: string) => {
    loadExtras()
    stopDraft()
    setFile(null)
    setFileError(null)
    setNameTouched(false)
    setSlug(null)
    const ts = new Date().toISOString()
    if (!raw.trim()) {
      setSession({ userText: '/new', userTs: ts, request: null, phase: { kind: 'ask' }, card: null, turn: 0 })
      return
    }
    setSession({ userText: `/new ${raw.trim()}`, userTs: ts, request: null, phase: { kind: 'ask' }, card: null, turn: 0 })
    runDraft(draftRequestBody(raw))
  }

  /** S6: the description typed into the composer. */
  const answer = (raw: string) => {
    setSession((s) => (s ? { ...s, userText: raw.trim(), userTs: new Date().toISOString() } : s))
    runDraft(draftRequestBody(raw))
  }

  /** A composer reply while the card shows: re-draft with the card as `previous`. */
  const reply = (raw: string) => {
    const card = session?.card
    setSession((s) => (s ? { ...s, userText: raw.trim(), userTs: new Date().toISOString() } : s))
    runDraft(draftRequestBody(raw, card ? previousOf(card) : undefined))
  }

  const cancel = () => {
    cancelledRef.current = abortRef.current
    stopDraft()
  }
  const retry = () => {
    if (session?.request) runDraft(session.request)
  }
  const fillByHand = () => {
    stopDraft()
    setSession((s) => (s ? { ...s, phase: { kind: 'card' }, card: s.card ?? blankCard(extrasRef.current.defaults), turn: s.turn + 1 } : s))
  }
  const end = () => {
    stopDraft()
    setSession(null)
  }

  const updateCard = (patch: Partial<CardDraft>) => {
    setSession((s) => {
      if (!s?.card) return s
      const phase = s.phase.kind === 'card' && s.phase.error ? { ...s.phase, error: undefined } : s.phase
      return { ...s, phase, card: { ...s.card, ...patch } }
    })
  }

  const pickFile = (f: File | null) => {
    if (!f) return
    const err = avatarFileError(f)
    setFileError(err)
    if (err) return
    setFile({ file: f, url: URL.createObjectURL(f) })
  }
  const clearFile = () => {
    setFile(null)
    setFileError(null)
  }

  // Reset when the chat changes (the flow belongs to the open DM).
  useEffect(() => () => stopDraft(), [conversationId])

  // Elapsed time for S1/S2.
  const drafting = session?.phase.kind === 'drafting'
  useEffect(() => {
    if (!drafting) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [drafting])

  // Private folder: debounced slug preview from the BE (never computed here, never for a blank name).
  const name = session?.card?.name ?? ''
  useEffect(() => {
    if (!name.trim()) {
      const t = setTimeout(() => setSlug(null), 0)
      return () => clearTimeout(t)
    }
    const ctrl = new AbortController()
    const t = setTimeout(() => {
      nb.slugPreview(name, ctrl.signal).then((s) => setSlug(s), () => {})
    }, SLUG_DEBOUNCE_MS)
    return () => {
      clearTimeout(t)
      ctrl.abort()
    }
  }, [name])

  useEffect(() => () => {
    if (file) URL.revokeObjectURL(file.url)
  }, [file])

  return {
    session, extras, file, fileError, slug, now, nameTouched,
    start, answer, reply, cancel, retry, fillByHand, end, updateCard, pickFile, clearFile, setNameTouched, setSession,
  }
}

function pickDefaults(d: AgentDefaults): Partial<CardDraft> {
  return { endpointId: d.endpointId, modelId: d.modelId, internetPolicy: d.internetPolicy, sourcesOn: d.skills.map((s) => s.sourceId) }
}

export type NewBotState = ReturnType<typeof useNewBot>
