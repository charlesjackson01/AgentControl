import { useEffect, useRef, type ReactNode } from 'react'
import type { NewBotState } from '../../hooks/useNewBot'
import { AVATAR_MIME_TYPES } from '../../lib/avatar-draft'
import { clockTime } from '../../lib/thread'
import { MAX_AGENT_RULE_CHARS, MAX_AGENT_RULES, type Agent, type InternetPolicy } from '../../lib/types'
import {
  MAX_DESCRIPTION_CHARS,
  MAX_NAME_CHARS,
  MAX_ROLE_CHARS,
  canCreate,
  draftingStatus,
  folderLabel,
  modelOptions,
  nameError,
  pickerChoices,
  startingSkillsTotal,
} from '../../lib/new-bot'
import { BotRow, UserRow } from './ChatRows'


const INTERNET: { value: InternetPolicy; label: string }[] = [
  { value: 'ask', label: 'Ask each time' },
  { value: 'always', label: 'Always allow' },
  { value: 'never', label: 'Never' },
]

/** The current /new turn: the user bubble, then S1–S9 or the card. */
export function NewBotTurn({
  nbs, primary, onCreate, onOpenFull,
}: {
  nbs: NewBotState
  primary?: Agent
  onCreate: () => void
  onOpenFull: () => void
}) {
  const { session, now } = nbs
  if (!session) return null
  const { phase } = session
  const userMeta = clockTime(session.userTs)
  const botMeta = phase.kind === 'drafting' ? 'now' : clockTime(session.userTs)
  const handBtn = (label = 'Fill it in by hand') => (
    <button type="button" className="cf-btn" onClick={nbs.fillByHand}>{label}</button>
  )

  let bot: ReactNode
  if (phase.kind === 'ask') {
    bot = (
      <BotRow author={primary} meta={botMeta} wide>
        What should the new bot do? Describe it in a sentence, e.g. <em>keeps my travel plans organized</em>.
        <div className="cf-nb-actions">{handBtn('Skip, fill it in by hand')}</div>
      </BotRow>
    )
  } else if (phase.kind === 'drafting') {
    const st = draftingStatus(now - phase.startedAt)
    bot = (
      <BotRow author={primary} meta="now" wide>
        <div className="cf-nb-status" role="status">
          <span className="spinner" aria-hidden="true" />
          <div>
            <div className="cf-nb-status__t">{st.title}</div>
            <div className="cf-nb-status__s">{st.sub}</div>
          </div>
        </div>
        {!st.long && (
          <>
            <div className="cf-nb-skel" style={{ width: '82%' }} />
            <div className="cf-nb-skel" style={{ width: '58%' }} />
          </>
        )}
        <div className="cf-nb-actions">
          <button type="button" className="cf-btn" onClick={nbs.cancel}>Cancel</button>
          {st.long && handBtn()}
        </div>
      </BotRow>
    )
  } else if (phase.kind === 'cancelled') {
    bot = (
      <>
        <p className="cf-system">Draft cancelled</p>
        <BotRow author={primary} meta={botMeta} wide>
          No draft this time.{' '}
          <div className="cf-nb-actions">
            {session.request && <button type="button" className="cf-btn" onClick={nbs.retry}>Try again</button>}
            {handBtn()}
          </div>
        </BotRow>
      </>
    )
  } else if (phase.kind === 'failed') {
    bot = (
      <BotRow author={primary} meta={botMeta} error wide>
        {phase.message}
        <div className="cf-nb-actions">
          {session.request && <button type="button" className="cf-btn" onClick={nbs.retry}>Retry</button>}
          {handBtn()}
        </div>
      </BotRow>
    )
  } else {
    bot = (
      <BotRow author={primary} meta={botMeta} wide after={<DraftCard nbs={nbs} onCreate={onCreate} onOpenFull={onOpenFull} />}>
        {phase.warning ? (
          <>
            <span className="cf-nb-warnlbl">⚠ No draft</span>
            {phase.warning}
          </>
        ) : (
          "Here's a draft. Change anything, then create it. It gets its own private chat and folder."
        )}
      </BotRow>
    )
  }
  return (
    <>
      <UserRow meta={userMeta}>{session.userText}</UserRow>
      {bot}
    </>
  )
}

/** Rules wrap like the mockup's text: grow the one-row textarea to its content. */
function fitRule(el: HTMLTextAreaElement | null) {
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
}

