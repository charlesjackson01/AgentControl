/**
 * FE-7: chat attachments (BE-9). Files picked with the composer ＋ (or dropped on the chat)
 * upload straight away to PUT /api/conversations/:id/uploads?name=… and land in the
 * conversation's shared/ folder; the message then carries the returned attachments.
 * Pure helpers only (no React, no fetch) so the tests can import them.
 */
import { humanSize } from './file-format.ts'
import { MAX_UPLOAD_BYTES, fileContentPath, filesErrorMessage, isImage, type FilesOwner } from './files.ts'
import type { Attachment } from './types.ts'

/** BE-9 MAX_ATTACHMENTS: a message carries at most 10 attachments (the brief didn't say; the BE 400s past it). */
export const MAX_ATTACHMENTS = 10

export type ChipStatus = 'uploading' | 'done' | 'error'

/** One file in the composer before the message is sent. */
export type Chip = {
  key: string
  /** The name the user picked. */
  name: string
  size: number
  mime: string
  status: ChipStatus
  /** 0..1 while uploading. */
  progress: number
  /** Set once the upload returned 201 (its `name` may differ: "report (2).pdf"). */
  attachment?: Attachment
  error?: string
}

type FileLike = { name: string; size: number; type?: string }

/** PUT target for one upload. */
export function uploadPath(conversationId: string, name: string): string {
  return `/api/conversations/${encodeURIComponent(conversationId)}/uploads?${new URLSearchParams({ name })}`
}

/** Chips that count toward the 10 (failed ones don't: they are never sent). */
export function liveChips(chips: readonly Chip[]): Chip[] {
  return chips.filter((c) => c.status !== 'error')
}

/**
 * Split picked/dropped files into those to upload and rejected ones, client side:
 * over 25 MiB (GAP-A3) or past the 10-attachment cap (GAP-A7). Zero-byte files are fine (the BE takes them).
 */
export function admitFiles<F extends FileLike>(chips: readonly Chip[], files: readonly F[]): { accepted: F[]; rejected: { file: F; error: string }[] } {
  let room = MAX_ATTACHMENTS - liveChips(chips).length
  const accepted: F[] = []
  const rejected: { file: F; error: string }[] = []
  for (const file of files) {
    if (file.size > MAX_UPLOAD_BYTES) {
      rejected.push({ file, error: oversizeText(file) })
      continue
    }
    if (room <= 0) {
      rejected.push({ file, error: `A message can carry up to ${MAX_ATTACHMENTS} files. Send these first, then add "${file.name}".` })
      continue
    }
    room -= 1
    accepted.push(file)
  }
  return { accepted, rejected }
}

export function oversizeText(file: FileLike): string {
  const size = humanSize(file.size)
  return `"${file.name}" is over the 25 MB limit${size ? ` (${size})` : ''}.`
}

export function newChip(key: string, file: FileLike): Chip {
  return { key, name: file.name, size: file.size, mime: file.type || '', status: 'uploading', progress: 0 }
}

export function rejectedChip(key: string, file: FileLike, error: string): Chip {
  return { ...newChip(key, file), status: 'error', error }
}

/** Message for a failed upload: the 25 MB 413, the server's own 400 text ("name" must be a file name…), else generic. */
export function uploadFailureText(status: number, serverMessage: string | null, name: string): string {
  if (status === 0) return `"${name}" didn't upload. Check your connection and try again.`
  if (status === 413) return filesErrorMessage(413, serverMessage, name).replace('upload limit', 'limit')
  if (status === 400 && serverMessage) return `"${name}" can't be uploaded: ${serverMessage}`
  if (serverMessage) return serverMessage
  return `"${name}" didn't upload (error ${status}).`
}

/** Attachments ready to go, in the order picked. */
export function readyAttachments(chips: readonly Chip[]): Attachment[] {
  return chips.flatMap((c) => (c.status === 'done' && c.attachment ? [c.attachment] : []))
}

export function anyUploading(chips: readonly Chip[]): boolean {
  return chips.some((c) => c.status === 'uploading')
}

/** Send is allowed with text, or with no text but at least one uploaded file; never while one is still uploading. */
export function canSendWith(text: string, chips: readonly Chip[]): boolean {
  if (anyUploading(chips)) return false
  return text.trim() !== '' || readyAttachments(chips).length > 0
}

/**
 * A send 400 that names a file ("shared/x.pdf" is no longer in the shared files. / wasn't uploaded
 * to this conversation): mark those chips failed with the server's text (GAP-A6). Returns null when no chip matched.
 */
