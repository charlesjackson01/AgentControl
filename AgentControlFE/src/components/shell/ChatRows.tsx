import type { ReactNode } from 'react'
import Avatar from '../Avatar'
import type { Agent } from '../../lib/types'

export function TypingDots() {
  return (
    <span className="cf-typing" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  )
}

/** One assistant row: avatar at the bubble's foot, bubble, then its time. */
type RowProps = { meta?: ReactNode; mid?: string; hit?: boolean; children: ReactNode }

/**
 * `before` / `after` sit above and below the bubble (FE-7 activity card, file cards; FE-5 draft card).
 * `wide`: the FE-5 /new rows, whose group is as wide as the draft card.
 */
export function BotRow({ author, authorName, who, meta, error, mid, hit, before, after, wide, children }: RowProps & { author?: Agent; authorName?: string; who?: ReactNode; error?: boolean; before?: ReactNode; after?: ReactNode; wide?: boolean }) {
  return (
    <div className={`cf-row${hit ? ' cf-row--hit' : ''}`} data-mid={mid}>
      <span className="cf-row__av">
        <Avatar name={author?.name ?? authorName ?? 'Bot'} agentId={author?.id} avatar={author?.avatar} color={author?.color} size="md" decorative />
      </span>
      <div className={`cf-grp${wide ? ' cf-nb-grp' : ''}`}>
        {/* FE-6 (06a): author name (and ★ Lead) above each bubble in a group. */}
        {who && <div className="cf-who">{who}</div>}
        {before}
        <div className={`cf-bub cf-bub--a${error ? ' cf-bub--error' : ''}${wide ? ' cf-nb-bub' : ''}`}>{children}</div>
        {after}
        {meta && <div className="cf-bt">{meta}</div>}
      </div>
    </div>
  )
}

export function UserRow({ meta, mid, hit, children }: RowProps) {
  return (
    <div className={`cf-row cf-row--u${hit ? ' cf-row--hit' : ''}`} data-mid={mid}>
      <div className="cf-grp">
        <div className="cf-bub cf-bub--u">{children}</div>
        {meta && <div className="cf-rcpt">{meta}</div>}
      </div>
    </div>
  )
}