function DraftCard({ nbs, onCreate, onOpenFull }: { nbs: NewBotState; onCreate: () => void; onOpenFull: () => void }) {
  const { session, extras, file, fileError, slug, nameTouched } = nbs
  const fileInput = useRef<HTMLInputElement>(null)
  const footRef = useRef<HTMLDivElement>(null)
  // S9: bring the error and the Create button back into view when a create fails.
  const createError = session?.phase.kind === 'card' ? session.phase.error : undefined
  useEffect(() => {
    if (createError) footRef.current?.scrollIntoView({ block: 'nearest' })
  }, [createError])
  if (!session?.card || session.phase.kind !== 'card') return null
  const card = session.card
  const busy = session.phase.creating === true
  const error = session.phase.error
  const name = card.name.trim()
  const blankAvatar = !card.avatarEmoji && !file
  const nErr = nameError(card, nameTouched)
  const options = modelOptions(extras.endpoints, extras.defaults)
  const selected = `${card.endpointId}\n${card.modelId}`
  const hasSelected = options.some((o) => `${o.endpointId}\n${o.modelId}` === selected)
  const sources = extras.defaults?.skills ?? []
  const total = startingSkillsTotal(extras.defaults)
  const rules = card.rules
  const setRule = (i: number, v: string) => nbs.updateCard({ rules: rules.map((r, j) => (j === i ? v : r)) })

  return (
    <div className={`cf-nb-card${busy ? ' cf-nb-card--busy' : ''}`} aria-busy={busy || undefined}>
      <div className="cf-nb-top">
        <div className="cf-nb-avcol">
          <div className={`cf-nb-av${blankAvatar ? '' : ' cf-nb-av--set'}`} aria-label="Avatar" role="img">
            {file ? <img src={file.url} alt="" /> : card.avatarEmoji || '?'}
          </div>
          <div className="cf-nb-avpick">
            {pickerChoices(card).map((e) => (
              <button key={e} type="button" disabled={busy} aria-label={`Use ${e}`} onClick={() => {
                nbs.updateCard({ avatarEmoji: e })
                nbs.clearFile()
              }}>
                {e}
              </button>
            ))}
            <button type="button" disabled={busy} aria-label="Upload a picture" title="Upload a picture" onClick={() => fileInput.current?.click()}>
              ⤒
            </button>
            <input
              ref={fileInput}
              type="file"
              hidden
              accept={AVATAR_MIME_TYPES.join(',')}
              onChange={(e) => {
                nbs.pickFile(e.target.files?.[0] ?? null)
                e.target.value = ''
              }}
            />
          </div>
        </div>
        <div className="cf-nb-grid">
          <div>
            <label className="cf-nb-lbl" htmlFor="nb-name">Name <span className="cf-nb-req">*</span></label>
            <input
              id="nb-name"
              className={`input${nErr ? ' input--invalid' : ''}`}
              value={card.name}
              maxLength={MAX_NAME_CHARS}
              placeholder="Name your bot"
              disabled={busy}
              aria-invalid={nErr ? true : undefined}
              onChange={(e) => nbs.updateCard({ name: e.target.value })}
              onBlur={() => nbs.setNameTouched(true)}
            />
            {nErr && <div className="cf-nb-fielderr">{nErr}</div>}
            {fileError && <div className="cf-nb-fielderr">{fileError}</div>}
          </div>
          <div>
            <label className="cf-nb-lbl" htmlFor="nb-role">Role</label>
            <input id="nb-role" className="input" value={card.role} maxLength={MAX_ROLE_CHARS} placeholder="e.g. Travel organizer" disabled={busy} onChange={(e) => nbs.updateCard({ role: e.target.value })} />
          </div>
          <div className="cf-nb-span2">
            <label className="cf-nb-lbl" htmlFor="nb-desc">What it does</label>
            <textarea
              id="nb-desc"
              className="input"
              rows={2}
              value={card.description}
              maxLength={MAX_DESCRIPTION_CHARS}
              placeholder="One or two sentences about what this bot is for"
              disabled={busy}
              onChange={(e) => nbs.updateCard({ description: e.target.value })}
            />
          </div>
          <div>
            <label className="cf-nb-lbl" htmlFor="nb-model">Model</label>
            <select
              id="nb-model"
              className="input"
              value={selected}
              disabled={busy}
              onChange={(e) => {
                const [endpointId, modelId] = e.target.value.split('\n')
                nbs.updateCard({ endpointId, modelId })
              }}
            >
              {!hasSelected && <option value={selected}>{card.modelId || '…'}</option>}
              {options.map((o) => (
                <option key={o.endpointId} value={`${o.endpointId}\n${o.modelId}`}>{o.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="cf-nb-lbl" htmlFor="nb-folder">Private folder</label>
            <input id="nb-folder" className="input cf-nb-mono" readOnly value={name ? folderLabel(slug) : ''} placeholder="bots/…/ (from the name)" />
          </div>
        </div>
      </div>
      <div className="cf-nb-sep" />
      <div className="cf-nb-lbl">
        Starting skills <span className="faint">· {total} on by default · change later in its settings</span>
      </div>
      <div className="chips">
        {sources.map((s) => {
          const on = card.sourcesOn.includes(s.sourceId)
          return (
            <button
              key={s.sourceId}
              type="button"
              className={`chip${on ? ' chip--on' : ''}`}
              aria-pressed={on}
              disabled={busy}
              onClick={() => nbs.updateCard({ sourcesOn: on ? card.sourcesOn.filter((x) => x !== s.sourceId) : [...card.sourcesOn, s.sourceId] })}
            >
              {on ? '✓ ' : ''}{s.label} ({s.count})
            </button>
          )
        })}
        <button type="button" className="chip" disabled={busy} onClick={onOpenFull}>
          ＋ Browse{extras.catalogCount !== null ? ` ${extras.catalogCount}` : ''}
        </button>
      </div>
      <div className="cf-nb-row2">
        <div>
          <div className="cf-nb-lbl" id="nb-net">Internet for scripts</div>
          <div className="segmented" role="radiogroup" aria-labelledby="nb-net">
            {INTERNET.map((o) => (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={card.internetPolicy === o.value}
                disabled={busy}
                className={`segmented__opt${card.internetPolicy === o.value ? ' segmented__opt--on' : ''}`}
                onClick={() => nbs.updateCard({ internetPolicy: o.value })}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
        <div>
          <div className="cf-nb-lbl">VM</div>
          <div className="cf-nb-sb">
            Its own VM is set up on its first script run. Scripts write only to its own folder; see Settings › VM.
          </div>
        </div>
      </div>
      <div className="cf-nb-lbl" style={{ marginTop: 12 }}>Rules</div>
      <div className="cf-nb-rules">
        {rules.length === 0 && <div className="cf-nb-faint">No rules yet.</div>}
        {rules.map((r, i) => (
          <div key={i} className="cf-nb-rule">
            <span className="cf-nb-faint">{i + 1}</span>
            <textarea
              ref={(el) => fitRule(el)}
              rows={1}
              className="cf-nb-rule__in"
              value={r}
              maxLength={MAX_AGENT_RULE_CHARS}
              disabled={busy}
              aria-label={`Rule ${i + 1}`}
              onChange={(e) => {
                fitRule(e.target)
                setRule(i, e.target.value)
              }}
              onKeyDown={(e) => {
                // A rule is one line of text: Enter finishes it instead of adding a newline.
                if (e.key === 'Enter') {
                  e.preventDefault()
                  e.currentTarget.blur()
                }
              }}
              onBlur={() => { if (!r.trim()) nbs.updateCard({ rules: rules.filter((_, j) => j !== i) }) }}
            />
          </div>
        ))}
        {rules.length < MAX_AGENT_RULES && (
          <button
            type="button"
            className="cf-nb-add"
            disabled={busy}
            onClick={() => {
              nbs.updateCard({ rules: [...rules, ''] })
              setTimeout(() => document.querySelector<HTMLTextAreaElement>('.cf-nb-rule:last-of-type .cf-nb-rule__in')?.focus(), 0)
            }}
          >
            ＋ Add a rule
          </button>
        )}
      </div>
      {error && <div className="notice notice--warn cf-nb-err" role="alert">{error}</div>}
      <div className="cf-nb-foot" ref={footRef}>
        <span className="cf-nb-foot__note">Nothing in Primary&apos;s folder is shared with {name || 'the new bot'}.</span>
        <button type="button" className="cf-btn" disabled={busy} onClick={onOpenFull}>Open full settings</button>
        <button type="button" className="btn btn--primary" disabled={busy || !canCreate(card)} onClick={onCreate}>
          {busy ? (
            <>
              <span className="spinner cf-nb-spin" aria-hidden="true" /> Creating…
            </>
          ) : (
            `Create ${name || 'bot'}`
          )}
        </button>
      </div>
    </div>
  )
}