export function markSendFailure(chips: readonly Chip[], message: string): Chip[] | null {
  let hit = false
  const next = chips.map((c) => {
    const path = c.attachment?.path
    if (c.status === 'done' && path && message.includes(`"${path}"`)) {
      hit = true
      return { ...c, status: 'error' as const, error: missingText(c.attachment!.name) }
    }
    return c
  })
  return hit ? next : null
}

export function missingText(name: string): string {
  return `"${name}" is no longer in the shared files. Remove it, or add it again.`
}

/* ---------- chip and card text ---------- */

/** Chip second line: "Uploading 40%", "412 KB", "Saved as report (2).pdf · 412 KB", or the error. */
export function chipLine(c: Chip): string {
  if (c.status === 'error') return c.error ?? 'Upload failed.'
  if (c.status === 'uploading') return `Uploading ${Math.round(Math.max(0, Math.min(1, c.progress)) * 100)}%`
  const size = humanSize(c.attachment?.size ?? c.size) ?? ''
  if (c.attachment && c.attachment.name !== c.name) return `Saved as ${c.attachment.name}${size ? ` · ${size}` : ''}`
  return size
}

/** Image cards (05b): by mime, else by extension. */
export function isImageAttachment(a: Pick<Attachment, 'name' | 'mime'>): boolean {
  return isImage({ kind: 'file', mime: a.mime || undefined, name: a.name })
}

export function isPdfAttachment(a: Pick<Attachment, 'name' | 'mime'>): boolean {
  return a.mime === 'application/pdf' || /\.pdf$/i.test(a.name)
}

/** Card meta: 04 "412 KB · saved to shared/" (the suffix is dropped on phones, as in 05b). */
export function attachmentMeta(a: Pick<Attachment, 'size'>): { size: string; saved: string } {
  return { size: humanSize(a.size) ?? '', saved: 'saved to shared/' }
}

/** Badge text on the non-image file tile: PDF in red (04); otherwise the extension, up to 4 letters. */
export function fileBadge(a: Pick<Attachment, 'name' | 'mime'>): string {
  if (isPdfAttachment(a)) return 'PDF'
  const m = /\.([A-Za-z0-9]{1,4})$/.exec(a.name)
  return m ? m[1].toUpperCase() : 'FILE'
}

/** Where the bytes live: a DM's bot folder or the group folder. */
export function attachmentOwner(a: Pick<Attachment, 'root'>, ctx: { agentId?: string; groupId?: string }): FilesOwner | null {
  if (a.root === 'group') return ctx.groupId ? { groupId: ctx.groupId } : null
  return ctx.agentId ?? null
}

/** Content URL path (no API base) for the thumbnail / open link; null without an owner. */
export function attachmentHref(a: Pick<Attachment, 'root' | 'path'>, ctx: { agentId?: string; groupId?: string }): string | null {
  const owner = attachmentOwner(a, ctx)
  return owner === null ? null : fileContentPath(owner, a.path)
}

/** Sidebar preview for a message with no text: "📎 plan.pdf", "📎 3 files". */
export function attachmentsPreview(list: readonly Pick<Attachment, 'name'>[] | undefined): string | null {
  if (!list || list.length === 0) return null
  return list.length === 1 ? `📎 ${list[0].name}` : `📎 ${list.length} files`
}

/** Files tab: the entry was sent in this very chat (BE-9 share record). */
export function sharedHere(e: { sharedInConversationId?: string }, conversationId: string | undefined): boolean {
  return Boolean(conversationId) && e.sharedInConversationId === conversationId
}

/** Is this drag carrying files (not text or a link)? */
export function dragHasFiles(types: readonly string[] | null | undefined): boolean {
  return Boolean(types && Array.from(types).includes('Files'))
}

/**
 * GAP-A10: a group's Shared files row for a file sent in this group chat: "You · sent in this chat · 8:22 PM"
 * (06c only shows "You · 8:22 PM"; files added from the panel keep that).
 */
export function groupSharedWhen(e: { sharedInConversationId?: string }, groupId: string, who: string, when: (who: string) => string): string {
  if (!sharedHere(e, groupId)) return when(who)
  return when(who ? `${who} · sent in this chat` : 'sent in this chat')
}

/**
 * GAP-A6 hint after a send 400. When the BE names one of the files (it says "wasn't uploaded to this
 * conversation…" once the file was deleted from shared/, or "is no longer in the shared files"), say which
 * file in plain words instead of the API wording; other errors pass through.
 */
export function sendFailureHint(chips: readonly Chip[], message: string): string {
  const named = chips.filter((c) => c.status === 'done' && c.attachment && message.includes(`"${c.attachment.path}"`))
  if (named.length === 0) return message
  if (named.length === 1) return missingText(named[0].attachment!.name)
  return `${named.length} files are no longer in the shared files. Remove them, or add them again.`
}
