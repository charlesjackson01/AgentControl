import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ApiError, uploadChatFile } from '../lib/api'
import { admitFiles, anyUploading, canSendWith, markSendFailure, newChip, readyAttachments, rejectedChip, uploadFailureText, uploadPath, type Chip } from '../lib/attachments'

let seq = 0
const nextKey = () => `att-${Date.now().toString(36)}-${(seq += 1)}`

/**
 * FE-7 composer attachments for one conversation: picked or dropped files upload at once
 * (with progress) and sit as removable chips until the message is sent.
 */
export function useAttachments(conversationId: string) {
  const [chips, setChips] = useState<Chip[]>([])
  const aborts = useRef(new Map<string, () => void>())
  const chipsRef = useRef(chips)
  useLayoutEffect(() => {
    chipsRef.current = chips
  }, [chips])

  // A different chat starts with an empty tray; in-flight uploads are cancelled.
  const [shownFor, setShownFor] = useState(conversationId)
  if (shownFor !== conversationId) {
    setShownFor(conversationId)
    setChips([])
  }
  useEffect(() => {
    const map = aborts.current
    return () => {
      for (const abort of map.values()) abort()
      map.clear()
    }
  }, [conversationId])

  const patch = useCallback((key: string, next: Partial<Chip>) => {
    setChips((list) => list.map((c) => (c.key === key ? { ...c, ...next } : c)))
  }, [])

  const add = useCallback(
    (files: FileList | readonly File[]) => {
      const { accepted, rejected } = admitFiles(chipsRef.current, Array.from(files))
      const fresh: Chip[] = []
      for (const r of rejected) fresh.push(rejectedChip(nextKey(), r.file, r.error))
      for (const file of accepted) {
        const chip = newChip(nextKey(), file)
        fresh.push(chip)
        const job = uploadChatFile(uploadPath(conversationId, file.name), file, (p) => patch(chip.key, { progress: p }))
        aborts.current.set(chip.key, job.abort)
        job.promise.then(
          (attachment) => patch(chip.key, { status: 'done', progress: 1, attachment }),
          (err: unknown) => {
            if (err instanceof ApiError && err.message === 'aborted') return
            const status = err instanceof ApiError ? err.status : 0
            const msg = err instanceof ApiError && err.message ? err.message : null
            patch(chip.key, { status: 'error', error: uploadFailureText(status, msg, file.name) })
          },
        ).finally(() => aborts.current.delete(chip.key))
      }
      setChips((list) => [...list, ...fresh])
    },
    [conversationId, patch],
  )

  const remove = useCallback((key: string) => {
    aborts.current.get(key)?.()
    aborts.current.delete(key)
    setChips((list) => list.filter((c) => c.key !== key))
  }, [])

  /** Take the tray for a send: returns the chips (to restore on failure) and empties it. */
  const take = useCallback(() => {
    const taken = chipsRef.current
    setChips([])
    return taken
  }, [])

  /** A failed send: put the chips back; files the 400 names are marked failed. */
  const restore = useCallback((taken: Chip[], message: string) => {
    const marked = markSendFailure(taken, message) ?? taken
    setChips((list) => [...marked, ...list])
  }, [])

  return {
    chips,
    add,
    remove,
    take,
    restore,
    ready: readyAttachments(chips),
    uploading: anyUploading(chips),
    canSend: (text: string) => canSendWith(text, chips),
  }
}

export type AttachmentsState = ReturnType<typeof useAttachments>
