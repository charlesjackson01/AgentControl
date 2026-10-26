import { useRef, useState } from 'react'
import { apiUrl } from '../../lib/api'
import { attachmentHref, attachmentMeta, chipLine, fileBadge, isImageAttachment, isPdfAttachment, type Chip } from '../../lib/attachments'
import { fileIcon } from '../../lib/files'
import type { Attachment } from '../../lib/types'
import type { AttachmentsState } from '../../hooks/useAttachments'

type Ctx = { agentId?: string; groupId?: string }

/** 04 / 05b: the files a user sent, above their bubble (right-aligned). */
export function AttachmentCards({ attachments, ctx }: { attachments: readonly Attachment[]; ctx: Ctx }) {
  if (attachments.length === 0) return null
  return (
    <div className="cf-atts" data-gap={attachments.length > 2 ? 'GAP-A8' : undefined}>
      {attachments.map((a) => (
        <AttachmentCard key={`${a.root}:${a.path}`} a={a} ctx={ctx} />
      ))}
    </div>
  )
}

function AttachmentCard({ a, ctx }: { a: Attachment; ctx: Ctx }) {
  const href = attachmentHref(a, ctx)
  const url = href ? apiUrl(href) : undefined
  const meta = attachmentMeta(a)
  const [broken, setBroken] = useState(false)
  const label = `Open ${a.name}`
  const text = (
    <span className="cf-att__txt">
      <span className="cf-att__name" title={a.name}>{a.name}</span>
      <span className="cf-att__meta">
        {meta.size}
        <span className="cf-att__saved">{meta.size ? ' · ' : ''}{meta.saved}</span>
      </span>
    </span>
  )
  if (isImageAttachment(a))
    return (
      <a className="cf-att cf-att--img" href={url} target="_blank" rel="noopener noreferrer" aria-label={label}>
        <span className="cf-att__thumb">
          {url && !broken ? <img src={url} alt="" loading="lazy" onError={() => setBroken(true)} /> : <span aria-hidden="true">🖼</span>}
        </span>
        {text}
      </a>
    )
  return (
    <a className="cf-att cf-att--file" href={url} target="_blank" rel="noopener noreferrer" aria-label={label}>
      <span className={`cf-att__tile${isPdfAttachment(a) ? ' cf-att__tile--pdf' : ''}`} aria-hidden="true">
        {isPdfAttachment(a) ? 'PDF' : fileIcon({ kind: 'file', name: a.name, mime: a.mime || undefined })}
      </span>
      {text}
      <span className="sr-only">{fileBadge(a)}</span>
    </a>
  )
}

/** GAP-A1: the composer tray, one removable chip per picked file (progress while uploading). */
export function AttachTray({ att, disabled }: { att: AttachmentsState; disabled?: boolean }) {
  if (att.chips.length === 0) return null
  return (
    <ul className="cf-achips" aria-label="Attached files" data-gap="GAP-A1">
      {att.chips.map((c) => (
        <AttachChip key={c.key} c={c} onRemove={() => att.remove(c.key)} disabled={disabled} />
      ))}
    </ul>
  )
}

function AttachChip({ c, onRemove, disabled }: { c: Chip; onRemove: () => void; disabled?: boolean }) {
  const name = c.attachment?.name ?? c.name
  const img = isImageAttachment({ name, mime: c.attachment?.mime ?? c.mime })
  return (
    <li className={`cf-achip cf-achip--${c.status}`} data-status={c.status}>
      <span className="cf-achip__ic" aria-hidden="true">{c.status === 'error' ? '!' : img ? '🖼' : fileIcon({ kind: 'file', name, mime: c.mime || undefined })}</span>
      <span className="cf-achip__txt">
        <span className="cf-achip__name" title={name}>{c.name}</span>
        <span className="cf-achip__line" role={c.status === 'error' ? 'alert' : undefined}>{chipLine(c)}</span>
      </span>
      {c.status === 'uploading' && (
        <span className="cf-achip__bar" aria-hidden="true">
          <i style={{ width: `${Math.round(c.progress * 100)}%` }} />
        </span>
      )}
      <button type="button" className="cf-achip__x" onClick={onRemove} disabled={disabled} aria-label={`Remove ${c.name}`} title={c.status === 'uploading' ? 'Cancel upload' : 'Remove'}>
        ×
      </button>
    </li>
  )
}

/** The composer ＋: a hidden file input (several files at once). */
export function AttachButton({ att, disabled }: { att: AttachmentsState; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <>
      <button type="button" className="cf-cbtn cf-cbtn--plus" disabled={disabled} title="Attach files" aria-label="Attach files" onClick={() => input.current?.click()}>
        ＋
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        data-testid="attach-input"
        onChange={(e) => {
          if (e.target.files?.length) att.add(e.target.files)
          e.target.value = ''
        }}
      />
    </>
  )
}
