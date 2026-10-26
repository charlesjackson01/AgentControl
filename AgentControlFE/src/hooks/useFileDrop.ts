import { useRef, useState, type DragEvent } from 'react'
import { dragHasFiles } from '../lib/attachments'
import type { AttachmentsState } from './useAttachments'

/** Drag-and-drop anywhere on the chat; `over` drives the composer's neutral drop highlight (GAP-A2). */
export function useFileDrop(att: AttachmentsState, enabled: boolean) {
  const [over, setOver] = useState(false)
  const depth = useRef(0)
  const has = (e: DragEvent) => enabled && dragHasFiles(e.dataTransfer?.types as unknown as string[])
  return {
    over: over && enabled,
    handlers: {
      onDragEnter: (e: DragEvent) => {
        if (!has(e)) return
        e.preventDefault()
        depth.current += 1
        setOver(true)
      },
      onDragOver: (e: DragEvent) => {
        if (!has(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      },
      onDragLeave: (e: DragEvent) => {
        if (!has(e)) return
        depth.current = Math.max(0, depth.current - 1)
        if (depth.current === 0) setOver(false)
      },
      onDrop: (e: DragEvent) => {
        if (!has(e)) return
        e.preventDefault()
        depth.current = 0
        setOver(false)
        if (e.dataTransfer.files.length) att.add(e.dataTransfer.files)
      },
    },
  }
}
